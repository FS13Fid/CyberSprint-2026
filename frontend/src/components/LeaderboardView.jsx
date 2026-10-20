import React from "react";
import { MODES } from "../training/content.js";
import { formatSpeed } from "../lib/format.js";
import SpeedUnitSwitch from "./SpeedUnitSwitch.jsx";
import "../styles/results.css";

export default function LeaderboardView({ rows, error, loading, updatedAt, onRefresh, sortBy, period, mode, order, speedUnit, onSpeedUnit, onSort, onPeriod, onMode, onOrder, page, onPage, hasNext, profile, onLogin, onLeaderboardVisibilityChange, visibilityBusy }) {
  const sortingLabel = sortBy === "speed" ? "скорости" : sortBy === "accuracy" ? "точности" : "опыту";
  const filtered = period !== "all" || mode !== "all";
  const selectColumn = (column) => {
    if (sortBy === column) onOrder(order === "desc" ? "asc" : "desc");
    else { onSort(column); onOrder("desc"); }
  };
  const sortState = (column) => sortBy === column ? order === "desc" ? "descending" : "ascending" : "none";
  const arrow = (column) => sortBy === column ? order === "desc" ? " ↓" : " ↑" : "";
  return <section className="panel leaderboard-panel" aria-busy={loading}>
    <div className="leaderboard-heading">
      <div><p className="eyebrow">УЧАСТНИКИ</p><h2>Таблица лидеров</h2><p>Реальные завершённые тренировки, включая свои слова и гонки. Участники сами включают показ результатов.</p></div>
      <SpeedUnitSwitch value={speedUnit} onChange={onSpeedUnit} />
    </div>
    <div className="leaderboard-filters results-filters">
      <label>Показатель<select value={sortBy} onChange={(event) => onSort(event.target.value)}><option value="speed">Скорость · {speedUnit === "wpm" ? "слов/мин" : "знаков/мин"}</option><option value="accuracy">Точность</option><option value="xp">Опыт</option></select></label>
      <label>Режим<select value={mode} onChange={(event) => onMode(event.target.value)}><option value="all">Все режимы</option>{MODES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
      <label>Период<select value={period} onChange={(event) => onPeriod(event.target.value)}><option value="all">Всё время</option><option value="week">Последние 7 суток</option><option value="today">Последние 24 часа</option></select></label>
      <label>Порядок<select value={order} onChange={(event) => onOrder(event.target.value)}><option value="desc">По убыванию</option><option value="asc">По возрастанию</option></select></label>
      <button className="button button-outline refresh-results" type="button" onClick={onRefresh} disabled={loading}>Обновить</button>
    </div>
    <div className="results-explanation"><p>Рекорд скорости, средняя точность и опыт рассчитаны по выбранным режиму и периоду. В рейтинг входят попытки от 10 знаков и 3 секунд.</p><span role="status">{loading ? "Загружаем результаты…" : updatedAt ? `Обновлено ${updatedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · автоматически каждые 15 сек` : ""}</span></div>
    {error && <div className="results-error" role="alert"><p>Не удалось обновить таблицу. {rows.length ? "Показаны последние загруженные результаты." : "Проверьте соединение и попробуйте ещё раз."}</p><button type="button" className="text-button" onClick={onRefresh}>Повторить</button></div>}
    <div className="table-scroll"><table>
      <caption className="sr-only">Сортировка по {sortingLabel}, {order === "desc" ? "по убыванию" : "по возрастанию"}</caption>
      <thead><tr><th>Место</th><th>Участник</th><th>Уровень</th><th aria-sort={sortState("speed")}><button type="button" className="table-sort" onClick={() => selectColumn("speed")}>Рекорд · {speedUnit === "wpm" ? "слов/мин" : "знаков/мин"}{arrow("speed")}</button></th><th aria-sort={sortState("accuracy")}><button type="button" className="table-sort" onClick={() => selectColumn("accuracy")}>Точность{arrow("accuracy")}</button></th><th aria-sort={sortState("xp")}><button type="button" className="table-sort" onClick={() => selectColumn("xp")}>Опыт{arrow("xp")}</button></th><th>Тренировки</th></tr></thead>
      <tbody>{loading ? <tr><td colSpan="7" className="empty-cell">Загружаем таблицу…</td></tr> : rows.map((row, index) => <tr key={row.id} className={profile?.id === row.id ? "is-current-user" : ""}><td className={`rank-cell rank-${row.rank ?? index + 1}`}>{String(row.rank ?? index + 1).padStart(2, "0")}</td><td className="name-cell">{row.username}{profile?.id === row.id && <span className="you-badge">вы</span>}</td><td>Ур. {row.level}</td><td className={sortBy === "speed" ? "sorted-value" : ""}>{formatSpeed(speedUnit === "wpm" ? row.best_wpm : row.best_cpm, speedUnit)}</td><td className={sortBy === "accuracy" ? "sorted-value" : ""}>{row.avg_accuracy ?? 0}%</td><td className={sortBy === "xp" ? "sorted-value" : ""}>{row.period_xp ?? 0} XP</td><td>{row.sessions_count ?? 0}</td></tr>)}</tbody>
    </table></div>
    {(page > 0 || rows.length > 0) && <nav className="results-pagination" aria-label="Страницы рейтинга"><button type="button" className="button button-outline" onClick={() => onPage(page - 1)} disabled={loading || page === 0}>Назад</button><span>Страница {page + 1} · по 50 участников</span><button type="button" className="button button-outline" onClick={() => onPage(page + 1)} disabled={loading || !hasNext}>Далее</button></nav>}
    {!error && !loading && !rows.length && <div className="leaderboard-empty"><span className="empty-symbol">↗</span><strong>{filtered ? "В этом разделе пока нет результатов" : "Рейтинг ждёт первых участников"}</strong><p>{filtered ? "Попробуйте другой режим или период. Завершённые тренировки появятся здесь после сохранения." : "Завершите тренировку от 10 знаков и 3 секунд, затем включите показ результатов в профиле."}</p>{filtered && <button className="button button-outline" type="button" onClick={() => { onMode("all"); onPeriod("all"); }}>Сбросить фильтры</button>}</div>}
    {!profile ? <div className="ranking-profile-note"><p>Войдите, чтобы сохранять свои результаты и участвовать в рейтинге.</p><button type="button" className="button button-primary" onClick={onLogin}>Войти в аккаунт</button></div> : !profile.leaderboard_public && <div className="ranking-profile-note"><p>Ваши результаты скрыты. Вы можете включить показ ника и статистики в общей таблице.</p><button type="button" className="button button-primary" onClick={() => onLeaderboardVisibilityChange(true)} disabled={visibilityBusy}>{visibilityBusy ? "Сохраняем…" : "Показывать мои результаты"}</button></div>}
  </section>;
}
