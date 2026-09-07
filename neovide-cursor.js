// neovide-cursor.js — maximum build (power + memory pass)
//
// Elastic four-corner caret physics with an allocation-free hot path, a fully
// event-driven update model, and no background cost when you are not typing.
//
// Cost model:
//   idle              -> zero. The rAF loop is cancelled, not just skipped.
//   window hidden     -> zero. Loop stopped and the canvas buffer is freed.
//   typing / moving   -> physics + draw only for carets that actually changed.
//   scrolling         -> positions pinned, no springs, no smear.
//
// Power notes:
//   * The render loop STOPS when nothing is animating. A re-arm only happens
//     when a mutation, scroll, or resize says there is work. An idle editor
//     costs no wakeups at all, which lets the CPU package reach deeper sleep
//     states — this is the difference that shows up in battery life.
//   * On visibilitychange the loop is cancelled and the canvas backing store
//     is released outright.
//
// Memory notes:
//   * All per-caret physics state is one packed Float32Array (36 slots,
//     144 bytes) instead of nine separate arrays of boxed pairs.
//   * Rank-sorting scratch buffers are module-level and shared by every
//     caret, since physics runs synchronously on one thread.
//   * A full-viewport canvas at DPR 2 on a 4K display is ~33 MB of backing
//     store. It is freed after releaseCanvasAfter ms of inactivity and
//     reallocated on demand, and DPR is capped by maxDevicePixelRatio.

// ====================================================================
// SECTION 1: User configuration
// ====================================================================

// --- Color and appearance ---
const tailColor = "#ffffff";      // hex, or "default" to follow the active theme
const tailOpacity = 1;            // 0-1

// --- Glow ---
// "css"    : GPU drop-shadow on the whole overlay layer. Composited once per
//            frame by the compositor rather than blurred per fill. Much
//            cheaper than "canvas" and looks near-identical here, because the
//            layer is transparent except for the caret quad. Recommended.
// "canvas" : classic per-fill ctx.shadowBlur. Most expensive option.
// "off"    : no glow. Cheapest.
const shadowMode = "css";
const shadowColor = tailColor;    // glow color
const shadowBlurPx = 7;           // glow radius in px, used by "css" mode
const shadowBlurFactor = 0.45;    // multiplier on cursor size, used by "canvas" mode

// --- Animation timing ---
const animationLength = 0.115;      // standard move duration (s)
const shortAnimationLength = 0.045; // small same-line move duration (s)
const shortMoveThreshold = 8;       // px below which a move counts as "short"

// --- Trail dynamics (per-corner lag; 1.0 = maximum lag, 0 = instant) ---
// The spread between these four numbers is what creates the stretch.
// Raise them for a longer, floatier trail; lower them for a tighter one.
const rank0TrailFactor = 1.0;     // most-trailing corner
const rank1TrailFactor = 0.9;
const rank2TrailFactor = 0.5;
const rank3TrailFactor = 0.3;     // most-leading corner

// --- Leading edge behavior ---
const useHardSnap = true;         // leading corners snap ahead; acts as a stabilizer
const leadingSnapFactor = 0.1;
const leadingSnapThreshold = 0.5; // alignment (0-1) above which a corner leads
const animationResetThreshold = 0.075; // above this duration, clear stale momentum (s)
const maxTrailDistanceFactor = 100;    // max stretch, in multiples of cursor size
const snapAnimationLength = 0.02; // duration for snapped leading corners (s)

// --- Native caret handoff ---
const cursorDisappearDelay = 50;          // ms before the canvas fades once settled
const cursorFadeOutDuration = 0.075;      // s
const nativeCursorRevealDuration = 0.075; // s

// --- Rendering / scheduling / power ---
const useHiDPI = true;              // render at devicePixelRatio for crisp edges
const maxDevicePixelRatio = 2;      // cap DPR; above 2 costs memory for no visible gain
const dirtyRectPadding = 6;         // extra px cleared around the painted region
const rescanThrottle = 300;         // ms; minimum gap between querySelectorAll sweeps
const settleEpsilon = 0.01;         // px below which a spring is considered at rest
const releaseCanvasAfter = 5000;    // ms of inactivity before freeing the canvas buffer
const pauseWhenHidden = true;       // stop everything when the window is not visible

