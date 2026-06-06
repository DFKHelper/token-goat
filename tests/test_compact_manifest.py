"""Tests for new compact manifest sections: test failures, dep changes, session stats,
and the enhanced MUST_PRESERVE sealed block.
"""
from __future__ import annotations

import subprocess
import time
from unittest.mock import MagicMock, patch

from compact_test_helpers import make_bash_entry as _make_bash_entry
from compact_test_helpers import make_bash_history as _make_bash_history

from token_goat import compact
from token_goat.compact import (
    _build_sealed_block,
    _extract_dep_changes,
    _extract_test_failures,
    _format_session_stats,
)

# ---------------------------------------------------------------------------
# _extract_test_failures
# ---------------------------------------------------------------------------

class TestExtractTestFailures:
    def test_empty_history_returns_empty(self):
        assert _extract_test_failures({}) == []

    def test_non_dict_history_returns_empty(self):
        assert _extract_test_failures(None) == []  # type: ignore[arg-type]
        assert _extract_test_failures([]) == []  # type: ignore[arg-type]

    def test_no_test_commands_returns_empty(self):
        hist = _make_bash_history(
            _make_bash_entry("git diff", "out-1"),
            _make_bash_entry("ruff check src/", "out-2"),
        )
        assert _extract_test_failures(hist) == []

    def test_extracts_failed_test_names(self):
        pytest_output = (
            "FAILED tests/test_auth.py::TestAuth::test_login - AssertionError\n"
            "FAILED tests/test_db.py::test_connect\n"
            "2 failed, 3 passed in 1.23s\n"
        )
        entry = _make_bash_entry("pytest tests/", "out-pytest", exit_code=1)
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = _extract_test_failures(hist)

        assert len(result) == 2
        assert "tests/test_auth.py::TestAuth::test_login" in result
        assert "tests/test_db.py::test_connect" in result

    def test_deduplicates_repeated_failures(self):
        pytest_output = (
            "FAILED tests/test_foo.py::test_a\n"
            "FAILED tests/test_foo.py::test_a\n"  # duplicate
        )
        entry = _make_bash_entry("uv run pytest", "out-1", exit_code=1)
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = _extract_test_failures(hist)

        assert result.count("tests/test_foo.py::test_a") == 1

    def test_caps_at_max_failures(self):
        lines = [f"FAILED tests/test_x.py::test_{i}\n" for i in range(20)]
        pytest_output = "".join(lines)
        entry = _make_bash_entry("pytest -v", "out-big", exit_code=1)
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = _extract_test_failures(hist)

        assert len(result) <= compact._MAX_TEST_FAILURES

    def test_handles_load_failure_gracefully(self):
        entry = _make_bash_entry("pytest tests/", "out-1", exit_code=1)
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", side_effect=OSError("disk error")):
            result = _extract_test_failures(hist)

        assert result == []

    def test_non_test_commands_ignored(self):
        output = "FAILED tests/test_foo.py::test_a\n"
        # "ruff check" is not a test runner
        entry = _make_bash_entry("ruff check src/", "out-ruff", exit_code=1)
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=output):
            result = _extract_test_failures(hist)

        assert result == []

    def test_uses_most_recent_run_first(self):
        old_output = "FAILED tests/test_old.py::test_old\n"
        new_output = "FAILED tests/test_new.py::test_new\n"
        old_entry = _make_bash_entry("pytest", "out-old", exit_code=1, ts=time.time() - 3600)
        new_entry = _make_bash_entry("pytest", "out-new", exit_code=1, ts=time.time())
        hist = _make_bash_history(old_entry, new_entry)

        def _load(oid: str) -> str:
            return new_output if oid == "out-new" else old_output

        with patch("token_goat.bash_cache.load_output", side_effect=_load):
            result = _extract_test_failures(hist)

        # The most-recent run's failures should appear first
        assert result[0] == "tests/test_new.py::test_new"


# ---------------------------------------------------------------------------
# _extract_dep_changes
# ---------------------------------------------------------------------------

