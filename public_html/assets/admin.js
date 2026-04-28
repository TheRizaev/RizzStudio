/* THE RIZAEV — admin console.
 *
 * Features:
 *  - Wizard for new releases (audio → cover → metadata → publish)
 *  - Editing existing releases (track replace, drag-reorder, BPM, plays preserved)
 *  - RGB color picker (native + hex + presets)
 *  - Catalog with quick toggle / duplicate / delete / edit / bulk ops / search / filters
 *  - Dashboard analytics: plays-per-day chart + top tracks
 *  - Inline ▶ play for every track row in the wizard
 *  - Auto-save wizard draft to localStorage (survives accidental tab close)
 *  - Global drop-zone: drop an mp3 anywhere → wizard opens with file uploaded
 *  - Schedule release: published_at in the future → hidden from public catalog
 */

import { api, $, $$, rmark, formatTime, showToast } from './ui-helpers.js';
import { computePeaks } from './audio-engine.js';

const ROOT = $('#root');
const DRAFT_STORAGE_KEY = 'rizz.adminDraft.v1';

/* ───────────── STATE ───────────── */
const state = {
  view: 'dashboard',    // dashboard | upload | catalog
  catalog: null,
  analytics: null,
  draft: emptyDraft(),
  step: 1,
  editing: false,
  // Catalog selection / filtering
  catalogSelected: new Set(),
  catalogFilter: { q: '', status: 'all', type: 'all' },
};

function emptyDraft() {
  return {
    id: null, title: '', artist: 'THE RIZAEV', type: 'single',
    year: String(new Date().getFullYear()),
    released_at: null,
    genre: '', tags: '', description: '',
    explicit: false, isrc: '',
    cover_url: null, cover_filename: null,
    accent_color: '#c6ff00', accent_color_2: '#3b00ff',
    status: 'published',
    tracks: [],
  };
}

function draftFromRelease(release) {
  return {
    id: release.id,
    title: release.title || '',
    artist: release.artist || 'THE RIZAEV',
    type: release.type || 'single',
    year: release.year || String(new Date().getFullYear()),
    released_at: release.released_at || null,
    genre: release.genre || '',
    tags: Array.isArray(release.tags) ? release.tags.join(', ') : (release.tags || ''),
    description: release.description || '',
    explicit: !!release.explicit,
    isrc: release.isrc || '',
    cover_url: release.cover_url || null,
    cover_filename: release.cover_filename || null,
    accent_color: release.accent_color || '#c6ff00',
    accent_color_2: release.accent_color_2 || '#3b00ff',
    status: release.status || 'published',
    tracks: (release.tracks || []).map(t => ({
      id: t.id,
      title: t.title || '',
      audio_url: t.audio_url,
      audio_filename: t.audio_filename,
      waveform_url: t.waveform_url,
      duration: t.duration || 0,
      bpm: t.bpm || null,
      plays: t.plays || 0,
      peaks: t.waveform_url ? true : null,
      _existing: true,
    })),
  };
}

/* ───────────── AUTO-SAVE (localStorage) ─────────────
 * On every meaningful state change we serialise the wizard draft so a tab
 * close, refresh, or crash doesn't lose progress. We never store binary —
 * only metadata + URLs of files already uploaded to the server (which are
 * persistent on disk regardless of admin session). */
function persistDraft() {
  try {
    if (state.view !== 'upload') return;
    // Tracks: strip transient upload-progress markers but keep the upload-result
    // fields (audio_url, peaks etc.) so a restored draft is publishable.
    const cleanTracks = state.draft.tracks.map(t => {
      const { _uploadProgress, _localSize, _localName, _error, _replaced, ...rest } = t;
      return rest;
    });
    const payload = {
      draft: { ...state.draft, tracks: cleanTracks },
      step: state.step,
      editing: state.editing,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // Quota / private mode etc. — silently degrade.
    console.warn('[admin] draft persist failed', e);
  }
}

function clearPersistedDraft() {
  try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch {}
}

function readPersistedDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Reject anything older than 14 days as stale.
    const age = (Date.now() - new Date(parsed.savedAt).getTime()) / 86400000;
    if (age > 14) return null;
    return parsed;
  } catch { return null; }
}

function maybeRestoreDraft() {
  const saved = readPersistedDraft();
  if (!saved || !saved.draft) return;
  // If the draft has nothing in it (no title, no tracks, no cover), don't even ask.
  const d = saved.draft;
  const isEmpty = !d.title?.trim() && !d.tracks?.length && !d.cover_url;
  if (isEmpty) return;

  const when = new Date(saved.savedAt).toLocaleString();
  const summary = `${d.title || '(no title)'} · ${(d.tracks || []).length} track(s)`;
  if (confirm(`Restore unsaved draft from ${when}?\n\n${summary}\n\nClick Cancel to discard.`)) {
    state.draft = { ...emptyDraft(), ...d };
    state.step = saved.step || 1;
    state.editing = !!saved.editing;
    state.view = 'upload';
  } else {
    clearPersistedDraft();
  }
}

/* ───────────── BOOT ───────────── */
async function renderApp() {
  await reloadCatalog();
  // Try to restore an unsaved wizard draft BEFORE the first paint —
  // saves a flicker of the dashboard.
  maybeRestoreDraft();
  paint();
  installGlobalDropHandler();
  // Analytics is async; don't block first paint.
  loadAnalytics();
}

async function reloadCatalog() {
  state.catalog = await api('/api/admin/catalog').catch(() => ({ releases: [] }));
}

async function loadAnalytics() {
  try {
    state.analytics = await api('/api/admin/analytics?days=30&top=10');
    // If we're on the dashboard, refresh just the analytics block.
    if (state.view === 'dashboard') paintBody();
  } catch (e) {
    console.warn('[admin] analytics load failed', e);
  }
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
    <div id="global-drop-overlay" class="global-drop-overlay" style="display:none">
      <div class="gdo-card">
        <div class="gdo-icon">↓</div>
        <div class="gdo-title">drop audio to start a <em>new release</em></div>
        <div class="gdo-sub mono">// MP3 / WAV / M4A · MULTIPLE FILES OK</div>
      </div>
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
  // Persist after every render that could've changed the draft.
  persistDraft();
}

function startNewDraft(prefilledFiles) {
  state.draft = emptyDraft();
  state.step = 1;
  state.editing = false;
  state.view = 'upload';
  clearPersistedDraft();
  paint();
  if (prefilledFiles && prefilledFiles.length) {
    handleAudioFiles(prefilledFiles);
  }
}

