"""Tests for _handle_bash_already_read — cross-tool cat/Read session-cache short-circuit."""


def _ctx(result: dict) -> str:
    """Extract additionalContext from a pre_tool_use_with_context result."""
    return result.get("hookSpecificOutput", {}).get("additionalContext", "")


class TestHandleBashAlreadyReadPositive:
    def test_cat_after_read_tool_returns_advisory(self, tmp_data_dir):
        """After a file is recorded in session.files (simulating a Read tool call), cat on that file should return an advisory hint."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "bar-already-read-1"
        path = "/proj/src/foo.py"
        sess.mark_file_read(sid, path)

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is not None
        ctx = _ctx(result)
        assert "already read" in ctx
        assert "token-goat" in ctx
        # Must be advisory, not deny
        assert result.get("action") != "deny"
        assert "permissionDecision" not in result.get("hookSpecificOutput", {})

    def test_read_count_2_defers_to_streak_hint(self, tmp_data_dir):
        """read_count=2 must return None so the streak hint (read_count >= 2) handles it instead."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "bar-already-read-count2"
        path = "/proj/src/foo.py"
        sess.mark_file_read(sid, path)
        sess.mark_file_read(sid, path)  # second read → read_count=2

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None, "read_count=2 must defer to _handle_bash_streak_hint (fires for >= 2)"

    def test_bat_after_read_tool_returns_advisory(self, tmp_data_dir):
        """bat (a cat alternative) targeting an already-read file also fires the hint."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "bar-already-read-bat"
        path = "/proj/src/utils.py"
        sess.mark_file_read(sid, path)

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"bat {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is not None
        assert "already read" in _ctx(result)


    def test_relative_path_resolved_via_cwd(self, tmp_path):
        """cat with a relative path hits the session entry stored under the resolved absolute path."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_bash_already_read

        src_dir = tmp_path / "src"
        src_dir.mkdir()
        (src_dir / "foo.py").write_text("# content", encoding="utf-8")
        abs_path = str(src_dir / "foo.py")
        sid = "bar-cwd-fallback"
        sess.mark_file_read(sid, abs_path)

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": "cat src/foo.py"},
            "cwd": str(tmp_path),
        }
        result = _handle_bash_already_read(payload)
        assert result is not None, "relative path must resolve to session entry via cwd fallback"
        assert "already read" in _ctx(result)


class TestHandleBashAlreadyReadNegative:
    def test_first_time_cat_returns_none(self, tmp_data_dir):
        """No prior read in session → no hint."""
        from token_goat.hooks_read import _handle_bash_already_read

        payload = {
            "session_id": "bar-no-prior-read",
            "tool_name": "Bash",
            "tool_input": {"command": "cat /proj/src/new_file.py"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None

    def test_non_read_command_returns_none(self, tmp_data_dir):
        """Non-read bash commands (npm install) are not handled."""
        from token_goat.hooks_read import _handle_bash_already_read

        payload = {
            "session_id": "bar-non-read",
            "tool_name": "Bash",
            "tool_input": {"command": "npm install"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None

    def test_no_session_id_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _handle_bash_already_read

        payload = {
            "tool_name": "Bash",
            "tool_input": {"command": "cat /proj/src/foo.py"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None

    def test_non_bash_tool_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _handle_bash_already_read

        payload = {
            "session_id": "bar-read-tool",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/foo.py"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None


class TestBashAlreadyReadStatGroup:
    def test_bash_read_equiv_already_read_in_bash_group(self):
        from token_goat.render.stats_renderer import _kind_group_label
        assert _kind_group_label("bash_read_equiv_already_read") == "Bash"
