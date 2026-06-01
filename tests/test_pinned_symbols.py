"""Tests for the pinned-symbols feature.

Covers:
- session.SessionCache.add_pinned / remove_pinned / list_pinned
- Max-20 cap enforcement
- to_dict / from_dict round-trip
- hints.build_pinned_hint fires on match, returns None on miss
- compact._render includes ## Pinned section at top when pins exist
- CLI: token-goat pinned add / remove / list
"""
from __future__ import annotations

import json
import time

import pytest
from typer.testing import CliRunner

from token_goat.cli import app
from token_goat.compact import build_manifest
from token_goat.hints import HINT_PRIORITY_CRITICAL, build_pinned_hint
from token_goat.session import (
    PINNED_SYMBOLS_MAX,
    SessionCache,
    load,
    save,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fresh_cache(session_id: str = "testsession1234") -> SessionCache:
    now = time.time()
    return SessionCache(
        session_id=session_id,
        started_ts=now,
        last_activity_ts=now,
    )


def _write_session(tmp_path, session_id: str, *, pinned: list[str] | None = None) -> None:
    """Write a minimal session JSON to tmp_path/sessions/<session_id>.json."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(exist_ok=True)
    now = time.time()
    payload = {
        "schema_version": 1,
        "created_by": "token-goat",
        "session_id": session_id,
        "started_ts": now - 60,
        "last_activity_ts": now,
        "created_ts": now - 60,
        "cwd": "",
        "files": {},
        "edited_files": {"src/foo.py": 1},
        "hints_emitted": 0,
        "hints_ignored": 0,
        "greps": [],
        "bash_history": {},
        "web_history": {},
        "skill_history": {},
        "decisions": [],
        "result_cache": {},
        "glob_history": [],
        "snapshot_shas": {},
        "hints_seen": {},
        "bash_dedup_emitted_ids": [],
        "structured_hints_emitted": 0,
        "index_only_hints_emitted": 0,
        "hints_emitted_by_type": {},
        "hints_suppressed_by_type": {},
        "recent_hints": [],
        "last_manifest_sha": "",
        "last_manifest_ts": 0.0,
        "version": 1,
        "hint_category_history": {},
        "image_shrink_count": {},
        "pinned_symbols": pinned or [],
    }
    f = sessions_dir / f"{session_id}.json"
    f.write_text(json.dumps(payload), encoding="utf-8")


# ---------------------------------------------------------------------------
# SessionCache unit tests
# ---------------------------------------------------------------------------

class TestSessionPinnedMethods:
    def test_add_pinned_creates_entry(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        assert cache.list_pinned() == ["src/auth.py::login"]

    def test_add_pinned_idempotent(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        cache.add_pinned("src/auth.py::login")
        assert len(cache.list_pinned()) == 1

    def test_remove_pinned_returns_true_and_removes(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        removed = cache.remove_pinned("src/auth.py::login")
        assert removed is True
        assert cache.list_pinned() == []

    def test_remove_pinned_missing_returns_false(self):
        cache = _fresh_cache()
        removed = cache.remove_pinned("src/auth.py::login")
        assert removed is False

    def test_list_pinned_empty_session(self):
        cache = _fresh_cache()
        assert cache.list_pinned() == []

    def test_max_pinned_symbols_cap(self):
        cache = _fresh_cache()
        for i in range(PINNED_SYMBOLS_MAX):
            cache.add_pinned(f"src/file{i}.py::Func{i}")
        assert len(cache.list_pinned()) == PINNED_SYMBOLS_MAX
        with pytest.raises(ValueError, match="pinned-symbol limit reached"):
            cache.add_pinned("src/overflow.py::Boom")
        # Existing pins unchanged after rejection
        assert len(cache.list_pinned()) == PINNED_SYMBOLS_MAX


class TestSessionPinnedPersistence:
    def test_to_dict_round_trip(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        cache.add_pinned("src/models.py::User")
        d = cache.to_dict()
        assert d["pinned_symbols"] == ["src/auth.py::login", "src/models.py::User"]

    def test_from_dict_restores_pinned(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert restored.list_pinned() == ["src/auth.py::login"]

    def test_from_dict_missing_field_defaults_to_empty(self):
        """Old session JSON without pinned_symbols deserializes to []."""
        cache = _fresh_cache()
        d = cache.to_dict()
        d.pop("pinned_symbols", None)
        restored = SessionCache.from_dict(d)
        assert restored.list_pinned() == []

    def test_from_dict_strips_malformed_entries(self):
        """Entries without '::' are dropped during deserialization."""
        cache = _fresh_cache()
        d = cache.to_dict()
        d["pinned_symbols"] = ["valid::spec", "no-double-colon", "", 42]  # type: ignore[list-item]
        restored = SessionCache.from_dict(d)
        assert restored.list_pinned() == ["valid::spec"]

    def test_from_dict_enforces_cap_on_load(self):
        """A hand-edited session with > 20 pins is trimmed to PINNED_SYMBOLS_MAX."""
        cache = _fresh_cache()
        d = cache.to_dict()
        d["pinned_symbols"] = [f"src/f{i}.py::F{i}" for i in range(PINNED_SYMBOLS_MAX + 5)]
        restored = SessionCache.from_dict(d)
        assert len(restored.list_pinned()) == PINNED_SYMBOLS_MAX

    def test_save_and_load_round_trip(self, tmp_data_dir):
        cache = _fresh_cache()
        cache.add_pinned("src/foo.py::Bar")
        save(cache)
        loaded = load(cache.session_id)
        assert loaded is not None
        assert loaded.list_pinned() == ["src/foo.py::Bar"]


# ---------------------------------------------------------------------------
# hints.build_pinned_hint
# ---------------------------------------------------------------------------

class TestBuildPinnedHint:
    def test_hint_fires_on_exact_match(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        hint = build_pinned_hint(cache, "src/auth.py", "login")
        assert hint is not None
        assert hint.hint_priority == HINT_PRIORITY_CRITICAL
        assert "src/auth.py::login" in hint.text
        assert "Pinned" in hint.text

    def test_hint_returns_none_on_no_pins(self):
        cache = _fresh_cache()
        hint = build_pinned_hint(cache, "src/auth.py", "login")
        assert hint is None

    def test_hint_returns_none_on_symbol_mismatch(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        hint = build_pinned_hint(cache, "src/auth.py", "logout")
        assert hint is None

    def test_hint_returns_none_on_file_mismatch(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        hint = build_pinned_hint(cache, "src/other.py", "login")
        assert hint is None

    def test_hint_returns_none_when_symbol_empty(self):
        cache = _fresh_cache()
        cache.add_pinned("src/auth.py::login")
        hint = build_pinned_hint(cache, "src/auth.py", "")
        assert hint is None

    def test_hint_returns_none_when_session_none(self):
        hint = build_pinned_hint(None, "src/auth.py", "login")
        assert hint is None


# ---------------------------------------------------------------------------
# compact.build_manifest — ## Pinned section
# ---------------------------------------------------------------------------

class TestCompactManifestPinnedSection:
    def test_pinned_section_present_at_top(self, tmp_data_dir):
        cache = _fresh_cache("manifsession00001")
        cache.edited_files["src/foo.py"] = 2
        cache.add_pinned("src/foo.py::MyClass")
        save(cache)
        manifest = build_manifest("manifsession00001")
        assert "## Pinned" in manifest
        assert "src/foo.py::MyClass" in manifest
        # Must appear BEFORE the Edited section
        pinned_pos = manifest.index("## Pinned")
        token_goat_header_pos = manifest.index("Token-Goat Session Manifest")
        assert token_goat_header_pos < pinned_pos

    def test_no_pinned_section_when_empty(self, tmp_data_dir):
        cache = _fresh_cache("manifsession00002")
        cache.edited_files["src/bar.py"] = 1
        save(cache)
        manifest = build_manifest("manifsession00002")
        assert "## Pinned" not in manifest

    def test_multiple_pins_all_listed(self, tmp_data_dir):
        cache = _fresh_cache("manifsession00003")
        cache.edited_files["src/foo.py"] = 1
        cache.add_pinned("src/foo.py::ClassA")
        cache.add_pinned("src/bar.py::func_b")
        save(cache)
        manifest = build_manifest("manifsession00003")
        assert "src/foo.py::ClassA" in manifest
        assert "src/bar.py::func_b" in manifest


# ---------------------------------------------------------------------------
# CLI tests: token-goat pinned add / remove / list
# ---------------------------------------------------------------------------

class TestCLIPinned:
    def test_add_and_list(self, tmp_data_dir):
        _write_session(tmp_data_dir, "clisession0000001")
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "add", "src/foo.py::MyClass", "--session-id", "clisession0000001"]
        )
        assert result.exit_code == 0, result.output
        assert "pinned" in result.output.lower()

        result2 = runner.invoke(
            app, ["pinned", "list", "--session-id", "clisession0000001"]
        )
        assert result2.exit_code == 0, result2.output
        assert "src/foo.py::MyClass" in result2.output

    def test_remove_existing(self, tmp_data_dir):
        _write_session(tmp_data_dir, "clisession0000002", pinned=["src/foo.py::MyClass"])
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "remove", "src/foo.py::MyClass", "--session-id", "clisession0000002"]
        )
        assert result.exit_code == 0, result.output
        assert "unpinned" in result.output.lower()

        result2 = runner.invoke(
            app, ["pinned", "list", "--session-id", "clisession0000002"]
        )
        assert "src/foo.py::MyClass" not in result2.output

    def test_remove_nonexistent_is_idempotent(self, tmp_data_dir):
        _write_session(tmp_data_dir, "clisession0000003")
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "remove", "src/nonexistent.py::Ghost", "--session-id", "clisession0000003"]
        )
        assert result.exit_code == 0, result.output
        assert "not pinned" in result.output.lower()

    def test_list_empty(self, tmp_data_dir):
        _write_session(tmp_data_dir, "clisession0000004")
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "list", "--session-id", "clisession0000004"]
        )
        assert result.exit_code == 0, result.output
        assert "no pinned" in result.output.lower()

    def test_add_invalid_spec_missing_double_colon(self, tmp_data_dir):
        _write_session(tmp_data_dir, "clisession0000005")
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "add", "src/foo.py/MyClass", "--session-id", "clisession0000005"]
        )
        assert result.exit_code != 0

    def test_add_max_exceeded(self, tmp_data_dir):
        pins = [f"src/f{i}.py::F{i}" for i in range(PINNED_SYMBOLS_MAX)]
        _write_session(tmp_data_dir, "clisession0000006", pinned=pins)
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "add", "src/overflow.py::TooMany", "--session-id", "clisession0000006"]
        )
        assert result.exit_code != 0
        assert "limit" in result.output.lower()

    def test_unknown_action(self, tmp_data_dir):
        _write_session(tmp_data_dir, "clisession0000007")
        runner = CliRunner()
        result = runner.invoke(
            app, ["pinned", "oops", "src/foo.py::Bar", "--session-id", "clisession0000007"]
        )
        assert result.exit_code != 0
