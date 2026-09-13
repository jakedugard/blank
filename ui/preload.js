const { contextBridge, ipcRenderer, webUtils } = require('electron')

// This preload runs in whatever the stage loads, including live websites, so
// the privileged API is exposed only to our own UI pages. Everything else gets
// the drag listener alone, which lives in the isolated world where page script
// can neither see nor call it.
const isOwnUI =
  location.protocol === 'file:' && /\/bar\.html$/.test(location.pathname)
const isRecorder =
  location.protocol === 'file:' && /\/recorder\.html$/.test(location.pathname)

// ⌘-drag moves the whole rig from anywhere on the page. Capture phase so page
// handlers can't swallow it first.
window.addEventListener('mousedown', (e) => {
  if (!e.metaKey || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()

  const ox = e.screenX
  const oy = e.screenY
  ipcRenderer.send('drag:start')

  const move = (ev) => ipcRenderer.send('drag:move', { dx: ev.screenX - ox, dy: ev.screenY - oy })
  const up = () => {
    window.removeEventListener('mousemove', move, true)
    window.removeEventListener('mouseup', up, true)
    ipcRenderer.send('drag:end')
  }
  window.addEventListener('mousemove', move, true)
  window.addEventListener('mouseup', up, true)
}, true)

// --- auto-scroll ------------------------------------------------------------
// Runs in the isolated world of whatever the stage loads, driven from main
// over IPC. Two modes share the interrupts, the pre-roll and the reporting:
//
//   steady   one velocity, ramped with a smoothstep over `ease` ms, so
//            starting, stopping, pausing and arriving at the end of the page
//            are all the same gesture.
//   natural  a flick, a rest, a flick: the way a hand scrolls a wheel. Each
//            flick glides out over roughly half a second, the page rests for
//            `dwell`, and a seeded jitter keeps the rhythm from being a
//            metronome. The same seed gives the same take.
//
// Any wheel, touch or scroll key from the user cancels either outright — the
// moment you reach for the page, the page is yours.

const smooth = (k) => k * k * (3 - 2 * k)
const easeOut = (t) => 1 - (1 - t) ** 3

// A hand's flick, as a velocity profile: a sine ramp up over the first
// GLIDE_IN of the stroke (the finger getting going), then a (1 − u)^DECAY
// fall to rest (the release). The higher the power, the longer and softer
// the tail: velocity keeps shrinking without ever braking hard, so the stop
// is felt rather than seen. Integrated in closed form so a frame can ask for
// the position at any t. Velocity is continuous at the handover.
const GLIDE_IN = 0.3
const DECAY = 5
function makeGlide (decay) {
  const head = 2 * GLIDE_IN / Math.PI
  const total = head + (1 - GLIDE_IN) / (decay + 1)
  const fn = (t) => {
    let d
    if (t < GLIDE_IN) d = head * (1 - Math.cos(Math.PI * t / (2 * GLIDE_IN)))
    else {
      const u = (t - GLIDE_IN) / (1 - GLIDE_IN)
      d = head + (1 - GLIDE_IN) * (1 - (1 - u) ** (decay + 1)) / (decay + 1)
    }
    return d / total
  }
  // Top speed, as a multiple of distance over duration: the curve is fastest
  // at the handover, where the ramp-in ends and the decay begins.
  fn.peak = 1 / total
  return fn
}
const glide = makeGlide(DECAY)

// Pin's hop. A flick's decay of 5 dumps most of the distance up front and
// creeps in; a smoothstep decelerates at a constant rate and stops dead, which
// reads as a machine. This sits between: the stop is asymptotic, so it's felt
// rather than seen, without the flick's long crawl.
const arrive = makeGlide(2.2)
// The same tail on its own, for cutting a flick short.
const tailOut = (t) => 1 - (1 - t) ** (DECAY + 1)

// Distance covered while k ramps from 0 to `k` at 1/ease per ms, in px:
// speed · ease · ∫smooth = speed · ease · (k³ − k⁴/2). At k = 1 that's half
// the cruise distance, which is when the arrival ramp has to begin.
const rampDistance = (speed, ease, k) => speed * (ease / 1000) * (k ** 3 - k ** 4 / 2)

// Small seeded PRNG (mulberry32); a take can be replayed from its seed.
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let job = null

function report (phase, extra = {}) {
  const active = !!job && phase !== 'done' && phase !== 'stopped'
  ipcRenderer.send('scroll:state', { phase, active, dir: job ? job.dir : 0, mode: job ? job.mode : null, ...extra })
}

// The document, unless the page scrolls a container instead (app shells).
function findScroller () {
  const doc = document.scrollingElement || document.documentElement
  if (doc.scrollHeight > doc.clientHeight + 1) return doc
  let best = null
  let bestArea = 0
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight <= el.clientHeight + 1) continue
    const oy = getComputedStyle(el).overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    const area = el.clientWidth * el.clientHeight
    if (area > bestArea) { best = el; bestArea = area }
  }
  return best || doc
}

