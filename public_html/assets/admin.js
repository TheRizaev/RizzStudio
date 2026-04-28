/* THE RIZAEV — admin console.
 *
 * Real upload flow:
 *   1. POST /api/admin/login           → session cookie
 *   2. drag mp3 onto dropzone          → POST /api/admin/upload/audio
 *   3. compute peaks via OfflineAudioContext (client-side, fast)
 *      → POST /api/admin/waveform
 *   4. (optional) drag cover image     → POST /api/admin/upload/cover
 *   5. fill metadata, click Publish    → POST /api/admin/release
 *   6. release goes live immediately on / and /release/<slug>
 */

import { api, $, $$, rmark, formatTime, showToast } from './ui-helpers.js';
import { computePeaks } from './audio-engine.js';

const ROOT = $('#root');

/* ───────────── LOGIN (deprecated — kept only because some helpers below
 * may reference its DOM; never invoked now that auth is via secret URL) ───────────── */
function renderLogin() {
  ROOT.innerHTML = `
    <div class="tex-vignette"></div>
    <div class="tex-scan"></div>
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <div class="login-brand">${rmark(48, '#c6ff00', '#fff')}</div>
        <div class="login-title">RIZZ <em>STUDIO</em></div>
        <div class="login-sub mono">// ADMIN ACCESS</div>
        <label class="field-label">PASSWORD</label>
        <input class="field-input" type="password" name="password" autocomplete="current-password" autofocus required>
        <button type="submit" class="btn-acid login-btn">◉ ENTER VAULT</button>
        <div class="login-err" id="login-err"></div>
      </form>
    </div>
  `;
  $('#login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const password = ev.target.password.value;
    const errEl = $('#login-err');
    errEl.textContent = '';
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      renderApp();
    } catch (err) {
      errEl.textContent = err.status === 401
        ? 'Wrong password.'
        : err.status === 503
          ? 'Server not configured. Set ADMIN_PASSWORD_HASH.'
          : 'Login failed.';
    }
  });
}

/* ───────────── APP SHELL ───────────── */
const state = {
  view: 'dashboard',     // dashboard | upload | catalog
  catalog: null,
  // current draft release being uploaded
  draft: emptyDraft(),
  step: 1,
};

function emptyDraft() {
  return {
    id: null, title: '', artist: 'THE RIZAEV', type: 'single',
    year: String(new Date().getFullYear()),
    genre: '', tags: '', description: '',
    explicit: false, isrc: '',
    cover_url: null, cover_filename: null,
    accent_color: '#c6ff00', accent_color_2: '#3b00ff',
    tracks: [],   // { id, title, audio_url, audio_filename, duration, bpm, peaks }
  };
}

async function renderApp() {
  await reloadCatalog();
  paint();
}

async function reloadCatalog() {
  state.catalog = await api('/api/admin/catalog').catch(() => ({ releases: [] }));
}

function paint() {
  ROOT.innerHTML = `
    <div class="tex-vignette"></div>
    <div class="admin-root">
      ${sidebarHTML()}
      <main class="admin-main">
        ${topbarHTML()}
        <div class="admin-body" id="admin-body"></div>
      </main>
    </div>
  `;
  wireSidebar();
  paintBody();
}

function paintBody() {
  const body = $('#admin-body');
  if (state.view === 'dashboard') body.innerHTML = dashboardHTML();
  if (state.view === 'upload')   body.innerHTML = uploadHTML();
  if (state.view === 'catalog')  body.innerHTML = catalogHTML();
  wireBody();
}

/* ───────────── SIDEBAR ───────────── */
function sidebarHTML() {
  const items = [
    { id: 'dashboard', n: '01', label: 'DASHBOARD' },
    { id: 'upload',    n: '02', label: 'NEW DROP' },
    { id: 'catalog',   n: '03', label: 'CATALOG' },
  ];
  return `
    <aside class="admin-sidebar">
      <div class="side-top">
        <div class="brand">
          ${rmark(32, '#c6ff00', '#fff')}
          <div>
            <div class="brand-1">RIZZ <em>STUDIO</em></div>
            <div class="brand-2 mono">// ADMIN CONSOLE</div>
          </div>
        </div>
        <div class="status-bar mono">
          <span class="live-dot"></span>
          <span>SYSTEM ONLINE</span>
        </div>
      </div>
      <nav class="admin-nav">
        ${items.map(it => `
          <button class="nav-item ${state.view === it.id ? 'active' : ''}" data-view="${it.id}">
            <span class="nav-n">${it.n}</span>
            <span style="flex:1">${it.label}</span>
            ${state.view === it.id ? '<span class="acid">●</span>' : ''}
          </button>
        `).join('')}
      </nav>
      <div class="side-bottom">
        <button class="btn-ghost logout-btn" data-action="exit">↩ EXIT</button>
      </div>
    </aside>
  `;
}

