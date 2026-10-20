"""Regression cases for wrong-key advance, precise timing and Backspace."""
import math

import pytest

from backend.metrics import combo_for_streak, earned_xp, public_metrics, replay_keystrokes, round_half_up


def events(keys, step=1000):
    return [{"key": key, "at_ms": index * step} for index, key in enumerate(keys)]


def test_wrong_character_advances_and_reduces_speed_and_accuracy():
    result = replay_keystrokes("abcd", events("axcd"), 3000, "axcd")
    assert result["correct_characters"] == 3
    assert result["cpm"] == 60
    assert result["wpm"] == 12
    assert result["accuracy"] == 75
    assert result["errors"] == 1
    assert result["error_chars"] == {"b": 1}


def test_corrected_mistakes_remain_in_accuracy_but_not_final_text():
    result = replay_keystrokes("abc", events(["a", "x", "Backspace", "b", "c"]), 4000, "abc")
    assert result["cpm"] == 45
    assert result["accuracy"] == 75
    assert result["errors"] == 1
    assert result["score"] == 30
    assert result["char_attempts"] == {"a": 1, "b": 2, "c": 1}


def test_backspace_cannot_farm_points_or_correct_character_count():
    result = replay_keystrokes("ab", events(["a", "Backspace", "a", "b"]), 3000)
    assert result["score"] == 20
    assert result["correct_characters"] == 2
    assert result["correct_keystrokes"] == 3
    assert result["max_streak"] == 2


def test_all_wrong_is_zero_accuracy_and_zero_score():
    result = replay_keystrokes("abc", events("xxx"), 2000)
    assert (result["accuracy"], result["cpm"], result["wpm"], result["score"]) == (0, 0, 0, 0)


def test_single_character_is_saved_without_speed_cap_but_not_ranked():
    result = replay_keystrokes("я", events("я"), 1)
    assert result["cpm"] == 60000
    assert result["is_ranked"] is False
    assert result["ranking_reason"]


def test_exact_subsecond_timing_and_display_rounding():
    result = replay_keystrokes("ab", events("ab", 741), 741)
    assert result["cpm"] == 120000 / 741
    assert public_metrics(result)["cpm"] == 162
    assert round_half_up(2.25, 1) == 2.3
    assert round_half_up(42.5) == 43


def test_unicode_and_line_breaks_have_one_position_each():
    result = replay_keystrokes("я\n😀", events("я\n😀"), 2000)
    assert result["correct_characters"] == 3
    assert result["accuracy"] == 100


@pytest.mark.parametrize("duration", [0, -1, math.inf, math.nan, 3_600_001])
def test_invalid_duration_rejected(duration):
    with pytest.raises(ValueError):
        replay_keystrokes("abc", events("abc"), duration)


@pytest.mark.parametrize("target,trace,duration,typed", [
    ("abc", events("ab"), 1000, "ab"),
    ("ab", events("abc"), 2000, "abc"),
    ("ab", [{"key": "a", "at_ms": 100}, {"key": "b", "at_ms": 10}], 100, "ab"),
    ("ab", events("ab"), 1000, "xx"),
    ("ab", [{"key": "ab", "at_ms": 0}], 1, "ab"),
])
def test_incomplete_forged_or_out_of_order_trace_rejected(target, trace, duration, typed):
    with pytest.raises(ValueError):
        replay_keystrokes(target, trace, duration, typed)


def test_all_combo_tiers_are_reachable_and_reset_after_error():
    assert [combo_for_streak(n) for n in (0, 4, 5, 11, 12, 24, 25, 39, 40)] == [1, 1, 2, 2, 3, 3, 4, 4, 5]
    target = "a" * 43
    result = replay_keystrokes(target, events("a" * 40 + "x" + "aa", 200), 8400)
    assert result["max_combo"] == 5
    assert result["max_streak"] == 40
    assert result["errors"] == 1


def test_xp_requires_meaningful_practice_and_not_fast_short_bursts():
    fast = replay_keystrokes("a" * 100, events("a" * 100, 20), 1980)
    assert fast["is_ranked"] is False
    assert earned_xp(fast, "words") == 0
    quick_ranked = replay_keystrokes("a" * 100, events("a" * 100, 30), 2970)
    assert earned_xp(quick_ranked, "words") == 0
    steady = replay_keystrokes("a" * 60, events("a" * 60, 500), 29500)
    assert earned_xp(steady, "words") == 5
    assert earned_xp(steady, "custom") == 4
    very_long = replay_keystrokes("a" * 1000, events("a" * 1000, 300), 299700)
    assert earned_xp(very_long, "words") == 30


def test_xp_penalizes_inaccurate_typing_independent_of_combo_points():
    perfect = replay_keystrokes("a" * 60, events("a" * 60, 500), 29500)
    mistakes = replay_keystrokes("a" * 60, events("x" * 12 + "a" * 48, 500), 29500)
    assert earned_xp(mistakes, "words") < earned_xp(perfect, "words")
    assert earned_xp(mistakes, "words") >= 0
