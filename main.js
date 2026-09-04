const { app, BrowserWindow, WebContentsView, ipcMain, dialog, screen, Menu, Tray, nativeImage, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')

const PRESETS = require('./src/presets')
const { serve, watch } = require('./src/server')
const { TargetStore } = require('./src/targets')

// The window is larger than the visual bar so the CSS shadow has room to fall.
// INSET is that transparent margin; gap is measured from the visible edge.
const BAR = { w: 560, h: 46, gap: 14 }
let barWidth = BAR.w   // grows to fit open wells, see 'bar:width'

// Feature gates. Everything stays wired; these only control what shows.
const FEATURES = { radius: true, scroll: true }

// Auto-scroll defaults for targets that predate the setting.
const SCROLL_DEFAULTS = { mode: 'steady', speed: 90, ease: 600, preroll: 2000, stride: 0.7, dwell: 1200, variation: 0.3, lockSeed: false, seed: 0 }   // Medium and Skim
// Presets per mode: a word instead of numbers. Anything else is Custom.
const SCROLL_PRESETS = {
  steady: [
    { name: 'Slow', speed: 45, ease: 900 },
    { name: 'Medium', speed: 90, ease: 600 },
    { name: 'Fast', speed: 180, ease: 400 }
  ],
  natural: [
    { name: 'Read', stride: 0.5, dwell: 2500, variation: 0.35 },
    { name: 'Skim', stride: 0.7, dwell: 1200, variation: 0.3 },
    { name: 'Sweep', stride: 0.9, dwell: 700, variation: 0.15 }
  ]
}

let stage = null   // the window
let view = null    // the page inside it, clipped to the corner radius
let bar = null
let tray = null
let store = null

// Suppresses the bar-follows-stage tether while the user is dragging the rig,
// so our repositioning can't fight the gesture.
let dragging = false
let dragOrigin = null

const current = {
  target: null,
  source: 'local',
  server: null,
  watcher: null
}

// --- windows ----------------------------------------------------------------

function createStage () {
  stage = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    frame: false,
    // Transparent so anything outside the view's corner radius shows through
    // rather than painting a square of background around it.
    transparent: true,
    backgroundColor: '#00000000',
    // No shadow and no macOS corner rounding: the shadow paints a rim line
    // around the page, and the recorder does its own corners.
    hasShadow: false,
    roundedCorners: false,
    show: false
  })

  // The page lives in a child view so the radius clips at the compositor.
  // Clipping the document root instead would break position:fixed, and sticky
  // headers are exactly what you'd be capturing.
  view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'ui', 'preload.js')
    }
  })
  stage.contentView.addChildView(view)
  layoutView()
  applyRadius(FEATURES.radius ? store.radius() : 0)
  if (FEATURES.scroll) hookScrollEvents(view.webContents)

  // Belt and braces: frame:false should already omit them, but be explicit.
  try { stage.setWindowButtonVisibility(false) } catch { /* not applicable */ }

  // There is no start screen. The stage only exists while a target is loaded;
  // with nothing open, the bar is the whole app.
  stage.on('move', () => { if (!dragging && stage.isVisible()) positionBar() })
  stage.on('resize', () => { layoutView(); if (!dragging && stage.isVisible()) positionBar() })
  stage.on('closed', () => {
    stage = null
    view = null
    if (bar && !bar.isDestroyed()) bar.close()
  })

  view.webContents.on('did-finish-load', () => suppressScrollbars(view.webContents))
  view.webContents.on('did-frame-finish-load', () => suppressScrollbars(view.webContents))

  // External links would make this a browser. Hand them to the real one.
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Bring the stage up centred on whichever display the bar is on, so opening
// a target from a bar you've parked somewhere puts the page next to it.
function showStage () {
  if (!stage || stage.isDestroyed() || stage.isVisible()) return
  const anchor = bar && !bar.isDestroyed() ? bar.getBounds() : stage.getBounds()
  const work = screen.getDisplayMatching(anchor).workArea
  const [w, h] = stage.getSize()
  stage.setPosition(
    Math.round(work.x + (work.width - w) / 2),
    Math.round(work.y + Math.max(0, (work.height - h - BAR.h - BAR.gap) / 2)),
    false
  )
  stage.show()
  positionBar()
}