class TestExtractDepChanges:
    def test_empty_history_returns_empty(self):
        assert _extract_dep_changes({}) == []

    def test_non_dict_returns_empty(self):
        assert _extract_dep_changes(None) == []  # type: ignore[arg-type]

    def test_no_dep_commands_returns_empty(self):
        hist = _make_bash_history(
            _make_bash_entry("pytest tests/", "out-1"),
        )
        assert _extract_dep_changes(hist) == []

    def test_extracts_pip_install_output(self):
        pip_output = (
            "Collecting requests==2.31.0\n"
            "Successfully installed requests-2.31.0 certifi-2024.1.0\n"
        )
        entry = _make_bash_entry("pip install requests==2.31.0", "out-pip")
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=pip_output):
            result = _extract_dep_changes(hist)

        assert len(result) > 0
        assert any("requests" in r.lower() for r in result)

    def test_extracts_uv_add_output(self):
        uv_output = (
            "Resolved 42 packages in 0.3s\n"
            "Downloaded 1 package in 1.2s\n"
            "Installed 1 package in 0.1s\n"
            " + requests==2.31.0\n"
        )
        entry = _make_bash_entry("uv add requests", "out-uv")
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=uv_output):
            result = _extract_dep_changes(hist)

        assert len(result) > 0
        assert any("requests" in r for r in result)

    def test_handles_load_failure_gracefully(self):
        entry = _make_bash_entry("pip install foo", "out-1")
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", side_effect=OSError("disk error")):
            result = _extract_dep_changes(hist)

        assert result == []

    def test_caps_at_max_dep_changes(self):
        # Generate many "Successfully installed ..." lines
        packages = [f"pkg{i}==1.{i}.0" for i in range(30)]
        pip_output = "Successfully installed " + " ".join(packages) + "\n"
        entry = _make_bash_entry("pip install -r req.txt", "out-big")
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=pip_output):
            result = _extract_dep_changes(hist)

        assert len(result) <= compact._MAX_DEP_CHANGES

    def test_deduplicates_lines(self):
        # Same line repeated in the same output
        pip_output = (
            "Successfully installed requests-2.31.0\n"
            "Successfully installed requests-2.31.0\n"  # duplicate
        )
        entry = _make_bash_entry("pip install requests", "out-1")
        hist = _make_bash_history(entry)

        with patch("token_goat.bash_cache.load_output", return_value=pip_output):
            result = _extract_dep_changes(hist)

        # Should not appear twice
        seen = set(result)
        assert len(result) == len(seen)


# ---------------------------------------------------------------------------
# _format_session_stats
# ---------------------------------------------------------------------------

class TestFormatSessionStats:
    def _make_cache(
        self,
        edited: int = 0,
        bash: int = 0,
        suppressed: int = 0,
    ) -> object:
        cache = MagicMock()
        # edited_files dict
        cache.edited_files = {f"file{i}.py": 1 for i in range(edited)}
        # bash_history dict
        cache.bash_history = {f"sha{i}": MagicMock() for i in range(bash)}
        # hints_suppressed_by_type dict
        cache.hints_suppressed_by_type = {"already_read": suppressed} if suppressed else {}
        return cache

    def test_all_zero_returns_none(self):
        cache = self._make_cache()
        assert _format_session_stats(cache) is None

    def test_edited_only(self):
        cache = self._make_cache(edited=3)
        result = _format_session_stats(cache)
        assert result is not None
        assert "3 edited" in result

    def test_bash_only(self):
        cache = self._make_cache(bash=5)
        result = _format_session_stats(cache)
        assert result is not None
        assert "5 bash" in result

    def test_suppressed_only(self):
        cache = self._make_cache(suppressed=7)
        result = _format_session_stats(cache)
        assert result is not None
        assert "7 suppressed" in result

    def test_all_fields_present(self):
        cache = self._make_cache(edited=2, bash=10, suppressed=4)
        result = _format_session_stats(cache)
        assert result is not None
        assert "2 edited" in result
        assert "10 bash" in result
        assert "4 suppressed" in result
        assert result.startswith("Stats:")

    def test_zero_fields_omitted(self):
        cache = self._make_cache(edited=2, bash=0, suppressed=0)
        result = _format_session_stats(cache)
        assert result is not None
        assert "bash" not in result
        assert "hints" not in result

    def test_handles_missing_attributes(self):
        # Legacy cache object with no attributes at all
        cache = object()
        result = _format_session_stats(cache)
        assert result is None


# ---------------------------------------------------------------------------
# Session stats appears in manifest
# ---------------------------------------------------------------------------

class TestSessionStatsInManifest:
    def test_stats_line_appears_in_manifest(self, tmp_data_dir, make_session):
        sid = "stats-manifest-1"
        make_session(
            sid,
            edits=2,
            bash_runs={"pytest tests/": (8000, 0), "ruff check src/": (5000, 0)},
        )
        result = compact.build_manifest(sid, max_tokens=600)
        assert "Stats:" in result

    def test_stats_line_shows_edited_count(self, tmp_data_dir, make_session):
        sid = "stats-manifest-2"
        make_session(sid, edits=3, bash_runs={"pytest": (8000, 0)})
        result = compact.build_manifest(sid, max_tokens=600)
        assert "3 edited" in result

    def test_stats_line_shows_bash_count(self, tmp_data_dir, make_session):
        sid = "stats-manifest-3"
        # bash_runs uses a dict so each unique cmd is one entry
        make_session(
            sid,
            edits=1,
            bash_runs={
                "pytest tests/": (8000, 0),
                "ruff check src/": (5000, 0),
            },
        )
        result = compact.build_manifest(sid, max_tokens=600)
        assert "2 bash" in result


