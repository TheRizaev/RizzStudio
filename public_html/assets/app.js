/* THE RIZAEV — public site main script.
 *
 * Vanilla JS (no React / build step). Fetches /api/catalog, renders the page,
 * wires the audio engine to the player UI. Mobile and desktop share the same
 * markup; CSS handles the layout switch via media queries.
 *
 * Player model:
 *   - Inline #player-section is now a *passive* tracklist only — clicking a
 *     row starts playback and opens the fullscreen overlay.
 *   - The fullscreen overlay (#player-fs) holds the circular EQ, rotating
 *     cover (vinyl-style), tracklist sidebar, transport controls, and the
 *     progress bar. It auto-opens on play and closes via the ✕ button.
 */

import { audioEngine } from './audio-engine.js';
import { CircularEQ } from './circular-eq.js';
import { rmark, formatTime, $, $$, e } from './ui-helpers.js';

const ROOT = $('#root');

// Module-level handles. Kept here so a hot re-render doesn't leak rAF loops.
let circularEQ = null;
// Cached release context for the overlay tracklist sidebar.
let currentRelease = null;
// All releases (used to look up titles for cross-release queues).
let allReleases = [];

/* ─── boot ─── */
async function boot() {
  ROOT.innerHTML = `
    <div class="tex-vignette"></div>
    <div class="tex-scan"></div>
    <div id="app-shell">
      ${navHTML()}
      ${heroHTML()}
      ${marqueeHTML()}
      <section id="player-section" class="player-section"></section>
      <section id="latest-section" class="latest-section"></section>
      <section id="vault-section" class="vault-section"></section>
      ${footerHTML()}
    </div>
    ${fullscreenPlayerHTML()}
  `;

  // Footer glitch — runs continuously, started once after first render
  startFooterGlitch();

  // Wire the fullscreen overlay (it's part of the initial DOM, so we can
  // attach handlers right away — they'll just fire when state changes).
  wireFullscreenPlayer();

  let catalog = { releases: [] };
  try {
    const res = await fetch('/api/catalog', { cache: 'no-cache' });
    catalog = await res.json();
  } catch {
    // graceful: render empty state instead of breaking
  }

  const releases = catalog.releases || [];
  allReleases = releases;
  renderHeroStats(releases);
  if (!releases.length) {
    renderEmpty();
    return;
  }

  const latest = releases[0];
  currentRelease = latest;

  audioEngine.setQueue(latest.tracks || []);

  renderPlayerTracklist(latest);
  renderLatest(latest);
  renderVault(releases);
  wireNavLinks();

  // Subscribe a single global listener that keeps both the inline tracklist
  // and the fullscreen overlay in sync with engine state.
  audioEngine.subscribe(syncAllUI);
}

function renderEmpty() {
  $('#player-section').innerHTML = `
    <div class="empty-state">
      <div class="card-tag">// THE VAULT IS EMPTY</div>
      <h2>no <em>signal</em> yet.</h2>
      <p>The first transmission hasn't been broadcast.<br>
      Come back soon or <a href="/admin">log in</a> to upload.</p>
    </div>
  `;
}

/* ─── live hero stats ─── */
function renderHeroStats(releases) {
  const tracksEl = $('#hs-tracks');
  const playsEl = $('#hs-plays');
  const durEl = $('#hs-duration');
  if (!tracksEl) return;

  let trackCount = 0;
  let plays = 0;
  let durationSec = 0;
  for (const r of releases) {
    for (const t of (r.tracks || [])) {
      trackCount += 1;
      plays += Number(t.plays) || 0;
      durationSec += Number(t.duration) || 0;
    }
  }

  tracksEl.textContent = trackCount === 0 ? '0' : String(trackCount);
  playsEl.textContent = plays.toLocaleString();
  durEl.textContent = formatHeroDuration(durationSec);
}

