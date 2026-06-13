"""Tests for compound-command read-chain dedup hint.

Covers split_compound() in bash_parser and _handle_compound_cmd_hint()
in hooks_read:
- Single-segment command → no hint
- wc -l X && tail -30 X where both cached → emits hint with both IDs
- wc -l X && tail -30 X where neither cached → no hint
- cat A && cat B where A cached, B not → emits hint mentioning A
- Hint response always has continue=True (advisory, never blocks)
- || fallback branch is dropped by split_compound
- Segments inside quotes are not split
"""
import pytest

# ---------------------------------------------------------------------------
# split_compound unit tests
# ---------------------------------------------------------------------------

class TestSplitCompound:
    def test_single_segment_returned_as_is(self):
        from token_goat.bash_parser import split_compound
        assert split_compound("cat foo.py") == ["cat foo.py"]

    def test_and_and_splits_two_segments(self):
        from token_goat.bash_parser import split_compound
        result = split_compound("wc -l foo.log && tail -30 foo.log")
        assert result == ["wc -l foo.log", "tail -30 foo.log"]

    def test_semicolon_splits_two_segments(self):
        from token_goat.bash_parser import split_compound
        result = split_compound("cat a.py; cat b.py")
        assert result == ["cat a.py", "cat b.py"]

    def test_or_branch_is_dropped(self):
        from token_goat.bash_parser import split_compound
        # cmd1 || fallback → only cmd1 returned
        result = split_compound("cat a.py || echo 'missing'")
        assert result == ["cat a.py"]

    def test_and_after_or_resumes_collection(self):
        """cmd1 || fallback && cmd3 → [cmd1, cmd3] (fallback dropped, cmd3 kept)."""
        from token_goat.bash_parser import split_compound
        result = split_compound("cat a.py || true && cat b.py")
        assert result == ["cat a.py", "cat b.py"]

    def test_quotes_protect_separator(self):
        from token_goat.bash_parser import split_compound
        result = split_compound('cmd "foo && bar"')
        assert result == ['cmd "foo && bar"']

    def test_single_quotes_protect_separator(self):
        from token_goat.bash_parser import split_compound
        result = split_compound("cmd 'a; b'")
        assert result == ["cmd 'a; b'"]

    def test_subshell_protects_separator(self):
        from token_goat.bash_parser import split_compound
        result = split_compound("cmd $(sub && inner) && outer")
        assert result == ["cmd $(sub && inner)", "outer"]

    def test_three_segments(self):
        from token_goat.bash_parser import split_compound
        result = split_compound("cat a && cat b && cat c")
        assert result == ["cat a", "cat b", "cat c"]


# ---------------------------------------------------------------------------
# _handle_compound_cmd_hint integration tests
# ---------------------------------------------------------------------------

def _make_payload(command: str, session_id: str = "compound-test-sid", cwd: str = "/proj") -> dict:
    return {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "cwd": cwd,
    }


def _ctx(result: dict) -> str:
    return result.get("hookSpecificOutput", {}).get("additionalContext", "")


def _store(sid: str, cmd: str, cwd: str, tmp_path) -> None:
    """Store a fake cached output for cmd and write its sidecar (mirroring post_bash)."""
    import token_goat.bash_cache as bc
    meta = bc.store_output(sid, cmd, stdout="fake output for caching", stderr="", exit_code=0, cwd=cwd)
    if meta is not None:
        bc.write_sidecar(meta)


