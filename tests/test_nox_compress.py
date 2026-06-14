"""Tests for NoxFilter — Python nox task-automation output compression."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _compress
from filter_test_helpers import savings_ratio as _savings_ratio

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Realistic nox output samples
# ---------------------------------------------------------------------------

_NOX_FULL_RUN = """\
nox > Running session tests-3.12
nox > Creating virtual environment (virtualenv) using python3.12 in .nox/tests-3-12
nox > python -m pip install pytest pytest-cov httpx
Collecting pytest
  Downloading pytest-8.1.1-py3-none-any.whl (343 kB)
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 343.3/343.3 kB 3.7 MB/s eta 0:00:00
Collecting pytest-cov
  Downloading pytest_cov-5.0.0-py3-none-any.whl (21 kB)
Collecting httpx
  Downloading httpx-0.27.0-py3-none-any.whl (75 kB)
Installing collected packages: pytest, pytest-cov, httpx
Successfully installed httpx-0.27.0 pytest-8.1.1 pytest-cov-5.0.0
nox > python -m pytest tests/
============================= test session starts ==============================
collected 22 items

tests/test_api.py ..............
tests/test_models.py ........

============================== 22 passed in 1.23s ==============================
nox > Session tests-3.12 was successful.

nox > Running session tests-3.11
nox > Creating virtual environment (virtualenv) using python3.11 in .nox/tests-3-11
nox > python -m pip install pytest pytest-cov httpx
Collecting pytest
  Using cached pytest-8.1.1-py3-none-any.whl (343 kB)
Collecting pytest-cov
  Using cached pytest_cov-5.0.0-py3-none-any.whl (21 kB)
Collecting httpx
  Using cached httpx-0.27.0-py3-none-any.whl (75 kB)
Installing collected packages: pytest, pytest-cov, httpx
Successfully installed httpx-0.27.0 pytest-8.1.1 pytest-cov-5.0.0
nox > python -m pytest tests/
============================= test session starts ==============================
collected 22 items

tests/test_api.py ..............
tests/test_models.py ........

============================== 22 passed in 1.31s ==============================
nox > Session tests-3.11 was successful.

nox > Running session lint
nox > Creating virtual environment (virtualenv) using python3.12 in .nox/lint
nox > python -m pip install ruff
Collecting ruff
  Downloading ruff-0.4.4-cp312-cp312-linux_x86_64.whl (6.8 MB)
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 6.8/6.8 MB 9.1 MB/s eta 0:00:00
Installing collected packages: ruff
Successfully installed ruff-0.4.4
nox > python -m ruff check src/
All checks passed!
nox > Session lint was successful.

nox > Ran multiple sessions:
nox > * tests-3.12: Passed
nox > * tests-3.11: Passed
nox > * lint: Passed
"""

_NOX_REUSE_VENV_RUN = """\
nox > Running session tests-3.12
nox > Re-using existing virtual environment at .nox/tests-3-12.
nox > python -m pip install pytest pytest-cov httpx
Requirement already satisfied: pytest in .nox/tests-3-12/lib/python3.12/site-packages (8.1.1)
Requirement already satisfied: pytest-cov in .nox/tests-3-12/lib/python3.12/site-packages (5.0.0)
Requirement already satisfied: httpx in .nox/tests-3-12/lib/python3.12/site-packages (0.27.0)
nox > python -m pytest tests/
============================= test session starts ==============================
collected 22 items

.......................

============================== 22 passed in 0.95s ==============================
nox > Session tests-3.12 was successful.
"""

_NOX_FAILURE_RUN = """\
nox > Running session tests-3.12
nox > Creating virtual environment (virtualenv) using python3.12 in .nox/tests-3-12
nox > python -m pip install pytest
Collecting pytest
  Downloading pytest-8.1.1-py3-none-any.whl (343 kB)
Installing collected packages: pytest
Successfully installed pytest-8.1.1
nox > python -m pytest tests/
============================= test session starts ==============================
collected 5 items

FAILED tests/test_api.py::test_broken - AssertionError: expected 200 got 404
============================== 1 failed, 4 passed in 0.44s ==============================
nox > Session tests-3.12 failed with exit code 1.

