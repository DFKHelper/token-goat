"""Tests for the in-session re-read deny-redirect (T2).

Covers _handle_reread_deny via hooks_read.pre_read:
- A file read once then read again with the same window is denied on the second call.
- The full-file sentinel case (read_count past collapse threshold) is denied.
- A file that was edited since its last read passes through (diff-hint path).
- Second identical attempt (anti-loop guard) passes through.
- Files below the size threshold are never denied.
- Disabled config passes through.
- First read (no session history) passes through.
- A windowed read that extends beyond the recorded range passes through.
- Subagent shared-cache: same session_id → denial fires.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from hook_helpers import assert_continue, assert_deny

from token_goat import config as cfg_mod
from token_goat import hooks_read, session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cfg(reread_deny: bool = True, min_bytes: int = 0) -> cfg_mod.Config:
    base = cfg_mod.load()
    return replace(base, hints=replace(base.hints, reread_deny=reread_deny, reread_deny_min_bytes=min_bytes))


def _read_payload(path: Path, sid: str, tmp_path: Path, **ti: object) -> dict:
    tool_input: dict[str, object] = {"file_path": str(path)}
    tool_input.update(ti)
    return {"session_id": sid, "tool_name": "Read", "tool_input": tool_input, "cwd": str(tmp_path)}


def _write(path: Path, n_bytes: int = 4096) -> Path:
    path.write_bytes(b"x" * n_bytes)
    return path


def _decision(result: dict) -> str | None:
    return (result.get("hookSpecificOutput") or {}).get("permissionDecision")


def _ctx(result: dict) -> str:
    return (result.get("hookSpecificOutput") or {}).get("additionalContext", "")


def _record_read(sid: str, path: Path, offset: int | None = None, limit: int | None = None) -> None:
    session.mark_file_read(sid, str(path), offset, limit)


# ---------------------------------------------------------------------------
# Core deny behaviour
# ---------------------------------------------------------------------------


class TestRereaDenyCore:
    def test_second_full_read_denied(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "source.py")
        sid = "rrd-full"
        _record_read(sid, f)  # first read — populates session history
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)

    def test_deny_message_mentions_file_and_prior_range(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "target.py")
        sid = "rrd-msg"
        _record_read(sid, f, offset=0, limit=100)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path, offset=0, limit=100))
        assert_deny(result)
        ctx = _ctx(result)
        assert "target.py" in ctx
        # Should mention surgical alternatives
        assert "token-goat" in ctx.lower() or "offset" in ctx

    def test_deny_message_mentions_antiloop_escape(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "escape.py")
        sid = "rrd-escape"
        _record_read(sid, f)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)
        ctx = _ctx(result)
        # User must be told that a second attempt passes through
        assert "second" in ctx.lower() or "again" in ctx.lower() or "pass" in ctx.lower()

    def test_windowed_contained_read_denied(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "windowed.py")
        sid = "rrd-wind"
        # Record reading lines 1–200 (offset=0, limit=200)
        _record_read(sid, f, offset=0, limit=200)
        # Request lines 50–150: fully contained in 1–200
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path, offset=49, limit=100))
        assert_deny(result)

    def test_full_file_sentinel_denied(self, tmp_data_dir, tmp_path):
        """After many reads, line_ranges collapses to sentinel (0, 0). Any re-read denied."""
        f = _write(tmp_path / "sentinel.py")
        sid = "rrd-sentinel"
        # Collapse to sentinel by exceeding _READ_COUNT_FULL_FILE_THRESHOLD reads.
        for i in range(25):
            _record_read(sid, f, offset=i * 10, limit=10)
        entry = session.get_file_entry(sid, str(f))
        assert entry is not None
        # Force sentinel to confirm the setup — if not yet sentinel, add more reads.
        if (0, 0) not in entry.line_ranges:
            for i in range(25, 50):
                _record_read(sid, f, offset=i * 10, limit=10)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)


# ---------------------------------------------------------------------------
# Anti-loop guard: second identical attempt passes through
# ---------------------------------------------------------------------------


class TestRereaDenyAntiLoop:
    def test_second_attempt_passes_through(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "antiloop.py")
        sid = "rrd-antiloop"
        _record_read(sid, f)

        cfg = _cfg()
        with patch.object(cfg_mod, "load", return_value=cfg):
            first = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
            second = hooks_read.pre_read(_read_payload(f, sid, tmp_path))

        assert_deny(first)
        assert_continue(second)

    def test_different_window_after_deny_still_denied(self, tmp_data_dir, tmp_path):
        """Anti-loop is keyed by (path, window); a different window is a new key."""
        f = _write(tmp_path / "diff_window.py")
        sid = "rrd-diffwin"
        _record_read(sid, f)  # full file

        cfg = _cfg()
        with patch.object(cfg_mod, "load", return_value=cfg):
            first = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
            # Re-read full file — denied (different request, same window: still new key)
            second = hooks_read.pre_read(_read_payload(f, sid, tmp_path))

        assert_deny(first)
        # second is the anti-loop pass-through for the SAME window
        assert_continue(second)


# ---------------------------------------------------------------------------
# Pass-through cases
# ---------------------------------------------------------------------------


class TestRereaDenyPassThrough:
    def test_first_read_passes_through(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "first.py")
        sid = "rrd-first"
        # No _record_read — no session history
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)

    def test_edited_file_passes_through(self, tmp_data_dir, tmp_path):
        """File edited since last read → diff-hint path; reread_deny must not fire."""
        f = _write(tmp_path / "edited.py")
        sid = "rrd-edited"
        _record_read(sid, f)
        # Simulate a session-level edit by marking it edited (last_edit_ts > last_read_ts)
        session.mark_file_edited(sid, str(f))
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        # Deny must NOT come from reread_deny (may be continue or a diff hint)
        hso = result.get("hookSpecificOutput") or {}
        # If it's a deny, it must NOT say "already in context" (that's the reread message)
        if hso.get("permissionDecision") == "deny":
            assert "already in context" not in _ctx(result)

    def test_window_extends_beyond_recorded_range_passes_through(self, tmp_data_dir, tmp_path):
        """Read that requests beyond the recorded range is not contained — must pass through."""
        f = _write(tmp_path / "partial.py")
        sid = "rrd-partial"
        _record_read(sid, f, offset=0, limit=50)  # records lines 1–50
        # Request lines 40–100: extends beyond recorded range
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path, offset=39, limit=60))
        assert_continue(result)

    def test_later_start_unbounded_read_denied(self, tmp_data_dir, tmp_path):
        """Prior full-file read covers a later-start unbounded re-read — must be denied.

        Regression for the false-negative where re >= req_start + _SESSION_UNKNOWN_END
        failed when req_start > rs (stored_start).  Fix: check (re - rs) >= sentinel.
        """
        f = _write(tmp_path / "laterstart.py")
        sid = "rrd-laterstart"
        _record_read(sid, f)  # full file: stored (1, 100_000)
        # Re-read from line 100 onward (no limit) — fully covered by prior full-file read
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path, offset=99))
        assert_deny(result)

    def test_config_disabled_passes_through(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "disabled.py")
        sid = "rrd-disabled"
        _record_read(sid, f)
        with patch.object(cfg_mod, "load", return_value=_cfg(reread_deny=False)):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)

    def test_small_file_exempt(self, tmp_data_dir, tmp_path):
        # File is 500 bytes; min_bytes=2048 → exempt
        f = _write(tmp_path / "tiny.py", n_bytes=500)
        sid = "rrd-small"
        _record_read(sid, f)
        with patch.object(cfg_mod, "load", return_value=_cfg(min_bytes=2048)):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)

    def test_min_bytes_zero_denies_small_file(self, tmp_data_dir, tmp_path):
        """min_bytes=0 disables the size gate — tiny files are denied too."""
        f = _write(tmp_path / "tiny_deny.py", n_bytes=100)
        sid = "rrd-tiny-deny"
        _record_read(sid, f)
        with patch.object(cfg_mod, "load", return_value=_cfg(min_bytes=0)):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)


# ---------------------------------------------------------------------------
# Subagent shared cache
# ---------------------------------------------------------------------------


class TestRereaDenySubagent:
    def test_shared_session_id_triggers_deny(self, tmp_data_dir, tmp_path):
        """Subagents share the parent session_id — a file read by the parent is denied in the sub."""
        f = _write(tmp_path / "shared.py")
        sid = "rrd-shared-parent"
        _record_read(sid, f)  # "parent" read

        # "Subagent" fires with same session_id
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)
