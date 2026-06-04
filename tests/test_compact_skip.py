"""Tests for compact pre-skip logic improvements.

Covers:
1. Richer activity floor — sentinel stores edited_count + bash_count; count
   increases bust the sentinel even when mtime resolution is coarse.
2. Noop-session fast-path — sessions with zero edits, zero bash, zero symbols
   are skipped without building a manifest.
3. Skip telemetry — _check_compact_skip_sentinel_detail returns a _SkipResult
   with reason, age_secs, and bool coercion.
4. Manifest quality score — _score_manifest returns expected values; thin
   manifests are detectable.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import token_goat.paths as paths
from token_goat import session
from token_goat.compact import _MANIFEST_THIN_THRESHOLD, _score_manifest
from token_goat.hooks_cli import (
    _check_compact_skip_sentinel,
    _check_compact_skip_sentinel_detail,
    _current_session_counts,
    _is_noop_session,
    _read_sentinel_counts,
    _SkipResult,
    _write_compact_skip_sentinel,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_sentinel_json(path: Path, edited_count: int, bash_count: int) -> None:
    """Write a sentinel JSON directly (bypassing the public helper)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"edited_count": edited_count, "bash_count": bash_count}),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# 1. _SkipResult
# ---------------------------------------------------------------------------


class TestSkipResult:
    def test_bool_true_when_should_skip(self):
        r = _SkipResult(True, "ttl_not_expired", 42.0)
        assert bool(r) is True
        assert r.should_skip is True
        assert r.reason == "ttl_not_expired"
        assert r.age_secs == 42.0

    def test_bool_false_when_not_skipping(self):
        r = _SkipResult(False, "", 0.0)
        assert bool(r) is False

    def test_truthy_in_if(self):
        assert _SkipResult(True, "noop_session", 0.0)
        assert not _SkipResult(False, "", 0.0)


# ---------------------------------------------------------------------------
# 2. _write_compact_skip_sentinel stores counts
# ---------------------------------------------------------------------------


class TestWriteCompactSkipSentinel:
    def test_writes_json_with_counts(self, tmp_data_dir):
        sid = "write-sentinel-test-abc"
        _write_compact_skip_sentinel(sid, edited_count=3, bash_count=5)
        sentinel = paths.compact_skip_sentinel_path(sid)
        assert sentinel.exists()
        data = json.loads(sentinel.read_text(encoding="utf-8"))
        assert data["edited_count"] == 3
        assert data["bash_count"] == 5

    def test_default_counts_are_zero(self, tmp_data_dir):
        sid = "write-sentinel-defaults-abc"
        _write_compact_skip_sentinel(sid)
        sentinel = paths.compact_skip_sentinel_path(sid)
        data = json.loads(sentinel.read_text(encoding="utf-8"))
        assert data["edited_count"] == 0
        assert data["bash_count"] == 0

    def test_overwrites_existing_sentinel(self, tmp_data_dir):
        sid = "write-sentinel-overwrite-abc"
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=1)
        _write_compact_skip_sentinel(sid, edited_count=4, bash_count=7)
        sentinel = paths.compact_skip_sentinel_path(sid)
        data = json.loads(sentinel.read_text(encoding="utf-8"))
        assert data["edited_count"] == 4
        assert data["bash_count"] == 7


# ---------------------------------------------------------------------------
# 3. _read_sentinel_counts
# ---------------------------------------------------------------------------


class TestReadSentinelCounts:
    def test_reads_counts_from_json(self, tmp_data_dir):
        sid = "read-sentinel-counts-abc"
        sentinel = paths.compact_skip_sentinel_path(sid)
        _write_sentinel_json(sentinel, 2, 8)
        edited, bash = _read_sentinel_counts(sentinel)
        assert edited == 2
        assert bash == 8

    def test_empty_file_returns_none_none(self, tmp_data_dir):
        sid = "read-sentinel-empty-abc"
        sentinel = paths.compact_skip_sentinel_path(sid)
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text("", encoding="utf-8")
        assert _read_sentinel_counts(sentinel) == (None, None)

    def test_non_json_returns_none_none(self, tmp_data_dir):
        sid = "read-sentinel-nonjson-abc"
        sentinel = paths.compact_skip_sentinel_path(sid)
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text("not valid json!!!", encoding="utf-8")
        assert _read_sentinel_counts(sentinel) == (None, None)

    def test_json_missing_keys_returns_none_none(self, tmp_data_dir):
        sid = "read-sentinel-nokeys-abc"
        sentinel = paths.compact_skip_sentinel_path(sid)
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text(json.dumps({"other": 1}), encoding="utf-8")
        assert _read_sentinel_counts(sentinel) == (None, None)


