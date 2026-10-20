import React from "react";
import ProviderIcon from "./ProviderIcon.jsx";
import { SOCIAL_PROVIDER_LABELS } from "../training/content.js";

export default function ProfileSettingsDialog({ profile, setSettingsOpen, socialProviders, settingsError, leaderboardVisibilityBusy, changeLeaderboardVisibility, notifications, loadProfile, submitUsernameChange, submitEmailChange, submitPasswordChange, settingsEmailRef, settingsBusy }) {
  const { maxBusy, maxReminderTime, setMaxReminderTime, connectMaxBot, updateMaxSettings, disconnectMaxBot } = notifications;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="dialog-close" type="button" onClick={() => setSettingsOpen(false)} aria-label="Закрыть">×</button>
          <p className="eyebrow">МОЙ АККАУНТ</p><h2 id="settings-title">Настройки профиля</h2>
          {settingsError && <p className="form-error settings-error" role="alert">{settingsError}</p>}
          <div className="settings-profile-card"><span className="settings-avatar">{profile.username.slice(0, 1).toUpperCase()}</span><div><strong>{profile.username}</strong><small>{profile.email || "Вход через аккаунт"}</small></div><b>УРОВЕНЬ {profile.level}</b></div>
          <label className="leaderboard-privacy settings-privacy"><span><strong>Показывать меня в таблице лидеров</strong><small>Будут видны ник, уровень, скорость, точность и опыт. Email не публикуется.</small></span><input type="checkbox" checked={Boolean(profile.leaderboard_public)} disabled={leaderboardVisibilityBusy} onChange={(event) => changeLeaderboardVisibility(event.target.checked)} /><span className="privacy-toggle-label">{profile.leaderboard_public ? "Включено" : "Выключено"}</span></label>
          <section className="account-links">
            <div><h3>Вход через другие аккаунты</h3><p>Привяжите аккаунты, чтобы входить без отдельного пароля.</p></div>
            {Object.entries(SOCIAL_PROVIDER_LABELS).map(([provider, label]) => {
              const linked = (profile.auth_providers || []).includes(provider);
              const available = Boolean(socialProviders[provider]);
              return <div className="account-link-row" key={provider}>
                <ProviderIcon provider={provider} />
                <strong>{label}</strong>
                <small>{linked ? "Подключён" : available ? "Не подключён" : "Пока не настроен"}</small>
                {!linked && available && <a href={`/api/auth/social/${provider}/start?intent=link`}>Подключить</a>}
              </div>;
            })}
          </section>
          <section className="push-settings max-settings">
            <div><h3>Сообщения от бота MAX</h3><p>Подключите бота, чтобы получать напоминания о практике и итоги тренировок. Каждый вид сообщений можно включить отдельно.</p></div>
            {!profile.max_bot_configured && <small>Бот MAX пока не подключён к сайту.</small>}
            {profile.max_bot_configured && !profile.max_connected && <>
              <button className="button button-outline" type="button" onClick={connectMaxBot} disabled={maxBusy}>{maxBusy ? "Подключаем…" : "Подключить MAX"}</button>
              <small>Откройте бота по ссылке и нажмите «Начать». После ответа бота статус появится здесь.</small>
              <button className="push-unsubscribe" type="button" onClick={loadProfile}>Проверить подключение</button>
            </>}
            {profile.max_connected && <>
              <small className="max-connected-note">Бот MAX подключён. Новые сообщения выключены, пока вы сами их не включите.</small>
              <label className="push-toggle"><input type="checkbox" checked={Boolean(profile.max_reminder_enabled)} disabled={maxBusy} onChange={(event) => updateMaxSettings({ reminder_enabled: event.target.checked })} /><span>Напоминать о тренировке</span></label>
              <label className="push-time-label">Время напоминания<input type="time" value={maxReminderTime} onChange={(event) => setMaxReminderTime(event.target.value)} /></label>
              <button className="button button-outline" type="button" onClick={() => updateMaxSettings()} disabled={maxBusy}>{maxBusy ? "Сохраняю…" : "Сохранить время"}</button>
              <label className="push-toggle"><input type="checkbox" checked={Boolean(profile.max_summaries_enabled)} disabled={maxBusy} onChange={(event) => updateMaxSettings({ summaries_enabled: event.target.checked })} /><span>Присылать итоги каждой тренировки</span></label>
              <button className="push-unsubscribe" type="button" onClick={disconnectMaxBot} disabled={maxBusy}>Отключить MAX</button>
            </>}
          </section>
          <form className="settings-form" onSubmit={submitUsernameChange}>
            <div><h3>Изменить никнейм</h3><p>Никнейм отображается в таблице лидеров.</p></div>
            <label>Новый никнейм<input type="text" name="username" autoComplete="nickname" defaultValue={profile.username} required minLength={2} maxLength={24} /></label>
            {profile.password_enabled && <label>Текущий пароль<input type="password" name="current_password" autoComplete="current-password" required maxLength={128} /></label>}
            <button className="button button-outline" type="submit" disabled={settingsBusy}>{settingsBusy ? "Сохраняю…" : "Сохранить никнейм"}</button>
          </form>
          {!profile.password_enabled && <p className="auth-provider-note">Вход выполняется через подключённый внешний аккаунт.</p>}
          {profile.password_enabled && <>
          <form className="settings-form" onSubmit={submitEmailChange}>
            <div><h3>Изменить email</h3><p>Новый адрес сразу станет логином для входа.</p></div>
            <label>Новый email<input ref={settingsEmailRef} type="email" name="email" autoComplete="email" defaultValue={profile.email} required maxLength={254} /></label>
            <label>Текущий пароль<input type="password" name="current_password" autoComplete="current-password" required maxLength={128} /></label>
            <button className="button button-outline" type="submit" disabled={settingsBusy}>{settingsBusy ? "Сохраняю…" : "Сохранить email"}</button>
          </form>
          <form className="settings-form" onSubmit={submitPasswordChange}>
            <div><h3>Изменить пароль</h3><p>После смены пароля входы на других устройствах завершатся.</p></div>
            <label>Текущий пароль<input type="password" name="current_password" autoComplete="current-password" required maxLength={128} /></label>
            <label>Новый пароль<input type="password" name="new_password" autoComplete="new-password" placeholder="Не менее 8 символов" required minLength={8} maxLength={128} /></label>
            <button className="button button-primary" type="submit" disabled={settingsBusy}>{settingsBusy ? "Сохраняю…" : "Сохранить пароль"}</button>
          </form>
          </>}
        </section>
      </div>;
}
