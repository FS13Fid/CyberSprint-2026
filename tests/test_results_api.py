"""API tests use a temporary database and no external services."""
from datetime import datetime, timedelta, timezone
import sqlite3
import uuid
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
import pytest

from backend import db
from main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "results.db")
    db.init_db()
    with TestClient(app) as instance:
        yield instance


def register(client, name="Player", public=True):
    response = client.post("/api/auth/register", json={
        "email": f"{name.lower()}@example.test", "username": name,
        "password": "sample-password", "leaderboard_public": public,
    })
    assert response.status_code == 200, response.text
    return response.json()


def payload(text="abcdefghij", duration=6000, mode="words", typed=None, identifier=None):
    typed = typed if typed is not None else text
    return {
        "mode": mode, "difficulty": "medium", "lang": "en",
        "target_text": text, "typed_text": typed, "duration_ms": duration,
        "client_session_id": identifier or str(uuid.uuid4()),
        "keystrokes": [{"key": char, "at_ms": round(index * duration / max(1, len(typed) - 1))}
                       for index, char in enumerate(typed)],
    }


def save(client, **kwargs):
    response = client.post("/api/session", json=payload(**kwargs))
    assert response.status_code == 200, response.text
    return response.json()


def test_session_history_progress_and_custom_leaderboard_share_metrics(client):
    register(client)
    result = save(client, mode="custom", duration=3000)
    metrics = result["metrics"]
    history = result["profile"]["sessions"][-1]
    board = client.get("/api/leaderboard", params={"mode": "custom", "sort_by": "cpm"}).json()
    assert metrics["cpm"] == history["cpm"] == result["profile"]["best_cpm"] == board[0]["best_cpm"] == 200
    assert metrics["wpm"] == history["wpm"] == result["profile"]["best_wpm"] == board[0]["best_wpm"] == 40
    assert board[0]["period_xp"] == history["xp_earned"] == result["xp_earned"] > 0
    assert history["mode"] == "custom"
    assert history["metrics_version"] == 2
    assert history["is_ranked"] is True


def test_replayed_metrics_ignore_fabricated_client_totals_and_have_no_cap(client):
    register(client)
    request = payload(text="a" * 105, duration=3000)
    request.update(wpm=999999, cpm=999999, accuracy=0, score=99999999, xp_bonus_score=99999999)
    response = client.post("/api/session", json=request)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["metrics"]["wpm"] == 420
    assert result["metrics"]["cpm"] == 2100
    assert result["metrics"]["accuracy"] == 100
    assert result["xp_earned"] < 10000


def test_retry_is_idempotent_and_does_not_update_another_session_xp(client):
    first_user = register(client, "First")
    first = save(client, text="abcdefghij", duration=3000)
    second_user = register(client, "Second")
    request = payload(text="zyxwvutsrq", duration=4000, typed="xyxwvutsrq")
    second = client.post("/api/session", json=request).json()
    repeat = client.post("/api/session", json=request).json()
    assert repeat["created"] is False
    assert repeat["session_id"] == second["session_id"]
    assert repeat["xp_earned"] == second["xp_earned"]
    assert repeat["profile"]["total_sessions"] == 1
    with db.get_db() as conn:
        rows = [dict(row) for row in conn.execute("SELECT user_id, xp_earned FROM sessions ORDER BY id")]
        assert rows == [{"user_id": first_user["id"], "xp_earned": first["xp_earned"]},
                        {"user_id": second_user["id"], "xp_earned": second["xp_earned"]}]
        assert conn.execute("SELECT SUM(error_count) FROM char_errors WHERE user_id=?", (second_user["id"],)).fetchone()[0] == 1


def test_zero_accuracy_not_replaced_with_one_hundred_and_no_free_xp(client):
    register(client)
    result = save(client, typed="xxxxxxxxxx")
    assert result["metrics"]["accuracy"] == result["profile"]["avg_accuracy"] == 0
    assert result["profile"]["sessions"][-1]["accuracy"] == 0
    assert result["xp_earned"] == 0