const INTERRUPT_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])
const isP = (e) => (e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey
const onWheel = () => cancelScroll()
// Hold P to pause: eases out on press, back in on release. The key is eaten
// here so the page never sees it; the keyup still arrives, unlike when main
// prevents a keydown in before-input-event.
const onKey = (e) => {
  if (isP(e)) {
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat && job && job.phase === 'running') settle('pause')
  } else if (!e.altKey && INTERRUPT_KEYS.has(e.key)) cancelScroll()
}
const onKeyUp = (e) => { if (isP(e)) { e.preventDefault(); e.stopPropagation(); resumeScroll() } }
function armInterrupts () {
  window.addEventListener('wheel', onWheel, { capture: true, passive: true })
  window.addEventListener('touchstart', onWheel, { capture: true, passive: true })
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKeyUp, true)
}
function disarmInterrupts () {
  window.removeEventListener('wheel', onWheel, true)
  window.removeEventListener('touchstart', onWheel, true)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('keyup', onKeyUp, true)
}

const maxScroll = (el) => Math.max(0, el.scrollHeight - el.clientHeight)

// --- pins ------------------------------------------------------------------
// A pin is a resting place in the page: a spot you clicked, stored as the
// element and the offset inside it rather than a scroll number, so it survives
// a rebuild of the local folder and carries across the flip to the live URL.
// The page rests with the pinned spot in the middle of the frame.

// The document Y of a pin, or null if its element has gone.
function pinDocY (m) {
  if (m && m.sel) {
    try {
      const el = document.querySelector(m.sel)
      if (el) {
        const r = el.getBoundingClientRect()
        const top = r.top + (document.scrollingElement || document.documentElement).scrollTop
        return top + (Number(m.dy) || 0)
      }
    } catch { /* a selector that no longer parses falls through to the offset */ }
  }
  return Number.isFinite(m && m.y) ? m.y : null
}

// Where a dot sits across the frame: against the element it was put on, or a
// share of the width if that element has gone. Always far enough in to click.
function pinX (m, el) {
  const w = el.clientWidth || 1
  let x = Number.isFinite(m.xf) ? m.xf * w : w / 2
  if (m && m.sel) {
    try {
      const node = document.querySelector(m.sel)
      if (node) x = node.getBoundingClientRect().left + (Number(m.dx) || 0)
    } catch { /* an unparseable selector falls back to the share */ }
  }
  return Math.round(Math.min(w - 10, Math.max(10, x)))
}

// Where the page rests to put a pin in the middle of the frame.
function pinRest (m, el) {
  const y = pinDocY(m)
  if (y == null) return null
  return Math.min(maxScroll(el), Math.max(0, Math.round(y - el.clientHeight / 2)))
}

function restPositions (pins, el) {
  if (!Array.isArray(pins)) return []
  return pins.map(m => pinRest(m, el)).filter(v => v != null).sort((a, b) => a - b)
}

// --- pin --------------------------------------------------------------------
// A hop is a scroll to somewhere, not a cruise: one eased move, quick, that
// lands on the pin. Its length scales with the root of the distance, so a
// short hop stays brisk and a long one doesn't turn into a blur. `travel` is
// what a screen's worth costs, which is a thing you can picture.
const HOP_MIN = 320
const HOP_MAX = 1800
// The fastest a hop may run, so a long one stretches rather than blurring. It
// scales with the preset's own pace: a flat ceiling would flatten every setting
// into the same speed the moment a flick ran longer than about a screen, which
// is exactly where Sweep should be outrunning Read.
const HOP_PEAK = 2400          // px/s, quoted at...
const HOP_PEAK_AT = 900        // ...this travel, in ms a screen
const hopPeak = (j) => HOP_PEAK * HOP_PEAK_AT / Math.max(200, j.travel)
// A gap too far to cross in one move goes in stages, so the page slows and
// gathers itself again on the way, the way it would under a hand. A stage aims
// at HOP_STAGE screens at the reference pace and grows as the pace quickens —
// Sweep shouldn't stop as often as Read on the same page — and the count is
// rounded rather than rounded up, so a gap goes in fewer, longer flicks.
const HOP_STAGE = 1.6          // screens per stage, quoted at...
const HOP_STAGE_AT = 900       // ...this travel, in ms a screen
const hopStage = (j) => HOP_STAGE * HOP_STAGE_AT / Math.max(200, j.travel)
// How much longer than one stage a gap has to be before it's split at all.
const HOP_FAR = 1.375
// The pause between those stages. Long enough to read as a fresh flick, far too
// short to read as a stop.
const HOP_BREATH = 110