// ====================================================================
// SECTION 2: Constants and shared state
// ====================================================================

// Relative corner offsets: TL, TR, BR, BL.
const CORNER_RX = [-0.5, 0.5, 0.5, -0.5];
const CORNER_RY = [-0.5, -0.5, 0.5, 0.5];

// Precomputed unit vectors for each corner direction (all are ±0.7071).
const INV_SQRT2 = Math.SQRT1_2;
const CORNER_DIR_X = [-INV_SQRT2, INV_SQRT2, INV_SQRT2, -INV_SQRT2];
const CORNER_DIR_Y = [-INV_SQRT2, -INV_SQRT2, INV_SQRT2, INV_SQRT2];

const TRAIL_FACTORS = [
  rank0TrailFactor,
  rank1TrailFactor,
  rank2TrailFactor,
  rank3TrailFactor,
];

// Packed physics buffer layout. One Float32Array per caret, 36 slots.
const O_CPX = 0;   // current painted x, 4 slots
const O_CPY = 4;   // current painted y
const O_PDX = 8;   // last destination x
const O_PDY = 12;  // last destination y
const O_SXP = 16;  // spring displacement x
const O_SXV = 20;  // spring velocity x
const O_SYP = 24;  // spring displacement y
const O_SYV = 28;  // spring velocity y
const O_LEN = 32;  // per-corner spring time constant
const PHYS_SLOTS = 36;

// Shared scratch for rank sorting. Physics is synchronous and single
// threaded, so every caret can borrow the same three buffers.
const sAlign = new Float32Array(4);
const sOrder = new Int32Array(4);
const sRank = new Int32Array(4);

// Where the caret last was globally, so a caret appearing in another split
// animates in from the previous position instead of flying in from nowhere.
let gLastX = null;
let gLastY = null;
let gLastW = 0;
let gLastH = 0;

const useCanvasShadow = shadowMode === "canvas";
const useCssShadow = shadowMode === "css";

const helperCanvas = document.createElement("canvas");
const helperCtx = helperCanvas.getContext("2d");

function parseHexColor(color) {
  if (!color || color.charCodeAt(0) !== 35 /* # */) {
    return { r: 255, g: 255, b: 255, a: 255 };
  }
  const hex = color.slice(1);
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 255,
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 255,
    };
  }
  if (hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: parseInt(hex.slice(6, 8), 16),
    };
  }
  return { r: 255, g: 255, b: 255, a: 255 };
}

// Let the browser normalize whatever notation was given, then parse it.
function resolveColor(color) {
  helperCtx.fillStyle = "#000000";
  helperCtx.fillStyle = color;
  return parseHexColor(helperCtx.fillStyle);
}

