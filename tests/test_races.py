"""Race rules with deterministic clocks, real SQLite transactions and key replay."""

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend import db, races
from backend.races import (
    COUNTDOWN_MS,
    DISCONNECT_MS,
    ERROR_PENALTY_MS,
    RaceService,
    init_race_schema,
)
from main import app


class RaceServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "races.db"
        self.now = 1_000_000
        self.saved = []
        conn = self.db()
        conn.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
            INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');
            CREATE TABLE results (id INTEGER PRIMARY KEY, user_id INTEGER, payload TEXT,
                                  result_key TEXT UNIQUE);
        """)
        init_race_schema(conn)
        conn.close()
        self.service = RaceService(self.db, self.save, clock=lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    def db(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def save(self, *, conn, user_id, mode, metrics, client_session_id, **kwargs):
        self.assertEqual(mode, "race")
        self.assertTrue(conn.in_transaction)
        existing = conn.execute("SELECT id FROM results WHERE result_key=?", (client_session_id,)).fetchone()
        if existing:
            return {"session_id": existing["id"], "metrics": metrics, "created": False}
        cursor = conn.execute("INSERT INTO results (user_id,payload,result_key) VALUES (?,?,?)",
                              (user_id, json.dumps(metrics), client_session_id))
        self.saved.append({"user_id": user_id, "metrics": metrics})
        return {"session_id": cursor.lastrowid, "metrics": metrics, "created": True}

    def room(self, text="abcdefghij"):
        room = self.service.create(1, "en")
        self.code = room["code"]
        conn = self.db()
        conn.execute("UPDATE race_rooms SET target_text=? WHERE code=?", (text, self.code))
        conn.commit()
        conn.close()
        joined = self.service.join(self.code.lower(), 2)
        self.start = joined["starts_ms"]
        self.now = self.start
        return joined

    @staticmethod
    def events(text, duration=5000):
        return [{"key": key, "at_ms": round((index + 1) * duration / len(text))}
                for index, key in enumerate(text)]

    def test_two_real_players_share_text_and_countdown_and_room_is_private(self):
        room = self.room()
        self.assertEqual(room["starts_ms"], room["server_now_ms"] + COUNTDOWN_MS)
        self.assertEqual([p["user_id"] for p in room["players"]], [1, 2])
        self.assertEqual(self.service.read(self.code, 1)["target_text"], room["target_text"])
        with self.assertRaises(HTTPException) as denied:
            self.service.read(self.code, 3)
        self.assertEqual(denied.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            self.service.join(self.code, 3)
        self.now = self.start - 1
        with self.assertRaises(HTTPException):
            self.service.progress(self.code, 1, "a", self.events("a", 1), 1)

    def test_error_advances_and_penalty_can_change_the_winner(self):
        self.room()
        self.now = self.start + 5_000
        first, saved = self.service.progress(self.code, 1, "xbcdefghij", self.events("xbcdefghij"), 1)
        first_player = first["players"][0]
        self.assertEqual(first_player["characters"], 10)
        self.assertEqual(first_player["metrics"]["accuracy"], 90)
        self.assertEqual(first_player["metrics"]["cpm"], 108)
        self.assertEqual(first_player["finish_ms"], self.now + ERROR_PENALTY_MS)
        self.assertIsNone(first["winner_id"])
        self.assertTrue(saved["created"])
        self.now += 250
        self.service.progress(self.code, 2, "abcdefghij", self.events("abcdefghij", 5250), 1)
        self.now += 1
        second = self.service.read(self.code, 2)
        self.assertEqual(second["winner_id"], 2)
        self.assertEqual(second["state"], "finished")
        self.assertEqual(len(self.saved), 2)

    def test_server_duration_and_final_metrics_are_immutable_and_saved_once(self):
        self.room()
        self.now = self.start + 10_000
        result, _ = self.service.progress(self.code, 1, "abcdefghij", self.events("abcdefghij", 5000), 1)
        metrics = result["players"][0]["metrics"]
        self.assertEqual(metrics["duration_ms"], 10_000)
        self.assertEqual(metrics["cpm"], 60)
        self.now += 30_000
        result, duplicate = self.service.progress(self.code, 1, "zzzzzzzzzz", self.events("zzzzzzzzzz"), 2)
        self.assertIsNone(duplicate)
        self.assertEqual(result["players"][0]["metrics"], metrics)
        self.assertEqual(len(self.saved), 1)
        conn = self.db()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], 1)
        conn.close()

    def test_stale_requests_do_not_move_car_back_and_trace_cannot_be_rewritten(self):
        self.room()
        self.now = self.start + 2_000
        events = self.events("abc", 1800)
        self.service.progress(self.code, 1, "abc", events, 2)
        snapshot, _ = self.service.progress(self.code, 1, "a", events[:1], 1)
        self.assertEqual(snapshot["players"][0]["characters"], 3)
        with self.assertRaises(HTTPException):
            self.service.progress(self.code, 1, "xbc", self.events("xbc", 1800), 3)
        with self.assertRaises(HTTPException):
            self.service.progress(self.code, 1, "abcd", events + [{"key": "d", "at_ms": 50_000}], 4)

    def test_low_accuracy_does_not_win_or_enter_rankings(self):
        self.room()
        self.now = self.start + 4_000
        snapshot, _ = self.service.progress(self.code, 1, "xxxdefghij", self.events("xxxdefghij", 4000), 1)
        self.assertFalse(snapshot["players"][0]["qualified"])
        self.assertIsNone(snapshot["players"][0]["finish_ms"])
        self.assertFalse(self.saved[0]["metrics"]["is_ranked"])
        self.assertIsNone(snapshot["winner_id"])
        self.now += 500
        self.service.progress(self.code, 2, "abcdefghij", self.events("abcdefghij", 4500), 1)
        self.now += 1
        snapshot = self.service.read(self.code, 2)
        self.assertEqual(snapshot["winner_id"], 2)

    def test_both_low_accuracy_end_without_winner(self):
        self.room()
        self.now = self.start + 4_000
        self.service.progress(self.code, 1, "xxxxxxxxxx", self.events("xxxxxxxxxx", 4000), 1)
        snapshot, _ = self.service.progress(self.code, 2, "xxxxxxxxxx", self.events("xxxxxxxxxx", 4000), 1)
        self.assertEqual(snapshot["state"], "finished")
        self.assertEqual(snapshot["outcome"], "no_qualifier")
        self.assertIsNone(snapshot["winner_id"])
        self.assertEqual(len(self.saved), 2)

    def test_accuracy_threshold_is_inclusive_and_equal_finishes_draw(self):
        self.room()
        self.now = self.start + 4_000
        self.service.progress(self.code, 1, "xxcdefghij", self.events("xxcdefghij", 4000), 1)
        self.service.progress(self.code, 2, "xxcdefghij", self.events("xxcdefghij", 4000), 1)
        self.now += 1001
        snapshot = self.service.read(self.code, 1)
        self.assertTrue(snapshot["players"][0]["qualified"])
        self.assertEqual(snapshot["outcome"], "draw")
        self.assertIsNone(snapshot["winner_id"])

    def test_disconnect_forfeit_does_not_create_fake_typing_result(self):
        self.room()
        self.now += DISCONNECT_MS // 2
        self.service.read(self.code, 1)
        self.now += DISCONNECT_MS // 2 + 1
        snapshot = self.service.read(self.code, 1)
        self.assertEqual(snapshot["winner_id"], 1)
        self.assertEqual(snapshot["outcome"], "forfeit")
        self.assertEqual(len(self.saved), 0)
        with self.assertRaises(HTTPException):
            self.service.progress(self.code, 2, "a", self.events("a", 100), 1)

    def test_leave_then_new_room_and_expiry(self):
        self.room()
        self.service.leave(self.code, 1)
        with self.assertRaises(HTTPException):
            self.service.join(self.code, 1)
        new_room = self.service.create(1, "ru")
        self.assertNotEqual(new_room["code"], self.code)
        self.now = new_room["expires_ms"] + 1
        snapshot = self.service.read(new_room["code"], 1)
        self.assertEqual(snapshot["state"], "expired")

    def test_player_key_trace_is_not_exposed_to_opponent(self):
        self.room()
        self.now = self.start + 1000
        self.service.progress(self.code, 1, "x", self.events("x", 1000), 1)
        snapshot = self.service.read(self.code, 2)
        opponent = snapshot["players"][0]
        self.assertNotIn("keystrokes", opponent)
        self.assertNotIn("typed_text", opponent)
        self.assertNotIn("typed_text", opponent["metrics"])
        self.assertNotIn("char_attempts", opponent["metrics"])
        self.assertNotIn("error_chars", opponent["metrics"])


@pytest.fixture
def api_race(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "race-api.db")
    db.init_db()
    with db.get_db() as conn:
        init_race_schema(conn)
    now = [2_000_000]
    monkeypatch.setattr(races.time, "time_ns", lambda: now[0] * 1_000_000)
    with TestClient(app) as first, TestClient(app) as second:
        for index, client in enumerate((first, second)):
            response = client.post("/api/auth/register", json={
                "email": f"race-{index}@example.test", "username": f"Racer{index}",
                "password": "sample-password", "leaderboard_public": index == 0,
            })
            assert response.status_code == 200, response.text
        response = first.post("/api/races", json={"lang": "en"})
        assert response.status_code == 200, response.text
        room = response.json()
        response = second.post(f"/api/races/{room['code']}/join")
        assert response.status_code == 200, response.text
        yield first, second, response.json(), now


def api_finish(first, second, room, now, typed=None):
    typed = typed if typed is not None else room["target_text"]
    duration = len(typed) * 300
    # Both participants poll while typing. No wall-clock sleeps in the test.
    now[0] = room["starts_ms"] + duration // 2
    first.get(f"/api/races/{room['code']}")
    second.get(f"/api/races/{room['code']}")
    now[0] = room["starts_ms"] + duration
    response = first.put(f"/api/races/{room['code']}/progress", json={
        "typed_text": typed, "keystrokes": RaceServiceTests.events(typed, duration), "client_seq": 1,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_race_api_real_auth_metrics_history_and_leaderboard_are_identical(api_race):
    first, second, room, now = api_race
    result = api_finish(first, second, room, now)
    metrics = result["players"][0]["metrics"]
    saved = result["saved_result"]
    history = result["profile"]["sessions"][-1]
    board = first.get("/api/leaderboard", params={"mode": "race", "sort_by": "cpm"}).json()
    assert metrics["cpm"] == saved["metrics"]["cpm"] == history["cpm"] == board[0]["best_cpm"] == 200
    assert metrics["wpm"] == saved["metrics"]["wpm"] == history["wpm"] == board[0]["best_wpm"] == 40
    assert history["mode"] == "race"
    assert history["is_ranked"] is True
    assert first.get("/api/leaderboard", params={"mode": "custom"}).json() == []
    now[0] += 1
    settled = second.get(f"/api/races/{room['code']}").json()
    assert settled["winner_id"] == result["players"][0]["user_id"]
    retry = first.put(f"/api/races/{room['code']}/progress", json={
        "typed_text": room["target_text"],
        "keystrokes": RaceServiceTests.events(room["target_text"], len(room["target_text"]) * 300),
        "client_seq": 2,
    })
    assert retry.status_code == 200
    assert first.get("/api/auth/me").json()["total_sessions"] == 1


def test_race_api_opponent_is_real_private_and_may_finish_after_winner(api_race):
    first, second, room, now = api_race
    result = api_finish(first, second, room, now)
    assert result["players"][1]["characters"] == 0
    assert not result["players"][1]["metrics"]
    now[0] += 1000
    duration = now[0] - room["starts_ms"]
    response = second.put(f"/api/races/{room['code']}/progress", json={
        "typed_text": room["target_text"],
        "keystrokes": RaceServiceTests.events(room["target_text"], duration), "client_seq": 1,
    })
    assert response.status_code == 200, response.text
    assert response.json()["profile"]["total_sessions"] == 1
    board = first.get("/api/leaderboard", params={"mode": "race"}).json()
    assert [row["username"] for row in board] == ["Racer0"]
    second.put("/api/profile/leaderboard-visibility", json={"leaderboard_public": True})
    board = first.get("/api/leaderboard", params={"mode": "race"}).json()
    assert [row["username"] for row in board] == ["Racer0", "Racer1"]


def test_race_api_low_accuracy_persists_reason_without_fake_record(api_race):
    first, second, room, now = api_race
    result = api_finish(first, second, room, now, "#" * len(room["target_text"]))
    session = result["profile"]["sessions"][-1]
    assert session["accuracy"] == 0
    assert session["cpm"] == 0
    assert session["is_ranked"] is False
    assert "80%" in session["ranking_reason"]
    assert result["profile"]["total_sessions"] == 1
    assert first.get("/api/leaderboard", params={"mode": "race"}).json() == []


if __name__ == "__main__":
    unittest.main()
