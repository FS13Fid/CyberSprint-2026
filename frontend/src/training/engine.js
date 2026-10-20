import { CONTENT } from "./content.js";

// One monotonic millisecond clock drives live, completed and saved results.
export const clockNow = () => Math.round(performance.now());

function sessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

export function createTraining(target, clientSessionId = sessionId()) {
  return {
    clientSessionId,
    target,
    targetChars: Array.from(target),
    typedChars: [],
    pointsByPosition: [],
    index: 0,
    startedAt: null,
    finishedAt: null,
    correctCharacters: 0,
    totalKeystrokes: 0,
    correctKeystrokes: 0,
    keystrokes: [],
    errors: 0,
    errorChars: {},
    charAttempts: {},
    errorPositions: [],
    streak: 0,
    maxStreak: 0,
    combo: 1,
    maxCombo: 1,
    score: 0,
  };
}

function pickDifficultyText(list, difficulty, length) {
  if (!list?.length) return "";
  const options = difficulty === "easy"
    ? list.filter((item) => item.length <= length)
    : difficulty === "hard" ? list.filter((item) => item.length >= length) : list;
  const available = options.length ? options : list;
  return available[Math.floor(Math.random() * available.length)];
}

export function makeTraining(mode, lang, codeLang, customText = "", difficulty = "medium") {
  if (mode === "custom" || mode === "race") return createTraining(mode === "race" ? "" : customText);
  const list = mode === "code" ? CONTENT.code[codeLang] : CONTENT[lang][mode];
  let target = pickDifficultyText(list, difficulty, mode === "code" ? 65 : mode === "sentences" ? 50 : 5);
  if (mode === "code") target = target.split("\n").map((line) => line.replace(/^\s+/, "")).join("\n");
  if (mode === "words") {
    const words = difficulty === "easy" ? list.filter((word) => word.length <= 4)
      : difficulty === "hard" ? list.filter((word) => word.length >= 5) : list;
    const available = words.length ? words : list;
    const count = difficulty === "easy" ? 8 : difficulty === "hard" ? 16 : 12;
    target = Array.from({ length: count }, () => available[Math.floor(Math.random() * available.length)]).join(" ");
  }
  if (mode === "symbols") {
    if (difficulty === "easy") target = target.slice(0, 16);
    if (difficulty === "hard" && list.length > 1) target = `${list[0]} ${list[1]}`;
  }
  return createTraining(target);
}

// All five multiplier tiers are reachable; a mistake or Backspace resets the combo.
export const COMBO_THRESHOLDS = [5, 12, 25, 40];
export function comboForStreak(streak) {
  return 1 + COMBO_THRESHOLDS.filter((milestone) => streak >= milestone).length;
}

export function applyKeystroke(training, rawKey, now = clockNow()) {
  const key = rawKey === "Enter" ? "\n" : rawKey;
  if (!training.targetChars.length || training.finishedAt !== null) return training;
  if (key !== "Backspace" && Array.from(key).length !== 1) return training;
  if (key === "Backspace" && training.index === 0) return training;
  const startedAt = training.startedAt ?? now;
  const at_ms = Math.max(0, Math.round(now - startedAt), training.keystrokes.at(-1)?.at_ms ?? 0);
  const keystrokes = [...training.keystrokes, { key, at_ms }];

  if (key === "Backspace") {
    const index = training.index - 1;
    return {
      ...training,
      startedAt,
      keystrokes,
      index,
      typedChars: training.typedChars.slice(0, -1),
      pointsByPosition: training.pointsByPosition.slice(0, -1),
      correctCharacters: training.correctCharacters - Number(training.typedChars[index] === training.targetChars[index]),
      errorPositions: training.errorPositions.filter((position) => position !== index),
      score: training.score - training.pointsByPosition[index],
      streak: 0,
      combo: 1,
    };
  }

  const expected = training.targetChars[training.index];
  const correct = key === expected;
  const streak = correct ? training.streak + 1 : 0;
  const combo = comboForStreak(streak);
  const points = correct ? 10 * combo : 0;
  const index = training.index + 1;
  return {
    ...training,
    startedAt,
    finishedAt: index === training.targetChars.length ? startedAt + Math.max(1, at_ms) : null,
    keystrokes,
    typedChars: [...training.typedChars, key],
    pointsByPosition: [...training.pointsByPosition, points],
    index,
    correctCharacters: training.correctCharacters + Number(correct),
    totalKeystrokes: training.totalKeystrokes + 1,
    correctKeystrokes: training.correctKeystrokes + Number(correct),
    errors: training.errors + Number(!correct),
    charAttempts: { ...training.charAttempts, [expected]: (training.charAttempts[expected] || 0) + 1 },
    errorChars: correct ? training.errorChars : { ...training.errorChars, [expected]: (training.errorChars[expected] || 0) + 1 },
    errorPositions: correct ? training.errorPositions : [...training.errorPositions, training.index],
    streak,
    maxStreak: Math.max(training.maxStreak, streak),
    combo,
    maxCombo: Math.max(training.maxCombo, combo),
    score: training.score + points,
  };
}

export function getMetrics(training, now = clockNow()) {
  const durationMs = training.startedAt === null ? 0 : Math.max(1, Math.round((training.finishedAt ?? now) - training.startedAt));
  const cpm = durationMs ? training.correctCharacters * 60000 / durationMs : 0;
  const accuracy = training.totalKeystrokes ? training.correctKeystrokes * 100 / training.totalKeystrokes : 100;
  return {
    wpm: Math.round(cpm / 5 * 10) / 10,
    cpm: Math.round(cpm),
    accuracy: Math.round(accuracy * 10) / 10,
    durationMs,
    elapsedSec: durationMs / 1000,
    correctCharacters: training.correctCharacters,
    correctKeystrokes: training.correctKeystrokes,
    totalKeystrokes: training.totalKeystrokes,
  };
}

export function getXpReward(training, mode) {
  const metrics = getMetrics(training);
  if (metrics.durationMs < 10_000 || training.targetChars.length < 20) return 0;
  const accuracy = training.totalKeystrokes ? training.correctKeystrokes / training.totalKeystrokes : 0;
  const completion = training.correctCharacters / training.targetChars.length;
  const practicePoints = Math.floor(training.correctCharacters / 15) + Math.min(3, Math.floor(training.maxStreak / 30));
  let reward = Math.min(30, Math.floor(metrics.durationMs / 5000), Math.round(practicePoints * accuracy * completion));
  if (mode === "custom") reward = Math.round(reward * 0.75);
  return Math.max(0, reward);
}

export function getSessionPayload(training, { mode, difficulty = "medium", lang }) {
  return {
    client_session_id: training.clientSessionId,
    mode,
    difficulty,
    lang,
    target_text: training.target,
    typed_text: training.typedChars.join(""),
    duration_ms: getMetrics(training).durationMs,
    keystrokes: training.keystrokes,
  };
}
