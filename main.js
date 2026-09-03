const { app, BrowserWindow, WebContentsView, ipcMain, dialog, screen, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const PRESETS = require('./src/presets')
const { serve, watch } = require('./src/server')
const { TargetStore } = require('./src/targets')

// The window is larger than the visual bar so the CSS shadow has room to fall.
// INSET is that transparent margin; gap is measured from the visible edge.
const BAR = { w: 560, h: 46, gap: 14 }

// Corner radius is hidden until the reset-to-0 problem is solved: setting a
// non-zero radius works, but going back to 0 leaves the old clip in place.
// Flip to true to bring the control back; the plumbing below is intact.
const RADIUS_UI = false

let stage = null   // the window
let view = null    // the page inside it, clipped to the corner radius
let bar = null
let store = null

// Suppresses the bar-follows-stage tether while the user is dragging the rig,
// so our repositioning can't fight the gesture.
let dragging = false
let dragOrigin = null

const current = {
  target: null,
  source: 'local',
  server: null,
  watcher: null,
  liveReload: true
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
    hasShadow: true,
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
  applyRadius(store.radius())

  // Belt and braces: frame:false should already omit them, but be explicit.
  try { stage.setWindowButtonVisibility(false) } catch { /* not applicable */ }

  // 'ready-to-show' fires for a window's OWN webContents, and this window
  // doesn't have one any more — the page lives in the child view. Show once
  // the view paints, with an immediate fallback so a failed load can't leave
  // the window invisible.
  view.webContents.once('did-finish-load', () => { if (stage && !stage.isDestroyed()) stage.show() })
  setTimeout(() => { if (stage && !stage.isDestroyed() && !stage.isVisible()) stage.show() }, 1500)
  stage.on('move', () => { if (!dragging) positionBar() })
  stage.on('resize', () => { layoutView(); if (!dragging) positionBar() })
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

  showLauncher()
}

function layoutView () {
  if (!stage || stage.isDestroyed() || !view) return
  const [w, h] = stage.getContentSize()
  view.setBounds({ x: 0, y: 0, width: w, height: h })
}

function applyRadius (r) {
  if (!view || !stage || stage.isDestroyed()) return
  const px = Math.max(0, Math.round(r || 0))
  try {
    view.setBorderRadius(px)

    // Setting the same bounds is a no-op, so the existing corner clip survives
    // — going 40 -> 0 left the view still rounded. Nudge the height by a pixel
    // and back to force a genuine relayout that rebuilds the clip.
    const [w, h] = stage.getContentSize()
    view.setBounds({ x: 0, y: 0, width: w, height: Math.max(1, h - 1) })
    view.setBounds({ x: 0, y: 0, width: w, height: h })

    console.log('[stage] applied border radius:', px)
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
  // Verified on macOS 26.6.2: omits this window from ScreenCaptureKit entirely.
  bar.setContentProtection(true)

  bar.loadFile(path.join(__dirname, 'ui', 'bar.html'))
  bar.once('ready-to-show', () => { bar.showInactive(); positionBar(); pushState() })
}

// Centered under the stage, flipping above when there's no room below.
function barBoundsFor (s) {
  const work = screen.getDisplayMatching(s).workArea

  let x = Math.round(s.x + (s.width - BAR.w) / 2)
  x = Math.max(work.x + 8, Math.min(x, work.x + work.width - BAR.w - 8))

  let y = s.y + s.height + BAR.gap
  if (y + BAR.h > work.y + work.height) y = s.y - BAR.h - BAR.gap
  y = Math.max(work.y + 8, Math.min(y, work.y + work.height - BAR.h - 8))

  return { x, y: Math.round(y), width: BAR.w, height: BAR.h }
}

function positionBar () {
  if (!stage || !bar || stage.isDestroyed() || bar.isDestroyed()) return
  bar.setBounds(barBoundsFor(stage.getBounds()))
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

    if (current.liveReload) {
      current.watcher = watch(root, async () => {
        const at = await getScroll()
        view.webContents.reload()
        restoreScroll(at)
      })
    }
  } else if (source === 'live' && target.liveUrl) {
    url = target.liveUrl
  }

  if (!url) { showLauncher(); return }

  applySize(target.size, { save: false })
  await view.webContents.loadURL(url).catch(() => {})
  if (keepScroll && y) restoreScroll(y)

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

function showLauncher () {
  current.target = null
  teardownSource()
  view.webContents.loadFile(path.join(__dirname, 'ui', 'launcher.html'))
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
    liveReload: current.liveReload,
    size: stage && !stage.isDestroyed()
      ? { w: stage.getContentSize()[0], h: stage.getContentSize()[1] }
      : null,
    presets: PRESETS,
    radius: store.radius(),
    radiusUI: RADIUS_UI,
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

// --- menus ------------------------------------------------------------------

function buildMenu () {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Stage',
      submenu: [
        { label: 'Open…', accelerator: 'Cmd+O', click: pickTarget },
        { label: 'Close Target', accelerator: 'Cmd+Shift+W', click: showLauncher },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'Cmd+R', click: () => view && view.webContents.reload() },
        { type: 'separator' },
        {
          label: 'Focus Bar',
          accelerator: 'Cmd+K',
          click: () => {
            if (!bar || bar.isDestroyed()) return
            if (!bar.isVisible()) bar.showInactive()
            bar.focus()
            bar.webContents.send('focus-input')
          }
        },
        {
          label: 'Toggle Bar',
          accelerator: 'Cmd+.',
          click: () => {
            if (!bar || bar.isDestroyed()) return
            bar.isVisible() ? bar.hide() : bar.showInactive()
          }
        }
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

function radiusSubmenu () {
  const cur = store.radius()
  const items = [0, 6, 10, 14, 18, 24, 32].map(r => ({
    label: r === 0 ? 'Square' : `${r} px`,
    type: 'checkbox',
    checked: cur === r,
    click: () => setRadius(r)
  }))
  items.push({ type: 'separator' }, {
    label: 'Custom…',
    click: () => bar && bar.webContents.send('custom-radius')
  })
  return items
}

function setRadius (r) {
  applyRadius(store.setRadius(r))
  pushState()
}

function popupRadiusMenu () {
  Menu.buildFromTemplate([
    { label: `Current: ${store.radius()} px`, enabled: false },
    { type: 'separator' },
    ...radiusSubmenu()
  ]).popup({ window: bar })
}

function popupMoreMenu () {
  const t = current.target
  Menu.buildFromTemplate([
    {
      label: 'Reload on file change',
      type: 'checkbox',
      checked: current.liveReload,
      enabled: !!(t && t.localPath),
      click: (mi) => {
        current.liveReload = mi.checked
        if (t) loadTarget(t, current.source, { keepScroll: true })
      }
    },
    { label: 'Reload now', accelerator: 'Cmd+R', click: () => view && view.webContents.reload() },
    { type: 'separator' },
    ...(RADIUS_UI ? [{ label: 'Corner Radius', submenu: radiusSubmenu() }, { type: 'separator' }] : []),
    { label: 'Open File or Folder…', accelerator: 'Cmd+O', click: pickTarget },
    { label: 'Close Target', enabled: !!t, click: showLauncher },
    { type: 'separator' },
    {
      label: 'Forget This Target',
      enabled: !!t,
      click: () => { store.remove(t.id); showLauncher() }
    },
    { label: 'Hide Bar', accelerator: 'Cmd+.', click: () => bar && bar.hide() }
  ]).popup({ window: bar })
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
ipcMain.handle('stage:radiusMenu', popupRadiusMenu)
ipcMain.handle('stage:moreMenu', popupMoreMenu)
ipcMain.handle('stage:focusStage', () => stage && stage.focus())

// Manual drag: both windows move from a recorded origin plus the pointer delta,
// so there's no accumulated drift and no tether fighting the gesture.
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
  pushState()
})

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
  buildMenu()
  createStage()
  createBar()

  const cli = cliArgs(process.argv)
  if (Number.isFinite(cli.radius)) setRadius(cli.radius)

  const first = pendingOpen || cli.target
  if (first) {
    /^https?:\/\//i.test(first) ? await openUrl(first) : await openPath(first)
  } else {
    const last = store.last()
    if (last) await loadTarget(last, last.source || (last.localPath ? 'local' : 'live'))
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', teardownSource)
