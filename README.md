# Neovide Cursor (customized build)

Neovide-style elastic caret animation for VS Code / VS Code Insiders.

This is a rewritten `neovide-cursor.js` for the [Neovide Cursor](https://marketplace.visualstudio.com/items?itemName=30d98f9b2.neovide-cursor) extension. It keeps the original four-corner spring physics but fixes the startup crash that prevents the stock script from running, and rebuilds the update loop so it costs nothing when you are not typing.

---

## Requirements

Both of these must be installed from the VS Code marketplace:

1. **Neovide Cursor** (`30d98f9b2.neovide-cursor`) — provides the commands and the script file this replaces
2. **Custom CSS and JS Loader** (`be5invis.vscode-custom-css`) — injects the script into the workbench

The Loader works by patching VS Code's internal files. VS Code will warn that the installation is corrupt afterwards. That is expected and is actually your confirmation that the patch applied.

---

## Setup

### 1. Generate the import path

Command Palette (`Ctrl+Shift+P`) → **`Neovide Cursor: Generate Path`**

This writes an entry into your `settings.json`. Open it with **`Preferences: Open User Settings (JSON)`** and confirm it looks like this:

```json
"vscode_custom_css.imports": [
    "file:///c%3A/Users/<you>/.vscode-insiders/extensions/30d98f9b2.neovide-cursor-1.0.1/neovide-cursor.js"
]
```

**Check the path carefully.** Two things go wrong here:

- `.vscode-insiders` vs `.vscode` — these are separate extension folders for Insiders and stable. The path must match the build you actually run.
- The version suffix (`-1.0.1`) — if the extension auto-updated, the folder name changed and this path now points at nothing. Re-run `Generate Path` rather than hand-editing.

### 2. Install this script

Replace the contents of the file that path points to:

```
<extensions folder>/30d98f9b2.neovide-cursor-1.0.1/neovide-cursor.js
```

Replace the whole file. Do not append.

### 3. Enable and reload

Run these in order from the Command Palette:

1. `Enable Custom CSS and JS`
2. `Reload Custom CSS and JS`
3. **Fully quit and reopen VS Code.** "Reload Window" is not enough — the patch only takes effect on a complete restart.

### 4. Verify

After restarting you should see:

> Your Code - Insiders installation appears to be corrupt. Please reinstall.

That warning means it worked. Click "Don't show again" to dismiss it permanently.

Then click into an editor and move the cursor around. You should see the caret stretch as it travels and snap closed when it arrives.

---

## Uninstalling

1. `Remove Generated Path`
2. `Reload Custom CSS and JS`
3. Restart VS Code
4. Uninstall the Neovide Cursor extension

To also undo the workbench patch, run `Disable Custom CSS and JS` before uninstalling the Loader.

---

## Configuration

All settings live in the config block at the top of `neovide-cursor.js`. Edit, then `Reload Custom CSS and JS` and restart.

### Appearance

| Setting | Default | Notes |
|---|---|---|
| `tailColor` | `"#ffffff"` | Hex color, or `"default"` to follow the active theme's cursor color |
| `tailOpacity` | `1` | 0–1 |

To change only the resting caret color (not the trail), use VS Code's own setting instead:

```json
"workbench.colorCustomizations": {
    "editorCursor.foreground": "#FFC0CB"
}
```

### Glow

| Setting | Default | Notes |
|---|---|---|
| `shadowMode` | `"css"` | `"css"`, `"canvas"`, or `"off"` |
| `shadowColor` | `tailColor` | |
| `shadowBlurPx` | `7` | Radius in px, used by `"css"` mode |
| `shadowBlurFactor` | `0.45` | Multiplier on caret size, used by `"canvas"` mode |

`"css"` renders the glow as a GPU `drop-shadow()` filter on the overlay layer — blurred once per frame by the compositor instead of per fill. `"canvas"` is the original `ctx.shadowBlur` path, which is the single most expensive operation in the script. `"off"` is cheapest.

### Animation feel

| Setting | Default | Notes |
|---|---|---|
| `animationLength` | `0.115` | Standard move duration, seconds |
| `shortAnimationLength` | `0.045` | Duration for small same-line moves |
| `shortMoveThreshold` | `8` | px below which a move counts as "short" |
| `rank0TrailFactor` … `rank3TrailFactor` | `1.0 / 0.9 / 0.5 / 0.3` | Per-corner lag. **The spread between these four numbers is what creates the stretch** — raise them for a longer, floatier trail, lower them for a tighter one |
| `useHardSnap` | `true` | Leading corners jump ahead; acts as a stabilizer |
| `leadingSnapThreshold` | `0.5` | Alignment (0–1) above which a corner counts as leading |
| `maxTrailDistanceFactor` | `100` | Max stretch, in multiples of caret size |

### Performance and power

| Setting | Default | Notes |
|---|---|---|
| `useHiDPI` | `true` | Render at device pixel ratio for crisp edges |
| `maxDevicePixelRatio` | `2` | Above 2 costs memory for no visible gain |
| `rescanThrottle` | `300` | ms between DOM sweeps for caret elements |
| `releaseCanvasAfter` | `5000` | ms of inactivity before freeing the canvas buffer |
| `pauseWhenHidden` | `true` | Stop everything when the window is not visible |

**If you want the absolute cheapest configuration:** `shadowMode = "off"` and `maxDevicePixelRatio = 1`.

---

## How it works

VS Code's native caret cannot deform, so the script hides it during motion and draws a replacement on a full-screen transparent canvas overlay.

The caret is not treated as a rectangle. It is four independent points, each on a critically damped spring. When the caret moves, each corner is ranked by how well it aligns with the direction of travel: leading corners respond almost instantly, trailing corners lag. That difference in lag is what produces the stretch on departure and the rubber-band snap on arrival.

Once everything settles, the canvas fades out and the real caret fades back in, so text alignment stays pixel-exact at rest.

---

## What changed from the stock script

### The crash

The stock script ends with a bare `new GlobalCursorManager()`. The Loader injects into `workbench.html` before `<body>` exists, so `document.body.appendChild(...)` throws:

```
Uncaught TypeError: Cannot read properties of null (reading 'appendChild')
    at GlobalCursorManager.init
```

That single throw kills the constructor — no canvas, no observers, nothing. Because it happens at load, the error scrolls away before you'd normally open DevTools, so the symptom is "the script loads fine, no errors, but nothing renders."

A `document.readyState` guard is not reliable in this injection context. This build polls for `document.body` on `requestAnimationFrame` until it exists.

### Correctness

- Corners are seeded to their starting position before the first move, so the opening frame isn't drawn from stale geometry
- Native caret hide/reveal handoff — without it the animation renders behind a fully opaque native caret and is invisible
- Momentum is cleared on slow corners so a previous move's inertia doesn't contaminate the next
- Stretch is clamped, so a large fast jump can't produce runaway spring values
- Scroll pins the caret to its target instead of smearing it across the viewport

### Performance

- **`MutationObserver` replaces the 500 ms polling scan.** Carets are picked up the instant they appear instead of up to half a second late, and idle costs nothing. Tree mutations only flip a flag; the actual `querySelectorAll` sweep is throttled to `rescanThrottle`.
- **Per-caret dirty tracking.** Attribute mutations identify exactly which caret changed, so only that one re-runs `getComputedStyle` and `getBoundingClientRect`. Previously every caret re-read both, every frame.
- **Dirty-rect clearing.** Only the region painted last frame is cleared, not the whole viewport.
- **Batched layout reads.** All geometry reads happen before any canvas writes, avoiding read/write layout thrashing.
- **Zero allocation in the hot path.** Physics state is one packed `Float32Array` per caret; rank sorting is a 4-element insertion sort into shared module-level scratch buffers. A frame of physics allocates nothing, so this script never triggers GC.
- **`desynchronized` canvas context**, letting the compositor present the overlay without waiting on the main pipeline.

### Power and memory

- **The render loop stops when idle.** It is cancelled, not just short-circuited — an idle editor costs zero frames, which is what lets the CPU reach deeper sleep states. A mutation, scroll, or resize re-arms it.
- **Paused entirely when the window is hidden.**
- **The canvas backing store is released after 5s of inactivity** and immediately when hidden. A full-viewport canvas at DPR 2 on a 4K display is roughly 33 MB; it is reallocated on demand.
- DPR capped at 2.

---

## Troubleshooting

**Nothing happens after installing.**

Work through these in order:

1. Both extensions installed and enabled
2. `Neovide Cursor: Generate Path` has been run, and the path in `settings.json` points at the extensions folder for the build you actually run (Insiders vs stable) with the correct version suffix
3. `Enable Custom CSS and JS` then `Reload Custom CSS and JS`
4. **Fully quit** and reopen — not "Reload Window"
5. You see the "installation appears to be corrupt" warning

If you never see that warning, the patch did not apply. Redo steps 3–4. VS Code updates overwrite the patched files, so this needs redoing after every update.

**Diagnosing from DevTools** (Help → Toggle Developer Tools → Console):

```js
// Is the caret element there at all? Should be >= 1
document.querySelectorAll('.monaco-editor .cursor').length

// Did the overlay canvas get created? Should be a <canvas>, not undefined
[...document.querySelectorAll('canvas')].find(c => c.style.zIndex === '9999')
```

If the first returns `0`, VS Code changed its internal DOM class names and the selector needs updating. If the first is fine but the second is `undefined`, the manager threw during construction — scroll to the very top of the console for the error, since it fires at load time.

**The caret changes color but never animates.** The color is coming from `workbench.colorCustomizations`, which is VS Code's own theming and unrelated to this script. That combination means the canvas is not drawing — check the second snippet above.

**It worked, then stopped after a VS Code update.** Updates overwrite the patched workbench files. Re-run `Enable Custom CSS and JS` → `Reload Custom CSS and JS` → full restart. Insiders updates roughly daily, so this is routine.

---

## Credits

Based on the [Neovide Cursor](https://marketplace.visualstudio.com/items?itemName=30d98f9b2.neovide-cursor) extension by Sertie, which is in turn based on the cursor animation in the [Neovide](https://neovide.dev/) editor.
