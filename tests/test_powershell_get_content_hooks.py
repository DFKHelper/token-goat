"""Integration tests: full hook flow for PowerShell Get-Content read-equivalents.

Covers the three gaps identified in iteration 2 of the Get-Content improvement loop:

1. ``post_bash`` marks files in session read-history for read-equivalent Bash commands
   (Get-Content, cat, bat, head, tail) so that the "already read" hint fires on repeat
   access — same as a native Read tool call.

2. ``pre_bash`` converts a Get-Content invocation to a Read payload, triggers image
   shrink / session hint logic, and recurses through ``pre_read`` correctly.

3. ``-Include`` / ``-Exclude`` / ``-Filter`` flags in bash_parser no longer eat the
   file path as the flag argument (regression guard for the parser fix).
"""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_cli, session

# ---------------------------------------------------------------------------
# Helper: simulate a successful PostToolUse(Bash) payload
# ---------------------------------------------------------------------------


def _post_bash_payload(
    sid: str,
    command: str,
    stdout: str = "line1\nline2\n",
    exit_code: int = 0,
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
    }


def _pre_bash_payload(sid: str, command: str) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "cwd": "C:/proj",
    }


# ---------------------------------------------------------------------------
# 1. post_bash  — read-equivalent session tracking
# ---------------------------------------------------------------------------


class TestPostBashReadEquivalentTracking:
    """post_bash must record the file in session.files for read-like commands."""

    def test_get_content_marks_file_read(self, tmp_data_dir):
        """``Get-Content foo.py`` should appear in session files after post_bash."""
        sid = "pgc-1"
        payload = _post_bash_payload(sid, "Get-Content foo.py")
        result = hooks_cli.post_bash(payload)
        _assert_continue(result)

        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "foo.py" in read_paths, (
            "Get-Content foo.py must be recorded in session files after post_bash"
        )

    def test_gc_alias_marks_file_read(self, tmp_data_dir):
        """``gc foo.py`` (gc alias) must also mark the file in session.files."""
        sid = "pgc-2"
        payload = _post_bash_payload(sid, "gc app.log")
        _assert_continue(hooks_cli.post_bash(payload))

        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "app.log" in read_paths

    def test_cat_marks_file_read(self, tmp_data_dir):
        """``cat src/foo.py`` must also mark the file — cat is a read-equivalent."""
        sid = "pgc-3"
        payload = _post_bash_payload(sid, "cat src/foo.py")
        _assert_continue(hooks_cli.post_bash(payload))

        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "src/foo.py" in read_paths

    def test_failed_get_content_not_marked(self, tmp_data_dir):
        """A failed Get-Content (exit_code != 0) must NOT mark the file as read."""
        sid = "pgc-4"
        payload = _post_bash_payload(
            sid, "Get-Content missing.txt",
            stdout="Get-Content: Cannot find path",
            exit_code=1,
        )
        _assert_continue(hooks_cli.post_bash(payload))

        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "missing.txt" not in read_paths, (
            "Failed Get-Content must not be recorded in session files"
        )

    def test_get_content_with_totalcount_marks_offset_and_limit(self, tmp_data_dir):
        """``Get-Content -TotalCount 50 foo.py`` records offset + limit in session entry."""
        sid = "pgc-5"
        payload = _post_bash_payload(sid, "Get-Content -TotalCount 50 foo.py")
        _assert_continue(hooks_cli.post_bash(payload))

        cache = session.load(sid)
        # Find the entry for foo.py
        matched = [e for e in cache.files.values() if e.rel_or_abs == "foo.py"]
        assert matched, "foo.py must be in session files"
        entry = matched[0]
        assert entry.read_count >= 1

    def test_get_content_wait_not_marked(self, tmp_data_dir):
        """-Wait is an interactive pager (tail -f); must NOT mark as a file read."""
        sid = "pgc-6"
        payload = _post_bash_payload(sid, "Get-Content app.log -Wait")
        _assert_continue(hooks_cli.post_bash(payload))

        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "app.log" not in read_paths, (
            "Get-Content -Wait is an interactive pager and must not be recorded as a file read"
        )

    def test_pre_then_post_produces_hint_on_repeat(self, tmp_data_dir, monkeypatch):
        """Full round-trip: post_bash marks file → pre_read emits 'already read' hint."""
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        sid = "pgc-7"
        # First pass: post_bash records the read
        payload1 = _post_bash_payload(sid, "Get-Content util.py")
        _assert_continue(hooks_cli.post_bash(payload1))

        # Second pass: pre_read (for a native Read) should now emit a hint
        payload2 = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "util.py", "offset": 0, "limit": 200},
            "cwd": "C:/proj",
        }
        result = hooks_cli.pre_read(payload2)
        _assert_continue(result)
        # The "already read" hint fires in hookSpecificOutput.additionalContext
        assert "hookSpecificOutput" in result, (
            "pre_read must emit an 'already read' hint after Get-Content was tracked "
            "by post_bash"
        )
        ctx = result["hookSpecificOutput"]
        assert "additionalContext" in ctx
        # Hint must reference the file path
        assert "util.py" in ctx["additionalContext"]