# ---------------------------------------------------------------------------
# Recent Test Failures section in manifest
# ---------------------------------------------------------------------------

class TestTestFailuresInManifest:
    def test_section_appears_when_pytest_fails(self, tmp_data_dir, make_session):
        sid = "tf-manifest-1"
        make_session(sid, edits=1, bash_runs={"pytest tests/": (12000, 1)})

        pytest_output = (
            "FAILED tests/test_auth.py::TestAuth::test_login\n"
            "1 failed in 0.5s\n"
        )

        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "### Recent Test Failures" in result
        assert "tests/test_auth.py::TestAuth::test_login" in result

    def test_section_absent_when_no_failures(self, tmp_data_dir, make_session):
        sid = "tf-manifest-2"
        make_session(sid, edits=1, bash_runs={"pytest tests/": (8000, 0)})

        with patch("token_goat.bash_cache.load_output", return_value="3 passed in 0.3s\n"):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "### Recent Test Failures" not in result

    def test_multiple_failures_listed(self, tmp_data_dir, make_session):
        sid = "tf-manifest-3"
        make_session(sid, edits=1, bash_runs={"pytest tests/": (12000, 1)})

        pytest_output = (
            "FAILED tests/test_a.py::test_one\n"
            "FAILED tests/test_b.py::test_two\n"
            "FAILED tests/test_c.py::test_three\n"
            "3 failed in 1.0s\n"
        )

        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "tests/test_a.py::test_one" in result
        assert "tests/test_b.py::test_two" in result
        assert "tests/test_c.py::test_three" in result


# ---------------------------------------------------------------------------
# Dependency Changes section in manifest
# ---------------------------------------------------------------------------

class TestDepChangesInManifest:
    def test_section_appears_on_pip_install(self, tmp_data_dir, make_session):
        sid = "dc-manifest-1"
        make_session(sid, edits=1, bash_runs={"pip install requests": (3000, 0)})

        pip_output = "Successfully installed requests-2.31.0\n"

        with patch("token_goat.bash_cache.load_output", return_value=pip_output):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "### Dependency Changes" in result
        assert "requests" in result

    def test_section_absent_when_no_install(self, tmp_data_dir, make_session):
        sid = "dc-manifest-2"
        make_session(sid, edits=1, bash_runs={"pytest tests/": (8000, 0)})

        with patch("token_goat.bash_cache.load_output", return_value="3 passed\n"):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "### Dependency Changes" not in result


# ---------------------------------------------------------------------------
# Enhanced MUST_PRESERVE sealed block
# ---------------------------------------------------------------------------

