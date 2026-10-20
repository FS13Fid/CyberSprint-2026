"""Private progress views and profile settings."""
import re
import sqlite3
import hashlib
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from .config import ACHIEVEMENTS_CONFIG, MAX_BOT_READY, SESSION_COOKIE, local_now
from .db import get_db
from .metrics import round_half_up
from .security import get_current_user_id, hash_password, normalize_email, verify_password

router = APIRouter()


@router.get("/api/user/{user_id}")
def user_profile(user_id: int, request: Request):
    if get_current_user_id(request) != user_id:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    return get_user_profile(user_id)


def get_user_profile(user_id: int):
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = cur.fetchone()
    if not user:
        conn.close()
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    cur.execute(
        "SELECT id, mode, difficulty, lang, wpm, cpm, accuracy, errors, score, xp_earned, "
        "duration_sec, duration_ms, is_ranked, metrics_version, ranking_reason, created_at FROM sessions "
        "WHERE user_id = ? ORDER BY id DESC LIMIT 20",
        (user_id,)
    )
    sessions = [dict(r) for r in cur.fetchall()]
    for session in sessions:
        session["wpm"] = round_half_up(session["wpm"], 1)
        session["cpm"] = round_half_up(session["cpm"])
        session["accuracy"] = round_half_up(session["accuracy"], 1)
        session["is_ranked"] = bool(session["is_ranked"])
    sessions.reverse()

    cur.execute(
        """
        SELECT e.char, e.error_count, COALESCE(a.attempt_count, 0) AS attempt_count,
               CASE WHEN COALESCE(a.attempt_count, 0) > 0
                    THEN ROUND(e.error_count * 100.0 / a.attempt_count, 1) ELSE NULL END AS error_rate
        FROM char_errors e
        LEFT JOIN char_attempts a ON a.user_id = e.user_id AND a.char = e.char
        WHERE e.user_id = ? AND e.error_count > 0
        ORDER BY COALESCE(error_rate, 0) DESC, e.error_count DESC
        LIMIT 10
        """,
        (user_id,)
    )
    hardest_chars = [dict(r) for r in cur.fetchall()]

    cur.execute("SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?", (user_id,))
    unlocked_map = {r["achievement_id"]: r["unlocked_at"] for r in cur.fetchall()}

    achievements = []
    for ach in ACHIEVEMENTS_CONFIG:
        achievements.append({
            **ach,
            "unlocked": ach["id"] in unlocked_map,
            "unlocked_at": unlocked_map.get(ach["id"])
        })

    cur.execute("""SELECT
        MAX(CASE WHEN is_ranked = 1 THEN wpm END) AS best_wpm,
        MAX(CASE WHEN is_ranked = 1 THEN cpm END) AS best_cpm,
        AVG(accuracy) AS avg_acc,
        COALESCE(SUM(is_ranked), 0) AS ranked_sessions,
        SUM(CASE WHEN metrics_version = 1 THEN 1 ELSE 0 END) AS legacy_sessions
        FROM sessions WHERE user_id = ?""", (user_id,))
    stats_row = cur.fetchone()

    today = local_now().date()
    cur.execute("SELECT practiced_on FROM practice_days WHERE user_id = ? ORDER BY practiced_on DESC LIMIT 400", (user_id,))
    practice_dates = {datetime.strptime(row["practiced_on"], "%Y-%m-%d").date() for row in cur.fetchall()}
    practiced_today = today in practice_dates
    streak_days = 0
    streak_day = today if practiced_today else today - timedelta(days=1)
    while streak_day in practice_dates:
        streak_days += 1
        streak_day -= timedelta(days=1)

    identities = cur.execute(
        "SELECT provider FROM auth_identities WHERE user_id = ? ORDER BY created_at",
        (user_id,),
    ).fetchall()
    providers = list(dict.fromkeys(row["provider"] for row in identities))
    auth_provider = providers[0] if providers else "email"
    max_bot = cur.execute(
        "SELECT reminder_time, reminder_enabled, summaries_enabled FROM max_connections WHERE user_id = ?",
        (user_id,),
    ).fetchone()

    conn.close()
    return {
        "id": user["id"],
        "email": None if user["email"].endswith("@users.invalid") else user["email"],
        "auth_provider": auth_provider,
        "auth_providers": providers,
        "password_enabled": bool(user["password_enabled"]),
        "username": user["username"],
        "leaderboard_public": bool(user["leaderboard_public"]),
        "xp": user["xp"],
        "level": user["level"],
        "next_level_xp": user["level"] * 500,
        "total_sessions": user["total_sessions"],
        "total_time_sec": user["total_time_sec"],
        "best_wpm": round_half_up(stats_row["best_wpm"] or 0, 1),
        "best_cpm": round_half_up(stats_row["best_cpm"] or 0),
        "avg_accuracy": round_half_up(stats_row["avg_acc"] if stats_row["avg_acc"] is not None else 100.0, 1),
        "ranked_sessions": stats_row["ranked_sessions"],
        "legacy_sessions": stats_row["legacy_sessions"] or 0,
        "sessions": sessions,
        "hardest_chars": hardest_chars,
        "achievements": achievements,
        "streak_days": streak_days,
        "practiced_today": practiced_today,
        "max_bot_configured": MAX_BOT_READY,
        "max_connected": bool(max_bot),
        "max_reminder_time": max_bot["reminder_time"] if max_bot else "20:00",
        "max_reminder_enabled": bool(max_bot["reminder_enabled"]) if max_bot else False,
        "max_summaries_enabled": bool(max_bot["summaries_enabled"]) if max_bot else False,
    }


