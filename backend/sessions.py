"""Verified result storage shared by solo practice and multiplayer races."""
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field

from .config import ACHIEVEMENTS_CONFIG, calculate_level, local_now
from .db import get_db
from .metrics import earned_xp, public_metrics, replay_keystrokes
from .notifications import deliver_max_session_summary
from .profiles import get_user_profile
from .security import get_current_user_id

router = APIRouter()


class Keystroke(BaseModel):
    key: str = Field(min_length=1, max_length=9)
    at_ms: float = Field(ge=0, le=3_600_000, allow_inf_nan=False)


class SessionCreateRequest(BaseModel):
    # Race submissions are accepted only by the authenticated room endpoint.
    mode: str = Field(pattern="^(words|sentences|code|symbols|custom)$")
    difficulty: str = Field(default="medium", pattern="^(easy|medium|hard)$")
    lang: str = Field(pattern="^(ru|en)$")
    target_text: str = Field(min_length=1, max_length=5000)
    typed_text: str = Field(min_length=1, max_length=5000)
    duration_ms: float = Field(ge=1, le=3_600_000, allow_inf_nan=False)
    keystrokes: list[Keystroke] = Field(min_length=1, max_length=20000)
    client_session_id: str = Field(min_length=8, max_length=128, pattern="^[A-Za-z0-9:_-]+$")


def stored_metrics(row) -> dict:
    """Reconstruct the public result from exactly what was persisted."""
    fields = ("wpm", "cpm", "accuracy", "errors", "score", "max_combo", "max_streak",
              "duration_sec", "duration_ms", "correct_characters", "correct_keystrokes",
              "total_keystrokes", "target_length", "metrics_version")
    result = {name: row[name] for name in fields}
    result["is_ranked"] = bool(row["is_ranked"])
    result["ranking_reason"] = row["ranking_reason"]
    return public_metrics(result)


def save_verified_result(*, user_id: int, mode: str, difficulty: str, lang: str,
                         metrics: dict, client_session_id: str, conn=None) -> dict:
    """Persist once, atomically. A supplied connection belongs to the caller.

    Callers must use replay_keystrokes or another server-controlled calculation
    before invoking this internal hook; it is not a public metrics endpoint.
    """
    owns_connection = conn is None
    conn = conn or get_db()
    try:
        if owns_connection:
            conn.execute("BEGIN IMMEDIATE")
        previous = conn.execute(
            "SELECT * FROM sessions WHERE user_id = ? AND client_session_id = ?",
            (user_id, client_session_id),
        ).fetchone()
        if previous:
            return {"session_id": previous["id"], "metrics": stored_metrics(previous),
                    "xp_earned": previous["xp_earned"], "newly_unlocked": [], "created": False}
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Пользователь не найден")

        xp_earned = earned_xp(metrics, mode)
        cursor = conn.execute("""
            INSERT INTO sessions
            (user_id, mode, difficulty, lang, wpm, cpm, accuracy, errors, score,
             xp_earned, duration_sec, max_combo, duration_ms, correct_characters,
             correct_keystrokes, total_keystrokes, target_length, metrics_version,
             is_ranked, client_session_id, max_streak, ranking_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
        """, (user_id, mode, difficulty, lang, metrics["wpm"], metrics["cpm"],
              metrics["accuracy"], metrics["errors"], metrics["score"], xp_earned,
              metrics["duration_sec"], metrics["max_combo"], metrics["duration_ms"],
              metrics["correct_characters"], metrics["correct_keystrokes"],
              metrics["total_keystrokes"], metrics["target_length"],
              int(metrics["is_ranked"]), client_session_id, metrics["max_streak"], metrics.get("ranking_reason")))
        # Capture the session ID before any other INSERT changes last_insert_rowid.
        session_id = cursor.lastrowid
        for char, count in metrics["error_chars"].items():
            conn.execute("""
                INSERT INTO char_errors (user_id, char, error_count) VALUES (?, ?, ?)
                ON CONFLICT(user_id, char) DO UPDATE SET error_count = error_count + excluded.error_count
            """, (user_id, char, count))
        for char, count in metrics["char_attempts"].items():
            conn.execute("""
                INSERT INTO char_attempts (user_id, char, attempt_count) VALUES (?, ?, ?)
                ON CONFLICT(user_id, char) DO UPDATE SET attempt_count = attempt_count + excluded.attempt_count
            """, (user_id, char, count))

        new_xp = user["xp"] + xp_earned
        new_sessions = user["total_sessions"] + 1
        new_flawless = user["flawless_chars"] + (metrics["correct_characters"] if metrics["errors"] == 0 else 0)
        new_max_streak = max(user["max_streak_ever"], metrics["max_streak"])
        conn.execute("""
            UPDATE users SET xp = ?, level = ?, total_sessions = ?, total_time_sec = ?,
                             flawless_chars = ?, max_streak_ever = ? WHERE id = ?
        """, (new_xp, calculate_level(new_xp), new_sessions,
              user["total_time_sec"] + metrics["duration_sec"], new_flawless, new_max_streak, user_id))
        conn.execute("INSERT OR IGNORE INTO practice_days (user_id, practiced_on) VALUES (?, ?)",
                     (user_id, local_now().date().isoformat()))
        existing = {row["achievement_id"] for row in conn.execute(
            "SELECT achievement_id FROM user_achievements WHERE user_id = ?", (user_id,))}
        checks = {
            "first_step": new_sessions >= 1,
            "speed_200_cpm": metrics["is_ranked"] and metrics["cpm"] >= 200,
            "typing_genius": metrics["is_ranked"] and metrics["wpm"] >= 300,
            "steel_finger": new_max_streak >= 1000,
            "flawless_1000": new_flawless >= 1000,
            "combo_master": metrics["max_combo"] >= 5,
        }
        newly_unlocked = []
        for achievement in ACHIEVEMENTS_CONFIG:
            if checks[achievement["id"]] and achievement["id"] not in existing:
                conn.execute("INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)",
                             (user_id, achievement["id"]))
                newly_unlocked.append(achievement)
        saved = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if owns_connection:
            conn.commit()
        return {"session_id": session_id, "metrics": stored_metrics(saved), "xp_earned": xp_earned,
                "newly_unlocked": newly_unlocked, "created": True}
    except Exception:
        if owns_connection:
            conn.rollback()
        raise
    finally:
        if owns_connection:
            conn.close()


@router.post("/api/session")
def save_session(req: SessionCreateRequest, request: Request, background_tasks: BackgroundTasks):
    user_id = get_current_user_id(request)
    events = [event.model_dump() for event in req.keystrokes]
    try:
        if events[0]["at_ms"] != 0 or req.duration_ms != max(1, events[-1]["at_ms"]):
            raise ValueError("Продолжительность должна совпадать со временем последнего нажатия")
        metrics = replay_keystrokes(req.target_text, events, req.duration_ms, req.typed_text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = save_verified_result(user_id=user_id, mode=req.mode, difficulty=req.difficulty,
                                  lang=req.lang, metrics=metrics, client_session_id=req.client_session_id)
    profile = get_user_profile(user_id)
    profile["newly_unlocked"] = result["newly_unlocked"]
    if result["created"]:
        background_tasks.add_task(deliver_max_session_summary, user_id,
                                  {"mode": req.mode, **result["metrics"], "xp_earned": result["xp_earned"]})
    return {**result, "profile": profile}
