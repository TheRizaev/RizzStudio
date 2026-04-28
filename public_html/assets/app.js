/* THE RIZAEV — public site main script.
 *
 * Vanilla JS (no React / build step). Fetches /api/catalog, renders the page,
 * wires the audio engine to the player UI. Mobile and desktop share the same
 * markup; CSS handles the layout switch via media queries.
 */

import { audioEngine } from './audio-engine.js';
import { rmark, formatTime, $, $$, e } from './ui-helpers.js';

const ROOT = $('#root');

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
  `;

  // Footer glitch — runs continuously, started once after first render
  startFooterGlitch();

  let catalog = { releases: [] };
  try {
    const res = await fetch('/api/catalog', { cache: 'no-cache' });
    catalog = await res.json();
  } catch {
    // graceful: render empty state instead of breaking
  }

  const releases = catalog.releases || [];
  renderHeroStats(releases);
  if (!releases.length) {
    renderEmpty();
    return;
  }

  const latest = releases[0];
  const allTracks = releases.flatMap(r => (r.tracks || []).map(t => ({
    ...t,
    release_title: r.title,
    release_id: r.id,
    cover_url: r.cover_url,
  })));

  audioEngine.setQueue(latest.tracks || allTracks);

  renderPlayer();
  renderLatest(latest);
  renderVault(releases);
  wireNavLinks();
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

/* Live numbers in the hero strip — replaces the old hardcoded 47 / ∞ / 0%.
 * Counts are derived from the public catalog: total track count, sum of
 * play counts across all tracks, and total runtime formatted as H:MM (or
 * just M:SS for short catalogs under an hour). */
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

// Format seconds as either H:MM (catalog ≥ 1 hour) or M:SS — keeps the
// number short enough to read at hero-size font.
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

/* ─── hero — restored from v1-full.jsx mockup with vinyl + stats row ─── */
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

/* ─── footer with FooterHero RGB-glitch wordmark (ported from v1-full.jsx) ─── */
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

// 1:1 port of FooterHero's `wordmark()` from v1-full.jsx —
// 'the' italic + 'RIZAEV' + white period at the end.
// Note: the period is white only on the BASE layer; on the rgb-shifted
// layers it inherits the layer color so the chromatic aberration is uniform.
function footerWordmark(color, isBase) {
  const dotColor = isBase ? '#fff' : color;
  return `
    <span class="fh-mark" style="color:${color}">
      <em class="fh-the">the</em><span class="fh-name">RIZAEV</span><span class="fh-dot" style="color:${dotColor}">.</span>
    </span>
  `;
}

// rAF-driven sub-pixel jitter on the three layers. Constants ported
// directly from FooterHero in v1-full.jsx so the feel matches your design.
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
    $('#player-section').scrollIntoView({ behavior: 'smooth' });
  });
}

/* ─── player ─── */
function renderPlayer() {
  const sec = $('#player-section');
  sec.innerHTML = `
    <div class="pad-x">
      <div class="player-head">
        <span class="card-tag">// PLAYER</span>
        <span class="mono player-counter" id="player-counter">— / —</span>
      </div>

      <div class="now-playing">
        <div class="np-left">
          <div class="np-status">
            <span class="live-dot" id="np-dot"></span>
            <span id="np-status-text">PAUSED</span>
          </div>
          <div class="np-title" id="np-title">—</div>
          <div class="np-meta mono" id="np-meta">—</div>
        </div>
        <div class="np-controls">
          <button class="transport-btn" data-action="prev" aria-label="Previous">⏮</button>
          <button class="play-btn" id="play-btn" aria-label="Play/pause">▶</button>
          <button class="transport-btn" data-action="next" aria-label="Next">⏭</button>
        </div>
      </div>

      <div class="waveform" id="waveform" role="slider" aria-label="Seek">
        <div class="playhead" id="playhead"></div>
      </div>

      <div class="time-row mono">
        <span class="acid" id="time-cur">0:00</span>
        <span style="opacity:0.4">—</span>
        <span style="opacity:0.4" id="time-total">0:00</span>
      </div>

      <div class="tracklist" id="tracklist"></div>
    </div>
  `;

  $('#play-btn').addEventListener('click', () => audioEngine.toggle());
  $('[data-action="next"]').addEventListener('click', () => audioEngine.next());
  $('[data-action="prev"]').addEventListener('click', () => audioEngine.prev());

  const wf = $('#waveform');
  wf.addEventListener('click', ev => {
    const rect = wf.getBoundingClientRect();
    audioEngine.seek((ev.clientX - rect.left) / rect.width);
  });

  buildWaveformBars();
  audioEngine.subscribe(state => updatePlayerUI(state));
}

const NUM_BARS = 96;
function buildWaveformBars() {
  const wf = $('#waveform');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < NUM_BARS; i++) {
    const b = document.createElement('div');
    b.className = 'wave-bar';
    b.style.height = '20%';
    frag.appendChild(b);
  }
  wf.insertBefore(frag, $('#playhead'));
}

function updatePlayerUI(state) {
  const { track, playing, position, duration, peaks, liveLevels, queue, index } = state;

  $('#play-btn').textContent = playing ? '❚❚' : '▶';
  $('#np-status-text').textContent = playing ? 'NOW PLAYING' : 'PAUSED';
  $('#np-dot').style.animationPlayState = playing ? 'running' : 'paused';
  $('#np-title').textContent = track?.title || '—';
  $('#np-meta').textContent = track
    ? `THE RIZAEV — ${track.release_title || ''}${track.bpm ? ` — ${track.bpm} BPM` : ''}`
    : '—';
  $('#player-counter').innerHTML = queue.length
    ? `<span class="acid">${String(index + 1).padStart(2, '0')}</span><span style="opacity:0.4"> / ${String(queue.length).padStart(2, '0')}</span>`
    : '— / —';

  const total = duration || track?.duration || 0;
  $('#time-cur').textContent = formatTime(position);
  $('#time-total').textContent = formatTime(total);

  const bars = $$('#waveform .wave-bar');
  const progress = total > 0 ? position / total : 0;
  for (let i = 0; i < bars.length; i++) {
    const tPeak = peaks ? peaks[Math.floor(i * peaks.length / bars.length)] : null;
    const tLive = liveLevels ? liveLevels[Math.floor(i * liveLevels.length / bars.length)] : 0;
    const baseH = tPeak != null ? Math.max(0.1, tPeak * 0.95) : 0.2 + Math.sin(i * 1.7) * 0.15;
    const h = playing ? Math.max(baseH, baseH * 0.4 + tLive * 0.7) : baseH;
    bars[i].style.height = (h * 100).toFixed(1) + '%';
    if (i / bars.length < progress) bars[i].classList.add('played');
    else bars[i].classList.remove('played');
  }
  $('#playhead').style.left = (progress * 100) + '%';

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
    $('#player-section').scrollIntoView({ behavior: 'smooth' });
  });

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
    });
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