function topbarHTML() {
  return `
    <header class="admin-topbar">
      <div class="crumbs mono">
        <span style="opacity:0.45">RIZZ STUDIO</span>
        <span class="acid">/</span>
        <span>${state.view.toUpperCase()}</span>
      </div>
      <div class="top-actions">
        <span class="top-pill mono">BUILD 0420</span>
        <button class="btn-acid" data-view="upload">+ NEW DROP</button>
      </div>
    </header>
  `;
}

function wireSidebar() {
  $$('[data-view]').forEach(el => el.addEventListener('click', () => {
    state.view = el.dataset.view;
    if (state.view === 'upload') state.draft = emptyDraft(), state.step = 1;
    paint();
  }));
  $('[data-action="exit"]').addEventListener('click', () => {
    location.href = '/';
  });
}

/* ───────────── DASHBOARD ───────────── */
function dashboardHTML() {
  const releases = state.catalog?.releases || [];
  const totalPlays = releases.reduce((a, r) => a + (r.plays || 0), 0);
  const totalTracks = releases.reduce((a, r) => a + (r.tracks?.length || 0), 0);
  return `
    <div class="page-head">
      <div>
        <div class="card-tag">// ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}</div>
        <h1 class="h1">welcome <em>back</em>, neural artist.</h1>
        <p class="sub">${releases.length} releases · ${totalTracks} tracks · ${totalPlays.toLocaleString()} plays · 0 humans involved.</p>
      </div>
      <button class="btn-acid big-cta" data-view="upload">DROP A NEW TRACK <span>→</span></button>
    </div>

    <div class="stat-grid">
      ${statCard('TOTAL PLAYS',  totalPlays.toLocaleString(),  'across catalog', true)}
      ${statCard('RELEASES',     releases.length,              `${releases.filter(r => r.status === 'published').length} live · ${releases.filter(r => r.status === 'draft').length} draft`)}
      ${statCard('TRACKS',       totalTracks,                  `${(state.catalog?.releases || []).reduce((a, r) => a + (r.tracks?.length || 0), 0)} tracks total`)}
      ${statCard('NEXT DROP',    'IN 0:00',                    releases.length ? 'queue is empty — drop one' : 'no releases yet', true)}
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-tag">// LATEST DROPS</span>
        <span class="mono" style="opacity:0.5">${releases.length}</span>
      </div>
      ${releases.slice(0, 5).map((r, i) => `
        <div class="drop-row">
          <div class="drop-cover" style="background:linear-gradient(135deg, ${r.accent_color || '#c6ff00'}, ${r.accent_color_2 || '#000'})">
            ${r.cover_url ? `<img src="${r.cover_url}" alt="">` : `<span class="drop-num">${String(i + 1).padStart(2, '0')}</span>`}
          </div>
          <div style="flex:1;min-width:0">
            <div class="drop-title">${escapeHTML(r.title)}</div>
            <div class="drop-meta mono">${(r.type || 'sgl').toUpperCase()} · ${r.year || ''} · ${(r.plays || 0).toLocaleString()} plays</div>
          </div>
          <div class="drop-status ${r.status}">${r.status === 'published' ? '◉ LIVE' : '○ DRAFT'}</div>
          <a class="btn-ghost" href="/release/${escapeHTML(r.slug)}" target="_blank" style="padding:8px 14px">↗</a>
        </div>
      `).join('') || `<div style="padding:24px;opacity:0.5;text-align:center" class="mono">// NO DROPS YET</div>`}
    </div>
  `;
}

function statCard(k, v, d, acid = false) {
  return `
    <div class="stat-card">
      <div class="stat-key mono">${k}</div>
      <div class="stat-val ${acid ? 'acid' : ''}">${v}</div>
      <div class="stat-delta mono">${d}</div>
    </div>
  `;
}

/* ───────────── UPLOAD WIZARD ───────────── */
function uploadHTML() {
  const steps = [
    { n: '01', label: 'AUDIO' },
    { n: '02', label: 'COVER' },
    { n: '03', label: 'METADATA' },
    { n: '04', label: 'PUBLISH' },
  ];
  const stepBody =
    state.step === 1 ? stepAudioHTML() :
    state.step === 2 ? stepCoverHTML() :
    state.step === 3 ? stepMetaHTML() :
    stepPublishHTML();

  return `
    <div class="page-head">
      <div>
        <div class="card-tag">// NEW RELEASE</div>
        <h1 class="h1">drop a <em>track.</em></h1>
        <p class="sub">upload audio, set the cover, fill the metadata, ship it to the vault.</p>
      </div>
    </div>

    <div class="stepper">
      ${steps.map((s, i) => `
        <div class="step-item ${state.step === i + 1 ? 'active' : ''} ${state.step > i + 1 ? 'done' : ''}" data-step="${i + 1}">
          <span class="step-n">${s.n}</span>
          <span>${s.label}</span>
          ${state.step > i + 1 ? '<span style="margin-left:auto" class="acid">✓</span>' : ''}
          ${state.step === i + 1 ? '<span style="margin-left:auto" class="acid live-dot" style="position:static"></span>' : ''}
        </div>
      `).join('')}
    </div>

    ${stepBody}
  `;
}

function stepAudioHTML() {
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 01 · DROP YOUR AUDIO</span>
        <span class="mono" style="opacity:0.5">MP3 / WAV / M4A · MAX 200MB</span>
      </div>
      <div class="dropzone" id="audio-dropzone">
        <input type="file" accept="audio/*" multiple id="audio-input" style="display:none">
        <div class="dz-icon">
          <svg viewBox="0 0 100 50" width="160" height="50">
            ${Array.from({ length: 24 }, (_, i) =>
              `<rect x="${i * 4}" y="${22 - Math.abs(Math.sin(i * 0.5) * 18)}" width="2" height="${Math.abs(Math.sin(i * 0.5) * 36) + 4}" fill="#c6ff00" opacity="0.7"/>`
            ).join('')}
          </svg>
        </div>
        <div class="dz-title">DRAG AUDIO HERE</div>
        <div class="dz-sub mono">or <span class="acid" style="text-decoration:underline">browse files</span></div>
      </div>

      <div id="audio-list" style="margin-top:24px;display:flex;flex-direction:column;gap:8px">
        ${state.draft.tracks.map((t, i) => trackRowHTML(t, i)).join('')}
      </div>

      <div class="step-nav">
        <span class="mono" style="opacity:0.5">${state.draft.tracks.length} FILE${state.draft.tracks.length !== 1 ? 'S' : ''} READY</span>
        <button class="btn-acid" data-next ${state.draft.tracks.length === 0 ? 'disabled' : ''}>CONTINUE → COVER</button>
      </div>
    </div>
  `;
}