function layoutView () {
  if (!stage || stage.isDestroyed() || !view) return
  const [w, h] = stage.getContentSize()
  view.setBounds({ x: 0, y: 0, width: w, height: h })
}

// Verified on Electron 44 / macOS 26.6.2: setBorderRadius() alone is not
// enough. Once the radius has been set to 0, the next bounds change (a size
// preset, even a one-pixel nudge) leaves the view's layer deaf to every later
// setBorderRadius — the value is stored but never reaches the compositor.
// Re-attaching the view runs Electron's OnViewAddedToWidget, which pushes the
// stored radius to a fresh layer. It's cheap: no reload, scroll and focus
// survive, and it costs at most a frame.
function applyRadius (r) {
  if (!view || !stage || stage.isDestroyed()) return
  const px = Math.max(0, Math.round(r || 0))
  try {
    view.setBorderRadius(px)
    stage.contentView.removeChildView(view)
    stage.contentView.addChildView(view)
    layoutView()
  } catch (e) {
    console.log('[stage] setBorderRadius failed:', e.message)
  }
}

function createBar () {
  bar = new BrowserWindow({
    width: BAR.w,
    height: BAR.h,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    // Real blur of whatever is behind the window. 'active' keeps the material
    // lit even though the bar is almost never the focused window.
    vibrancy: 'under-window',
    visualEffectState: 'active',
    type: 'panel',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'ui', 'preload.js')
    }
  })

  bar.setAlwaysOnTop(true, 'floating')
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applyBarCapture()

  if (FEATURES.scroll) hookScrollEvents(bar.webContents)
  bar.loadFile(path.join(__dirname, 'ui', 'bar.html'))
  bar.once('ready-to-show', () => {
    stage && stage.isVisible() ? positionBar() : centerBar()
    bar.showInactive()
    pushState()
  })
}

// Verified on macOS 26.6.2: content protection omits the bar from
// ScreenCaptureKit entirely. It's on unless you're recording blank itself.
function applyBarCapture () {
  if (!bar || bar.isDestroyed()) return
  bar.setContentProtection(!store.barInCaptures())
}

function barCaptureItem () {
  return {
    label: 'Show Bar in Recordings',
    type: 'checkbox',
    checked: store.barInCaptures(),
    click: (mi) => { store.setBarInCaptures(mi.checked); applyBarCapture(); pushState() }
  }
}

// Centered under the stage, flipping above when there's no room below.
function barBoundsFor (s) {
  const work = screen.getDisplayMatching(s).workArea

  let x = Math.round(s.x + (s.width - barWidth) / 2)
  x = Math.max(work.x + 8, Math.min(x, work.x + work.width - barWidth - 8))

  let y = s.y + s.height + BAR.gap
  if (y + BAR.h > work.y + work.height) y = s.y - BAR.h - BAR.gap
  y = Math.max(work.y + 8, Math.min(y, work.y + work.height - BAR.h - 8))

  return { x, y: Math.round(y), width: barWidth, height: BAR.h }
}

function positionBar () {
  if (!stage || !bar || stage.isDestroyed() || bar.isDestroyed()) return
  if (!stage.isVisible()) return           // nothing to tether to; stay put
  bar.setBounds(barBoundsFor(stage.getBounds()))
}

// With no stage, the bar goes back to where it was last parked, or failing
// that (first run, display gone) to the middle of the display you're on.
function centerBar () {
  if (!bar || bar.isDestroyed()) return
  const last = store.barPos()
  if (last) {
    const d = screen.getAllDisplays().find(d => {
      const b = d.workArea
      return last.x >= b.x && last.x + barWidth <= b.x + b.width && last.y >= b.y && last.y + BAR.h <= b.y + b.height
    })
    if (d) { bar.setBounds({ x: last.x, y: last.y, width: barWidth, height: BAR.h }); return }
  }
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  bar.setBounds({
    x: Math.round(work.x + (work.width - barWidth) / 2),
    y: Math.round(work.y + (work.height - BAR.h) / 2),
    width: barWidth, height: BAR.h
  })
}

