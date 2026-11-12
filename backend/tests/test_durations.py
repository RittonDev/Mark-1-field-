from datetime import UTC, datetime, timedelta

from app.services.durations import actual_seconds, round_to_5, suggested_minutes

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


def test_actual_seconds_includes_running_interval() -> None:
    assert actual_seconds(600, None, NOW) == 600
    assert actual_seconds(600, NOW - timedelta(minutes=5), NOW) == 900


def test_round_to_5() -> None:
    assert round_to_5(233.4) == 235
    assert round_to_5(1) == 5


def test_suggestion_needs_enough_samples() -> None:
    assert suggested_minutes(20, 235, 2) is None
    # O caso do Field Control: 20 min estimados, mediana de 3h55.
    assert suggested_minutes(20, 235, 3) == 235


def test_no_suggestion_when_estimate_is_close() -> None:
    assert suggested_minutes(60, 70, 10) is None  # +17%
    assert suggested_minutes(60, 50, 10) is None  # -17%
    assert suggested_minutes(60, 40, 10) == 40  # -33%: estimativa folgada demais
