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
        # Collapse to sentinel by crossing _READ_COUNT_FULL_FILE_THRESHOLD reads.
        # One read past the threshold guarantees the collapse; looping to 25/50 (as
        # this test previously did) only added redundant session-DB round-trips.
        for i in range(session._READ_COUNT_FULL_FILE_THRESHOLD + 1):
            _record_read(sid, f, offset=i * 10, limit=10)
        entry = session.get_file_entry(sid, str(f))
        assert entry is not None
        assert (0, 0) in entry.line_ranges, "expected collapse to full-file sentinel"
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


# ---------------------------------------------------------------------------
# SHA verification
# ---------------------------------------------------------------------------


class TestRereaDenyShaVerification:
    """_handle_reread_deny gates on on-disk SHA when a snapshot exists."""

    def _store_snapshot(self, sid: str, path: Path) -> None:
        import hashlib
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        session.set_snapshot_sha(sid, str(path), sha)

    def test_deny_fires_when_sha_matches(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "sha_match.py")
        sid = "rrd-sha-match"
        _record_read(sid, f)
        self._store_snapshot(sid, f)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)

    def test_pass_through_when_sha_differs(self, tmp_data_dir, tmp_path):
        f = _write(tmp_path / "sha_diff.py")
        sid = "rrd-sha-diff"
        _record_read(sid, f)
        self._store_snapshot(sid, f)
        # Modify file externally — SHA now differs from snapshot
        f.write_bytes(b"y" * 4096)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)

    def test_no_snapshot_still_denies(self, tmp_data_dir, tmp_path):
        """Without a snapshot, timestamp guard drives the deny (no SHA stored)."""
        f = _write(tmp_path / "no_snap.py")
        sid = "rrd-no-snap"
        _record_read(sid, f)
        # Deliberately do NOT store snapshot → falls back to timestamp comparison
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)

    def test_sha_mismatch_overrides_unedited_timestamp(self, tmp_data_dir, tmp_path):
        """SHA mismatch → pass-through even when last_edit_ts is never set (external change)."""
        f = _write(tmp_path / "ext_change.py")
        sid = "rrd-ext"
        _record_read(sid, f)
        self._store_snapshot(sid, f)
        # External change — no edit hook fires, last_edit_ts stays 0
        f.write_bytes(b"z" * 4096)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)


# ---------------------------------------------------------------------------
# On-disk fingerprint (mtime_ns + size): cross-session freshness gate
# ---------------------------------------------------------------------------