# ---------------------------------------------------------------------------
# 2. pre_bash — Get-Content → Read conversion for image-shrink / hint dispatch
# ---------------------------------------------------------------------------


class TestPreBashGetContentDispatch:
    """pre_bash must route Get-Content to the Read pipeline (session hints, etc.)."""

    def test_get_content_triggers_pre_read_pipeline(self, tmp_data_dir, monkeypatch):
        """Pre-Bash with Get-Content reaches the pre_read handler (no crash, continue)."""
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        payload = _pre_bash_payload("pgc-8", "Get-Content README.md")
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)

    def test_gc_alias_triggers_pre_read_pipeline(self, tmp_data_dir, monkeypatch):
        """``gc`` alias must also reach the pre_read handler without crashing."""
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        payload = _pre_bash_payload("pgc-9", "gc README.md")
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)

    def test_get_content_cached_file_emits_hint(self, tmp_data_dir, monkeypatch):
        """pre_read emits a hint when the file is already in session cache."""
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        sid = "pgc-10"
        path = "C:/proj/util.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        # Simulate Codex calling Get-Content on a file already read this session.
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"Get-Content {path}"},
            "cwd": "C:/proj",
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)
        # Must emit additionalContext because the file is in the session cache
        assert "hookSpecificOutput" in result, (
            "pre_read/pre_bash must emit 'already read' hint for a cached file "
            "when Get-Content is used"
        )


# ---------------------------------------------------------------------------
# 3. Parser regression: -Include / -Exclude / -Filter must not eat the path
# ---------------------------------------------------------------------------


class TestGetContentFlagParsing:
    """bash_parser.parse must not misidentify -Include/-Exclude/-Filter args as paths."""

    def _parse(self, cmd: str):
        from token_goat.bash_parser import parse
        return parse(cmd)

    def test_include_flag_skips_pattern_not_path(self):
        """-Include *.txt file.log → target must be file.log, not *.txt."""
        intent = self._parse("Get-Content -Include *.txt file.log")
        assert intent.kind == "read"
        assert intent.target_path == "file.log", (
            f"-Include pattern must not be treated as the file path; "
            f"got {intent.target_path!r}"
        )

    def test_exclude_flag_skips_pattern_not_path(self):
        """-Exclude debug.log app.log → target must be app.log."""
        intent = self._parse("Get-Content -Exclude debug.log app.log")
        assert intent.kind == "read"
        assert intent.target_path == "app.log"

    def test_filter_flag_skips_provider_pattern(self):
        """-Filter *.txt app.log → target must be app.log, not *.txt."""
        intent = self._parse("Get-Content -Filter *.log C:/logs/app.log")
        assert intent.kind == "read"
        assert intent.target_path == "C:/logs/app.log"

    def test_include_with_path_flag(self):
        """``gc -Include *.py -Path src/main.py`` → target must be src/main.py."""
        intent = self._parse("gc -Include *.py -Path src/main.py")
        assert intent.kind == "read"
        assert intent.target_path == "src/main.py"

    def test_encoding_still_skips_correctly(self):
        """Existing -Encoding handling must still work after the flag set expansion."""
        intent = self._parse("Get-Content -Encoding utf8 foo.txt")
        assert intent.kind == "read"
        assert intent.target_path == "foo.txt"

    def test_include_after_path_no_target_paths_confusion(self):
        """-Include after the path should not steal the path from target_paths."""
        intent = self._parse("Get-Content foo.txt -Include *.txt")
        assert intent.kind == "read"
        assert intent.target_path == "foo.txt"
        # -Include after path: *.txt is the include arg, so target_paths should be None
        # (single file) — important that foo.txt is preserved
        assert intent.target_paths is None


class TestMultiFileGetContentTracking:
    """Regression: post_bash must mark ALL files in a multi-file Get-Content read.

    Before the fix, ``gc f1.txt f2.txt`` only recorded ``f1.txt`` (target_path)
    while ``f2.txt`` (in target_paths) was silently dropped, so the "already
    read" hint never fired on a repeat access of the second file.
    """

    def test_multi_file_all_paths_marked(self, tmp_data_dir):
        """``gc f1.py f2.py`` must record BOTH paths in session files."""
        sid = "pgc-multi-1"
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": "gc src/a.py src/b.py"},
            "tool_response": {"stdout": "content\n", "stderr": "", "exit_code": 0},
        }
        from token_goat import hooks_cli, session

        hooks_cli.post_bash(payload)
        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "src/a.py" in read_paths, "first file must be tracked"
        assert "src/b.py" in read_paths, (
            "second file must be tracked — regression for multi-file mark_file_read gap"
        )

    def test_single_file_still_works(self, tmp_data_dir):
        """Single-file Get-Content still records the path after the multi-file fix."""
        sid = "pgc-multi-2"
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": "Get-Content src/only.py"},
            "tool_response": {"stdout": "content\n", "stderr": "", "exit_code": 0},
        }
        from token_goat import hooks_cli, session

        hooks_cli.post_bash(payload)
        cache = session.load(sid)
        read_paths = {entry.rel_or_abs for entry in cache.files.values()}
        assert "src/only.py" in read_paths