# ---------------------------------------------------------------------------
# 4. _current_session_counts
# ---------------------------------------------------------------------------


class TestCurrentSessionCounts:
    def test_counts_from_populated_session(self, tmp_data_dir):
        sid = "current-counts-session-abc"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        from conftest import _make_session
        _make_session(sid, bash_runs={"pytest": (1000, 0), "ruff check": (500, 1)})
        edited, bash = _current_session_counts(sid)
        assert edited == 2
        assert bash == 2

    def test_zero_counts_for_empty_session(self, tmp_data_dir):
        sid = "current-counts-empty-abc"
        edited, bash = _current_session_counts(sid)
        assert edited == 0
        assert bash == 0

    def test_graceful_on_missing_session(self, tmp_data_dir):
        sid = "current-counts-missing-abc"
        # No session file written; should return (0, 0)
        edited, bash = _current_session_counts(sid)
        assert edited == 0
        assert bash == 0


# ---------------------------------------------------------------------------
# 5. _check_compact_skip_sentinel_detail — TTL and mtime gates
# ---------------------------------------------------------------------------


class TestCheckCompactSkipSentinelDetail:
    def test_absent_sentinel_returns_not_skip(self, tmp_data_dir):
        sid = "detail-absent-abc"
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False
        assert result.reason == ""

    def test_fresh_sentinel_returns_skip(self, tmp_data_dir):
        sid = "detail-fresh-abc"
        _write_compact_skip_sentinel(sid)
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is True
        assert result.reason == "ttl_not_expired"
        assert result.age_secs >= 0.0

    def test_expired_sentinel_returns_not_skip(self, tmp_data_dir):
        sid = "detail-expired-abc"
        _write_compact_skip_sentinel(sid)
        sentinel = paths.compact_skip_sentinel_path(sid)
        # Backdate mtime by 400 s (beyond default 300-s TTL).
        old_mtime = time.time() - 400
        import os
        os.utime(sentinel, (old_mtime, old_mtime))
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False

    def test_future_sentinel_returns_not_skip(self, tmp_data_dir):
        sid = "detail-future-abc"
        _write_compact_skip_sentinel(sid)
        sentinel = paths.compact_skip_sentinel_path(sid)
        future_mtime = time.time() + 3600
        import os
        os.utime(sentinel, (future_mtime, future_mtime))
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False

    def test_boolean_coercion_matches_legacy(self, tmp_data_dir):
        """_check_compact_skip_sentinel (legacy) returns same bool as detail."""
        sid = "detail-compat-abc"
        _write_compact_skip_sentinel(sid)
        assert _check_compact_skip_sentinel(sid) == bool(
            _check_compact_skip_sentinel_detail(sid)
        )

    def test_age_secs_populated_when_sentinel_exists(self, tmp_data_dir):
        sid = "detail-age-abc"
        _write_compact_skip_sentinel(sid)
        result = _check_compact_skip_sentinel_detail(sid)
        # Age should be very small but >= 0.
        assert 0.0 <= result.age_secs < 5.0

    def test_age_secs_nonzero_when_expired(self, tmp_data_dir):
        sid = "detail-age-expired-abc"
        _write_compact_skip_sentinel(sid)
        sentinel = paths.compact_skip_sentinel_path(sid)
        old_mtime = time.time() - 400
        import os
        os.utime(sentinel, (old_mtime, old_mtime))
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.age_secs >= 390.0  # within a rounding margin


# ---------------------------------------------------------------------------
# 6. Activity floor — count-based bust
# ---------------------------------------------------------------------------


class TestActivityFloorCounts:
    def test_count_increase_busts_sentinel(self, tmp_data_dir):
        """A sentinel with edited_count=1 is busted when session now has 2 edits."""
        sid = "count-bust-edits-abc"
        # Write sentinel recording edited_count=1
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)
        # Now add a second edited file to the session (count increases to 2)
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")  # 2 total
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False

    def test_bash_increase_busts_sentinel(self, tmp_data_dir):
        """A sentinel with bash_count=0 is busted when session now has 1 bash run."""
        sid = "count-bust-bash-abc"
        from conftest import _make_session
        # Write sentinel with bash_count=0
        _write_compact_skip_sentinel(sid, edited_count=0, bash_count=0)
        # Now record a bash run
        _make_session(sid, bash_runs={"pytest": (500, 0)})
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is False

    def test_same_counts_does_not_bust_sentinel(self, tmp_data_dir):
        """Sentinel is not busted when counts have not increased."""
        sid = "count-nochange-abc"
        session.mark_file_edited(sid, "/proj/a.py")  # edited_count == 1
        _write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)
        # No new edits or bash since the sentinel was written.
        result = _check_compact_skip_sentinel_detail(sid)
        assert result.should_skip is True

    def test_legacy_empty_sentinel_skips_count_check(self, tmp_data_dir):
        """Legacy touch()-style sentinels (empty content) skip the count gate."""
        sid = "count-legacy-abc"
        sentinel = paths.compact_skip_sentinel_path(sid)
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text("", encoding="utf-8")  # legacy: no JSON
        # Even with edits present, a legacy sentinel is not busted by count check.
        # (mtime floor may still bust it, but count check passes through.)
        result = _check_compact_skip_sentinel_detail(sid)
        # Legacy sentinel has no counts → count gate skipped → only mtime + TTL gate.
        # The sentinel is fresh (just written) so should still skip.
        assert result.should_skip is True


