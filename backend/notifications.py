"""Opt-in MAX messenger reminders and training summaries. Browser push is disabled."""
import asyncio
import hashlib
import hmac
import json
import secrets
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from .config import (MAX_API_URL, MAX_BOT_READY, MAX_BOT_TOKEN, MAX_BOT_USERNAME,
                     MAX_CA_BUNDLE, MAX_WEBHOOK_SECRET, PUBLIC_URL, local_now)
from .db import get_db
from .profiles import get_user_profile
from .security import get_current_user_id

router = APIRouter()


def max_api(method: str, *, payload: dict | None = None, query: str = "") -> dict | None:
    if not MAX_BOT_TOKEN:
        return None
    request = urllib.request.Request(
        f"{MAX_API_URL}/{method}{query}",
        data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
        headers={
            "Authorization": MAX_BOT_TOKEN,
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    try:
        tls_context = ssl.create_default_context()
        if MAX_CA_BUNDLE:
            tls_context.load_verify_locations(cafile=MAX_CA_BUNDLE)
        with urllib.request.urlopen(request, timeout=8, context=tls_context) as response:
            result = json.loads(response.read().decode())
            return result if isinstance(result, dict) and result.get("success") is not False else None
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return None


def send_max_message(user_id: int | str, message: str) -> bool:
    return max_api("messages", payload={"text": message}, query=f"?user_id={urllib.parse.quote(str(user_id))}") is not None


def ensure_max_webhook() -> None:
    if not MAX_BOT_READY:
        return
    max_api("subscriptions", payload={
        "url": f"{PUBLIC_URL}/api/max/webhook",
        "update_types": ["bot_started", "bot_stopped"],
        "secret": MAX_WEBHOOK_SECRET,
    })


def deliver_max_session_summary(user_id: int, session: dict) -> None:
    conn = get_db()
    row = conn.execute(
        "SELECT max_user_id FROM max_connections WHERE user_id = ? AND summaries_enabled = 1",
        (user_id,),
    ).fetchone()
    conn.close()
    if not row:
        return
    mode_names = {
        "words": "Слова", "sentences": "Фразы", "code": "Код",
        "symbols": "Знаки", "custom": "Свои слова", "race": "Клавагонки",
    }
    message = (
        "Итог тренировки · Печать героя\n"
        f"Режим: {mode_names.get(session['mode'], 'Тренировка')}\n"
        f"Скорость: {session['wpm']:.1f} слов/мин · {session['cpm']:.0f} знаков/мин\n"
        f"Точность: {session['accuracy']:.1f}% · Ошибки: {session['errors']}\n"
        f"Опыт: +{session['xp_earned']}"
    )
    send_max_message(row["max_user_id"], message)


def deliver_due_max_reminders() -> None:
    if not MAX_BOT_READY:
        return
    now = local_now()
    today = now.date().isoformat()
    conn = get_db()
    rows = conn.execute(
        """
        SELECT t.user_id, t.max_user_id, u.username FROM max_connections t
        JOIN users u ON u.id = t.user_id
        WHERE t.reminder_enabled = 1 AND t.reminder_time <= ?
          AND NOT EXISTS (SELECT 1 FROM max_reminder_log l WHERE l.user_id = t.user_id AND l.reminder_date = ?)
          AND NOT EXISTS (SELECT 1 FROM practice_days d WHERE d.user_id = t.user_id AND d.practiced_on = ?)
        """,
        (now.strftime("%H:%M"), today, today),
    ).fetchall()
    for row in rows:
        if send_max_message(row["max_user_id"], f"{row['username']}, пора размяться: уделите печати пару минут. Откройте «Печать героя» и продолжите серию занятий."):
            conn.execute(
                "INSERT OR IGNORE INTO max_reminder_log (user_id, reminder_date) VALUES (?, ?)",
                (row["user_id"], today),
            )
    conn.commit()
    conn.close()


async def max_reminder_worker() -> None:
    """Check opt-in MAX reminders without scheduling any browser notifications."""
    while True:
        try:
            await asyncio.to_thread(deliver_due_max_reminders)
        except Exception:
            # A messenger outage must not interrupt typing.
            pass
        await asyncio.sleep(30)


class MaxNotificationSettingsRequest(BaseModel):
    reminder_enabled: bool
    summaries_enabled: bool
    reminder_time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")


@router.post("/api/profile/max/link")
def create_max_link(request: Request):
    if not MAX_BOT_READY:
        raise HTTPException(status_code=503, detail="Бот MAX пока не настроен владельцем сайта")
    user_id = get_current_user_id(request)
    token = secrets.token_urlsafe(24)
    expires_at = (datetime.utcnow() + timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db()
    conn.execute(
        "INSERT INTO max_link_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at",
        (user_id, hashlib.sha256(token.encode()).hexdigest(), expires_at),
    )
    conn.commit()
    conn.close()
    return {"url": f"https://max.ru/{urllib.parse.quote(MAX_BOT_USERNAME)}?start={urllib.parse.quote(token)}"}


@router.delete("/api/profile/max")
def disconnect_max(request: Request):
    user_id = get_current_user_id(request)
    conn = get_db()
    conn.execute("DELETE FROM max_connections WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM max_link_tokens WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    return get_user_profile(user_id)


@router.put("/api/profile/max/settings")
def update_max_settings(req: MaxNotificationSettingsRequest, request: Request):
    user_id = get_current_user_id(request)
    conn = get_db()
    updated = conn.execute(
        "UPDATE max_connections SET reminder_enabled = ?, summaries_enabled = ?, reminder_time = ? WHERE user_id = ?",
        (int(req.reminder_enabled), int(req.summaries_enabled), req.reminder_time, user_id),
    ).rowcount
    conn.commit()
    conn.close()
    if not updated:
        raise HTTPException(status_code=409, detail="Сначала подключите бота MAX")
    return get_user_profile(user_id)


@router.post("/api/max/webhook")
async def max_webhook(request: Request):
    secret = request.headers.get("X-Max-Bot-Api-Secret", "")
    if not MAX_BOT_READY or not hmac.compare_digest(secret, MAX_WEBHOOK_SECRET):
        raise HTTPException(status_code=403, detail="Forbidden")
    update = await request.json()
    update_type = update.get("update_type") or update.get("type")
    user = update.get("user") or {}
    max_user_id = user.get("user_id") or update.get("user_id")
    if not max_user_id:
        return {"ok": True}
    max_user_id = str(max_user_id)
    if update_type == "bot_stopped":
        conn = get_db()
        conn.execute("DELETE FROM max_connections WHERE max_user_id = ?", (max_user_id,))
        conn.commit()
        conn.close()
        return {"ok": True}
    if update_type != "bot_started":
        return {"ok": True}

    payload = str(update.get("payload") or "").strip()
    if not payload:
        send_max_message(max_user_id, "Чтобы связать MAX с профилем, откройте настройки «Печати героя» и нажмите «Подключить MAX».")
        return {"ok": True}
    token_hash = hashlib.sha256(payload.encode()).hexdigest()
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db()
    link = conn.execute(
        "SELECT user_id FROM max_link_tokens WHERE token_hash = ? AND expires_at > ?",
        (token_hash, now),
    ).fetchone()
    if not link:
        conn.close()
        send_max_message(max_user_id, "Ссылка подключения устарела. Создайте новую в настройках профиля и нажмите «Начать».")
        return {"ok": True}
    occupied = conn.execute(
        "SELECT user_id FROM max_connections WHERE max_user_id = ? AND user_id != ?",
        (max_user_id, link["user_id"]),
    ).fetchone()
    if occupied:
        conn.close()
        send_max_message(max_user_id, "Этот аккаунт MAX уже подключён к другому профилю.")
        return {"ok": True}
    conn.execute(
        "INSERT INTO max_connections (user_id, max_user_id) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET max_user_id = excluded.max_user_id, reminder_enabled = 0, summaries_enabled = 0",
        (link["user_id"], max_user_id),
    )
    conn.execute("DELETE FROM max_link_tokens WHERE user_id = ?", (link["user_id"],))
    conn.commit()
    conn.close()
    send_max_message(
        max_user_id,
        "Бот MAX подключён к «Печати героя»! Вернитесь на сайт: статус обновится в настройках профиля. Напоминания и итоги тренировок можно включить отдельно.",
    )
    return {"ok": True}
