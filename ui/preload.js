const { contextBridge, ipcRenderer, webUtils } = require('electron')

// This preload runs in whatever the stage loads, including live websites, so
// the privileged API is exposed only to our own UI pages. Everything else gets
// the drag listener alone, which lives in the isolated world where page script
// can neither see nor call it.
const isOwnUI =
  location.protocol === 'file:' && /\/bar\.html$/.test(location.pathname)

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
// GLIDE_IN of the stroke (the finger getting going), then a squared decay to
// rest (the release). Integrated in closed form so a frame can ask for the
// position at any t. Velocity is continuous at the handover.
const GLIDE_IN = 0.25
const glideTotal = 2 * GLIDE_IN / Math.PI + (1 - GLIDE_IN) / 3
function glide (t) {
  let d
  if (t < GLIDE_IN) d = (2 * GLIDE_IN / Math.PI) * (1 - Math.cos(Math.PI * t / (2 * GLIDE_IN)))
  else {
    const u = (t - GLIDE_IN) / (1 - GLIDE_IN)
    d = 2 * GLIDE_IN / Math.PI + (1 - GLIDE_IN) * (1 - (1 - u) ** 3) / 3
  }
  return d / glideTotal
}
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

// Either mode begins here: pre-roll, then `run`. Mid-run, ease out first and
// begin the new run (no pre-roll) from rest.
function launch (m) {
  if (job && job.phase !== 'preroll') {
    job.next = { ...m, preroll: 0 }
    settle('restart')
    return
  }
  clearJob()

  const el = findScroller()
  const mode = m.mode === 'natural' ? 'natural' : 'steady'
  job = {
    mode, dir: m.dir, speed: m.speed, ease: m.ease, el, pos: el.scrollTop,
    phase: 'preroll', reason: null, next: null, timer: null, raf: 0, last: 0,
    // steady
    k: 0, target: 0,
    // natural
    stride: m.stride, dwell: m.dwell, variation: m.variation,
    rand: rng(m.seed || 1), flick: null
  }
  const me = job
  const begin = () => {
    if (job !== me) return
    job.phase = 'running'
    armInterrupts()
    report('running')
    if (job.mode === 'natural') nextFlick()
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

// Live changes while running; only speed matters mid-flight.
function tune (m) {
  if (job && Number.isFinite(m.speed)) job.speed = m.speed
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
  // Longer flicks take longer, but none is quick: even a short one is most
  // of a second, and a full screen is nearer two.
  const T = Math.min(2000, Math.max(700, 500 + dist * 1.4)) * jitter(j)
  j.flick = { from: j.pos, to, t0: performance.now(), T, curve: glide, last: to === max || to === 0 }
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
  if (f.last) { finish('done'); return }
  j.timer = setTimeout(nextFlick, j.dwell * jitter(j))
}

// Cut the current flick short: glide out over a short tail from where we are.
function truncateFlick (j) {
  const f = j.flick
  if (!f) return
  const remaining = f.to - j.pos
  const tail = Math.sign(remaining) * Math.min(Math.abs(remaining), Math.max(24, Math.abs(remaining) * 0.3))
  j.flick = { from: j.pos, to: j.pos + tail, t0: performance.now(), T: 400, curve: easeOut, last: false }
}

// --- shared ---

// Ease to a halt, then act on `reason` in finish().
function settle (reason) {
  const j = job
  if (!j) return
  j.reason = reason
  if (j.phase === 'preroll' || j.phase === 'paused') { finish(reason); return }
  if (j.mode === 'natural') {
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

ipcRenderer.on('scroll:cmd', (_e, m) => {
  switch (m.cmd) {
    case 'start': launch(m); break
    case 'stop': settle('stop'); break
    case 'tune': tune(m); break
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
    onCustomScroll: (fn) => ipcRenderer.on('custom-scroll', (_e, key) => fn(key))
  })
}
