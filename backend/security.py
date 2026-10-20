"""Password hashing and cookie-session authentication."""
import hashlib
import hmac
import re
import secrets
from datetime import datetime
from fastapi import HTTPException, Request, Response
from .config import PASSWORD_ITERATIONS, SESSION_COOKIE, SESSION_TTL
from .db import get_db


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> tuple[bool, bool]:
    """Return (valid, needs_upgrade), accepting old unsalted hashes once."""
    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            _, iterations, salt_hex, digest_hex = stored_hash.split("$", 3)
            digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations))
            return hmac.compare_digest(digest.hex(), digest_hex), False
        except (ValueError, TypeError):
            return False, False

    legacy_digest = hashlib.sha256(password.encode()).hexdigest()
    return hmac.compare_digest(legacy_digest, stored_hash), True


def normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if len(normalized) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise ValueError("Введите корректный email")
    return normalized


def create_session(user_id: int, request: Request, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    conn = get_db()
    conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now.strftime("%Y-%m-%d %H:%M:%S"),))
    previous_token = request.cookies.get(SESSION_COOKIE)
    if previous_token:
        conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (hashlib.sha256(previous_token.encode()).hexdigest(),))
    conn.execute(
        "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (hashlib.sha256(token.encode()).hexdigest(), user_id, (now + SESSION_TTL).strftime("%Y-%m-%d %H:%M:%S")),
    )
    conn.commit()
    conn.close()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def get_current_user_id(request: Request) -> int:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Войдите в аккаунт")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db()
    row = conn.execute(
        "SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
        (token_hash, now),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=401, detail="Сессия завершилась. Войдите снова")
    return row["user_id"]