function rgbaToCss(c, alphaScale) {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255) * alphaScale})`;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function readThemeCursorColor() {
  const workbench = document.querySelector("body > .monaco-workbench");
  if (!workbench) return "#ffffff";
  const s = getComputedStyle(workbench);
  return (
    s.getPropertyValue("--vscode-editorCursor-foreground").trim() ||
    s.getPropertyValue("--vscode-editorCursor-background").trim() ||
    "#ffffff"
  );
}

// ====================================================================
// SECTION 3: Caret instance
// ====================================================================
//
// Each corner is a critically damped spring on each axis. All of it lives in
// one packed Float32Array, so a frame of physics allocates nothing at all.

class NeovideCursor {
  constructor(fillCss, shadowCss) {
    this.fillCss = fillCss;
    this.shadowCss = shadowCss;

    this.d = new Float32Array(PHYS_SLOTS);
    for (let i = 0; i < 4; i++) {
      this.d[O_PDX + i] = -1e5;
      this.d[O_PDY + i] = -1e5;
      this.d[O_LEN + i] = animationLength;
    }

    this.width = 8;
    this.height = 18;
    this.centerX = 0;
    this.centerY = 0;
    this.lastTimestamp = 0;
    this.initialized = false;
    this.jumped = false;

    // Painted bounds from the most recent draw.
    this.minX = 0;
    this.minY = 0;
    this.maxX = 0;
    this.maxY = 0;
  }

  setSize(w, h) {
    if (w > 0) this.width = w;
    if (h > 0) this.height = h;
  }

  seedAt(cx, cy, w, h) {
    const d = this.d;
    for (let i = 0; i < 4; i++) {
      const dx = cx + CORNER_RX[i] * w;
      const dy = cy + CORNER_RY[i] * h;
      d[O_CPX + i] = dx;
      d[O_CPY + i] = dy;
      d[O_PDX + i] = dx;
      d[O_PDY + i] = dy;
      d[O_SXP + i] = 0;
      d[O_SXV + i] = 0;
      d[O_SYP + i] = 0;
      d[O_SYV + i] = 0;
    }
  }

  setPosition(x, y) {
    this.centerX = x + this.width / 2;
    this.centerY = y + this.height / 2;
    this.seedAt(this.centerX, this.centerY, this.width, this.height);
    this.initialized = true;
    this.jumped = false;
  }

  move(x, y, srcX, srcY) {
    if ((x <= 0 && y <= 0) || Number.isNaN(x) || Number.isNaN(y)) return;

    const cx = x + this.width / 2;
    const cy = y + this.height / 2;

    // First sight, or arriving from another editor/split: start the corners
    // at the source so the trail travels from there.
    const hasSrc = srcX !== null && srcX !== undefined;
    if (!this.initialized || hasSrc) {
      if (hasSrc) {
        this.seedAt(srcX, srcY, gLastW || this.width, gLastH || this.height);
      } else if (gLastX !== null) {
        this.seedAt(gLastX, gLastY, gLastW || this.width, gLastH || this.height);
      } else {
        this.seedAt(cx, cy, this.width, this.height);
      }
      this.initialized = true;
    }

    this.centerX = cx;
    this.centerY = cy;
    this.jumped = true;

    gLastX = cx;
    gLastY = cy;
    gLastW = this.width;
    gLastH = this.height;
  }

  // Rank corners by alignment with the direction of travel. Rank 0 lags most,
  // rank 3 leads. Four elements, so insertion sort into shared scratch beats
  // map/sort/reduce and allocates nothing.
  assignRanks() {
    const d = this.d;
    const w = this.width;
    const h = this.height;

    for (let i = 0; i < 4; i++) {
      const destX = this.centerX + CORNER_RX[i] * w;
      const destY = this.centerY + CORNER_RY[i] * h;
      let tx = destX - d[O_CPX + i];
      let ty = destY - d[O_CPY + i];
      const len = Math.hypot(tx, ty);
      if (len > 0) {
        tx /= len;
        ty /= len;
      } else {
        tx = 0;
        ty = 0;
      }
      sAlign[i] = tx * CORNER_DIR_X[i] + ty * CORNER_DIR_Y[i];
      sOrder[i] = i;
    }

    for (let i = 1; i < 4; i++) {
      const cur = sOrder[i];
      const val = sAlign[cur];
      let j = i - 1;
      while (j >= 0 && sAlign[sOrder[j]] > val) {
        sOrder[j + 1] = sOrder[j];
        j--;
      }
      sOrder[j + 1] = cur;
    }

    for (let r = 0; r < 4; r++) sRank[sOrder[r]] = r;
  }

  applyJump() {
    const d = this.d;
    const w = this.width;
    const h = this.height;
    this.assignRanks();

    for (let i = 0; i < 4; i++) {
      const targetX = this.centerX + CORNER_RX[i] * w;
      const targetY = this.centerY + CORNER_RY[i] * h;

      const jvx = (targetX - d[O_PDX + i]) / w;
      const jvy = (targetY - d[O_PDY + i]) / h;

      const isShort =
        (jvx < 0 ? -jvx : jvx) <= shortMoveThreshold &&
        (jvy < 0 ? -jvy : jvy) <= 0.001;
      const baseTime = isShort ? shortAnimationLength : animationLength;

      const jlen = Math.hypot(jvx, jvy);
      let alignment = 0;
      if (jlen > 0) {
        alignment =
          (jvx / jlen) * CORNER_DIR_X[i] + (jvy / jlen) * CORNER_DIR_Y[i];
      }

      const leading = useHardSnap && alignment > leadingSnapThreshold;
      const factor = leading ? leadingSnapFactor : TRAIL_FACTORS[sRank[i]];
      const len = leading ? snapAnimationLength : baseTime * clamp(factor, 0, 1);

      d[O_LEN + i] = len;

      // Slow corners drop leftover momentum so the previous move's inertia
      // doesn't contaminate this one.
      if (len > animationResetThreshold) {
        d[O_SXP + i] = 0;
        d[O_SXV + i] = 0;
        d[O_SYP + i] = 0;
        d[O_SYV + i] = 0;
      }
    }
    this.jumped = false;
  }

  // Returns true while anything is still visibly in motion.
  step(dt, immediate) {
    if (!this.initialized) return false;
    if (this.jumped) this.applyJump();

    const d = this.d;
    const w = this.width;
    const h = this.height;
    const maxD = (w > h ? w : h) * maxTrailDistanceFactor;
    let animating = false;

    for (let i = 0; i < 4; i++) {
      const destX = this.centerX + CORNER_RX[i] * w;
      const destY = this.centerY + CORNER_RY[i] * h;

      if (destX !== d[O_PDX + i] || destY !== d[O_PDY + i]) {
        d[O_SXP + i] = destX - d[O_CPX + i];
        d[O_SYP + i] = destY - d[O_CPY + i];
        d[O_PDX + i] = destX;
        d[O_PDY + i] = destY;
      }

      // While scrolling, pin to target: no springs, no smear across the page.
      if (immediate) {
        d[O_CPX + i] = destX;
        d[O_CPY + i] = destY;
        d[O_SXP + i] = 0;
        d[O_SXV + i] = 0;
        d[O_SYP + i] = 0;
        d[O_SYV + i] = 0;
        continue;
      }

      const len = d[O_LEN + i];

      if (len <= dt) {
        d[O_SXP + i] = 0;
        d[O_SXV + i] = 0;
        d[O_SYP + i] = 0;
        d[O_SYV + i] = 0;
      } else {
        const omega = 4.0 / len;
        // One exp() shared between both axes of this corner.
        const decay = Math.exp(-omega * dt);

        let p = d[O_SXP + i];
        if (p !== 0) {
          const b = p * omega + d[O_SXV + i];
          const np = (p + b * dt) * decay;
          if (np < settleEpsilon && np > -settleEpsilon) {
            d[O_SXP + i] = 0;
            d[O_SXV + i] = 0;
          } else {
            d[O_SXP + i] = clamp(np, -maxD, maxD);
            d[O_SXV + i] = decay * (-p * omega - b * dt * omega + b);
          }
        }

        p = d[O_SYP + i];
        if (p !== 0) {
          const b = p * omega + d[O_SYV + i];
          const np = (p + b * dt) * decay;
          if (np < settleEpsilon && np > -settleEpsilon) {
            d[O_SYP + i] = 0;
            d[O_SYV + i] = 0;
          } else {
            d[O_SYP + i] = clamp(np, -maxD, maxD);
            d[O_SYV + i] = decay * (-p * omega - b * dt * omega + b);
          }
        }
      }

      d[O_CPX + i] = destX - d[O_SXP + i];
      d[O_CPY + i] = destY - d[O_SYP + i];

      if (d[O_SXP + i] !== 0 || d[O_SYP + i] !== 0) animating = true;
    }

    return animating;
  }

  draw(ctx) {
    const d = this.d;

    ctx.beginPath();
    ctx.moveTo(d[O_CPX], d[O_CPY]);
    ctx.lineTo(d[O_CPX + 1], d[O_CPY + 1]);
    ctx.lineTo(d[O_CPX + 2], d[O_CPY + 2]);
    ctx.lineTo(d[O_CPX + 3], d[O_CPY + 3]);
    ctx.closePath();

    ctx.fillStyle = this.fillCss;

    let glow = 0;
    if (useCanvasShadow) {
      glow = shadowBlurFactor * (this.width > this.height ? this.width : this.height);
      ctx.shadowColor = this.shadowCss;
      ctx.shadowBlur = glow;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    } else {
      // "css" mode blurs the whole layer on the GPU at composite time, so
      // nothing extra is painted into the pixel buffer here and the dirty
      // rect stays tight.
      ctx.fill();
    }

    let minX = d[O_CPX];
    let maxX = d[O_CPX];
    let minY = d[O_CPY];
    let maxY = d[O_CPY];
    for (let i = 1; i < 4; i++) {
      const x = d[O_CPX + i];
      const y = d[O_CPY + i];
      if (x < minX) minX = x;
      else if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      else if (y > maxY) maxY = y;
    }

    const pad = glow + dirtyRectPadding;
    this.minX = minX - pad;
    this.minY = minY - pad;
    this.maxX = maxX + pad;
    this.maxY = maxY + pad;
  }
}

// ====================================================================
// SECTION 4: Manager
// ====================================================================

class GlobalCursorManager {
  constructor() {
    this.cursors = new Map();
    this.seenScratch = new Set(); // reused by every scan

    this.canvas = document.createElement("canvas");
    // desynchronized lets the compositor present this overlay without waiting
    // on the main canvas pipeline, which cuts perceived latency.
    this.ctx =
      this.canvas.getContext("2d", { alpha: true, desynchronized: true }) ||
      this.canvas.getContext("2d");

    this.isScrolling = false;
    this.scrollTimeout = null;
    this.resizeTimeout = null;
    this.fadeTimeout = null;
    this.releaseTimeout = null;

    // Scheduling.
    this.rafId = null;         // null means the loop is not running
    this.paused = false;       // window hidden
    this.dirty = true;
    this.needsRescan = true;
    this.forceReadAll = true;
    this.wasAnimating = false;
    this.lastRescan = 0;

    // Region painted last frame, cleared at the start of the next one.
    this.paintedValid = false;
    this.pMinX = 0;
    this.pMinY = 0;
    this.pMaxX = 0;
    this.pMaxY = 0;

    this.dpr = 1;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.canvasAllocated = false;

    // Bound once so the rAF loop never allocates a closure.
    this.boundLoop = this.loop.bind(this);

    const resolved = tailColor === "default" ? readThemeCursorColor() : tailColor;
    const colorObj = resolveColor(resolved);
    this.fillCss = rgbaToCss(colorObj, tailOpacity);
    this.shadowCss = useCanvasShadow
      ? shadowColor === tailColor
        ? this.fillCss
        : rgbaToCss(resolveColor(shadowColor), 1)
      : null;
    this.cssShadowValue = useCssShadow
      ? `drop-shadow(0 0 ${shadowBlurPx}px ${
          shadowColor === tailColor
            ? this.fillCss
            : rgbaToCss(resolveColor(shadowColor), 1)
        })`
      : "none";

    this.init();
  }

  init() {
    const style = document.createElement("style");
    style.textContent = `
      .monaco-editor .cursor { transition: none !important; }
      .cursor-trail { opacity: 0 !important; }
    `;
    document.head.appendChild(style);

    this.canvas.style.cssText = `
      pointer-events: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 9999;
      opacity: 0;
      transition: none;
      will-change: opacity;
      filter: ${this.cssShadowValue};
    `;
    document.body.appendChild(this.canvas);
    this.allocateCanvas();

    window.addEventListener("resize", () => {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = setTimeout(() => {
        if (this.canvasAllocated) this.allocateCanvas();
        this.forceReadAll = true;
        this.markDirty();
      }, 100);
    });

    // Scrolling moves carets via ancestor transforms, so no attribute
    // mutation fires on the caret itself — geometry must be re-read.
    document.addEventListener(
      "scroll",
      () => {
        this.isScrolling = true;
        this.forceReadAll = true;
        this.markDirty();
        clearTimeout(this.scrollTimeout);
        this.scrollTimeout = setTimeout(() => {
          this.isScrolling = false;
          this.forceReadAll = true;
          this.markDirty();
        }, 100);
      },
      { capture: true, passive: true }
    );

    if (pauseWhenHidden) {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.pause();
        else this.resume();
      });
    }

    // Tree churn is constant in the workbench, so this callback only flips a
    // flag; the expensive querySelectorAll sweep is throttled in the loop.
    this.treeObserver = new MutationObserver(() => {
      this.needsRescan = true;
      this.markDirty();
    });
    this.treeObserver.observe(document.body, { childList: true, subtree: true });

    // Attribute mutations identify exactly which caret changed, so only that
    // one re-reads computed style and geometry.
    this.styleObserver = new MutationObserver((records) => {
      for (let i = 0; i < records.length; i++) {
        const id = records[i].target.dataset?.cursorId;
        if (!id) continue;
        const data = this.cursors.get(id);
        if (data) {
          data.styleDirty = true;
          data.needsRead = true;
        }
      }
      this.markDirty();
    });

    this.scanCursors();
    this.schedule();
  }

  // ---- scheduling -------------------------------------------------

  // The loop only runs while there is work. Anything that creates work calls
  // markDirty, which re-arms it. Idle means literally zero frames.
  schedule() {
    if (this.rafId === null && !this.paused) {
      this.rafId = requestAnimationFrame(this.boundLoop);
    }
  }

  markDirty() {
    this.dirty = true;
    this.schedule();
  }

  pause() {
    this.paused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    clearTimeout(this.releaseTimeout);
    this.releaseTimeout = null;
    // Nothing is visible while hidden, so give the memory back immediately.
    this.releaseCanvas();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.forceReadAll = true;
    this.needsRescan = true;
    this.markDirty();
  }

  // ---- canvas backing store ---------------------------------------

  allocateCanvas() {
    this.dpr = useHiDPI
      ? Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio)
      : 1;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.canvas.width = Math.floor(this.viewW * this.dpr);
    this.canvas.height = Math.floor(this.viewH * this.dpr);
    // Draw in CSS pixels; the backing store carries the density.
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.canvasAllocated = true;
    this.paintedValid = false;
  }

  releaseCanvas() {
    if (!this.canvasAllocated) return;
    // Setting the dimensions to zero frees the backing store outright.
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvasAllocated = false;
    this.paintedValid = false;
  }

  scheduleCanvasRelease() {
    if (this.releaseTimeout || !this.canvasAllocated) return;
    this.releaseTimeout = setTimeout(() => {
      this.releaseTimeout = null;
      if (!this.wasAnimating) this.releaseCanvas();
    }, releaseCanvasAfter);
  }

  ensureCanvas() {
    if (!this.canvasAllocated) this.allocateCanvas();
    if (this.releaseTimeout) {
      clearTimeout(this.releaseTimeout);
      this.releaseTimeout = null;
    }
  }

  // ---- caret bookkeeping ------------------------------------------

  scanCursors() {
    const elements = document.querySelectorAll(".monaco-editor .cursor");
    const seen = this.seenScratch;
    seen.clear();

    for (let i = 0; i < elements.length; i++) {
      const target = elements[i];
      let id = target.dataset.cursorId;
      if (!id) {
        id = "c" + Math.random().toString(36).slice(2, 9);
        target.dataset.cursorId = id;
      }
      seen.add(id);
      if (this.cursors.has(id)) continue;

      const rect = target.getBoundingClientRect();
      const instance = new NeovideCursor(this.fillCss, this.shadowCss);
      instance.setSize(rect.width, rect.height);
      instance.setPosition(rect.left, rect.top);

      this.styleObserver.observe(target, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });

      this.cursors.set(id, {
        instance,
        target,
        lastX: rect.left,
        lastY: rect.top,
        lastW: rect.width,
        lastH: rect.height,
        isActive: false,
        isJumping: true,
        jumpSrcX: gLastX,
        jumpSrcY: gLastY,
        cachedActive: false,
        styleDirty: true,
        needsRead: true,
        animating: false,
        offScreen: false,
        hiddenNative: false,
      });
    }

    for (const [id, data] of this.cursors) {
      if (!seen.has(id) || !data.target.isConnected) {
        this.restoreNativeCursor(data);
        this.cursors.delete(id);
        this.paintedValid = false;
      }
    }
  }

  isTargetActive(data) {
    // getComputedStyle only runs when a mutation says this caret changed.
    if (!data.styleDirty) return data.cachedActive;

    const cs = getComputedStyle(data.target);
    // Opacity is deliberately excluded: we drive the native caret's opacity
    // ourselves during the handoff, and testing it here would make the caret
    // mark itself inactive the moment we hide it.
    data.cachedActive =
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      cs.transform.indexOf("-10000px") === -1;
    data.styleDirty = false;
    return data.cachedActive;
  }

  hideNativeCursor(data) {
    if (data.hiddenNative) return;
    data.target.style.transition = "opacity 0s ease-out";
    data.target.style.opacity = "0";
    data.hiddenNative = true;
  }

  restoreNativeCursor(data) {
    if (!data.hiddenNative) return;
    if (data.target.isConnected) {
      data.target.style.transition = `opacity ${nativeCursorRevealDuration}s ease-in`;
      data.target.style.opacity = "1";
    }
    data.hiddenNative = false;
  }

  clearPainted() {
    if (!this.paintedValid) return;
    const w = this.pMaxX - this.pMinX;
    const h = this.pMaxY - this.pMinY;
    if (w > 0 && h > 0) this.ctx.clearRect(this.pMinX, this.pMinY, w, h);
    this.paintedValid = false;
  }

  // ---- frame ------------------------------------------------------

  loop(now) {
    this.rafId = null;
    if (this.paused) return;

    const t = now || performance.now();
    const wasDirty = this.dirty;
    this.dirty = false;

    // Throttled sweep — tree mutations fire constantly, querySelectorAll does
    // not need to run on every one of them.
    if (this.needsRescan && wasDirty) {
      if (t - this.lastRescan >= rescanThrottle || this.cursors.size === 0) {
        this.lastRescan = t;
        this.needsRescan = false;
        this.scanCursors();
      }
    }

    const forceAll = this.forceReadAll;
    this.forceReadAll = false;
    const scrolling = this.isScrolling;

    let anyAnimating = false;
    let anyDrawn = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    // Pass 1: physics. Nothing touches the canvas yet, so all layout reads
    // stay batched ahead of any paint.
    for (const [id, data] of this.cursors) {
      if (!data.target.isConnected) {
        this.cursors.delete(id);
        continue;
      }

      const instance = data.instance;
      const wasAnim = data.animating;
      const mustRead = forceAll || data.needsRead || data.isJumping;

      // Geometry is only re-measured when something says it may have moved,
      // or while this caret is mid-flight.
      if (mustRead || wasAnim) {
        const active = this.isTargetActive(data);
        const rect = data.target.getBoundingClientRect();
        data.needsRead = false;

        const moved = rect.left !== data.lastX || rect.top !== data.lastY;
        const resized = rect.width !== data.lastW || rect.height !== data.lastH;

        if (active && !data.isActive) {
          data.isJumping = true;
          data.jumpSrcX = gLastX;
          data.jumpSrcY = gLastY;
        }

        if (data.isJumping && (moved || resized)) {
          instance.setSize(rect.width, rect.height);
          instance.move(rect.left, rect.top, data.jumpSrcX, data.jumpSrcY);
          data.isJumping = false;
        } else if (active && (moved || resized)) {
          instance.setSize(rect.width, rect.height);
          instance.move(rect.left, rect.top, null, null);
        }

        data.lastX = rect.left;
        data.lastY = rect.top;
        data.lastW = rect.width;
        data.lastH = rect.height;
        data.isActive = active;
        data.offScreen =
          rect.right < 0 ||
          rect.bottom < 0 ||
          rect.left > this.viewW ||
          rect.top > this.viewH;
      }

      if (!data.isActive) {
        this.restoreNativeCursor(data);
        data.animating = false;
        data.shouldDraw = false;
        continue;
      }

      if (instance.lastTimestamp === 0) instance.lastTimestamp = t;
      let dt = (t - instance.lastTimestamp) / 1000;
      instance.lastTimestamp = t;
      if (dt > 1 / 30) dt = 1 / 30;
      else if (dt < 0) dt = 0;

      const animating = instance.step(dt, scrolling);
      data.animating = animating;
      if (animating) anyAnimating = true;

      // Draw on animating frames, plus the single frame where it settles.
      data.shouldDraw = !data.offScreen && (animating || wasAnim);
      if (data.shouldDraw) anyDrawn = true;
    }

    // Pass 2: paint. Skipped entirely if nothing needs drawing, which also
    // means the canvas buffer is never touched on a no-op frame.
    if (anyDrawn) {
      this.ensureCanvas();
      this.clearPainted();
      for (const [, data] of this.cursors) {
        if (!data.shouldDraw) continue;
        const inst = data.instance;
        inst.draw(this.ctx);
        if (inst.minX < minX) minX = inst.minX;
        if (inst.minY < minY) minY = inst.minY;
        if (inst.maxX > maxX) maxX = inst.maxX;
        if (inst.maxY > maxY) maxY = inst.maxY;
      }
      this.pMinX = minX;
      this.pMinY = minY;
      this.pMaxX = maxX;
      this.pMaxY = maxY;
      this.paintedValid = true;
    } else if (wasDirty) {
      this.clearPainted();
    }

    // Native caret handoff: hide the real caret while the physics cursor is
    // in flight, bring it back crisp once everything settles so glyph
    // alignment stays exact.
    if (anyAnimating) {
      if (this.fadeTimeout) {
        clearTimeout(this.fadeTimeout);
        this.fadeTimeout = null;
      }
      if (this.canvas.style.opacity !== "1") {
        this.canvas.style.transition = "none";
        this.canvas.style.opacity = "1";
      }
      for (const [, data] of this.cursors) {
        if (data.isActive) this.hideNativeCursor(data);
      }
    } else if (this.wasAnimating) {
      for (const [, data] of this.cursors) {
        if (data.isActive) this.restoreNativeCursor(data);
      }
      if (this.canvas.style.opacity === "1" && !this.fadeTimeout) {
        this.fadeTimeout = setTimeout(() => {
          this.canvas.style.transition = `opacity ${cursorFadeOutDuration}s ease-out`;
          this.canvas.style.opacity = "0";
          this.fadeTimeout = null;
          // One final pass to wipe the last painted region, then let the
          // buffer go.
          this.markDirty();
          this.scheduleCanvasRelease();
        }, cursorDisappearDelay);
      }
    }

    this.wasAnimating = anyAnimating;

    // Re-arm only if there is still work. Otherwise the loop stops here and
    // the next mutation, scroll, or resize restarts it.
    if (anyAnimating || this.dirty) this.schedule();
    else this.scheduleCanvasRelease();
  }
}

// ====================================================================
// SECTION 5: Boot
// ====================================================================

// The loader can inject this before <body> exists, so poll until it does
// rather than trusting document.readyState in this context.
function safeInit() {
  if (document.body) {
    new GlobalCursorManager();
  } else {
    requestAnimationFrame(safeInit);
  }
}
safeInit();
