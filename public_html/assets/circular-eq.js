/* THE RIZAEV — fullscreen circular equalizer (v3, "dot ring" style).
 *
 * Reference-driven rewrite. The visual model is:
 * - Default state: every bar is a small dot/tick on a circle. Idle, calm.
 * - When audio is loud: the dot for that frequency extends OUTWARD into a
 * long capsule (a fat rounded line). Quieter frequencies stay as dots.
 * - The ring breathes — only a SECTOR is active at any moment, and the
 * "live" sector moves around as the music's spectrum shifts.
 *
 * Why this works visually: the contrast between "passive dots" and "active
 * capsules" is what makes the ring feel like an audio meter rather than
 * decorative motion. If every bar always extends, you get a sun. The
 * referenced design keeps 60-80% of the ring as plain dots so the active
 * region pops.
 *
 * Implementation notes:
 * - We draw outward from the inner radius like before, but each bar's
 * visible length is GATED by an activation threshold. Below the gate,
 * the bar renders as a tiny dot (length ≈ 4px). Above the gate, the
 * bar grows linearly with the level above the gate.
 * - The gate itself adapts to the loudest bar in the current frame
 * (auto-gain). On quiet music the gate drops so dots still occasionally
 * extend; on loud music it rises so we don't get an everything-on look.
 * - Glow is much softer than v2 — references show clean white dots, not
 * a bloomed sun. We do one thin halo + the crisp acid line.
 *
 * Public API unchanged:
 * const eq = new CircularEQ(canvasEl, audioEngine, options?);
 * eq.destroy();
 * eq.setCoverRadius(px);
 * eq.getBassLevel()  -> 0..1, smoothed bass envelope (still drives cover)
 */

export class CircularEQ {
  constructor(canvas, audioEngine, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = audioEngine;

    this.opts = {
      coverRadiusPx: 140,

      // Dot rendering
      dotRadiusPx: 2.2,           // size of an inactive dot
      dotGapPx: 6,                // gap from cover edge to start of dots

      // Capsule rendering (when bar is active)
      capsuleWidthPx: 3.5,        // thickness of an active bar (rounded ends) - ADJUSTED FOR MINIMALISM
      maxBarLengthFrac: 0.45,     // max bar length as frac of available radius

      // Activation gate. Bars must exceed this threshold (after auto-gain)
      // to extend beyond a dot. Lower = more bars active. 0.18 keeps the
      // ring feeling sparse and selective like the reference.
      activationGate: 0.22, // ADJUSTED FOR MINIMALISM

      // Auto-gain tracking — divisor adapts to the loudest recent bar so
      // the gate stays meaningful across loud and quiet songs.
      gainSmoothing: 0.04,        // how fast auto-gain drifts toward target
      gainFloor: 0.35,            // never divide by less than this (avoids
                                  // exploding bar lengths during silence)

      // Per-bar smoothing for visual easing.
      smoothing: 0.30,

      // Colors — Minimalist monochrome scheme by default.
      // CHANGE THESE TO "YOUR COLORS" AS REQUESTED.
      colorAcid: '#ffffff',
      colorDot: 'rgba(255,255,255,0.40)',  // dots: softer white
      colorActive: '#ffffff',
      colorActiveGlow: 'rgba(255,255,255,0.20)', // softer glow

      ...options,
    };

    this._N = 96;
    this.eased = new Float32Array(this._N);

    // Auto-gain peak tracker — the rolling max we normalize against.
    this._autoGainPeak = this.opts.gainFloor;

    // Bass envelope still exposed for the cover pulse.
    this._bass = 0;

    this._playing = false;
    this._levels = null;

    this._rafId = null;
    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._t0 = performance.now();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);

    this._unsub = this.engine.subscribe(state => {
      this._playing = state.playing;
      this._levels = state.liveLevels || null;
    });

