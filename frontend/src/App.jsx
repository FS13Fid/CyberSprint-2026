import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { MODES, DIFFICULTIES, PAGE_COPY, SOCIAL_PROVIDER_LABELS } from "./training/content.js";
import { KEY_ROWS, FINGER_ROWS, detectTextLanguage, getCharacterLanguage, getFingerHint, getLayoutWarning } from "./training/keyboard.js";
import { makeTraining, applyKeystroke, getMetrics, getSessionPayload, clockNow } from "./training/engine.js";
import { errorMessage } from "./lib/errors.js";
import { playTone } from "./lib/audio.js";
import AuthDialog from "./components/AuthDialog.jsx";
import ProfileSettingsDialog from "./components/ProfileSettingsDialog.jsx";
import StatsView from "./components/StatsView.jsx";
import AchievementsView from "./components/AchievementsView.jsx";
import LeaderboardView from "./components/LeaderboardView.jsx";
import RaceMode from "./components/RaceMode.jsx";
import useLeaderboard from "./hooks/useLeaderboard.js";
import useNotifications from "./hooks/useNotifications.js";
import useProfileSettings from "./hooks/useProfileSettings.js";

function initialMode() {
  return new URLSearchParams(window.location.search).has("race") ? "race" : "words";
}

function App() {
  const [page, setPage] = useState("trainer");
  const [mode, setMode] = useState(initialMode);
  const [lang, setLang] = useState("ru");
  const [difficulty, setDifficulty] = useState("medium");
  const [speedUnit, setSpeedUnit] = useState(() => window.localStorage.getItem("typing-speed-unit") === "cpm" ? "cpm" : "wpm");
  const [codeLang, setCodeLang] = useState("python");
  const [customDraft, setCustomDraft] = useState("");
  const [customText, setCustomText] = useState("");
  const [training, setTraining] = useState(() => makeTraining(initialMode(), "ru", "python"));
  const trainingRef = useRef(training);
  const typingRef = useRef(null);
  const mobileInputRef = useRef(null);
  const [now, setNow] = useState(clockNow);
  const [profile, updateProfileState] = useState(null);
  const profileRef = useRef(null);
  const accountRevisionRef = useRef(0);
  const setProfile = useCallback((next) => {
    const value = typeof next === "function" ? next(profileRef.current) : next;
    if ((profileRef.current?.id ?? null) !== (value?.id ?? null)) accountRevisionRef.current += 1;
    profileRef.current = value;
    updateProfileState(value);
  }, []);
  const [leaderboardVisibilityBusy, setLeaderboardVisibilityBusy] = useState(false);
  const [layoutWarning, setLayoutWarning] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const [saveState, setSaveState] = useState(null);
  const [achievementToast, setAchievementToast] = useState(null);
  const achievementTimer = useRef(null);
  const finishedRef = useRef(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sortBy, setSortBy] = useState("speed");
  const [leaderboardMode, setLeaderboardMode] = useState("all");
  const [sortOrder, setSortOrder] = useState("desc");
  const [leaderboardRevision, setLeaderboardRevision] = useState(0);
  const [period, setPeriod] = useState("all");
  const [dataScope, setDataScope] = useState(null);
  const [socialProviders, setSocialProviders] = useState({});
  const emailRef = useRef(null);
  const settingsEmailRef = useRef(null);

  const setTrainingState = useCallback((next) => {
    trainingRef.current = next;
    setTraining(next);
  }, []);

  const resetExercise = useCallback(() => {
    setSaveState(null);
    finishedRef.current = false;
    setLayoutWarning("");
    setTrainingState(makeTraining(mode, lang, codeLang, customText, difficulty));
    setNow(clockNow());
  }, [codeLang, customText, difficulty, lang, mode, setLayoutWarning, setTrainingState]);

  const startCustomExercise = useCallback(() => {
    const text = customDraft.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").trim();
    if (!text) return;
    setSaveState(null);
    finishedRef.current = false;
    setLayoutWarning("");
    setCustomText(text);
    setTrainingState(makeTraining("custom", lang, codeLang, text, difficulty));
    setNow(clockNow());
    // Wait for an explicit click before capturing typing.
  }, [codeLang, customDraft, difficulty, lang, setTrainingState]);

  useEffect(() => {
    window.localStorage.setItem("typing-speed-unit", speedUnit);
  }, [speedUnit]);

  useEffect(() => () => {
    window.clearTimeout(toastTimer.current);
    window.clearTimeout(achievementTimer.current);
  }, []);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4200);
  }, []);

  const { settingsBusy, settingsError, setSettingsError, submitUsernameChange, submitEmailChange, submitPasswordChange } = useProfileSettings({ setProfile, notify });

  const loadProfile = useCallback(async () => {
    const accountRevision = accountRevisionRef.current;
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (response.ok) {
        const data = await response.json();
        if (accountRevision === accountRevisionRef.current) setProfile(data);
      } else {
        if (accountRevision === accountRevisionRef.current) setProfile(null);
      }
    } catch {
      if (accountRevision === accountRevisionRef.current) setProfile(null);
    }
  }, [setProfile]);

  const notifications = useNotifications({ profile, setProfile, notify, setSettingsError, loadProfile });

  const persistSession = useCallback(async (payload, accountId = profileRef.current?.id) => {
    if (!accountId || profileRef.current?.id !== accountId) {
      notify("Войдите в тот аккаунт, в котором была начата эта попытка, чтобы повторить сохранение.");
      return;
    }
    const id = payload.client_session_id;
    const accountRevision = accountRevisionRef.current;
    const sameAccount = () => accountRevision === accountRevisionRef.current && profileRef.current?.id === accountId;
    setSaveState({ id, accountId, status: "saving", payload });
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!sameAccount()) {
        setSaveState((previous) => previous?.id === id ? { id, accountId, status: "error", payload, error: "Аккаунт изменился. Войдите в исходный аккаунт и повторите сохранение — результат не будет записан дважды." } : previous);
        return;
      }
      if (!response.ok) {
        if (response.status === 401) setProfile(null);
        throw new Error(errorMessage(data, "Не удалось сохранить результат на сервере."));
      }
      if (data.profile?.id !== accountId) throw new Error("Ответ сервера относится к другому аккаунту. Повторите сохранение после входа в исходный аккаунт.");
      setProfile(data.profile);
      setLeaderboardRevision((revision) => revision + 1);
      if (trainingRef.current.clientSessionId === id) {
        setTrainingState({ ...trainingRef.current, savedMetrics: data.metrics });
        setSaveState({ id, accountId, status: "saved", payload, result: data });
        const result = data.metrics;
        notify(`Сохранено: ${result.wpm} слов/мин · ${result.cpm} знаков/мин · точность ${result.accuracy}% · +${data.xp_earned} опыта${result.is_ranked === false ? ". Короткая попытка — вне рейтинга." : ""}`);
      }
      const unlocked = data.newly_unlocked || [];
      if (unlocked.length) {
        setAchievementToast(unlocked[0]);
        window.clearTimeout(achievementTimer.current);
        achievementTimer.current = window.setTimeout(() => setAchievementToast(null), 6500);
      }
    } catch (error) {
      const message = error instanceof TypeError ? "Не удалось сохранить результат. Проверьте соединение и повторите сохранение." : error.message;
      setSaveState((previous) => previous?.id === id ? { id, accountId, status: "error", payload, error: message } : previous);
      if (sameAccount() && trainingRef.current.clientSessionId === id) notify(message);
    }
  }, [notify, setProfile, setTrainingState]);

  const finishExercise = useCallback((completeTraining) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const result = getMetrics(completeTraining);
    if (profile) {
      const payload = getSessionPayload(completeTraining, {
        mode,
        difficulty,
        lang: mode === "code" ? "en" : mode === "custom" ? detectTextLanguage(completeTraining.target, lang) : lang,
      });
      void persistSession(payload);
    } else {
      notify(`Готово: ${result.wpm} слов/мин · ${result.cpm} знаков/мин · точность ${result.accuracy}%. Войдите, чтобы сохранять результаты.`);
    }
  }, [difficulty, lang, mode, notify, persistSession, profile]);

  useEffect(() => {
    resetExercise();
  }, [resetExercise]);

  useEffect(() => {
    if (training.startedAt === null || training.finishedAt !== null) return undefined;
    const timer = window.setInterval(() => setNow(clockNow()), 250);
    return () => window.clearInterval(timer);
  }, [training.finishedAt, training.startedAt]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    let active = true;
    fetch("/api/status")
      .then((response) => response.ok ? response.json() : {})
      .then((status) => { if (active) setDataScope(status.data_scope || null); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/providers")
      .then((response) => response.ok ? response.json() : {})
      .then((providers) => { if (active) setSocialProviders(providers); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const authErrorParam = url.searchParams.get("auth_error");
    const linkErrorParam = url.searchParams.get("link_error");
    const linkedProvider = url.searchParams.get("account_linked");
    if (authErrorParam) {
      setAuthMode("login");
      setAuthOpen(true);
      const provider = authErrorParam.replace("_setup", "");
      const label = SOCIAL_PROVIDER_LABELS[provider] || "внешний аккаунт";
      setAuthError(authErrorParam.endsWith("_setup")
        ? `Вход через ${label} пока не настроен.`
        : `Не удалось войти через ${label}. Попробуйте ещё раз.`);
      url.searchParams.delete("auth_error");
    }
    if (linkErrorParam) {
      setSettingsError(`Не удалось подключить ${SOCIAL_PROVIDER_LABELS[linkErrorParam] || "аккаунт"}. Проверьте настройки входа и повторите попытку.`);
      setSettingsOpen(true);
      url.searchParams.delete("link_error");
    }
    if (linkedProvider) {
      void loadProfile();
      notify(`Подключён аккаунт: ${SOCIAL_PROVIDER_LABELS[linkedProvider] || linkedProvider}.`);
      url.searchParams.delete("account_linked");
    }
    if (!authErrorParam && !linkErrorParam && !linkedProvider) return;
    window.history.replaceState({}, "", url);
  }, [loadProfile, notify]);

  useEffect(() => {
    if (!authOpen && !settingsOpen) return undefined;
    const timer = window.setTimeout(() => (authOpen ? emailRef.current : settingsEmailRef.current)?.focus(), 0);
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setAuthOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [authOpen, settingsOpen]);

  const { rows: leaderboard, error: leaderboardError, loading: leaderboardLoading, updatedAt: leaderboardUpdatedAt, refresh: refreshLeaderboard, page: leaderboardPage, setPage: setLeaderboardPage, hasNext: leaderboardHasNext } = useLeaderboard({
    active: page === "leaderboard",
    sortBy: sortBy === "speed" ? speedUnit : sortBy,
    period,
    mode: leaderboardMode,
    order: sortOrder,
    revision: `${leaderboardRevision}:${profile?.leaderboard_public}`,
  });

  const metrics = useMemo(() => training.savedMetrics || getMetrics(training, now), [now, training]);

  const typeKey = useCallback((key, event = {}) => {
    if (authOpen || settingsOpen || page !== "trainer" || mode === "race") return;
    const current = trainingRef.current;
    if (current.finishedAt !== null || finishedRef.current) return;
    const expected = current.targetChars[current.index];
    if (expected === undefined) return;
    const customLanguage = detectTextLanguage(current.target, lang);
    const expectedLanguage = mode === "code" ? "en" : mode === "custom" ? getCharacterLanguage(expected, customLanguage) : lang;
    setLayoutWarning(key === "Backspace" ? "" : getLayoutWarning(expected, key, event.code, expectedLanguage, event.shiftKey));
    const next = applyKeystroke(current, key, clockNow());
    if (next === current) return;
    setTrainingState(next);
    setNow(clockNow());
    if (soundEnabled && key !== "Backspace") playTone(next.errors > current.errors ? 190 : 440 + next.combo * 50, 0.075, 0.055);
    if (next.finishedAt !== null) finishExercise(next);
  }, [authOpen, settingsOpen, page, mode, lang, setTrainingState, soundEnabled, finishExercise]);

  const keyDown = useCallback((event) => {
    const isMobileTyping = event.target === mobileInputRef.current;
    if (isMobileTyping && event.key !== "Backspace") return;
    if (event.target !== typingRef.current && !isMobileTyping) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
    if (event.key !== "Enter" && event.key !== "Backspace" && Array.from(event.key).length !== 1) return;
    if (page !== "trainer" || mode === "race" || authOpen || settingsOpen) return;
    if (isMobileTyping || [" ", "Enter", "Backspace"].includes(event.key)) event.preventDefault();
    typeKey(event.key === "Enter" ? "\n" : event.key, event);
  }, [typeKey, page, mode, authOpen, settingsOpen]);

  const mobileInput = (event) => {
    const value = event.currentTarget.value;
    event.currentTarget.value = "";
    for (const character of Array.from(value)) typeKey(character);
  };

  // Keyboard input is scoped to the focused exercise, not the entire page.

  const openAuth = (nextMode = "login") => {
    setAuthMode(nextMode);
    setAuthError("");
    setAuthOpen(true);
  };

  const submitAuth = async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      email: String(formData.get("email") || "").trim(),
      password: String(formData.get("password") || ""),
    };
    if (authMode === "register") {
      payload.username = String(formData.get("username") || "").trim();
      payload.leaderboard_public = Boolean(formData.get("leaderboard_public"));
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch(authMode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Проверьте данные и попробуйте ещё раз."));
      setProfile(data);
      setAuthOpen(false);
      notify(`Рады видеть, ${data.username}.`);
    } catch (error) {
      setAuthError(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const accountAction = async () => {
    if (!profile) {
      openAuth("login");
      return;
    }
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("logout");
      setProfile(null);
      setProfileMenuOpen(false);
      notify("Вы вышли из аккаунта.");
    } catch {
      notify("Не удалось выйти. Проверьте соединение.");
    }
  };

  const changeLeaderboardVisibility = async (enabled) => {
    setLeaderboardVisibilityBusy(true);
    try {
      const response = await fetch("/api/profile/leaderboard-visibility", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaderboard_public: enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(data, "Не удалось сохранить настройки таблицы лидеров."));
      setProfile(data);
      notify(enabled ? "Ваш ник и результаты будут видны в таблице лидеров." : "Ваш профиль скрыт из таблицы лидеров.");
    } catch (error) {
      notify(error instanceof TypeError ? "Не удалось подключиться. Проверьте соединение." : error.message);
    } finally {
      setLeaderboardVisibilityBusy(false);
    }
  };

  const openProfileSettings = () => {
    setProfileMenuOpen(false);
    setSettingsError("");
    setSettingsOpen(true);
  };

  const clearCustomText = () => {
    setCustomDraft("");
    setCustomText("");
    setLayoutWarning("");
    setSaveState(null);
    finishedRef.current = false;
    setTrainingState(makeTraining("custom", lang, codeLang));
  };

  const speedIsMeasuring = training.startedAt !== null && training.finishedAt === null && metrics.durationMs < 1000;
  const currentChar = training.targetChars[training.index];
  const exerciseComplete = training.finishedAt !== null;
  const customLanguage = detectTextLanguage(customDraft || customText, lang);
  const customHasLetters = /[а-яёa-z]/i.test(customDraft || customText);
  const customLanguageLabel = customHasLetters ? (customLanguage === "ru" ? "русский" : "английский") : "определится автоматически";
  const keyboardLanguage = mode === "code" ? "en" : mode === "custom" ? customLanguage : lang;
  const keyboardRows = KEY_ROWS[keyboardLanguage];
  const copy = page === "trainer" && mode === "race" ? ["КЛАВАГОНКИ", "Выйди на старт.", "Один текст, два игрока. Набирай быстрее и точнее, чтобы первым пересечь финиш."] : PAGE_COPY[page];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#trainer" onClick={(event) => { event.preventDefault(); setPage("trainer"); }} aria-label="Печать героя — на главную">
            <span className="brand-mark" aria-hidden="true"><svg className="brand-icon" viewBox="0 0 40 40" fill="none"><rect x="7.5" y="8" width="7" height="7" rx="1.8" /><rect x="16.5" y="8" width="7" height="7" rx="1.8" /><rect x="25.5" y="8" width="7" height="7" rx="1.8" /><rect x="7.5" y="17" width="7" height="7" rx="1.8" /><rect x="16.5" y="17" width="7" height="7" rx="1.8" /><path d="M27 19h5m-2.5-2.5L32 19l-2.5 2.5M10 30h14" /></svg></span>
            <span className="brand-name"><strong>Печать героя</strong><small>КИБЕРРЫВОК · 2026</small></span>
          </a>
          <nav className="main-nav" aria-label="Разделы">
            {[["trainer", "Тренажёр"], ["stats", "Мой прогресс"], ["achievements", "Награды"], ["leaderboard", "Таблица лидеров"]].map(([id, label]) => (
              <button key={id} type="button" className={`nav-link ${page === id ? "is-current" : ""}`} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}>{label}</button>
            ))}
          </nav>
          <div className="topbar-actions">
            {profile ? <div
              className={`profile-menu-root ${profileMenuOpen ? "is-open" : ""}`}
              onMouseEnter={() => setProfileMenuOpen(true)}
              onMouseLeave={() => setProfileMenuOpen(false)}
              onFocus={() => setProfileMenuOpen(true)}
              onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setProfileMenuOpen(false); }}
            >
              <button
                className="user-chip"
                type="button"
                title={`${profile.xp} опыта`}
                aria-haspopup="true"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((open) => (window.matchMedia("(hover: none)").matches ? !open : true))}
              >
                <span className="user-dot">{profile.username.slice(0, 1).toUpperCase()}</span>
                <span>{profile.username}</span>
                <b>ур. {profile.level}</b>
                <span className="streak-chip" title="Дней практики подряд">🔥 {profile.streak_days || 0}</span>
                <span className="profile-chevron" aria-hidden="true">⌄</span>
              </button>
              <div className="profile-popover" aria-label="Меню профиля">
                <div className="profile-popover-heading"><span className="user-dot">{profile.username.slice(0, 1).toUpperCase()}</span><div><strong>{profile.username}</strong><small>{profile.email || "Вход через аккаунт"}</small></div></div>
                <div className="profile-level-card"><div><span>УРОВЕНЬ {profile.level}</span><strong>{profile.xp} XP</strong></div><div className="profile-level-track"><span style={{ width: `${Math.max(0, Math.min(100, ((profile.xp % 500) / 500) * 100))}%` }} /></div><small>До следующего уровня: {500 - (profile.xp % 500)} XP</small></div>
                <div className="streak-note">🔥 {profile.streak_days || 0} {profile.streak_days === 1 ? "день практики подряд" : "дней практики подряд"}{profile.practiced_today ? " · сегодня уже занимались" : " · начните сегодня"}</div>
                <button className="profile-menu-action" type="button" onClick={() => { setPage("stats"); setProfileMenuOpen(false); }}>Мой прогресс <span>↗</span></button>
                <button className="profile-menu-action" type="button" onClick={openProfileSettings}>Настройки профиля <span>⚙</span></button>
                <label className="profile-visibility"><span><strong>Таблица лидеров</strong><small>{profile.leaderboard_public ? "Ваши результаты показываются" : "Ваши результаты скрыты"}</small></span><input type="checkbox" checked={Boolean(profile.leaderboard_public)} disabled={leaderboardVisibilityBusy} onChange={(event) => changeLeaderboardVisibility(event.target.checked)} /></label>
                <button className="profile-logout" type="button" onClick={accountAction}>Выйти из аккаунта</button>
              </div>
            </div> : <button className="button button-outline account-button" type="button" onClick={accountAction}>Войти</button>}
          </div>
        </div>
      </header>

      <main className="page-wrap">
        {dataScope === "local" && <div className="local-database-notice" role="status"><div><strong>Вы запустили сайт на своём компьютере</strong><span>Результаты сохраняются только здесь и не попадают в общую таблицу лидеров.</span></div><a href="https://demoground.ru">Открыть основную версию сайта</a></div>}
        <section className="page-heading">
          <div><p className="eyebrow">{copy[0]}</p><h1>{copy[1]}</h1><p className="heading-copy">{copy[2]}</p></div>
          <div className="heading-aside"><span className="aside-line" /><p><strong>{profile ? `Уровень ${profile.level}` : "Без спешки"}</strong><br />{profile ? `${profile.xp} очков опыта` : "Точность важнее скорости."}</p></div>
        </section>

        {page === "trainer" && (
          <section className="trainer-view" aria-label="Тренажёр">
            <div className="trainer-controls panel">
              <div className="mode-switch" role="group" aria-label="Тип упражнения">
                {MODES.map((item) => <button key={item.id} type="button" className={`mode-option ${mode === item.id ? "selected" : ""}`} onClick={() => setMode(item.id)}>{item.label}</button>)}
              </div>
              <div className="control-spacer" />
              {mode !== "race" && <>
              {mode !== "custom" && <label className="control-select"><span>Сложность</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>{DIFFICULTIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
              {mode === "code" ? (
                <label className="control-select"><span>Язык кода</span><select value={codeLang} onChange={(event) => setCodeLang(event.target.value)}><option value="python">Python</option><option value="javascript">JavaScript</option><option value="html">HTML</option></select></label>
              ) : mode === "custom" ? <span className="language-detected">Язык: {customLanguageLabel}</span> : <div className="language-switch" role="group" aria-label="Язык упражнения"><button type="button" className={lang === "ru" ? "selected" : ""} onClick={() => setLang("ru")}>РУ</button><button type="button" className={lang === "en" ? "selected" : ""} onClick={() => setLang("en")}>EN</button></div>}
              </>}
              <div className="unit-switch" role="group" aria-label="Единица измерения скорости"><button type="button" className={speedUnit === "wpm" ? "selected" : ""} onClick={() => setSpeedUnit("wpm")}>Слова/мин</button><button type="button" className={speedUnit === "cpm" ? "selected" : ""} onClick={() => setSpeedUnit("cpm")}>Знаки/мин</button></div>
              {mode !== "race" && <button type="button" className="sound-toggle" onClick={() => setSoundEnabled((enabled) => !enabled)} aria-pressed={soundEnabled}>{soundEnabled ? "Звук вкл." : "Звук выкл."}</button>}
            </div>

            {mode === "race" ? <RaceMode key={profile?.id || "guest"} profile={profile} speedUnit={speedUnit} onProfileUpdate={(updated) => { setProfile(updated); setLeaderboardRevision((value) => value + 1); }} onLogin={() => openAuth("login")} /> : <>
            {mode === "custom" && <div className="custom-words-panel panel">
              <label className="custom-words-field" htmlFor="custom-words-input">
                <span>Ваш текст для тренировки</span>
                <textarea id="custom-words-input" value={customDraft} onChange={(event) => setCustomDraft(event.target.value)} maxLength={500} placeholder="Введите слова или фразу — до 500 знаков" />
                <span className="custom-words-hint"><span>Слова можно разделять пробелами или переносами строк. Текст останется, если переключиться на другой режим.</span><span>{customDraft.length}/500</span></span>
              </label>
              <div className="custom-actions"><button className="button button-primary custom-start" type="button" onClick={startCustomExercise} disabled={!customDraft.trim()}>Начать печатать</button><button className="button button-outline custom-clear" type="button" onClick={clearCustomText} disabled={!customDraft && !customText}>Очистить текст</button></div>
            </div>}

            <div className="metric-grid" aria-label="Текущий результат">
              {[[speedUnit === "wpm" ? "СЛОВА В МИНУТУ" : "ЗНАКИ В МИНУТУ", speedIsMeasuring ? "—" : speedUnit === "wpm" ? metrics.wpm : metrics.cpm, speedUnit === "wpm" ? "слов/мин" : "знаков/мин"], [speedUnit === "wpm" ? "ЗНАКИ В МИНУТУ" : "СЛОВА В МИНУТУ", speedIsMeasuring ? "—" : speedUnit === "wpm" ? metrics.cpm : metrics.wpm, speedUnit === "wpm" ? "знаков/мин" : "слов/мин"], ["ТОЧНОСТЬ", `${metrics.accuracy}%`, ""], ["ОШИБКИ", training.errors, ""], ["КОМБО", `×${training.combo}`, `серия ${training.streak}`], ["ОЧКИ", Math.round(training.score), ""]].map(([label, value, suffix]) => <div key={label} className="metric-item"><span>{label}</span><strong>{value}</strong><small>{suffix || " "}</small></div>)}
            </div>

            <div className={`typing-panel panel ${exerciseComplete ? "is-complete" : ""}`}>
              <div className="exercise-topline"><span>{mode === "code" ? `ПРАКТИКА · ${codeLang.toUpperCase()} · ${DIFFICULTIES.find((item) => item.id === difficulty)?.label.toUpperCase()}` : mode === "custom" ? `СВОИ СЛОВА · ${customLanguage === "ru" ? "РУССКИЙ" : "АНГЛИЙСКИЙ"}` : `ПРАКТИКА · ${lang === "ru" ? "РУССКИЙ" : "АНГЛИЙСКИЙ"} · ${DIFFICULTIES.find((item) => item.id === difficulty)?.label.toUpperCase()}`}</span><span className="exercise-progress">{exerciseComplete ? "ГОТОВО" : training.target.length ? training.startedAt !== null ? `${training.index} / ${training.targetChars.length} ЗНАКОВ` : "ГОТОВ К СТАРТУ" : "ВВЕДИТЕ СВОЙ ТЕКСТ"}</span></div>
              {layoutWarning && <div className="layout-warning" role="alert"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2L10 2.5Z" /><path d="M10 7v4.5m0 2.5h.01" /></svg><span>{layoutWarning}</span></div>}
              {exerciseComplete && <div className="completion-burst" role="status"><span aria-hidden="true">✦</span> Упражнение завершено {saveState?.status === "saved" && <b>+{saveState.result.xp_earned} опыта</b>}{saveState?.status === "saving" && <b>Сохраняем результат…</b>}</div>}
              {exerciseComplete && saveState?.result?.metrics?.is_ranked === false && <p className="result-note">{saveState.result.metrics.ranking_reason || "Для рейтинга нужна попытка от 10 знаков и 3 секунд. Скорость этой попытки сохранена в истории."}</p>}
              {exerciseComplete && saveState?.status === "error" && <div className="save-error" role="alert"><p>{saveState.error}</p><button className="button button-outline" type="button" onClick={() => persistSession(saveState.payload, saveState.accountId)}>Повторить сохранение</button></div>}
              <div ref={typingRef} className={`typing-text ${mode === "code" ? "typing-code" : ""}`} role="group" aria-label="Нажмите на текст и печатайте" tabIndex={0} onKeyDown={keyDown} onClick={(event) => { if (event.target !== mobileInputRef.current) typingRef.current?.focus(); }}>
                {Array.from(training.target).map((char, index) => <span key={`${index}-${char}`} className={`typing-char ${index < training.index ? "is-done" : ""} ${index === training.index ? "is-next" : ""} ${training.errorPositions.includes(index) ? "has-error" : ""}`}>{char === "\n" ? "↵\n" : char}</span>)}
              <input ref={mobileInputRef} className="mobile-typing-input" type="text" onChange={mobileInput} onPaste={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()} autoCapitalize="off" autoCorrect="off" spellCheck="false" autoComplete="off" aria-label="Нажмите сюда и печатайте на экранной клавиатуре" placeholder="Нажмите сюда и печатайте" />
              </div>
              <div className="typing-bottom"><p>{exerciseComplete ? "Результат зафиксирован. Начни следующее упражнение, когда будешь готов." : training.startedAt === null ? "Нажми на текст упражнения, затем печатай. Набор вне поля не учитывается." : "Ошибся? Продолжай со следующего знака. Backspace — исправить по желанию."}</p><button className="text-button" type="button" onClick={resetExercise}>{exerciseComplete ? "Следующее упражнение" : "Другое упражнение"} <span aria-hidden="true">↻</span></button></div>
            </div>

            <div className="keyboard-area">
              <div className="keyboard-caption"><span>ПОДСКАЗКА ПО ПАЛЬЦАМ</span>{currentChar && <p>Следующий знак <strong>«{currentChar === "\n" ? "ENTER · ↵" : currentChar === " " ? "ПРОБЕЛ · SPACE" : currentChar.toUpperCase()}»</strong> — {getFingerHint(currentChar, keyboardLanguage)}.</p>}</div>
              <div className="keyboard" aria-label="Экранная клавиатура">
                {keyboardRows.map((row, rowIndex) => <div className={`key-row row-${rowIndex}`} key={`${keyboardLanguage}-${rowIndex}`}>{Array.from(row).map((key, keyIndex) => {
                  const targetKey = currentChar === "\n" ? " " : currentChar?.toLocaleLowerCase();
                  const active = targetKey === key.toLocaleLowerCase();
                  const finger = FINGER_ROWS[keyboardLanguage][rowIndex][keyIndex];
                  return <span key={`${rowIndex}-${keyIndex}`} className={`keycap ${finger} ${active ? "key-active" : ""} ${key === " " ? "space-key" : ""}`}>{key === " " ? "ПРОБЕЛ" : key.toUpperCase()}</span>;
                })}</div>)}
                <div className="key-row final-row"><span className={`keycap space-key ${currentChar === " " || currentChar === "\n" ? "key-active" : ""}`}>ПРОБЕЛ</span></div>
              </div>
              {!profile && <p className="save-note">Хочешь сохранить результат? <button type="button" onClick={() => openAuth("register")}>Создай аккаунт</button></p>}
            </div>
            </>}
          </section>
        )}

        {page === "stats" && <StatsView profile={profile} speedUnit={speedUnit} onSpeedUnit={setSpeedUnit} onLogin={() => openAuth("login")} onLeaderboardVisibilityChange={changeLeaderboardVisibility} visibilityBusy={leaderboardVisibilityBusy} />}
        {page === "achievements" && <AchievementsView profile={profile} onLogin={() => openAuth("login")} />}
        {page === "leaderboard" && <LeaderboardView page={leaderboardPage} onPage={setLeaderboardPage} hasNext={leaderboardHasNext} rows={leaderboard} error={leaderboardError} loading={leaderboardLoading} updatedAt={leaderboardUpdatedAt} onRefresh={refreshLeaderboard} sortBy={sortBy} period={period} mode={leaderboardMode} order={sortOrder} speedUnit={speedUnit} onSpeedUnit={setSpeedUnit} onSort={setSortBy} onPeriod={setPeriod} onMode={setLeaderboardMode} onOrder={setSortOrder} profile={profile} onLogin={() => openAuth("login")} onLeaderboardVisibilityChange={changeLeaderboardVisibility} visibilityBusy={leaderboardVisibilityBusy} />}
      </main>

      {authOpen && <AuthDialog authMode={authMode} setAuthOpen={setAuthOpen} socialProviders={socialProviders} authError={authError} submitAuth={submitAuth} emailRef={emailRef} authBusy={authBusy} setAuthMode={setAuthMode} setAuthError={setAuthError} />}
      {settingsOpen && profile && <ProfileSettingsDialog profile={profile} setSettingsOpen={setSettingsOpen} socialProviders={socialProviders} settingsError={settingsError} leaderboardVisibilityBusy={leaderboardVisibilityBusy} changeLeaderboardVisibility={changeLeaderboardVisibility} notifications={notifications} loadProfile={loadProfile} submitUsernameChange={submitUsernameChange} submitEmailChange={submitEmailChange} submitPasswordChange={submitPasswordChange} settingsEmailRef={settingsEmailRef} settingsBusy={settingsBusy} />}
      <div className="toast-host" aria-live="polite" aria-atomic="true">{toast && <div className="toast-message">{toast}</div>}</div>
      {achievementToast && <div className="achievement-toast" role="status"><span className="achievement-toast-icon">{achievementToast.icon || "✦"}</span><span><small>НАГРАДА ОТКРЫТА</small><strong>{achievementToast.title}</strong><em>{achievementToast.desc}</em></span><i aria-hidden="true">✦</i></div>}
      <footer className="site-footer">
        <div className="footer-brand"><span className="brand-mark" aria-hidden="true"><img src="/static/favicon.svg" alt="" /></span><span><strong>Печать героя</strong><small>Киберрывок · 2026</small></span></div>
        <div><strong>Как заниматься</strong><p>Выберите упражнение, нажмите на текст и печатайте. Ошибка продвигает курсор и снижает точность; Backspace позволяет исправить её.</p></div>
        <div><strong>Скорость и прогресс</strong><p>Знаки/мин — правильно набранные знаки за минуту. Слова/мин — это знаки/мин, поделённые на 5. В профиле сохраняются результаты и сложные для вас клавиши.</p></div>
        <div><strong>Напоминания в MAX</strong><p>Свяжите профиль с ботом MAX, чтобы получать напоминания и итоги тренировок. Уведомлений браузера нет.</p></div>
      </footer>
    </div>
  );
}

export default App;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