def test_short_custom_in_history_but_not_a_fake_speed_record(client):
    register(client)
    result = save(client, text="я", typed="я", duration=1, mode="custom")
    assert result["metrics"]["cpm"] == 60000
    assert result["metrics"]["is_ranked"] is False
    assert result["profile"]["total_sessions"] == 1
    assert result["profile"]["best_cpm"] == 0
    assert result["profile"]["ranked_sessions"] == 0
    assert result["profile"]["sessions"][0]["ranking_reason"]
    assert client.get("/api/leaderboard").json() == []


def test_leaderboard_filters_order_privacy_and_stable_ties(client):
    register(client, "Alice")
    save(client, mode="custom", duration=3000)
    register(client, "Bob")
    old = save(client, mode="words", duration=3000)
    save(client, mode="custom", duration=6000)
    register(client, "Carol")
    save(client, mode="custom", duration=6000)
    register(client, "Private", public=False)
    save(client, mode="custom", duration=3000)
    with db.get_db() as conn:
        conn.execute("UPDATE sessions SET created_at = ? WHERE id = ?",
                     ((datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%d %H:%M:%S"), old["session_id"]))
    custom = client.get("/api/leaderboard", params={"mode": "custom", "sort_by": "cpm"}).json()
    assert [row["username"] for row in custom] == ["Alice", "Bob", "Carol"]
    assert [row["rank"] for row in custom] == [1, 2, 3]
    assert [row["best_cpm"] for row in custom] == [200, 100, 100]
    ascending = client.get("/api/leaderboard", params={"mode": "custom", "order": "asc"}).json()
    assert [row["username"] for row in ascending] == ["Carol", "Bob", "Alice"]
    assert [row["rank"] for row in ascending] == [3, 2, 1]
    assert client.get("/api/leaderboard", params={"mode": "words", "period": "week"}).json() == []
    assert len(client.get("/api/leaderboard", params={"mode": "words", "period": "all"}).json()) == 1
    assert client.get("/api/leaderboard", params={"sort_by": "DROP TABLE users"}).status_code == 422
    assert client.get("/api/leaderboard", params={"mode": "unknown"}).status_code == 422


def test_rejects_invalid_trace_duration_incomplete_and_direct_race(client):
    register(client)
    invalid = payload()
    invalid["duration_ms"] += 1
    assert client.post("/api/session", json=invalid).status_code == 422
    assert client.post("/api/session", json=payload(typed="abc")).status_code == 422
    assert client.post("/api/session", json=payload(mode="race")).status_code == 422
    invalid = payload()
    invalid["typed_text"] = "zzzzzzzzzz"
    assert client.post("/api/session", json=invalid).status_code == 422


def test_migrations_preserve_historical_metrics_and_opt_in(client):
    user = register(client)
    with db.get_db() as conn:
        conn.execute("""INSERT INTO sessions(user_id, mode, lang, wpm, cpm, accuracy, errors,
                     score, xp_earned, duration_sec, max_combo) VALUES (?, 'custom', 'ru', 17.2, 86, 0, 10, 0, 0, 7, 1)""", (user["id"],))
    db.init_db()
    db.init_db()
    profile = client.get("/api/auth/me").json()
    assert profile["sessions"][0]["wpm"] == 17.2
    assert profile["sessions"][0]["cpm"] == 86
    assert profile["sessions"][0]["metrics_version"] == 1
    assert profile["sessions"][0]["duration_ms"] is None
    assert profile["legacy_sessions"] == 1
    assert client.get("/api/leaderboard").json()[0]["legacy_sessions"] == 1


def test_upgrade_from_original_schema_preserves_rows_and_adds_columns(tmp_path, monkeypatch):
    path = tmp_path / "old-version.db"
    monkeypatch.setattr(db, "DB_PATH", path)
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT NOT NULL,
                password_hash TEXT NOT NULL, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 1,
                total_sessions INTEGER DEFAULT 0, total_time_sec INTEGER DEFAULT 0,
                flawless_chars INTEGER DEFAULT 0, max_streak_ever INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE sessions (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, mode TEXT NOT NULL,
                lang TEXT NOT NULL, wpm REAL NOT NULL, cpm REAL NOT NULL, accuracy REAL NOT NULL,
                errors INTEGER NOT NULL, score INTEGER NOT NULL, xp_earned INTEGER NOT NULL,
                duration_sec INTEGER NOT NULL, max_combo INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id));
            INSERT INTO users(id,email,username,password_hash,xp,total_sessions,total_time_sec)
            VALUES(7,'legacy@example.test','Legacy','oldhash',50,1,10);
            INSERT INTO sessions(id,user_id,mode,lang,wpm,cpm,accuracy,errors,score,xp_earned,duration_sec,max_combo)
            VALUES(9,7,'custom','ru',20,100,80,5,100,50,10,3);
        """)
    db.init_db()
    db.init_db()
    with db.get_db() as conn:
        old = dict(conn.execute("SELECT * FROM sessions WHERE id=9").fetchone())
        assert (old["wpm"], old["cpm"], old["accuracy"], old["xp_earned"]) == (20, 100, 80, 50)
        assert old["metrics_version"] == 1
        assert old["duration_ms"] is None
        assert old["difficulty"] == "medium"
        assert old["client_session_id"] is None
        assert conn.execute("SELECT leaderboard_public FROM users WHERE id=7").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


def test_authentication_and_profile_settings_survive_module_split(client):
    user = register(client)
    assert client.get(f"/api/user/{user['id']}").status_code == 200
    assert client.get("/api/user/9999").status_code == 404
    response = client.put("/api/profile/username", json={"username": "Renamed", "current_password": "sample-password"})
    assert response.status_code == 200
    assert response.json()["username"] == "Renamed"
    response = client.put("/api/profile/email", json={"email": "changed@example.test", "current_password": "sample-password"})
    assert response.status_code == 200
    response = client.put("/api/profile/password", json={"new_password": "different-password", "current_password": "sample-password"})
    assert response.status_code == 200
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    response = client.post("/api/auth/login", json={"email": "changed@example.test", "password": "different-password"})
    assert response.status_code == 200
    assert response.json()["id"] == user["id"]
    assert client.put("/api/profile/leaderboard-visibility", json={"leaderboard_public": False}).json()["leaderboard_public"] is False
    assert client.get("/api/auth/providers").status_code == 200
    assert client.get("/api/push/config").status_code == 404
    assert client.post("/api/profile/push/subscription", json={}).status_code == 404
    assert client.get("/api/push/config").status_code == 200


def test_practice_days_use_local_date_and_do_not_grow_after_restart(client, monkeypatch):
    monkeypatch.setattr(db, "APP_TIMEZONE", ZoneInfo("Europe/Moscow"))
    user = register(client)
    saved = save(client)
    with db.get_db() as conn:
        conn.execute("UPDATE sessions SET created_at = '2026-10-19 21:30:00' WHERE id = ?", (saved["session_id"],))
        conn.execute("DELETE FROM practice_days")
        # This is the erroneous UTC date produced by the previous migration.
        conn.execute("INSERT INTO practice_days(user_id, practiced_on) VALUES (?, '2026-10-19')", (user["id"],))
    db.init_db()
    db.init_db()
    with db.get_db() as conn:
        assert [row["practiced_on"] for row in conn.execute("SELECT practiced_on FROM practice_days WHERE user_id = ?", (user["id"],))] == ["2026-10-20"]
        assert conn.execute("SELECT created_at FROM sessions WHERE id = ?", (saved["session_id"],)).fetchone()[0] == "2026-10-19 21:30:00"
