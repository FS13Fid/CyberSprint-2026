"""Email and OAuth authentication routes."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from .config import PUBLIC_URL, SESSION_COOKIE, SOCIAL_PROVIDERS
from .db import get_db
from .profiles import get_user_profile
from .security import create_session, get_current_user_id, hash_password, normalize_email, verify_password

router = APIRouter()

PROVIDER_ORDER = ("yandex", "vk", "github")
PROVIDER_CALLBACKS = {
    "github": os.environ.get("GITHUB_OAUTH_REDIRECT_URI", f"{PUBLIC_URL}/api/auth/social/github/callback").strip(),
    "yandex": os.environ.get("YANDEX_OAUTH_REDIRECT_URI", f"{PUBLIC_URL}/api/auth/social/yandex/callback").strip(),
    "vk": os.environ.get("VK_ID_REDIRECT_URI", f"{PUBLIC_URL}/api/auth/social/vk/callback").strip(),
}


class RegisterRequest(BaseModel):
    email: str = Field(min_length=6, max_length=254)
    username: str = Field(min_length=2, max_length=24)
    password: str = Field(min_length=8, max_length=128)
    leaderboard_public: bool = False

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        try:
            return normalize_email(value)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[\w.-]{2,24}", value, flags=re.UNICODE) or not value[0].isalnum():
            raise ValueError("Никнейм: 2–24 буквы, цифры, точка, дефис или подчёркивание")
        return value


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_login_email(cls, value: str) -> str:
        return value.strip().lower()


@router.post("/api/auth/register")
def register(req: RegisterRequest, request: Request, response: Response):
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO users (email, username, password_hash, leaderboard_public) VALUES (?, ?, ?, ?)",
            (req.email, req.username, hash_password(req.password), int(req.leaderboard_public))
        )
        conn.commit()
        user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Пользователь с таким email уже существует")
    conn.close()
    create_session(user_id, request, response)
    return get_user_profile(user_id)


@router.post("/api/auth/login")
def login(req: LoginRequest, request: Request, response: Response):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, password_hash FROM users WHERE email = ?",
        (req.email,)
    )
    row = cur.fetchone()
    valid, needs_upgrade = verify_password(req.password, row["password_hash"]) if row else (False, False)
    if valid and needs_upgrade:
        cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(req.password), row["id"]))
        conn.commit()
    conn.close()
    if not valid:
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    create_session(row["id"], request, response)
    return get_user_profile(row["id"])


def make_code_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def fetch_json(url: str, *, data: bytes | None = None, headers: dict | None = None) -> dict:
    request = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(request, timeout=12) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict):
        raise ValueError("Identity provider returned an invalid response")
    return result


def save_oauth_state(provider: str, request: Request, intent: str, user_id: int | None, verifier: str, nonce: str | None) -> str:
    state = secrets.token_urlsafe(32)
    session_token = request.cookies.get(SESSION_COOKIE) if intent == "link" else None
    conn = get_db()
    conn.execute("DELETE FROM auth_oauth_states WHERE expires_at <= ?", (datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),))
    conn.execute(
        "INSERT INTO auth_oauth_states (state_hash, provider, intent, user_id, session_token_hash, code_verifier, nonce, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            hashlib.sha256(state.encode()).hexdigest(), provider, intent, user_id,
            hashlib.sha256(session_token.encode()).hexdigest() if session_token else None,
            verifier, nonce, (datetime.utcnow() + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S"),
        ),
    )
    conn.commit()
    conn.close()
    return state


def consume_oauth_state(state: str, provider: str):
    state_hash = hashlib.sha256(state.encode()).hexdigest()
    conn = get_db()
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        "SELECT * FROM auth_oauth_states WHERE state_hash = ? AND provider = ? AND expires_at > ?",
        (state_hash, provider, datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")),
    ).fetchone()
    conn.execute("DELETE FROM auth_oauth_states WHERE state_hash = ?", (state_hash,))
    conn.commit()
    conn.close()
    return row


def clean_social_username(provider: str, subject: str, value: str) -> str:
    username = re.sub(r"[^\w.-]", "", str(value or ""), flags=re.UNICODE)[:24]
    if len(username) < 2 or not username[0].isalnum():
        username = f"{provider}{subject[-8:]}"[:24]
    return username


def complete_social_identity(provider: str, subject: str, username: str, request: Request, intent: str, user_id: int | None, session_token_hash: str | None) -> tuple[int, bool]:
    if not subject or len(subject) > 200:
        raise ValueError("Identity provider returned an invalid user id")
    if intent == "link":
        token = request.cookies.get(SESSION_COOKIE, "")
        if not user_id or not token or not session_token_hash or not hmac.compare_digest(
            hashlib.sha256(token.encode()).hexdigest(), session_token_hash
        ) or get_current_user_id(request) != user_id:
            raise ValueError("The account session changed during linking")
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        identity = conn.execute(
            "SELECT user_id FROM auth_identities WHERE provider = ? AND subject = ?",
            (provider, subject),
        ).fetchone()
        if intent == "link":
            if identity and identity["user_id"] != user_id:
                raise ValueError("This external account is already linked to another profile")
            if not identity:
                conn.execute(
                    "INSERT INTO auth_identities (provider, subject, user_id) VALUES (?, ?, ?)",
                    (provider, subject, user_id),
                )
            conn.commit()
            return user_id, True
        if identity:
            conn.commit()
            return identity["user_id"], False
        normalized = clean_social_username(provider, subject, username)
        email = f"{provider}-{subject}@users.invalid"
        conn.execute(
            "INSERT INTO users (email, username, password_hash, password_enabled) VALUES (?, ?, ?, 0)",
            (email, normalized, hash_password(secrets.token_urlsafe(48))),
        )
        new_user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO auth_identities (provider, subject, user_id) VALUES (?, ?, ?)",
            (provider, subject, new_user_id),
        )
        conn.commit()
        return new_user_id, False
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def provider_failure(provider: str, intent: str):
    safe_provider = provider if provider in SOCIAL_PROVIDERS else "account"
    if intent == "link":
        return RedirectResponse(f"/?link_error={safe_provider}", status_code=303)
    return RedirectResponse(f"/?auth_error={safe_provider}", status_code=303)


@router.get("/api/auth/providers")
def auth_providers():
    return {provider: bool(SOCIAL_PROVIDERS[provider]["ready"]) for provider in PROVIDER_ORDER}


@router.get("/api/auth/social/{provider}/start")
def start_social_login(provider: str, request: Request, intent: str = "login"):
    if provider not in SOCIAL_PROVIDERS or not SOCIAL_PROVIDERS[provider]["ready"]:
        return provider_failure(provider, "link" if intent == "link" else "login")
    intent = "link" if intent == "link" else "login"
    user_id = get_current_user_id(request) if intent == "link" else None
    verifier = secrets.token_urlsafe(48)
    state = save_oauth_state(provider, request, intent, user_id, verifier, None)
    redirect_uri = PROVIDER_CALLBACKS[provider]
    if provider == "github":
        params = {
            "client_id": SOCIAL_PROVIDERS[provider]["client_id"],
            "redirect_uri": redirect_uri,
            "scope": "read:user",
            "state": state,
        }
        return RedirectResponse(f"https://github.com/login/oauth/authorize?{urllib.parse.urlencode(params)}", status_code=303)
    if provider == "yandex":
        params = {
            "client_id": SOCIAL_PROVIDERS[provider]["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "login:info",
            "state": state,
            "code_challenge": make_code_challenge(verifier),
            "code_challenge_method": "S256",
        }
        return RedirectResponse(f"https://oauth.yandex.ru/authorize?{urllib.parse.urlencode(params)}", status_code=303)
    params = {
        "client_id": SOCIAL_PROVIDERS[provider]["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "state": state,
        "code_challenge": make_code_challenge(verifier),
        "code_challenge_method": "s256",
    }
    return RedirectResponse(f"https://id.vk.ru/authorize?{urllib.parse.urlencode(params)}", status_code=303)


@router.get("/api/auth/social/{provider}/callback")
def social_login_callback(
    provider: str,
    request: Request,
    response: Response,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    device_id: str | None = None,
):
    if provider not in SOCIAL_PROVIDERS or not SOCIAL_PROVIDERS[provider]["ready"]:
        return provider_failure(provider, "login")
    if not state:
        return provider_failure(provider, "login")
    flow = consume_oauth_state(state, provider)
    if not flow:
        return provider_failure(provider, "login")
    if error or not code:
        return provider_failure(provider, flow["intent"])
    if flow["intent"] == "link":
        token = request.cookies.get(SESSION_COOKIE, "")
        if not token or not flow["session_token_hash"] or not hmac.compare_digest(
            hashlib.sha256(token.encode()).hexdigest(), flow["session_token_hash"]
        ):
            return provider_failure(provider, "link")
    try:
        subject = ""
        username = ""
        redirect_uri = PROVIDER_CALLBACKS[provider]
        verifier = flow["code_verifier"]
        if provider == "github":
            config = SOCIAL_PROVIDERS[provider]
            token_data = fetch_json(
                "https://github.com/login/oauth/access_token",
                data=urllib.parse.urlencode({
                    "client_id": config["client_id"], "client_secret": config["client_secret"],
                    "code": code, "redirect_uri": redirect_uri,
                }).encode(),
                headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
            )
            user_data = fetch_json(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {token_data['access_token']}",
                    "Accept": "application/vnd.github+json", "User-Agent": "CyberSprint-2026",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            subject, username = str(user_data.get("id", "")), str(user_data.get("login", ""))
        elif provider == "yandex":
            config = SOCIAL_PROVIDERS[provider]
            token_data = fetch_json(
                "https://oauth.yandex.ru/token",
                data=urllib.parse.urlencode({
                    "grant_type": "authorization_code", "code": code,
                    "client_id": config["client_id"], "client_secret": config["client_secret"],
                    "redirect_uri": redirect_uri, "code_verifier": verifier,
                }).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            info = fetch_json(
                "https://login.yandex.ru/info?format=json",
                headers={"Authorization": f"OAuth {token_data['access_token']}"},
            )
            subject, username = str(info.get("id", "")), str(info.get("login") or info.get("display_name") or "")
        else:
            config = SOCIAL_PROVIDERS[provider]
            token_url = "https://id.vk.ru/oauth2/auth?" + urllib.parse.urlencode({
                "grant_type": "authorization_code", "client_id": config["client_id"],
                "redirect_uri": redirect_uri, "code_verifier": verifier,
                "state": state, "device_id": device_id or "",
            })
            token_data = fetch_json(
                token_url, data=urllib.parse.urlencode({"code": code}).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if str(token_data.get("state", "")) != state:
                raise ValueError("VK ID state mismatch")
            info = fetch_json(
                "https://id.vk.ru/oauth2/user_info?" + urllib.parse.urlencode({"client_id": config["client_id"]}),
                data=urllib.parse.urlencode({"access_token": token_data["access_token"]}).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            user_info = info.get("user", info)
            subject = str(user_info.get("user_id") or user_info.get("id") or token_data.get("user_id") or "")
            username = str(user_info.get("first_name") or user_info.get("name") or f"vk{subject[-8:]}")
        user_id, linked = complete_social_identity(
            provider, subject, username, request, flow["intent"], flow["user_id"], flow["session_token_hash"]
        )
    except Exception:
        return provider_failure(provider, flow["intent"])

    if linked:
        return RedirectResponse(f"/?account_linked={provider}", status_code=303)
    result = RedirectResponse("/", status_code=303)
    create_session(user_id, request, result)
    return result


@router.get("/api/auth/me")
def current_profile(request: Request):
    return get_user_profile(get_current_user_id(request))


@router.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        conn = get_db()
        conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
        conn.commit()
        conn.close()
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return {"ok": True}