// --- scrollbars -------------------------------------------------------------

const SCROLLBAR_CSS = `
  html { scrollbar-width: none !important; }
  html::-webkit-scrollbar, body::-webkit-scrollbar,
  *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
`

function suppressScrollbars (wc) {
  wc.insertCSS(SCROLLBAR_CSS).catch(() => {})
  const walk = (frame) => {
    for (const child of frame.frames) {
      child.executeJavaScript(`(() => {
        if (document.getElementById('__stage_sb')) return
        const s = document.createElement('style')
        s.id = '__stage_sb'
        s.textContent = ${JSON.stringify(SCROLLBAR_CSS)}
        document.documentElement.appendChild(s)
      })()`).catch(() => {})
      walk(child)
    }
  }
  try { walk(wc.mainFrame) } catch { /* frame gone mid-walk */ }
}

// --- loading ----------------------------------------------------------------

async function teardownSource () {
  if (current.watcher) { current.watcher.close(); current.watcher = null }
  if (current.server) { await current.server.close(); current.server = null }
}

async function loadTarget (target, source, { keepScroll = false } = {}) {
  if (!target) return
  const y = keepScroll ? await getScroll() : 0

  current.target = target
  current.source = source
  await teardownSource()

  let url = null
  if (source === 'local' && target.localPath) {
    const isFile = fs.existsSync(target.localPath) && fs.statSync(target.localPath).isFile()
    const root = path.resolve(isFile ? path.dirname(target.localPath) : target.localPath)
    const entry = isFile ? '/' + path.basename(target.localPath) : '/'

    current.server = await serve(root)
    url = current.server.origin + entry

    // Local folders always live-reload, keeping the scroll position.
    current.watcher = watch(root, async () => {
      const at = await getScroll()
      view.webContents.reload()
      restoreScroll(at)
    })
  } else if (source === 'live' && target.liveUrl) {
    url = target.liveUrl
  }

  if (!url) { closeTarget(); return }

  applySize(target.size, { save: false })
  await view.webContents.loadURL(url).catch(() => {})
  if (keepScroll && y) restoreScroll(y)
  showStage()

  store.touch(target.id)
  store.update(target.id, { source })
  pushState()
}

function getScroll () {
  if (!stage || stage.isDestroyed()) return Promise.resolve(0)
  return view.webContents.executeJavaScript('window.scrollY').catch(() => 0)
}

function restoreScroll (y) {
  if (!y) return
  const once = () => {
    view.webContents.executeJavaScript(
      `requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, ${y})))`
    ).catch(() => {})
    view.webContents.off('did-finish-load', once)
  }
  view.webContents.on('did-finish-load', once)
}

function closeTarget () {
  current.target = null
  teardownSource()
  if (stage && !stage.isDestroyed()) stage.hide()
  if (view) view.webContents.loadURL('about:blank').catch(() => {})
  centerBar()
  pushState()
}

function applySize (size, { save = true } = {}) {
  if (!stage || stage.isDestroyed() || !size) return
  stage.setContentSize(Math.round(size.w), Math.round(size.h))
  layoutView()
  positionBar()
  if (save && current.target) store.update(current.target.id, { size })
  pushState()
}

// --- state ------------------------------------------------------------------

// What the bar shows: whichever address is actually on screen.
function addressOf (t, source) {
  if (!t) return ''
  return source === 'live' ? (t.liveUrl || '') : (t.localPath || t.liveUrl || '')
}