class TestBuildSealedBlock:
    def test_fail_files_slot_added_when_test_failures_present(self):
        failures = ["tests/test_auth.py::TestAuth::test_login"]
        block = _build_sealed_block(
            edited_clean={},
            blocker_entries=[],
            raw_skills={},
            test_failure_names=failures,
            raw_bash={},
        )
        block_text = "\n".join(block)
        # Should include the basename of the failing test file
        assert "test_auth.py" in block_text

    def test_bash_cmds_slot_added_when_bash_history_present(self):
        entry = _make_bash_entry("uv run pytest tests/", "out-1", ts=time.time())
        raw_bash = _make_bash_history(entry)

        block = _build_sealed_block(
            edited_clean={"src/auth.py": 2},
            blocker_entries=[],
            raw_skills={},
            test_failure_names=[],
            raw_bash=raw_bash,
        )
        block_text = "\n".join(block)
        assert "uv run pytest" in block_text

    def test_both_new_slots_absent_when_no_data(self):
        block = _build_sealed_block(
            edited_clean={"src/auth.py": 1},
            blocker_entries=[],
            raw_skills={},
            test_failure_names=[],
            raw_bash={},
        )
        block_text = "\n".join(block)
        assert "❌" not in block_text
        assert "🕐" not in block_text

    def test_sealed_block_respects_token_cap(self):
        # Many failures + many bash commands: should not exceed 80 tokens
        failures = [f"tests/test_{i}.py::test_func" for i in range(10)]
        raw_bash = _make_bash_history(
            *[_make_bash_entry(f"pytest tests/test_{i}.py -v", f"out-{i}") for i in range(10)]
        )
        block = _build_sealed_block(
            edited_clean={"src/auth.py": 5, "src/db.py": 3, "src/models.py": 1},
            blocker_entries=[],
            raw_skills={},
            test_failure_names=failures,
            raw_bash=raw_bash,
        )
        from token_goat.compact import _token_count
        block_text = "\n".join(block)
        assert _token_count(block_text) <= 80

    def test_backward_compatible_without_new_params(self):
        # Old callers that don't pass the new params should still work
        block = _build_sealed_block(
            edited_clean={"src/auth.py": 2},
            blocker_entries=[],
            raw_skills={},
        )
        assert isinstance(block, list)
        # Should contain the MUST_PRESERVE structure
        block_text = "\n".join(block)
        assert "MUST_PRESERVE" in block_text

    def test_fail_files_deduplicates_basenames(self):
        # Two failures from the same file should only add one basename
        failures = [
            "tests/test_auth.py::TestAuth::test_login",
            "tests/test_auth.py::TestAuth::test_logout",
        ]
        block = _build_sealed_block(
            edited_clean={},
            blocker_entries=[],
            raw_skills={},
            test_failure_names=failures,
            raw_bash={},
        )
        # "test_auth.py" should appear exactly once in the fail_files_slot
        fail_line = next((ln for ln in block if ln.startswith("❌")), "")
        assert fail_line.count("test_auth.py") == 1

    def test_sealed_block_appears_in_full_manifest(self, tmp_data_dir, make_session):
        sid = "sealed-manifest-1"
        make_session(sid, edits=1, bash_runs={"pytest tests/": (12000, 1)})

        pytest_output = "FAILED tests/test_auth.py::test_x\n1 failed\n"

        with patch("token_goat.bash_cache.load_output", return_value=pytest_output):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "### MUST_PRESERVE" in result
        assert "<<preserve>>" in result


# ---------------------------------------------------------------------------
# _render_active_errors_section
# ---------------------------------------------------------------------------


class TestRenderActiveErrorsSection:
    """Tests for _render_active_errors_section function."""

    def test_empty_session_returns_empty(self):
        """Empty session (no errors) returns empty list."""
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=[]):
            result = compact._render_active_errors_section("sess-empty")
        assert result == []

    def test_no_errors_returns_empty(self):
        """When get_recent_error_outputs returns empty, section is omitted."""
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=[]):
            result = compact._render_active_errors_section("sess-no-errors", max_errors=3)
        assert result == []

    def test_single_error_rendered(self):
        """A single error is rendered with header and entry."""
        errors = [{"command": "pytest tests/", "error_summary": "AssertionError: expected 5"}]
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=errors):
            result = compact._render_active_errors_section("sess-one-error")

        assert len(result) >= 2
        assert result[0] == "### Active Errors"
        assert "pytest tests/" in result[1]
        assert "AssertionError" in result[1]

    def test_multiple_errors_rendered(self):
        """Multiple errors are rendered."""
        errors = [
            {"command": "pytest tests/", "error_summary": "AssertionError: expected 5"},
            {"command": "uv sync", "error_summary": "error: dependency conflict"},
            {"command": "make build", "error_summary": "Error: compilation failed"},
        ]
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=errors):
            result = compact._render_active_errors_section("sess-multi-errors", max_errors=3)

        assert len(result) >= 4
        assert result[0] == "### Active Errors"
        # All three errors should be present
        content = "\n".join(result)
        assert "pytest tests/" in content
        assert "uv sync" in content
        assert "make build" in content

    def test_respects_max_errors_limit(self):
        """Only up to max_errors entries are rendered."""
        errors = [
            {"command": f"cmd{i}", "error_summary": f"Error {i}"}
            for i in range(5)
        ]
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=errors):
            result = compact._render_active_errors_section("sess-limit", max_errors=2)

        # Should have header + up to 2 entries
        assert len(result) <= 3

    def test_handles_cache_exception_gracefully(self):
        """Exception from bash_cache is caught and returns empty (fail-soft)."""
        with patch("token_goat.bash_cache.get_recent_error_outputs", side_effect=OSError("cache error")):
            result = compact._render_active_errors_section("sess-error")
        assert result == []

    def test_command_truncated_in_output(self):
        """Commands are sanitized and truncated."""
        long_cmd = "very_long_command_that_exceeds_max_length_" + "X" * 100
        errors = [{"command": long_cmd, "error_summary": "Error occurred"}]
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=errors):
            result = compact._render_active_errors_section("sess-truncate")

        # The section should still render but command should be truncated in output
        assert len(result) >= 2
        # The actual output command should be <= 80 chars due to sanitization
        assert "Very_long_command" in result[1] or "X" * 50 not in result[1]

    def test_error_summary_truncated_in_output(self):
        """Error summary is sanitized and truncated."""
        long_summary = "Error: " + "X" * 150
        errors = [{"command": "cmd", "error_summary": long_summary}]
        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=errors):
            result = compact._render_active_errors_section("sess-summary-trunc")

        assert len(result) >= 2
        # Summary should be present but possibly truncated by sanitization
        assert "cmd" in result[1]

    def test_manifest_integration_includes_active_errors(self, tmp_data_dir, make_session):
        """Active Errors section appears in full manifest when there are errors."""
        sid = "sess-with-errors"
        make_session(sid, edits=1)

        # Mock bash_cache to return errors
        error_outputs = [
            {"command": "pytest tests/", "error_summary": "FAILED tests/test_foo.py::test_bar"}
        ]

        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=error_outputs):
            result = compact.build_manifest(sid, max_tokens=600)

        # Manifest should contain the Active Errors section
        assert "### Active Errors" in result
        assert "pytest tests/" in result

    def test_manifest_omits_errors_when_none(self, tmp_data_dir, make_session):
        """Active Errors section is omitted when there are no errors."""
        sid = "sess-no-errors-manifest"
        make_session(sid, edits=1)

        with patch("token_goat.bash_cache.get_recent_error_outputs", return_value=[]):
            result = compact.build_manifest(sid, max_tokens=600)

        # Manifest should NOT contain the Active Errors section
        assert "### Active Errors" not in result


