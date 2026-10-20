import test from "node:test";
import assert from "node:assert/strict";
import { createTraining, applyKeystroke, comboForStreak, getMetrics, getSessionPayload, getXpReward } from "./engine.js";

function replay(target, events) {
  return events.reduce((state, [key, time]) => applyKeystroke(state, key, time), createTraining(target, "cc53a720-dca1-4288-9db4-aeae9ac3d2d4"));
}

test("a wrong character advances and the following expected character is accepted", () => {
  const initial = createTraining("кот");
  const wrong = applyKeystroke(initial, "х", 1000);
  assert.equal(wrong.index, 1);
  assert.equal(wrong.targetChars[wrong.index], "о");
  const completed = applyKeystroke(applyKeystroke(wrong, "о", 1300), "т", 1600);
  assert.equal(completed.typedChars.join(""), "хот");
  assert.equal(completed.errors, 1);
  assert.equal(completed.correctCharacters, 2);
  assert.deepEqual(completed.errorPositions, [0]);
  assert.equal(getMetrics(completed).cpm, 200);
  assert.equal(getMetrics(completed).accuracy, 66.7);
});

test("finished speed stays exactly the same after time passes and when saved", () => {
  const completed = replay("test", [["t", 0], ["e", 200], ["s", 400], ["t", 600]]);
  const atFinish = getMetrics(completed, 600);
  assert.deepEqual(getMetrics(completed, 3600000), atFinish);
  assert.equal(atFinish.cpm, 400);
  assert.equal(atFinish.wpm, 80);
  const payload = getSessionPayload(completed, { mode: "custom", lang: "en" });
  assert.equal(payload.duration_ms, 600);
  assert.equal(payload.target_text, "test");
  assert.equal(payload.typed_text, "test");
  assert.equal(payload.client_session_id, completed.clientSessionId);
  assert.equal(payload.keystrokes.at(-1).at_ms, 600);
  assert.equal("cpm" in payload, false, "speed is recomputed from evidence by the server");
});

test("accuracy remains zero for a completed all-wrong attempt", () => {
  const state = replay("abc", [["x", 2000], ["x", 3000], ["x", 4000]]);
  assert.equal(state.index, 3);
  assert.equal(state.finishedAt, 4000);
  assert.equal(getMetrics(state).accuracy, 0);
  assert.equal(getMetrics(state).cpm, 0);
  assert.equal(state.errors, 3);
  assert.equal(getXpReward(state, "custom"), 0);
  assert.equal(getXpReward(state, "words"), 0);
});

test("Backspace corrects text but does not erase errors or inflate speed", () => {
  const state = replay("abc", [["x", 0], ["Backspace", 200], ["a", 400], ["b", 700], ["c", 1000]]);
  assert.equal(state.typedChars.join(""), "abc");
  assert.equal(state.errors, 1);
  assert.equal(state.correctCharacters, 3);
  assert.equal(state.totalKeystrokes, 4);
  assert.equal(state.correctKeystrokes, 3);
  assert.equal(getMetrics(state).accuracy, 75);
  assert.equal(getMetrics(state).cpm, 180);
  assert.deepEqual(state.errorPositions, []);
  assert.deepEqual(state.errorChars, { a: 1 });
  assert.deepEqual(state.charAttempts, { a: 2, b: 1, c: 1 });
});

test("retyping correct characters cannot farm score or extra correct text", () => {
  let state = createTraining("abc");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    state = applyKeystroke(state, "a", attempt * 200);
    state = applyKeystroke(state, "Backspace", attempt * 200 + 100);
  }
  assert.equal(state.score, 0);
  assert.equal(state.correctCharacters, 0);
  state = applyKeystroke(state, "a", 2000);
  state = applyKeystroke(state, "b", 2200);
  state = applyKeystroke(state, "c", 2400);
  assert.equal(state.score, 30);
  assert.equal(state.correctCharacters, 3);
  assert.equal(state.totalKeystrokes, 11);
  assert.equal(getMetrics(state).cpm, 75);
});

