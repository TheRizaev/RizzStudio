export class CircularEQ {
  constructor(canvas, audioEngine, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = audioEngine;

    this.opts = {
      innerRadiusPx: 150,
      outerRadiusFrac: 0.95, // Увеличено (было 0.82) - позволяет эквалайзеру занимать больше места на экране

      bars: 120,
      minBarPx: 12,          // Увеличено (было 6) - базовый размер баров
      maxBarPx: 140,         // Увеличено (было 62) - максимальная длина баров (размах)
      lineWidthPx: 2.5,      // Увеличено (было 1.9) - толщина линий для лучшей видимости при большом размере

      glowBlurPx: 7,
      ghostAlpha: 0.2,

      bassAttack: 0.46,
      bassDecay: 0.1,
      smooth: 0.18,

      rotationSpeed: 0.025,

      color: '#baff00',

      ...options,
    };

    this._levels = null;
    this._playing = false;
    this._bass = 0;
    this._bars = new Float32Array(this.opts.bars);

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

  setCoverRadius(px) {
    this.opts.innerRadiusPx = Math.max(80, px + 10);
  }

  getBassLevel() {
    return this._bass;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    const cssW = Math.max(120, rect.width || 320);
    const cssH = Math.max(120, rect.height || 320);

    this._cssW = cssW;
    this._cssH = cssH;
    this._dpr = dpr;

    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);

    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }
  }

  _updateBass(levels) {
    if (!levels || !levels.length) {
      this._bass *= 0.92;
      return;
    }

    const end = Math.max(3, Math.floor(levels.length * 0.12));
    let sum = 0;

    for (let i = 0; i < end; i++) {
      sum += levels[i];
    }

    const raw = Math.min(1, (sum / end) * 1.55);
    const k = raw > this._bass
      ? this.opts.bassAttack
      : this.opts.bassDecay;

    this._bass += (raw - this._bass) * k;
  }

  _levelAt(index, levels, t) {
    if (!this._playing || !levels || !levels.length) {
      return (
        0.12 +
        Math.sin(t * 0.8 + index * 0.18) * 0.035 +
        Math.sin(t * 1.3 + index * 0.06) * 0.025
      );
    }

    const n = this.opts.bars;
    const binA = Math.floor((index / n) * levels.length);
    const binB = Math.floor(((n - index) / n) * levels.length);

    const a = levels[Math.min(levels.length - 1, binA)] || 0;
    const b = levels[Math.min(levels.length - 1, binB)] || 0;

    return Math.min(1, (a * 0.75 + b * 0.25) * 1.4);
  }

  _loop(now) {
    this._rafId = requestAnimationFrame(this._loop);

    const ctx = this.ctx;
    const o = this.opts;
    const dpr = this._dpr;

    const w = this.canvas.width;
    const h = this.canvas.height;

    const cx = w / 2;
    const cy = h / 2;

    const t = (now - this._t0) / 1000;
    const minSide = Math.min(w, h);

    const inner = o.innerRadiusPx * dpr;
    const outer = minSide * 0.5 * o.outerRadiusFrac;
    const usable = Math.max(30 * dpr, outer - inner);

    this._updateBass(this._levels);

    ctx.save();

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0, 0, 0, ${o.ghostAlpha})`;
    ctx.fillRect(0, 0, w, h);

    const rotation = t * o.rotationSpeed + this._bass * 0.035;

    this._drawSoftGlow(ctx, cx, cy, inner, usable);
    this._drawBars(ctx, cx, cy, inner, usable, rotation, t);

    ctx.restore();
  }

  _drawSoftGlow(ctx, cx, cy, inner, usable) {
    const o = this.opts;
    const dpr = this._dpr;
    const { r, g, b } = hexToRgb(o.color);

    const radius = inner + usable * 0.54 + this._bass * 12 * dpr;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${14 * dpr}px)`;

    const grad = ctx.createRadialGradient(cx, cy, inner * 0.55, cx, cy, radius);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.00)`);
    grad.addColorStop(0.52, `rgba(${r},${g},${b},${0.025 + this._bass * 0.04})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawBars(ctx, cx, cy, inner, usable, rotation, t) {
    const o = this.opts;
    const dpr = this._dpr;
    const N = o.bars;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (let pass = 0; pass < 2; pass++) {
      const isCore = pass === 1;

      ctx.filter = isCore ? 'none' : `blur(${o.glowBlurPx * dpr}px)`;
      ctx.lineWidth = (isCore ? o.lineWidthPx : o.lineWidthPx * 1.45) * dpr;

      for (let i = 0; i < N; i++) {
        const target = this._levelAt(i, this._levels, t);
        this._bars[i] += (target - this._bars[i]) * o.smooth;

        const energy = this._bars[i];
        const angle = rotation + (i / N) * Math.PI * 2;

        const wave =
          Math.sin(t * 0.9 + i * 0.13) *
          Math.cos(t * 0.45 + i * 0.05) *
          5 *
          dpr;

        // Длина баров теперь зависит от увеличенных minBarPx и maxBarPx
        const length =
          o.minBarPx * dpr +
          energy * o.maxBarPx * dpr +
          this._bass * 24 * dpr + // Усилил реакцию на бас
          wave;

        const start = inner + usable * 0.1;
        // Расширил границу обрезки с 0.94 до 1.0, чтобы столбикам было куда расти
        const end = Math.min(inner + usable * 1.0, start + length); 

        const x1 = cx + Math.cos(angle) * start;
        const y1 = cy + Math.sin(angle) * start;
        const x2 = cx + Math.cos(angle) * end;
        const y2 = cy + Math.sin(angle) * end;

        const alpha = isCore
          ? 0.42 + energy * 0.36
          : 0.08 + energy * 0.18;

        ctx.strokeStyle = this._rgba(o.color, alpha);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}

function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');

  if (h.length === 3) {
    h = h.split('').map(c => c + c).join('');
  }

  const n = parseInt(h, 16);

  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}