# ---------------------------------------------------------------------------
# Improvement A: Recent Branch Commits (pre-session git context)
# ---------------------------------------------------------------------------


class TestRecentBranchCommits:
    """Tests for the "Recent Branch Commits" section added in item #38.

    The section fires when the session has fewer than 2 commits AND the session
    is not "young" (>= 10 min old), providing pre-session branch context.
    """

    def test_recent_branch_commits_shown_for_read_only_session(self, tmp_data_dir):
        """Section is shown for a read-only session (no edits, 0 session commits)."""
        from token_goat import session

        sid = "sess-read-only-branch-ctx"
        # Read-only session: file read first, then set cwd/age on loaded cache.
        # This order ensures the CAS merge doesn't overwrite created_ts.
        session.mark_file_read(sid, "/some/repo/src/main.py", offset=0, limit=100)
        cache = session.load(sid)
        cache.cwd = "/some/repo"
        cache.created_ts = time.time() - 3600  # 1 hour old
        session.save(cache)

        branch_commits = ["abc1234 feat: add user auth", "def5678 fix: null pointer bug"]
        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=True),
            patch(
                "token_goat.compact._get_recent_commits_for_orchestrator",
                return_value=branch_commits,
            ),
        ):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "Recent Branch Commits" in result
        assert "abc1234" in result
        assert "feat: add user auth" in result

    def test_recent_branch_commits_shown_when_session_has_zero_commits(self, tmp_data_dir):
        """Section appears when session has edits but 0 commits so far."""
        from token_goat import session

        sid = "sess-zero-commits-branch-ctx"
        # Mark edit first, then load and set cwd/age to avoid CAS merge overwriting
        session.mark_file_edited(sid, "/proj/src/app.py")
        cache = session.load(sid)
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 1800  # 30 min old
        session.save(cache)

        branch_commits = ["xyz9999 refactor: clean up imports"]
        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=True),
            patch(
                "token_goat.compact._get_recent_commits_for_orchestrator",
                return_value=branch_commits,
            ),
        ):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "Recent Branch Commits" in result
        assert "xyz9999" in result

    def test_recent_branch_commits_suppressed_when_session_has_two_or_more_commits(
        self, tmp_data_dir
    ):
        """Section is suppressed when session already has >= 2 commits (ample context)."""
        from token_goat import session

        sid = "sess-many-commits-no-branch"
        session.mark_file_edited(sid, "/proj/src/app.py")
        cache = session.load(sid)
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 3600  # 1 hour old — not young
        session.save(cache)

        session_commits = ["aaa1111 feat: first change", "bbb2222 fix: follow-up"]
        with (
            patch("token_goat.compact._get_session_commits", return_value=session_commits),
            patch("token_goat.compact._is_git_repo", return_value=True),
            patch(
                "token_goat.compact._get_recent_commits_for_orchestrator",
                return_value=["ccc3333 chore: old work"],
            ),
        ):
            result = compact.build_manifest(sid, max_tokens=600)

        # Session has 2 commits — branch section should be suppressed
        assert "Recent Branch Commits" not in result
        # But session commits should still appear
        assert "Commits This Session" in result
        assert "aaa1111" in result

    def test_recent_branch_commits_suppressed_for_young_session(self, tmp_data_dir):
        """Section is suppressed for young sessions (< 10 min old)."""
        from token_goat import session

        sid = "sess-young-no-branch-ctx"
        # Mark file read first, then set cwd/age
        session.mark_file_read(sid, "/proj/src/main.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 60  # only 1 min old — "young"
        session.save(cache)

        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=True),
            patch(
                "token_goat.compact._get_recent_commits_for_orchestrator",
                return_value=["abc1234 some work"],
            ),
        ):
            result = compact.build_manifest(sid, max_tokens=600)

        # Young session — branch context suppressed
        assert "Recent Branch Commits" not in result

    def test_recent_branch_commits_suppressed_when_not_git_repo(self, tmp_data_dir):
        """Section is suppressed when cwd is not a git repo."""
        from token_goat import session

        sid = "sess-no-git-branch-ctx"
        # Mark file read first, then set cwd/age
        session.mark_file_read(sid, "/some/non-git-dir/file.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = "/some/non-git-dir"
        cache.created_ts = time.time() - 3600
        session.save(cache)

        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=False),
            patch(
                "token_goat.compact._get_recent_commits_for_orchestrator",
                return_value=["abc1234 some work"],
            ) as mock_get,
        ):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "Recent Branch Commits" not in result
        mock_get.assert_not_called()


