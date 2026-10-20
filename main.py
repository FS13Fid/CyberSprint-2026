"""ASGI entry point. Run with: python -m uvicorn main:app."""
import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend import auth, leaderboard, notifications, profiles, sessions
from backend.config import DATA_SCOPE, MAX_BOT_READY, PUBLIC_URL, STATIC_DIR
from backend.db import get_db, init_db
from backend.races import create_race_router
from backend.security import get_current_user_id


@asynccontextmanager
async def lifespan(app):
    tasks = []
    if MAX_BOT_READY:
        tasks.append(asyncio.create_task(asyncio.to_thread(notifications.ensure_max_webhook)))
    if MAX_BOT_READY:
        tasks.append(asyncio.create_task(notifications.max_reminder_worker()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task


init_db()
app = FastAPI(title="Печать героя — Киберрывок 2026", lifespan=lifespan)
for router in (auth.router, profiles.router, notifications.router, sessions.router, leaderboard.router):
    app.include_router(router)
app.include_router(create_race_router(get_db, get_current_user_id,
                                     sessions.save_verified_result, profiles.get_user_profile))


@app.get("/api/status")
def app_status():
    return {"data_scope": DATA_SCOPE, "public_url": PUBLIC_URL}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def serve_index():
    index_file = STATIC_DIR / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=503, detail="Сначала соберите фронтенд командой npm run build")
    return FileResponse(index_file)


@app.get("/sw.js")
def serve_service_worker():
    worker_file = STATIC_DIR / "sw.js"
    if not worker_file.is_file():
        raise HTTPException(status_code=404, detail="Service worker не найден")
    return FileResponse(worker_file, media_type="application/javascript", headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})
