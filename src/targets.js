// A target is a thing you point the stage at. It can carry two sources for the
// same project — the local folder you build in and the URL you pushed it to —
// so you can flip between them without losing size or scroll.
const fs = require('fs')
const path = require('path')

class TargetStore {
  constructor (dir) {
    this.file = path.join(dir, 'targets.json')
    this.data = { targets: [], lastId: null, radius: 0 }
    this.load()
  }

  load () {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(this.data.targets)) this.data.targets = []
    } catch { /* first run, or unreadable — start clean */ }
    return this.data
  }

  save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  all () { return this.data.targets }

  // Whether the bar shows up in screen recordings. Off by default so the bar
  // never pollutes a capture of the page; on when the capture is of blank.
  barInCaptures () { return !!this.data.barInCaptures }
  setBarInCaptures (on) {
    this.data.barInCaptures = !!on
    this.save()
    return this.data.barInCaptures
  }

  // Corner radius is a house style rather than a per-project fact, so it's
  // stored once and applied to everything.
  radius () { return this.data.radius || 0 }
  setRadius (r) {
    this.data.radius = Math.max(0, Math.min(120, Math.round(r) || 0))
    this.save()
    return this.data.radius
  }

  get (id) { return this.data.targets.find(t => t.id === id) || null }

  last () { return this.get(this.data.lastId) }

  // Matches on whichever source is supplied so re-opening a folder you've
  // already got a target for updates it rather than duplicating it.
  upsert ({ localPath, liveUrl, name, size }) {
    let t = this.data.targets.find(t =>
      (localPath && t.localPath === localPath) || (liveUrl && t.liveUrl === liveUrl))

    if (!t) {
      t = {
        id: 't' + Date.now().toString(36),
        name: name || deriveName({ localPath, liveUrl }),
        localPath: null,
        liveUrl: null,
        size: size || { w: 1440, h: 900 },
        scroll: { mode: 'steady', speed: 90, ease: 600, preroll: 2000, stride: 0.6, dwell: 1500, variation: 0.3 },
        source: localPath ? 'local' : 'live',
        openedAt: Date.now()
      }
      this.data.targets.unshift(t)
    }

    if (localPath) t.localPath = localPath
    if (liveUrl) t.liveUrl = liveUrl
    if (size) t.size = size
    if (name) t.name = name
    t.openedAt = Date.now()

    this.data.lastId = t.id
    this.save()
    return t
  }

  update (id, patch) {
    const t = this.get(id)
    if (!t) return null
    Object.assign(t, patch)
    this.save()
    return t
  }

  touch (id) {
    this.data.lastId = id
    const t = this.get(id)
    if (t) t.openedAt = Date.now()
    this.save()
  }

  remove (id) {
    this.data.targets = this.data.targets.filter(t => t.id !== id)
    if (this.data.lastId === id) this.data.lastId = null
    this.save()
  }
}

function deriveName ({ localPath, liveUrl }) {
  if (localPath) {
    const base = path.basename(localPath)
    return base === 'index.html' ? path.basename(path.dirname(localPath)) : base
  }
  if (liveUrl) {
    try { return new URL(liveUrl).hostname.replace(/^www\./, '') } catch { return liveUrl }
  }
  return 'Untitled'
}

module.exports = { TargetStore, deriveName }