function formatHeroDuration(sec) {
  const total = Math.floor(sec || 0);
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/* ─── nav ─── */
function navHTML() {
  return `
    <header class="nav pad-x">
      <div class="logo">${rmark(56, '#fff', '#c6ff00')}</div>
      <nav class="nav-links">
        <a href="#player-section">PLAYER</a>
        <a href="#vault-section">RELEASES</a>
        <a href="#latest-section">LATEST</a>
        <a href="mailto:hello@rizaev.studio">CONTACT</a>
      </nav>
      <button class="btn-acid nav-cta" data-action="play-latest">
        LISTEN NOW <span aria-hidden="true">→</span>
      </button>
    </header>
  `;
}

/* ─── hero (vinyl restored as it was originally) ─── */
function heroHTML() {
  // 60 stars equally spaced on the outer ring
  const stars = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * 360;
    return `<text x="100" y="12" font-size="6" fill="#c6ff00" font-family="monospace"
      letter-spacing="0.2em" text-anchor="middle"
      transform="rotate(${a} 100 100)" opacity="0.7">★</text>`;
  }).join('');

  return `
    <section class="hero pad-x">
      <div class="hero-meta mono">
        <div class="hero-meta-row">
          <span class="acid">◉ LIVE</span>
          <span>AI-GENERATED · ALL GENRES · NO HUMANS HARMED</span>
        </div>
        <div class="hero-meta-row">
          <span class="acid">EST.</span>
          <span>2026 / NEURAL ARTIST</span>
        </div>
      </div>

      <h1 class="hero-title">
        <span class="hero-line">
          <span class="hero-rizz">RIZZ</span>
          <span class="hero-studio hero-flow">STUDIO</span>
        </span>
        <span class="hero-sub"><em>music</em> made by the machine,</span>
        <span class="hero-sub"><em>curated</em> by the ghost.</span>
      </h1>

      <div class="hero-bottom">
        <div class="hero-stat">
          <div class="hero-stat-num" id="hs-tracks">—</div>
          <div class="hero-stat-label mono">TRACKS<br>IN THE CATALOG</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-num" id="hs-plays">—</div>
          <div class="hero-stat-label mono">TOTAL PLAYS<br>ACROSS ALL TRACKS</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-num" id="hs-duration">—</div>
          <div class="hero-stat-label mono">TOTAL DURATION<br>OF MUSIC</div>
        </div>

        <div class="hero-vinyl">
          <svg viewBox="0 0 200 200" class="hv-ring1">${stars}</svg>
          <svg viewBox="0 0 200 200" class="hv-ring2">
            <defs>
              <path id="heroCirc" d="M 100 100 m -75 0 a 75 75 0 1 1 150 0 a 75 75 0 1 1 -150 0" fill="none"/>
            </defs>
            <text font-size="9" fill="#fff" font-family="monospace" letter-spacing="0.4em" opacity="0.85">
              <textPath href="#heroCirc" startOffset="0">
                THE RIZAEV · NEURAL ARTIST · THE RIZAEV · NON-HUMAN · 
              </textPath>
            </text>
          </svg>
          <div class="hero-vinyl-inner">
            <svg viewBox="0 0 100 100" width="68" height="68">
              <rect x="22" y="20" width="14" height="60" fill="#fff"/>
              <rect x="22" y="20" width="42" height="14" fill="#fff"/>
              <rect x="22" y="46" width="38" height="14" fill="#fff"/>
              <rect x="50" y="20" width="14" height="40" fill="#fff"/>
              <polygon points="44,54 60,54 78,80 62,80" fill="#fff"/>
              <circle cx="74" cy="26" r="4" fill="#c6ff00"/>
            </svg>
          </div>
        </div>
      </div>
    </section>
  `;
}

function marqueeHTML() {
  const item = `<span>NEW DROP — "NEURAL DECAY" — OUT NOW</span><span class="star">✦</span>`;
  return `
    <div class="marquee">
      <div class="marquee-track">${item.repeat(8)}</div>
    </div>
  `;
}

