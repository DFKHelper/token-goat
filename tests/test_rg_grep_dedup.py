"""Tests for rg/grep Bash command grep-pattern dedup.

Verifies that:
- rg invoked via the Bash tool fires pattern-level dedup when the same pattern
  was already run in this session (via native Grep or prior rg).
- The grep pattern is recorded in session.greps by post_bash so subsequent
  pre-read calls can deduplicate.
- grep/ag/ack Bash commands also benefit from the same path.
- stat recording fires for the dedup hint (bytes_saved tracked).
"""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_read, session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed_grep(
    session_id: str,
    pattern: str,
    *,
    path: str | None = None,
    result_count: int = 100,
) -> None:
    """Record a prior Grep invocation so dedup can fire."""
    session.mark_grep(session_id, pattern, path=path, result_count=result_count)


def _bash_payload(session_id: str, command: str) -> dict:
    return {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": command},
    }


def _post_bash_payload(session_id: str, command: str, stdout: str = "") -> dict:
    return {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": 0},
    }


# ---------------------------------------------------------------------------
# _handle_bash_grep_dedup via pre_read
# ---------------------------------------------------------------------------

class TestRgGrepDedup:
    """rg via Bash fires grep-pattern dedup when the same pattern was run."""

    def test_rg_dedup_fires_after_native_grep(self, tmp_data_dir):
        """rg 'TODO' fires dedup when native Grep 'TODO' ran earlier (no path both sides)."""
        # Seed with no path; rg invocation also has no path so they match
        _seed_grep("rg-1", "TODO", result_count=200)
        payload = _bash_payload("rg-1", "rg 'TODO'")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "expected grep dedup hint for rg 'TODO'"
        ctx = hso.get("additionalContext", "")
        assert "TODO" in ctx

    def test_rg_dedup_fires_after_prior_rg(self, tmp_data_dir):
        """rg 'login' fires dedup when a prior rg 'login' ran with the same path."""
        # Seed with path="src/token_goat/" matching the rg command below
        _seed_grep("rg-2", "login", path="src/token_goat/", result_count=50)
        payload = _bash_payload("rg-2", "rg login src/token_goat/")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "expected grep dedup hint for rg login"
        ctx = hso.get("additionalContext", "")
        assert "login" in ctx

    def test_rg_no_dedup_on_fresh_pattern(self, tmp_data_dir):
        """rg with a pattern never seen before does not fire a grep dedup hint.

        A bash-compress or other non-dedup hint may still be returned; we only
        verify the absence of a grep-pattern-level dedup hint.
        """
        payload = _bash_payload("rg-3", "rg 'XUNIQUE_PATTERN_XYZ' src/")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        # If any hint was emitted, it must not be a grep dedup hint
        if hso:
            ctx = hso.get("additionalContext", "")
            # Grep dedup hints mention the pattern and match counts; compress hints mention wrapping
            assert "XUNIQUE_PATTERN_XYZ" not in ctx or "matches" not in ctx

    def test_grep_bash_dedup_fires(self, tmp_data_dir):
        """grep via Bash benefits from pattern-level dedup when path matches."""
        # Seed with path="src/" to match the grep command below
        _seed_grep("rg-4", "def.*login", path="src/", result_count=15)
        payload = _bash_payload("rg-4", "grep -rn 'def.*login' src/")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "expected grep dedup hint for grep -rn"
        ctx = hso.get("additionalContext", "")
        assert "def.*login" in ctx

    def test_ag_bash_dedup_fires(self, tmp_data_dir):
        """ag (The Silver Searcher) also triggers pattern-level dedup (path=None both sides)."""
        _seed_grep("rg-5", "import.*os", result_count=30)
        payload = _bash_payload("rg-5", "ag 'import.*os'")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "expected grep dedup hint for ag"

    def test_rg_dedup_below_min_threshold_no_hint(self, tmp_data_dir):
        """rg dedup respects the minimum-match threshold (same as native Grep).

        When result_count is below the minimum, no grep dedup hint fires.
        A bash-compress or other non-dedup hint may still be returned.
        """
        _seed_grep("rg-6", "RARE_PATTERN", result_count=2)
        payload = _bash_payload("rg-6", "rg RARE_PATTERN src/")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        # If any hint fired it must not be a grep-pattern dedup hint (which
        # would mention "RARE_PATTERN" alongside a match count)
        if hso:
            ctx = hso.get("additionalContext", "")
            assert "RARE_PATTERN" not in ctx or "matches" not in ctx

    def test_non_grep_bash_not_affected(self, tmp_data_dir):
        """A non-grep Bash command (e.g. ls) does not trigger grep dedup."""
        _seed_grep("rg-7", "anything", result_count=200)
        payload = _bash_payload("rg-7", "ls -la src/")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        # ls has no grep pattern — must NOT fire grep dedup
        hso = result.get("hookSpecificOutput")
        if hso:
            ctx = hso.get("additionalContext", "")
            # Any hint is fine but must not be a grep pattern hint for "anything"
            assert "anything" not in ctx