# ---------------------------------------------------------------------------
# Improvement B: Symbol-enriched Key Files entries (item #37)
# ---------------------------------------------------------------------------


class TestSymbolEnrichedKeyFiles:
    """Tests for inline symbol annotations on 3+ read files in 'Key Files Read'.

    Item #37: Files read 3+ times that have accessed symbols get those symbols
    annotated inline on the Files entry when their symbol lines were suppressed
    from the Symbols Accessed section (item #8 suppression).
    """

    def test_frequently_read_file_gets_inline_symbols(self, tmp_data_dir):
        """A file read 3+ times with accessed symbols shows top symbols inline."""
        from token_goat import session

        sid = "sess-symbol-enriched-files"
        # Read a file 4 times to qualify as "frequently read"
        for _ in range(4):
            session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=100)
        # Mark symbols accessed on that file (symbol reads record in symbols_read)
        session.mark_file_read(sid, "/proj/src/auth.py", symbol="login")
        session.mark_file_read(sid, "/proj/src/auth.py", symbol="logout")
        # Load after all marks to get the merged state, then set cwd/age
        cache = session.load(sid)
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 1800
        session.save(cache)

        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=False),
        ):
            result = compact.build_manifest(sid, max_tokens=800)

        # The Files section should show auth.py with inline symbols
        assert "auth.py" in result
        # Symbols should appear (either in Files or Symbols Accessed section)
        assert "login" in result
        assert "logout" in result

    def test_file_read_twice_does_not_get_inline_symbols(self, tmp_data_dir):
        """Files read only 1-2 times do NOT get symbol annotations in Files section.

        Note: both full-file reads and symbol reads increment read_count.  This test
        uses a single full-file read plus a single symbol read (total = 2 reads) so
        the file stays below the 3-read threshold for symbol enrichment.
        """
        import re

        from token_goat import session

        sid = "sess-low-read-no-syms"
        # One full-file read + one symbol read = read_count 2 (below the 3-read threshold)
        session.mark_file_read(sid, "/proj/src/utils.py", offset=0, limit=100)
        session.mark_file_read(sid, "/proj/src/utils.py", symbol="helper_fn")
        cache = session.load(sid)
        # Verify read_count is actually 2
        entry = cache.files.get(list(cache.files.keys())[0])
        assert entry is not None
        assert entry.read_count == 2, f"Expected read_count=2, got {entry.read_count}"
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 1800
        session.save(cache)

        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=False),
        ):
            result = compact.build_manifest(sid, max_tokens=800)

        # If utils.py appears in the Files section, it should NOT have a symbol annotation
        if "utils.py" in result:
            files_match = re.search(r"- → .*utils\.py[^\n]*", result)
            if files_match:
                line = files_match.group(0)
                # A file with only 2 reads should not have read count annotation
                assert "(read " not in line, f"2-read file should not show read count: {line!r}"
                # And should not have inline symbol ": helper_fn"
                assert ": helper_fn" not in line, f"2-read file should not show inline syms: {line!r}"

    def test_inline_symbols_capped_at_three(self, tmp_data_dir):
        """Inline symbol annotations are capped at 3 symbols per file."""
        import re

        from token_goat import session

        sid = "sess-symbol-cap-test"
        # 2 full-file reads + 5 symbol reads = 7 total reads (well above 3-read threshold)
        for _ in range(2):
            session.mark_file_read(sid, "/proj/src/models.py", offset=0, limit=100)
        # Add 5 symbols — should be capped at 3 in inline annotation
        for sym in ["ModelA", "ModelB", "ModelC", "ModelD", "ModelE"]:
            session.mark_file_read(sid, "/proj/src/models.py", symbol=sym)

        cache = session.load(sid)
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 1800
        session.save(cache)

        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=False),
        ):
            result = compact.build_manifest(sid, max_tokens=800)

        # Find the models.py entry and count inline symbols
        models_match = re.search(r"- → .*models\.py[^\n]*", result)
        if models_match:
            line = models_match.group(0)
            if ": " in line:
                # Count commas in the symbol list (cap: 3 symbols = at most 2 commas)
                sym_part = line.split(": ", 1)[1] if ": " in line else ""
                comma_count = sym_part.count(",")
                assert comma_count <= 2, (
                    f"Expected at most 2 commas (3 symbols max) but got {comma_count}: {line!r}"
                )


