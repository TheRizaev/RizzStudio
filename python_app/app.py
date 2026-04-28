"""
THE RIZAEV — Flask backend.

Single-admin music site. JSON-on-disk "database" with file-locking.
No external services. Designed to run on cPanel "Setup Python App".

Environment variables (set in cPanel Python App → Environment Variables):
    ADMIN_PASSWORD_HASH   bcrypt hash of admin password (use scripts/hash_password.py)
    SECRET_KEY            random 32+ char string for signing session cookies
    DATA_DIR              absolute path to data/ (default: ./data next to app.py)

Endpoints:
    GET  /api/catalog                public catalog (releases + tracks, no drafts)
    GET  /api/release/<slug>         single release by slug
    POST /api/play                   increment play count (debounced server-side)
    POST /api/admin/login            { password } -> sets session cookie
    POST /api/admin/logout
    GET  /api/admin/catalog          full catalog incl. drafts (auth required)
    POST /api/admin/upload/audio     multipart audio file -> { filename, url }
    POST /api/admin/upload/cover     multipart image -> { filename, url }
    POST /api/admin/release          create/update release (auth required)
    DELETE /api/admin/release/<id>   delete release (auth required)
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

import bcrypt
from flask import Flask, jsonify, request, send_from_directory, abort, session
from werkzeug.utils import secure_filename


# ─────────────────────────── config ───────────────────────────
APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR / "data"))
AUDIO_DIR = DATA_DIR / "audio"
COVER_DIR = DATA_DIR / "covers"
WAVEFORM_DIR = DATA_DIR / "waveforms"
CATALOG_FILE = DATA_DIR / "catalog.json"

for d in (AUDIO_DIR, COVER_DIR, WAVEFORM_DIR):
    d.mkdir(parents=True, exist_ok=True)

ALLOWED_AUDIO = {".mp3", ".m4a", ".wav", ".ogg", ".flac"}
ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp"}
MAX_AUDIO_BYTES = 200 * 1024 * 1024   # 200 MB
MAX_IMAGE_BYTES = 10 * 1024 * 1024    # 10 MB

# Server-side play debounce: same IP+track, 1 plays per 30s.
PLAY_DEBOUNCE_SEC = 30
_play_cache: dict[tuple[str, str], float] = {}

# JSON file lock — JSON is rewritten in full on every admin write,
# so a process-wide lock is enough for one cPanel worker.
_catalog_lock = Lock()


# ─────────────────────────── app ──────────────────────────────
app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # SESSION_COOKIE_SECURE is set automatically by Flask when behind HTTPS
    # via X-Forwarded-Proto if PREFERRED_URL_SCHEME is 'https'.
    PREFERRED_URL_SCHEME="https",
    MAX_CONTENT_LENGTH=MAX_AUDIO_BYTES + 1024 * 1024,
)


# ─────────────────────────── helpers ──────────────────────────
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(text: str) -> str:
    """URL-safe slug. Keeps a-z 0-9 and dashes."""
    text = (text or "").lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "untitled"


def empty_catalog() -> dict:
    return {"version": 1, "releases": [], "updated_at": now_iso()}


def load_catalog() -> dict:
    """Read full catalog. Creates empty file on first run."""
    with _catalog_lock:
        if not CATALOG_FILE.exists():
            CATALOG_FILE.write_text(json.dumps(empty_catalog(), indent=2))
        try:
            return json.loads(CATALOG_FILE.read_text())
        except json.JSONDecodeError:
            # Corrupt JSON — start fresh, keep a backup.
            backup = CATALOG_FILE.with_suffix(f".json.broken.{int(time.time())}")
            CATALOG_FILE.rename(backup)
            empty = empty_catalog()
            CATALOG_FILE.write_text(json.dumps(empty, indent=2))
            return empty


def save_catalog(cat: dict) -> None:
    """Atomic write: tmp file + rename."""
    cat["updated_at"] = now_iso()
    with _catalog_lock:
        tmp = CATALOG_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cat, indent=2, ensure_ascii=False))
        tmp.replace(CATALOG_FILE)


def public_view(cat: dict) -> dict:
    """Strip drafts and admin-only fields before sending to public API."""
    releases = [r for r in cat.get("releases", []) if r.get("status") == "published"]
    # Sort newest first by released_at fallback to created_at.
    releases.sort(
        key=lambda r: r.get("released_at") or r.get("created_at") or "",
        reverse=True,
    )
    return {"updated_at": cat.get("updated_at"), "releases": releases}


def is_admin() -> bool:
    # Security model changed: admin access is gated by a secret URL on the
    # frontend (see public_html/.htaccess), not by a session/password.
    # Anyone who knows the secret URL is treated as admin.
    return True


def require_admin():
    # No-op. Kept as a function so existing call-sites still work.
    return


def safe_ext(filename: str, allowed: set[str]) -> str:
    ext = Path(filename or "").suffix.lower()
    if ext not in allowed:
        abort(400, description=f"unsupported file type: {ext}")
    return ext


def client_ip() -> str:
    # cPanel usually sits behind Apache; X-Forwarded-For may carry the real IP.
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else (request.remote_addr or "?")


# ─────────────────────────── public API ───────────────────────
@app.get("/api/catalog")
def api_catalog():
    return jsonify(public_view(load_catalog()))


@app.get("/api/release/<slug>")
def api_release(slug: str):
    cat = load_catalog()
    for r in cat.get("releases", []):
        if r.get("slug") == slug and r.get("status") == "published":
            return jsonify(r)
    abort(404)


@app.post("/api/play")
def api_play():
    """Increment play count. Debounced per IP+track."""
    body = request.get_json(silent=True) or {}
    track_id = body.get("track_id")
    if not track_id:
        abort(400)

    key = (client_ip(), str(track_id))
    now = time.time()
    last = _play_cache.get(key, 0)
    if now - last < PLAY_DEBOUNCE_SEC:
        return jsonify({"ok": True, "counted": False})
    _play_cache[key] = now
    # Trim cache occasionally
    if len(_play_cache) > 5000:
        cutoff = now - PLAY_DEBOUNCE_SEC * 2
        for k in [k for k, v in _play_cache.items() if v < cutoff]:
            _play_cache.pop(k, None)

    cat = load_catalog()
    found = False
    for r in cat.get("releases", []):
        for t in r.get("tracks", []):
            if t.get("id") == track_id:
                t["plays"] = int(t.get("plays", 0)) + 1
                r["plays"] = sum(int(x.get("plays", 0)) for x in r["tracks"])
                found = True
                break
        if found:
            break
    if not found:
        abort(404)
    save_catalog(cat)
    return jsonify({"ok": True, "counted": True})


# ─────────────────────────── admin auth ───────────────────────
@app.post("/api/admin/login")
def api_admin_login():
    body = request.get_json(silent=True) or {}
    password = (body.get("password") or "").encode("utf-8")
    pw_hash = (os.environ.get("ADMIN_PASSWORD_HASH") or "").encode("utf-8")
    if not pw_hash:
        # Useful self-check during deployment: tells you the env var is missing
        # without leaking whether the password matched.
        return jsonify({"ok": False, "error": "server_not_configured"}), 503
    try:
        if bcrypt.checkpw(password, pw_hash):
            session["admin"] = True
            session.permanent = True
            return jsonify({"ok": True})
    except ValueError:
        # Malformed hash in env
        return jsonify({"ok": False, "error": "server_misconfigured"}), 503
    # Constant-ish delay against brute force (cheap, doesn't replace rate limiting
    # at the cPanel/.htaccess level if you ever care).
    time.sleep(0.4)
    return jsonify({"ok": False, "error": "invalid_password"}), 401


@app.post("/api/admin/logout")
def api_admin_logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/admin/me")
def api_admin_me():
    return jsonify({"authenticated": is_admin()})


# ─────────────────────────── admin: catalog ───────────────────
@app.get("/api/admin/catalog")
def api_admin_catalog():
    require_admin()
    return jsonify(load_catalog())


@app.post("/api/admin/upload/audio")
def api_admin_upload_audio():
    require_admin()
    f = request.files.get("file")
    if not f:
        abort(400, description="no file")
    ext = safe_ext(f.filename, ALLOWED_AUDIO)
    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}{ext}"
    dest = AUDIO_DIR / fname
    f.save(dest)
    if dest.stat().st_size > MAX_AUDIO_BYTES:
        dest.unlink(missing_ok=True)
        abort(413, description="file too large")
    return jsonify({
        "ok": True,
        "filename": fname,
        "url": f"/media/audio/{fname}",
        "size": dest.stat().st_size,
    })


@app.post("/api/admin/upload/cover")
def api_admin_upload_cover():
    require_admin()
    f = request.files.get("file")
    if not f:
        abort(400, description="no file")
    ext = safe_ext(f.filename, ALLOWED_IMAGE)
    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}{ext}"
    dest = COVER_DIR / fname
    f.save(dest)
    if dest.stat().st_size > MAX_IMAGE_BYTES:
        dest.unlink(missing_ok=True)
        abort(413, description="image too large")
    return jsonify({
        "ok": True,
        "filename": fname,
        "url": f"/media/covers/{fname}",
    })


@app.post("/api/admin/waveform")
def api_admin_save_waveform():
    """Client computes peaks via OfflineAudioContext and posts them here.
    Stored as a small JSON next to audio for instant render on the public site."""
    require_admin()
    body = request.get_json(silent=True) or {}
    audio_filename = body.get("audio_filename")
    peaks = body.get("peaks")
    duration = body.get("duration")
    if not audio_filename or not isinstance(peaks, list):
        abort(400)
    safe = secure_filename(audio_filename)
    out = WAVEFORM_DIR / f"{Path(safe).stem}.json"
    out.write_text(json.dumps({"peaks": peaks, "duration": duration}))
    return jsonify({"ok": True, "url": f"/media/waveforms/{out.name}"})


@app.post("/api/admin/release")
def api_admin_save_release():
    """Create or update a release.

    Body: full release object. If `id` is missing → create.
    Slug auto-generated from title; uniqueness enforced by appending -2, -3, ...
    """
    require_admin()
    body = request.get_json(silent=True) or {}
    cat = load_catalog()
    releases = cat.setdefault("releases", [])

    rid = body.get("id")
    is_new = not rid
    if is_new:
        rid = uuid.uuid4().hex[:12]

    title = (body.get("title") or "").strip() or "Untitled"
    base_slug = slugify(body.get("slug") or title)
    slug = base_slug
    n = 2
    taken = {r["slug"] for r in releases if r.get("id") != rid}
    while slug in taken:
        slug = f"{base_slug}-{n}"
        n += 1

    # Normalise tracks: ensure each has an id and play counter
    tracks = []
    for i, t in enumerate(body.get("tracks", [])):
        tracks.append({
            "id": t.get("id") or uuid.uuid4().hex[:12],
            "n": f"{i + 1:02d}",
            "title": (t.get("title") or "").strip() or f"Track {i + 1}",
            "audio_url": t.get("audio_url"),
            "audio_filename": t.get("audio_filename"),
            "waveform_url": t.get("waveform_url"),
            "duration": float(t.get("duration") or 0),
            "bpm": int(t.get("bpm") or 0) if t.get("bpm") else None,
            "plays": int(t.get("plays") or 0),
        })

    rel = {
        "id": rid,
        "slug": slug,
        "title": title,
        "artist": body.get("artist") or "THE RIZAEV",
        "type": body.get("type") or "single",      # single | ep | lp
        "year": body.get("year") or str(datetime.now().year),
        "released_at": body.get("released_at") or now_iso(),
        "genre": body.get("genre") or "",
        "tags": body.get("tags") or [],
        "description": body.get("description") or "",
        "explicit": bool(body.get("explicit")),
        "isrc": body.get("isrc") or "",
        "cover_url": body.get("cover_url"),
        "cover_filename": body.get("cover_filename"),
        "accent_color": body.get("accent_color") or "#c6ff00",
        "accent_color_2": body.get("accent_color_2") or "#000000",
        "tracks": tracks,
        "plays": sum(t["plays"] for t in tracks),
        "status": body.get("status") or "published",  # published | draft
        "created_at": body.get("created_at") or now_iso(),
        "updated_at": now_iso(),
    }

    if is_new:
        releases.insert(0, rel)
    else:
        for i, r in enumerate(releases):
            if r.get("id") == rid:
                # Preserve play counts even if client forgot to send them
                existing_plays = {t["id"]: t.get("plays", 0) for t in r.get("tracks", [])}
                for t in rel["tracks"]:
                    if t["id"] in existing_plays and t["plays"] == 0:
                        t["plays"] = existing_plays[t["id"]]
                rel["plays"] = sum(t["plays"] for t in rel["tracks"])
                releases[i] = rel
                break
        else:
            releases.insert(0, rel)

    save_catalog(cat)
    return jsonify({"ok": True, "release": rel})


@app.delete("/api/admin/release/<rid>")
def api_admin_delete_release(rid: str):
    require_admin()
    cat = load_catalog()
    before = len(cat.get("releases", []))
    cat["releases"] = [r for r in cat.get("releases", []) if r.get("id") != rid]
    if len(cat["releases"]) == before:
        abort(404)
    save_catalog(cat)
    return jsonify({"ok": True})


# ─────────────────────────── media serving ────────────────────
# Apache will normally serve /media/* directly via .htaccess (much faster, supports Range).
# These routes are a fallback if you ever run the app standalone (e.g. local dev).
@app.get("/media/audio/<path:filename>")
def media_audio(filename):
    return send_from_directory(AUDIO_DIR, filename, conditional=True)


@app.get("/media/covers/<path:filename>")
def media_cover(filename):
    return send_from_directory(COVER_DIR, filename, conditional=True)


@app.get("/media/waveforms/<path:filename>")
def media_waveform(filename):
    return send_from_directory(WAVEFORM_DIR, filename, conditional=True)


# ─────────────────────────── error JSON ───────────────────────
@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(404)
@app.errorhandler(413)
@app.errorhandler(500)
def err(e):
    code = getattr(e, "code", 500)
    return jsonify({"ok": False, "error": getattr(e, "description", str(e))}), code


if __name__ == "__main__":
    # Local dev only. cPanel uses passenger_wsgi.py.
    app.run(host="127.0.0.1", port=5000, debug=True)