function trackRowHTML(t, i) {
  const ready = t.audio_url && t.peaks;
  return `
    <div class="file-row" data-track-idx="${i}">
      <div class="file-ico">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M9 18V5l12-2v13" fill="none" stroke="#c6ff00" stroke-width="2"/>
          <circle cx="6" cy="18" r="3" fill="#c6ff00"/>
          <circle cx="18" cy="16" r="3" fill="#c6ff00"/>
        </svg>
      </div>
      <div style="flex:1;min-width:0">
        <input class="field-input" style="background:transparent;border:none;padding:0;font-size:14px;font-weight:600"
               value="${escapeHTML(t.title || t._localName || 'Untitled')}"
               data-edit="title" data-idx="${i}">
        <div class="file-meta mono">
          ${t._localSize ? `${(t._localSize / 1024 / 1024).toFixed(1)} MB · ` : ''}
          ${t.duration ? formatTime(t.duration) : '—:—'} ·
          <span class="${ready ? 'acid' : ''}">${
            t._error ? `ERROR: ${escapeHTML(t._error)}` :
            !t.audio_url ? `${(t._uploadProgress || 0).toFixed(0)}% UPLOADING` :
            !t.peaks ? 'COMPUTING WAVEFORM…' :
            'READY ✓'
          }</span>
        </div>
        <div class="bar-track" style="margin-top:6px">
          <div class="bar-fill" style="width:${
            t._error ? 0 :
            !t.audio_url ? (t._uploadProgress || 0) :
            !t.peaks ? 75 : 100
          }%"></div>
        </div>
      </div>
      <button class="file-x" data-remove data-idx="${i}">×</button>
    </div>
  `;
}