# ---------------------------------------------------------------------------
# Edge cases: _get_session_commits git timeout and empty repo
# ---------------------------------------------------------------------------


class TestGetSessionCommitsEdgeCases:
    """Edge cases for _get_session_commits: timeout, empty repo, None cwd."""

    def test_git_command_timeout_returns_empty(self, monkeypatch):
        """_get_session_commits returns [] when _run_git raises TimeoutExpired."""
        def _raise_timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(["git"], 2)

        monkeypatch.setattr("token_goat.compact._util_run_git", _raise_timeout)
        result = compact._get_session_commits("/some/repo", time.time() - 3600)
        assert result == [], f"Expected [] on TimeoutExpired, got {result!r}"

    def test_git_oserror_returns_empty(self, monkeypatch):
        """_get_session_commits returns [] when git is not on PATH (OSError)."""
        def _raise_oserror(*args, **kwargs):
            raise OSError("git: command not found")

        monkeypatch.setattr("token_goat.compact._util_run_git", _raise_oserror)
        result = compact._get_session_commits("/some/repo", time.time() - 3600)
        assert result == [], f"Expected [] on OSError, got {result!r}"

    def test_zero_session_start_ts_returns_empty(self):
        """_get_session_commits returns [] when session_start_ts is 0 (invalid)."""
        # No git call should be made; guard fires immediately.
        result = compact._get_session_commits("/some/valid/path", 0.0)
        assert result == []

    def test_none_cwd_returns_empty(self):
        """_get_session_commits returns [] when cwd is None."""
        result = compact._get_session_commits(None, time.time() - 3600)
        assert result == []


# ---------------------------------------------------------------------------
# Edge cases: build_manifest with zero files read but cwd set
# ---------------------------------------------------------------------------


