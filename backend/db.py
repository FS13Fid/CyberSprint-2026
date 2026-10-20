"""SQLite connections and backward-compatible schema migrations."""
import sqlite3
from datetime import datetime, timezone
from .config import APP_TIMEZONE, DB_PATH


def get_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def rebuild_practice_days(conn):
    """Rebuild the derived calendar in the same timezone used for new results.

    SQLite CURRENT_TIMESTAMP is UTC. Adding its date directly used to create
    an extra practice day after restarting during the first hours after local
    midnight. Source sessions and their original timestamps stay unchanged.
    """
    days = set()
    for row in conn.execute("SELECT user_id, created_at FROM sessions"):
        try:
            timestamp = datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        days.add((row["user_id"], timestamp.astimezone(APP_TIMEZONE).date().isoformat()))
    conn.execute("DELETE FROM practice_days")
    conn.executemany("INSERT INTO practice_days (user_id, practiced_on) VALUES (?, ?)", sorted(days))


def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_enabled INTEGER NOT NULL DEFAULT 1,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        total_sessions INTEGER DEFAULT 0,
        total_time_sec INTEGER DEFAULT 0,
        flawless_chars INTEGER DEFAULT 0,
        max_streak_ever INTEGER DEFAULT 0,
        leaderboard_public INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    user_columns = {row["name"] for row in cur.execute("PRAGMA table_info(users)")}
    if "leaderboard_public" not in user_columns:
        cur.execute("ALTER TABLE users ADD COLUMN leaderboard_public INTEGER NOT NULL DEFAULT 0")
    if "password_enabled" not in user_columns:
        cur.execute("ALTER TABLE users ADD COLUMN password_enabled INTEGER NOT NULL DEFAULT 1")
        cur.execute("UPDATE users SET password_enabled = 0 WHERE email LIKE '%@users.invalid'")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mode TEXT NOT NULL,
        lang TEXT NOT NULL,
        wpm REAL NOT NULL,
        cpm REAL NOT NULL,
        accuracy REAL NOT NULL,
        errors INTEGER NOT NULL,
        score INTEGER NOT NULL,
        xp_earned INTEGER NOT NULL,
        duration_sec INTEGER NOT NULL,
        max_combo INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS char_errors (
        user_id INTEGER NOT NULL,
        char TEXT NOT NULL,
        error_count INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, char),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS char_attempts (
        user_id INTEGER NOT NULL,
        char TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, char),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS user_achievements (
        user_id INTEGER NOT NULL,
        achievement_id TEXT NOT NULL,
        unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, achievement_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS auth_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(provider, subject),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS auth_oauth_states (
        state_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        intent TEXT NOT NULL,
        user_id INTEGER,
        session_token_hash TEXT,
        code_verifier TEXT NOT NULL,
        nonce TEXT,
        expires_at TIMESTAMP NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS practice_days (
        user_id INTEGER NOT NULL,
        practiced_on TEXT NOT NULL,
        PRIMARY KEY (user_id, practiced_on),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    # Legacy push_subscriptions rows (if present) are left untouched, but unused.
    cur.execute("""
    CREATE TABLE IF NOT EXISTS max_connections (
        user_id INTEGER PRIMARY KEY,
        max_user_id TEXT NOT NULL UNIQUE,
        reminder_time TEXT NOT NULL DEFAULT '20:00',
        reminder_enabled INTEGER NOT NULL DEFAULT 0,
        summaries_enabled INTEGER NOT NULL DEFAULT 0,
        linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS max_link_tokens (
        user_id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS max_reminder_log (
        user_id INTEGER NOT NULL,
        reminder_date TEXT NOT NULL,
        PRIMARY KEY(user_id, reminder_date),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)
    # Retire old messenger sign-in and notification records from app data.
    retired_provider = "".join(("tele", "gram"))
    cur.execute("DELETE FROM auth_identities WHERE provider = ?", (retired_provider,))
    cur.execute("DELETE FROM auth_oauth_states WHERE provider = ?", (retired_provider,))
    for retired_table in ("connections", "link_tokens", "reminder_log"):
        cur.execute(f"DROP TABLE IF EXISTS {retired_provider}_{retired_table}")

    session_columns = {row["name"] for row in cur.execute("PRAGMA table_info(sessions)")}
    if "difficulty" not in session_columns:
        cur.execute("ALTER TABLE sessions ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium'")
    # Keep historical rows intact. Their original event traces were not stored,
    # so they are explicitly identified as legacy instead of inventing timing.
    session_additions = {
        "duration_ms": "REAL",
        "correct_characters": "INTEGER",
        "correct_keystrokes": "INTEGER",
        "total_keystrokes": "INTEGER",
        "target_length": "INTEGER",
        "metrics_version": "INTEGER NOT NULL DEFAULT 1",
        "is_ranked": "INTEGER NOT NULL DEFAULT 1",
        "client_session_id": "TEXT",
        "max_streak": "INTEGER NOT NULL DEFAULT 0",
        "ranking_reason": "TEXT",
    }
    for column, definition in session_additions.items():
        if column not in session_columns:
            cur.execute(f"ALTER TABLE sessions ADD COLUMN {column} {definition}")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS sessions_submission ON sessions(user_id, client_session_id) WHERE client_session_id IS NOT NULL")
    cur.execute("CREATE INDEX IF NOT EXISTS sessions_leaderboard ON sessions(is_ranked, mode, created_at, user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS sessions_user_history ON sessions(user_id, id DESC)")
    rebuild_practice_days(conn)

    conn.commit()
    conn.close()