    this._resize();
    this._loop = this._loop.bind(this);
    this._rafId = requestAnimationFrame(this._loop);
  }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._unsub) this._unsub();
    if (this._ro) this._ro.disconnect();
  }

  setCoverRadius(px) { this.opts.coverRadiusPx = px; }
  getBassLevel() { return this._bass; }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(80, rect.width || 320);
    const cssH = Math.max(80, rect.height || 320);
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }
    this._dpr = dpr;
    this._cssW = cssW;
    this._cssH = cssH;

    // Bar density — denser ring on big screens. The reference uses ~120 dots,
    // dense enough to read as a continuous circle but sparse enough that a
    // gap (active capsule) is visible.
    const minDim = Math.min(cssW, cssH);
    const N = Math.min(160, Math.max(80, Math.round(minDim / 7)));
    if (N !== this._N) {
      this._N = N;
      this.eased = new Float32Array(N);
    }
  }

  /* Bass envelope for the cover pulse. Same asymmetric easing as v2 — fast
   * attack, slow decay, so kicks feel punchy but the cover doesn't snap
   * back instantly between hits. */
  _updateBass(levels) {
    if (!levels || !levels.length) {
      this._bass *= 0.92;
      return;
    }
    const bassEnd = Math.max(2, Math.floor(levels.length * 0.12));
    let sum = 0;
    for (let i = 0; i < bassEnd; i++) sum += levels[i];
    const bassRaw = Math.min(1, (sum / bassEnd) * 1.4);
    if (bassRaw > this._bass) this._bass += (bassRaw - this._bass) * 0.5;
    else                       this._bass += (bassRaw - this._bass) * 0.08;
  }

  /* Per-bar mid/high contribution.
   *
   * The reference keeps activity LOCALIZED in sectors (one chunk of the
   * ring lights up at a time, not scattered points). We achieve that by
   * mapping each bar to a contiguous range of FFT bins — adjacent bars
   * read adjacent frequencies. So when a guitar plays a note, all the
   * bars near that note's bin extend together as a group of capsules,
   * which is exactly what the reference shows.
   *
   * No mirror this time: the reference shows activity moving FREELY around
   * the ring (sometimes just bottom, sometimes top-right + bottom-left,
   * etc). A symmetric mirror would force every active sector to have a
   * twin on the opposite side, which is the wrong feel. */
  _midHighFor(i, levels) {
    const L = levels.length;
    const bassEnd = Math.max(2, Math.floor(L * 0.08));
    const mhRange = L - bassEnd;
    if (mhRange <= 0) return 0;
    // Simple linear mapping: bar i -> bin (bassEnd + (i/N) * mhRange)
    const t = i / Math.max(1, this._N - 1);
    // Power curve <1 expands low/mid bins (more visual coverage to the
    // frequency range that actually carries melody/rhythm).
    const curved = Math.pow(t, 0.75);
    const binIdx = bassEnd + Math.min(mhRange - 1, Math.floor(curved * mhRange));
    return levels[binIdx] || 0;
  }

  /* Idle pattern — tiny breathing motion when paused. Not visible as
   * extended bars (they all stay dots), but the eased buffer wiggles so
   * the next play-event animates in smoothly. */
  _idleLevel(i, t) {
    return 0.04 + 0.03 * Math.sin((i * 0.18) + t * 1.2);
  }

  _loop(now) {
    this._rafId = requestAnimationFrame(this._loop);

    const { ctx, opts, _cssW: cssW, _cssH: cssH, _dpr: dpr, _N: N } = this;
    const w = cssW * dpr;
    const h = cssH * dpr;
    const cx = w / 2;
    const cy = h / 2;

    const rInner = (opts.coverRadiusPx + opts.dotGapPx) * dpr;
    const rOuterCap = (Math.min(cssW, cssH) / 2) * dpr;
    const maxLen = Math.max(rOuterCap - rInner, 50 * dpr) * opts.maxBarLengthFrac;

    ctx.clearRect(0, 0, w, h);

    const t = (now - this._t0) / 1000;
    const levels = this._levels;
    const usingLive = this._playing && levels && levels.length > 0;

    if (usingLive) this._updateBass(levels);
    else { this._bass *= 0.94; }

    // ── Step 1: collect raw per-bar targets and find the frame's max ──
    // We need the max so the auto-gain can normalize each bar relative to
    // it. Without this, soft tracks would never trigger any active bars
    // and loud tracks would have everything on.
    let frameMax = 0;
    const rawTargets = new Float32Array(N);
    if (usingLive) {
      const bassMix = this._bass * 0.25; // small global lift on bass
      for (let i = 0; i < N; i++) {
        const mh = this._midHighFor(i, levels);
        const v = Math.min(1, mh + bassMix);
        rawTargets[i] = v;
        if (v > frameMax) frameMax = v;
      }
    } else {
      for (let i = 0; i < N; i++) rawTargets[i] = this._idleLevel(i, t);
      frameMax = 0.07;
    }

    // ── Step 2: auto-gain ──
    // _autoGainPeak slowly chases the recent max. Dividing rawTargets by it
    // produces normalized values 0..1 that respect dynamics within the
    // current track but don't penalize quiet songs.
    const targetPeak = Math.max(opts.gainFloor, frameMax);
    if (targetPeak > this._autoGainPeak) {
      // Faster rise so loud sections don't clip visually.
      this._autoGainPeak += (targetPeak - this._autoGainPeak) * 0.25;
    } else {
      this._autoGainPeak += (targetPeak - this._autoGainPeak) * opts.gainSmoothing;
    }
    const gainDiv = Math.max(opts.gainFloor, this._autoGainPeak);

    // ── Step 3: ease values toward normalized targets ──
    for (let i = 0; i < N; i++) {
      const norm = Math.min(1, rawTargets[i] / gainDiv);
      this.eased[i] += (norm - this.eased[i]) * opts.smoothing;
    }

    // ── Step 4: render ──
    // Slow rotation drift so the ring feels alive even when the music is
    // sparse. The drift is much smaller than v2 because the reference
    // doesn't visibly rotate — it's a static circle whose dots animate.
    const baseRotation = -Math.PI / 2 + Math.sin(t * 0.15) * 0.02;
    const angularStep = (Math.PI * 2) / N;

    const dotR = opts.dotRadiusPx * dpr;
    const capW = opts.capsuleWidthPx * dpr;
    const gate = opts.activationGate;

    // Two collections: dots and active capsules. We batch each into one
    // Path2D so the GPU isn't toggling state between every bar.
    const dotPath = new Path2D();
    const activePath = new Path2D();
    const activeGlowPath = new Path2D();

    for (let i = 0; i < N; i++) {
      const lvl = Math.max(0, Math.min(1, this.eased[i]));
      const angle = baseRotation + i * angularStep;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      if (lvl < gate) {
        // Plain dot at the inner radius. Reference-style: small, slightly
        // soft, evenly spaced.
        const x = cx + cosA * rInner;
        const y = cy + sinA * rInner;
        dotPath.moveTo(x + dotR, y);
        dotPath.arc(x, y, dotR, 0, Math.PI * 2);
      } else {
        // Active capsule — extends outward by (lvl - gate)/(1 - gate) of
        // maxLen. Inner end starts at rInner (so the dot transitions
        // smoothly into a capsule of the same anchor point).
        const effective = (lvl - gate) / (1 - gate);
        const len = Math.max(dotR * 2, maxLen * effective);
        const x1 = cx + cosA * rInner;
        const y1 = cy + sinA * rInner;
        const x2 = cx + cosA * (rInner + len);
        const y2 = cy + sinA * (rInner + len);
        // sub-path for this capsule
        activePath.moveTo(x1, y1); activePath.lineTo(x2, y2);
        activeGlowPath.moveTo(x1, y1); activeGlowPath.lineTo(x2, y2);
      }
    }

    // Pass 1: soft glow under the active capsules only. Dots get no glow —
    // that's what keeps the inactive ring crisp and minimal.
    ctx.lineCap = 'round';
    ctx.strokeStyle = opts.colorActiveGlow;
    ctx.lineWidth = capW * 3.2;
    ctx.stroke(activeGlowPath);

    // Pass 2: dots — soft white, no glow.
    ctx.fillStyle = opts.colorDot;
    ctx.fill(dotPath);

    // Pass 3: active capsules on top — crisp acid.
    ctx.strokeStyle = opts.colorActive;
    ctx.lineWidth = capW;
    ctx.stroke(activePath);
  }
}