class TestBuildManifestZeroFilesRead:
    """build_manifest edge cases when session has cwd but no activity."""

    def test_session_with_cwd_but_no_files_returns_empty(self, tmp_data_dir):
        """A session where only cwd is set (no reads, edits, greps) returns ''."""
        from token_goat import session

        sid = "sess-cwd-only-no-files"
        cache = session.load(sid)
        cache.cwd = "/some/project"
        cache.created_ts = time.time() - 1800
        session.save(cache)

        # Even with cwd set, a session with zero activity should return empty manifest.
        result = compact.build_manifest(sid, max_tokens=800)
        assert result == "", f"Expected empty manifest for zero-activity session, got:\n{result}"

    def test_recent_branch_commits_section_absent_when_orchestrator_returns_empty(
        self, tmp_data_dir
    ):
        """Recent Branch Commits section is absent when _get_recent_commits_for_orchestrator
        returns [] even for a mature non-young session with file reads."""
        from token_goat import session

        sid = "sess-empty-branch-commits"
        session.mark_file_read(sid, "/proj/src/main.py", offset=0, limit=100)
        cache = session.load(sid)
        cache.cwd = "/proj"
        cache.created_ts = time.time() - 3600  # mature session
        session.save(cache)

        with (
            patch("token_goat.compact._get_session_commits", return_value=[]),
            patch("token_goat.compact._is_git_repo", return_value=True),
            patch(
                "token_goat.compact._get_recent_commits_for_orchestrator",
                return_value=[],  # git returns nothing (e.g., brand-new repo, no commits)
            ),
        ):
            result = compact.build_manifest(sid, max_tokens=600)

        # No branch commits returned → section must be absent
        assert "Recent Branch Commits" not in result

    def test_build_manifest_does_not_crash_with_nonexistent_cwd(self, tmp_data_dir):
        """build_manifest is fail-soft when cwd points to a non-existent directory."""
        from token_goat import session

        sid = "sess-nonexistent-cwd"
        session.mark_file_read(sid, "/nonexistent/dir/file.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = "/nonexistent/dir/that/does/not/exist"
        cache.created_ts = time.time() - 1800
        session.save(cache)

        # Must not raise; git calls will fail gracefully and return None/[].
        result = compact.build_manifest(sid, max_tokens=600)
        assert isinstance(result, str), "build_manifest must always return a string"


# ---------------------------------------------------------------------------
# Manifest header: git branch name
# ---------------------------------------------------------------------------


class TestManifestBranchHeader:
    """Verify the manifest header includes 'branch: <name>' when on a named branch."""

    def test_branch_line_included_when_on_named_branch(self, tmp_data_dir):
        """Manifest header contains 'branch: main' when git reports 'main'."""
        from token_goat import session

        sid = "sess-branch-main"
        session.mark_file_read(sid, "src/token_goat/cli.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = "/some/project"
        cache.created_ts = time.time() - 600
        session.save(cache)

        with patch("token_goat.compact._get_current_branch", return_value="main"):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "branch: main" in result

    def test_branch_line_included_for_feature_branch(self, tmp_data_dir):
        """Manifest header contains the feature branch name, not just 'main'."""
        from token_goat import session

        sid = "sess-branch-feature"
        session.mark_file_read(sid, "src/token_goat/cli.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = "/some/project"
        cache.created_ts = time.time() - 600
        session.save(cache)

        with patch("token_goat.compact._get_current_branch", return_value="feat/add-recent-reads"):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "branch: feat/add-recent-reads" in result

    def test_branch_line_absent_on_detached_head(self, tmp_data_dir):
        """Manifest header omits the branch line when _get_current_branch returns None."""
        from token_goat import session

        sid = "sess-branch-detached"
        session.mark_file_read(sid, "src/token_goat/cli.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = "/some/project"
        cache.created_ts = time.time() - 600
        session.save(cache)

        with patch("token_goat.compact._get_current_branch", return_value=None):
            result = compact.build_manifest(sid, max_tokens=600)

        assert "branch:" not in result

    def test_branch_line_absent_when_no_cwd(self, tmp_data_dir):
        """Manifest header omits branch when cache has no cwd."""
        from token_goat import session

        sid = "sess-branch-no-cwd"
        session.mark_file_read(sid, "src/token_goat/cli.py", offset=0, limit=50)
        cache = session.load(sid)
        cache.cwd = None
        cache.created_ts = time.time() - 600
        session.save(cache)

        # _get_current_branch should not be called with None
        with patch("token_goat.compact._get_current_branch") as mock_branch:
            result = compact.build_manifest(sid, max_tokens=600)

        mock_branch.assert_not_called()
        assert "branch:" not in result


# ---------------------------------------------------------------------------
# _get_current_branch unit tests
# ---------------------------------------------------------------------------


class TestGetCurrentBranch:
    """Unit tests for _get_current_branch."""

    def test_returns_branch_name(self):
        from token_goat.compact import _get_current_branch

        with patch("token_goat.compact._run_git", return_value="main\n"):
            result = _get_current_branch("/some/repo")

        assert result == "main"

    def test_returns_feature_branch_name(self):
        from token_goat.compact import _get_current_branch

        with patch("token_goat.compact._run_git", return_value="feat/my-feature\n"):
            result = _get_current_branch("/some/repo")

        assert result == "feat/my-feature"

    def test_returns_none_on_detached_head(self):
        """git symbolic-ref exits non-zero on detached HEAD; _run_git returns None."""
        from token_goat.compact import _get_current_branch

        with patch("token_goat.compact._run_git", return_value=None):
            result = _get_current_branch("/some/repo")

        assert result is None

    def test_returns_none_when_no_repo_root(self):
        from token_goat.compact import _get_current_branch

        result = _get_current_branch(None)
        assert result is None

    def test_returns_none_on_empty_output(self):
        """Empty string output (edge case) yields None rather than empty string."""
        from token_goat.compact import _get_current_branch

        with patch("token_goat.compact._run_git", return_value=""):
            result = _get_current_branch("/some/repo")

        assert result is None

    def test_strips_trailing_newline(self):
        from token_goat.compact import _get_current_branch

        with patch("token_goat.compact._run_git", return_value="develop\n"):
            result = _get_current_branch("/some/repo")

        assert result == "develop"