function hopTime (j, dist) {
  const screen = Math.max(1, j.el.clientHeight)
  const t = Math.min(HOP_MAX, Math.max(HOP_MIN, j.travel * Math.sqrt(dist / screen)))
  return Math.max(t, arrive.peak * 1000 * dist / hopPeak(j))
}

// The next place a Pin take comes to a stop: the nearest pin ahead of us, or
// the end of the page when there are none left.
function nextStop (j) {
  const max = maxScroll(j.el)
  let best = null
  for (const m of j.pins) {
    if (j.dir > 0 ? m <= j.pos + 8 : m >= j.pos - 8) continue
    if (best == null || (j.dir > 0 ? m < best : m > best)) best = m
  }
  return best == null ? { to: j.dir > 0 ? max : 0, pin: false } : { to: best, pin: true }
}

// --- how far down we are ----------------------------------------------------
// The bar offers a way back to the top once you're past a quarter of the page.
// This runs on every scroll event, and findScroller can walk the whole
// document, so the scroller is memoised.

const DEEP = 0.25
let deep = null
let scrollerWas = null
let scrollerAt = 0
function scroller () {
  const now = performance.now()
  if (!scrollerWas || now - scrollerAt > 1000) { scrollerWas = findScroller(); scrollerAt = now }
  return scrollerWas
}

let depthRaf = 0
function reportDepth () {
  depthRaf = 0
  const el = scroller()
  const max = maxScroll(el)
  const d = max > 0 && el.scrollTop / max > DEEP
  if (d === deep) return
  deep = d
  ipcRenderer.send('scroll:depth', d)
}
const onAnyScroll = () => { if (!depthRaf) depthRaf = requestAnimationFrame(reportDepth) }

// Back to the top, travelled rather than cut to: quick, but the page moves, so
// you can see where it went. Scales with the distance like a Pin hop and caps
// hard, since this is a reset and nobody wants to watch it. Touching the wheel
// takes it back, the same as any other motion the page makes on its own.
const TOP_PACE = 300           // ms a screen
const TOP_MIN = 240
const TOP_MAX = 800
let toTop = null

function cancelToTop () {
  if (!toTop) return
  cancelAnimationFrame(toTop.raf)
  window.removeEventListener('wheel', cancelToTop, true)
  window.removeEventListener('touchstart', cancelToTop, true)
  toTop = null
}

function scrollToTop () {
  cancelScroll()               // whatever the page was doing, it isn't now
  cancelToTop()
  const el = scroller()
  const from = el.scrollTop
  if (from < 1) { el.scrollTo({ top: 0, behavior: 'instant' }); reportDepth(); return }

  const screen = Math.max(1, el.clientHeight)
  const T = Math.min(TOP_MAX, Math.max(TOP_MIN, TOP_PACE * Math.sqrt(from / screen)))
  const t0 = performance.now()
  toTop = { raf: 0 }
  window.addEventListener('wheel', cancelToTop, { capture: true, passive: true })
  window.addEventListener('touchstart', cancelToTop, { capture: true, passive: true })

  const step = (now) => {
    if (!toTop) return
    const t = Math.min(1, (now - t0) / T)
    el.scrollTo({ top: t < 1 ? from * (1 - arrive(t)) : 0, behavior: 'instant' })
    if (t < 1) { toTop.raf = requestAnimationFrame(step); return }
    cancelToTop()
    reportDepth()
  }
  toTop.raf = requestAnimationFrame(step)
}

if (!isOwnUI && !isRecorder) {
  window.addEventListener('scroll', onAnyScroll, { capture: true, passive: true })
  window.addEventListener('resize', onAnyScroll, { passive: true })
  window.addEventListener('load', onAnyScroll)
  onAnyScroll()
}

