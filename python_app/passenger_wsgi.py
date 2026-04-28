"""cPanel Passenger entry point.

cPanel's "Setup Python App" expects a `passenger_wsgi.py` file in the
application root that exposes a WSGI callable named `application`.
"""
import os
import sys

# Make the app directory importable regardless of where Passenger runs from.
APP_DIR = os.path.dirname(os.path.abspath(__file__))
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

from app import app as application  # noqa: E402,F401