async function startEditDraft(releaseId) {
  try {
    const release = await api(`/api/admin/release/${encodeURIComponent(releaseId)}`);
    state.draft = draftFromRelease(release);
    state.step = 1;
    state.editing = true;
    state.view = 'upload';
    clearPersistedDraft();
    paint();
  } catch (err) {
    showToast('Failed to load release: ' + (err.message || err), 'err');
  }
}

/* ───────────── SIDEBAR / TOPBAR ───────────── */
function sidebarHTML() {
  const items = [
    { id: 'dashboard', n: '01', label: 'DASHBOARD' },
    { id: 'upload',    n: '02', label: state.editing ? 'EDIT DROP' : 'NEW DROP' },
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
  const label = state.view === 'upload'
    ? (state.editing ? 'EDIT RELEASE' : 'NEW RELEASE')
    : state.view.toUpperCase();
  return `
    <header class="admin-topbar">
      <div class="crumbs mono">
        <span style="opacity:0.45">RIZZ STUDIO</span>
        <span class="acid">/</span>
        <span>${label}</span>
      </div>
      <div class="top-actions">
        <span class="top-pill mono">BUILD 0420</span>
        <button class="btn-acid" data-action="new-drop">+ NEW DROP</button>
      </div>
    </header>
  `;
}

function wireSidebar() {
  $$('[data-view]').forEach(el => el.addEventListener('click', () => {
    const target = el.dataset.view;
    if (target === 'upload') { startNewDraft(); return; }
    state.view = target;
    paint();
  }));
  $('[data-action="exit"]').addEventListener('click', () => { location.href = '/'; });
  $('[data-action="new-drop"]')?.addEventListener('click', () => startNewDraft());
}

/* ───────────── DASHBOARD ───────────── */
function dashboardHTML() {
  const releases = state.catalog?.releases || [];
  const totalPlays = releases.reduce((a, r) => a + (r.plays || 0), 0);
  const totalTracks = releases.reduce((a, r) => a + (r.tracks?.length || 0), 0);
  const scheduled = releases.filter(r => r.status === 'published' && isFuture(r.released_at)).length;
  return `
    <div class="page-head">
      <div>
        <div class="card-tag">// ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}</div>
        <h1 class="h1">welcome <em>back</em>, neural artist.</h1>
        <p class="sub">${releases.length} releases · ${totalTracks} tracks · ${totalPlays.toLocaleString()} plays · 0 humans involved.</p>
      </div>
      <button class="btn-acid big-cta" data-action="new-drop">DROP A NEW TRACK <span>→</span></button>
    </div>

    <div class="stat-grid">
      ${statCard('TOTAL PLAYS',  totalPlays.toLocaleString(),  'across catalog', true)}
      ${statCard('RELEASES',     releases.length,              `${releases.filter(r => r.status === 'published' && !isFuture(r.released_at)).length} live · ${releases.filter(r => r.status === 'draft').length} draft · ${scheduled} scheduled`)}
      ${statCard('TRACKS',       totalTracks,                  `${totalTracks} tracks total`)}
      ${statCard('30-DAY PLAYS', state.analytics ? state.analytics.totals.in_window.toLocaleString() : '—', 'last 30 days · log only', true)}
    </div>

    <div class="dash-grid">
      <div class="card dash-chart-card">
        <div class="card-head">
          <span class="card-tag">// PLAYS · LAST 30 DAYS</span>
          <span class="mono" style="opacity:0.5">${state.analytics ? state.analytics.totals.in_window.toLocaleString() + ' total' : 'loading…'}</span>
        </div>
        ${state.analytics ? renderPlayChart(state.analytics.per_day) : '<div style="height:180px;display:flex;align-items:center;justify-content:center;opacity:0.5" class="mono">// LOADING DATA</div>'}
      </div>

      <div class="card dash-top-card">
        <div class="card-head">
          <span class="card-tag">// TOP TRACKS</span>
          <span class="mono" style="opacity:0.5">all-time</span>
        </div>
        ${state.analytics ? renderTopTracks(state.analytics.top) : '<div style="padding:24px;opacity:0.5;text-align:center" class="mono">// LOADING</div>'}
      </div>
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
          <div class="drop-status ${releaseStatusClass(r)}">${releaseStatusLabel(r)}</div>
          <button class="btn-ghost" data-edit-release="${r.id}" style="padding:8px 14px">EDIT</button>
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

/* SVG bar chart for plays-per-day. Hand-rolled (no chart library) so it
 * stays in the brand voice: monospace tick labels + acid bars + scan-line
 * vibe. The chart is responsive via viewBox + preserveAspectRatio. */
function renderPlayChart(series) {
  if (!series.length) return '<div style="opacity:0.5;text-align:center;padding:24px" class="mono">// NO DATA</div>';
  const max = Math.max(1, ...series.map(d => d.plays));
  const W = 600, H = 180, pad = 24;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;
  const barGap = 2;
  const barW = (innerW - (series.length - 1) * barGap) / series.length;

  const bars = series.map((d, i) => {
    const x = pad + i * (barW + barGap);
    const h = (d.plays / max) * innerH;
    const y = H - pad - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barW).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}"
      fill="#c6ff00" opacity="${d.plays > 0 ? 0.85 : 0.15}">
      <title>${d.date} · ${d.plays} plays</title>
    </rect>`;
  }).join('');

  // X-axis labels: only first, middle, last day to stay readable.
  const ticks = [series[0], series[Math.floor(series.length / 2)], series[series.length - 1]];
  const labels = ticks.map((t, i) => {
    const idx = i === 0 ? 0 : i === 1 ? Math.floor(series.length / 2) : series.length - 1;
    const x = pad + idx * (barW + barGap) + barW / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 4}" fill="#666" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">${t.date.slice(5)}</text>`;
  }).join('');

  // Y-axis max label
  const maxLabel = `<text x="${pad - 4}" y="${pad + 4}" fill="#666" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="end">${max}</text>`;

  return `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="dash-chart">
        <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#222" stroke-width="1"/>
        ${bars}
        ${labels}
        ${maxLabel}
      </svg>
    </div>
  `;
}

