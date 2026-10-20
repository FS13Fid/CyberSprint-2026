import React from "react";
import ProviderIcon from "./ProviderIcon.jsx";
import { SOCIAL_PROVIDER_LABELS } from "../training/content.js";

export default function AuthDialog({ authMode, setAuthOpen, socialProviders, authError, submitAuth, emailRef, authBusy, setAuthMode, setAuthError }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
        <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <button className="dialog-close" type="button" onClick={() => setAuthOpen(false)} aria-label="Закрыть">×</button>
          <p className="eyebrow">ЛИЧНЫЙ ПРОФИЛЬ</p><h2 id="auth-title">{authMode === "register" ? "Создать аккаунт" : "С возвращением"}</h2>
          <p className="dialog-copy">{authMode === "register" ? "Сохраняй результаты и следи за прогрессом." : "Войди, чтобы тренировки остались в твоём профиле."}</p>
          <div className="social-login-list">
            <p className="social-login-title">Войти через аккаунт</p>
            <div className="social-login-grid">{Object.entries(SOCIAL_PROVIDER_LABELS).map(([provider, label]) => socialProviders[provider]
              ? <a className={`social-login-button provider-${provider}`} href={`/api/auth/social/${provider}/start`} key={provider}><ProviderIcon provider={provider} /><span>{label}</span></a>
              : <button className={`social-login-button provider-${provider} social-login-disabled`} type="button" disabled title="Этот способ входа пока не настроен на сайте" key={provider}><ProviderIcon provider={provider} /><span>{label}</span></button>)}</div>
            {Object.values(socialProviders).some(Boolean)
              ? <p className="auth-divider">или войди по email</p>
              : <p className="social-login-note">Вход через эти сервисы появится после подключения к сайту.</p>}
          </div>
          <form onSubmit={submitAuth}>
            <label>Email<input ref={emailRef} type="email" name="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} /></label>
            {authMode === "register" && <label>Никнейм<input type="text" name="username" autoComplete="nickname" placeholder="Например, alex" required minLength={2} maxLength={24} /></label>}
            {authMode === "register" && <label className="leaderboard-consent"><input type="checkbox" name="leaderboard_public" /><span>Показывать мой ник, уровень, рекорд скорости, точность и опыт в общей таблице лидеров. Email и пароль не публикуются.</span></label>}
            <label>Пароль<input type="password" name="password" autoComplete={authMode === "register" ? "new-password" : "current-password"} placeholder={authMode === "register" ? "Не менее 8 символов" : "Введите пароль"} required minLength={authMode === "register" ? 8 : 1} maxLength={128} /></label>
            {authError && <p className="form-error" role="alert">{authError}</p>}
            <button className="button button-primary submit-button" type="submit" disabled={authBusy}>{authBusy ? "Подождите…" : authMode === "register" ? "Создать аккаунт" : "Войти"}</button>
          </form>
          <p className="auth-switch-copy">{authMode === "register" ? "Уже есть аккаунт?" : "Ещё нет аккаунта?"} <button type="button" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthError(""); }}>{authMode === "register" ? "Войти" : "Создать аккаунт"}</button></p>
        </section>
      </div>;
}
