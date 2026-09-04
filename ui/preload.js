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
// over IPC. Velocity ramps with a smoothstep over `ease` ms, so starting,
// stopping, pausing and arriving at the end of the page are all the same
// gesture. Any wheel, touch or scroll key from the user cancels it outright —
// the moment you reach for the page, the page is yours.

const smooth = (k) => k * k * (3 - 2 * k)
// Distance covered while k ramps from 0 to `k` at 1/ease per ms, in px:
// speed · ease · ∫smooth = speed · ease · (k³ − k⁴/2). At k = 1 that's half
// the cruise distance, which is when the arrival ramp has to begin.
const rampDistance = (speed, ease, k) => speed * (ease / 1000) * (k ** 3 - k ** 4 / 2)

let job = null

function report (phase, extra = {}) {
  const active = !!job && phase !== 'done' && phase !== 'stopped'
  ipcRenderer.send('scroll:state', { phase, active, dir: job ? job.dir : 0, ...extra })
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

function startScroll ({ dir, speed, ease, preroll }) {
  // Mid-run, ease out first and begin the new run (no pre-roll) from rest.
  if (job && job.phase !== 'preroll') {
    job.next = { dir, speed, ease, preroll: 0 }
    settle('restart')
    return
  }
  clearJob()

  const el = findScroller()
  job = { dir, speed, ease, el, pos: el.scrollTop, k: 0, target: 0, reason: null, phase: 'preroll', last: 0, timer: null, raf: 0 }
  const me = job
  const begin = () => {
    if (job !== me) return
    job.phase = 'running'
    job.target = 1
    job.last = performance.now()
    job.raf = requestAnimationFrame(tick)
    armInterrupts()
    report('running')
  }
  if (preroll > 0) {
    job.timer = setTimeout(begin, preroll)
    report('preroll', { until: Date.now() + preroll })
  } else begin()
}

function tick (now) {
  const j = job
  if (!j) return
  const dt = Math.min(now - j.last, 50)   // a throttled frame mustn't lurch
  j.last = now

  const step = j.ease > 0 ? dt / j.ease : 1
  j.k = j.target > j.k ? Math.min(j.target, j.k + step) : Math.max(j.target, j.k - step)

  const max = Math.max(0, j.el.scrollHeight - j.el.clientHeight)
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

// Ease to a halt, then act on `reason` in finish().
function settle (reason) {
  const j = job
  if (!j) return
  if (j.phase === 'preroll' || j.phase === 'paused') {
    j.reason = reason
    finish(reason)
    return
  }
  j.reason = reason
  j.target = 0
  j.phase = 'stopping'
}

function finish (reason) {
  const j = job
  if (!j) return
  clearTimeout(j.timer)
  cancelAnimationFrame(j.raf)
  if (reason === 'pause') {
    j.phase = 'paused'
    report('paused')
    return
  }
  const next = reason === 'restart' ? j.next : null
  disarmInterrupts()
  job = null
  if (next) startScroll(next)
  else report(reason === 'done' ? 'done' : 'stopped')
}

function resumeScroll () {
  const j = job
  if (!j || j.phase !== 'paused') return
  j.phase = 'running'
  j.target = 1
  j.reason = null
  j.last = performance.now()
  j.raf = requestAnimationFrame(tick)
  report('running')
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
    case 'start': startScroll(m); break
    case 'stop': settle('stop'); break
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