/* ─── footer ─── */
function footerHTML() {
  return `
    <footer class="footer pad-x">
      <div class="footer-hero" id="footer-hero">
        <div class="fh-scanlines"></div>
        <div class="fh-beam" id="fh-beam"></div>
        <div class="fh-wordmark">
          <div class="fh-layer fh-magenta" id="fh-magenta">${footerWordmark('#ff10a8', false)}</div>
          <div class="fh-layer fh-cyan" id="fh-cyan">${footerWordmark('#00d9ff', false)}</div>
          <div class="fh-layer fh-base" id="fh-base">${footerWordmark('#c6ff00', true)}</div>
        </div>
      </div>
      <div class="footer-row mono">
        <span class="footer-row-left">
          ${rmark(18, '#fff', '#c6ff00')}
          <span>© 2026 — NEURAL ARTIST</span>
        </span>
        <span>NO COOKIES. NO TRACKING. JUST NOISE.</span>
        <span>v.4.7.2 / BUILD 0420</span>
      </div>
    </footer>
  `;
}

function footerWordmark(color, isBase) {
  const dotColor = isBase ? '#fff' : color;
  return `
    <span class="fh-mark" style="color:${color}">
      <em class="fh-the">the</em><span class="fh-name">RIZAEV</span><span class="fh-dot" style="color:${dotColor}">.</span>
    </span>
  `;
}

function startFooterGlitch() {
  const base = $('#fh-base');
  const r1 = $('#fh-magenta');
  const r2 = $('#fh-cyan');
  const beam = $('#fh-beam');
  if (!base || !r1 || !r2 || !beam) return;

  const loop = (ts) => {
    const t = ts / 1000;
    const jitterX = Math.sin(t * 30) * 1.5;
    const jitterY = Math.cos(t * 23) * 0.8;
    const rgbR = Math.sin(t * 8) * 6;
    base.style.transform = `translate(${jitterX}px, 0)`;
    r1.style.transform = `translate(${rgbR}px, ${jitterY}px)`;
    r2.style.transform = `translate(${-rgbR}px, ${-jitterY}px)`;
    beam.style.top = `${(t * 80) % 100}%`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function wireNavLinks() {
  $$('a[href^="#"]').forEach(a => {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      const t = $(a.getAttribute('href'));
      if (t) t.scrollIntoView({ behavior: 'smooth' });
    });
  });
  $('[data-action="play-latest"]').addEventListener('click', () => {
    audioEngine.playIndex(0, true);
    // syncAllUI -> openFullscreen will run on the next state tick.
  });
}

/* ─── inline player section — tracklist only, no controls ─── */
function renderPlayerTracklist(release) {
  const sec = $('#player-section');
  sec.innerHTML = `
    <div class="pad-x">
      <div class="player-head">
        <span class="card-tag">// PLAYER · ${escapeHTML(release.title.toUpperCase())}</span>
        <span class="mono player-counter" id="player-counter">— / —</span>
      </div>
      <div class="player-hint mono">
        <span class="acid">◉</span> CLICK ANY TRACK TO LAUNCH THE FULLSCREEN PLAYER
      </div>
      <div class="tracklist" id="tracklist"></div>
    </div>
  `;

  const tl = $('#tracklist');
  tl.innerHTML = (release.tracks || []).map((t, i) => `
    <button class="track-row" data-idx="${i}">
      <span class="track-num">${t.n || String(i + 1).padStart(2, '0')}</span>
      <span class="eq-bars" style="display:none"><span></span><span></span><span></span><span></span></span>
      <span class="track-body">
        <span class="track-title">${escapeHTML(t.title)}</span>
        <span class="track-meta mono">
          ${t.bpm ? `${t.bpm} BPM · ` : ''}${formatTime(t.duration || 0)}
        </span>
      </span>
      <span class="track-play">▶</span>
    </button>
  `).join('');

  $$('#tracklist .track-row').forEach(row => {
    row.addEventListener('click', () => {
      const i = +row.dataset.idx;
      audioEngine.playIndex(i, true);
      // openFullscreen() called by syncAllUI when playing flips to true.
    });
  });
}