function pushState () {
  if (!bar || bar.isDestroyed()) return
  const work = stage && !stage.isDestroyed()
    ? screen.getDisplayMatching(stage.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea

  const t = current.target
  const payload = {
    target: t ? { id: t.id, name: t.name, url: addressOf(t, current.source) } : null,
    size: stage && !stage.isDestroyed() && stage.isVisible()
      ? { w: stage.getContentSize()[0], h: stage.getContentSize()[1] }
      : null,
    presets: PRESETS,
    radius: store.radius(),
    features: FEATURES,
    scroll: { ...scrollSettings(), preset: scrollPreset() },
    scrollPresets: Object.fromEntries(Object.entries(SCROLL_PRESETS).map(([m, l]) => [m, l.map(p => p.name)])),
    scrolling: scrollState,
    maxFit: { w: work.width, h: work.height },
    recents: store.all().slice(0, 8).map(r => ({ id: r.id, name: r.name }))
  }

  bar.webContents.send('state', payload)
  if (view && !view.webContents.isDestroyed()) view.webContents.send('state', payload)
}

// --- entry points -----------------------------------------------------------

function normalizeUrl (raw) {
  let u = String(raw || '').trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try { new URL(u); return u } catch { return null }
}

async function openPath (p) {
  if (p && p.startsWith('~')) p = path.join(app.getPath('home'), p.slice(1))
  if (!p || !fs.existsSync(p)) return
  const t = store.upsert({ localPath: path.resolve(p) })
  await loadTarget(t, 'local')
  if (bar && !bar.isDestroyed() && !bar.isVisible()) bar.showInactive()
}

async function openUrl (raw) {
  const u = normalizeUrl(raw)
  if (!u) return
  const t = store.upsert({ liveUrl: u })
  await loadTarget(t, 'live')
}

async function pickTarget () {
  const r = await dialog.showOpenDialog({
    title: 'Open a file or folder',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Web', extensions: ['html', 'htm'] }]
  })
  if (!r.canceled && r.filePaths[0]) openPath(r.filePaths[0])
}

// --- auto-scroll ------------------------------------------------------------
// The motion itself runs in the page's preload (see ui/preload.js); main owns
// the settings, the shortcuts, and the last phase the engine reported.

let scrollState = null

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function scrollSettings () {
  const s = (current.target && current.target.scroll) || {}
  // The first targets stored a named easing; map it onto a ramp duration.
  const ease = Number.isFinite(s.ease) ? s.ease
    : ({ none: 0, gentle: 600, soft: 1200 }[s.easing] ?? SCROLL_DEFAULTS.ease)
  const num = (k) => Number.isFinite(s[k]) ? s[k] : SCROLL_DEFAULTS[k]
  return {
    mode: s.mode === 'natural' ? 'natural' : 'steady',
    speed: num('speed'),
    ease,
    preroll: num('preroll'),
    stride: num('stride'),
    dwell: num('dwell'),
    variation: num('variation'),
    lockSeed: !!s.lockSeed,
    seed: num('seed')
  }
}

// The preset whose numbers the settings match, or 'Custom'.
function scrollPreset (s = scrollSettings()) {
  const near = (a, b) => Math.abs(a - b) < 1e-6
  const hit = SCROLL_PRESETS[s.mode].find(p => Object.keys(p).every(k => k === 'name' || near(p[k], s[k])))
  return hit ? hit.name : 'Custom'
}

function applyScrollPreset (name) {
  const s = scrollSettings()
  const p = SCROLL_PRESETS[s.mode].find(p => p.name === name)
  if (p) setScroll({ ...p })
}

function setScroll (patch) {
  if (!current.target) return
  const n = { ...scrollSettings(), ...patch }
  store.update(current.target.id, {
    scroll: {
      mode: n.mode === 'natural' ? 'natural' : 'steady',
      speed: clamp(Math.round(n.speed) || SCROLL_DEFAULTS.speed, 5, 2000),
      ease: clamp(Math.round(n.ease) || 0, 0, 10000),
      preroll: clamp(Math.round(n.preroll) || 0, 0, 30000),
      stride: clamp(Number(n.stride) || SCROLL_DEFAULTS.stride, 0.1, 3),
      dwell: clamp(Math.round(n.dwell) || 0, 0, 30000),
      variation: clamp(Number(n.variation) || 0, 0, 1),
      lockSeed: !!n.lockSeed,
      seed: Math.round(n.seed) || 0
    }
  })
  pushState()
  // A running scroll picks the change up live; pre-roll and seed wait for the next start.
  if (scrollState && scrollState.active) scrollCmd('tune')
}

function scrollCmd (cmd, extra = {}) {
  if (!view || !current.target || view.webContents.isDestroyed()) return
  view.webContents.send('scroll:cmd', { cmd, ...scrollSettings(), ...extra })
}

// ⌥↓ while already scrolling down stops; ⌥↑ mid-run turns around.
function startScroll (dir) {
  if (scrollState && scrollState.active && scrollState.dir === dir) { scrollCmd('stop'); return }
  const s = scrollSettings()
  // A natural take is seeded so it can be repeated. Fresh each time unless
  // the rhythm is locked, in which case the last seed is reused.
  let seed = s.seed
  if (s.mode === 'natural' && !(s.lockSeed && seed)) {
    seed = 1 + Math.floor(Math.random() * 0x7fffffff)
    store.update(current.target.id, { scroll: { ...s, seed } })
  }
  scrollCmd('start', { dir, seed })
}

function hookScrollEvents (wc) {
  wc.on('before-input-event', (e, input) => {
    const plain = !input.meta && !input.control
    if (input.alt && plain && (input.key === 'ArrowDown' || input.key === 'ArrowUp')) {
      e.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) startScroll(input.key === 'ArrowDown' ? 1 : -1)
      return
    }

    // Esc stops. Hold-P lives in the preload: preventing a keyDown here
    // swallows its keyUp too, so main can never see the key released.
    if (scrollState && scrollState.active && input.key === 'Escape' && input.type === 'keyDown') {
      e.preventDefault()
      scrollCmd('stop')
    }
  })

  // A full navigation replaces the preload world, and the engine with it.
  wc.on('did-navigate', () => { scrollState = null; pushState() })
}

