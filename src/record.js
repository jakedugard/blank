// Recording: the stage window, captured by macOS as a single window (so the
// bar never appears), encoded by Chromium's own recorder straight to H.264
// MP4. The encoder has to live in a renderer, so a hidden window hosts it
// and streams chunks back here to be written to disk.

const { BrowserWindow, desktopCapturer, session, systemPreferences, shell, app } = require('electron')
const fs = require('fs')
const path = require('path')

const FPS = 60
const START_TIMEOUT = 6000   // the encoder has this long to say it's rolling
const BITRATE = 40e6   // 40 Mb/s at 2880×1800: generous for UI motion; scaled down with the output size

let recWin = null      // the hidden encoder window
let job = null         // { file, stream, onState, name }
let source = null      // the stage window as a capture source, resolved per take

function permission () {
  // 'granted' | 'denied' | 'restricted' | 'unknown' (not asked yet)
  return systemPreferences.getMediaAccessStatus('screen')
}

// macOS has no request API for screen recording: the first capture attempt
// raises the system prompt, and after that it's the Settings pane.
function openPermissionSettings () {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
}

function ensureRecorder (preload) {
  if (recWin && !recWin.isDestroyed()) return recWin
  recWin = new BrowserWindow({
    show: false, width: 320, height: 200,
    webPreferences: { contextIsolation: true, preload, backgroundThrottling: false }
  })
  recWin.loadFile(path.join(__dirname, '..', 'ui', 'recorder.html'))
  // Whatever the recorder asks for, hand it the stage window.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    if (source) cb({ video: source, audio: undefined })
    else cb(null)
  })
  return recWin
}

function folder () {
  const dir = path.join(app.getPath('videos'), 'blank')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

// Start a take of `stage`. `name` names the file; `onState` hears
// 'recording' | 'saved' | 'failed' with a detail.
async function start ({ stage, preload, name, matte = '#ffffff', radius = 0, scale = 2, onState }) {
  if (job) return
  if (!stage || stage.isDestroyed() || !stage.isVisible()) return onState('failed', 'no page')

  const win = ensureRecorder(preload)
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r))

  // Ask the OS for the stage window. This is also what raises the permission
  // prompt the first time.
  const id = stage.getMediaSourceId()
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).catch(() => [])
  source = sources.find(s => s.id === id) || null
  if (!source) {
    const why = permission() === 'granted' ? 'the page window could not be captured' : 'screen recording permission is needed'
    return onState('failed', why)
  }

  const file = path.join(folder(), `${(name || 'blank').replace(/[/:]/g, '-')} ${stamp()}.mp4`)
  job = { file, stream: fs.createWriteStream(file), onState, bytes: 0, watchdog: null }
  // If the encoder never reports back, the take is over before it began. Say so
  // rather than sit in a recording state nothing can leave.
  job.watchdog = setTimeout(() => {
    if (job && !job.rolling) failed('the recorder did not start')
  }, START_TIMEOUT)
  const [cssWidth, cssHeight] = stage.getContentSize()
  win.webContents.send('rec:start', { fps: FPS, bitrate: BITRATE, matte, radius, scale, cssWidth, cssHeight })
}

function stop () {
  if (!job || !recWin || recWin.isDestroyed()) return
  recWin.webContents.send('rec:stop')
}

function chunk (buf) {
  if (!job) return
  job.bytes += buf.byteLength
  job.stream.write(Buffer.from(buf))
}

function started () {
  if (!job) return
  job.rolling = true
  clearTimeout(job.watchdog)
  job.onState('recording', job.file)
}

function done () {
  const j = job
  job = null
  source = null
  if (!j) return
  clearTimeout(j.watchdog)
  j.stream.end(() => {
    if (j.bytes === 0) { fs.rm(j.file, () => {}); j.onState('failed', 'nothing was recorded'); return }
    j.onState('saved', j.file)
  })
}

function failed (why) {
  const j = job
  job = null
  source = null
  if (!j) return
  clearTimeout(j.watchdog)
  j.stream.end(() => fs.rm(j.file, () => {}))
  j.onState('failed', why)
}

const active = () => !!job

module.exports = { start, stop, chunk, started, done, failed, active, permission, openPermissionSettings, folder }