function renderTopTracks(top) {
  if (!top || !top.length) {
    return '<div style="padding:24px;opacity:0.5;text-align:center" class="mono">// NO PLAYS YET</div>';
  }
  const max = Math.max(1, ...top.map(t => t.plays_total));
  return `
    <div class="top-list">
      ${top.map((t, i) => `
        <div class="top-row">
          <span class="top-rank mono">${String(i + 1).padStart(2, '0')}</span>
          <div class="top-cover" style="background:linear-gradient(135deg, ${t.accent_color || '#c6ff00'}, ${t.accent_color_2 || '#000'})">
            ${t.cover_url ? `<img src="${t.cover_url}" alt="">` : ''}
          </div>
          <div class="top-meta">
            <div class="top-title">${escapeHTML(t.title)}</div>
            <div class="top-sub mono">${escapeHTML(t.release_title)}</div>
          </div>
          <div class="top-bar-wrap">
            <div class="top-bar" style="width:${(t.plays_total / max * 100).toFixed(1)}%"></div>
          </div>
          <div class="top-plays mono acid">${t.plays_total.toLocaleString()}</div>
        </div>
      `).join('')}
    </div>
  `;
}

/* ───────────── UPLOAD WIZARD ───────────── */
function uploadHTML() {
  const steps = [
    { n: '01', label: 'AUDIO' },
    { n: '02', label: 'COVER' },
    { n: '03', label: 'METADATA' },
    { n: '04', label: state.editing ? 'SAVE' : 'PUBLISH' },
  ];
  const stepBody =
    state.step === 1 ? stepAudioHTML() :
    state.step === 2 ? stepCoverHTML() :
    state.step === 3 ? stepMetaHTML() :
    stepPublishHTML();

  const titleVerb = state.editing ? 'edit' : 'drop';
  const titleObj = state.editing
    ? `"${escapeHTML(state.draft.title || 'untitled')}"`
    : 'a <em>track.</em>';
  const subText = state.editing
    ? 'replace audio, swap the cover, adjust the metadata, save.'
    : 'upload audio, set the cover, fill the metadata, ship it to the vault.';

  return `
    <div class="page-head">
      <div>
        <div class="card-tag">// ${state.editing ? 'EDITING RELEASE' : 'NEW RELEASE'}</div>
        <h1 class="h1">${titleVerb} ${titleObj}</h1>
        <p class="sub">${subText}</p>
      </div>
      ${state.editing ? `
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          <span class="mono" style="font-size:10px;letter-spacing:0.2em;opacity:0.5">RELEASE ID</span>
          <span class="mono acid" style="font-size:11px;letter-spacing:0.15em">${escapeHTML(state.draft.id)}</span>
        </div>
      ` : ''}
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

    <div class="autosave-note mono">
      <span class="acid">●</span> draft autosaved locally · safe to close tab
    </div>
  `;
}