ipcMain.on('scroll:state', (e, st) => {
  if (!view || e.sender !== view.webContents) return
  scrollState = st
  pushState()
})

function scrollSubmenu () {
  const s = scrollSettings()
  const t = current.target
  const active = !!(scrollState && scrollState.active)
  const natural = s.mode === 'natural'

  const pick = (values, key, fmt) => values.map(v => ({
    label: fmt(v), type: 'checkbox', checked: s[key] === v, click: () => setScroll({ [key]: v })
  })).concat({ type: 'separator' }, {
    label: 'Custom…', click: () => bar && bar.webContents.send('custom-scroll', key)
  })
  const ms = (v) => v ? `${v} ms` : 'None'
  const sec = (v) => v ? `${v / 1000} s` : 'None'
  const pct = (v) => v ? `${Math.round(v * 100)}%` : 'None'
  const screens = (v) => v === 1 ? 'Full screen' : `${Math.round(v * 100)}% of screen`

  const preset = scrollPreset(s)
  const presets = SCROLL_PRESETS[s.mode].map(p => ({
    label: p.name, type: 'radio', checked: preset === p.name, click: () => applyScrollPreset(p.name)
  })).concat({ label: 'Custom', type: 'radio', checked: preset === 'Custom', enabled: preset === 'Custom' })

  // Only the settings the chosen mode reads. Pre-roll applies to both.
  const settings = natural ? [
    { label: `Stride: ${screens(s.stride)}`, submenu: pick([0.33, 0.5, 0.6, 0.8, 1], 'stride', screens) },
    { label: `Dwell: ${sec(s.dwell)}`, submenu: pick([500, 1000, 1500, 2500, 4000], 'dwell', sec) },
    { label: `Variation: ${pct(s.variation)}`, submenu: pick([0, 0.15, 0.3, 0.5], 'variation', pct) },
    { label: 'Same rhythm each take', type: 'checkbox', checked: s.lockSeed, click: () => setScroll({ lockSeed: !s.lockSeed }) }
  ] : [
    { label: `Speed: ${s.speed} px/s`, submenu: pick([30, 60, 90, 150, 300], 'speed', v => `${v} px/s`) },
    { label: `Easing: ${ms(s.ease)}`, submenu: pick([0, 300, 600, 1200, 2000], 'ease', ms) }
  ]

  return [
    { label: 'Scroll Down    ⌥↓', enabled: !!t, click: () => startScroll(1) },
    { label: 'Scroll Up    ⌥↑', enabled: !!t, click: () => startScroll(-1) },
    { label: 'Stop    esc', enabled: active, click: () => scrollCmd('stop') },
    { label: 'Hold P to pause', enabled: false },
    { type: 'separator' },
    { label: 'Steady', type: 'radio', checked: !natural, click: () => setScroll({ mode: 'steady' }) },
    { label: 'Natural', type: 'radio', checked: natural, click: () => setScroll({ mode: 'natural' }) },
    { type: 'separator' },
    ...presets,
    { type: 'separator' },
    ...settings,
    { label: `Pre-roll: ${sec(s.preroll)}`, submenu: pick([0, 1000, 2000, 3000, 5000], 'preroll', sec) }
  ]
}