// Either mode begins here: pre-roll, then `run`. Mid-run, ease out first and
// begin the new run (no pre-roll) from rest.
function launch (m) {
  cancelToTop()
  if (job && job.phase !== 'preroll') {
    job.next = { ...m, preroll: 0 }
    settle('restart')
    return
  }
  clearJob()

  const el = findScroller()
  const mode = m.mode === 'natural' ? 'natural' : m.mode === 'pin' ? 'pin' : 'steady'
  job = {
    mode, dir: m.dir, speed: m.speed, ease: m.ease, el, pos: el.scrollTop,
    phase: 'preroll', reason: null, next: null, timer: null, raf: 0, last: 0,
    // steady and pin
    k: 0, target: 0,
    // pin
    holding: false,
    hold: Number.isFinite(m.hold) ? m.hold : 1200,
    travel: Number.isFinite(m.travel) ? m.travel : 800,
    pins: mode === 'pin' ? restPositions(m.pins, el) : [],   // Steady and Natural ignore them
    // natural
    stride: m.stride, dwell: m.dwell, variation: m.variation, pace: m.pace || 1,
    rand: rng(m.seed || 1), flick: null
  }
  const me = job
  const begin = () => {
    if (job !== me) return
    job.phase = 'running'
    armInterrupts()
    report('running')
    if (job.mode === 'natural') nextFlick()
    else if (job.mode === 'pin') beginHop(job)
    else {
      job.target = 1
      job.last = performance.now()
      job.raf = requestAnimationFrame(tick)
    }
  }
  if (m.preroll > 0) {
    job.timer = setTimeout(begin, m.preroll)
    report('preroll', { until: Date.now() + m.preroll })
  } else begin()
}

// Live changes while running. Steady picks up speed on the next frame;
// natural picks up stride, dwell and variation on the next flick.
function tune (m) {
  if (!job) return
  for (const k of ['speed', 'ease', 'stride', 'dwell', 'variation', 'pace', 'hold', 'travel']) {
    if (Number.isFinite(m[k])) job[k] = m[k]
  }
  if (job.mode === 'pin' && Array.isArray(m.pins)) job.pins = restPositions(m.pins, job.el)
}

// --- steady ---

function tick (now) {
  const j = job
  if (!j) return
  const dt = Math.min(now - j.last, 50)   // a throttled frame mustn't lurch
  j.last = now

  const step = j.ease > 0 ? dt / j.ease : 1
  j.k = j.target > j.k ? Math.min(j.target, j.k + step) : Math.max(j.target, j.k - step)

  const max = maxScroll(j.el)
  j.pos = Math.min(max, Math.max(0, j.pos + j.dir * j.speed * smooth(j.k) * dt / 1000))
  j.el.scrollTo({ top: j.pos, behavior: 'instant' })

  const remaining = j.dir > 0 ? max - j.pos : j.pos
  if (j.target === 1 && remaining <= rampDistance(j.speed, j.ease, j.k)) {
    j.target = 0
    j.reason = 'done'
  }

  if (j.k === 0 && j.target === 0) { finish(j.reason || 'done'); return }
  j.raf = requestAnimationFrame(tick)
}

// --- natural ---

// ±variation, e.g. 0.3 → a factor between 0.7 and 1.3.
const jitter = (j) => 1 + j.variation * (j.rand() * 2 - 1)

function nextFlick () {
  const j = job
  if (!j || j.phase !== 'running') return
  const max = maxScroll(j.el)
  const want = j.stride * j.el.clientHeight * jitter(j)
  let to = Math.min(max, Math.max(0, j.pos + j.dir * want))
  // Nobody flicks the last few pixels; fold a stub into this flick.
  if (j.dir > 0 ? max - to < 40 : to < 40) to = j.dir > 0 ? max : 0
  const dist = Math.abs(to - j.pos)
  if (dist < 1) { j.pos = to; j.el.scrollTo({ top: to, behavior: 'instant' }); finish('done'); return }
  // Longer flicks take longer, and none is quick: a short one is a second,
  // 70% of a screen nearer two. Most of that is the tail.
  // `pace` scales the whole flick: under 1 is a quicker hand.
  const T = Math.min(2600, Math.max(1000, 800 + dist * 1.8)) * j.pace * jitter(j)
  j.flick = { from: j.pos, to, t0: performance.now(), T, curve: glide, last: to === max || to === 0 }
  j.raf = requestAnimationFrame(tickNatural)
}

