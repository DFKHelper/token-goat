"""Tests for session.py and config.py reliability edge cases.

Covers:
- Session JSON atomic writes (already in place via paths.atomic_write_text)
- Session file size cap (_trim_session_for_size / _get_session_max_bytes)
- Stale session cleanup at SessionStart (hooks_session calling cleanup_stale)
- Config corrupt TOML fallback (already handled; regression test)
"""
from __future__ import annotations

import json
import os
import time

import pytest

from token_goat import session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cache(session_id: str = "test-size-cap") -> session.SessionCache:
    """Return a fresh empty SessionCache without touching disk."""
    now = time.time()
    return session.SessionCache(
        session_id=session_id,
        started_ts=now,
        last_activity_ts=now,
    )


def _bloat_result_cache(cache: session.SessionCache, n: int = 200) -> None:
    """Stuff *n* large ResultCacheEntry objects into cache.result_cache."""
    now = time.time()
    for i in range(n):
        key = f"src/mod{i}.py::function_{i}"
        cache.result_cache[key] = session.ResultCacheEntry(
            file_sha="abc123",
            kind="symbol",
            result={"source": "x" * 500, "line_start": i, "line_end": i + 20},
            ts=now + i,
        )


def _bloat_bash_history(cache: session.SessionCache, n: int = 75) -> None:
    """Stuff *n* BashEntry objects into cache.bash_history."""
    now = time.time()
    for i in range(n):
        sha = f"sha{i:04d}"
        cache.bash_history[sha] = session.BashEntry(
            cmd_sha=sha,
            cmd_preview=f"pytest tests/test_{i}.py -v --tb=long --cov=src" * 3,
            output_id=f"out-{i}",
            ts=now + i,
            stdout_bytes=8000,
            stderr_bytes=500,
        )


def _bloat_hints_seen(cache: session.SessionCache, n: int = 500) -> None:
    """Stuff *n* entries into cache.hints_seen."""
    for i in range(n):
        cache.hints_seen[f"fingerprint_{i:04d}"] = i + 1


def _bloat_greps(cache: session.SessionCache, n: int = 75) -> None:
    """Stuff *n* GrepEntry objects into cache.greps."""
    now = time.time()
    for i in range(n):
        cache.greps.append(session.GrepEntry(
            pattern=f"def function_{i}" * 5,
            path=f"src/module_{i}.py",
            ts=now + i,
            result_count=i,
        ))


# ---------------------------------------------------------------------------
# Session size cap
# ---------------------------------------------------------------------------