function popupScrollMenu () {
  Menu.buildFromTemplate(scrollSubmenu()).popup({ window: bar })
}

// --- menus ------------------------------------------------------------------

function buildMenu () {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'blank',
      submenu: [
        { label: 'Open…', accelerator: 'Cmd+O', click: pickTarget },
        { label: 'Close Page', accelerator: 'Cmd+Shift+W', click: closeTarget },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'Cmd+R', click: () => view && view.webContents.reload() },
        { type: 'separator' },
        ...(FEATURES.scroll ? [
          { label: 'Scroll Down    ⌥↓', click: () => startScroll(1) },
          { label: 'Scroll Up    ⌥↑', click: () => startScroll(-1) },
          { label: 'Stop Scrolling    esc', click: () => scrollCmd('stop') },
          { type: 'separator' }
        ] : []),
        {
          label: 'Focus Bar',
          accelerator: 'Cmd+K',
          click: () => {
            if (!bar || bar.isDestroyed()) return
            if (!bar.isVisible()) showRig()
            bar.focus()
            bar.webContents.send('focus-input')
          }
        },
        { label: 'Hide blank', accelerator: 'Cmd+.', click: hideRig }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]))
}

function popupSizeMenu () {
  if (!stage || stage.isDestroyed()) return
  const [cw, ch] = stage.getContentSize()
  const work = screen.getDisplayMatching(stage.getBounds()).workArea

  const items = PRESETS.map(p => {
    if (p.group) return { type: 'separator' }
    const over = p.w > work.width || p.h > work.height
    return {
      label: `${p.w} × ${p.h}   ${p.label}${over ? '  ▲' : ''}`,
      type: 'checkbox',
      checked: cw === p.w && ch === p.h,
      click: () => applySize({ w: p.w, h: p.h })
    }
  })

  items.unshift({ label: `Current: ${cw} × ${ch}`, enabled: false }, { type: 'separator' })
  items.push({ type: 'separator' }, {
    label: 'Add Custom Size…',
    click: () => bar && bar.webContents.send('custom-size')
  })

  Menu.buildFromTemplate(items).popup({ window: bar })
}

function setRadius (r) {
  applyRadius(store.setRadius(r))
  pushState()
}

function popupMoreMenu () {
  const t = current.target
  Menu.buildFromTemplate([
    { label: 'Reload', accelerator: 'Cmd+R', enabled: !!t, click: () => view && view.webContents.reload() },
    { type: 'separator' },
    ...(FEATURES.scroll ? [{ label: 'Auto-scroll', submenu: scrollSubmenu() }] : []),
    ...(FEATURES.scroll ? [{ type: 'separator' }] : []),
    { label: 'Open File or Folder…', accelerator: 'Cmd+O', click: pickTarget },
    { label: 'Close Page', accelerator: 'Cmd+Shift+W', enabled: !!t, click: closeTarget },
    { type: 'separator' },
    barCaptureItem(),
    { label: 'Hide blank', accelerator: 'Cmd+.', click: hideRig },
    ...(updateReady ? [{ type: 'separator' }, updateItem()] : [])
  ]).popup({ window: bar })
}

// --- updates ----------------------------------------------------------------
// Checks the GitHub release feed on launch and every few hours, downloads
// quietly, and offers "Update to x.y.z" in the menus. Nothing interrupts a
// recording: the swap only happens when you choose it, or on quit.

