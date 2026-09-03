// Generates every icon from one shape: a square rounded almost, but not
// quite, to a circle. Run with `node build/icons.js`. Outputs the menu bar
// template icon (black + alpha, so macOS tints it) and the app .icns.
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const INK = [0x16, 0x15, 0x12]
const ROUND = 0.42            // corner radius as a fraction of the side

function png (w, h, rgba) {
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ])
}

// Signed distance to a rounded square, anti-aliased over one pixel.
function shape (canvas, side, rgb) {
  const p = new Uint8Array(canvas * canvas * 4)
  const half = side / 2
  const r = side * ROUND
  const c = canvas / 2
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const dx = Math.abs(x + 0.5 - c) - (half - r)
      const dy = Math.abs(y + 0.5 - c) - (half - r)
      const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
      const a = Math.max(0, Math.min(1, 0.5 - d))
      const i = (y * canvas + x) * 4
      p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; p[i + 3] = Math.round(a * 255)
    }
  }
  return png(canvas, canvas, p)
}

const root = path.join(__dirname, '..')

// Menu bar: 18pt canvas, 14pt glyph. Black; macOS handles light/dark.
fs.writeFileSync(path.join(root, 'ui/tray/iconTemplate.png'), shape(18, 14, [0, 0, 0]))
fs.writeFileSync(path.join(root, 'ui/tray/iconTemplate@2x.png'), shape(36, 28, [0, 0, 0]))

// App icon: iconset → icns. Glyph fills 80% like a standard macOS tile.
const set = path.join(__dirname, 'icon.iconset')
fs.rmSync(set, { recursive: true, force: true })
fs.mkdirSync(set)
for (const [name, px] of [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024]
]) fs.writeFileSync(path.join(set, name + '.png'), shape(px, Math.round(px * 0.8), INK))
execSync(`iconutil -c icns "${set}" -o "${path.join(__dirname, 'icon.icns')}"`)
fs.rmSync(set, { recursive: true, force: true })
console.log('icons written')
