const { contextBridge, ipcRenderer, webUtils } = require('electron')

// This preload runs in whatever the stage loads, including live websites, so
// the privileged API is exposed only to our own UI pages. Everything else gets
// the drag listener alone, which lives in the isolated world where page script
// can neither see nor call it.
const isOwnUI =
  location.protocol === 'file:' && /\/(launcher|bar)\.html$/.test(location.pathname)

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
    radiusMenu: ()     => ipcRenderer.invoke('stage:radiusMenu'),
    moreMenu:   ()     => ipcRenderer.invoke('stage:moreMenu'),
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
    onCustomRadius: (fn) => ipcRenderer.on('custom-radius', fn)
  })
}