/* ─── fullscreen player overlay ─── */
function fullscreenPlayerHTML() {
  return `
    <div id="player-fs" class="player-fs" aria-hidden="true">
      <!--
        Layered structure:
          .fs-bg          fixed black + ambient glow background
          .fs-canvas-wrap absolutely positioned full-viewport, holds the EQ canvas
          .fs-cover       centered rotating cover (vinyl)
          .fs-sidebar     right-side track sidebar
          .fs-topbar      top-left meta + close button top-right
          .fs-bottombar   transport row + progress bar at the bottom
        All layers use position:absolute inside the fixed-position root so we
        avoid stacking-context surprises.
      -->
      <div class="fs-bg"></div>
      <div class="fs-canvas-wrap">
        <canvas id="fs-eq-canvas" class="fs-eq-canvas"></canvas>
      </div>

      <div class="fs-cover" id="fs-cover">
        <!--
          Inner img/fallback is rotated by CSS when playing. Outer wrapper holds
          the optional thin acid border.
        -->
        <div class="fs-cover-disc" id="fs-cover-disc">
          <img id="fs-cover-img" alt="" style="display:none">
          <div class="fs-cover-fallback" id="fs-cover-fallback"></div>
          <!-- center dot like on a vinyl record -->
          <div class="fs-cover-spindle"></div>
        </div>
      </div>

      <header class="fs-topbar">
        <div class="fs-meta">
          <div class="fs-meta-tag mono">
            <span class="live-dot" id="fs-dot"></span>
            <span id="fs-status">PAUSED</span>
          </div>
          <div class="fs-release mono" id="fs-release">—</div>
        </div>
        <button class="fs-close" id="fs-close" aria-label="Close player">
          <span aria-hidden="true">✕</span>
          <span class="fs-close-label mono">CLOSE</span>
        </button>
      </header>

      <aside class="fs-sidebar" id="fs-sidebar">
        <div class="fs-sidebar-head">
          <div class="card-tag">// QUEUE</div>
          <div class="fs-sidebar-title mono" id="fs-sidebar-title">—</div>
        </div>
        <div class="fs-sidebar-list" id="fs-sidebar-list"></div>
      </aside>

      <div class="fs-bottombar">
        <div class="fs-now">
          <div class="fs-now-title" id="fs-now-title">—</div>
          <div class="fs-now-meta mono" id="fs-now-meta">—</div>
        </div>

        <div class="fs-controls">
          <button class="fs-transport" data-action="prev" aria-label="Previous">⏮</button>
          <button class="fs-play" id="fs-play" aria-label="Play/pause">▶</button>
          <button class="fs-transport" data-action="next" aria-label="Next">⏭</button>
        </div>

        <div class="fs-time-wrap">
          <span class="mono fs-time-cur" id="fs-time-cur">0:00</span>
          <div class="fs-progress" id="fs-progress" role="slider" aria-label="Seek">
            <div class="fs-progress-fill" id="fs-progress-fill"></div>
            <div class="fs-progress-thumb" id="fs-progress-thumb"></div>
          </div>
          <span class="mono fs-time-total" id="fs-time-total">0:00</span>
        </div>
      </div>
    </div>
  `;
}

