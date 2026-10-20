import React from "react";

export default function SignInPrompt({ onLogin }) {
  return <div className="empty-state"><h2>Здесь начнётся твоя история.</h2><p>Войди или создай аккаунт, чтобы сохранить тренировки и видеть свой прогресс.</p><button className="button button-primary" type="button" onClick={onLogin}>Войти в профиль</button></div>;
}
