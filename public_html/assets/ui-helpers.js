/* THE RIZAEV — shared UI helpers. */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function e(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') el.className = attrs[k];
    else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k]);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else el.setAttribute(k, attrs[k]);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function rmark(size = 22, strokeColor = '#fff', dotColor = '#c6ff00') {
  return `<svg class="rmark" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">
    <rect x="22" y="20" width="14" height="60" fill="${strokeColor}"/>
    <rect x="22" y="20" width="42" height="14" fill="${strokeColor}"/>
    <rect x="22" y="46" width="38" height="14" fill="${strokeColor}"/>
    <rect x="50" y="20" width="14" height="40" fill="${strokeColor}"/>
    <polygon points="44,54 60,54 78,80 62,80" fill="${strokeColor}"/>
    <circle cx="74" cy="26" r="4" fill="${dotColor}"/>
  </svg>`;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function showToast(text, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.innerHTML = `<span class="${kind === 'err' ? '' : 'acid'}">${kind === 'err' ? '✕' : '◉'}</span> ${text}`;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s, transform 0.3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(40px)';
  }, 3000);
  setTimeout(() => t.remove(), 3400);
}

/* Tiny fetch wrapper that always returns JSON or throws. */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let json = null;
  try { json = await res.json(); } catch { /* may be empty */ }
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}