function wireFullscreenPlayer() {
  const fs = $('#player-fs');

  // Boot the visualizer once. It's harmless (idle bars) until playback starts.
  if (!circularEQ) {
    const canvas = $('#fs-eq-canvas');
    if (canvas) {
      circularEQ = new CircularEQ(canvas, audioEngine, {
        // Cover radius keeps in sync with the rendered cover element below
        // via setCoverRadius() on resize.
        coverRadiusPx: getCoverRadiusPx(),
      });
    }
  }

  // Close button.
  $('#fs-close').addEventListener('click', () => closeFullscreen());

  // Transport controls.
  $('#fs-play').addEventListener('click', () => audioEngine.toggle());
  fs.querySelector('[data-action="next"]').addEventListener('click', () => audioEngine.next());
  fs.querySelector('[data-action="prev"]').addEventListener('click', () => audioEngine.prev());

  // Progress bar — click + drag to seek.
  const prog = $('#fs-progress');
  let dragging = false;
  const seekFromEvent = ev => {
    const rect = prog.getBoundingClientRect();
    const x = ('clientX' in ev) ? ev.clientX : ev.touches?.[0]?.clientX;
    if (x == null) return;
    const f = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    audioEngine.seek(f);
  };
  prog.addEventListener('pointerdown', ev => {
    dragging = true; prog.setPointerCapture(ev.pointerId); seekFromEvent(ev);
  });
  prog.addEventListener('pointermove', ev => { if (dragging) seekFromEvent(ev); });
  const stopDrag = ev => {
    dragging = false;
    try { prog.releasePointerCapture(ev.pointerId); } catch {}
  };
  prog.addEventListener('pointerup', stopDrag);
  prog.addEventListener('pointercancel', stopDrag);

  // Keep cover radius in sync with the rendered .fs-cover element on resize.
  // The element's CSS size is what the EQ needs to know to position the
  // inner ring of bars correctly.
  window.addEventListener('resize', () => {
    if (circularEQ) circularEQ.setCoverRadius(getCoverRadiusPx());
  });
}

function getCoverRadiusPx() {
  const el = $('#fs-cover-disc');
  if (!el) return 140;
  const rect = el.getBoundingClientRect();
  // Fall back to 140 if it hasn't laid out yet (overlay was hidden).
  return Math.max(60, (rect.width || 280) / 2);
}

function openFullscreen() {
  const fs = $('#player-fs');
  if (!fs || fs.classList.contains('open')) return;
  fs.classList.add('open');
  fs.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  // After the layout actually runs (next frame), tell the EQ where the
  // cover is. Otherwise getCoverRadiusPx() reads zero.
  requestAnimationFrame(() => {
    if (circularEQ) circularEQ.setCoverRadius(getCoverRadiusPx());
  });
}

function closeFullscreen() {
  const fs = $('#player-fs');
  if (!fs) return;
  fs.classList.remove('open');
  fs.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  // Pause playback on close — feels right; the user explicitly dismissed
  // the player. Comment this out if you prefer continuous background play.
  audioEngine.pause();
}