nox > Ran multiple sessions:
nox > * tests-3.12: Failed
"""


# ---------------------------------------------------------------------------
# Registration / dispatch
# ---------------------------------------------------------------------------

class TestNoxFilterRegistration:
    """Verify NoxFilter is exported and wired into the dispatch table."""

    def test_exported_in_all(self) -> None:
        assert "NoxFilter" in bc.__all__

    def test_dispatch_nox(self) -> None:
        f = bc.select_filter(["nox"])
        assert f is not None
        assert f.name == "nox"

    def test_dispatch_nox_with_session_flag(self) -> None:
        f = bc.select_filter(["nox", "-s", "tests"])
        assert f is not None
        assert f.name == "nox"

    def test_dispatch_nox_full_path(self) -> None:
        f = bc.select_filter(["/usr/local/bin/nox"])
        assert f is not None
        assert f.name == "nox"

    def test_dispatch_python_m_nox(self) -> None:
        f = bc.select_filter(["python", "-m", "nox"])
        assert f is not None
        assert f.name == "nox"

    def test_dispatch_python3_m_nox(self) -> None:
        f = bc.select_filter(["python3", "-m", "nox"])
        assert f is not None
        assert f.name == "nox"

    def test_no_dispatch_tox(self) -> None:
        f = bc.select_filter(["tox"])
        assert f is None or f.name != "nox"

    def test_no_dispatch_pytest(self) -> None:
        f = bc.select_filter(["pytest"])
        assert f is None or f.name != "nox"


# ---------------------------------------------------------------------------
# matches()
# ---------------------------------------------------------------------------

class TestNoxFilterMatches:
    F = bc.NoxFilter()

    def test_matches_nox(self) -> None:
        assert self.F.matches(["nox"])

    def test_matches_nox_with_args(self) -> None:
        assert self.F.matches(["nox", "-s", "tests", "lint"])

    def test_no_match_tox(self) -> None:
        assert not self.F.matches(["tox"])

    def test_no_match_pytest(self) -> None:
        assert not self.F.matches(["pytest"])

    def test_no_match_empty(self) -> None:
        assert not self.F.matches([])


# ---------------------------------------------------------------------------
# Env create / reuse noise collapsed
# ---------------------------------------------------------------------------

class TestNoxEnvNoise:
    F = bc.NoxFilter()

    def test_collapses_create_venv(self) -> None:
        text = (
            "nox > Running session tests-3.12\n"
            "nox > Creating virtual environment (virtualenv) using python3.12 in .nox/tests-3-12\n"
            "nox > python -m pytest tests/\n"
            "nox > Session tests-3.12 was successful.\n"
        )
        result = _compress(self.F, text)
        assert "Creating virtual environment" not in result
        assert "Running session tests-3.12" in result
        assert "Session tests-3.12 was successful." in result

    def test_collapses_reuse_venv(self) -> None:
        text = (
            "nox > Running session tests-3.12\n"
            "nox > Re-using existing virtual environment at .nox/tests-3-12.\n"
            "nox > python -m pytest tests/\n"
            "nox > Session tests-3.12 was successful.\n"
        )
        result = _compress(self.F, text)
        assert "Re-using existing virtual environment" not in result
        assert "Session tests-3.12 was successful." in result

    def test_env_noise_emits_note(self) -> None:
        text = (
            "nox > Creating virtual environment (virtualenv) using python3.12 in .nox/tests\n"
            "nox > Creating virtual environment (virtualenv) using python3.11 in .nox/tests2\n"
            "nox > Session tests was successful.\n"
        )
        result = _compress(self.F, text)
        assert "collapsed 2 nox env-create/reuse lines" in result

    def test_mixed_create_and_reuse(self) -> None:
        text = (
            "nox > Creating virtual environment (virtualenv) using python3.12 in .nox/a\n"
            "nox > Re-using existing virtual environment at .nox/b.\n"
            "nox > Session tests was successful.\n"
        )
        result = _compress(self.F, text)
        assert "collapsed 2 nox env-create/reuse lines" in result


# ---------------------------------------------------------------------------
# pip progress noise collapsed
# ---------------------------------------------------------------------------

class TestNoxPipNoise:
    F = bc.NoxFilter()

    def test_collapses_collecting(self) -> None:
        text = (
            "nox > python -m pip install pytest\n"
            "Collecting pytest\n"
            "Successfully installed pytest-8.1.1\n"
            "nox > Session tests was successful.\n"
        )
        result = _compress(self.F, text)
        assert "Collecting pytest" not in result
        assert "Successfully installed pytest-8.1.1" in result

    def test_collapses_downloading(self) -> None:
        text = (
            "Downloading pytest-8.1.1-py3-none-any.whl (343 kB)\n"
            "Successfully installed pytest-8.1.1\n"
        )
        result = _compress(self.F, text)
        assert "Downloading pytest" not in result

    def test_collapses_using_cached(self) -> None:
        text = (
            "Using cached pytest-8.1.1-py3-none-any.whl (343 kB)\n"
            "Successfully installed pytest-8.1.1\n"
        )
        result = _compress(self.F, text)
        assert "Using cached" not in result

    def test_collapses_progress_bar(self) -> None:
        text = (
            "Collecting pytest\n"
            "  ━━━━━━━━━━━━━━━━━━━━ 343.3/343.3 kB 3.7 MB/s eta 0:00:00\n"
            "Successfully installed pytest-8.1.1\n"
        )
        result = _compress(self.F, text)
        assert "━" not in result
        assert "Successfully installed pytest-8.1.1" in result

    def test_rich_section_separator_not_dropped(self) -> None:
        # Regression: the broad "━" in line check would drop rich/pytest section
        # separators that start with ━ then text — not pip progress bars.
        text = (
            "nox > Running session tests\n"
            "━━━━━━━━━━━━━━━━━━ short test summary info ━━━━━━━━━━━━━━━━━━\n"
            "FAILED test_foo.py::test_bar\n"
            "nox > Session tests failed.\n"
        )
        result = _compress(self.F, text)
        assert "short test summary info" in result

    def test_collapses_installing_collected(self) -> None:
        text = (
            "Installing collected packages: pytest, pytest-cov\n"
            "Successfully installed pytest-8.1.1 pytest-cov-5.0.0\n"
        )
        result = _compress(self.F, text)
        assert "Installing collected packages" not in result
        assert "Successfully installed" in result

    def test_pip_noise_emits_note(self) -> None:
        text = (
            "Collecting pytest\n"
            "Downloading pytest-8.1.1-py3-none-any.whl (343 kB)\n"
            "Successfully installed pytest-8.1.1\n"
        )
        result = _compress(self.F, text)
        assert "pip install progress lines" in result

    def test_collapses_requirement_satisfied(self) -> None:
        text = (
            "Requirement already satisfied: pytest in .nox/tests/lib/python3.12/site-packages\n"
            "Requirement already satisfied: pytest-cov in .nox/tests/lib/python3.12/site-packages\n"
            "Requirement already satisfied: httpx in .nox/tests/lib/python3.12/site-packages\n"
            "nox > Session tests was successful.\n"
        )
        result = _compress(self.F, text)
        # The individual requirement lines (with file paths) must not appear verbatim.
        assert ".nox/tests/lib/python3.12/site-packages" not in result
        assert "collapsed 3 'Requirement already satisfied' lines" in result

    def test_keeps_successfully_installed(self) -> None:
        text = (
            "Collecting pytest\n"
            "Installing collected packages: pytest\n"
            "Successfully installed pytest-8.1.1\n"
        )
        result = _compress(self.F, text)
        assert "Successfully installed pytest-8.1.1" in result


# ---------------------------------------------------------------------------
# Signal lines always kept
# ---------------------------------------------------------------------------

class TestNoxKeptLines:
    F = bc.NoxFilter()

    def test_keeps_running_session(self) -> None:
        text = "nox > Running session tests-3.12\nnox > Session tests-3.12 was successful.\n"
        result = _compress(self.F, text)
        assert "Running session tests-3.12" in result

    def test_keeps_session_successful(self) -> None:
        text = "nox > Session tests-3.12 was successful.\n"
        result = _compress(self.F, text)
        assert "Session tests-3.12 was successful." in result

    def test_keeps_session_failed_with_exit_code(self) -> None:
        text = (
            "nox > Session tests-3.12 failed with exit code 1.\n"
            "nox > Ran multiple sessions:\nnox > * tests-3.12: Failed\n"
        )
        result = _compress(self.F, text, exit_code=0)
        assert "failed with exit code 1" in result

    def test_keeps_final_summary_header(self) -> None:
        text = (
            "nox > Ran multiple sessions:\n"
            "nox > * tests-3.12: Passed\n"
            "nox > * lint: Passed\n"
        )
        result = _compress(self.F, text)
        assert "Ran multiple sessions:" in result

    def test_keeps_final_summary_items(self) -> None:
        text = (
            "nox > Ran multiple sessions:\n"
            "nox > * tests-3.12: Passed\n"
            "nox > * tests-3.11: Failed\n"
            "nox > * lint: Skipped\n"
        )
        result = _compress(self.F, text)
        assert "* tests-3.12: Passed" in result
        assert "* tests-3.11: Failed" in result
        assert "* lint: Skipped" in result

    def test_keeps_skipping_session(self) -> None:
        text = (
            "nox > Skipping session lint: already run\n"
            "nox > Session lint was skipped.\n"
        )
        result = _compress(self.F, text)
        assert "Skipping session lint" in result

    def test_keeps_error_lines(self) -> None:
        text = (
            "nox > Creating virtual environment (virtualenv) using python3.12 in .nox/tests\n"
            "ERROR: could not install dependencies: package not found\n"
        )
        result = _compress(self.F, text, exit_code=1)
        assert "ERROR: could not install dependencies" in result

    def test_keeps_test_output_within_session(self) -> None:
        text = (
            "nox > python -m pytest tests/\n"
            "FAILED tests/test_api.py::test_broken - AssertionError\n"
            "1 failed, 4 passed in 0.44s\n"
        )
        result = _compress(self.F, text)
        assert "FAILED tests/test_api.py::test_broken" in result
        assert "1 failed, 4 passed" in result

    def test_keeps_session_command_line(self) -> None:
        text = (
            "nox > python -m pytest tests/ --cov=src\n"
            "nox > Session tests was successful.\n"
        )
        result = _compress(self.F, text)
        assert "python -m pytest tests/ --cov=src" in result


# ---------------------------------------------------------------------------
# Full realistic scenario
# ---------------------------------------------------------------------------

class TestNoxFullScenario:
    F = bc.NoxFilter()

    def test_full_successful_run(self) -> None:
        result = _compress(self.F, _NOX_FULL_RUN)
        # Noise is removed
        assert "Creating virtual environment" not in result
        assert "Collecting pytest" not in result
        assert "Downloading pytest" not in result
        assert "━" not in result
        assert "Installing collected packages" not in result
        # Signal is kept
        assert "Running session tests-3.12" in result
        assert "22 passed in 1.23s" in result
        assert "Session tests-3.12 was successful." in result
        assert "Running session lint" in result
        assert "All checks passed!" in result
        assert "Ran multiple sessions:" in result
        assert "* tests-3.12: Passed" in result
        assert "* lint: Passed" in result
        # "Successfully installed" summaries kept
        assert "Successfully installed" in result

    def test_full_reuse_venv_run(self) -> None:
        result = _compress(self.F, _NOX_REUSE_VENV_RUN)
        assert "Re-using existing virtual environment" not in result
        # Individual "Requirement already satisfied: X in .nox/..." lines suppressed.
        assert ".nox/tests-3-12/lib/python3.12/site-packages" not in result
        assert "22 passed in 0.95s" in result
        assert "Session tests-3.12 was successful." in result

    def test_full_failure_run(self) -> None:
        result = _compress(self.F, _NOX_FAILURE_RUN, exit_code=0)
        assert "Creating virtual environment" not in result
        assert "FAILED tests/test_api.py::test_broken" in result
        assert "Session tests-3.12 failed with exit code 1." in result
        assert "* tests-3.12: Failed" in result

    def test_savings_ratio_full_run(self) -> None:
        ratio = _savings_ratio(self.F, _NOX_FULL_RUN)
        assert ratio >= 0.35, f"Expected >=35% savings, got {ratio:.1%}"

    def test_savings_ratio_reuse_run(self) -> None:
        ratio = _savings_ratio(self.F, _NOX_REUSE_VENV_RUN)
        assert ratio >= 0.20, f"Expected >=20% savings, got {ratio:.1%}"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestNoxEdgeCases:
    F = bc.NoxFilter()

    def test_empty_input(self) -> None:
        result = _compress(self.F, "")
        assert isinstance(result, str)

    def test_no_noise_passthrough(self) -> None:
        text = (
            "nox > Running session tests\n"
            "nox > python -m pytest tests/\n"
            "22 passed in 1.23s\n"
            "nox > Session tests was successful.\n"
        )
        result = _compress(self.F, text)
        assert "Running session tests" in result
        assert "22 passed in 1.23s" in result
        assert "Session tests was successful." in result
        assert "token-goat" not in result

    def test_stderr_preserved_on_failure(self) -> None:
        stderr = "Traceback (most recent call last):\n  File ...\nRuntimeError: missing config\n"
        result = _compress(self.F, stdout="nox > Running session tests\n", stderr=stderr, exit_code=1)
        assert "RuntimeError: missing config" in result

    def test_no_note_when_no_noise(self) -> None:
        text = "nox > Running session tests\nnox > Session tests was successful.\n"
        result = _compress(self.F, text)
        assert "token-goat" not in result
