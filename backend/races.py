"""Two-player typing races with server clocks and persistent SQLite rooms.

The browser submits an append-only key trace. It never submits a speed, winner,
or car position. Every room transition and result insert uses one transaction.
"""

import json
import secrets
import time
import uuid

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .metrics import public_metrics, replay_keystrokes

COUNTDOWN_MS = 3_000
ERROR_PENALTY_MS = 500
MIN_RACE_ACCURACY = 80
WAIT_TTL_MS = 10 * 60_000
RACE_TTL_MS = 15 * 60_000
DISCONNECT_MS = 60_000
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

RACE_TEXTS = {
    "ru": [
        "На старте важно сохранять спокойствие. Смотри на текст, держи ровный ритм и двигайся к финишу. Точные движения помогают набрать скорость, а практика делает каждый новый круг увереннее.",
        "Дорога ведет вперед, и каждый знак приближает к цели. Не торопись на поворотах, замечай пробелы и знаки. Побеждает тот, кто умеет сочетать хороший темп и точность движений.",
        "За окном светит солнце, а на трассе начинается новая гонка. Машина слушается твоих пальцев. Набирай текст в своем ритме, следи за точностью и постарайся первым пересечь линию финиша.",
    ],
    "en": [
        "Stay calm at the starting line. Follow the text, find a steady rhythm, and move toward the finish. Accurate movements help you build speed, and daily practice makes every new lap feel more natural.",
        "The road stretches ahead and every letter brings you closer to the goal. Watch the spaces and keep a steady pace through each turn. A good driver combines speed with accuracy all the way to the finish.",
        "The sun is shining and a new race is about to begin. Your fingers control the car on the track. Type at a comfortable pace, pay attention to every word, and see who reaches the finish line first.",
    ],
}


class RaceCreate(BaseModel):
    lang: str = Field(default="ru", pattern="^(ru|en)$")


class RaceKey(BaseModel):
    key: str = Field(min_length=1, max_length=16)
    at_ms: float = Field(ge=0, allow_inf_nan=False)


class RaceProgress(BaseModel):
    typed_text: str = Field(max_length=1_000)
    keystrokes: list[RaceKey] = Field(max_length=4_000)
    client_seq: int = Field(ge=1)