function beginHop (j) {
  if (job !== j || j.phase !== 'running') return
  const { to, pin } = nextStop(j)
  const gap = Math.abs(to - j.pos)
  if (gap < 1) { finish('done'); return }

  // Near enough to take in one move, or one stage of the way there. Stages are
  // even, so the last one lands on the pin rather than nudging the final few
  // pixels, and re-dividing what's left each time keeps them that way.
  const screen = Math.max(1, j.el.clientHeight)
  const stage = hopStage(j) * screen
  let target = to
  let arriving = true
  if (gap > HOP_FAR * stage) {
    const stages = Math.max(2, Math.round(gap / stage))
    target = j.pos + Math.sign(to - j.pos) * (gap / stages)
    arriving = false
  }

  j.holding = false
  j.reason = null
  j.flick = {
    from: j.pos, to: target, t0: performance.now(),
    T: hopTime(j, Math.abs(target - j.pos)), curve: arrive,
    atPin: pin && arriving, last: !pin && arriving
  }
  j.raf = requestAnimationFrame(tickNatural)
}

function tickNatural (now) {
  const j = job
  const f = j && j.flick
  if (!f) return
  const t = Math.min(1, (now - f.t0) / f.T)
  j.pos = t < 1 ? f.from + (f.to - f.from) * f.curve(t) : f.to   // land exactly
  j.el.scrollTo({ top: j.pos, behavior: 'instant' })
  if (t < 1) { j.raf = requestAnimationFrame(tickNatural); return }

  j.flick = null
  if (j.reason) { finish(j.reason); return }        // asked to stop or pause mid-flick
  if (j.mode === 'pin') {
    if (f.atPin) {                                  // landed on a pin: rest, then go again
      j.holding = true
      j.timer = setTimeout(() => beginHop(j), j.hold)
      return
    }
    if (f.last) { finish('done'); return }          // ran out the bottom of the page
    j.timer = setTimeout(() => beginHop(j), HOP_BREATH)   // part of the way: gather, go again
    return
  }
  if (f.last) { finish('done'); return }
  j.timer = setTimeout(nextFlick, j.dwell * jitter(j))
}

// Cut the current flick short: glide out over a short tail from where we are.
function truncateFlick (j) {
  const f = j.flick
  if (!f) return
  const remaining = f.to - j.pos
  // Never coast more than a third of a screen out of a stop. A Natural flick is
  // about a screen long, so 30% of what's left is already small; a Pin hop can
  // span thousands of pixels, and 30% of that would carry you past the point of
  // having pressed stop.
  const most = Math.min(Math.abs(remaining) * 0.3, j.el.clientHeight * 0.33)
  const tail = Math.sign(remaining) * Math.min(Math.abs(remaining), Math.max(24, most))
  j.flick = { from: j.pos, to: j.pos + tail, t0: performance.now(), T: 500, curve: tailOut, last: false }
}

// --- shared ---

// Ease to a halt, then act on `reason` in finish().
function settle (reason) {
  const j = job
  if (!j) return
  j.reason = reason
  if (j.phase === 'preroll' || j.phase === 'paused') { finish(reason); return }
  if (j.holding) { clearTimeout(j.timer); finish(reason); return }   // held at a pin
  if (j.mode !== 'steady') {
    if (j.flick) truncateFlick(j)                   // finish() runs when the tail lands
    else { clearTimeout(j.timer); finish(reason) }  // resting: nothing to ease
    return
  }
  j.target = 0
  j.phase = 'stopping'
}

function finish (reason) {
  const j = job
  if (!j) return
  clearTimeout(j.timer)
  cancelAnimationFrame(j.raf)
  j.flick = null
  if (reason === 'pause') {
    j.phase = 'paused'
    j.reason = null
    j.holding = false
    report('paused')
    return
  }
  const next = reason === 'restart' ? j.next : null
  disarmInterrupts()
  job = null
  if (next) launch(next)
  else report(reason === 'done' ? 'done' : 'stopped')
}

function resumeScroll () {
  const j = job
  if (!j || j.phase !== 'paused') return
  j.phase = 'running'
  j.reason = null
  report('running')
  if (j.mode === 'pin') { j.timer = setTimeout(() => beginHop(j), 250); return }
  if (j.mode === 'natural') { j.timer = setTimeout(nextFlick, 250); return }
  j.target = 1
  j.last = performance.now()
  j.raf = requestAnimationFrame(tick)
}

// Immediate, no ramp: the user took over.
function cancelScroll () {
  if (!job) return
  clearJob()
  report('stopped')
}

