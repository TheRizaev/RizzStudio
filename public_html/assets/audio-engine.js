/* THE RIZAEV — audio engine.
 *
 * Singleton player that any UI can subscribe to. Drives:
 *   - HTMLAudioElement (handles streaming, Range, codec selection)
 *   - Web Audio AnalyserNode (drives live waveform reactivity)
 *   - Pre-baked peaks (drawn instantly so the UI never looks empty)
 *
 * Why this split: the static peaks make the bar chart appear before the file
 * has loaded a single byte; the analyser then "lights up" the bars in time
 * with the music. If audio is paused or analyser isn't available (autoplay
 * blocked, file 404), the static peaks alone still produce a passable visual.
 *
 * Public:
 *   audioEngine.load(track, { peaks })   queue a track (doesn't autoplay)
 *   audioEngine.play() / pause() / toggle()
 *   audioEngine.seek(0..1)
 *   audioEngine.next() / prev()              (operates on the engine queue)
 *   audioEngine.setQueue(tracks, startIdx)
 *   audioEngine.subscribe(fn)                fn(state) on every change
 *
 * State shape:
 *   {
 *     queue: Track[],
 *     index: number,
 *     track: Track | null,
 *     playing: boolean,
 *     position: number (sec),
 *     duration: number (sec),
 *     buffered: number (0..1),
 *     peaks: number[] | null,            // static fallback amplitudes
 *     liveLevels: Float32Array | null,   // live frequency bins, 0..1
 *   }
 *
 *   Track = { id, title, audio_url, waveform_url?, duration?, ... }
 */

const ANALYSER_BINS = 128;          // number of bars the visualiser renders
const PLAY_COUNT_THRESHOLD_SEC = 30;