test("fractional seconds are measured without rounding the duration to seconds", () => {
  const state = replay("abc", [["a", 100], ["b", 980], ["c", 1500]]);
  assert.equal(getMetrics(state).durationMs, 1400);
  assert.equal(getMetrics(state).elapsedSec, 1.4);
  assert.equal(getMetrics(state).cpm, 129);
  assert.equal(getMetrics(state).wpm, 25.7);
});

test("no artificial 120 WPM or 300 WPM speed limit is applied", () => {
  const state = replay("abcdef", [["a", 0], ["b", 20], ["c", 40], ["d", 80], ["e", 100], ["f", 120]]);
  assert.equal(getMetrics(state).cpm, 3000);
  assert.equal(getMetrics(state).wpm, 600);
});

test("non-BMP characters use character positions rather than UTF-16 offsets", () => {
  const state = replay("😀я", [["😀", 0], ["я", 1000]]);
  assert.equal(state.targetChars.length, 2);
  assert.equal(state.index, 2);
  assert.equal(state.correctCharacters, 2);
  assert.equal(getMetrics(state).cpm, 120);
});

test("Enter is stored as a newline and is included in the metrics", () => {
  const state = replay("a\nb", [["a", 0], ["Enter", 300], ["b", 600]]);
  assert.equal(state.typedChars.join(""), "a\nb");
  assert.equal(state.keystrokes[1].key, "\n");
  assert.equal(getMetrics(state).cpm, 300);
});

test("a finished exercise cannot change from extra keys or Backspace", () => {
  const state = replay("ab", [["a", 0], ["b", 500]]);
  assert.strictEqual(applyKeystroke(state, "c", 1000), state);
  assert.strictEqual(applyKeystroke(state, "Backspace", 1000), state);
});

test("a zero-time first character stays finite and keeps a valid trace", () => {
  const state = applyKeystroke(createTraining("a"), "a", 0);
  assert.equal(getMetrics(state).durationMs, 1);
  assert.equal(Number.isFinite(getMetrics(state).wpm), true);
  assert.equal(state.keystrokes[0].at_ms, 0);
});

test("modifier keys, empty Backspace and bulk inserts do not start a session", () => {
  const state = createTraining("abc");
  for (const key of ["Backspace", "Shift", "ArrowLeft", "abc"]) assert.strictEqual(applyKeystroke(state, key, 100), state);
  assert.equal(state.startedAt, null);
  assert.equal(getMetrics(state).accuracy, 100);
  assert.equal(getMetrics(state).cpm, 0);
});


test("all combo tiers count 5/12/25/40 correctly and reset on errors and Backspace", () => {
  assert.deepEqual([0, 4, 5, 11, 12, 24, 25, 39, 40].map(comboForStreak), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
  let state = createTraining("a".repeat(42));
  for (let i = 0; i < 40; i += 1) state = applyKeystroke(state, "a", i * 100);
  assert.equal(state.combo, 5);
  assert.equal(state.maxCombo, 5);
  state = applyKeystroke(state, "x", 4000);
  assert.equal(state.combo, 1);
  assert.equal(state.streak, 0);
  state = applyKeystroke(state, "Backspace", 4100);
  assert.equal(state.combo, 1);
  assert.equal(state.maxCombo, 5);
});

test("XP does not depend on combo score and is capped by practice time", () => {
  let quick = createTraining("a".repeat(100));
  for (let i = 0; i < 100; i += 1) quick = applyKeystroke(quick, "a", i * 20);
  assert.equal(getXpReward(quick, "words"), 0);
  let steady = createTraining("a".repeat(60));
  for (let i = 0; i < 60; i += 1) steady = applyKeystroke(steady, "a", i * 500);
  assert.equal(getXpReward(steady, "words"), 5);
  assert.equal(getXpReward(steady, "custom"), 4);
});