class TestRereaDenyOnDiskFingerprint:
    """A file modified on disk since its last read is never denied — even when no edit
    hook recorded the change against *this* session.

    post_edit keys ``last_edit_ts`` on the editing session's id, so a sub-agent running
    under a different session_id never bumps the parent's timestamp guard. The on-disk
    ``(st_mtime_ns, st_size)`` fingerprint recorded at read time is the cross-session
    source of truth that lets the parent's re-read of changed content through.
    """

    def test_fingerprint_recorded_at_read(self, tmp_data_dir, tmp_path):
        """mark_file_read records (mtime_ns, size) and it survives the JSON round-trip."""
        f = _write(tmp_path / "fp_record.py")
        sid = "rrd-fp-record"
        _record_read(sid, f)
        entry = session.get_file_entry(sid, str(f))  # loads from disk → exercises (de)serialization
        assert entry is not None
        st = f.stat()
        assert entry.read_mtime_ns == st.st_mtime_ns
        assert entry.read_size == st.st_size

    def test_unchanged_file_still_denied(self, tmp_data_dir, tmp_path):
        """Existing behavior preserved: fingerprint matches on disk → deny still fires."""
        f = _write(tmp_path / "fp_same.py")
        sid = "rrd-fp-same"
        _record_read(sid, f)
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)

    def test_size_changed_passes_through(self, tmp_data_dir, tmp_path):
        """File grew on disk since last read (no edit hook, no snapshot) → pass-through."""
        f = _write(tmp_path / "fp_grow.py", n_bytes=4096)
        sid = "rrd-fp-grow"
        _record_read(sid, f)
        f.write_bytes(b"x" * 8192)  # size 4096 → 8192
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)

    def test_mtime_changed_same_size_passes_through(self, tmp_data_dir, tmp_path):
        """Same size but a newer mtime (in-place content swap) → pass-through.

        os.utime moves the mtime well past the recorded fingerprint while keeping size
        identical, so the size comparison can't catch it — proving the mtime_ns leg fires.
        """
        import os

        f = _write(tmp_path / "fp_mtime.py", n_bytes=4096)
        sid = "rrd-fp-mtime"
        _record_read(sid, f)
        entry = session.get_file_entry(sid, str(f))
        assert entry is not None
        future_ns = entry.read_mtime_ns + 5_000_000_000  # +5s, beyond any fs mtime resolution
        os.utime(f, ns=(future_ns, future_ns))
        assert f.stat().st_size == entry.read_size  # size unchanged — mtime is the only signal
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_continue(result)

    def test_subagent_edit_under_different_session_passes_through(self, tmp_data_dir, tmp_path):
        """The reported bug: a sub-agent edits the file under a *different* session_id.

        The parent's last_edit_ts never moves (timestamp guard is blind) and no snapshot SHA
        exists, so before this fix the parent would deny a re-read of stale content. The
        on-disk fingerprint diverges, so the freshness gate lets the parent's re-read through.
        """
        f = _write(tmp_path / "subagent_edit.py", n_bytes=4096)
        parent = "rrd-parent-sess"
        subagent = "rrd-subagent-sess"
        _record_read(parent, f)  # parent reads — fingerprint captured

        # Sub-agent edit: content lands on disk AND post_edit records under the *sub* session.
        f.write_bytes(b"y" * 9000)
        session.mark_file_edited(subagent, str(f))

        # Parent's own entry never saw the edit — timestamp guard would still deny.
        parent_entry = session.get_file_entry(parent, str(f))
        assert parent_entry is not None
        assert parent_entry.last_edit_ts == 0.0

        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, parent, tmp_path))
        assert_continue(result)

    def test_zero_fingerprint_round_trips_distinct_from_none(self):
        """Serialize/parse must distinguish a recorded 0 (epoch mtime) from unrecorded (None).

        Regression for the sentinel collision. The pre-fix serialize used a falsy-0 check
        (``if entry.read_mtime_ns:``) that DROPPED a recorded 0 — so an epoch-mtime
        fingerprint could never be persisted — and the pre-fix parse defaulted a missing key
        to 0, making "unrecorded" indistinguishable from a legitimate 0. This exercises the
        (de)serialization directly, bypassing the in-process cache that ``load`` returns.
        """
        # A recorded 0 must be serialized, not dropped.
        e0 = session.FileEntry(
            rel_or_abs="f.py", last_read_ts=1.0, read_count=1,
            line_ranges=[], symbols_read=[], read_mtime_ns=0, read_size=0,
        )
        d0 = session._serialize_file_entry(e0)
        assert d0.get("read_mtime_ns") == 0
        assert d0.get("read_size") == 0
        # Parsing that wire dict back preserves 0 (a real value, not None).
        back = session._parse_file_entry("f.py", dict(d0), now=1.0)
        assert back is not None
        assert back.read_mtime_ns == 0
        assert back.read_size == 0
        # An unrecorded fingerprint (keys absent — legacy session JSON) parses to None, not 0.
        legacy = session._parse_file_entry(
            "f.py", {"rel_or_abs": "f.py", "last_read_ts": 1.0, "read_count": 1}, now=1.0
        )
        assert legacy is not None
        assert legacy.read_mtime_ns is None
        assert legacy.read_size is None

    def test_zero_fingerprint_freshness_gate_detects_change(self, tmp_data_dir, tmp_path):
        """An epoch-timestamped file records st_mtime_ns == 0, a *legitimate* fingerprint.

        Regression for the reported bug: read_mtime_ns=0 must mean "recorded as 0", not
        "unrecorded". When the live file diverges from the recorded (0, 0) fingerprint the
        freshness gate must detect the change and NOT deny the re-read as "unchanged". The
        pre-fix falsy-0 guard skipped the comparison entirely and denied stale content.

        Asserts on the permission decision, not ``continue`` — a deny redirect also carries
        ``continue: True`` (fail-soft), so ``assert_continue`` cannot tell deny from passthrough.
        """
        f = _write(tmp_path / "epoch_fp.py", n_bytes=4096)
        sid = "rrd-epoch-fp"
        _record_read(sid, f)
        # Force the recorded fingerprint to the epoch sentinel value (mtime_ns=0, size=0) —
        # exactly what mark_file_read stores for a file whose on-disk mtime is the epoch.
        cache = session.load(sid)
        for entry in cache.files.values():
            entry.read_mtime_ns = 0
            entry.read_size = 0
        session.save(cache)
        # Live (mtime_ns, size) differs from the recorded (0, 0): must NOT be denied.
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert _decision(result) != "deny"

    def test_legacy_entry_without_fingerprint_still_denied(self, tmp_data_dir, tmp_path):
        """A FileEntry with read_mtime_ns=None (legacy/unstattable) on an *unchanged* file:
        the freshness gate has nothing to compare and falls through to the timestamp deny
        path, exactly as a pre-fingerprint session cache would. The None sentinel must not
        accidentally trip the gate (`is not None` guard) and suppress the deny.
        """
        f = _write(tmp_path / "legacy_fp.py", n_bytes=4096)
        sid = "rrd-legacy-fp"
        _record_read(sid, f)
        # Simulate a legacy/unstattable entry: clear the on-disk fingerprint to None.
        cache = session.load(sid)
        for entry in cache.files.values():
            entry.read_mtime_ns = None
            entry.read_size = None
        session.save(cache)
        # File is unchanged on disk → deny must still fire.
        with patch.object(cfg_mod, "load", return_value=_cfg()):
            result = hooks_read.pre_read(_read_payload(f, sid, tmp_path))
        assert_deny(result)