# ---------------------------------------------------------------------------
# 7. _is_noop_session
# ---------------------------------------------------------------------------


class TestIsNoopSession:
    def _make_cache(
        self,
        *,
        edited: dict | None = None,
        bash: dict | None = None,
        files_with_syms: bool = False,
    ) -> object:
        """Build a minimal mock session cache."""
        mock = MagicMock()
        mock.edited_files = edited or {}
        mock.bash_history = bash or {}
        if files_with_syms:
            entry = MagicMock()
            entry.symbols_read = ["some_symbol"]
            mock.files = {"key": entry}
        else:
            entry = MagicMock()
            entry.symbols_read = []
            mock.files = {"key": entry} if False else {}
        return mock

    def test_empty_session_is_noop(self):
        cache = self._make_cache()
        assert _is_noop_session(cache) is True

    def test_session_with_edit_is_not_noop(self):
        cache = self._make_cache(edited={"/proj/a.py": 1})
        assert _is_noop_session(cache) is False

    def test_session_with_bash_is_not_noop(self):
        mock = MagicMock()
        mock.edited_files = {}
        mock.bash_history = {"abc123": MagicMock()}
        mock.files = {}
        assert _is_noop_session(mock) is False

    def test_session_with_symbols_is_not_noop(self):
        mock = MagicMock()
        mock.edited_files = {}
        mock.bash_history = {}
        entry = MagicMock()
        entry.symbols_read = ["my_func"]
        mock.files = {"key": entry}
        assert _is_noop_session(mock) is False

    def test_files_without_symbols_is_noop(self):
        """Files-read but no symbols accessed is still a noop."""
        mock = MagicMock()
        mock.edited_files = {}
        mock.bash_history = {}
        entry = MagicMock()
        entry.symbols_read = []
        mock.files = {"key": entry}
        assert _is_noop_session(mock) is True

    def test_none_attributes_treated_as_empty(self):
        """None attribute values are treated as empty collections."""
        mock = MagicMock()
        mock.edited_files = None
        mock.bash_history = None
        mock.files = None
        assert _is_noop_session(mock) is True


# ---------------------------------------------------------------------------
# 8. _score_manifest
# ---------------------------------------------------------------------------


class TestScoreManifest:
    def test_empty_sections_scores_zero(self):
        assert _score_manifest([]) == 0

    def test_empty_string_scores_zero(self):
        assert _score_manifest([""]) == 0

    def test_edited_file_lines_score_ten_each(self):
        section = "**Edited**:\n- a.py ✎×2\n- b.py ✎×1"
        score = _score_manifest([section])
        assert score == 20  # 2 edit lines × 10

    def test_bash_lines_score_three_each(self):
        section = "**Bash**:\n- `pytest` (8kb) abc123\n- `ruff check` (2kb) def456"
        score = _score_manifest([section])
        assert score == 6  # 2 bash lines × 3

    def test_symbol_lines_score_two_each(self):
        section = "**Symbols**:\n- get_user (auth.py)\n- create_token (auth.py)"
        score = _score_manifest([section])
        assert score == 4  # 2 symbol lines × 2

    def test_failure_line_adds_five(self):
        # A line in Bash section containing ✗ triggers the +5 bonus
        section = "**Bash**:\n- ✗ pytest (exit=1)"
        score = _score_manifest([section])
        # 1 bash line (3) + failure bonus (5) = 8
        assert score == 8

    def test_mixed_sections(self):
        sections = [
            "**Edited**:\n- main.py ✎×3",
            "**Bash**:\n- `pytest` (1kb) abc\n- `ruff` (500b) def",
            "**Symbols**:\n- parse_args (cli.py)",
        ]
        score = _score_manifest(sections)
        # 1 edit (10) + 2 bash (6) + 1 symbol (2) = 18
        assert score == 18

    def test_multiple_sections_combined(self):
        """Sections in a single string (whole manifest) are also scored."""
        manifest = (
            "## Token-Goat Session Manifest\n\n"
            "**Edited**:\n- foo.py ✎×1\n\n"
            "**Bash**:\n- `uv run pytest` (5kb exit=0) id123\n"
        )
        score = _score_manifest([manifest])
        assert score >= 10  # at least the edited file

    def test_thin_manifest_threshold_constant(self):
        """_MANIFEST_THIN_THRESHOLD is defined and positive."""
        assert isinstance(_MANIFEST_THIN_THRESHOLD, int)
        assert _MANIFEST_THIN_THRESHOLD > 0

    def test_zero_score_is_below_thin_threshold(self):
        assert _score_manifest([]) < _MANIFEST_THIN_THRESHOLD

    def test_rich_session_exceeds_thin_threshold(self):
        # 2 edits (20) should exceed any reasonable thin threshold.
        section = "**Edited**:\n- a.py ✎×1\n- b.py ✎×2"
        score = _score_manifest([section])
        assert score >= _MANIFEST_THIN_THRESHOLD