function stepCoverHTML() {
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 02 · COVER ART</span>
        <span class="mono" style="opacity:0.5">JPG / PNG / WEBP · 3000×3000 RECOMMENDED</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <div class="cover-drop" id="cover-dropzone">
          <input type="file" accept="image/*" id="cover-input" style="display:none">
          ${state.draft.cover_url
            ? `<img src="${state.draft.cover_url}" style="width:100%;height:100%;object-fit:cover">`
            : `<div class="cover-placeholder">
                 <div class="acid mono" style="font-size:12px;letter-spacing:0.3em;margin-top:16px">+ DROP COVER</div>
               </div>`}
        </div>
        <div style="display:flex;flex-direction:column;gap:24px">
          <div>
            <div class="field-label">ACCENT COLOR (used as fallback if no cover)</div>
            <div style="display:flex;gap:12px;flex-wrap:wrap">
              ${['#c6ff00','#ff10a8','#00d9ff','#3b00ff','#ffffff'].map(c =>
                `<button class="color-chip ${state.draft.accent_color === c ? 'active' : ''}" data-color="${c}" style="background:${c}"></button>`
              ).join('')}
            </div>
          </div>
          <div>
            <div class="field-label">SECONDARY COLOR (gradient end)</div>
            <div style="display:flex;gap:12px;flex-wrap:wrap">
              ${['#000000','#3b00ff','#c6ff00','#ff10a8'].map(c =>
                `<button class="color-chip ${state.draft.accent_color_2 === c ? 'active' : ''}" data-color2="${c}" style="background:${c}"></button>`
              ).join('')}
            </div>
          </div>
          <div style="margin-top:16px;padding:16px;border:1px solid var(--line);">
            <div class="field-label">PREVIEW</div>
            <div style="aspect-ratio:1;background:linear-gradient(135deg, ${state.draft.accent_color}, ${state.draft.accent_color_2});display:flex;align-items:flex-end;padding:16px;font-size:32px;font-weight:900;color:#fff;letter-spacing:-0.02em">
              ${escapeHTML(state.draft.title || 'UNTITLED')}
            </div>
          </div>
        </div>
      </div>
      <div class="step-nav">
        <button class="btn-ghost" data-prev>← BACK</button>
        <button class="btn-acid" data-next>CONTINUE → METADATA</button>
      </div>
    </div>
  `;
}

function stepMetaHTML() {
  const d = state.draft;
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 03 · METADATA</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        ${field('TITLE', `<input class="field-input" data-meta="title" value="${escapeHTML(d.title)}" placeholder="e.g. NEURAL DECAY">`, true)}
        ${field('ARTIST', `<input class="field-input" data-meta="artist" value="${escapeHTML(d.artist)}">`)}
        ${field('GENRE / VIBE', `<input class="field-input" data-meta="genre" value="${escapeHTML(d.genre)}" placeholder="hyperpop, ambient, glitch…">`)}
        ${field('YEAR', `<input class="field-input" data-meta="year" value="${escapeHTML(d.year)}">`)}
        ${field('ISRC (optional)', `<input class="field-input" data-meta="isrc" value="${escapeHTML(d.isrc)}" placeholder="USRZ12600001">`)}
        ${field('RELEASE TYPE', `
          <div style="display:flex;gap:8px">
            ${[['single','SINGLE'],['ep','EP'],['lp','ALBUM']].map(([v, l]) =>
              `<button class="chip ${d.type === v ? 'active' : ''}" data-type="${v}">${l}</button>`
            ).join('')}
          </div>
        `)}
        ${field('TAGS', `<input class="field-input" data-meta="tags" value="${escapeHTML(d.tags)}" placeholder="ai, neural, hyperpop">`, true)}
        ${field('DESCRIPTION', `<textarea class="field-textarea" data-meta="description" placeholder="A brief story about the release…">${escapeHTML(d.description)}</textarea>`, true)}
        ${field('EXPLICIT', `
          <label style="display:inline-flex;align-items:center;gap:12px;cursor:pointer">
            <input type="checkbox" data-meta="explicit" ${d.explicit ? 'checked' : ''}>
            <span class="mono" style="font-size:12px">${d.explicit ? 'YES — CONTAINS EXPLICIT CONTENT' : 'NO — CLEAN VERSION'}</span>
          </label>
        `, true)}
      </div>
      <div class="step-nav">
        <button class="btn-ghost" data-prev>← BACK</button>
        <button class="btn-acid" data-next>CONTINUE → PUBLISH</button>
      </div>
    </div>
  `;
}