function stepAudioHTML() {
  const hasTracks = state.draft.tracks.length > 0;
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 01 · ${state.editing ? 'TRACKS' : 'DROP YOUR AUDIO'}</span>
        <span class="mono" style="opacity:0.5">MP3 / WAV / M4A · MAX 200MB</span>
      </div>
      <div class="dropzone ${hasTracks ? 'dropzone-compact' : ''}" id="audio-dropzone">
        <input type="file" accept="audio/*" multiple id="audio-input" style="display:none">
        <div class="dz-icon">
          <svg viewBox="0 0 100 50" width="${hasTracks ? 100 : 160}" height="${hasTracks ? 32 : 50}">
            ${Array.from({ length: 24 }, (_, i) =>
              `<rect x="${i * 4}" y="${22 - Math.abs(Math.sin(i * 0.5) * 18)}" width="2" height="${Math.abs(Math.sin(i * 0.5) * 36) + 4}" fill="#c6ff00" opacity="0.7"/>`
            ).join('')}
          </svg>
        </div>
        <div class="dz-title">${hasTracks ? 'ADD MORE TRACKS' : 'DRAG AUDIO HERE'}</div>
        <div class="dz-sub mono">or <span class="acid" style="text-decoration:underline">browse files</span></div>
      </div>

      <div id="audio-list" style="margin-top:24px;display:flex;flex-direction:column;gap:8px">
        ${state.draft.tracks.map((t, i) => trackRowHTML(t, i)).join('')}
      </div>

      <div class="step-nav">
        <span class="mono" style="opacity:0.5">${state.draft.tracks.length} TRACK${state.draft.tracks.length !== 1 ? 'S' : ''} · DRAG ⋮ TO REORDER</span>
        <button class="btn-acid" data-next ${state.draft.tracks.length === 0 ? 'disabled' : ''}>CONTINUE → COVER</button>
      </div>
    </div>
  `;
}

function trackRowHTML(t, i) {
  const ready = t.audio_url && t.peaks;
  const isExisting = !!t._existing;
  const status =
    t._error ? `ERROR: ${escapeHTML(t._error)}` :
    !t.audio_url ? `${(t._uploadProgress || 0).toFixed(0)}% UPLOADING` :
    !t.peaks ? 'COMPUTING WAVEFORM…' :
    isExisting ? (t._replaced ? '✓ REPLACED' : `READY · ${(t.plays || 0).toLocaleString()} PLAYS`) : 'READY ✓';
  const progressPct =
    t._error ? 0 :
    !t.audio_url ? (t._uploadProgress || 0) :
    !t.peaks ? 75 : 100;

  const playable = !!t.audio_url;

  return `
    <div class="file-row" data-track-idx="${i}" draggable="true">
      <div class="file-handle mono" title="Drag to reorder">⋮⋮</div>
      <button draggable="false" class="file-play ${playable ? '' : 'disabled'}"
              data-play-track data-idx="${i}" title="${playable ? 'Preview audio' : 'Upload first'}">▶</button>
      <div style="flex:1;min-width:0">
        <input draggable="false" class="field-input track-title-input"
               value="${escapeHTML(t.title || t._localName || 'Untitled')}"
               data-edit="title" data-idx="${i}" placeholder="Track title">
        <div class="track-row-meta">
          <input draggable="false" class="field-input track-bpm-input"
                 type="number" min="0" max="300" placeholder="BPM"
                 value="${t.bpm || ''}" data-edit="bpm" data-idx="${i}">
          <span class="file-meta mono">
            ${t._localSize ? `${(t._localSize / 1024 / 1024).toFixed(1)} MB · ` : ''}
            ${t.duration ? formatTime(t.duration) : '—:—'} ·
            <span class="${ready ? 'acid' : ''}">${status}</span>
          </span>
        </div>
        <div class="bar-track" style="margin-top:6px">
          <div class="bar-fill" style="width:${progressPct}%"></div>
        </div>
      </div>
      <input type="file" accept="audio/*" id="replace-input-${i}" style="display:none" data-replace-idx="${i}">
      <button draggable="false" class="file-replace mono" data-replace data-idx="${i}" title="Replace audio file">↻ REPLACE</button>
      <button draggable="false" class="file-x" data-remove data-idx="${i}" title="Remove track">×</button>
    </div>
  `;
}

function colorPickerBlock(label, currentValue, dataKey, presets) {
  const safe = currentValue || '#000000';
  return `
    <div class="color-block">
      <div class="field-label">${label}</div>
      <div class="color-controls">
        <label class="color-swatch" style="background:${safe}">
          <input type="color" value="${safe}" data-${dataKey}-rgb>
        </label>
        <input class="field-input color-hex"
               type="text" maxlength="7" spellcheck="false"
               value="${safe.toUpperCase()}" data-${dataKey}-hex
               placeholder="#RRGGBB">
      </div>
      <div class="color-presets">
        ${presets.map(c => `
          <button type="button" class="color-chip ${currentValue?.toLowerCase() === c.toLowerCase() ? 'active' : ''}"
                  data-${dataKey}="${c}" style="background:${c}" title="${c}"></button>
        `).join('')}
      </div>
    </div>
  `;
}

function stepCoverHTML() {
  const d = state.draft;
  const presetA = ['#c6ff00','#ff10a8','#00d9ff','#3b00ff','#ffffff','#ff6b00','#00ff85','#ffd000'];
  const presetB = ['#000000','#3b00ff','#c6ff00','#ff10a8','#1a1a1a','#0066ff','#001a4d','#1a0033'];
  const grad = `linear-gradient(135deg, ${d.accent_color}, ${d.accent_color_2})`;
  const titleSafe = escapeHTML(d.title || 'UNTITLED');
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 02 · COVER ART</span>
        <span class="mono" style="opacity:0.5">JPG / PNG / WEBP · 3000×3000 RECOMMENDED</span>
      </div>
      <div class="cover-grid">
        <div>
          <div class="cover-drop" id="cover-dropzone">
            <input type="file" accept="image/*" id="cover-input" style="display:none">
            ${d.cover_url
              ? `<img src="${d.cover_url}" style="width:100%;height:100%;object-fit:cover">`
              : `<div class="cover-placeholder">
                   <div class="acid mono" style="font-size:12px;letter-spacing:0.3em;margin-top:16px">+ DROP COVER</div>
                 </div>`}
          </div>
          ${d.cover_url ? `
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn-ghost" data-cover-replace style="flex:1;padding:10px">↻ REPLACE COVER</button>
              <button class="btn-ghost" data-cover-clear style="padding:10px 14px">×</button>
            </div>
          ` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:24px">
          ${colorPickerBlock('ACCENT COLOR (primary)', d.accent_color, 'color', presetA)}
          ${colorPickerBlock('SECONDARY COLOR (gradient end)', d.accent_color_2, 'color2', presetB)}
        </div>
      </div>

      <!-- Real-context preview: the same gradient/cover composed inside
           mockups of how it'll appear on the live site. Helps catch
           low-contrast color combos before publishing. -->
      <div class="mockup-grid">
        <div class="mockup mockup-vault">
          <div class="mockup-tag mono">// HOMEPAGE VAULT CARD</div>
          <div class="mockup-vault-card" style="background:${grad}">
            ${d.cover_url ? `<img src="${d.cover_url}" alt="">` : ''}
            <span class="mockup-idx mono">01/${String((state.catalog?.releases?.length || 0) + 1).padStart(2, '0')}</span>
            <span class="mockup-badge mono">${(d.type || 'SGL').toUpperCase()}</span>
            <span class="mockup-year">${escapeHTML(d.year || '')}</span>
          </div>
          <div class="mockup-card-meta">
            <div class="mockup-card-title">${titleSafe}</div>
            <div class="mockup-listen mono"><span class="acid">↗</span> LISTEN</div>
          </div>
        </div>

        <div class="mockup mockup-player">
          <div class="mockup-tag mono">// LATEST RELEASE STRIP</div>
          <div class="mockup-player-row" style="background:${grad}">
            ${d.cover_url ? `<img src="${d.cover_url}" alt="">` : `<div class="mockup-fallback">${titleSafe}</div>`}
          </div>
          <div class="mockup-player-meta">
            <span class="mono acid">// LATEST RELEASE</span>
            <div class="mockup-player-title">${titleSafe}</div>
            <div class="mockup-player-sub mono">${escapeHTML(d.artist)} — ${escapeHTML(d.year || '')}</div>
            <div class="mockup-bars">
              ${Array.from({length: 32}, (_, i) =>
                `<span style="height:${20 + Math.abs(Math.sin(i*1.7))*60}%;background:${i < 10 ? d.accent_color : 'rgba(255,255,255,0.2)'}"></span>`
              ).join('')}
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
  // The schedule field uses an HTML datetime-local input. Value must be
  // formatted as 'YYYY-MM-DDTHH:MM' (no timezone, no seconds). When stored
  // we convert to ISO; when displayed we strip back. Empty = publish now.
  const scheduleVal = d.released_at && isFuture(d.released_at)
    ? toLocalDateTimeInput(d.released_at)
    : '';
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
        ${field('STATUS', `
          <div style="display:flex;gap:8px">
            ${[['published','◉ PUBLISHED'],['draft','○ DRAFT']].map(([v, l]) =>
              `<button class="chip ${d.status === v ? 'active' : ''}" data-status="${v}">${l}</button>`
            ).join('')}
          </div>
        `)}
        ${field('SCHEDULE RELEASE (optional)', `
          <div style="display:flex;gap:8px;align-items:center">
            <input class="field-input" type="datetime-local" data-meta-schedule
                   value="${scheduleVal}">
            <button class="btn-ghost" data-meta-schedule-clear style="padding:10px 14px">CLEAR</button>
          </div>
          <div class="mono" style="font-size:10px;letter-spacing:0.15em;opacity:0.5;margin-top:6px">
            ${scheduleVal
              ? `→ will go live ${new Date(d.released_at).toLocaleString()} (your local time)`
              : 'leave empty to publish immediately'}
          </div>
        `, true)}
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
        <button class="btn-acid" data-next>CONTINUE → ${state.editing ? 'SAVE' : 'PUBLISH'}</button>
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
  const ctaLabel = state.editing ? '◉ SAVE CHANGES' : (isFuture(d.released_at) ? '◉ SCHEDULE' : '◉ PUBLISH TO VAULT');
  const scheduledAt = isFuture(d.released_at) ? d.released_at : null;
  return `
    <div class="card">
      <div class="card-head">
        <span class="card-tag">// 04 · REVIEW & ${state.editing ? 'SAVE' : (scheduledAt ? 'SCHEDULE' : 'PUBLISH')}</span>
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
            ${summaryRow('STATUS', scheduledAt ? `⏱ SCHEDULED` : (d.status === 'published' ? '◉ LIVE' : '○ DRAFT'))}
          </div>
          ${scheduledAt ? `
            <div class="schedule-note mono">
              <span class="acid">⏱</span> goes live ${new Date(scheduledAt).toLocaleString()} (local time).
            </div>
          ` : ''}
        </div>
      </div>
      <div class="step-nav">
        <button class="btn-ghost" data-prev>← BACK</button>
        <button class="btn-acid" data-publish ${!ready ? 'disabled' : ''}>${ctaLabel}</button>
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
  const all = state.catalog?.releases || [];
  const filtered = applyCatalogFilter(all);
  const f = state.catalogFilter;
  const selectedCount = state.catalogSelected.size;

  return `
    <div class="page-head">
      <div>
        <div class="card-tag">// CATALOG</div>
        <h1 class="h1">the <em>vault.</em></h1>
        <p class="sub">
          ${all.length} releases · ${all.filter(r => r.status === 'published' && !isFuture(r.released_at)).length} live
          · ${all.filter(r => r.status === 'draft').length} draft
          · ${all.filter(r => r.status === 'published' && isFuture(r.released_at)).length} scheduled
          ${filtered.length !== all.length ? ` · <span class="acid">${filtered.length} match${filtered.length === 1 ? '' : 'es'}</span>` : ''}
        </p>
      </div>
    </div>

    <div class="catalog-toolbar">
      <input class="field-input catalog-search"
             type="search" placeholder="🔍 search by title, slug, genre, tags…"
             value="${escapeHTML(f.q)}" data-cat-search autocomplete="off">
      <div class="catalog-pills">
        <span class="mono" style="opacity:0.5;font-size:10px;letter-spacing:0.2em">STATUS</span>
        ${['all','published','draft','scheduled'].map(s => `
          <button class="chip ${f.status === s ? 'active' : ''}" data-cat-status="${s}">${s.toUpperCase()}</button>
        `).join('')}
      </div>
      <div class="catalog-pills">
        <span class="mono" style="opacity:0.5;font-size:10px;letter-spacing:0.2em">TYPE</span>
        ${['all','single','ep','lp'].map(s => `
          <button class="chip ${f.type === s ? 'active' : ''}" data-cat-type="${s}">${s.toUpperCase()}</button>
        `).join('')}
      </div>
    </div>

    <div class="catalog-table">
      <div class="catalog-header mono">
        <input type="checkbox" data-cat-selectall ${selectedCount > 0 && selectedCount === filtered.length ? 'checked' : ''}>
        <span>#</span><span>RELEASE</span><span>TYPE</span><span>YEAR</span>
        <span>TRACKS</span><span>PLAYS</span><span>STATUS</span><span style="text-align:right">ACTIONS</span>
      </div>
      ${filtered.map((r, i) => `
        <div class="catalog-row ${state.catalogSelected.has(r.id) ? 'selected' : ''}">
          <input type="checkbox" data-cat-select="${r.id}" ${state.catalogSelected.has(r.id) ? 'checked' : ''}>
          <span class="mono" style="opacity:0.5">${String(i + 1).padStart(2, '0')}</span>
          <div style="display:flex;align-items:center;gap:14px;min-width:0">
            <div class="cat-cover" style="background:linear-gradient(135deg, ${r.accent_color || '#c6ff00'}, ${r.accent_color_2 || '#000'})">
              ${r.cover_url ? `<img src="${r.cover_url}" alt="">` : ''}
            </div>
            <div style="min-width:0">
              <div style="font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHTML(r.title)}</div>
              <div class="mono" style="font-size:10px;letter-spacing:0.2em;opacity:0.5">/release/${escapeHTML(r.slug)}</div>
            </div>
          </div>
          <span class="mono" style="font-size:11px;letter-spacing:0.2em">${(r.type || 'sgl').toUpperCase()}</span>
          <span class="mono" style="font-size:11px">${escapeHTML(r.year || '')}</span>
          <span class="mono" style="font-size:11px">${(r.tracks || []).length}</span>
          <span class="mono acid" style="font-size:12px">${(r.plays || 0).toLocaleString()}</span>
          <button class="status-toggle ${releaseStatusClass(r)}" data-toggle-status="${r.id}" title="Click to toggle">
            ${releaseStatusLabel(r)}
          </button>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="icon-btn" data-edit-release="${r.id}" title="Edit">✎</button>
            <button class="icon-btn" data-duplicate-release="${r.id}" title="Duplicate">⎘</button>
            <a class="icon-btn" href="/release/${escapeHTML(r.slug)}" target="_blank" title="Open">↗</a>
            <button class="icon-btn icon-btn-danger" data-delete-release="${r.id}" title="Delete">×</button>
          </div>
        </div>
      `).join('') || `<div style="padding:48px;text-align:center;opacity:0.5" class="mono">// NO MATCHING RELEASES</div>`}
    </div>

    ${selectedCount > 0 ? `
      <div class="bulk-bar">
        <div class="bulk-info mono">
          <span class="acid">●</span>
          <span>${selectedCount} SELECTED</span>
        </div>
        <div class="bulk-actions">
          <button class="btn-ghost" data-bulk="publish">PUBLISH ALL</button>
          <button class="btn-ghost" data-bulk="draft">UNPUBLISH ALL</button>
          <button class="btn-ghost icon-btn-danger" data-bulk="delete" style="color:var(--magenta);border-color:var(--magenta)">DELETE ALL</button>
          <button class="btn-ghost" data-bulk="clear">CLEAR</button>
        </div>
      </div>
    ` : ''}
  `;
}

function applyCatalogFilter(releases) {
  const f = state.catalogFilter;
  const q = f.q.trim().toLowerCase();
  return releases.filter(r => {
    if (q) {
      const hay = [
        r.title || '', r.slug || '', r.genre || '', r.artist || '',
        Array.isArray(r.tags) ? r.tags.join(' ') : (r.tags || ''),
        r.year || '',
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.status === 'published' && !(r.status === 'published' && !isFuture(r.released_at))) return false;
    if (f.status === 'draft' && r.status !== 'draft') return false;
    if (f.status === 'scheduled' && !(r.status === 'published' && isFuture(r.released_at))) return false;
    if (f.type !== 'all' && (r.type || 'single') !== f.type) return false;
    return true;
  });
}

function releaseStatusLabel(r) {
  if (r.status === 'draft') return '○ DRAFT';
  if (isFuture(r.released_at)) return '⏱ SCHEDULED';
  return '◉ LIVE';
}
function releaseStatusClass(r) {
  if (r.status === 'draft') return 'draft';
  if (isFuture(r.released_at)) return 'scheduled';
  return 'published';
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

  wireAudioStep();
  wireCoverStep();
  wireMetaStep();
  $('[data-publish]')?.addEventListener('click', publish);
  wireCatalogActions();
  wireDashboardActions();
}

function wireDashboardActions() {
  $$('[data-edit-release]').forEach(b => b.addEventListener('click', () => startEditDraft(b.dataset.editRelease)));
}

function wireAudioStep() {
  const dz = $('#audio-dropzone');
  if (!dz) return;
  const input = $('#audio-input');
  dz.addEventListener('click', e => {
    if (e.target.closest('.file-row')) return;
    input.click();
  });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    handleAudioFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => handleAudioFiles(input.files));

  $$('[data-edit="title"]').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.idx;
    if (state.draft.tracks[i]) {
      state.draft.tracks[i].title = inp.value;
      persistDraft();
    }
  }));
  $$('[data-edit="bpm"]').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.idx;
    if (!state.draft.tracks[i]) return;
    const v = parseInt(inp.value, 10);
    state.draft.tracks[i].bpm = Number.isFinite(v) && v > 0 ? v : null;
    persistDraft();
  }));

  $$('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
    state.draft.tracks.splice(+btn.dataset.idx, 1);
    paintBody();
  }));

  $$('[data-replace]').forEach(btn => btn.addEventListener('click', () => {
    const i = +btn.dataset.idx;
    $(`#replace-input-${i}`).click();
  }));
  $$('[data-replace-idx]').forEach(inp => inp.addEventListener('change', e => {
    const i = +e.target.dataset.replaceIdx;
    const file = e.target.files?.[0];
    if (file) replaceTrackFile(i, file);
  }));

  // Inline ▶ play / pause
  $$('[data-play-track]').forEach(btn => btn.addEventListener('click', () => {
    const i = +btn.dataset.idx;
    const track = state.draft.tracks[i];
    if (!track?.audio_url) return;
    togglePreview(track, btn);
  }));

  wireTrackReorder();
}

