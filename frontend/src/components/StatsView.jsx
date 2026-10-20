import React from "react";
import SignInPrompt from "./SignInPrompt.jsx";
import Sparkline from "./Sparkline.jsx";
import SpeedUnitSwitch from "./SpeedUnitSwitch.jsx";
import { DIFFICULTIES } from "../training/content.js";
import { formatSpeed, formatDate, modeLabel } from "../lib/format.js";
import "../styles/results.css";

function practiceTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} мин ${Math.round(seconds % 60)} сек` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

export default function StatsView({ profile, speedUnit, onSpeedUnit, onLogin, onLeaderboardVisibilityChange, visibilityBusy }) {
  if (!profile) return <SignInPrompt onLogin={onLogin} />;
  const sessions = profile.sessions || [];
  const charCount = profile.hardest_chars || [];
  const bestSpeed = formatSpeed(speedUnit === "wpm" ? profile.best_wpm : profile.best_cpm, speedUnit);
  const hasRanked = profile.ranked_sessions > 0;
  const summary = [
    ["Тренировок", profile.total_sessions],
    ["Время практики", practiceTime(profile.total_time_sec || 0)],
    ["Рекорд скорости в рейтинге", hasRanked ? bestSpeed : "Пока нет"],
    ["Средняя точность", `${profile.avg_accuracy}%`],
  ];
  return <section className="dashboard-view">
    <label className="leaderboard-privacy panel"><span><strong>Общая таблица лидеров</strong><small>При включении видны ник, уровень, рекорд скорости, точность и опыт. Email и пароль не публикуются.</small></span><input type="checkbox" checked={Boolean(profile.leaderboard_public)} disabled={visibilityBusy} onChange={(event) => onLeaderboardVisibilityChange(event.target.checked)} /><span className="privacy-toggle-label">{profile.leaderboard_public ? "Показывать" : "Скрыть"}</span></label>
    <div className="stats-toolbar"><p>Знаки/мин — верные знаки за минуту. Слова/мин = знаки/мин ÷ 5.</p><SpeedUnitSwitch value={speedUnit} onChange={onSpeedUnit} /></div>
    <div className="stats-summary">{summary.map(([label, value]) => <article className="summary-card panel" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    <p className="result-note">Рекорд учитывает рейтинговые попытки от 10 знаков и 3 секунд во всех режимах. Короткие попытки сохраняются в истории с фактической скоростью.</p>
    {profile.legacy_sessions > 0 && <p className="result-note">В истории есть записи из предыдущей версии. Их время набора невозможно проверить повторно; такие записи отмечены отдельно.</p>}
    <div className="dashboard-columns">
      <article className="panel dashboard-card">
        <div className="section-title"><div><p className="eyebrow">ПОСЛЕДНИЕ РЕЗУЛЬТАТЫ</p><h2>Ритм практики</h2></div><span className="chart-legend"><i /> {speedUnit === "wpm" ? "Слов/мин" : "Знаков/мин"}</span></div>
        <Sparkline values={sessions.map((item) => Number(speedUnit === "wpm" ? item.wpm : item.cpm) || 0)} />
        <div className="chart-foot"><span>Последние {sessions.length} тренировок</span><strong>{hasRanked ? `${bestSpeed} · рекорд` : "Рекорд ещё не установлен"}</strong></div>
      </article>
      <article className="panel dashboard-card">
        <div className="section-title"><div><p className="eyebrow">ЧТО ПОТРЕНИРОВАТЬ</p><h2>Трудные знаки</h2></div></div>
        {charCount.length ? <div className="hardest-list">{charCount.map((item) => <div className="hardest-row" key={item.char}><span className="hardest-key">{item.char === " " ? "␠" : item.char === "\n" ? "↵" : item.char}</span><span>{item.error_count} {item.error_count === 1 ? "ошибка" : "ошибок"}{item.error_rate !== null && item.error_rate !== undefined ? ` · ${item.error_rate}% на этот знак` : ""}</span></div>)}</div> : <p className="quiet-note">Ошибок пока нет — так держать.</p>}
      </article>
    </div>
    <article className="panel table-panel">
      <div className="section-title"><div><p className="eyebrow">ИСТОРИЯ</p><h2>Недавние тренировки</h2></div></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Дата</th><th>Режим</th><th>Сложность</th><th>Скорость</th><th>Точность</th><th>Ошибки</th></tr></thead>
        <tbody>{sessions.slice().reverse().map((item, index) => <tr key={item.id ?? `${item.created_at}-${index}`}>
          <td>{formatDate(item.created_at)}</td>
          <td>{modeLabel(item.mode)}<span className="history-status" title={item.ranking_reason || undefined}>{item.metrics_version === 1 ? "Запись предыдущей версии" : item.is_ranked ? "В рейтинге" : "Вне рейтинга"}</span></td>
          <td>{item.mode === "custom" ? "Свой текст" : item.mode === "race" ? "Общий текст" : DIFFICULTIES.find((level) => level.id === item.difficulty)?.label || "Средний"}</td>
          <td><strong>{formatSpeed(item[speedUnit], speedUnit)}</strong><span className="history-status">{formatSpeed(item[speedUnit === "wpm" ? "cpm" : "wpm"], speedUnit === "wpm" ? "cpm" : "wpm")}</span></td>
          <td>{item.accuracy}%</td><td>{item.errors}</td>
        </tr>)}{!sessions.length && <tr><td colSpan="6" className="empty-cell">Заверши тренировку, и она появится здесь.</td></tr>}</tbody>
      </table></div>
    </article>
  </section>;
}
