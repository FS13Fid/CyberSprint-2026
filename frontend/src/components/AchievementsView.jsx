import React from "react";
import SignInPrompt from "./SignInPrompt.jsx";
import { ACHIEVEMENT_MARKS } from "../training/content.js";

export default function AchievementsView({ profile, onLogin }) {
  if (!profile) return <SignInPrompt onLogin={onLogin} />;
  const achievements = profile.achievements || [];
  const unlocked = achievements.filter((item) => item.unlocked).length;
  return <section className="dashboard-view">
    <div className="achievement-intro panel"><div><p className="eyebrow">ТВОЙ ПРОФИЛЬ</p><h2>{unlocked} из {achievements.length} отметок</h2><p>Каждая награда связана с конкретным результатом.</p></div><div className="achievement-progress"><div><span style={{ width: `${achievements.length ? (unlocked / achievements.length) * 100 : 0}%` }} /></div><small>{achievements.length ? Math.round((unlocked / achievements.length) * 100) : 0}% пути</small></div></div>
    <div className="achievement-grid">{achievements.map((item) => <article className={`achievement-card panel ${item.unlocked ? "unlocked" : "locked"}`} key={item.id}><div className="achievement-mark">{ACHIEVEMENT_MARKS[item.id] || "•"}</div><div><h2>{item.title}</h2><p>{item.desc}</p></div><span className="achievement-status">{item.unlocked ? "ОТКРЫТО" : "ВПЕРЕДИ"}</span></article>)}</div>
  </section>;
}
