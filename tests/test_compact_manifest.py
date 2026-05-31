"""Tests for new compact manifest sections: test failures, dep changes, session stats,
and the enhanced MUST_PRESERVE sealed block.
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

from token_goat import compact
from token_goat.compact import (
    _build_sealed_block,
    _extract_dep_changes,
    _extract_test_failures,
    _format_session_stats,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_bash_entry(
    cmd_preview: str,
    output_id: str,
    *,
    exit_code: int = 0,
    ts: float | None = None,
    stdout_bytes: int = 5000,
) -> object:
    """Build a minimal BashEntry-like object for testing."""
    entry = MagicMock()
    entry.cmd_preview = cmd_preview
    entry.output_id = output_id
    entry.exit_code = exit_code
    entry.ts = ts if ts is not None else time.time()
    entry.stdout_bytes = stdout_bytes
    entry.stderr_bytes = 0
    entry.run_count = 1
    entry.truncated = False
    return entry


def _make_bash_history(*entries: object) -> dict:
    """Wrap entries into a cmd_sha → BashEntry dict."""
    return {str(i): e for i, e in enumerate(entries)}


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
        assert "7 hints suppressed" in result

    def test_all_fields_present(self):
        cache = self._make_cache(edited=2, bash=10, suppressed=4)
        result = _format_session_stats(cache)
        assert result is not None
        assert "2 edited" in result
        assert "10 bash" in result
        assert "4 hints suppressed" in result
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