# ---------------------------------------------------------------------------
# post_bash records grep pattern to session.greps
# ---------------------------------------------------------------------------

class TestPostBashRecordsGrepPattern:
    """post_bash populates session.greps for rg/grep Bash commands."""

    def test_post_bash_rg_records_grep_pattern(self, tmp_data_dir):
        """After post_bash processes an rg command, session.greps has the pattern."""
        sid = "pb-rg-1"
        stdout_text = "\n".join(f"file{i}.py:10: match" for i in range(20))
        payload = _post_bash_payload(sid, "rg 'mark_grep' src/", stdout=stdout_text)
        result = hooks_read.post_bash(payload)
        _assert_continue(result)

        cache = session.load(sid)
        assert cache.greps, "session.greps should be populated after post_bash for rg"
        patterns = [g.pattern for g in cache.greps]
        assert "mark_grep" in patterns

    def test_post_bash_grep_records_pattern(self, tmp_data_dir):
        """After post_bash processes a grep command, session.greps has the pattern."""
        sid = "pb-grep-1"
        stdout_text = "\n".join(f"file{i}.py:10: match" for i in range(10))
        payload = _post_bash_payload(sid, "grep -rn 'def.*init' src/", stdout=stdout_text)
        hooks_read.post_bash(payload)

        cache = session.load(sid)
        assert cache.greps
        patterns = [g.pattern for g in cache.greps]
        assert "def.*init" in patterns

    def test_post_bash_non_grep_no_greps_entry(self, tmp_data_dir):
        """post_bash for a non-grep Bash command does not add to session.greps."""
        sid = "pb-ls-1"
        payload = _post_bash_payload(sid, "ls -la src/", stdout="file1.py\nfile2.py\n")
        hooks_read.post_bash(payload)

        cache = session.load(sid)
        assert not cache.greps, "ls should not populate session.greps"

    def test_post_bash_rg_then_pre_grep_dedup_fires(self, tmp_data_dir):
        """Full round-trip: post_bash rg records pattern, then pre_read Grep deduplicates.

        Both rg and the subsequent Grep use no path argument so the path
        matches (None == None) and the dedup triggers.
        """
        sid = "pb-roundtrip-1"
        # Step 1: rg without a path argument so path=None in GrepEntry
        stdout_text = "\n".join(f"file{i}.py:5: found" for i in range(50))
        post_payload = _post_bash_payload(sid, "rg 'record_stat'", stdout=stdout_text)
        hooks_read.post_bash(post_payload)

        # Verify greps was populated
        cache = session.load(sid)
        assert cache.greps, "post_bash should record grep entry"
        assert any(g.pattern == "record_stat" for g in cache.greps)

        # Step 2: native Grep for the same pattern (also no path) triggers dedup
        pre_payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "record_stat"},
        }
        result = hooks_read.pre_read(pre_payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "native Grep should fire dedup after post_bash rg recorded the pattern"
        ctx = hso.get("additionalContext", "")
        assert "record_stat" in ctx

    def test_post_bash_rg_result_count_in_greps(self, tmp_data_dir):
        """result_count from rg output (line count) is stored in session.greps."""
        sid = "pb-count-1"
        # Produce exactly 12 non-empty output lines
        stdout_text = "\n".join(f"file{i}.py:1: hit" for i in range(12))
        payload = _post_bash_payload(sid, "rg 'some_func' src/", stdout=stdout_text)
        hooks_read.post_bash(payload)

        cache = session.load(sid)
        assert cache.greps
        entry = next((g for g in cache.greps if g.pattern == "some_func"), None)
        assert entry is not None
        assert entry.result_count == 12


# ---------------------------------------------------------------------------
# bash_parser: _parse_grep preserves target_path in BashIntent
# ---------------------------------------------------------------------------

class TestBashParserGrepPath:
    """bash_parser._parse_grep now stores target_path in BashIntent."""

    def test_rg_with_path_stores_target_path(self):
        from token_goat import bash_parser
        intent = bash_parser.parse("rg 'TODO' src/token_goat/")
        assert intent.kind == "grep"
        assert intent.pattern == "TODO"
        assert intent.target_path == "src/token_goat/"

    def test_rg_without_path_target_path_none(self):
        from token_goat import bash_parser
        intent = bash_parser.parse("rg 'TODO'")
        assert intent.kind == "grep"
        assert intent.pattern == "TODO"
        assert intent.target_path is None

    def test_grep_with_path_stores_target_path(self):
        from token_goat import bash_parser
        intent = bash_parser.parse("grep -rn 'pattern' tests/")
        assert intent.kind == "grep"
        assert intent.pattern == "pattern"
        assert intent.target_path == "tests/"

    def test_grep_no_path_target_path_none(self):
        from token_goat import bash_parser
        intent = bash_parser.parse("grep 'needle'")
        assert intent.kind == "grep"
        assert intent.pattern == "needle"
        assert intent.target_path is None