function field(label, inner, full) {
  return `<div style="${full ? 'grid-column:span 2' : ''}">
    <div class="field-label">${label}</div>
    ${inner}
  </div>`;
}

function stepPublishHTML() {
  const d = state.draft;
  const ready = d.title && d.tracks.length && d.tracks.every(t => t.audio_url && t.peaks);
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 04 · REVIEW & PUBLISH</span>
      </div>
      <div style="display:grid;grid-template-columns:300px 1fr;gap:32px">
        <div class="preview-cover" style="background:linear-gradient(135deg, ${d.accent_color}, ${d.accent_color_2})">
          ${d.cover_url ? `<img src="${d.cover_url}" style="width:100%;height:100%;object-fit:cover">` : ''}
          <div class="preview-badge mono">${d.type.toUpperCase()}</div>
        </div>
        <div>
          <div class="field-label">TRACK</div>
          <div style="font-size:36px;font-weight:800;letter-spacing:-0.03em;margin-top:4px">${escapeHTML(d.title || 'UNTITLED')}</div>
          <div class="mono" style="font-size:13px;letter-spacing:0.2em;opacity:0.7;margin:6px 0 24px">
            ${escapeHTML(d.artist)} · ${d.year} · ${d.tracks.length} TRACK${d.tracks.length !== 1 ? 'S' : ''}
          </div>
          <div class="summary-grid">
            ${summaryRow('GENRE', d.genre || '—')}
            ${summaryRow('TYPE', d.type.toUpperCase())}
            ${summaryRow('TRACKS', d.tracks.length)}
            ${summaryRow('TOTAL', formatTime(d.tracks.reduce((a, t) => a + (t.duration || 0), 0)))}
            ${summaryRow('EXPLICIT', d.explicit ? 'YES' : 'NO')}
            ${summaryRow('STATUS', ready ? 'READY' : 'INCOMPLETE')}
          </div>
        </div>
      </div>
      <div class="step-nav">
        <button class="btn-ghost" data-prev>← BACK</button>
        <button class="btn-acid" data-publish ${!ready ? 'disabled' : ''}>◉ PUBLISH TO VAULT</button>
      </div>
    </div>
  `;
}

function summaryRow(label, value) {
  return `<div class="summary-row">
    <span class="mono" style="opacity:0.5;font-size:10px;letter-spacing:0.2em">${label}</span>
    <span style="font-weight:600;margin-top:4px;display:block">${escapeHTML(value)}</span>
  </div>`;
}

/* ───────────── CATALOG ───────────── */
function catalogHTML() {
  const releases = state.catalog?.releases || [];
  return `
    <div class="page-head">
      <div>
        <div class="card-tag">// CATALOG</div>
        <h1 class="h1">the <em>vault.</em></h1>
        <p class="sub">${releases.length} releases · ${releases.filter(r => r.status === 'published').length} live · ${releases.filter(r => r.status === 'draft').length} draft.</p>
      </div>
    </div>
    <div class="catalog-table">
      <div class="catalog-header mono">
        <span>#</span><span>RELEASE</span><span>TYPE</span><span>YEAR</span>
        <span>TRACKS</span><span>PLAYS</span><span>STATUS</span><span style="text-align:right">ACTIONS</span>
      </div>
      ${releases.map((r, i) => `
        <div class="catalog-row">
          <span class="mono" style="opacity:0.5">${String(i + 1).padStart(2, '0')}</span>
          <div style="display:flex;align-items:center;gap:14px">
            <div class="cat-cover" style="background:linear-gradient(135deg, ${r.accent_color || '#c6ff00'}, ${r.accent_color_2 || '#000'})">
              ${r.cover_url ? `<img src="${r.cover_url}" alt="">` : ''}
            </div>
            <div>
              <div style="font-size:16px;font-weight:700">${escapeHTML(r.title)}</div>
              <div class="mono" style="font-size:10px;letter-spacing:0.2em;opacity:0.5">/release/${escapeHTML(r.slug)}</div>
            </div>
          </div>
          <span class="mono" style="font-size:11px;letter-spacing:0.2em">${(r.type || 'sgl').toUpperCase()}</span>
          <span class="mono" style="font-size:11px">${escapeHTML(r.year || '')}</span>
          <span class="mono" style="font-size:11px">${(r.tracks || []).length}</span>
          <span class="mono acid" style="font-size:12px">${(r.plays || 0).toLocaleString()}</span>
          <span class="mono ${r.status}" style="font-size:10px;letter-spacing:0.2em;color:${r.status === 'published' ? 'var(--acid)' : 'var(--magenta)'}">
            ${r.status === 'published' ? '◉ LIVE' : '○ DRAFT'}
          </span>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <a class="icon-btn" href="/release/${escapeHTML(r.slug)}" target="_blank" title="Open">↗</a>
            <button class="icon-btn" data-delete-release="${r.id}" title="Delete">×</button>
          </div>
        </div>
      `).join('') || `<div style="padding:48px;text-align:center;opacity:0.5" class="mono">// VAULT IS EMPTY</div>`}
    </div>
  `;
}

/* ───────────── BODY EVENTS ───────────── */
function wireBody() {
  // step navigation
  $$('[data-step]').forEach(el => el.addEventListener('click', () => {
    state.step = +el.dataset.step;
    paintBody();
  }));
  $('[data-prev]')?.addEventListener('click', () => { state.step--; paintBody(); });
  $('[data-next]')?.addEventListener('click', () => {
    if (state.step === 1 && !state.draft.tracks.every(t => t.audio_url && t.peaks)) {
      showToast('Some uploads still in progress', 'err'); return;
    }
    if (state.step === 3 && !state.draft.title.trim()) {
      showToast('Title is required', 'err'); return;
    }
    state.step++;
    paintBody();
  });

  // ─── audio dropzone ───
  const dz = $('#audio-dropzone');
  if (dz) {
    const input = $('#audio-input');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      handleAudioFiles(e.dataTransfer.files);
    });
    input.addEventListener('change', () => handleAudioFiles(input.files));

    $$('[data-edit="title"]').forEach(inp => inp.addEventListener('change', () => {
      const i = +inp.dataset.idx;
      state.draft.tracks[i].title = inp.value;
    }));
    $$('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
      state.draft.tracks.splice(+btn.dataset.idx, 1);
      paintBody();
    }));
  }

  // ─── cover dropzone ───
  const cdz = $('#cover-dropzone');
  if (cdz) {
    const input = $('#cover-input');
    cdz.addEventListener('click', () => input.click());
    cdz.addEventListener('dragover', e => { e.preventDefault(); cdz.classList.add('drag-over'); });
    cdz.addEventListener('dragleave', () => cdz.classList.remove('drag-over'));
    cdz.addEventListener('drop', e => {
      e.preventDefault(); cdz.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) handleCoverFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => input.files[0] && handleCoverFile(input.files[0]));
    $$('[data-color]').forEach(b => b.addEventListener('click', () => {
      state.draft.accent_color = b.dataset.color; paintBody();
    }));
    $$('[data-color2]').forEach(b => b.addEventListener('click', () => {
      state.draft.accent_color_2 = b.dataset.color2; paintBody();
    }));
  }

  // ─── meta ───
  $$('[data-meta]').forEach(el => {
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      state.draft[el.dataset.meta] = el.type === 'checkbox' ? el.checked : el.value;
    });
  });
  $$('[data-type]').forEach(b => b.addEventListener('click', () => {
    state.draft.type = b.dataset.type;
    paintBody();
  }));

  // ─── publish ───
  $('[data-publish]')?.addEventListener('click', publish);

  // ─── catalog actions ───
  $$('[data-delete-release]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.deleteRelease;
    if (!confirm('Delete this release? This cannot be undone.')) return;
    try {
      await api(`/api/admin/release/${id}`, { method: 'DELETE' });
      showToast('Release deleted');
      await reloadCatalog();
      paintBody();
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'err');
    }
  }));
}

/* ───────────── UPLOAD HANDLERS ───────────── */
async function handleAudioFiles(filelist) {
  const files = Array.from(filelist || []);
  for (const file of files) {
    const draft = {
      id: null,
      title: file.name.replace(/\.[^.]+$/, ''),
      _localName: file.name,
      _localSize: file.size,
      _uploadProgress: 0,
      audio_url: null,
      audio_filename: null,
      duration: 0,
      bpm: null,
      peaks: null,
    };
    state.draft.tracks.push(draft);
    paintBody();

    // 1) upload
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = await uploadWithProgress('/api/admin/upload/audio', fd, p => {
        draft._uploadProgress = p; updateTrackRow(draft);
      });
      draft.audio_url = result.url;
      draft.audio_filename = result.filename;
      draft._uploadProgress = 100;
      updateTrackRow(draft);

      // 2) compute peaks (client-side)
      const { peaks, duration } = await computePeaks(file, 256);
      draft.peaks = peaks;
      draft.duration = duration;
      updateTrackRow(draft);

      // 3) save peaks to server
      await api('/api/admin/waveform', {
        method: 'POST',
        body: JSON.stringify({ audio_filename: draft.audio_filename, peaks, duration }),
      });
      draft.waveform_url = `/media/waveforms/${draft.audio_filename.replace(/\.[^.]+$/, '')}.json`;
      updateTrackRow(draft);
    } catch (err) {
      console.error(err);
      draft._error = err.message || 'upload failed';
      updateTrackRow(draft);
      showToast(`Upload failed: ${file.name}`, 'err');
    }
  }
  paintBody();
}

function updateTrackRow(track) {
  const i = state.draft.tracks.indexOf(track);
  if (i < 0) return;
  const row = $(`[data-track-idx="${i}"]`);
  if (!row) return;
  row.outerHTML = trackRowHTML(track, i);
}

function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      try {
        const j = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(j);
        else reject(new Error(j.error || `HTTP ${xhr.status}`));
      } catch { reject(new Error(`HTTP ${xhr.status}`)); }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(formData);
  });
}

async function handleCoverFile(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const result = await uploadWithProgress('/api/admin/upload/cover', fd);
    state.draft.cover_url = result.url;
    state.draft.cover_filename = result.filename;
    paintBody();
    showToast('Cover uploaded');
  } catch (e) {
    showToast('Cover upload failed: ' + e.message, 'err');
  }
}

async function publish() {
  const d = state.draft;
  const payload = {
    title: d.title,
    artist: d.artist,
    type: d.type,
    year: d.year,
    genre: d.genre,
    tags: d.tags ? d.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
    description: d.description,
    explicit: d.explicit,
    isrc: d.isrc,
    cover_url: d.cover_url,
    cover_filename: d.cover_filename,
    accent_color: d.accent_color,
    accent_color_2: d.accent_color_2,
    status: 'published',
    tracks: d.tracks.map(t => ({
      title: t.title,
      audio_url: t.audio_url,
      audio_filename: t.audio_filename,
      waveform_url: t.waveform_url,
      duration: t.duration,
      bpm: t.bpm,
    })),
  };
  try {
    const result = await api('/api/admin/release', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(`✓ "${result.release.title}" is live at /release/${result.release.slug}`);
    state.draft = emptyDraft();
    state.step = 1;
    state.view = 'catalog';
    await reloadCatalog();
    paint();
  } catch (e) {
    showToast('Publish failed: ' + e.message, 'err');
  }
}

/* ─── helpers ─── */
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ─── boot ───
// Placed at the bottom so every const/let above (state, ROOT, helpers) is
// fully initialized before renderApp runs. Auth is gated by the secret URL
// slug — if you can load this script, you're in.
(async () => {
  await renderApp();
})();