function clearJob () {
  if (!job) return
  clearTimeout(job.timer)
  cancelAnimationFrame(job.raf)
  disarmInterrupts()
  job = null
}

// --- pinning ----------------------------------------------------------------
// Arming pins makes the page inert and turns clicks into pins: click a spot
// to place one, click a pin to take it away. The overlay is drawn in fixed
// coordinates and redrawn every frame, so it holds its place whatever the page
// does under it, and it goes away the moment pinning is off — a take never
// records it.

let pinning = null

// An element, as a selector that will still find it after the page is rebuilt:
// an id when there is one, otherwise the path down from body by tag and index.
function selectorFor (el) {
  if (!el || el.nodeType !== 1) return null
  const parts = []
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    if (n.id) {
      const byId = '#' + CSS.escape(n.id)
      let unique = false
      try { unique = document.querySelectorAll(byId).length === 1 } catch { unique = false }
      if (unique) { parts.unshift(byId); break }
    }
    const tag = n.localName
    let i = 1
    for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.localName === tag) i++
    }
    parts.unshift(`${tag}:nth-of-type(${i})`)
    if (n.parentElement === document.body) { parts.unshift('body'); break }
  }
  const sel = parts.join(' > ')
  try { return document.querySelector(sel) ? sel : null } catch { return null }
}

function pinStyle () {
  const el = document.createElement('style')
  el.textContent = `
    .blank-pins { position:fixed; inset:0; z-index:2147483647; pointer-events:none; }
    .blank-pins i { position:absolute; display:block; box-sizing:border-box;
      width:56px; height:56px; margin:-28px 0 0 -28px; border-radius:50%;
      border:1.5px solid rgba(255,59,48,.45); background:rgba(255,59,48,.10); }
    .blank-pins i::before, .blank-pins i::after { content:''; position:absolute;
      background:rgba(255,59,48,.45); }
    /* Both arms hang off the centre, so the stroke can change thickness without
       walking the plus off it. */
    .blank-pins i::before { left:50%; margin-left:-0.75px; width:1.5px;
      top:50%; margin-top:-10px; height:20px; }
    .blank-pins i::after { top:50%; margin-top:-0.75px; height:1.5px;
      left:50%; margin-left:-10px; width:20px; }
    .blank-pinning, .blank-pinning * { cursor:crosshair !important; }
  `
  return el
}

function drawPins () {
  const m = pinning
  if (!m) return
  const el = scroller()   // memoised: this runs every frame, and findScroller walks the DOM
  const top = el.scrollTop
  // Each rule carries the index of the pin it draws, so a click that lands on
  // one removes that pin whatever order the page resolved them in.
  // A dot sits on the spot itself, not on where the page will rest. Near the
  // top or bottom those differ, since the page can't scroll past its ends.
  const at = []
  m.pins.forEach((pin, i) => {
    const y = pinDocY(pin)
    if (y == null) return
    at.push({ i, y: Math.round(y - top), x: pinX(pin, el) })
  })
  while (m.box.children.length > at.length) m.box.lastElementChild.remove()
  while (m.box.children.length < at.length) m.box.appendChild(document.createElement('i'))
  m.rules = [...m.box.children]
  m.at = at
  at.forEach((a, n) => {
    m.rules[n].style.top = a.y + 'px'
    m.rules[n].style.left = a.x + 'px'
  })
  m.raf = requestAnimationFrame(drawPins)
}

// Swallow everything a click would otherwise do to the page.
const eatEvent = (e) => { e.preventDefault(); e.stopPropagation() }

function onPinDown (e) {
  if (e.button !== 0 || e.metaKey) return   // ⌘-drag still moves the rig
  eatEvent(e)
  const m = pinning
  if (!m) return
  // Near an existing pin, the click takes it away instead of adding one.
  const hit = m.at.find(a => Math.hypot(a.x - e.clientX, a.y - e.clientY) <= 28)
  if (hit) { ipcRenderer.send('pins:remove', hit.i); return }

  const el = findScroller()
  const target = e.target && e.target.nodeType === 1 ? e.target : document.body
  const rect = target.getBoundingClientRect()
  const y = e.clientY + el.scrollTop
  ipcRenderer.send('pins:add', {
    sel: selectorFor(target),
    dy: Math.round(e.clientY - rect.top),
    dx: Math.round(e.clientX - rect.left),
    y: Math.round(y),
    xf: Math.round((e.clientX / (el.clientWidth || 1)) * 1000) / 1000
  })
}

