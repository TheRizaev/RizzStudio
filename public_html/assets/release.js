/* THE RIZAEV — release page.
 * Reads slug from /release/<slug> URL, fetches the release, renders detail page
 * with full tracklist + working player.
 */

import { audioEngine } from './audio-engine.js';
import { rmark, formatTime, $, $$, api } from './ui-helpers.js';

const slug = location.pathname.replace(/^\/release\//, '').replace(/\/$/, '');

(async () => {
  if (!slug) return goHome();
  let release;
  try {
    release = await api(`/api/release/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (err.status === 404) {
      $('#root').innerHTML = `
        <div class="tex-vignette"></div>
        <div style="padding:120px 24px;text-align:center">
          <div class="card-tag">// 404 · NOT FOUND</div>
          <h1 style="font-size:96px;font-weight:900;letter-spacing:-0.04em;margin:16px 0">no <em style="color:var(--acid);font-style:italic">signal</em> here.</h1>
          <p style="opacity:0.7"><a href="/" style="color:var(--acid)">← back to home</a></p>
        </div>
      `;
      return;
    }
    throw err;
  }
  render(release);
})();

function render(r) {
  document.getElementById('page-title').textContent = `${r.title} — RIZZ STUDIO`;
  document.getElementById('page-desc').setAttribute('content', r.description || `${r.title} by THE RIZAEV.`);

  const grad = `linear-gradient(135deg, ${r.accent_color || '#c6ff00'}, ${r.accent_color_2 || '#000'})`;
  const totalDur = (r.tracks || []).reduce((a, t) => a + (t.duration || 0), 0);

  $('#root').innerHTML = `
    <div class="tex-vignette"></div>
    <div class="tex-scan"></div>

    <header class="nav pad-x">
      <a href="/" class="logo">${rmark(56, '#fff', '#c6ff00')}</a>
      <nav class="nav-links">
        <a href="/">HOME</a>
        <a href="/#vault-section">CATALOG</a>
        <a href="mailto:hello@rizaev.studio">CONTACT</a>
      </nav>
    </header>

    <section class="release-page pad-x">
      <a href="/" class="back-link mono">← BACK TO VAULT</a>

      <div class="release-grid">
        <div class="release-cover" style="background:${grad}">
          ${r.cover_url
            ? `<img src="${r.cover_url}" alt="${escapeHTML(r.title)}">`
            : `<div class="cover-fallback">
                 <div class="cover-title">
                   <div>${escapeHTML(r.title.split(' ')[0] || '')}</div>
                   <div style="font-style:italic">${escapeHTML(r.title.split(' ').slice(1).join(' ') || '')}</div>
                 </div>
               </div>`}
          <div class="cover-badge mono">${(r.type || 'SGL').toUpperCase()}</div>
        </div>

        <div class="release-info">
          <div class="release-date mono">RELEASED · ${formatDate(r.released_at)}</div>
          <h1 class="release-page-title">${escapeHTML(r.title)}</h1>
          <div class="release-page-meta mono">
            ${(r.tracks || []).length} TRACKS · ${formatTime(totalDur)}
            ${r.genre ? ` · ${escapeHTML(r.genre.toUpperCase())}` : ''}
            ${r.year ? ` · ${escapeHTML(r.year)}` : ''}
          </div>
          ${r.description ? `<p class="release-page-desc">${escapeHTML(r.description)}</p>` : ''}
          <div class="release-ctas">
            <button class="btn-acid" id="play-all">▶ PLAY ALBUM</button>
          </div>
        </div>
      </div>

      <!-- Player -->
      <section class="player-section release-player">
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
            <button class="transport-btn" data-action="prev">⏮</button>
            <button class="play-btn" id="play-btn">▶</button>
            <button class="transport-btn" data-action="next">⏭</button>
          </div>
        </div>
        <div class="waveform" id="waveform">
          ${'<div class="wave-bar" style="height:20%"></div>'.repeat(96)}
          <div class="playhead" id="playhead"></div>
        </div>
        <div class="time-row mono">
          <span class="acid" id="time-cur">0:00</span>
          <span style="opacity:0.4" id="time-total">${formatTime(totalDur)}</span>
        </div>
        <div class="tracklist" id="tracklist"></div>
      </section>
    </section>

    <footer class="footer pad-x">
      <div class="footer-row mono">
        <span>${rmark(18, '#fff', '#c6ff00')} &nbsp; © 2026 — NEURAL ARTIST</span>
        <span><a href="/">RIZZ.STUDIO</a></span>
      </div>
    </footer>
  `;

  // tracklist
  $('#tracklist').innerHTML = (r.tracks || []).map((t, i) => `
    <button class="track-row" data-idx="${i}">
      <span class="track-num">${t.n || String(i + 1).padStart(2, '0')}</span>
      <span class="eq-bars" style="display:none"><span></span><span></span><span></span><span></span></span>
      <span class="track-body">
        <span class="track-title">${escapeHTML(t.title)}</span>
        <span class="track-meta mono">
          ${t.bpm ? `${t.bpm} BPM · ` : ''}${formatTime(t.duration || 0)}
          · ${(t.plays || 0).toLocaleString()} plays
        </span>
      </span>
      <span class="track-play">▶</span>
    </button>
  `).join('');

  $$('#tracklist .track-row').forEach(row => {
    row.addEventListener('click', () => audioEngine.playIndex(+row.dataset.idx, true));
  });
  $('#play-btn').addEventListener('click', () => audioEngine.toggle());
  $('#play-all').addEventListener('click', () => audioEngine.playIndex(0, true));
  $('[data-action="next"]').addEventListener('click', () => audioEngine.next());
  $('[data-action="prev"]').addEventListener('click', () => audioEngine.prev());
  $('#waveform').addEventListener('click', e => {
    const rect = e.currentTarget.getBoundingClientRect();
    audioEngine.seek((e.clientX - rect.left) / rect.width);
  });

  audioEngine.setQueue((r.tracks || []).map(t => ({ ...t, release_title: r.title })));

  audioEngine.subscribe(state => {
    $('#play-btn').textContent = state.playing ? '❚❚' : '▶';
    $('#np-status-text').textContent = state.playing ? 'NOW PLAYING' : 'PAUSED';
    $('#np-dot').style.animationPlayState = state.playing ? 'running' : 'paused';
    $('#np-title').textContent = state.track?.title || '—';
    $('#np-meta').textContent = state.track
      ? `THE RIZAEV — ${r.title}${state.track.bpm ? ` — ${state.track.bpm} BPM` : ''}`
      : '—';
    $('#time-cur').textContent = formatTime(state.position);
    const total = state.duration || state.track?.duration || 0;
    if (total) $('#time-total').textContent = formatTime(total);

    const bars = $$('#waveform .wave-bar');
    const progress = total > 0 ? state.position / total : 0;
    for (let i = 0; i < bars.length; i++) {
      const tPeak = state.peaks ? state.peaks[Math.floor(i * state.peaks.length / bars.length)] : null;
      const tLive = state.liveLevels ? state.liveLevels[Math.floor(i * state.liveLevels.length / bars.length)] : 0;
      const baseH = tPeak != null ? Math.max(0.1, tPeak * 0.95) : 0.2 + Math.sin(i * 1.7) * 0.15;
      const h = state.playing ? Math.max(baseH, baseH * 0.4 + tLive * 0.7) : baseH;
      bars[i].style.height = (h * 100).toFixed(1) + '%';
      bars[i].classList.toggle('played', i / bars.length < progress);
    }
    $('#playhead').style.left = (progress * 100) + '%';

    $$('#tracklist .track-row').forEach((el, i) => {
      el.classList.toggle('active', i === state.index);
      const eq = el.querySelector('.eq-bars');
      const num = el.querySelector('.track-num');
      if (i === state.index && state.playing) {
        eq.style.display = ''; num.style.display = 'none';
      } else {
        eq.style.display = 'none'; num.style.display = '';
      }
    });
  });
}

function goHome() { location.href = '/'; }

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }).toUpperCase(); }
  catch { return '—'; }
}

// ─── extra styles for release page ───
const css = document.createElement('style');
css.textContent = `
  .release-page { padding-top: 24px; padding-bottom: 80px; }
  .back-link {
    display: inline-block; font-size: 11px; letter-spacing: 0.25em;
    color: var(--acid); margin-bottom: 32px; padding: 8px 0;
  }
  .back-link:hover { text-decoration: underline; }
  .release-grid {
    display: grid; grid-template-columns: 1fr 1.2fr;
    gap: 56px; align-items: center;
    margin-bottom: 80px;
  }
  @media (max-width: 960px) { .release-grid { grid-template-columns: 1fr; gap: 32px; } }
  .release-cover {
    aspect-ratio: 1; position: relative; overflow: hidden;
    border: 1px solid var(--line-strong);
    box-shadow: 0 30px 80px rgba(0,0,0,0.6);
    max-width: 540px;
  }
  .release-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .release-info {}
  .release-page-title {
    font-size: clamp(56px, 8vw, 120px);
    font-weight: 900; letter-spacing: -0.04em;
    line-height: 0.85; margin: 0 0 16px;
  }
  .release-page-meta {
    font-size: 11px; letter-spacing: 0.2em; color: var(--acid); margin-bottom: 24px;
  }
  .release-page-desc {
    font-size: 18px; line-height: 1.5;
    opacity: 0.85; margin: 0 0 32px;
  }
  .release-player {
    border-top: 1px solid var(--line);
    padding: 56px 0 0; background: transparent;
  }
`;
document.head.appendChild(css);
