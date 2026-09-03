# Stage

A clean stage for capturing web work. Not a browser — you point it at one thing
and it shows it at an exact size with no chrome, ready for CleanShot.

    npm start                 # just the bar
    npx electron . ./fixture  # straight to a target
    npm run build             # dist/Stage-darwin-arm64/Stage.app

The build is unsigned, which is fine for an app you built on the machine it
runs on. Drag it to /Applications; rebuild after changes.

## Model

A **target** is a project, not a URL. It can hold two sources for the same
thing — the local folder you build in and the URL you pushed it to — so ⌘L
flips between them at the same size and scroll position. That makes local-vs-
deployed a true A/B: anything that moves is a real difference.

There is no start screen. With nothing open, the bar is the whole app: drop a
file or folder on it, paste a URL, or ⌘O. The stage appears when a target
loads and goes away with ⌘⇧W.

## Two things verified on macOS 26.6.2

- `setContentProtection(true)` genuinely omits the panel from ScreenCaptureKit —
  it disappears from recordings rather than going black. The panel can therefore
  overlap the stage without polluting a capture.
- `useContentSize` gives an exact CSS-pixel viewport (1440 × 900 reads back as
  1440 × 900), so presets don't need CDP device-metrics override yet.

## Why local files are served over HTTP

`file://` blocks ES modules, `fetch` of local JSON, and taints canvas with local
images. Local targets get an ephemeral 127.0.0.1 server rooted at the containing
folder instead. Watching that folder gives live reload for free.

## Auto-scroll (parked — `FEATURES.scroll` in main.js)

A capture that scrolls by hand always looks scrolled by hand. **⌥↓** scrolls
the page down at a set speed, **⌥↑** up; the same key again stops, the
opposite key turns around. **Hold P** to pause and release to carry on. **Esc**
stops, and so does touching the wheel or any scroll key — the moment you reach
for the page it's yours again.

Three settings, per target, from the speed readout in the bar or ••• →
Auto-scroll:

- **Speed** in px/s (default 90).
- **Easing** — the ramp in ms (default 600). Starting, stopping, pausing and
  arriving at the end of the page all use the same smoothstep velocity ramp,
  so every change of motion reads as one gesture. The arrival ramp starts at
  exactly the stopping distance, so the page settles on its last pixel.
- **Pre-roll** — a delay before motion starts (default 2 s), so you can hit the
  key and take your hands off before the recording shows anything move.

The engine runs in the preload's isolated world on `requestAnimationFrame`, so
it's frame-accurate and pages can't see it. Pages that scroll a container
rather than the document get the largest scrollable element.

## Shortcuts

| ⌘O | open | ⌘K | focus bar | ⌘R | reload | ⌘⇧W | close target | ⌘. | hide bar |

With auto-scroll on: ⌥↓ down, ⌥↑ up, hold P to pause, esc to stop.

The stage has no chrome to grab, so **⌘-drag anywhere on the page** moves the
stage and bar together, and the bar itself drags from any non-control area.
The drag listener lives in the preload's isolated world, so pages can't see it.

The preload exposes its privileged API only to our own `file://` UI pages —
a loaded website gets the drag listener and nothing else.

## Corner radius

A number, edited as a number: click the value to type, drag the corner icon
to scrub, ↑↓ to step (⇧ for tens). No menu — the presets a menu would offer
are just numbers you'd rather nudge. `--radius=N` sets it from the command line.

`WebContentsView.setBorderRadius()` has a trap on macOS (Electron 44, macOS
26.6.2, verified by screenshotting a probe window through every sequence):
once the radius has been set to 0, the next bounds change — a size preset,
even a one-pixel nudge — leaves the view's layer deaf to every later
`setBorderRadius`. Removing and re-adding the child view runs Electron's
`OnViewAddedToWidget`, which pushes the stored radius to a fresh layer.
`applyRadius()` does that on every change: no reload, scroll and focus
survive, it costs a frame. What looked like a stuck radius before that was
mostly the window's own macOS corner rounding, now off (`roundedCorners:
false`).

## Probing

`STAGE_PROBE=script.js npx electron . ./fixture` hands `script.js` the live
internals (`startScroll`, `setRadius`, `applySize`, the windows) so behaviour
can be driven and screenshotted without a hand on the keyboard.

## Not built yet

v3 frame-stepped capture → ffmpeg, cookie zapper, smooth-scroll adapters.