class TestCompoundCmdHint:
    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_data_dir):
        self.tmp_data_dir = tmp_data_dir

    # ── No-hint cases ────────────────────────────────────────────────────────

    def test_single_segment_no_hint(self):
        """A non-compound command never triggers the compound hint."""
        from token_goat.hooks_read import _handle_compound_cmd_hint
        result = _handle_compound_cmd_hint(_make_payload("cat foo.py"))
        assert result is None

    def test_neither_segment_cached_no_hint(self):
        """No hint when none of the segments have cached output."""
        from token_goat.hooks_read import _handle_compound_cmd_hint
        result = _handle_compound_cmd_hint(
            _make_payload("wc -l file.log && tail -30 file.log", session_id="cch-nocache")
        )
        assert result is None

    def test_only_one_read_type_segment_no_hint(self):
        """A compound command with only one read-type segment never fires."""
        from token_goat.hooks_read import _handle_compound_cmd_hint
        # "echo hello" is not a read, so only "cat foo.py" qualifies
        result = _handle_compound_cmd_hint(
            _make_payload("echo hello && cat foo.py", session_id="cch-one-read")
        )
        assert result is None

    # ── Positive hint cases ──────────────────────────────────────────────────

    def test_both_segments_cached_emits_hint(self, tmp_path):
        """When both segments are cached the hint mentions each one."""
        from token_goat.hooks_read import _handle_compound_cmd_hint

        sid = "cch-both-cached"
        cwd = str(tmp_path)
        cmd_a = "wc -l file.log"
        cmd_b = "tail -30 file.log"
        _store(sid, cmd_a, cwd, tmp_path)
        _store(sid, cmd_b, cwd, tmp_path)

        compound = f"{cmd_a} && {cmd_b}"
        result = _handle_compound_cmd_hint(_make_payload(compound, session_id=sid, cwd=cwd))
        assert result is not None
        ctx = _ctx(result)
        assert "[token-goat]" in ctx
        assert "wc -l file.log" in ctx
        assert "tail -30 file.log" in ctx
        assert "bash-output" in ctx

    def test_one_segment_cached_emits_hint_for_that_segment(self, tmp_path):
        """When only segment A is cached the hint mentions A but not B."""
        from token_goat.hooks_read import _handle_compound_cmd_hint

        sid = "cch-one-cached"
        cwd = str(tmp_path)
        cmd_a = "cat a.py"
        cmd_b = "cat b.py"
        _store(sid, cmd_a, cwd, tmp_path)
        # cmd_b intentionally NOT stored

        compound = f"{cmd_a} && {cmd_b}"
        result = _handle_compound_cmd_hint(_make_payload(compound, session_id=sid, cwd=cwd))
        assert result is not None
        ctx = _ctx(result)
        assert "cat a.py" in ctx
        assert "bash-output" in ctx
        # b.py should not appear in the cached-segment list
        assert "cat b.py" not in ctx

    # ── Safety: advisory contract ─────────────────────────────────────────────

    def test_hint_is_always_continue_true(self, tmp_path):
        """The compound hint must never block — always continue=True."""
        from token_goat.hooks_read import _handle_compound_cmd_hint

        sid = "cch-continue-check"
        cwd = str(tmp_path)
        _store(sid, "cat a.py", cwd, tmp_path)

        result = _handle_compound_cmd_hint(
            _make_payload("cat a.py && cat b.py", session_id=sid, cwd=cwd)
        )
        assert result is not None
        # pre_tool_use_with_context always sets continue=True implicitly;
        # verify no deny/block key is present
        assert result.get("action") != "deny"
        hso = result.get("hookSpecificOutput", {})
        assert "permissionDecision" not in hso
        # additionalContext is populated (not a blocking response)
        assert hso.get("additionalContext")

    def test_no_hint_for_non_bash_tool(self):
        """The function must guard against non-Bash payloads gracefully."""
        from token_goat.hooks_read import _handle_compound_cmd_hint
        payload = {
            "session_id": "cch-non-bash",
            "tool_name": "Read",
            "tool_input": {"file_path": "foo.py"},
            "cwd": "/proj",
        }
        # Should not raise; command key missing → None
        result = _handle_compound_cmd_hint(payload)
        assert result is None

    # ── split_compound: backtick subshell ─────────────────────────────────────

    def test_backtick_protects_separator(self):
        """&& inside a backtick subshell must not split the command."""
        from token_goat.bash_parser import split_compound

        result = split_compound("result=`cat a && cat b` && echo result")
        assert result == ["result=`cat a && cat b`", "echo result"]

    def test_backtick_at_end(self):
        """Unclosed backtick (unlikely but safe) should not crash."""
        from token_goat.bash_parser import split_compound

        result = split_compound("result=`cat a && cat b`")
        assert result == ["result=`cat a && cat b`"]

    def test_backtick_semicolon_protected(self):
        """Semicolon inside backtick must also be suppressed."""
        from token_goat.bash_parser import split_compound

        result = split_compound("x=`a; b` && cat c")
        assert result == ["x=`a; b`", "cat c"]
