"""Environment configuration and shared product constants."""
import hashlib
import os
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DB_PATH = Path(os.environ.get("CYBERSPRINT_DB_PATH", "typing_hero.db"))
STATIC_DIR = Path("static")
STATIC_DIR.mkdir(parents=True, exist_ok=True)
SESSION_COOKIE = "typing_hero_session"
SESSION_TTL = timedelta(days=30)
PASSWORD_ITERATIONS = 310_000
APP_TIMEZONE = ZoneInfo(os.environ.get("CYBERSPRINT_TIMEZONE", "Europe/Moscow"))
DATA_SCOPE = "server" if os.environ.get("CYBERSPRINT_DATA_SCOPE", "local").strip().lower() == "server" else "local"
PUBLIC_URL = os.environ.get("CYBERSPRINT_PUBLIC_URL", "https://demoground.ru").rstrip("/")
SOCIAL_PROVIDERS = {
    "github": {
        "label": "GitHub",
        "client_id": os.environ.get("GITHUB_OAUTH_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("GITHUB_OAUTH_CLIENT_SECRET", "").strip(),
    },
    "yandex": {
        "label": "Яндекс",
        "client_id": os.environ.get("YANDEX_OAUTH_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("YANDEX_OAUTH_CLIENT_SECRET", "").strip(),
    },
    "vk": {"label": "ВКонтакте", "client_id": os.environ.get("VK_ID_CLIENT_ID", "").strip()},
}
for provider in ("github", "yandex", "vk"):
    SOCIAL_PROVIDERS[provider]["ready"] = bool(SOCIAL_PROVIDERS[provider]["client_id"])
if "client_secret" in SOCIAL_PROVIDERS["github"]:
    SOCIAL_PROVIDERS["github"]["ready"] = bool(SOCIAL_PROVIDERS["github"]["client_id"] and SOCIAL_PROVIDERS["github"]["client_secret"])
if "client_secret" in SOCIAL_PROVIDERS["yandex"]:
    SOCIAL_PROVIDERS["yandex"]["ready"] = bool(SOCIAL_PROVIDERS["yandex"]["client_id"] and SOCIAL_PROVIDERS["yandex"]["client_secret"])
MAX_BOT_TOKEN = os.environ.get("MAX_BOT_TOKEN", "").strip()
MAX_BOT_USERNAME = os.environ.get("MAX_BOT_USERNAME", "").strip().removeprefix("@").strip()
MAX_WEBHOOK_SECRET = os.environ.get("MAX_WEBHOOK_SECRET", "").strip() or (
    hashlib.sha256(f"cybersprint-max-webhook:{MAX_BOT_TOKEN}".encode()).hexdigest()
    if MAX_BOT_TOKEN else ""
)
MAX_CA_BUNDLE = os.environ.get("MAX_CA_BUNDLE", "").strip()
MAX_BOT_READY = bool(MAX_BOT_TOKEN and MAX_BOT_USERNAME)
MAX_API_URL = "https://platform-api2.max.ru"

ACHIEVEMENTS_CONFIG = [
    {"id": "first_step", "title": "Первая тренировка", "desc": "Завершить первое упражнение", "icon": "🎯"},
    {"id": "speed_200_cpm", "title": "Скоростной рубеж", "desc": "Достичь скорости 200 символов/мин", "icon": "⚡"},
    {"id": "typing_genius", "title": "Печатный гений", "desc": "Достичь скорости 300 слов/мин", "icon": "🧠"},
    {"id": "steel_finger", "title": "Стальной палец", "desc": "1000 правильных нажатий подряд", "icon": "🦾"},
    {"id": "flawless_1000", "title": "Безупречная тысяча", "desc": "Напечатать 1000 символов без ошибок", "icon": "💎"},
    {"id": "combo_master", "title": "Мастер комбо", "desc": "Достичь максимального множителя комбо x5", "icon": "🔥"},
]


def local_now() -> datetime:
    return datetime.now(APP_TIMEZONE)

def calculate_level(xp: int) -> int:
    return max(1, (xp // 500) + 1)