function wireCoverStep() {
  const cdz = $('#cover-dropzone');
  if (!cdz) return;
  const input = $('#cover-input');
  cdz.addEventListener('click', () => input.click());
  cdz.addEventListener('dragover', e => { e.preventDefault(); cdz.classList.add('drag-over'); });
  cdz.addEventListener('dragleave', () => cdz.classList.remove('drag-over'));
  cdz.addEventListener('drop', e => {
    e.preventDefault(); cdz.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleCoverFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => input.files[0] && handleCoverFile(input.files[0]));

  $('[data-cover-replace]')?.addEventListener('click', () => input.click());
  $('[data-cover-clear]')?.addEventListener('click', () => {
    state.draft.cover_url = null;
    state.draft.cover_filename = null;
    paintBody();
  });

  wireColorPicker();
}

function wireMetaStep() {
  $$('[data-meta]').forEach(el => {
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      state.draft[el.dataset.meta] = el.type === 'checkbox' ? el.checked : el.value;
      persistDraft();
    });
  });
  $$('[data-type]').forEach(b => b.addEventListener('click', () => {
    state.draft.type = b.dataset.type;
    paintBody();
  }));
  $$('[data-status]').forEach(b => b.addEventListener('click', () => {
    state.draft.status = b.dataset.status;
    paintBody();
  }));

  // Schedule field. The browser <input type="datetime-local"> returns the
  // user's local time without a tz; we convert to ISO so the server treats
  // it as "the user clearly meant this absolute moment".
  $('[data-meta-schedule]')?.addEventListener('change', e => {
    const v = e.target.value;
    if (!v) {
      state.draft.released_at = null;
    } else {
      const d = new Date(v);
      if (!isNaN(d.getTime())) state.draft.released_at = d.toISOString();
    }
    paintBody();
  });
  $('[data-meta-schedule-clear]')?.addEventListener('click', () => {
    state.draft.released_at = null;
    paintBody();
  });
}

