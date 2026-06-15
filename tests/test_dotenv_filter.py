"""Tests for DotenvFilter — dotenv / python-dotenv loading-banner compression."""

from __future__ import annotations

from token_goat.bash_compress import DotenvFilter, select_filter

_FILTER = DotenvFilter()


def _compress(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    if argv is None:
        argv = ["dotenv", "--", "node", "app.js"]
    return _FILTER.compress(stdout, stderr, exit_code, argv)


# ---------------------------------------------------------------------------
# Representative dotenv output samples
# ---------------------------------------------------------------------------

DOTENV_CLI_STDOUT = """\
[dotenv] Loading .env
[dotenv] Exported 23 variables
[dotenv] Skipped 2 variables (already set)
"""

PYTHON_DOTENV_STDOUT = """\
Loading .env environment variables...
Loaded variables from .env
"""

PYTHON_DOTENV_PARSE_ERROR = """\
Loading .env environment variables...
Loaded variables from .env
python-dotenv could not parse statement starting at line 12
  Path: /home/user/project/.env
  Line: 'BROKEN_KEY value without equals'
"""


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def test_dispatch_selects_dotenv_filter() -> None:
    """``dotenv -- <cmd>`` routes to DotenvFilter."""
    f = select_filter(["dotenv", "--", "node", "app.js"])
    assert isinstance(f, DotenvFilter)


def test_dispatch_ignores_non_dotenv_binary() -> None:
    """A non-dotenv binary is never claimed by DotenvFilter."""
    f = select_filter(["pip", "install", "flask"])
    assert not isinstance(f, DotenvFilter)


# ---------------------------------------------------------------------------
# Collapsing
# ---------------------------------------------------------------------------


def test_dotenv_cli_banner_collapses_to_count_summary() -> None:
    """``[dotenv]`` loading/exported lines collapse to one ``loaded N vars`` line."""
    out = _compress(stdout=DOTENV_CLI_STDOUT)
    assert out == "[dotenv] loaded 23 vars"


def test_skipped_count_excluded_from_loaded_tally() -> None:
    """``Skipped N variables`` collapses but never inflates the loaded count."""
    out = _compress(stdout=DOTENV_CLI_STDOUT)
    assert "Skipped" not in out
    assert "25" not in out  # 23 exported + 2 skipped must NOT be summed
    assert "23" in out


def test_python_dotenv_plain_load_collapses_without_count() -> None:
    """Count-less python-dotenv banners collapse to ``[dotenv] loaded .env``."""
    out = _compress(stdout=PYTHON_DOTENV_STDOUT)
    assert out == "[dotenv] loaded .env"


def test_multiple_export_counts_are_summed() -> None:
    """Two ``Exported N variables`` banners sum into a single tally."""
    stdout = "[dotenv] Exported 10 variables\n[dotenv] Exported 5 variables\n"
    out = _compress(stdout=stdout)
    assert out == "[dotenv] loaded 15 vars"


# ---------------------------------------------------------------------------
# Pass-through behaviour
# ---------------------------------------------------------------------------


def test_parse_warning_preserved_verbatim() -> None:
    """Parse warnings and their indented continuation lines survive untouched."""
    out = _compress(stdout=PYTHON_DOTENV_PARSE_ERROR)
    lines = out.splitlines()
    assert lines[0] == "[dotenv] loaded .env"
    assert "python-dotenv could not parse statement starting at line 12" in out
    assert "  Path: /home/user/project/.env" in out
    assert "  Line: 'BROKEN_KEY value without equals'" in out
    # The two leading banner lines must be gone (collapsed into the summary).
    assert "Loading .env environment variables..." not in out
    assert "Loaded variables from .env" not in out


def test_single_banner_line_passes_through_unchanged() -> None:
    """A lone loading message has nothing to collapse and is returned as-is."""
    out = _compress(stdout="Loading environment from .env")
    assert out == "Loading environment from .env"


def test_no_banner_output_passes_through() -> None:
    """Output with no dotenv banner at all is left untouched."""
    payload = "running migrations\nall done"
    out = _compress(stdout=payload)
    assert out == payload


def test_error_lines_are_not_collapsed() -> None:
    """A wrapped-command error line is preserved alongside the collapsed banner."""
    stdout = (
        "[dotenv] Loading .env\n"
        "[dotenv] Exported 4 variables\n"
        "Error: ENOENT no such file or directory\n"
    )
    out = _compress(stdout=stdout, exit_code=1)
    assert "[dotenv] loaded 4 vars" in out
    assert "Error: ENOENT no such file or directory" in out


def test_summary_precedes_preserved_diagnostics() -> None:
    """The collapsed summary is emitted at the position of the first banner."""
    out = _compress(stdout=PYTHON_DOTENV_PARSE_ERROR)
    assert out.startswith("[dotenv] loaded .env\n")
