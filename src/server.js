// Local files are served over http://127.0.0.1 rather than loaded as file://.
// file:// blocks ES modules, fetch of local JSON, and taints canvas with local
// images — all of which break ordinary HTML work for no good reason.
const http = require('http')
const fs = require('fs')
const path = require('path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.wasm': 'application/wasm',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8'
}

function serve (root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel
      try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname) }
      catch { res.writeHead(400).end('bad request'); return }

      // Resolve, then confirm the result is still inside root — blocks ../ escapes.
      const full = path.resolve(root, '.' + rel)
      if (full !== root && !full.startsWith(root + path.sep)) {
        res.writeHead(403).end('forbidden')
        return
      }

      fs.stat(full, (err, stat) => {
        let file = full
        if (!err && stat.isDirectory()) file = path.join(full, 'index.html')

        fs.readFile(file, (err2, buf) => {
          if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            // Never cache: live reload must always show the newest bytes.
            'Cache-Control': 'no-store, must-revalidate'
          })
          res.end(buf)
        })
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      })
    })
  })
}

// Coalesced recursive watch. Editors write in bursts (temp file, rename,
// truncate), so a debounce keeps one save from firing five reloads.
function watch (root, onChange, delay = 120) {
  let timer = null
  let watcher
  try {
    watcher = fs.watch(root, { recursive: true }, (_e, name) => {
      if (name && /(^|\/)(\.git|node_modules)(\/|$)/.test(name)) return
      clearTimeout(timer)
      timer = setTimeout(onChange, delay)
    })
  } catch {
    return { close () {} }   // watching is a nicety, never fatal
  }
  return { close () { clearTimeout(timer); watcher.close() } }
}

module.exports = { serve, watch }