function wireCatalogActions() {
  // Search & filter
  $('[data-cat-search]')?.addEventListener('input', e => {
    state.catalogFilter.q = e.target.value;
    // Don't repaint the search input itself — we'd lose focus. Just update
    // the rows below. For simplicity (and since it's fast), repaint and
    // re-focus at end of input.
    const cursor = e.target.selectionStart;
    paintBody();
    const f = $('[data-cat-search]');
    if (f) { f.focus(); f.setSelectionRange(cursor, cursor); }
  });
  $$('[data-cat-status]').forEach(b => b.addEventListener('click', () => {
    state.catalogFilter.status = b.dataset.catStatus;
    paintBody();
  }));
  $$('[data-cat-type]').forEach(b => b.addEventListener('click', () => {
    state.catalogFilter.type = b.dataset.catType;
    paintBody();
  }));

  // Per-row checkboxes
  $$('[data-cat-select]').forEach(cb => cb.addEventListener('change', () => {
    const id = cb.dataset.catSelect;
    if (cb.checked) state.catalogSelected.add(id);
    else state.catalogSelected.delete(id);
    paintBody();
  }));
  // Select-all in header
  $('[data-cat-selectall]')?.addEventListener('change', e => {
    const filtered = applyCatalogFilter(state.catalog?.releases || []);
    if (e.target.checked) filtered.forEach(r => state.catalogSelected.add(r.id));
    else filtered.forEach(r => state.catalogSelected.delete(r.id));
    paintBody();
  });

  // Quick toggle
  $$('[data-toggle-status]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.toggleStatus;
    const cur = state.catalog.releases.find(r => r.id === id);
    if (!cur) return;
    const next = cur.status === 'published' ? 'draft' : 'published';
    try {
      await api(`/api/admin/release/${id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      showToast(`Release set to ${next.toUpperCase()}`);
      await reloadCatalog();
      paintBody();
    } catch (e) {
      showToast('Update failed: ' + e.message, 'err');
    }
  }));

  $$('[data-edit-release]').forEach(b => b.addEventListener('click', () => startEditDraft(b.dataset.editRelease)));

  $$('[data-duplicate-release]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.duplicateRelease;
    try {
      const result = await api(`/api/admin/release/${id}/duplicate`, { method: 'POST' });
      showToast(`Cloned as draft: "${result.release.title}"`);
      await reloadCatalog();
      paintBody();
    } catch (e) {
      showToast('Duplicate failed: ' + e.message, 'err');
    }
  }));

  $$('[data-delete-release]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.deleteRelease;
    if (!confirm('Delete this release? This cannot be undone.')) return;
    try {
      await api(`/api/admin/release/${id}`, { method: 'DELETE' });
      showToast('Release deleted');
      state.catalogSelected.delete(id);
      await reloadCatalog();
      paintBody();
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'err');
    }
  }));

  // Bulk operations
  $$('[data-bulk]').forEach(b => b.addEventListener('click', async () => {
    const op = b.dataset.bulk;
    const ids = Array.from(state.catalogSelected);
    if (!ids.length) return;

    if (op === 'clear') {
      state.catalogSelected.clear();
      paintBody();
      return;
    }
    if (op === 'delete') {
      if (!confirm(`Delete ${ids.length} releases? This cannot be undone.`)) return;
    }
    try {
      // Sequential (cPanel single-worker friendly) — also gives a clear progress feel.
      for (const id of ids) {
        if (op === 'publish') {
          await api(`/api/admin/release/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) });
        } else if (op === 'draft') {
          await api(`/api/admin/release/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'draft' }) });
        } else if (op === 'delete') {
          await api(`/api/admin/release/${id}`, { method: 'DELETE' });
        }
      }
      showToast(`✓ ${op.toUpperCase()} applied to ${ids.length} release${ids.length === 1 ? '' : 's'}`);
      state.catalogSelected.clear();
      await reloadCatalog();
      paintBody();
    } catch (e) {
      showToast('Bulk op failed: ' + e.message, 'err');
    }
  }));
}

/* ───────────── COLOR PICKER ───────────── */
function wireColorPicker() {
  function commitColor(field, value) {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return false;
    state.draft[field] = value.toLowerCase();
    const dataKey = field === 'accent_color' ? 'color' : 'color2';
    const swatch = document.querySelector(`[data-${dataKey}-rgb]`)?.parentElement;
    if (swatch) swatch.style.background = value;

    // Update gradient previews everywhere on this step. Currently this hits
    // the two mockup blocks (.mockup-vault-card, .mockup-player-row), but
    // we keep .cover-preview in the selector list so a future template
    // change that re-introduces a single preview block "just works".
    document.querySelectorAll('.cover-preview, .mockup-vault-card, .mockup-player-row').forEach(el => {
      el.style.background = `linear-gradient(135deg, ${state.draft.accent_color}, ${state.draft.accent_color_2})`;
    });
    // Mockup waveform bars use accent_color for the "played" portion. Recolor
    // them in place so the preview reacts to color tweaks without a full repaint.
    if (field === 'accent_color') {
      const bars = document.querySelectorAll('.mockup-bars span');
      bars.forEach((b, i) => {
        if (i < 10) b.style.background = state.draft.accent_color;
      });
    }

    const rgb = document.querySelector(`[data-${dataKey}-rgb]`);
    const hex = document.querySelector(`[data-${dataKey}-hex]`);
    if (rgb && rgb.value.toLowerCase() !== value.toLowerCase()) rgb.value = value;
    if (hex && hex.value.toUpperCase() !== value.toUpperCase()) hex.value = value.toUpperCase();
    document.querySelectorAll(`[data-${dataKey}]`).forEach(chip => {
      chip.classList.toggle('active', chip.dataset[dataKey].toLowerCase() === value.toLowerCase());
    });
    persistDraft();
    return true;
  }

  $('[data-color-rgb]')?.addEventListener('input', e => commitColor('accent_color', e.target.value));
  $('[data-color-hex]')?.addEventListener('input', e => {
    let v = e.target.value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    commitColor('accent_color', v);
  });
  $$('[data-color]').forEach(chip => chip.addEventListener('click', () => commitColor('accent_color', chip.dataset.color)));

  $('[data-color2-rgb]')?.addEventListener('input', e => commitColor('accent_color_2', e.target.value));
  $('[data-color2-hex]')?.addEventListener('input', e => {
    let v = e.target.value.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    commitColor('accent_color_2', v);
  });
  $$('[data-color2]').forEach(chip => chip.addEventListener('click', () => commitColor('accent_color_2', chip.dataset.color2)));
}

/* ───────────── DRAG REORDER ───────────── */
function wireTrackReorder() {
  let dragIdx = null;
  $$('.file-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragIdx = +row.dataset.trackIdx;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragIdx));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      $$('.file-row').forEach(r => r.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragIdx === null) return;
      const overIdx = +row.dataset.trackIdx;
      if (overIdx !== dragIdx) row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const overIdx = +row.dataset.trackIdx;
      if (dragIdx === null || overIdx === dragIdx) return;
      const arr = state.draft.tracks;
      const [moved] = arr.splice(dragIdx, 1);
      arr.splice(overIdx, 0, moved);
      dragIdx = null;
      paintBody();
    });
  });
}

/* ───────────── INLINE PREVIEW PLAYER ─────────────
 * One shared <audio> element. Multiple ▶ buttons can target it; whichever
 * was last clicked is "active". Clicking the active button again pauses.
 * Clicking another button stops the previous and starts the new track. */
const _preview = {
  audio: null,
  activeBtn: null,
  ensure() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'metadata';
      this.audio.addEventListener('ended', () => this.stop());
      this.audio.addEventListener('error', () => this.stop());
    }
    return this.audio;
  },
  stop() {
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
    if (this.activeBtn) { this.activeBtn.textContent = '▶'; this.activeBtn.classList.remove('playing'); this.activeBtn = null; }
  },
};

function togglePreview(track, btn) {
  const audio = _preview.ensure();
  // Same button clicked while playing → pause.
  if (_preview.activeBtn === btn && !audio.paused) {
    audio.pause();
    btn.textContent = '▶';
    btn.classList.remove('playing');
    return;
  }
  // Different track or paused state → load + play.
  if (audio.src !== location.origin + track.audio_url && !audio.src.endsWith(track.audio_url)) {
    audio.src = track.audio_url;
  }
  if (_preview.activeBtn && _preview.activeBtn !== btn) {
    _preview.activeBtn.textContent = '▶';
    _preview.activeBtn.classList.remove('playing');
  }
  _preview.activeBtn = btn;
  audio.play().then(() => {
    btn.textContent = '❚❚';
    btn.classList.add('playing');
  }).catch(err => {
    showToast('Preview failed: ' + err.message, 'err');
    _preview.stop();
  });
}

/* ───────────── GLOBAL DROP HANDLER ─────────────
 * Drop an audio file on ANY part of the page → it kicks off a fresh wizard
 * with that file already in step 1. Only kicks in if the drop doesn't land
 * on a wizard dropzone (those handle their own files). */
function installGlobalDropHandler() {
  let depth = 0;
  const overlay = $('#global-drop-overlay');

  function isAudioDrag(e) {
    if (!e.dataTransfer) return false;
    // Some browsers don't expose item types until drop. We probe by file kind:
    const items = e.dataTransfer.items;
    if (items && items.length) {
      for (const it of items) if (it.kind === 'file') return true;
    }
    return e.dataTransfer.types?.includes('Files');
  }

  document.addEventListener('dragenter', e => {
    if (!isAudioDrag(e)) return;
    depth++;
    if (overlay) overlay.style.display = 'flex';
  });
  document.addEventListener('dragover', e => {
    if (!isAudioDrag(e)) return;
    e.preventDefault();
  });
  document.addEventListener('dragleave', e => {
    depth = Math.max(0, depth - 1);
    if (depth === 0 && overlay) overlay.style.display = 'none';
  });
  document.addEventListener('drop', e => {
    depth = 0;
    if (overlay) overlay.style.display = 'none';
    if (!e.dataTransfer.files?.length) return;
    // If the drop happened inside an explicit dropzone (audio or cover),
    // let that handler take it. We detect this by checking the closest ancestor.
    const onWizardZone = e.target.closest?.('#audio-dropzone, #cover-dropzone');
    if (onWizardZone) return;

    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac)$/i.test(f.name));
    if (!audioFiles.length) return;

    // If we're already inside the wizard, just add tracks to the current draft.
    if (state.view === 'upload') {
      handleAudioFiles(audioFiles);
    } else {
      // Otherwise: open a new wizard pre-filled with the dropped files.
      startNewDraft(audioFiles);
    }
  });
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
    await uploadOneTrack(file, draft);
  }
  paintBody();
}

async function replaceTrackFile(index, file) {
  const track = state.draft.tracks[index];
  if (!track) return;
  track._uploadProgress = 0;
  track._error = null;
  track._replaced = false;
  track.audio_url = null;
  track.audio_filename = null;
  track.waveform_url = null;
  track.peaks = null;
  track.duration = 0;
  track._localName = file.name;
  track._localSize = file.size;
  paintBody();
  await uploadOneTrack(file, track);
  track._replaced = true;
  updateTrackRow(track);
}

async function uploadOneTrack(file, draft) {
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

    const { peaks, duration } = await computePeaks(file, 256);
    draft.peaks = peaks;
    draft.duration = duration;
    updateTrackRow(draft);

    await api('/api/admin/waveform', {
      method: 'POST',
      body: JSON.stringify({ audio_filename: draft.audio_filename, peaks, duration }),
    });
    draft.waveform_url = `/media/waveforms/${draft.audio_filename.replace(/\.[^.]+$/, '')}.json`;
    updateTrackRow(draft);
    persistDraft();
  } catch (err) {
    console.error(err);
    draft._error = err.message || 'upload failed';
    updateTrackRow(draft);
    showToast(`Upload failed: ${file.name}`, 'err');
  }
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
  // If schedule is in the future, make sure status is 'published' (so
  // is_release_visible flips it on at the right time).
  let statusToSend = d.status || 'published';
  if (isFuture(d.released_at) && statusToSend === 'draft') {
    // A scheduled draft makes no sense; escalate to published-but-future.
    statusToSend = 'published';
  }
  const payload = {
    id: d.id || undefined,
    title: d.title,
    artist: d.artist,
    type: d.type,
    year: d.year,
    released_at: d.released_at || undefined,
    genre: d.genre,
    tags: d.tags
      ? (Array.isArray(d.tags) ? d.tags : d.tags.split(',').map(s => s.trim()).filter(Boolean))
      : [],
    description: d.description,
    explicit: d.explicit,
    isrc: d.isrc,
    cover_url: d.cover_url,
    cover_filename: d.cover_filename,
    accent_color: d.accent_color,
    accent_color_2: d.accent_color_2,
    status: statusToSend,
    tracks: d.tracks.map(t => ({
      id: t.id || undefined,
      title: t.title,
      audio_url: t.audio_url,
      audio_filename: t.audio_filename,
      waveform_url: t.waveform_url,
      duration: t.duration,
      bpm: t.bpm,
      plays: t.plays || 0,
    })),
  };
  try {
    const result = await api('/api/admin/release', { method: 'POST', body: JSON.stringify(payload) });
    let verb;
    if (state.editing) verb = 'updated';
    else if (isFuture(d.released_at)) verb = `scheduled for ${new Date(d.released_at).toLocaleString()}`;
    else verb = 'is live';
    showToast(`✓ "${result.release.title}" ${verb} at /release/${result.release.slug}`);
    state.draft = emptyDraft();
    state.step = 1;
    state.editing = false;
    state.view = 'catalog';
    clearPersistedDraft();
    _preview.stop();
    await reloadCatalog();
    loadAnalytics(); // refresh analytics in background
    paint();
  } catch (e) {
    showToast(`${state.editing ? 'Save' : 'Publish'} failed: ` + e.message, 'err');
  }
}

/* ─── helpers ─── */
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function isFuture(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (isNaN(t)) return false;
  return t > Date.now();
}

// 'YYYY-MM-DDTHH:MM' for <input type="datetime-local"> from an ISO string,
// using the BROWSER'S local time (so the input doesn't drift from what the
// user picked).
function toLocalDateTimeInput(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── boot ───
(async () => {
  await renderApp();
})();