/* ─── single global UI sync ─── */
function syncAllUI(state) {
  const { track, playing, position, duration, queue, index } = state;

  // ── Inline tracklist counter + active row ──
  const counter = $('#player-counter');
  if (counter) {
    counter.innerHTML = queue.length
      ? `<span class="acid">${String(index + 1).padStart(2, '0')}</span><span style="opacity:0.4"> / ${String(queue.length).padStart(2, '0')}</span>`
      : '— / —';
  }
  $$('#tracklist .track-row').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    const eq = el.querySelector('.eq-bars');
    const num = el.querySelector('.track-num');
    if (i === index && playing) {
      if (eq) eq.style.display = '';
      if (num) num.style.display = 'none';
    } else {
      if (eq) eq.style.display = 'none';
      if (num) num.style.display = '';
    }
  });

  // ── Auto-open the overlay the first time playback starts ──
  // Use `track` rather than `playing` because pressing play on a paused track
  // should also re-open the overlay if it was closed.
  if (track && playing) openFullscreen();

  // ── Fullscreen overlay sync ──
  const fs = $('#player-fs');
  if (!fs) return;

  $('#fs-status').textContent = playing ? 'NOW PLAYING' : 'PAUSED';
  $('#fs-dot').style.animationPlayState = playing ? 'running' : 'paused';
  $('#fs-play').textContent = playing ? '❚❚' : '▶';
  $('#fs-now-title').textContent = track?.title || '—';
  $('#fs-now-meta').textContent = track
    ? `THE RIZAEV — ${currentRelease?.title || ''}${track.bpm ? ` · ${track.bpm} BPM` : ''}`
    : '—';
  $('#fs-release').textContent = currentRelease
    ? `${currentRelease.title.toUpperCase()} · ${(currentRelease.type || 'sgl').toUpperCase()}`
    : '—';

  // Spinning-vinyl effect: toggle a class that runs the rotate animation.
  // Pausing freezes the rotation in place rather than resetting to 0deg.
  const disc = $('#fs-cover-disc');
  if (disc) disc.classList.toggle('spinning', playing);

  // Cover image / fallback gradient.
  const img = $('#fs-cover-img');
  const fb = $('#fs-cover-fallback');
  if (currentRelease) {
    const grad = `linear-gradient(135deg, ${currentRelease.accent_color || '#c6ff00'}, ${currentRelease.accent_color_2 || '#000'})`;
    if (currentRelease.cover_url) {
      img.src = currentRelease.cover_url;
      img.style.display = '';
      fb.style.display = 'none';
    } else {
      img.style.display = 'none';
      fb.style.display = '';
      fb.style.background = grad;
      fb.textContent = (currentRelease.title || '').slice(0, 24);
    }
  }

  // Sidebar tracklist — only re-render when the queue identity changes.
  const sidebarTitle = $('#fs-sidebar-title');
  if (sidebarTitle && currentRelease) sidebarTitle.textContent = currentRelease.title;
  renderFsSidebar(state);

  // Progress + time.
  const total = duration || track?.duration || 0;
  const frac = total > 0 ? Math.min(1, position / total) : 0;
  $('#fs-time-cur').textContent = formatTime(position);
  $('#fs-time-total').textContent = formatTime(total);
  $('#fs-progress-fill').style.width = (frac * 100).toFixed(2) + '%';
  $('#fs-progress-thumb').style.left = (frac * 100).toFixed(2) + '%';
}

// Cache the queue identity to avoid re-rendering the sidebar every frame.
let _lastSidebarQueueKey = '';
function renderFsSidebar(state) {
  const list = $('#fs-sidebar-list');
  if (!list) return;
  const queue = state.queue || [];
  const key = queue.map(t => t.id).join('|');
  const needsRebuild = key !== _lastSidebarQueueKey;

  if (needsRebuild) {
    list.innerHTML = queue.map((t, i) => `
      <button class="fs-row" data-idx="${i}">
        <span class="fs-row-num mono">${String(i + 1).padStart(2, '0')}</span>
        <span class="fs-row-eq" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="fs-row-body">
          <span class="fs-row-title">${escapeHTML(t.title)}</span>
          <span class="fs-row-meta mono">${formatTime(t.duration || 0)}</span>
        </span>
      </button>
    `).join('');
    list.querySelectorAll('.fs-row').forEach(row => {
      row.addEventListener('click', () => {
        const i = +row.dataset.idx;
        audioEngine.playIndex(i, true);
      });
    });
    _lastSidebarQueueKey = key;
  }

  // Update active state every tick — cheap.
  list.querySelectorAll('.fs-row').forEach((row, i) => {
    row.classList.toggle('active', i === state.index);
    row.classList.toggle('playing', i === state.index && state.playing);
  });
}