class LeaderboardVisibilityRequest(BaseModel):
    leaderboard_public: bool


class EmailChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    email: str = Field(min_length=6, max_length=254)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        try:
            return normalize_email(value)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc


class UsernameChangeRequest(BaseModel):
    current_password: str | None = Field(default=None, max_length=128)
    username: str = Field(min_length=2, max_length=24)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[\w.-]{2,24}", value, flags=re.UNICODE) or not value[0].isalnum():
            raise ValueError("Никнейм: 2–24 буквы, цифры, точка, дефис или подчёркивание")
        return value


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


@router.put("/api/profile/leaderboard-visibility")
def update_leaderboard_visibility(req: LeaderboardVisibilityRequest, request: Request):
    user_id = get_current_user_id(request)
    conn = get_db()
    conn.execute(
        "UPDATE users SET leaderboard_public = ? WHERE id = ?",
        (int(req.leaderboard_public), user_id)
    )
    conn.commit()
    conn.close()
    return get_user_profile(user_id)


@router.put("/api/profile/email")
def update_profile_email(req: EmailChangeRequest, request: Request):
    user_id = get_current_user_id(request)
    conn = get_db()
    row = conn.execute(
        "SELECT email, password_hash FROM users WHERE id = ?",
        (user_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    valid, _ = verify_password(req.current_password, row["password_hash"])
    if not valid:
        conn.close()
        raise HTTPException(status_code=401, detail="Текущий пароль неверен")
    try:
        conn.execute("UPDATE users SET email = ? WHERE id = ?", (req.email, user_id))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=409, detail="Этот email уже используется")
    conn.close()
    return get_user_profile(user_id)


@router.put("/api/profile/username")
def update_profile_username(req: UsernameChangeRequest, request: Request):
    user_id = get_current_user_id(request)
    conn = get_db()
    row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    identity = conn.execute("SELECT password_enabled FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    valid = not bool(identity["password_enabled"])
    if not valid and req.current_password:
        valid, _ = verify_password(req.current_password, row["password_hash"])
    if not valid:
        conn.close()
        raise HTTPException(status_code=401, detail="Текущий пароль неверен")
    conn.execute("UPDATE users SET username = ? WHERE id = ?", (req.username, user_id))
    conn.commit()
    conn.close()
    return get_user_profile(user_id)


@router.put("/api/profile/password")
def update_profile_password(req: PasswordChangeRequest, request: Request):
    user_id = get_current_user_id(request)
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Войдите в аккаунт")
    current_token_hash = hashlib.sha256(token.encode()).hexdigest()
    conn = get_db()
    row = conn.execute(
        "SELECT password_hash FROM users WHERE id = ?",
        (user_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    valid, _ = verify_password(req.current_password, row["password_hash"])
    if not valid:
        conn.close()
        raise HTTPException(status_code=401, detail="Текущий пароль неверен")
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(req.new_password), user_id))
    conn.execute(
        "DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?",
        (user_id, current_token_hash)
    )
    conn.commit()
    conn.close()
    return {"ok": True}
