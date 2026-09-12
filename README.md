# blank

**A stripped-down browser for clean screen recordings.**

No tabs, no address bar, no bookmarks bar, no scrollbars. Just the page, at
the size you want, with nothing in the way. Point blank at a site or a folder
and record.

It's for designers and developers who show web work: a site you built, a
prototype, a reel of a launch. A recording of a real browser always looks
like a recording of a browser. This looks like the work.

**[Download for Mac](https://github.com/jakedugard/blank/releases/latest/download/blank.dmg)** ·
free, open source, updates itself. ![downloads](https://img.shields.io/github/downloads/jakedugard/blank/blank.dmg?style=flat-square&label=downloads&color=111)

**[Watch a four-minute walkthrough](https://supercut.ai/share/jake-2/zib56yAfOKBPqJF7T6ejhi)** ·
the bar, sizing, the scroll settings, and a take from start to saved file.

## What it does

- **One page, one exact size.** Pick a preset or type a size, and the
  viewport is that size to the pixel.
- **Nothing around it.** blank lives in your menu bar. The only control is
  a small bar under the page, and it stays out of your recordings.
- **Scrolls for you.** A page scrolled by hand looks scrolled by hand.
  Press Steady for one smooth speed, Natural for the flick and rest of a hand
  on a trackpad, or Pin to click the spots a take should stop on. Then take
  your hands off.
- **Records itself.** Press Record and blank captures the page alone, straight
  to an MP4 in your Movies folder. With a scroll mode selected, one press is
  the whole take: record, scroll to the end, stop, save.
- **Zaps what's in the way.** A cookie banner, a chat bubble, a badge: press
  Zap, click it, and it's gone from every take of that site.
- **Local or live.** Drop in a folder you're building in and it live-reloads
  as you save. Paste the URL you shipped it to and flip between the two at
  the same scroll position.

## Using it

Drop a file or folder on the bar, paste a URL, or ⌘O. The page appears above
the bar. ⌘⇧W closes it, ⌘H (or ⌘.) hides everything, and the menu bar icon
brings it back.

Once you're more than a quarter of the way down a page, an **↑** fades in beside
the address and runs the page back to the top, stopping whatever it was doing.
It travels rather than cuts, so you can see where it went: a quick eased scroll,
a third of a second for a screen or two and never more than 0.8s however long
the page, and touching the wheel hands the page back mid-flight. It's in the bar
rather than over the page because the bar is the part macOS leaves out of a
capture, and it holds its slot there whether or not it's showing, so passing
that quarter mark doesn't resize the rig.

## Model

A **target** is a project, not a URL. It can hold two sources for the same
thing — the local folder you build in and the URL you pushed it to — so ⌘L
flips between them at the same size and scroll position. That makes local-vs-
deployed a true A/B: anything that moves is a real difference.

There is no start screen. With nothing open, the bar is the whole app: drop a
file or folder on it, paste a URL, or ⌘O. The stage appears when a target
loads and goes away with ⌘⇧W (Close Page).

blank lives in the menu bar, not the Dock. Click the icon to summon the rig
or put it away (⌘H and ⌘. do the same); right-click for Open, Close, Launch at
Login and Quit. Hiding is not quitting — the tray keeps it alive.

Found a bug, or want to say thanks? **Report a Bug** opens onto two ways to do
it — a mail with the build and macOS version already filled in, or just the
address, copied — and **Buy Me a Coffee ↗** sits beside it. Both are in ••• ,
the menu bar icon's menu, and the app menu, above About.

## Auto-scroll

A capture that scrolls by hand always looks scrolled by hand. The bar's
**Scroll** well offers three ways to go:

- **Steady** is one velocity, start to finish, for showreels and long pages.
- **Natural** is a flick, a rest, a flick: the way a hand reads a page on a
  wheel or trackpad. Each flick accelerates, glides out over about a second,
  and the page rests before the next.
- **Pin** stops where you say. Click the spots that matter and the take
  scrolls to each in turn and holds there. See [Pin](#pin) below.

Pick one and a play button appears beside it, with the mode's presets in the
next well: Slow, Medium and Fast for Steady, or Read, Skim and Sweep for
either of the other two. Play scrolls down
after a one-second pre-roll, so you can take your hands off before the
recording shows anything move; **⌥-click** scrolls up. While it runs, play is
the readout — the countdown, then the direction, or paused — and a click
there stops. From the
keyboard, **⌥↓** and **⌥↑** start (the same key again stops, the opposite
turns around), **hold P** pauses, and **Esc** stops, as does touching the
wheel or any scroll key: the moment you reach for the page it's yours.

The presets cover most takes. To go further, press **Custom** beside them and
the numbers behind the presets open in the next well, each edited the way the
radius is: click the value to type, ↑↓ to step, drag the unit to scrub. Which
numbers show depends on the mode, and a running scroll picks up every change
live:

- **Speed** in px/s and **Easing**, the ramp in ms, for Steady. Starting,
  stopping, pausing and arriving at the end of the page all use the same
  smoothstep velocity ramp, so every change of motion reads as one gesture.
- **Stride** (a share of the screen), **Dwell** (the rest between flicks),
  **Glide** (how quick the hand is) and **Variation** (jitter on all of it,
  so the rhythm isn't a metronome) for Natural.
- **Hold** (how long it rests on a pin) and **Travel** (what a screen's worth
  of it costs) for Pin. Those two are all Pin has.

Two settings have no place in the bar, and live in the menu instead — ••• →
Auto-scroll, or a right-click on the Scroll well: **Pre-roll**, which applies to
all three modes, and **Same rhythm each take**, which locks Natural's seeded
jitter so a re-record of the same page moves exactly the same way. Everything
else the menu used to carry is in the bar, where a number you can scrub beats a
list of five values.

### Pin

Steady and Natural decide how the page moves. **Pin** decides where it stops.

Picking Pin arms pinning, since that's what you came for: the page goes inert
and clicks become pins. Click a spot to pin it, click a pin to take it away,
press **Pins** in the bar when you're done. A pin draws as a hairline red ring
with a plus in it, big enough to aim at and open enough to read the page
through.

Then the take scrolls to each pin in turn and stops nowhere else. Every hop is
one eased move that lands with the pinned spot in the middle of the frame, rests
there, and goes again; after the last pin it carries on to the bottom, so a take
still shows the whole page. Nothing interrupts the motion but a pin.

A hop is quick, and its length grows with the root of the distance rather than
in step with it, so a short hop stays brisk and a long one doesn't drag. It
arrives the way a flick does, easing out asymptotically rather than braking at
a constant rate, so the stop is felt rather than seen.

Pins far apart aren't crossed in one move. Beyond a couple of screens the page
goes in even stages, slowing and gathering itself between them the way a hand
would, and only the last stage lands on the pin. A stage runs longer the quicker
the preset, so Sweep doesn't stop as often as Read on the same page: over four
screens Read takes three flicks, Skim two, and over eight it's five, four and
three. Two pins close together still get one short hop each. Distance reads as
travel rather than as a jump.

That leaves Pin two numbers, not five: how long it holds, and what a screen's
worth of travel costs. Its presets are Natural's, since they mean the same
thing: **Read** (1.5s holds, 0.9s a screen), **Skim** (1.1s, 0.7s) and **Sweep**
(0.8s, 0.55s).

A pin is stored as the element you clicked and the offset inside it, not a
scroll number, so it survives editing the local folder and carries across ⌘L to
the live URL. If the element goes, the pin falls back to the offset it had.

Pins belong to the page they were put on. A reload, a live-reload while you edit,
and the ⌘L flip are all the same page, and keep them; following a link is a
different page, and takes them off. If you were pinning when the page moved,
you're still pinning when the new one lands. **Clear** appears beside Pins as
soon as there's one to clear, so starting over isn't a walk down the page
unpicking them one at a time.

Pinning turns itself off the moment the page starts moving, a take starts, or
you leave Pin mode, so the rings are never in a recording.

All three engines run in the preload's isolated world on `requestAnimationFrame`,
so they're frame-accurate and pages can't see them. Pages that scroll a container
rather than the document get the largest scrollable element.

## Zap

Live sites come with things you'd never put in a recording: the cookie
banner, the chat bubble in the corner, a "made with" badge. You can't edit the
site, so **Zap** edits the take.

Press Zap in the bar and the page goes inert, the way it does for pinning.
The element under the cursor is outlined; click it and it's gone. Click the
next thing. **⌘Z** takes the last one back, **esc** (or Zap again) is done.
The pill counts what's gone.

A zap is stored as the element's selector, with the target, and applied as a
stylesheet the moment each page's document exists, so nothing flashes before
it's hidden. That means it holds across a reload, the ⌘L flip to the live URL,
and the site's other pages, where a banner is usually the same element again.
Right-click the pill (or ••• → Zap) to restore any one of them by name, or all
of them. If a site rebuilds its DOM so a selector no longer matches, nothing
breaks; the element is back, and so is your finger.

Zap and Pin can't both be armed, since each makes the page inert, and both turn
themselves off the moment the page starts moving or a take starts, so the
outline is never in a recording.

## Recording

You don't need a screen recorder. **Record** in the bar (or ⌘⇧R) captures
the page window on its own, so the bar, the desktop and anything overlapping
never make it in, and writes an H.264 MP4 to `~/Movies/blank`, named for the
target and the time. Press again, or Esc, to stop; the file is revealed in
the Finder as it lands.

With Steady or Natural selected, Record is the whole take: it starts the
recording, runs the scroll after the pre-roll, waits for the page to settle
at the end, stops, and saves. One press, one finished clip.

The page's cursor is hidden for the length of the take. Rounded corners are
matted, white by default; ••• → Recording sets Black or any colour, so the
clip drops into a deck or a timeline without a transparent edge going black.
**Output Size**, in the same menu, is 2× by default (the display's own pixels
on a Retina Mac, 2880 × 1800 for a 1440 × 900 page) or 1× for a clip at CSS
size, half the dimensions and a fraction of the file, for the web or a DM.
The menu bar icon carries a red dot while a take is running.

The first take asks macOS for Screen Recording permission. If the button
reads **Allow recording ↗**, click it to open the Settings pane, grant it,
and record again.

## Shortcuts

| ⌘O | open | ⌘K | focus bar | ⌘R | reload | ⌘⇧W | close page | ⌘H ⌘. | hide |
| ⌥↓ | scroll down | ⌥↑ | scroll up | P (hold) | pause | esc | stop | ⌘⇧R | record |
| ⌘Z | undo a zap (while zapping) | esc | done zapping |

The stage has no chrome to grab, so **⌘-drag anywhere on the page** moves the
stage and bar together, and the bar itself drags from any non-control area.
The drag listener lives in the preload's isolated world, so pages can't see it.

The preload exposes its privileged API only to our own `file://` UI pages —
a loaded website gets the drag listener and nothing else.

## Corner radius

A number, edited as a number: click the value to type, drag the corner icon
to scrub, ↑↓ to step (⇧ for tens). No menu — the presets a menu would offer
are just numbers you'd rather nudge. `--radius=N` sets it from the command line.

<details>
<summary><strong>Under the hood</strong> — building, releasing, and the things that bit</summary>

## Releasing and updates

Bump `version` in package.json, write the release's **What's new** into
`build/release-notes.md` (the download line above it is fixed), commit, then
`npm run release`. That builds a universal binary, signs it with the Developer ID certificate in the keychain,
notarizes it through the `blank` notarytool profile (`xcrun notarytool
store-credentials blank …` once per machine), and publishes the dmg (always `blank.dmg`, so the download link never
changes), zip and update manifest to a GitHub release under `v<version>`.

Installed copies check that feed on launch and every four hours, download the
new build quietly, and offer **Update to x.y.z** in the menu bar menu and •••.
Nothing installs mid-session: the swap happens when you pick it, or on quit.
Builds before 0.3.0 have no updater and need one manual install.

`install-app` skips signing so local iteration stays fast. Icons are
generated by `build/icons.js`; entitlements are the three Electron needs
under the hardened runtime.


## How recording works

macOS captures the stage window alone: `desktopCapturer` finds it by
`getMediaSourceId()` and a `setDisplayMediaRequestHandler` hands that source
to whatever asks for it. The encoder is Chromium's own `MediaRecorder`, which
in Electron 44 writes H.264 MP4 directly (`video/mp4;codecs=avc1.64002A`). It
has to run in a renderer, so a hidden window hosts it and streams chunks back
to main to be written to disk. Frames are pulled off the capture track as macOS
delivers them and each is painted and handed on at once, so the file holds one
frame per captured frame with the capture's own timing (an earlier timer-driven
recorder sampled at 62.5 Hz and repeated about one frame in nine of a scroll).
Each frame passes through a canvas that paints the matte behind the rounded
corners, since a transparent corner records black.
There is no API to keep the cursor out of a window capture, so the page gets
`cursor: none` for the take. Verified at 2880 × 1800, 60 fps, while scrolling.

macOS has no request API for Screen Recording: the first capture attempt
raises the system prompt, and after that it's the Settings pane, which the
button opens.


## Two things verified on macOS 26.6.2

- `setContentProtection(true)` genuinely omits the panel from ScreenCaptureKit —
  it disappears from recordings rather than going black. The panel can therefore
  overlap the stage without polluting a capture. **Show Bar in Recordings**
  (••• or the menu bar icon) turns protection off for when the recording is
  of blank itself.
- `useContentSize` gives an exact CSS-pixel viewport (1440 × 900 reads back as
  1440 × 900), so presets don't need CDP device-metrics override yet.

## Why local files are served over HTTP

`file://` blocks ES modules, `fetch` of local JSON, and taints canvas with local
images. Local targets get an ephemeral 127.0.0.1 server rooted at the containing
folder instead. Watching that folder gives live reload for free.


## Corner radius, the trap

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

Frame-stepped capture through ffmpeg for takes that can't drop a frame,
smooth-scroll adapters for pages that hijack the wheel (Lenis and friends).

</details>