let updateReady = null   // { version } once a build is downloaded and waiting

function setupUpdates () {
  if (!app.isPackaged) return             // dev runs have nothing to update
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('update-downloaded', (info) => { updateReady = { version: info.version } })
  autoUpdater.on('error', (e) => console.log('[blank] update check failed:', e.message))
  autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}

async function checkForUpdatesNow () {
  if (!app.isPackaged) return
  try {
    const r = await autoUpdater.checkForUpdates()
    const latest = r && r.updateInfo && r.updateInfo.version
    if (!latest || latest === app.getVersion()) {
      dialog.showMessageBox({ message: `blank ${app.getVersion()} is up to date.`, buttons: ['OK'] })
    }
    // Otherwise the download is already under way; the menu will offer it.
  } catch (e) {
    dialog.showMessageBox({ type: 'warning', message: 'Couldn\u2019t check for updates.', detail: e.message, buttons: ['OK'] })
  }
}

function updateItem () {
  return updateReady
    ? { label: `Update to ${updateReady.version}`, click: () => autoUpdater.quitAndInstall() }
    : { label: `blank ${app.getVersion()}`, enabled: false }
}

// --- menu bar ---------------------------------------------------------------
// blank lives in the menu bar, not the Dock. Click the icon to summon the rig
// or put it away; right-click for the few things that aren't in the bar.

function rigVisible () {
  return !!(bar && !bar.isDestroyed() && bar.isVisible())
}

function showRig () {
  if (!bar || bar.isDestroyed()) return
  if (current.target && stage && !stage.isDestroyed()) {
    stage.show()
    positionBar()
  } else {
    centerBar()
  }
  bar.showInactive()
  bar.focus()
}

function hideRig () {
  if (stage && !stage.isDestroyed()) stage.hide()
  if (bar && !bar.isDestroyed()) bar.hide()
}

function toggleRig () {
  rigVisible() ? hideRig() : showRig()
}

function trayMenu () {
  const t = current.target
  const login = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false
  return Menu.buildFromTemplate([
    updateItem(),
    { type: 'separator' },
    { label: rigVisible() ? 'Hide blank' : 'Show blank', click: toggleRig },
    { type: 'separator' },
    { label: 'Open File or Folder…', click: () => { showRig(); pickTarget() } },
    { label: t ? `Close ${t.name}` : 'Close Page', enabled: !!t, click: closeTarget },
    { type: 'separator' },
    barCaptureItem(),
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: login,
      enabled: app.isPackaged,       // in dev this would register Electron itself
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked })
    },
    { label: 'Check for Updates…', enabled: app.isPackaged, click: checkForUpdatesNow },
    { type: 'separator' },
    { label: 'Quit blank', accelerator: 'Cmd+Q', click: () => app.quit() }
  ])
}

function createTray () {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray', 'iconTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('blank')
  tray.on('click', toggleRig)
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()))
}

// --- ipc --------------------------------------------------------------------

ipcMain.handle('stage:setSize', (_e, size) => applySize(size))
ipcMain.handle('stage:reload', () => view && view.webContents.reload())
ipcMain.handle('stage:pick', () => pickTarget())
ipcMain.handle('stage:openPath', (_e, p) => openPath(p))
ipcMain.handle('stage:openUrl', (_e, u) => openUrl(u))
ipcMain.handle('stage:openRecent', (_e, id) => {
  const t = store.get(id)
  if (t) loadTarget(t, t.localPath ? 'local' : 'live')
})
ipcMain.handle('stage:setRadius', (_e, r) => setRadius(r))
ipcMain.handle('stage:sizeMenu', popupSizeMenu)
ipcMain.handle('stage:moreMenu', popupMoreMenu)
ipcMain.handle('stage:scrollMenu', popupScrollMenu)
ipcMain.handle('stage:setScroll', (_e, patch) => setScroll(patch || {}))
ipcMain.handle('stage:scroll', (_e, dir) => startScroll(dir < 0 ? -1 : 1))
ipcMain.handle('stage:scrollStop', () => scrollCmd('stop'))
ipcMain.handle('stage:scrollAs', (_e, mode, dir) => { setScroll({ mode }); startScroll(dir < 0 ? -1 : 1) })
ipcMain.handle('stage:scrollPreset', (_e, name) => applyScrollPreset(name))
ipcMain.handle('stage:focusStage', () => stage && stage.isVisible() && stage.focus())