/* ─── latest release ─── */
function renderLatest(release) {
  const sec = $('#latest-section');
  const grad = `linear-gradient(135deg, ${release.accent_color || '#c6ff00'}, ${release.accent_color_2 || '#000'})`;
  sec.innerHTML = `
    <div class="pad-x latest-grid">
      <div class="latest-cover">
        <div class="cover-tag mono">// LATEST RELEASE</div>
        <div class="cover-art" style="background:${grad}">
          ${release.cover_url
            ? `<img src="${release.cover_url}" alt="${escapeHTML(release.title)}" loading="lazy">`
            : `<div class="cover-fallback">
                 <div class="cover-title">
                   <div>${escapeHTML(release.title.split(' ')[0] || 'RIZZ')}</div>
                   <div style="font-style:italic">${escapeHTML(release.title.split(' ').slice(1).join(' ') || 'STUDIO')}</div>
                 </div>
               </div>`}
          <div class="cover-badge mono">${(release.type || 'SGL').toUpperCase()} / 01</div>
        </div>
      </div>
      <div class="latest-info">
        <div class="release-date mono">RELEASED · ${formatDate(release.released_at)}</div>
        <h2 class="release-title">${escapeHTML(release.title)}</h2>
        <p class="release-desc">${escapeHTML(release.description || '')}</p>
        <div class="release-meta mono">
          ${(release.tracks || []).length} TRACKS · ${formatTime((release.tracks || []).reduce((a, t) => a + (t.duration || 0), 0))}
          ${release.genre ? ` · ${escapeHTML(release.genre.toUpperCase())}` : ''}
        </div>
        <div class="release-ctas">
          <button class="btn-acid" data-action="play-release">▶ PLAY ALBUM</button>
          <a class="btn-ghost" href="/release/${escapeHTML(release.slug)}">OPEN PAGE →</a>
        </div>
      </div>
    </div>
  `;

  $('[data-action="play-release"]').addEventListener('click', () => {
    audioEngine.setQueue(release.tracks || []);
    audioEngine.playIndex(0, true);
  });
}

/* ─── vault ─── */
function renderVault(releases) {
  const sec = $('#vault-section');
  sec.innerHTML = `
    <div class="pad-x">
      <div class="vault-head">
        <div>
          <div class="card-tag">// THE VAULT · ${releases.length} RELEASES</div>
          <h2 class="vault-title">the <em>back</em> catalog</h2>
        </div>
        <span class="mono vault-hint">← DRAG → / SCROLL</span>
      </div>
    </div>
    <div class="vault-scroll" id="vault-scroll">
      <div class="vault-track">
        ${releases.map((r, i) => vaultCardHTML(r, i, releases.length)).join('')}
      </div>
    </div>
  `;
  enableDragScroll($('#vault-scroll'));
}

function vaultCardHTML(r, i, total) {
  const grad = `linear-gradient(135deg, ${r.accent_color || '#c6ff00'}, ${r.accent_color_2 || '#000'})`;
  return `
    <a class="vault-card" href="/release/${escapeHTML(r.slug)}">
      <div class="vault-cover" style="background:${grad}">
        ${r.cover_url ? `<img src="${r.cover_url}" alt="${escapeHTML(r.title)}" loading="lazy">` : ''}
        <div class="vault-cover-idx mono">${String(i + 1).padStart(2, '0')}<span style="opacity:0.4">/${String(total).padStart(2, '0')}</span></div>
        <div class="vault-cover-badge mono">${(r.type || 'SGL').toUpperCase()}</div>
        <div class="vault-cover-year">${r.year || ''}</div>
      </div>
      <div class="vault-meta">
        <div class="vault-meta-top mono">
          <span class="acid">R/${String(i + 1).padStart(2, '0')}</span>
          <span>·</span>
          <span>${(r.tracks || []).length} TRACKS</span>
          <span>·</span>
          <span>${r.year || ''}</span>
        </div>
        <div class="vault-card-title">${escapeHTML(r.title)}</div>
        <div class="vault-listen mono"><span>↗</span> LISTEN</div>
      </div>
    </a>
  `;
}

/* ─── helpers ─── */
function enableDragScroll(el) {
  let down = false, sx = 0, sl = 0;
  el.addEventListener('pointerdown', e => {
    down = true; sx = e.pageX; sl = el.scrollLeft;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', e => {
    if (!down) return;
    el.scrollLeft = sl - (e.pageX - sx);
  });
  const release = e => { down = false; el.style.cursor = ''; el.releasePointerCapture?.(e.pointerId); };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }).toUpperCase();
  } catch { return '—'; }
}

boot();