"""Replay typing events and calculate the same metrics in every game mode.

Speed counts correct characters still present in the completed text. Accuracy
counts every character attempt, including mistakes subsequently corrected with
Backspace. Client-provided speed, score and accuracy are never used.
"""
from collections import Counter
import math

MIN_RANKED_CHARACTERS = 10
MIN_RANKED_DURATION_MS = 3000
MAX_DURATION_MS = 3_600_000

# Combo is a visible score mechanic, not an XP multiplier.
COMBO_THRESHOLDS = (5, 12, 25, 40)
MIN_XP_CHARACTERS = 20
MIN_XP_DURATION_MS = 10_000
MAX_SESSION_XP = 30


def round_half_up(value: float, decimals: int = 0) -> float | int:
    """Match JavaScript Math.round for the non-negative metrics we display."""
    scale = 10 ** decimals
    result = math.floor(value * scale + 0.5) / scale
    return int(result) if decimals == 0 else result


def combo_for_streak(streak: int) -> int:
    return 1 + sum(streak >= threshold for threshold in COMBO_THRESHOLDS)


def earned_xp(metrics: dict, mode: str) -> int:
    """Deliberately slow progression: reward steady, accurate practice, not fake speed.

    XP is independent of combo points and WPM. Short bursts earn no XP;
    long exercises are limited both by elapsed time and a hard session cap.
    """
    duration = metrics["duration_ms"]
    correct = metrics["correct_characters"]
    length = metrics["target_length"]
    if duration < MIN_XP_DURATION_MS or length < MIN_XP_CHARACTERS:
        return 0
    accuracy = metrics["correct_keystrokes"] / metrics["total_keystrokes"] if metrics["total_keystrokes"] else 0
    completion = correct / length
    practice_points = correct // 15 + min(3, metrics["max_streak"] // 30)
    reward = min(MAX_SESSION_XP, int(duration // 5000), round_half_up(practice_points * accuracy * completion))
    if mode == "custom":
        reward = round_half_up(reward * 0.75)
    return max(0, int(reward))


def public_metrics(metrics: dict) -> dict:
    """Only presentation is rounded; raw values are retained for ordering."""
    result = {key: value for key, value in metrics.items()
              if key not in {"char_attempts", "error_chars", "typed_text"}}
    result["wpm"] = round_half_up(metrics["wpm"], 1)
    result["cpm"] = round_half_up(metrics["cpm"])
    result["accuracy"] = round_half_up(metrics["accuracy"], 1)
    return result


def replay_keystrokes(target_text: str, keystrokes: list, duration_ms: float,
                      typed_text: str | None = None, require_complete: bool = True) -> dict:
    if not isinstance(target_text, str) or not 1 <= len(target_text) <= 5000:
        raise ValueError("Длина упражнения должна быть от 1 до 5000 знаков")
    if not isinstance(duration_ms, (float, int)) or not math.isfinite(duration_ms) or not 1 <= duration_ms <= MAX_DURATION_MS:
        raise ValueError("Некорректная продолжительность упражнения")
    if not isinstance(keystrokes, list) or not 1 <= len(keystrokes) <= 20000:
        raise ValueError("Не передана история нажатий")

    active = []
    errors = correct_keystrokes = total_keystrokes = 0
    streak = max_streak = 0
    combo = max_combo = 1
    error_chars, char_attempts = Counter(), Counter()
    previous_at = -1
    for event in keystrokes:
        if hasattr(event, "model_dump"):
            event = event.model_dump()
        if not isinstance(event, dict):
            raise ValueError("Некорректное событие клавиатуры")
        key, at_ms = event.get("key"), event.get("at_ms")
        if not isinstance(at_ms, (float, int)) or not math.isfinite(at_ms) or not previous_at <= at_ms <= duration_ms or at_ms < 0:
            raise ValueError("Некорректное время нажатия")
        previous_at = at_ms
        if len(active) >= len(target_text):
            raise ValueError("Упражнение уже завершено")
        if key == "Backspace":
            if active:
                active.pop()
            streak, combo = 0, 1
            continue
        if not isinstance(key, str) or len(key) != 1 or (not key.isprintable() and key not in "\n\t"):
            raise ValueError("Допустимы одиночные символы и Backspace")
        expected = target_text[len(active)]
        correct = key == expected
        total_keystrokes += 1
        char_attempts[expected] += 1
        if correct:
            correct_keystrokes += 1
            streak += 1
            combo = combo_for_streak(streak)
            max_streak = max(max_streak, streak)
            max_combo = max(max_combo, combo)
        else:
            errors += 1
            error_chars[expected] += 1
            streak, combo = 0, 1
        active.append({"key": key, "correct": correct, "points": 10 * combo if correct else 0})

    actual_text = "".join(item["key"] for item in active)
    if typed_text is not None and actual_text != typed_text:
        raise ValueError("Текст не совпадает с историей нажатий")
    if require_complete and len(active) != len(target_text):
        raise ValueError("Сначала завершите упражнение")
    correct_characters = sum(item["correct"] for item in active)
    cpm = correct_characters * 60000 / duration_ms
    is_ranked = len(target_text) >= MIN_RANKED_CHARACTERS and duration_ms >= MIN_RANKED_DURATION_MS
    return {
        "wpm": cpm / 5,
        "cpm": cpm,
        "accuracy": correct_keystrokes * 100 / total_keystrokes if total_keystrokes else 100.0,
        "errors": errors,
        "correct_characters": correct_characters,
        "correct_keystrokes": correct_keystrokes,
        "total_keystrokes": total_keystrokes,
        "score": sum(item["points"] for item in active),
        "max_combo": max_combo,
        "max_streak": max_streak,
        "char_attempts": dict(char_attempts),
        "error_chars": dict(error_chars),
        "typed_text": actual_text,
        "target_length": len(target_text),
        "duration_ms": duration_ms,
        "duration_sec": duration_ms / 1000,
        "is_ranked": is_ranked,
        "ranking_reason": None if is_ranked else "Для рейтинга нужно набрать не менее 10 знаков за 3 секунды или дольше.",
    }