function armPins (pins) {
  if (pinning) { pinning.pins = pins || []; return }
  const style = pinStyle()
  const box = document.createElement('div')
  box.className = 'blank-pins'
  document.documentElement.appendChild(style)
  document.documentElement.appendChild(box)
  document.documentElement.classList.add('blank-pinning')
  pinning = { pins: pins || [], box, style, rules: [], at: [], raf: 0 }
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, type === 'mousedown' ? onPinDown : eatEvent, true)
  }
  drawPins()
}

function disarmPins () {
  const m = pinning
  if (!m) return
  cancelAnimationFrame(m.raf)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.removeEventListener(type, type === 'mousedown' ? onPinDown : eatEvent, true)
  }
  m.box.remove()
  m.style.remove()
  document.documentElement.classList.remove('blank-pinning')
  pinning = null
}

// --- zap --------------------------------------------------------------------
// A zap is an element you don't want in the take: a cookie banner, a chat
// bubble, a badge. It's stored as a selector and kept with the target, and
// applied as a stylesheet rather than by touching the element, so a banner a
// site builds again on its next page stays gone. Arming zap makes the page
// inert and turns clicks into zaps; the element under the cursor is outlined
// so you can see what's about to go.
//
// A zap hides: the box stays in the layout and simply isn't painted, so
// nothing around it moves. (display:none was the first version, and a zapped
// grid cell let its neighbours stretch into the gap.) ⌥-click removes
// instead, for the banner at the top of a page that's pushing everything down.

const ZAP_STYLE = '__blank_zaps'

function applyZaps (zaps) {
  let st = document.getElementById(ZAP_STYLE)
  const rules = (zaps || []).filter(z => z && z.sel).map(z =>
    z.mode === 'remove'
      ? `${z.sel} { display: none !important; }`
      : `${z.sel} { visibility: hidden !important; }`)
  if (!rules.length) { if (st) st.remove(); return }
  if (!st) {
    st = document.createElement('style')
    st.id = ZAP_STYLE
    ;(document.head || document.documentElement).appendChild(st)
  }
  st.textContent = rules.join('\n')
}

// A short name for the Restore menu: the tag with its id or first class, and
// a little of what it says.
function zapName (el) {
  let n = el.localName
  if (el.id) n += '#' + el.id
  else if (el.classList.length) n += '.' + el.classList[0]
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text) n += ` “${text.length > 24 ? text.slice(0, 24) + '…' : text}”`
  return n.length > 60 ? n.slice(0, 60) + '…' : n
}

let zapping = null

function zapStyle () {
  const el = document.createElement('style')
  el.textContent = `
    .blank-zap-hi { position:fixed; z-index:2147483647; pointer-events:none; box-sizing:border-box;
      border:1.5px solid rgba(255,59,48,.85); background:rgba(255,59,48,.12); border-radius:3px;
      display:none; }
    .blank-zapping, .blank-zapping * { cursor:crosshair !important; }
  `
  return el
}

// html and body would take the whole page with them.
const zappable = (el) => el && el.nodeType === 1 && el !== document.documentElement && el !== document.body

function zapHover (e) {
  const m = zapping
  if (!m) return
  const el = e.target
  if (!zappable(el)) { m.over = null; m.hi.style.display = 'none'; return }
  m.over = el
  const r = el.getBoundingClientRect()
  Object.assign(m.hi.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
}

function onZapDown (e) {
  if (e.button !== 0 || e.metaKey) return   // ⌘-drag still moves the rig
  eatEvent(e)
  const m = zapping
  if (!m) return
  const el = zappable(e.target) ? e.target : m.over
  if (!zappable(el)) return
  const sel = selectorFor(el)
  if (!sel) return
  m.hi.style.display = 'none'
  m.over = null
  ipcRenderer.send('zaps:add', { sel, name: zapName(el), mode: e.altKey ? 'remove' : 'hide' })
}

function armZap () {
  if (zapping) return
  const style = zapStyle()
  const hi = document.createElement('div')
  hi.className = 'blank-zap-hi'
  document.documentElement.appendChild(style)
  document.documentElement.appendChild(hi)
  document.documentElement.classList.add('blank-zapping')
  zapping = { style, hi, over: null }
  window.addEventListener('mousemove', zapHover, true)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, type === 'mousedown' ? onZapDown : eatEvent, true)
  }
}

