# Stage

A clean stage for capturing web work. Not a browser — you point it at one thing
and it shows it at an exact size with no chrome, ready for CleanShot.

    npm start                 # launcher
    npx electron . ./fixture  # straight to a target

## Model

A **target** is a project, not a URL. It can hold two sources for the same
thing — the local folder you build in and the URL you pushed it to — so ⌘L
flips between them at the same size and scroll position. That makes local-vs-
deployed a true A/B: anything that moves is a real difference.

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

## Shortcuts

| ⌘O | open | ⌘K | focus bar | ⌘R | reload | ⌘⇧W | launcher | ⌘. | hide bar |

The stage has no chrome to grab, so **⌘-drag anywhere on the page** moves the
stage and bar together, and the bar itself drags from any non-control area.
The drag listener lives in the preload's isolated world, so pages can't see it.

The preload exposes its privileged API only to our own `file://` UI pages —
a loaded website gets the drag listener and nothing else.

## Known issue — corner radius (control hidden)

`WebContentsView.setBorderRadius()` applies a non-zero radius correctly, but
setting it back to 0 leaves the previous clip in place: the value reaches the
view (logged and persisted), yet the corners stay rounded. Forcing a relayout
by nudging the view bounds a pixel and back did not clear it either.

Next thing to try is recreating the view when the radius changes, which will
definitely rebuild the clip but costs a page reload. `RADIUS_UI` in `main.js`
flips the control back on; `--radius=N` sets it from the command line.

## Not built yet

v2 auto-scroll (px/s, easing duration, pre-roll, ⌥↓/⌥↑, hold-P).
v3 frame-stepped capture → ffmpeg, cookie zapper, smooth-scroll adapters.