class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'metadata';

    this._listeners = new Set();
    this._state = {
      queue: [],
      index: -1,
      track: null,
      playing: false,
      position: 0,
      duration: 0,
      buffered: 0,
      peaks: null,
      liveLevels: null,
    };

    this._wireAudio();
    this._raf = null;
    this._countedFor = new Set(); // track ids for which we've already POSTed /api/play
    this._playStartedAt = 0;
  }

  _wireAudio() {
    const a = this.audio;
    a.addEventListener('play',   () => { this._patch({ playing: true }); this._startTicker(); });
    a.addEventListener('pause',  () => { this._patch({ playing: false }); });
    a.addEventListener('ended',  () => { this.next(); });
    a.addEventListener('loadedmetadata', () => this._patch({ duration: a.duration || 0 }));
    a.addEventListener('progress', () => this._patch({ buffered: this._bufferedFraction() }));
    a.addEventListener('error', () => {
      console.error('[audio] error', a.error);
      this._patch({ playing: false });
    });
  }

  _bufferedFraction() {
    const a = this.audio;
    if (!a.buffered.length || !a.duration) return 0;
    return a.buffered.end(a.buffered.length - 1) / a.duration;
  }

  // Web Audio is created lazily on first user gesture (browsers block it otherwise).
  _ensureAnalyser() {
    if (this._analyser) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._ctx = new Ctx();
      this._source = this._ctx.createMediaElementSource(this.audio);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = ANALYSER_BINS * 2;
      this._analyser.smoothingTimeConstant = 0.78;
      this._source.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);
      this._freqBuf = new Uint8Array(this._analyser.frequencyBinCount);
    } catch (e) {
      // Analyser not available — site still works, bars just won't react to audio.
      console.warn('[audio] analyser unavailable:', e);
    }
  }

  _startTicker() {
    if (this._raf) return;
    const tick = () => {
      const a = this.audio;
      const patch = { position: a.currentTime || 0 };

      if (this._analyser) {
        this._analyser.getByteFrequencyData(this._freqBuf);
        // Down-sample 1024 frequency bins → ANALYSER_BINS visual bars.
        // Use a logarithmic mapping so bass doesn't dominate the right half.
        const binsPerBar = this._freqBuf.length / ANALYSER_BINS;
        const out = new Float32Array(ANALYSER_BINS);
        for (let i = 0; i < ANALYSER_BINS; i++) {
          const start = Math.floor(i * binsPerBar);
          const end = Math.floor((i + 1) * binsPerBar);
          let sum = 0;
          for (let j = start; j < end; j++) sum += this._freqBuf[j];
          out[i] = (sum / Math.max(1, end - start)) / 255; // 0..1
        }
        patch.liveLevels = out;
      }

      // Play counter — debounced server-side too.
      if (this._state.track && a.currentTime >= PLAY_COUNT_THRESHOLD_SEC) {
        const id = this._state.track.id;
        if (!this._countedFor.has(id)) {
          this._countedFor.add(id);
          fetch('/api/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track_id: id }),
          }).catch(() => {});
        }
      }

      this._patch(patch);
      if (this._state.playing) {
        this._raf = requestAnimationFrame(tick);
      } else {
        this._raf = null;
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  _patch(diff) {
    let changed = false;
    for (const k in diff) {
      if (this._state[k] !== diff[k]) { this._state[k] = diff[k]; changed = true; }
    }
    if (changed) this._emit();
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this._state); } catch (e) { console.error(e); }
    }
  }

  /* ──────── public API ──────── */

  subscribe(fn) {
    this._listeners.add(fn);
    fn(this._state);
    return () => this._listeners.delete(fn);
  }

  getState() { return this._state; }

  setQueue(tracks, startIdx = 0) {
    this._state.queue = tracks || [];
    this._state.index = -1;
    if (this._state.queue.length) this.playIndex(startIdx, false);
  }

  load(track, { autoplay = false, peaks = null } = {}) {
    this._countedFor.clear();
    this._patch({
      track,
      peaks: peaks || null,
      position: 0,
      duration: track?.duration || 0,
      buffered: 0,
      liveLevels: null,
    });

    this.audio.src = track?.audio_url || '';
    this.audio.load();

    // If we don't have peaks yet, try to fetch a pre-baked waveform JSON.
    if (!peaks && track?.waveform_url) {
      fetch(track.waveform_url)
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (j && Array.isArray(j.peaks) && this._state.track?.id === track.id) {
            this._patch({ peaks: j.peaks });
          }
        })
        .catch(() => {});
    }

    if (autoplay) this.play();
  }

  play() {
    this._ensureAnalyser();
    if (this._ctx?.state === 'suspended') this._ctx.resume();
    return this.audio.play().catch(err => {
      console.warn('[audio] play blocked:', err.message);
    });
  }

  pause() { this.audio.pause(); }

  toggle() { this._state.playing ? this.pause() : this.play(); }

  seek(fraction) {
    if (!this.audio.duration) return;
    this.audio.currentTime = Math.max(0, Math.min(1, fraction)) * this.audio.duration;
  }

  playIndex(i, autoplay = true) {
    if (!this._state.queue.length) return;
    const idx = ((i % this._state.queue.length) + this._state.queue.length) % this._state.queue.length;
    const track = this._state.queue[idx];
    this._state.index = idx;
    this.load(track, { autoplay });
  }

  next() {
    if (this._state.queue.length) this.playIndex(this._state.index + 1, true);
  }
  prev() {
    if (this._state.queue.length) this.playIndex(this._state.index - 1, true);
  }
}

export const audioEngine = new AudioEngine();

/* ──────── client-side waveform pre-computation ────────
 * Used by the admin uploader: computes a low-res peaks array from a freshly
 * uploaded audio file via OfflineAudioContext, then POSTs it to the server.
 * Doing this client-side avoids needing ffmpeg/pydub on cPanel and is fast
 * enough for files under ~30 minutes.
 */
export async function computePeaks(audioFile, numPeaks = 256) {
  const arrayBuf = await audioFile.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
  ctx.close();

  const channel = audioBuf.getChannelData(0);
  const blockSize = Math.floor(channel.length / numPeaks);
  const peaks = new Array(numPeaks);
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    const start = i * blockSize;
    const end = start + blockSize;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks[i] = +max.toFixed(3);
  }
  return { peaks, duration: audioBuf.duration };
}