function disarmZap () {
  const m = zapping
  if (!m) return
  window.removeEventListener('mousemove', zapHover, true)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.removeEventListener(type, type === 'mousedown' ? onZapDown : eatEvent, true)
  }
  m.hi.remove()
  m.style.remove()
  document.documentElement.classList.remove('blank-zapping')
  zapping = null
}

ipcRenderer.on('zaps:cmd', (_e, m) => {
  if (m.cmd === 'apply') applyZaps(m.zaps)
  else if (m.cmd === 'arm') armZap()
  else if (m.cmd === 'disarm') disarmZap()
})

ipcRenderer.on('pins:cmd', (_e, m) => {
  if (m.cmd === 'arm') armPins(m.pins)
  else disarmPins()
})

ipcRenderer.on('scroll:cmd', (_e, m) => {
  switch (m.cmd) {
    case 'start': launch(m); break
    case 'stop': settle('stop'); break
    case 'tune': tune(m); break
    case 'top': scrollToTop(); break
  }
})

if (isOwnUI) {
  contextBridge.exposeInMainWorld('stage', {
    setSize:    (size) => ipcRenderer.invoke('stage:setSize', size),
    setRadius:  (r)    => ipcRenderer.invoke('stage:setRadius', r),
    reload:     ()     => ipcRenderer.invoke('stage:reload'),
    pick:       ()     => ipcRenderer.invoke('stage:pick'),
    openPath:   (p)    => ipcRenderer.invoke('stage:openPath', p),
    openUrl:    (u)    => ipcRenderer.invoke('stage:openUrl', u),
    openRecent: (id)   => ipcRenderer.invoke('stage:openRecent', id),
    sizeMenu:   ()     => ipcRenderer.invoke('stage:sizeMenu'),
    moreMenu:   ()     => ipcRenderer.invoke('stage:moreMenu'),
    scrollMenu: ()     => ipcRenderer.invoke('stage:scrollMenu'),
    setScroll:  (p)    => ipcRenderer.invoke('stage:setScroll', p),
    scroll:     (dir)  => ipcRenderer.invoke('stage:scroll', dir),
    scrollStop: ()     => ipcRenderer.invoke('stage:scrollStop'),
    toTop:      ()     => ipcRenderer.invoke('stage:toTop'),
    scrollAs:   (m, d) => ipcRenderer.invoke('stage:scrollAs', m, d),
    scrollPreset: (n)  => ipcRenderer.invoke('stage:scrollPreset', n),
    pins:      (cmd)  => ipcRenderer.invoke('stage:pins', cmd),
    zaps:      (cmd, arg) => ipcRenderer.invoke('stage:zaps', cmd, arg),
    zapMenu:   ()     => ipcRenderer.invoke('stage:zapMenu'),
    record:     (o)    => ipcRenderer.invoke('stage:record', o),
    armed:      (on)   => ipcRenderer.send('bar:armed', !!on),
    recordPermission: () => ipcRenderer.invoke('stage:recordPermission'),
    setMatte:   (c)    => ipcRenderer.invoke('stage:setMatte', c),
    setBarWidth: (w)   => ipcRenderer.send('bar:width', w),
    focusStage: ()     => ipcRenderer.invoke('stage:focusStage'),

    // Electron 32 removed File.path; this is the supported replacement.
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file) } catch { return null }
    },

    // Fire-and-forget so a drag isn't gated on a round trip per pointer move.
    dragStart: ()       => ipcRenderer.send('drag:start'),
    dragMove:  (dx, dy) => ipcRenderer.send('drag:move', { dx, dy }),
    dragEnd:   ()       => ipcRenderer.send('drag:end'),

    onState:      (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
    onFocusInput: (fn) => ipcRenderer.on('focus-input', fn),
    onCustomSize:   (fn) => ipcRenderer.on('custom-size', fn),
    onCustomMatte:  (fn) => ipcRenderer.on('custom-matte', fn)
  })
}

// The hidden encoder window: main starts and stops it, it streams chunks back.
if (isRecorder) {
  contextBridge.exposeInMainWorld('recorder', {
    onStart: (fn) => ipcRenderer.on('rec:start', (_e, opts) => fn(opts)),
    onStop:  (fn) => ipcRenderer.on('rec:stop', () => fn()),
    started: ()   => ipcRenderer.send('rec:started'),
    chunk:   (b)  => ipcRenderer.send('rec:chunk', b),
    done:    ()   => ipcRenderer.send('rec:done'),
    failed:  (m)  => ipcRenderer.send('rec:failed', m),
    kick:    ()   => ipcRenderer.send('rec:kick')
  })
}