def init_race_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS race_rooms (
            code TEXT PRIMARY KEY,
            lang TEXT NOT NULL,
            target_text TEXT NOT NULL,
            created_ms INTEGER NOT NULL,
            starts_ms INTEGER,
            expires_ms INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'waiting',
            winner_id INTEGER,
            outcome TEXT
        );
        CREATE TABLE IF NOT EXISTS race_players (
            code TEXT NOT NULL REFERENCES race_rooms(code) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            slot INTEGER NOT NULL,
            joined_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            left_ms INTEGER,
            typed_text TEXT NOT NULL DEFAULT '',
            events_json TEXT NOT NULL DEFAULT '[]',
            client_seq INTEGER NOT NULL DEFAULT 0,
            completed_ms INTEGER,
            finish_ms INTEGER,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            session_id INTEGER,
            PRIMARY KEY (code, user_id),
            UNIQUE (code, slot)
        );
        CREATE INDEX IF NOT EXISTS race_player_user_idx ON race_players(user_id);
        CREATE INDEX IF NOT EXISTS race_room_expiry_idx ON race_rooms(expires_ms);
    """)
    conn.commit()


class RaceService:
    """Persistence and rules separated from HTTP for deterministic tests."""

    def __init__(self, get_db, save_verified_result, clock=None):
        self.get_db = get_db
        self.save_verified_result = save_verified_result
        self.clock = clock or (lambda: time.time_ns() // 1_000_000)

    @staticmethod
    def _code(code):
        code = code.strip().upper()
        if len(code) != 6 or any(char not in ROOM_ALPHABET for char in code):
            raise HTTPException(404, "Комната не найдена. Проверьте код приглашения.")
        return code

    @staticmethod
    def _room(conn, code):
        room = conn.execute("SELECT * FROM race_rooms WHERE code = ?", (code,)).fetchone()
        if not room:
            raise HTTPException(404, "Комната не найдена. Проверьте код приглашения.")
        return dict(room)

    @staticmethod
    def _players(conn, code):
        return [dict(row) for row in conn.execute(
            "SELECT p.*, u.username FROM race_players p JOIN users u ON u.id = p.user_id "
            "WHERE p.code = ? ORDER BY p.slot", (code,)
        )]

    def _refresh(self, conn, room, now):
        players = self._players(conn, room["code"])
        if room["state"] in {"closed", "expired"}:
            return room, players
        if now >= room["expires_ms"] and room["state"] != "finished":
            conn.execute("UPDATE race_rooms SET state = 'expired', outcome = 'expired' WHERE code = ?", (room["code"],))
        elif room["state"] == "active":
            # A completed racer remains present while the penalty elapses.
            for player in players:
                if (player["left_ms"] is None and player["completed_ms"] is None
                        and now - player["last_seen_ms"] > DISCONNECT_MS):
                    conn.execute("UPDATE race_players SET left_ms = ? WHERE code = ? AND user_id = ?",
                                 (now, room["code"], player["user_id"]))
                    player["left_ms"] = now
            remaining = [p for p in players if p["left_ms"] is None]
            if len(remaining) == 1:
                failed = remaining[0]["completed_ms"] is not None and remaining[0]["finish_ms"] is None
                conn.execute("UPDATE race_rooms SET state = 'finished', winner_id = ?, outcome = ? WHERE code = ?",
                             (None if failed else remaining[0]["user_id"], "no_qualifier" if failed else "forfeit", room["code"]))
            elif not remaining:
                conn.execute("UPDATE race_rooms SET state = 'closed', outcome = 'abandoned' WHERE code = ?", (room["code"],))
            else:
                finished = sorted([p for p in remaining if p["finish_ms"] is not None], key=lambda p: p["finish_ms"])
                if finished and finished[0]["finish_ms"] < now:
                    # At this instant an unfinished opponent can no longer beat it.
                    draw = len(finished) == 2 and finished[0]["finish_ms"] == finished[1]["finish_ms"]
                    conn.execute("UPDATE race_rooms SET state = 'finished', winner_id = ?, outcome = ? WHERE code = ?",
                                 (None if draw else finished[0]["user_id"], "draw" if draw else "finish", room["code"]))
                elif all(p["completed_ms"] is not None for p in remaining) and not finished:
                    conn.execute("UPDATE race_rooms SET state = 'finished', outcome = 'no_qualifier' WHERE code = ?",
                                 (room["code"],))
        return self._room(conn, room["code"]), self._players(conn, room["code"])

    def _snapshot(self, conn, room, user_id, now):
        room, players = self._refresh(conn, room, now)
        result = {
            "code": room["code"], "lang": room["lang"], "target_text": room["target_text"],
            "state": room["state"], "starts_ms": room["starts_ms"], "expires_ms": room["expires_ms"],
            "server_now_ms": now, "winner_id": room["winner_id"], "outcome": room["outcome"],
            "you": user_id, "penalty_ms_per_error": ERROR_PENALTY_MS,
            "minimum_accuracy": MIN_RACE_ACCURACY, "players": [],
        }
        for player in players:
            metrics = json.loads(player["metrics_json"])
            elapsed_ms = max(1, now - room["starts_ms"]) if room["starts_ms"] else 0
            if player["completed_ms"] is None and metrics and elapsed_ms:
                # Only live speeds age. Completed results are always frozen.
                metrics = {**metrics, "duration_ms": elapsed_ms, "duration_sec": elapsed_ms / 1000,
                           "cpm": metrics["correct_characters"] * 60_000 / elapsed_ms,
                           "wpm": metrics["correct_characters"] * 12_000 / elapsed_ms}
            item = {
                "user_id": player["user_id"], "username": player["username"], "slot": player["slot"],
                "characters": len(player["typed_text"]), "metrics": public_metrics(metrics) if metrics else {},
                "last_seen_ms": player["last_seen_ms"], "left": player["left_ms"] is not None,
                "completed_ms": player["completed_ms"], "finish_ms": player["finish_ms"],
                "qualified": player["completed_ms"] is not None and player["finish_ms"] is not None,
                "session_id": player["session_id"], "client_seq": player["client_seq"],
            }
            if player["user_id"] == user_id:
                item["typed_text"] = player["typed_text"]
                item["keystrokes"] = json.loads(player["events_json"])
            result["players"].append(item)
        return result

    def create(self, user_id, lang):
        now = self.clock()
        conn = self.get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            previous = conn.execute(
                "SELECT r.* FROM race_rooms r JOIN race_players p ON r.code = p.code "
                "WHERE p.user_id = ? AND p.left_ms IS NULL AND r.state IN ('waiting','active') "
                "AND r.expires_ms > ? ORDER BY r.created_ms DESC LIMIT 1", (user_id, now)
            ).fetchone()
            if previous:
                room, _ = self._refresh(conn, dict(previous), now)
                if room["state"] in {"waiting", "active"}:
                    result = self._snapshot(conn, room, user_id, now)
                    conn.commit()
                    return result
            for _ in range(10):
                code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
                if not conn.execute("SELECT 1 FROM race_rooms WHERE code = ?", (code,)).fetchone():
                    break
            else:
                raise HTTPException(503, "Не получилось создать комнату. Попробуйте ещё раз.")
            conn.execute("INSERT INTO race_rooms (code,lang,target_text,created_ms,expires_ms) VALUES (?,?,?,?,?)",
                         (code, lang, secrets.choice(RACE_TEXTS[lang]), now, now + WAIT_TTL_MS))
            conn.execute("INSERT INTO race_players (code,user_id,slot,joined_ms,last_seen_ms) VALUES (?,?,0,?,?)",
                         (code, user_id, now, now))
            result = self._snapshot(conn, self._room(conn, code), user_id, now)
            conn.commit()
            return result
        finally:
            conn.close()

    def join(self, code, user_id):
        code, now = self._code(code), self.clock()
        conn = self.get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            room, players = self._refresh(conn, self._room(conn, code), now)
            member = next((p for p in players if p["user_id"] == user_id), None)
            if member:
                if member["left_ms"] is not None:
                    raise HTTPException(409, "Вы вышли из этой гонки. Создайте новую комнату.")
                conn.execute("UPDATE race_players SET last_seen_ms = ? WHERE code = ? AND user_id = ?", (now, code, user_id))
            else:
                if room["state"] != "waiting" or len(players) >= 2:
                    raise HTTPException(409, "Гонка уже началась или комната закрыта. Создайте новую.")
                if any(now - p["last_seen_ms"] > DISCONNECT_MS for p in players):
                    raise HTTPException(409, "Создатель комнаты не в сети. Попросите его вернуться в комнату.")
                other_room = conn.execute(
                    "SELECT r.* FROM race_rooms r JOIN race_players p ON r.code = p.code "
                    "WHERE p.user_id = ? AND p.left_ms IS NULL AND r.state IN ('waiting','active') "
                    "AND r.expires_ms > ? LIMIT 1", (user_id, now)
                ).fetchone()
                if other_room and self._refresh(conn, dict(other_room), now)[0]["state"] in {"waiting", "active"}:
                    raise HTTPException(409, "Сначала выйдите из своей текущей комнаты.")
                conn.execute("INSERT INTO race_players (code,user_id,slot,joined_ms,last_seen_ms) VALUES (?,?,1,?,?)",
                             (code, user_id, now, now))
                conn.execute("UPDATE race_rooms SET state = 'active', starts_ms = ?, expires_ms = ? WHERE code = ?",
                             (now + COUNTDOWN_MS, now + COUNTDOWN_MS + RACE_TTL_MS, code))
            result = self._snapshot(conn, self._room(conn, code), user_id, now)
            conn.commit()
            return result
        finally:
            conn.close()

    def read(self, code, user_id):
        code, now = self._code(code), self.clock()
        conn = self.get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            room = self._room(conn, code)
            member = conn.execute("SELECT * FROM race_players WHERE code = ? AND user_id = ?", (code, user_id)).fetchone()
            if not member:
                raise HTTPException(403, "Войдите в комнату по коду приглашения.")
            # Reconnect is allowed until the disconnect grace period is exceeded.
            room, players = self._refresh(conn, room, now)
            if not next(p for p in players if p["user_id"] == user_id)["left_ms"]:
                conn.execute("UPDATE race_players SET last_seen_ms = ? WHERE code = ? AND user_id = ?", (now, code, user_id))
            result = self._snapshot(conn, room, user_id, now)
            conn.commit()
            return result
        finally:
            conn.close()

    def progress(self, code, user_id, typed_text, events, client_seq):
        code, now = self._code(code), self.clock()
        conn = self.get_db()
        saved = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            room = self._room(conn, code)
            player = conn.execute("SELECT * FROM race_players WHERE code = ? AND user_id = ?", (code, user_id)).fetchone()
            if not player:
                raise HTTPException(403, "Вы не участвуете в этой гонке.")
            room, players = self._refresh(conn, room, now)
            player = next(p for p in players if p["user_id"] == user_id)
            if player["left_ms"] is not None or room["state"] in {"closed", "expired"} or now >= room["expires_ms"]:
                raise HTTPException(409, "Гонка завершена. Создайте новую комнату.")
            if room["starts_ms"] is None or now < room["starts_ms"]:
                raise HTTPException(409, "Дождитесь сигнала старта.")
            conn.execute("UPDATE race_players SET last_seen_ms = ? WHERE code = ? AND user_id = ?", (now, code, user_id))
            if player["completed_ms"] is not None or client_seq <= player["client_seq"]:
                result = self._snapshot(conn, room, user_id, now)
                conn.commit()
                return result, None
            previous = json.loads(player["events_json"])
            if len(events) < len(previous) or events[:len(previous)] != previous:
                raise HTTPException(409, "История ввода не совпадает. Обновите комнату.")
            elapsed_ms = max(1, now - room["starts_ms"])
            if events and events[-1]["at_ms"] > elapsed_ms:
                raise HTTPException(422, "Время нажатий не совпадает со временем гонки.")
            try:
                metrics = replay_keystrokes(room["target_text"], events, elapsed_ms,
                                            typed_text=typed_text, require_complete=False)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            # The race timer starts for both people at the common start signal.
            metrics["duration_ms"] = elapsed_ms
            metrics["duration_sec"] = elapsed_ms / 1000
            metrics["cpm"] = metrics["correct_characters"] * 60_000 / elapsed_ms
            metrics["wpm"] = metrics["correct_characters"] * 12_000 / elapsed_ms
            complete = len(typed_text) == len(room["target_text"])
            qualified = complete and metrics["accuracy"] >= MIN_RACE_ACCURACY
            finish_ms = now + metrics["errors"] * ERROR_PENALTY_MS if qualified else None
            if complete:
                if not qualified:
                    metrics["is_ranked"] = False
                    metrics["ranking_reason"] = "Для зачёта гонки нужна точность от 80%."
                saved = self.save_verified_result(
                    user_id=user_id, mode="race", difficulty="medium", lang=room["lang"], metrics=metrics,
                    client_session_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"typing-race:{code}:{user_id}")), conn=conn,
                )
            conn.execute(
                "UPDATE race_players SET typed_text=?, events_json=?, client_seq=?, metrics_json=?, "
                "completed_ms=?, finish_ms=?, session_id=? WHERE code=? AND user_id=?",
                (typed_text, json.dumps(events, ensure_ascii=False), client_seq, json.dumps(metrics, ensure_ascii=False),
                 now if complete else None, finish_ms, saved["session_id"] if saved else None, code, user_id)
            )
            result = self._snapshot(conn, room, user_id, now)
            conn.commit()
            return result, saved
        finally:
            conn.close()

    def leave(self, code, user_id):
        code, now = self._code(code), self.clock()
        conn = self.get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            room = self._room(conn, code)
            if not conn.execute("SELECT 1 FROM race_players WHERE code = ? AND user_id = ?", (code, user_id)).fetchone():
                raise HTTPException(403, "Вы не участвуете в этой гонке.")
            conn.execute("UPDATE race_players SET left_ms = COALESCE(left_ms, ?) WHERE code = ? AND user_id = ?", (now, code, user_id))
            if room["state"] == "waiting":
                conn.execute("UPDATE race_rooms SET state = 'closed', outcome = 'abandoned' WHERE code = ?", (code,))
            result = self._snapshot(conn, self._room(conn, code), user_id, now)
            conn.commit()
            return result
        finally:
            conn.close()


def create_race_router(get_db, get_current_user_id, save_verified_result, get_user_profile):
    conn = get_db()
    try:
        init_race_schema(conn)
    finally:
        conn.close()
    service = RaceService(get_db, save_verified_result)
    router = APIRouter(prefix="/api/races", tags=["races"])

    def private(response):
        response.headers["Cache-Control"] = "no-store"

    @router.post("")
    def create_room(payload: RaceCreate, request: Request, response: Response):
        private(response)
        return service.create(get_current_user_id(request), payload.lang)

    @router.post("/{code}/join")
    def join_room(code: str, request: Request, response: Response):
        private(response)
        return service.join(code, get_current_user_id(request))

    @router.get("/{code}")
    def read_room(code: str, request: Request, response: Response):
        private(response)
        return service.read(code, get_current_user_id(request))

    @router.put("/{code}/progress")
    def send_progress(code: str, payload: RaceProgress, request: Request, response: Response):
        private(response)
        user_id = get_current_user_id(request)
        result, saved = service.progress(code, user_id, payload.typed_text,
                                        [key.model_dump() for key in payload.keystrokes], payload.client_seq)
        if saved:
            result["profile"] = get_user_profile(user_id)
            result["saved_result"] = saved
        return result

    @router.post("/{code}/leave")
    def leave_room(code: str, request: Request, response: Response):
        private(response)
        return service.leave(code, get_current_user_id(request))

    return router
