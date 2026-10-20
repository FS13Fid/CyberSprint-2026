"""A deterministic leaderboard drawn exclusively from saved public results."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query

from .db import get_db
from .metrics import round_half_up

router = APIRouter()


@router.get("/api/leaderboard")
def get_leaderboard(
    sort_by: str = Query("wpm", pattern="^(wpm|cpm|accuracy|xp)$"),
    period: str = Query("all", pattern="^(today|week|all)$"),
    mode: str = Query("all", pattern="^(all|words|sentences|code|symbols|custom|race)$"),
    order: str = Query("desc", pattern="^(desc|asc)$"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    clauses = ["u.leaderboard_public = 1", "s.is_ranked = 1"]
    params = []
    if period != "all":
        # The UI calls these filters "Сутки" / "7 дней": rolling UTC windows.
        cutoff = datetime.now(timezone.utc) - timedelta(days=1 if period == "today" else 7)
        clauses.append("s.created_at >= ?")
        params.append(cutoff.strftime("%Y-%m-%d %H:%M:%S"))
    if mode != "all":
        clauses.append("s.mode = ?")
        params.append(mode)
    primary = {"wpm": "best_wpm", "cpm": "best_cpm", "accuracy": "avg_accuracy", "xp": "period_xp"}[sort_by]
    # Ranking uses raw values and explicit ties; rounded display values never
    # influence positions. Reversing the view retains the actual place number.
    rank_order = f"{primary} DESC, best_cpm DESC, avg_accuracy DESC, period_xp DESC, id ASC"
    display_order = "ASC" if order == "desc" else "DESC"
    query = f"""
        WITH totals AS (
            SELECT u.id, u.username, u.level,
                   MAX(s.wpm) AS best_wpm, MAX(s.cpm) AS best_cpm,
                   AVG(s.accuracy) AS avg_accuracy, SUM(s.xp_earned) AS period_xp,
                   COUNT(*) AS sessions_count,
                   SUM(CASE WHEN s.metrics_version = 1 THEN 1 ELSE 0 END) AS legacy_sessions
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE {' AND '.join(clauses)}
            GROUP BY u.id
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (ORDER BY {rank_order}) AS rank FROM totals
        )
        SELECT * FROM ranked ORDER BY rank {display_order} LIMIT ? OFFSET ?
    """
    conn = get_db()
    try:
        rows = [dict(row) for row in conn.execute(query, [*params, limit, offset])]
    finally:
        conn.close()
    for row in rows:
        row["best_wpm"] = round_half_up(row["best_wpm"], 1)
        row["best_cpm"] = round_half_up(row["best_cpm"])
        row["avg_accuracy"] = round_half_up(row["avg_accuracy"], 1)
    return rows