# ---------------------------------------------------------------------------
# 9. pre_compact noop-session integration
# ---------------------------------------------------------------------------


class TestPreCompactNoopSession:
    def test_noop_session_skips_manifest(self, tmp_data_dir):
        """pre_compact returns CONTINUE without systemMessage for noop sessions."""
        from token_goat.hooks_cli import pre_compact

        sid = "precompact-noop-session-abc"
        # Create an empty session (no edits, no bash, no symbols).
        session.load(sid)  # creates the session file

        payload = {
            "session_id": sid,
            "trigger": "manual",
        }
        with patch("token_goat.config.load") as mock_cfg:
            cfg = MagicMock()
            cfg.compact_assist.enabled = True
            cfg.compact_assist.triggers = ["manual", "auto"]
            cfg.compact_assist.min_events = 1
            cfg.compact_assist.max_manifest_tokens = 400
            cfg.compact_assist.auto_trigger_multiplier = 1.0
            mock_cfg.return_value = cfg
            response = pre_compact(payload)

        assert response.get("continue") is True
        assert "systemMessage" not in response

    def test_session_with_edit_does_not_skip_as_noop(self, tmp_data_dir):
        """pre_compact does NOT skip when the session has an edited file."""
        from token_goat.hooks_cli import pre_compact

        sid = "precompact-has-edit-abc"
        session.mark_file_edited(sid, "/proj/main.py")

        payload = {
            "session_id": sid,
            "trigger": "manual",
        }
        with patch("token_goat.config.load") as mock_cfg:
            cfg = MagicMock()
            cfg.compact_assist.enabled = True
            cfg.compact_assist.triggers = ["manual", "auto"]
            cfg.compact_assist.min_events = 1
            cfg.compact_assist.max_manifest_tokens = 400
            cfg.compact_assist.auto_trigger_multiplier = 1.0
            mock_cfg.return_value = cfg
            pre_compact(payload)

        # With an edited file the noop guard should NOT fire; the hook may
        # still skip for other reasons (events < min, empty manifest), but
        # NOT because of the noop gate.  We verify by confirming the sentinel
        # written does NOT record reason="noop" — instead the sentinel written
        # should contain edited_count >= 1.
        sentinel = paths.compact_skip_sentinel_path(sid)
        if sentinel.exists():
            raw = sentinel.read_text(encoding="utf-8")
            if raw.strip():
                data = json.loads(raw)
                # The noop gate writes edited_count=0; any path through the
                # non-noop gate should write edited_count >= 1.
                assert data.get("edited_count", -1) >= 1


# ---------------------------------------------------------------------------
# 10. Sentinel written with counts after min_events skip
# ---------------------------------------------------------------------------


class TestSentinelCountsAfterSkip:
    def test_sentinel_records_counts_after_min_events_skip(self, tmp_data_dir):
        """When pre_compact skips due to min_events, sentinel carries current counts."""
        from conftest import _make_session

        from token_goat.hooks_cli import pre_compact

        sid = "sentinel-counts-skip-abc"
        _make_session(sid, edits=2, bash_runs={"ls": (100, 0)})

        payload = {"session_id": sid, "trigger": "manual"}
        with patch("token_goat.config.load") as mock_cfg:
            cfg = MagicMock()
            cfg.compact_assist.enabled = True
            cfg.compact_assist.triggers = ["manual", "auto"]
            # Set min_events very high so it always skips
            cfg.compact_assist.min_events = 99999
            cfg.compact_assist.max_manifest_tokens = 400
            cfg.compact_assist.auto_trigger_multiplier = 1.0
            mock_cfg.return_value = cfg
            pre_compact(payload)

        sentinel = paths.compact_skip_sentinel_path(sid)
        assert sentinel.exists()
        data = json.loads(sentinel.read_text(encoding="utf-8"))
        assert data["edited_count"] == 2
        assert data["bash_count"] == 1


