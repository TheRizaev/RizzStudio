"""Generate a bcrypt hash for the admin password.

Run on your local machine OR on the server (cPanel → Terminal):

    python hash_password.py

Paste the resulting hash into cPanel → Setup Python App →
Environment Variables → ADMIN_PASSWORD_HASH.
"""
import getpass
import bcrypt


def main() -> None:
    pw = getpass.getpass("New admin password: ")
    pw2 = getpass.getpass("Repeat: ")
    if pw != pw2:
        raise SystemExit("Passwords do not match.")
    if len(pw) < 8:
        raise SystemExit("Use at least 8 characters.")
    h = bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")
    print()
    print("Set this in cPanel → Setup Python App → Environment Variables:")
    print()
    print(f"  ADMIN_PASSWORD_HASH={h}")
    print()


if __name__ == "__main__":
    main()