class TestSessionSizeCap:
    """_trim_session_for_size trims collections to fit within max_bytes."""

    def test_no_trim_when_under_limit(self):
        """Small session is returned unchanged."""
        cache = _make_cache()
        trimmed = session._trim_session_for_size(cache, max_bytes=2 * 1024 * 1024)
        assert not trimmed

    def test_trim_result_cache_when_over_limit(self):
        """Oversized result_cache is trimmed first (largest contributor)."""
        cache = _make_cache()
        _bloat_result_cache(cache, n=200)
        original_size = len(cache.result_cache)
        # Use a very small cap to force trimming
        trimmed = session._trim_session_for_size(cache, max_bytes=10_000)
        assert trimmed
        assert len(cache.result_cache) < original_size

    def test_trim_bash_history_when_over_limit(self):
        """Oversized bash_history is trimmed when result_cache is empty."""
        cache = _make_cache()
        _bloat_bash_history(cache, n=75)
        original_size = len(cache.bash_history)
        trimmed = session._trim_session_for_size(cache, max_bytes=5_000)
        assert trimmed
        assert len(cache.bash_history) < original_size

    def test_trim_hints_seen_when_over_limit(self):
        """Oversized hints_seen is trimmed when other collections are empty."""
        cache = _make_cache()
        _bloat_hints_seen(cache, n=500)
        original_size = len(cache.hints_seen)
        trimmed = session._trim_session_for_size(cache, max_bytes=5_000)
        assert trimmed
        assert len(cache.hints_seen) < original_size

    def test_trim_greps_when_over_limit(self):
        """Oversized greps list is trimmed."""
        cache = _make_cache()
        _bloat_greps(cache, n=75)
        original_size = len(cache.greps)
        trimmed = session._trim_session_for_size(cache, max_bytes=3_000)
        assert trimmed
        assert len(cache.greps) < original_size

    def test_trim_preserves_files_dict(self):
        """files dict is never trimmed (it is load-bearing for hints)."""
        cache = _make_cache()
        now = time.time()
        for i in range(50):
            k = f"src/file_{i}.py"
            cache.files[k] = session.FileEntry(
                rel_or_abs=k,
                last_read_ts=now,
                read_count=1,
                line_ranges=[(1, 100)],
                symbols_read=[],
            )
        _bloat_result_cache(cache, n=200)
        initial_files = set(cache.files.keys())
        session._trim_session_for_size(cache, max_bytes=5_000)
        # files dict should be unchanged
        assert set(cache.files.keys()) == initial_files

    def test_trim_result_is_valid_json(self):
        """After trimming, to_json() produces valid JSON."""
        cache = _make_cache()
        _bloat_result_cache(cache, n=200)
        _bloat_bash_history(cache, n=75)
        session._trim_session_for_size(cache, max_bytes=20_000)
        try:
            data = json.loads(cache.to_json())
        except json.JSONDecodeError:
            pytest.fail("to_json() returned invalid JSON after trimming")
        assert data["session_id"] == cache.session_id

    def test_trim_produces_smaller_json(self):
        """After trimming, to_json() produces a smaller result than before trimming."""
        cache = _make_cache()
        _bloat_result_cache(cache, n=200)
        # Capture size before trimming
        before_json = cache.to_json()
        # Trim to a small cap — forces entries to be removed
        session._trim_session_for_size(cache, max_bytes=10_000)
        # Invalidate to force re-serialization and check result
        cache._invalidate_json_cache()
        after_json = cache.to_json()
        assert len(after_json) < len(before_json)

    def test_get_session_max_bytes_default(self, monkeypatch):
        """Default is 2MB when env var is not set."""
        monkeypatch.delenv("TOKEN_GOAT_SESSION_MAX_BYTES", raising=False)
        assert session._get_session_max_bytes() == session._SESSION_MAX_BYTES

    def test_get_session_max_bytes_env_override(self, monkeypatch):
        """TOKEN_GOAT_SESSION_MAX_BYTES overrides the default."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_MAX_BYTES", "524288")
        assert session._get_session_max_bytes() == 524288

    def test_get_session_max_bytes_invalid_env_falls_back_to_default(self, monkeypatch):
        """Invalid TOKEN_GOAT_SESSION_MAX_BYTES falls back to default."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_MAX_BYTES", "not-a-number")
        assert session._get_session_max_bytes() == session._SESSION_MAX_BYTES

    def test_get_session_max_bytes_zero_env_falls_back_to_default(self, monkeypatch):
        """Zero TOKEN_GOAT_SESSION_MAX_BYTES falls back to default (must be > 0)."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_MAX_BYTES", "0")
        assert session._get_session_max_bytes() == session._SESSION_MAX_BYTES

    def test_save_applies_size_cap(self, tmp_data_dir, monkeypatch):
        """save() applies size cap before writing if session would exceed the limit."""
        # Set a cap that is smaller than the bloated session but larger than a tiny one.
        # 30000 bytes is ~30KB; the bloated session is ~150KB, so trimming fires.
        monkeypatch.setenv("TOKEN_GOAT_SESSION_MAX_BYTES", "30000")
        cache = _make_cache("test-save-cap")
        _bloat_result_cache(cache, n=200)
        _bloat_bash_history(cache, n=75)
        # Check uncapped JSON size is larger than cap
        uncapped_size = len(cache.to_json().encode("utf-8"))
        assert uncapped_size > 30000, f"Pre-condition failed: {uncapped_size} not > 30000"
        session.save(cache)
        # Verify the file exists and is smaller than the pre-trim size
        p = session.paths.session_cache_path("test-save-cap")
        assert p.exists()
        saved_size = p.stat().st_size
        assert saved_size < uncapped_size, (
            f"Expected saved file ({saved_size}) to be smaller than uncapped ({uncapped_size})"
        )

    def test_trim_bash_dedup_ids(self):
        """bash_dedup_emitted_ids set is trimmed when it is the largest contributor."""
        cache = _make_cache()
        # Set bash_dedup_emitted_ids to a large set
        cache.bash_dedup_emitted_ids = {f"id-{i:04d}" for i in range(150)}
        original_size = len(cache.bash_dedup_emitted_ids)
        trimmed = session._trim_session_for_size(cache, max_bytes=1_000)
        assert trimmed
        assert len(cache.bash_dedup_emitted_ids) < original_size


# ---------------------------------------------------------------------------
# Stale session cleanup at SessionStart
# ---------------------------------------------------------------------------

class TestSessionStartStaleCleanup:
    """session_start triggers cleanup_stale for sessions older than 7 days."""

    def test_cleanup_stale_7_days_cutoff(self, tmp_data_dir):
        """cleanup_stale(168h) removes files older than 7 days."""
        # Create a session file that is 8 days old
        old_id = "old-session-8days"
        s = session.load(old_id)
        session.save(s)
        old_path = session.paths.session_cache_path(old_id)
        old_mtime = time.time() - 8 * 24 * 3600  # 8 days ago
        os.utime(old_path, (old_mtime, old_mtime))

        # Create a session file that is 6 days old (should NOT be removed)
        recent_id = "recent-session-6days"
        s2 = session.load(recent_id)
        session.save(s2)
        recent_path = session.paths.session_cache_path(recent_id)
        recent_mtime = time.time() - 6 * 24 * 3600  # 6 days ago
        os.utime(recent_path, (recent_mtime, recent_mtime))

        removed = session.cleanup_stale(max_age_hours=168.0)
        assert removed >= 1
        assert not old_path.exists(), "8-day-old session should have been removed"
        assert recent_path.exists(), "6-day-old session should be kept"

    def test_cleanup_stale_does_not_remove_active_sessions(self, tmp_data_dir):
        """cleanup_stale leaves files newer than the cutoff intact."""
        active_id = "active-session"
        session.mark_file_read(active_id, "main.py")
        # File is brand new — well within 7 days
        session.cleanup_stale(max_age_hours=168.0)
        active_path = session.paths.session_cache_path(active_id)
        assert active_path.exists()

    def test_cleanup_stale_empty_dir_returns_zero(self, tmp_data_dir):
        """cleanup_stale on an empty sessions directory returns 0."""
        removed = session.cleanup_stale(max_age_hours=168.0)
        assert removed == 0

    def test_session_start_calls_cleanup(self, tmp_data_dir, monkeypatch):
        """session_start invokes cleanup_stale at startup (non-compact source)."""
        cleanup_calls: list[float] = []

        # Patch session.cleanup_stale to record calls
        import token_goat.session as session_mod

        def fake_cleanup(max_age_hours: float = 24.0) -> int:
            cleanup_calls.append(max_age_hours)
            return 0

        monkeypatch.setattr(session_mod, "cleanup_stale", fake_cleanup)

        # The session module that hooks_session lazily imports is already patched
        # via the monkeypatch on the module object (shared reference).
        import contextlib

        from token_goat.hooks_session import session_start
        payload = {
            "session_id": "test-cleanup-session",
            "cwd": str(tmp_data_dir),
        }
        with contextlib.suppress(Exception):
            # session_start may fail for other reasons (db, worker, etc.)
            # — we only care that cleanup was called
            session_start(payload)

        assert len(cleanup_calls) >= 1, "cleanup_stale should have been called"
        assert cleanup_calls[0] == 168.0, f"Expected 168h cutoff, got {cleanup_calls[0]}"


# ---------------------------------------------------------------------------
# Config corrupt TOML fallback (regression)
# ---------------------------------------------------------------------------

class TestConfigCorruptTomlFallback:
    """config.load() falls back to defaults when TOML is corrupt."""

    def _reset_config_cache(self) -> None:
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

    def test_corrupt_toml_returns_defaults(self, tmp_path, monkeypatch):
        """A corrupt TOML file causes load() to return defaults without raising."""
        self._reset_config_cache()
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("this is not valid TOML ][[[", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)

        cfg = cfg_mod.load()
        # Should return defaults — compact_assist is enabled by default
        assert cfg.compact_assist.enabled is True
        assert cfg.bash_compress.enabled is True

    def test_missing_config_returns_defaults(self, tmp_path, monkeypatch):
        """A missing config file returns defaults without raising."""
        self._reset_config_cache()
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "nonexistent.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)

        cfg = cfg_mod.load()
        assert cfg.compact_assist.enabled is True

    def test_corrupt_toml_emits_warning(self, tmp_path, monkeypatch, caplog):
        """A corrupt TOML file triggers a WARNING log, not a crash."""
        import logging
        self._reset_config_cache()
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[[bad", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            cfg_mod.load()

        assert any("load failed" in r.message.lower() for r in caplog.records), (
            f"Expected warning about load failure; got: {[r.message for r in caplog.records]}"
        )

    def test_partial_toml_applies_valid_fields(self, tmp_path, monkeypatch):
        """A partial (valid) TOML file applies its fields and defaults the rest."""
        self._reset_config_cache()
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text(
            "[compact_assist]\nenabled = false\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)

        cfg = cfg_mod.load()
        assert cfg.compact_assist.enabled is False
        # Other sections still default
        assert cfg.bash_compress.enabled is True


# ---------------------------------------------------------------------------
# Session atomic writes (regression: ensure tmp file is not left on success)
# ---------------------------------------------------------------------------

class TestSessionAtomicWrite:
    """save() uses atomic write — no .tmp artifact left on success."""

    def test_no_tmp_artifact_after_successful_save(self, tmp_data_dir):
        """After save(), no .tmp files remain in the sessions directory."""
        s_id = "atomic-write-test"
        session.mark_file_read(s_id, "foo.py")
        p = session.paths.session_cache_path(s_id)
        parent = p.parent
        # No .tmp files should remain after save
        after_tmps = set(parent.glob("*.tmp"))
        assert not after_tmps, (
            f"Stale .tmp files left after save: {after_tmps}"
        )
        assert p.exists()

    def test_saved_file_is_valid_json(self, tmp_data_dir):
        """The session file written by save() is always valid JSON."""
        s_id = "json-valid-test"
        session.mark_file_read(s_id, "bar.py", offset=0, limit=100)
        p = session.paths.session_cache_path(s_id)
        raw = p.read_text(encoding="utf-8")
        data = json.loads(raw)
        assert data["session_id"] == s_id
