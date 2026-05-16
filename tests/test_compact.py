"""Tests for compaction assist: manifest generation, config, and pre_compact hook."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import compact, config, hooks_cli, session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _populate_session(session_id: str, *, files: int = 3, greps: int = 2, edits: int = 1) -> None:
    """Put enough activity in a session to exceed any reasonable min_events threshold."""
    for i in range(files):
        session.mark_file_read(session_id, f"/proj/src/file{i}.py", offset=0, limit=100)
    for i in range(greps):
        session.mark_grep(session_id, f"pattern{i}", "/proj/src")
    for i in range(edits):
        session.mark_file_edited(session_id, f"/proj/src/edited{i}.py")


# ---------------------------------------------------------------------------
# compact.event_count
# ---------------------------------------------------------------------------

class TestEventCount:
    def test_empty_session_returns_zero(self, tmp_data_dir):
        assert compact.event_count("empty-session-abc") == 0

    def test_counts_files_greps_and_edits(self, tmp_data_dir):
        sid = "evcount-session-xyz"
        _populate_session(sid, files=3, greps=2, edits=1)
        # event_count = len(files) + len(greps) + len(edited_files)
        assert compact.event_count(sid) == 6

    def test_only_edits_counted(self, tmp_data_dir):
        sid = "only-edits-session-abc"
        session.mark_file_edited(sid, "/proj/app.py")
        session.mark_file_edited(sid, "/proj/app.py")  # same file, same key
        # edited_files is path→count dict, so same path = 1 entry
        assert compact.event_count(sid) == 1

    def test_invalid_session_id_returns_zero(self, tmp_data_dir):
        # Handles load failures gracefully
        assert compact.event_count("a" * 300) == 0  # too long → validation fails → caught


# ---------------------------------------------------------------------------
# compact.build_manifest
# ---------------------------------------------------------------------------

class TestBuildManifest:
    def test_empty_session_returns_empty_string(self, tmp_data_dir):
        result = compact.build_manifest("no-activity-session")
        assert result == ""

    def test_manifest_contains_header(self, tmp_data_dir):
        sid = "manifest-header-session"
        _populate_session(sid, files=2, greps=1, edits=1)
        result = compact.build_manifest(sid)
        assert "## Token-Goat Session Manifest" in result

    def test_edited_files_section_present(self, tmp_data_dir):
        sid = "edited-files-session-abc"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=50)
        # read + edited = 2 events >= min_events=0 for manifest; but build_manifest has no min
        result = compact.build_manifest(sid)
        assert "Files Edited" in result
        assert "auth.py" in result

    def test_symbols_section_present(self, tmp_data_dir):
        sid = "symbols-session-abc"
        session.mark_file_read(sid, "/proj/src/parser.py", symbol="index_project")
        result = compact.build_manifest(sid)
        assert "Symbols Accessed" in result
        assert "index_project" in result

    def test_key_files_section_present(self, tmp_data_dir):
        sid = "keyfiles-session-abc"
        session.mark_file_read(sid, "/proj/src/db.py", offset=0, limit=200)
        result = compact.build_manifest(sid)
        assert "Key Files Read" in result
        assert "db.py" in result

    def test_manifest_respects_token_budget(self, tmp_data_dir):
        sid = "budget-session-abc"
        # Add many files to push the manifest above a tiny budget
        for i in range(20):
            session.mark_file_read(sid, f"/proj/src/bigfile{i:02d}.py", offset=0, limit=500)
        result = compact.build_manifest(sid, max_tokens=50)
        max_chars = 50 * 4
        assert len(result) <= max_chars

    def test_edited_files_sorted_by_edit_count(self, tmp_data_dir):
        sid = "sort-edits-session-abc"
        session.mark_file_edited(sid, "/proj/a.py")
        session.mark_file_edited(sid, "/proj/b.py")
        session.mark_file_edited(sid, "/proj/b.py")
        session.mark_file_edited(sid, "/proj/b.py")
        result = compact.build_manifest(sid)
        # b.py was edited 3× — should appear before a.py
        assert result.index("b.py") < result.index("a.py")

    def test_edit_count_suffix_in_manifest(self, tmp_data_dir):
        sid = "suffix-session-abc"
        for _ in range(4):
            session.mark_file_edited(sid, "/proj/hot.py")
        result = compact.build_manifest(sid)
        assert "×4" in result

    def test_manifest_is_string(self, tmp_data_dir):
        sid = "str-check-session"
        _populate_session(sid)
        result = compact.build_manifest(sid)
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# config.load / config.save
# ---------------------------------------------------------------------------

class TestConfigLoad:
    def test_defaults_when_no_file(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        cfg = config.load()
        assert cfg.compact_assist.enabled is True
        assert "manual" in cfg.compact_assist.triggers
        assert "auto" in cfg.compact_assist.triggers
        assert cfg.compact_assist.min_events == 5
        assert cfg.compact_assist.max_manifest_tokens == 400

    def test_env_var_disables_compact_assist(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        for val in ("0", "false", "no", "off"):
            monkeypatch.setenv("TOKEN_GOAT_COMPACT_ASSIST", val)
            cfg = config.load()
            assert cfg.compact_assist.enabled is False, f"expected disabled for env={val!r}"

    def test_env_var_blank_leaves_enabled(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.setenv("TOKEN_GOAT_COMPACT_ASSIST", "")
        cfg = config.load()
        assert cfg.compact_assist.enabled is True

    def test_toml_overrides_defaults(self, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            "[compact_assist]\nenabled = false\nmin_events = 10\nmax_manifest_tokens = 200\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        cfg = config.load()
        assert cfg.compact_assist.enabled is False
        assert cfg.compact_assist.min_events == 10
        assert cfg.compact_assist.max_manifest_tokens == 200

    def test_corrupt_toml_falls_back_to_defaults(self, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("this is not valid toml }{{{", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)
        cfg = config.load()
        assert cfg.compact_assist.enabled is True  # fell back to default

    def test_save_and_reload(self, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        original = config.load()
        original.compact_assist.enabled = False
        original.compact_assist.min_events = 99
        config.save(original)

        reloaded = config.load()
        assert reloaded.compact_assist.enabled is False
        assert reloaded.compact_assist.min_events == 99


# ---------------------------------------------------------------------------
# pre_compact hook handler
# ---------------------------------------------------------------------------

class TestPreCompactHandler:
    def _make_payload(self, session_id: str, trigger: str = "manual") -> dict:
        return {"session_id": session_id, "trigger": trigger}

    def test_disabled_returns_continue_only(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = false\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "disabled-session-abc"
        _populate_session(sid, files=5, greps=3, edits=2)
        result = hooks_cli.pre_compact(self._make_payload(sid))
        _assert_continue(result)
        assert "systemMessage" not in result

    def test_env_var_disables_handler(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.setenv("TOKEN_GOAT_COMPACT_ASSIST", "0")

        sid = "envdisabled-session-abc"
        _populate_session(sid, files=5, greps=3, edits=2)
        result = hooks_cli.pre_compact(self._make_payload(sid))
        _assert_continue(result)

    def test_trigger_not_in_config_skips(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text('[compact_assist]\ntriggers = ["manual"]\n', encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "trigger-filter-session"
        _populate_session(sid, files=5, greps=3, edits=2)
        # trigger="auto" is not in ["manual"]
        result = hooks_cli.pre_compact(self._make_payload(sid, trigger="auto"))
        _assert_continue(result)
        assert "systemMessage" not in result

    def test_below_min_events_skips(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nmin_events = 100\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "below-min-session-abc"
        _populate_session(sid, files=2, greps=1, edits=0)  # 3 events < 100
        result = hooks_cli.pre_compact(self._make_payload(sid))
        _assert_continue(result)
        assert "systemMessage" not in result

    def test_happy_path_emits_system_message(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 1\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "happy-path-session-abc"
        _populate_session(sid, files=3, greps=2, edits=1)
        result = hooks_cli.pre_compact(self._make_payload(sid, trigger="manual"))

        assert result["continue"] is True
        assert "systemMessage" in result
        msg = result["systemMessage"]
        assert isinstance(msg, str)
        assert len(msg) > 0
        assert "Token-Goat Session Manifest" in msg

    def test_auto_trigger_emits_when_in_config(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            '[compact_assist]\nenabled = true\nmin_events = 1\ntriggers = ["manual", "auto"]\n',
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "auto-trigger-session-abc"
        _populate_session(sid, files=2, greps=1, edits=1)
        result = hooks_cli.pre_compact(self._make_payload(sid, trigger="auto"))

        assert "systemMessage" in result

    def test_missing_session_id_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        result = hooks_cli.pre_compact({"trigger": "manual"})
        _assert_continue(result)

    def test_empty_session_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text("[compact_assist]\nenabled = true\nmin_events = 0\n", encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        # Session exists but no activity → manifest is empty string → no systemMessage
        result = hooks_cli.pre_compact(self._make_payload("completely-empty-session-abc"))
        _assert_continue(result)

    def test_system_message_respects_token_budget(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths
        budget = 100
        cfg_path = tmp_path / "config.toml"
        cfg_path.write_text(
            f"[compact_assist]\nenabled = true\nmin_events = 1\nmax_manifest_tokens = {budget}\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        sid = "budget-check-session-abc"
        for i in range(20):
            session.mark_file_read(sid, f"/proj/src/mod{i:02d}.py", offset=0, limit=200)
        for i in range(5):
            session.mark_file_edited(sid, f"/proj/src/edit{i}.py")

        result = hooks_cli.pre_compact(self._make_payload(sid))
        if "systemMessage" in result:
            assert len(result["systemMessage"]) <= budget * 4

    def test_garbage_payload_does_not_crash(self, tmp_data_dir):
        """fail_soft must absorb any exception and return continue:true."""
        result = hooks_cli.pre_compact({"session_id": None, "trigger": None})
        assert result.get("continue") is True


# ---------------------------------------------------------------------------
# Dispatcher integration
# ---------------------------------------------------------------------------

class TestDispatcherIntegration:
    def test_pre_compact_event_is_registered(self, tmp_data_dir):
        assert "pre-compact" in hooks_cli.EVENTS

    def test_dispatch_pre_compact_returns_continue(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import paths

        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "config.toml")
        monkeypatch.delenv("TOKEN_GOAT_COMPACT_ASSIST", raising=False)

        result = hooks_cli.dispatch("pre-compact", {"session_id": "dispatch-test-abc", "trigger": "manual"})
        assert result.get("continue") is True
