import React, { useCallback, useEffect, useRef, useState } from "react";
import { applyKeystroke, clockNow, createTraining, getMetrics } from "../training/engine.js";
import "../styles/races.css";

function payloadError(payload, fallback) {
  return typeof payload?.detail === "string" ? payload.detail : fallback;
}

async function raceRequest(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(path, {
      credentials: "same-origin", cache: "no-store", ...options, signal: controller.signal,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(payloadError(payload, "Не удалось связаться с комнатой. Попробуйте ещё раз."));
      failure.status = response.status;
      throw failure;
    }
    return payload;
  } catch (failure) {
    if (timedOut) throw new Error("Сервер не ответил вовремя. Проверьте соединение.");
    throw failure;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function RaceCar({ color, waiting }) {
  return <svg className={`race-car ${waiting ? "race-car-still" : ""}`} viewBox="0 0 108 58" aria-hidden="true" style={{ "--car-color": color }}>
    <ellipse cx="53" cy="49" rx="43" ry="5" fill="#142c2825" />
    <path d="M10 31 20 28 32 13Q36 8 46 8h22q8 0 15 12l8 10q12 2 12 9v6H6V36q0-4 4-5Z" fill="var(--car-color)" />
    <path d="m37 15-9 14h26V14H41q-3 0-4 1Zm23-1v15h23l-7-10q-3-5-9-5Z" fill="#e5f0ec" />
    <path d="M10 34h10v6H8m84-6h9v6H91" fill="#fdf1c0" />
    <path d="M46 33h8" stroke="#ffffff99" strokeWidth="3" strokeLinecap="round" />
    <g fill="#20332e" stroke="#f4f2eb" strokeWidth="3"><circle cx="28" cy="44" r="10" /><circle cx="81" cy="44" r="10" /></g>
    <g fill="#a9bbb1"><circle cx="28" cy="44" r="4" /><circle cx="81" cy="44" r="4" /></g>
  </svg>;
}

function carProgress(player, length, now) {
  if (!player || !length) return 0;
  const base = Math.min(0.97, (player.metrics?.correct_characters || 0) / length);
  if (!player.finish_ms) return base;
  if (now >= player.finish_ms) return 1;
  const penalty = player.finish_ms - player.completed_ms;
  return penalty ? base + (1 - base) * Math.max(0, (now - player.completed_ms) / penalty) : 1;
}

function playerStatus(player, room, now) {
  if (!player) return "Ждём второго игрока";
  if (player.left) return "Покинул гонку";
  if (player.completed_ms && !player.qualified) return "Вне зачёта · точность ниже 80%";
  if (player.finish_ms && now >= player.finish_ms) return room.winner_id === player.user_id ? "Победитель" : "Финиш";
  if (player.finish_ms) return `Штраф: ещё ${Math.max(0, (player.finish_ms - now) / 1000).toFixed(1)} с`;
  if (now - player.last_seen_ms > 5_000) return "Связь прервалась…";
  if (room.state === "waiting") return "Готов к старту";
  if (now < room.starts_ms) return "На стартовой линии";
  return `${player.characters} / ${Array.from(room.target_text).length} знаков`;
}

export default function RaceMode({ profile, speedUnit = "cpm", onProfileUpdate, onLogin }) {
  const inviteCode = () => new URLSearchParams(window.location.search).get("race")?.toUpperCase().slice(0, 6) || "";
  const [codeDraft, setCodeDraft] = useState(inviteCode);
  const [lang, setLang] = useState("ru");
  const [room, setRoom] = useState(null);
  const [training, setTraining] = useState(() => createTraining(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [syncBlocked, setSyncBlocked] = useState(false);
  const [, setTick] = useState(0);
  const roomRef = useRef(null);
  const trainingRef = useRef(training);
  const clockRef = useRef({ server: Date.now(), local: performance.now() });
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const seqRef = useRef(0);
  const sendingRef = useRef(false);
  const pendingRef = useRef(null);
  const sendTimerRef = useRef(null);
  const sendControllerRef = useRef(null);
  const flushRef = useRef(null);
  const inputRef = useRef(null);
  const profileSessionRef = useRef(null);
  const onProfileUpdateRef = useRef(onProfileUpdate);
  onProfileUpdateRef.current = onProfileUpdate;
  const serverNow = () => clockRef.current.server + performance.now() - clockRef.current.local;

  const updateTraining = useCallback((next) => {
    trainingRef.current = next;
    setTraining(next);
  }, []);

  const acceptRoom = useCallback((snapshot, hydrate = false) => {
    if (!mountedRef.current) return;
    const previous = roomRef.current;
    if (previous?.code === snapshot.code && previous.server_now_ms > snapshot.server_now_ms) return;
    clockRef.current = { server: snapshot.server_now_ms, local: performance.now() };
    roomRef.current = snapshot;
    setRoom(snapshot);
    const mine = snapshot.players.find((player) => player.user_id === snapshot.you);
    const start = snapshot.starts_ms === null ? null : clockNow() - (snapshot.server_now_ms - snapshot.starts_ms);
    if (hydrate || previous?.code !== snapshot.code) {
      let next = createTraining(snapshot.target_text);
      next.startedAt = start;
      for (const event of mine?.keystrokes || []) next = applyKeystroke(next, event.key, start + event.at_ms);
      updateTraining(next);
      seqRef.current = mine?.client_seq || 0;
    } else if (trainingRef.current.startedAt === null && start !== null) {
      updateTraining({ ...trainingRef.current, startedAt: start });
    }
    if (snapshot.profile) {
      profileSessionRef.current = mine?.session_id;
      onProfileUpdateRef.current?.(snapshot.profile);
    }
  }, [updateTraining]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setInterval(() => setTick((value) => value + 1), 100);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      window.clearInterval(timer);
      window.clearTimeout(sendTimerRef.current);
      sendControllerRef.current?.abort();
    };
  }, []);

  const resetRoom = useCallback(() => {
    generationRef.current += 1;
    sendControllerRef.current?.abort();
    window.clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;
    sendingRef.current = false;
    pendingRef.current = null;
    roomRef.current = null;
    setRoom(null);
    setSyncBlocked(false);
    updateTraining(createTraining(""));
    profileSessionRef.current = null;
  }, [updateTraining]);

  useEffect(() => {
    resetRoom();
  }, [profile?.id, resetRoom]);

  const openRoom = async (action, code = codeDraft) => {
    if (!profile) { onLogin(); return; }
    const generation = generationRef.current;
    setBusy(true);
    setError("");
    try {
      const snapshot = await raceRequest(action === "create" ? "/api/races" : `/api/races/${encodeURIComponent(code.trim().toUpperCase())}/join`, {
        method: "POST", body: action === "create" ? JSON.stringify({ lang }) : undefined,
      });
      if (!mountedRef.current || generation !== generationRef.current) return;
      acceptRoom(snapshot, true);
      sessionStorage.setItem(`typing-race-room:${profile.id}`, snapshot.code);
      setCodeDraft(snapshot.code);
    } catch (failure) {
      if (mountedRef.current && generation === generationRef.current) setError(failure.message);
    } finally {
      if (mountedRef.current && generation === generationRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!room?.code) return undefined;
    const code = room.code;
    const generation = generationRef.current;
    const controller = new AbortController();
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const snapshot = await raceRequest(`/api/races/${code}`, { signal: controller.signal });
        if (stopped || generation !== generationRef.current) return;
        acceptRoom(snapshot);
        setError((current) => current.startsWith("Связь с гонкой прервалась.") ? "" : current);
        if (pendingRef.current && !sendingRef.current) flushRef.current?.();
        if (["expired", "closed"].includes(snapshot.state)
            || (snapshot.state === "finished" && snapshot.players.every((player) =>
              player.left || (player.completed_ms && (!player.finish_ms || player.finish_ms <= snapshot.server_now_ms))))) stopped = true;
      } catch (failure) {
        if (!stopped && failure.name !== "AbortError") setError("Связь с гонкой прервалась. Ввод сохраняется, переподключаемся…");
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 750);
      }
    };
    timer = window.setTimeout(poll, 300);
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [room?.code, acceptRoom]);

  const flushProgress = useCallback(async () => {
    sendTimerRef.current = null;
    const snapshot = roomRef.current;
    if (sendingRef.current || !pendingRef.current || !snapshot) return;
    const progress = pendingRef.current;
    pendingRef.current = null;
    sendingRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    sendControllerRef.current = controller;
    const clientSeq = ++seqRef.current;
    try {
      const result = await raceRequest(`/api/races/${snapshot.code}/progress`, {
        method: "PUT", signal: controller.signal,
        body: JSON.stringify({ typed_text: progress.typedChars.join(""), keystrokes: progress.keystrokes, client_seq: clientSeq }),
      });
      if (generation !== generationRef.current || !mountedRef.current) return;
      acceptRoom(result);
      setError("");
    } catch (failure) {
      if (failure.name !== "AbortError" && generation === generationRef.current && mountedRef.current) {
        if ([401, 403, 404, 409, 422].includes(failure.status)) {
          pendingRef.current = null;
          setSyncBlocked(true);
          setError(failure.message);
        } else {
          pendingRef.current = pendingRef.current || progress;
          setError(`${failure.message} Результат будет отправлен повторно.`);
        }
      }
    } finally {
      if (generation === generationRef.current) {
        sendingRef.current = false;
        if (pendingRef.current && mountedRef.current) sendTimerRef.current = window.setTimeout(() => flushRef.current?.(), 750);
      }
    }
  }, [acceptRoom]);
  flushRef.current = flushProgress;

  const me = room?.players.find((player) => player.user_id === room.you);
  const now = serverNow();
  const countdown = room?.starts_ms ? Math.max(0, Math.ceil((room.starts_ms - now) / 1000)) : null;
  const canType = Boolean(room && room.starts_ms !== null && !countdown && !me?.left && !me?.completed_ms
    && !syncBlocked && !["expired", "closed"].includes(room.state) && now < room.expires_ms && training.finishedAt === null);

  // A race starts on the server; typing still requires clicking its input.

  useEffect(() => {
    if (!me?.session_id || profileSessionRef.current === me.session_id) return undefined;
    const controller = new AbortController();
    const generation = generationRef.current;
    raceRequest("/api/auth/me", { signal: controller.signal }).then((updated) => {
      if (mountedRef.current && generation === generationRef.current) {
        profileSessionRef.current = me.session_id;
        onProfileUpdateRef.current?.(updated);
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [me?.session_id]);

  const appendKeys = (keys) => {
    if (!canType) return;
    let next = trainingRef.current;
    for (const key of keys) next = applyKeystroke(next, key, clockNow());
    if (next === trainingRef.current) return;
    updateTraining(next);
    pendingRef.current = next;
    if (!sendingRef.current && !sendTimerRef.current) {
      sendTimerRef.current = window.setTimeout(() => flushRef.current?.(), next.finishedAt !== null ? 0 : 150);
    }
  };

  const handleInput = (event) => {
    if (event.nativeEvent?.inputType?.includes("Paste")) return;
    const previous = trainingRef.current.typedChars.join("");
    const value = event.target.value.replace(/\r\n?/g, "\n");
    if (value.startsWith(previous)) appendKeys(Array.from(value.slice(previous.length)));
    else if (previous.startsWith(value)) appendKeys(Array.from(previous.slice(value.length), () => "Backspace"));
  };

  const leaveRoom = async () => {
    if (!room) return;
    setBusy(true);
    try {
      await raceRequest(`/api/races/${room.code}/leave`, { method: "POST" });
      sessionStorage.removeItem(`typing-race-room:${profile.id}`);
      const url = new URL(window.location.href);
      url.searchParams.delete("race");
      window.history.replaceState({}, "", url);
      resetRoom();
      setCodeDraft("");
      setError("");
    } catch (failure) { setError(failure.message); }
    finally { if (mountedRef.current) setBusy(false); }
  };

  const copyInvite = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("race", room.code);
    try { await navigator.clipboard.writeText(url.toString()); setCopyNotice("Ссылка скопирована"); }
    catch { setCopyNotice(`Передайте код комнаты: ${room.code}`); }
  };

  const savedCode = profile ? sessionStorage.getItem(`typing-race-room:${profile.id}`) : null;
  const localMetrics = getMetrics(training);
  const metrics = me?.completed_ms ? me.metrics : localMetrics;
  const unitLabel = speedUnit === "wpm" ? "слов/мин" : "знаков/мин";
  const localPlayer = me && !me.completed_ms ? { ...me, characters: training.index,
    metrics: { ...me.metrics, correct_characters: training.correctCharacters, accuracy: localMetrics.accuracy } } : me;
  const players = room ? [room.players[0], room.players[1]].map((player) => player?.user_id === room.you ? localPlayer : player) : [];
  const winner = room?.players.find((player) => player.user_id === room.winner_id);
  const raceHeadline = room?.state === "waiting" ? "Пригласи друга на старт"
    : room?.state === "expired" ? "Время гонки истекло"
      : room?.state === "closed" ? "Комната закрыта"
        : countdown ? `Старт через ${countdown}`
          : room?.outcome === "draw" ? "Ничья!"
            : room?.outcome === "no_qualifier" ? "Гонка завершена без зачёта"
              : winner ? winner.user_id === room.you ? "Ты выиграл!" : `Победил ${winner.username}`
                : me?.completed_ms && !me.qualified ? "Текст готов · вне зачёта"
                  : me?.completed_ms ? "Доезжаем с учётом ошибок…" : "Гонка идёт!";

  return <section className="race-mode" aria-label="Клавагонки">
    <div className="race-intro">
      <div><p className="eyebrow">ДВА ИГРОКА · ОДИН ТЕКСТ</p><h2>Клавагонки</h2><p>Создай комнату, пригласи соперника и набирай текст, чтобы вести свою машину к финишу.</p></div>
      <span className="race-badge"><span /> Живой соперник</span>
    </div>
    <p className="race-rules">Ошибочная буква не останавливает ввод. Каждая ошибка добавляет <strong>0,5 с</strong> к финишу. Для зачёта нужна точность <strong>от 80%</strong>. Скорость считается от общего старта; штраф в неё не входит.</p>
    {!profile ? <div className="panel race-signin"><RaceCar color="#315846" waiting /><h3>Выйди на старт под своим именем</h3><p>Войди в аккаунт, чтобы участвовать в гонке и сохранить результат в прогрессе.</p><button type="button" className="button button-primary" onClick={onLogin}>Войти и гонять</button></div>
      : !room ? <div className="race-lobby">
        <article className="panel race-lobby-card"><span className="race-step">01</span><h3>Создать гонку</h3><p>Комната рассчитана на двоих. Второй игрок присоединится по коду или ссылке.</p><label className="race-label">Язык текста<select value={lang} onChange={(event) => setLang(event.target.value)}><option value="ru">Русский</option><option value="en">English</option></select></label><button type="button" className="button button-primary" disabled={busy} onClick={() => openRoom("create")}>{busy ? "Подключаемся…" : "Создать комнату"}</button></article>
        <article className="panel race-lobby-card"><span className="race-step">02</span><h3>Принять вызов</h3><p>Введи код от друга. После подключения у обоих будет три секунды до старта.</p><form onSubmit={(event) => { event.preventDefault(); openRoom("join"); }}><label className="race-label" htmlFor="race-room-code">Код комнаты<input id="race-room-code" maxLength={6} value={codeDraft} onChange={(event) => setCodeDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ABC234" autoComplete="off" spellCheck="false" /></label><button type="submit" className="button button-outline" disabled={busy || codeDraft.length !== 6}>Присоединиться</button></form></article>
        {savedCode && <div className="race-rejoin"><span>У тебя есть комната {savedCode}.</span><button type="button" className="button button-outline" disabled={busy} onClick={() => openRoom("join", savedCode)}>Вернуться в гонку</button></div>}
      </div> : <>
        <div className="panel race-arena">
          <div className="race-arena-heading"><div><p className="eyebrow">КОМНАТА {room.code}</p><h3 aria-live="polite">{raceHeadline}</h3></div><div className="race-room-actions"><button type="button" className="button button-outline" onClick={copyInvite}>Пригласить по ссылке</button><button type="button" className="race-exit" onClick={leaveRoom} disabled={busy}>Выйти</button></div></div>
          {copyNotice && <p className="race-copy-notice" role="status">{copyNotice}</p>}
          {room.state === "waiting" && <div className="race-invite-code"><span>Код для второго игрока</span><strong>{room.code}</strong><small>Ожидаем подключение. Комната действует 10 минут.</small></div>}
          <div className="race-track" aria-label="Трасса гонки">
            <div className="race-track-landscape" aria-hidden="true"><i /><i /><i /><span>ФИНИШ</span></div>
            {players.map((player, index) => {
              const progress = carProgress(player, Array.from(room.target_text).length, now);
              return <div className={`race-lane ${player?.user_id === room.you ? "race-lane-you" : ""}`} key={player?.user_id || "waiting"}>
                <div className="race-driver"><strong>{player ? `${player.username}${player.user_id === room.you ? " · ты" : ""}` : "Свободная дорожка"}</strong><span>{playerStatus(player, room, now)}</span></div>
                <div className="race-road" role="progressbar" aria-label={`Прогресс: ${player?.username || "соперник"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><div className="race-finish-line" /><div className="race-car-position" style={{ left: `${progress * 100}%` }}><RaceCar color={index ? "#bc753b" : "#315846"} waiting={!player || Boolean(countdown) || room.state === "waiting" || player.left || (player.finish_ms && now >= player.finish_ms)} /></div></div>
              </div>;
            })}
          </div>
          {room.outcome === "forfeit" && <p className="race-outcome-note">Соперник вышел или не подключался более минуты. Победа присуждена оставшемуся игроку. Результат печати сохраняется после завершения текста.</p>}
          {room.outcome === "no_qualifier" && <p className="race-outcome-note">У обоих участников точность ниже 80%. Результаты сохранены в личном прогрессе, без места в рейтинге.</p>}
          {room.state === "expired" && <p className="race-outcome-note">Создай новую комнату. Завершённые результаты уже сохранены, незаконченный текст в рейтинг не попадает.</p>}
        </div>
        {room.starts_ms !== null && <div className="panel race-exercise">
          <div className="race-metrics"><div><span>СКОРОСТЬ</span><strong>{metrics[speedUnit] || 0}<small> {unitLabel}</small></strong></div><div><span>ТОЧНОСТЬ</span><strong>{metrics.accuracy ?? 100}<small>%</small></strong></div><div><span>ОШИБКИ</span><strong>{me?.completed_ms ? me.metrics.errors : training.errors}</strong></div><div><span>ШТРАФ</span><strong>{((me?.completed_ms ? me.metrics.errors : training.errors) * 0.5).toFixed(1)}<small> с</small></strong></div></div>
          <div className="race-text" aria-label="Текст гонки">{training.targetChars.map((char, index) => <span key={index} className={index < training.index ? training.typedChars[index] === char ? "race-char-correct" : "race-char-error" : index === training.index ? "race-char-current" : ""}>{char === "\n" ? "↵\n" : char}</span>)}</div>
          <label className="race-input-label" htmlFor="race-typing-input">{countdown ? "Приготовься. Ввод откроется после сигнала старта." : me?.completed_ms ? "Текст завершён. Результат сохранён." : training.finishedAt !== null ? "Текст завершён. Отправляем результат…" : "Печатай здесь — ошибки можно пропускать или исправлять Backspace."}</label>
          <textarea ref={inputRef} id="race-typing-input" className="race-input" rows={2} value={training.typedChars.join("")} onChange={handleInput} disabled={!canType} spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" placeholder="Начни набирать текст после старта…" onPaste={(event) => { event.preventDefault(); setError("В гонке нужно набирать текст с клавиатуры. Вставка отключена."); }} onDrop={(event) => event.preventDefault()} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Delete"].includes(event.key)) event.preventDefault(); }} onSelect={(event) => { const field = event.currentTarget; if (field.selectionStart !== field.value.length || field.selectionEnd !== field.value.length) field.setSelectionRange(field.value.length, field.value.length); }} />
          {me?.completed_ms && <div className="race-saved-result" role="status"><strong>{me.qualified ? "Результат сохранён" : "Результат сохранён вне зачёта"}</strong><span>{me.metrics.wpm} слов/мин · {me.metrics.cpm} знаков/мин · точность {me.metrics.accuracy}%</span><small>{!me.qualified ? "Для места в рейтинге гонок нужна точность от 80%." : profile.leaderboard_public ? "Открой таблицу лидеров и выбери режим «Клавагонки»." : "Включи показ результатов в профиле, чтобы участвовать в таблице лидеров."}</small></div>}
          {room.state === "finished" && <button type="button" className="button button-outline race-again" disabled={busy || (!me?.completed_ms && canType)} onClick={leaveRoom}>К новой гонке</button>}
        </div>}
      </>}
    {error && <div className="race-error" role="alert">{error}{syncBlocked && room && <button type="button" className="button button-outline" disabled={busy} onClick={() => { const code = room.code; resetRoom(); openRoom("join", code); }}>Вернуться к сохранённому вводу</button>}</div>}
  </section>;
}