# ---------------------------------------------------------------------------
# 11. Sentinel write is atomic (uses paths.atomic_write_text)
# ---------------------------------------------------------------------------


class TestWriteCompactSkipSentinelAtomic:
    def test_uses_atomic_write_text(self, tmp_data_dir):
        """_write_compact_skip_sentinel delegates to paths.atomic_write_text, not write_text."""
        with patch("token_goat.paths.atomic_write_text") as mock_atomic:
            _write_compact_skip_sentinel("atomic-sentinel-abc", edited_count=2, bash_count=3)

        mock_atomic.assert_called_once()
        call_args = mock_atomic.call_args
        # First arg: Path, second arg: JSON string
        written_payload = call_args[0][1]
        data = json.loads(written_payload)
        assert data["edited_count"] == 2
        assert data["bash_count"] == 3

    def test_atomic_write_no_partial_content_on_error(self, tmp_data_dir):
        """If atomic_write_text raises, the error is silently swallowed (fail-soft)."""
        with patch("token_goat.paths.atomic_write_text", side_effect=OSError("disk full")):
            # Must not raise; sentinel write failures are always suppressed
            _write_compact_skip_sentinel("atomic-error-abc", edited_count=1, bash_count=0)
        # No sentinel was written (error suppressed)
        sentinel = paths.compact_skip_sentinel_path("atomic-error-abc")
        assert not sentinel.exists()


# ---------------------------------------------------------------------------
# 12. pre_compact timing log
# ---------------------------------------------------------------------------


class TestPreCompactTimingLog:
    def test_timing_log_emitted_at_debug(self, tmp_data_dir, caplog):
        """pre_compact emits a DEBUG log with 'built manifest in' after build_manifest_with_count."""
        import logging

        from conftest import _make_session

        from token_goat.hooks_cli import pre_compact

        sid = "timing-log-test-abc"
        _make_session(sid, edits=1, bash_runs={"echo hi": (50, 0)})

        payload = {"session_id": sid, "trigger": "manual"}
        with patch("token_goat.config.load") as mock_cfg:
            cfg = MagicMock()
            cfg.compact_assist.enabled = True
            cfg.compact_assist.triggers = ["manual", "auto"]
            cfg.compact_assist.min_events = 0
            cfg.compact_assist.max_manifest_tokens = 400
            cfg.compact_assist.auto_trigger_multiplier = 1.0
            cfg.compact_assist.max_manifest_chars = 0
            mock_cfg.return_value = cfg
            with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
                pre_compact(payload)

        timing_logs = [
            r.message for r in caplog.records
            if "built manifest in" in r.getMessage()
        ]
        assert timing_logs, "Expected a DEBUG log containing 'built manifest in'"
        # The message should contain 'ms' (milliseconds) and 'tokens'
        assert any("ms" in m and "tokens" in m for m in timing_logs)

    def test_timing_log_contains_token_count(self, tmp_data_dir, caplog):
        """Timing log token count is non-negative integer."""
        import logging
        import re

        from conftest import _make_session

        from token_goat.hooks_cli import pre_compact

        sid = "timing-log-tokens-abc"
        _make_session(sid, edits=1)

        payload = {"session_id": sid, "trigger": "manual"}
        with patch("token_goat.config.load") as mock_cfg:
            cfg = MagicMock()
            cfg.compact_assist.enabled = True
            cfg.compact_assist.triggers = ["manual", "auto"]
            cfg.compact_assist.min_events = 0
            cfg.compact_assist.max_manifest_tokens = 400
            cfg.compact_assist.auto_trigger_multiplier = 1.0
            cfg.compact_assist.max_manifest_chars = 0
            mock_cfg.return_value = cfg
            with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
                pre_compact(payload)

        for record in caplog.records:
            msg = record.getMessage()
            if "built manifest in" in msg:
                # Extract token count — expect pattern like "built manifest in 42ms (7 tokens)"
                m = re.search(r"\((\d+) tokens\)", msg)
                assert m is not None, f"Token count not found in log message: {msg!r}"
                assert int(m.group(1)) >= 0
                return
        raise AssertionError("No 'built manifest in' timing log found")
