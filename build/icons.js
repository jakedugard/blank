// Generates the menu bar icons from the app icon's inner shape: a square
// with corners rounded to about a fifth of its side, the mark inside
// build/icon.svg. Run with `node build/icons.js`. Outputs the template icon
// (black + alpha, so macOS tints it), the recording glyph (a red dot in the
// middle, on a neutral that survives either menu bar), the update badge (a
// half-alpha dot on the corner, still a template so it stays grey and stays
// visible), the dot on its own for the menu, and the app .icns.
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const INK = [0x16, 0x15, 0x12]
const ROUND = 113.687 / 532.13   // the app icon's inner square: rx over side

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

// Signed distance to a rounded square centred at (cx, cy), anti-aliased
// over one pixel; `dot`, if given, adds a filled circle {x, y, r, rgb}.
function shape (canvas, side, rgb, { width = canvas, cx = canvas / 2, dot = null } = {}) {
  const w = width, h = canvas
  const p = new Uint8Array(w * h * 4)
  const half = side / 2
  const r = side * ROUND
  const cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x + 0.5 - cx) - (half - r)
      const dy = Math.abs(y + 0.5 - cy) - (half - r)
      const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
      let a = Math.max(0, Math.min(1, 0.5 - d))
      let col = rgb
      if (dot) {
        const dd = Math.hypot(x + 0.5 - dot.x, y + 0.5 - dot.y) - dot.r
        const da = Math.max(0, Math.min(1, 0.5 - dd))
        // The dot takes the pixel rather than piling onto it, so `alpha` below
        // 1 reads as a lighter dot even where it lies over the glyph. In a
        // template that lighter alpha is what macOS renders as grey.
        if (da > 0) { col = dot.rgb; a = Math.max(a * (1 - da), da * (dot.alpha ?? 1)) }
      }
      const i = (y * w + x) * 4
      p[i] = col[0]; p[i + 1] = col[1]; p[i + 2] = col[2]; p[i + 3] = Math.round(a * 255)
    }
  }
  return png(w, h, p)
}

const root = path.join(__dirname, '..')

// Menu bar: 18pt canvas, 14pt glyph. Black; macOS handles light/dark.
fs.writeFileSync(path.join(root, 'ui/tray/iconTemplate.png'), shape(18, 14, [0, 0, 0]))
fs.writeFileSync(path.join(root, 'ui/tray/iconTemplate@2x.png'), shape(36, 28, [0, 0, 0]))

const RED = [0xff, 0x3b, 0x30]

// Update ready: the glyph where it always is, with a dot straddling its
// top-right corner, the canvas a shade wider so the badge has room without the
// glyph shifting. A TEMPLATE, unlike the recording variants — which is the
// whole point. macOS decides the menu bar's appearance from the wallpaper
// behind it, not from Dark Mode, and it tells nobody: nativeTheme reports the
// app's appearance, which is a different question. A light-mode Mac with a dark
// desktop gets a dark menu bar, and a baked-in black glyph vanishes into it.
// Only template images are tinted to match, so only a template is always seen.
// Drawn at partial alpha: macOS tints a template by its alpha, so a half-opaque
// dot comes out grey against whatever the bar is — quiet, and never the same
// thing as the red of a take in progress.
for (const k of [1, 2]) {
  const img = shape(18 * k, 14 * k, [0, 0, 0], {
    width: 20 * k, cx: 9 * k,
    dot: { x: 15.8 * k, y: 3.6 * k, r: 3.3 * k, rgb: [0, 0, 0], alpha: 0.5 }
  })
  fs.writeFileSync(path.join(root, `ui/tray/updateTemplate${k === 2 ? '@2x' : ''}.png`), img)
}

// Recording: a red dot in the middle of the glyph. Non-template, because red has
// to survive and a template is tinted — tinting is exactly what would take the
// red away. That means the glyph's own colour is baked in, so it can't be black
// or white: either one vanishes into the menu bar it doesn't suit, which is what
// the old pair of light/dark variants got wrong. A neutral grey holds up on
// both, and red reads on both, so one image serves every appearance.
const GREY = [0x92, 0x92, 0x97]
for (const k of [1, 2]) {
  fs.writeFileSync(path.join(root, `ui/tray/recording${k === 2 ? '@2x' : ''}.png`),
    shape(18 * k, 14 * k, GREY, { dot: { x: 9 * k, y: 9 * k, r: 3.2 * k, rgb: RED } }))
}

// A bare dot, for the menu item that offers the update. macOS draws menu
// icons small, so this is only ever a dot.
function circle (canvas, r, rgb) {
  const p = new Uint8Array(canvas * canvas * 4)
  const c = canvas / 2
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const a = Math.max(0, Math.min(1, 0.5 - (Math.hypot(x + 0.5 - c, y + 0.5 - c) - r)))
      const i = (y * canvas + x) * 4
      p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; p[i + 3] = Math.round(a * 255)
    }
  }
  return png(canvas, canvas, p)
}
fs.writeFileSync(path.join(root, 'ui/tray/updateDot.png'), circle(12, 3.5, RED))
fs.writeFileSync(path.join(root, 'ui/tray/updateDot@2x.png'), circle(24, 7, RED))

// App icon: iconset → icns. The master is build/icon.png, a 1024 render of
// build/icon.svg on Apple's squircle (824 wide, 100 in, radius 185); render
// it with any SVG rasteriser when the SVG changes. If it's missing, the
// generated shape stands in.
const set = path.join(__dirname, 'icon.iconset')
const master = path.join(__dirname, 'icon.png')
fs.rmSync(set, { recursive: true, force: true })
fs.mkdirSync(set)
for (const [name, px] of [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024]
]) {
  const out = path.join(set, name + '.png')
  if (fs.existsSync(master)) execSync(`sips -z ${px} ${px} "${master}" --out "${out}" >/dev/null`)
  else fs.writeFileSync(out, shape(px, Math.round(px * 0.8), INK))
}
execSync(`iconutil -c icns "${set}" -o "${path.join(__dirname, 'icon.icns')}"`)
fs.rmSync(set, { recursive: true, force: true })
console.log('icons written')