// Manual drag: both windows move from a recorded origin plus the pointer delta,
// so there's no accumulated drift and no tether fighting the gesture.
// The bar asks for the width its controls need; anything under the base
// width means the base. It stays centred under the stage, or on its own
// centre when there's none.
ipcMain.on('bar:width', (_e, w) => {
  const next = Math.max(BAR.w, Math.round(w) || 0)
  if (next === barWidth || !bar || bar.isDestroyed()) return
  const b = bar.getBounds()
  barWidth = next
  if (stage && !stage.isDestroyed() && stage.isVisible()) positionBar()
  else bar.setBounds({ x: Math.round(b.x + (b.width - next) / 2), y: b.y, width: next, height: BAR.h })
})

ipcMain.on('drag:start', () => {
  if (!stage || stage.isDestroyed() || !bar || bar.isDestroyed()) return
  dragging = true
  dragOrigin = { stage: stage.getBounds(), bar: bar.getBounds() }
})

ipcMain.on('drag:move', (_e, { dx, dy }) => {
  if (!dragging || !dragOrigin) return
  if (!stage || stage.isDestroyed() || !bar || bar.isDestroyed()) return

  // Pointer screen coordinates are fractional on scaled displays, and
  // setPosition only accepts integers — round before it reaches the binding.
  const x = Math.round(dx)
  const y = Math.round(dy)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return

  stage.setPosition(dragOrigin.stage.x + x, dragOrigin.stage.y + y, false)
  bar.setPosition(dragOrigin.bar.x + x, dragOrigin.bar.y + y, false)
})

ipcMain.on('drag:end', () => {
  dragging = false
  dragOrigin = null
  positionBar()   // re-snap in case the rig crossed a display edge
  rememberBar()
  pushState()
})

function rememberBar () {
  if (bar && !bar.isDestroyed() && store) store.setBarPos(bar.getBounds())
}

// --- lifecycle --------------------------------------------------------------

let pendingOpen = null
app.on('open-file', (e, p) => {
  e.preventDefault()
  app.isReady() ? openPath(p) : (pendingOpen = p)
})

function cliArgs (argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  const flag = args.find(a => a.startsWith('--radius='))
  return {
    target: args.find(a => !a.startsWith('-')) || null,
    radius: flag ? parseInt(flag.split('=')[1], 10) : null
  }
}

app.whenReady().then(async () => {
  store = new TargetStore(app.getPath('userData'))
  if (app.dock) app.dock.hide()          // menu bar only; see createTray
  buildMenu()
  createStage()
  createBar()
  createTray()
  setupUpdates()

  const cli = cliArgs(process.argv)
  if (FEATURES.radius && Number.isFinite(cli.radius)) setRadius(cli.radius)

  // Nothing opens on its own: a plain launch is just the bar.
  const first = pendingOpen || cli.target
  if (first) /^https?:\/\//i.test(first) ? await openUrl(first) : await openPath(first)

  // Dev hook: STAGE_PROBE=script.js hands a script the live internals.
  if (process.env.STAGE_PROBE) {
    require(path.resolve(process.env.STAGE_PROBE))({
      stage: () => stage, view: () => view, bar: () => bar,
      startScroll, scrollCmd, setScroll, setRadius, applySize, openPath, closeTarget, storeRadius: () => store.radius(), toggleRig,
      storeBarInCaptures: () => store.barInCaptures(), scrollSettingsNow: scrollSettings, setBarInCaptures: (on) => { store.setBarInCaptures(on); applyBarCapture() },
      scrollState: () => scrollState
    })
  }
})

app.on('window-all-closed', () => { /* the tray keeps us alive */ })
app.on('before-quit', () => { rememberBar(); teardownSource() })
