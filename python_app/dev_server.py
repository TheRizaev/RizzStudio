"""Local dev server — runs Flask API + serves public_html/ on a single port.

Use only for local testing (`python dev_server.py`). On cPanel, Apache
serves public_html/ and Passenger runs the Flask app — this file isn't used.

Why this exists: in production Apache + .htaccess merges the static folder
and the Python app into one origin so /api works. Locally we don't have
Apache, so we mount the same Flask app and add a catch-all that serves
files from ../public_html/.
"""
import os
import sys
from pathlib import Path

from flask import send_from_directory, abort

# Import the existing Flask app
from app import app

PUBLIC_HTML = (Path(__file__).resolve().parent.parent / "public_html").resolve()

if not PUBLIC_HTML.exists():
    print(f"[dev] public_html not found at: {PUBLIC_HTML}")
    print("[dev] Make sure you run this from inside python_app/")
    sys.exit(1)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_static(path):
    """Serve files from public_html/. Mirrors what .htaccess does on cPanel."""
    # Don't intercept API or media routes — Flask already handles those.
    # (Flask matches more specific routes first, so this is a fallback.)
    if path.startswith("api/") or path.startswith("media/"):
        abort(404)

    # Pretty URL: /admin -> admin.html
    if path == "admin" or path == "admin/":
        return send_from_directory(PUBLIC_HTML, "admin.html")

    # Pretty URL: /release/<slug> -> release.html (JS reads slug from path)
    if path.startswith("release/"):
        return send_from_directory(PUBLIC_HTML, "release.html")

    # Try the literal path (e.g. assets/app.js, index.html)
    target = (PUBLIC_HTML / path).resolve()
    # Security: don't escape PUBLIC_HTML
    try:
        target.relative_to(PUBLIC_HTML)
    except ValueError:
        abort(403)

    if target.is_file():
        return send_from_directory(PUBLIC_HTML, path)

    # Default: SPA-style fallback to index.html
    return send_from_directory(PUBLIC_HTML, "index.html")


if __name__ == "__main__":
    if not os.environ.get("ADMIN_PASSWORD_HASH"):
        print()
        print("⚠  ADMIN_PASSWORD_HASH is not set.")
        print("   Run: python hash_password.py")
        print("   Then: export ADMIN_PASSWORD_HASH='<the hash>'   (mac/linux)")
        print("         $env:ADMIN_PASSWORD_HASH='<the hash>'      (windows powershell)")
        print()
        print("The site will load but you won't be able to log into /admin until you set it.")
        print()

    print(f"[dev] serving public_html/ from: {PUBLIC_HTML}")
    print(f"[dev] open http://127.0.0.1:5000")
    print(f"[dev] admin: http://127.0.0.1:5000/admin")
    print()
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=True)
