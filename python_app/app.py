"""
THE RIZAEV — Flask backend.

Single-admin music site. JSON-on-disk "database" with file-locking.
No external services. Designed to run on cPanel "Setup Python App".

Environment variables (set in cPanel Python App → Environment Variables):
    ADMIN_PASSWORD_HASH   bcrypt hash of admin password (use scripts/hash_password.py)
    SECRET_KEY            random 32+ char string for signing session cookies
    DATA_DIR              absolute path to data/ (default: ./data next to app.py)

Endpoints (public):
    GET  /api/catalog                catalog (releases + tracks, no drafts, no scheduled)
    GET  /api/release/<slug>         single release by slug (404 if scheduled/draft)
    POST /api/play                   increment play count + log to plays.jsonl

Endpoints (admin):
    POST /api/admin/login            { password } -> sets session cookie
    POST /api/admin/logout
    GET  /api/admin/me
    GET  /api/admin/catalog          full catalog incl. drafts and scheduled
    GET  /api/admin/release/<id>     get release for editing
    POST /api/admin/upload/audio     multipart audio file -> { filename, url }
    POST /api/admin/upload/cover     multipart image -> { filename, url }
    POST /api/admin/waveform         save peaks JSON
    POST /api/admin/release          create/update release (id present = update)
    PATCH /api/admin/release/<id>    partial update
    POST /api/admin/release/<id>/duplicate    clone a release as a draft
    DELETE /api/admin/release/<id>   delete release
    GET  /api/admin/analytics        plays-per-day + top tracks
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone, timedelta
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
PLAYS_LOG = DATA_DIR / "plays.jsonl"

for d in (AUDIO_DIR, COVER_DIR, WAVEFORM_DIR):
    d.mkdir(parents=True, exist_ok=True)

ALLOWED_AUDIO = {".mp3", ".m4a", ".wav", ".ogg", ".flac"}
ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp"}
MAX_AUDIO_BYTES = 200 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024

PLAY_DEBOUNCE_SEC = 30
_play_cache: dict[tuple[str, str], float] = {}

_catalog_lock = Lock()
_plays_lock = Lock()


# ─────────────────────────── app ──────────────────────────────
app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PREFERRED_URL_SCHEME="https",
    MAX_CONTENT_LENGTH=MAX_AUDIO_BYTES + 1024 * 1024,
)


# ─────────────────────────── helpers ──────────────────────────
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(s: str | None) -> datetime | None:
    """Lenient ISO-8601 parser. Returns None on bad input."""
    if not s:
        return None
    try:
        # Python's fromisoformat supports the common forms produced by JS
        # (Date.toISOString) and our own now_iso().
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def slugify(text: str) -> str:
    text = (text or "").lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "untitled"


def empty_catalog() -> dict:
    return {"version": 1, "releases": [], "updated_at": now_iso()}


def load_catalog() -> dict:
    with _catalog_lock:
        if not CATALOG_FILE.exists():
            CATALOG_FILE.write_text(json.dumps(empty_catalog(), indent=2))
        try:
            return json.loads(CATALOG_FILE.read_text())
        except json.JSONDecodeError:
            backup = CATALOG_FILE.with_suffix(f".json.broken.{int(time.time())}")
            CATALOG_FILE.rename(backup)
            empty = empty_catalog()
            CATALOG_FILE.write_text(json.dumps(empty, indent=2))
            return empty


def save_catalog(cat: dict) -> None:
    cat["updated_at"] = now_iso()
    with _catalog_lock:
        tmp = CATALOG_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cat, indent=2, ensure_ascii=False))
        tmp.replace(CATALOG_FILE)


def is_release_visible(r: dict, now: datetime | None = None) -> bool:
    """A release is publicly visible if status='published' AND release date is
    in the past (or empty — empty defaults to immediate publication)."""
    if r.get("status") != "published":
        return False
    rel_at = parse_iso(r.get("released_at"))
    if rel_at is None:
        return True
    if now is None:
        now = now_utc()
    # released_at is ISO with tz; normalise to UTC if naive.
    if rel_at.tzinfo is None:
        rel_at = rel_at.replace(tzinfo=timezone.utc)
    return rel_at <= now


def public_view(cat: dict) -> dict:
    now = now_utc()
    releases = [r for r in cat.get("releases", []) if is_release_visible(r, now)]
    releases.sort(
        key=lambda r: r.get("released_at") or r.get("created_at") or "",
        reverse=True,
    )
    return {"updated_at": cat.get("updated_at"), "releases": releases}


def is_admin() -> bool:
    return True


def require_admin():
    return


def safe_ext(filename: str, allowed: set[str]) -> str:
    ext = Path(filename or "").suffix.lower()
    if ext not in allowed:
        abort(400, description=f"unsupported file type: {ext}")
    return ext


def client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else (request.remote_addr or "?")


def find_release(cat: dict, rid: str) -> tuple[int, dict | None]:
    for i, r in enumerate(cat.get("releases", [])):
        if r.get("id") == rid:
            return i, r
    return -1, None


def append_play_log(track_id: str) -> None:
    """Append one line to plays.jsonl. JSON-lines format keeps appends atomic
    on POSIX (single write < pipe buffer) and is trivial to read back."""
    line = json.dumps({"t": now_iso(), "id": track_id}, separators=(",", ":")) + "\n"
    with _plays_lock:
        with open(PLAYS_LOG, "a", encoding="utf-8") as fh:
            fh.write(line)


# ─────────────────────────── public API ───────────────────────
@app.get("/api/catalog")
def api_catalog():
    return jsonify(public_view(load_catalog()))


@app.get("/api/release/<slug>")
def api_release(slug: str):
    cat = load_catalog()
    now = now_utc()
    for r in cat.get("releases", []):
        if r.get("slug") == slug and is_release_visible(r, now):
            return jsonify(r)
    abort(404)


@app.post("/api/play")
def api_play():
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
    # Append to log AFTER catalog save so analytics never references a track
    # that doesn't exist in the catalog.
    append_play_log(track_id)
    return jsonify({"ok": True, "counted": True})


# ─────────────────────────── admin auth ───────────────────────
@app.post("/api/admin/login")
def api_admin_login():
    body = request.get_json(silent=True) or {}
    password = (body.get("password") or "").encode("utf-8")
    pw_hash = (os.environ.get("ADMIN_PASSWORD_HASH") or "").encode("utf-8")
    if not pw_hash:
        return jsonify({"ok": False, "error": "server_not_configured"}), 503
    try:
        if bcrypt.checkpw(password, pw_hash):
            session["admin"] = True
            session.permanent = True
            return jsonify({"ok": True})
    except ValueError:
        return jsonify({"ok": False, "error": "server_misconfigured"}), 503
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


@app.get("/api/admin/release/<rid>")
def api_admin_get_release(rid: str):
    require_admin()
    cat = load_catalog()
    _, rel = find_release(cat, rid)
    if not rel:
        abort(404)
    return jsonify(rel)


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

    existing = None
    if not is_new:
        _, existing = find_release(cat, rid)

    existing_track_plays: dict[str, int] = {}
    if existing:
        for t in existing.get("tracks", []):
            tid = t.get("id")
            if tid:
                existing_track_plays[tid] = int(t.get("plays", 0))

    tracks = []
    for i, t in enumerate(body.get("tracks", [])):
        tid = t.get("id") or uuid.uuid4().hex[:12]
        plays = int(t.get("plays") or 0)
        if plays == 0 and tid in existing_track_plays:
            plays = existing_track_plays[tid]
        tracks.append({
            "id": tid,
            "n": f"{i + 1:02d}",
            "title": (t.get("title") or "").strip() or f"Track {i + 1}",
            "audio_url": t.get("audio_url"),
            "audio_filename": t.get("audio_filename"),
            "waveform_url": t.get("waveform_url"),
            "duration": float(t.get("duration") or 0),
            "bpm": int(t.get("bpm") or 0) if t.get("bpm") else None,
            "plays": plays,
        })

    rel = {
        "id": rid,
        "slug": slug,
        "title": title,
        "artist": body.get("artist") or "THE RIZAEV",
        "type": body.get("type") or "single",
        "year": body.get("year") or str(datetime.now().year),
        "released_at": body.get("released_at") or (existing.get("released_at") if existing else now_iso()),
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
        "status": body.get("status") or "published",
        "created_at": (existing.get("created_at") if existing else None) or body.get("created_at") or now_iso(),
        "updated_at": now_iso(),
    }

    if is_new:
        releases.insert(0, rel)
    else:
        for i, r in enumerate(releases):
            if r.get("id") == rid:
                releases[i] = rel
                break
        else:
            releases.insert(0, rel)

    save_catalog(cat)
    return jsonify({"ok": True, "release": rel})


@app.patch("/api/admin/release/<rid>")
def api_admin_patch_release(rid: str):
    require_admin()
    body = request.get_json(silent=True) or {}
    cat = load_catalog()
    idx, rel = find_release(cat, rid)
    if not rel:
        abort(404)

    allowed = {
        "title", "artist", "type", "year", "released_at", "genre", "tags",
        "description", "explicit", "isrc", "cover_url", "cover_filename",
        "accent_color", "accent_color_2", "status",
    }
    for k, v in body.items():
        if k in allowed:
            rel[k] = v

    if "title" in body:
        base_slug = slugify(rel["title"])
        slug = base_slug
        n = 2
        taken = {r["slug"] for r in cat["releases"] if r.get("id") != rid}
        while slug in taken:
            slug = f"{base_slug}-{n}"
            n += 1
        rel["slug"] = slug

    rel["updated_at"] = now_iso()
    cat["releases"][idx] = rel
    save_catalog(cat)
    return jsonify({"ok": True, "release": rel})


@app.post("/api/admin/release/<rid>/duplicate")
def api_admin_duplicate_release(rid: str):
    """Clone a release as a fresh draft. Tracks get NEW ids (so play counts
    don't bleed across clones), but reuse the SAME audio_url/cover_url —
    it's a logical clone, not a file copy. The user can replace files later."""
    require_admin()
    cat = load_catalog()
    _, src = find_release(cat, rid)
    if not src:
        abort(404)

    new_id = uuid.uuid4().hex[:12]
    base_title = (src.get("title") or "Untitled") + " (copy)"
    base_slug = slugify(base_title)
    slug = base_slug
    n = 2
    taken = {r["slug"] for r in cat["releases"]}
    while slug in taken:
        slug = f"{base_slug}-{n}"
        n += 1

    new_tracks = []
    for i, t in enumerate(src.get("tracks", [])):
        new_tracks.append({
            **t,
            "id": uuid.uuid4().hex[:12],
            "n": f"{i + 1:02d}",
            "plays": 0,
        })

    rel = {
        **src,
        "id": new_id,
        "slug": slug,
        "title": base_title,
        "tracks": new_tracks,
        "plays": 0,
        "status": "draft",
        # Reset timestamps for the clone; keep the cover/colors/description.
        "released_at": now_iso(),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    cat["releases"].insert(0, rel)
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


# ─────────────────────────── analytics ────────────────────────
@app.get("/api/admin/analytics")
def api_admin_analytics():
    """Return:
       - per_day:   [{date: 'YYYY-MM-DD', plays: N}, ...] for the last `days` days
       - top:       [{track_id, title, release_title, plays}] limited to top N
       - totals:    overall totals
    Reads plays.jsonl line by line — fine for tens of thousands of plays. If
    the log ever grows huge, switch to a periodic aggregation step."""
    require_admin()
    days = int(request.args.get("days", 30))
    top_n = int(request.args.get("top", 10))

    end = now_utc().date()
    start = end - timedelta(days=days - 1)

    per_day: dict[str, int] = defaultdict(int)
    per_track: dict[str, int] = defaultdict(int)
    total_in_window = 0

    if PLAYS_LOG.exists():
        with open(PLAYS_LOG, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = parse_iso(rec.get("t"))
                tid = rec.get("id")
                if not ts or not tid:
                    continue
                day = ts.date()
                if start <= day <= end:
                    per_day[day.isoformat()] += 1
                    total_in_window += 1
                # per_track is all-time, not windowed
                per_track[tid] += 1

    # Fill missing days with 0 so the chart x-axis is contiguous.
    series = []
    cur = start
    while cur <= end:
        key = cur.isoformat()
        series.append({"date": key, "plays": per_day.get(key, 0)})
        cur += timedelta(days=1)

    # Build top-tracks list using catalog metadata.
    cat = load_catalog()
    track_meta: dict[str, dict] = {}
    for r in cat.get("releases", []):
        for t in r.get("tracks", []):
            track_meta[t["id"]] = {
                "track_id": t["id"],
                "title": t.get("title") or "Untitled",
                "release_title": r.get("title") or "",
                "release_slug": r.get("slug") or "",
                "release_id": r.get("id") or "",
                "cover_url": r.get("cover_url"),
                "accent_color": r.get("accent_color"),
                "accent_color_2": r.get("accent_color_2"),
                "plays_total": int(t.get("plays") or 0),  # cumulative counter from catalog
            }

    # Use the cumulative play counter (from catalog.json) as the source of
    # truth for "top tracks" — it's consistent with what the user sees on
    # release pages, even for plays from before plays.jsonl existed.
    top = sorted(
        track_meta.values(),
        key=lambda x: x["plays_total"],
        reverse=True,
    )[:top_n]

    total_plays_alltime = sum(m["plays_total"] for m in track_meta.values())

    return jsonify({
        "ok": True,
        "window_days": days,
        "per_day": series,
        "top": top,
        "totals": {
            "in_window": total_in_window,
            "all_time": total_plays_alltime,
            "tracks": len(track_meta),
        },
    })


# ─────────────────────────── media serving ────────────────────
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
    app.run(host="127.0.0.1", port=5000, debug=True)