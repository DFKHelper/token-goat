"""Tests for DepListFilter — dependency-listing output compression."""

from __future__ import annotations

from token_goat.bash_compress import DepListFilter, select_filter

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_pkg_lines(n: int, prefix: str = "package") -> str:
    """Return *n* newline-joined package-like lines."""
    return "\n".join(f"{prefix}{i}==1.0.{i}" for i in range(n))


_FILTER = DepListFilter()


def _compress(stdout: str, argv: list[str], *, stderr: str = "", exit_code: int = 0) -> str:
    return _FILTER.compress(stdout, stderr, exit_code, argv)


# ---------------------------------------------------------------------------
# Short output (≤ 30 lines) passes through unchanged
# ---------------------------------------------------------------------------

def test_short_output_passthrough_at_threshold() -> None:
    """Exactly 30 lines should pass through with no trailer."""
    output = _make_pkg_lines(30)
    result = _compress(output, ["pip", "list"])
    assert "more packages" not in result
    assert result.count("\n") == 29  # 30 lines = 29 newlines


def test_short_output_passthrough_below_threshold() -> None:
    """5 lines should pass through unchanged."""
    output = _make_pkg_lines(5)
    result = _compress(output, ["pip", "list"])
    assert "more packages" not in result
    assert "package0==1.0.0" in result
    assert "package4==1.0.4" in result


def test_single_line_passthrough() -> None:
    """Single-line output passes through unchanged."""
    result = _compress("requests==2.31.0", ["pip", "freeze"])
    assert result == "requests==2.31.0"


# ---------------------------------------------------------------------------
# Long output (> 30 lines) truncates to 30 + trailer
# ---------------------------------------------------------------------------

def test_long_output_truncated_to_30_lines() -> None:
    """Output with 50 lines should produce 30 lines + 1 trailer line."""
    output = _make_pkg_lines(50)
    result = _compress(output, ["pip", "list"])
    lines = result.split("\n")
    assert lines[30].startswith("...[20 more packages")
    assert len(lines) == 31  # 30 content lines + 1 trailer


def test_long_output_trailer_count() -> None:
    """Trailer accurately counts the suppressed lines."""
    output = _make_pkg_lines(130)
    result = _compress(output, ["pip", "list"])
    assert "...[100 more packages" in result


def test_long_output_first_30_preserved() -> None:
    """The first 30 lines must be present verbatim in truncated output."""
    output = _make_pkg_lines(60)
    result = _compress(output, ["pip", "list"])
    for i in range(30):
        assert f"package{i}==1.0.{i}" in result
    # Line 31+ (index 30+) must NOT appear as content.
    for i in range(30, 60):
        assert f"package{i}==" not in result


def test_trailer_contains_hint() -> None:
    """Trailer includes a usable command hint."""
    output = _make_pkg_lines(60)
    result = _compress(output, ["pip", "list"])
    assert "pip list" in result


# ---------------------------------------------------------------------------
# matches() — pip commands
# ---------------------------------------------------------------------------

def test_pip_list_matches() -> None:
    assert _FILTER.matches(["pip", "list"])


def test_pip_freeze_matches() -> None:
    assert _FILTER.matches(["pip", "freeze"])


def test_pip3_list_matches() -> None:
    assert _FILTER.matches(["pip3", "list"])


def test_pip_install_does_not_match() -> None:
    """pip install is handled by PipFilter, not DepListFilter."""
    assert not _FILTER.matches(["pip", "install", "requests"])


def test_pip_show_matches() -> None:
    """pip show is in DepListFilter.subcommands (shared with poetry show)."""
    assert _FILTER.matches(["pip", "show", "requests"])


# ---------------------------------------------------------------------------
# matches() — npm commands
# ---------------------------------------------------------------------------

def test_npm_list_matches() -> None:
    assert _FILTER.matches(["npm", "list"])


def test_npm_ls_matches() -> None:
    assert _FILTER.matches(["npm", "ls"])


def test_npm_install_does_not_match() -> None:
    """npm install is handled by NodePackageFilter, not DepListFilter."""
    assert not _FILTER.matches(["npm", "install"])


def test_npm_run_does_not_match() -> None:
    assert not _FILTER.matches(["npm", "run", "build"])


# ---------------------------------------------------------------------------
# matches() — uv pip list (3-token command)
# ---------------------------------------------------------------------------

def test_uv_pip_list_matches() -> None:
    """uv pip list — the canonical 3-token form must match."""
    assert _FILTER.matches(["uv", "pip", "list"])


def test_uv_pip_freeze_matches() -> None:
    assert _FILTER.matches(["uv", "pip", "freeze"])


def test_uv_sync_does_not_match() -> None:
    """uv sync is handled by UvFilter."""
    assert not _FILTER.matches(["uv", "sync"])


def test_uv_pip_install_does_not_match() -> None:
    """uv pip install is handled by UvFilter."""
    assert not _FILTER.matches(["uv", "pip", "install", "requests"])


def test_uv_add_does_not_match() -> None:
    assert not _FILTER.matches(["uv", "add", "requests"])


# ---------------------------------------------------------------------------
# matches() — cargo
# ---------------------------------------------------------------------------

def test_cargo_tree_matches() -> None:
    assert _FILTER.matches(["cargo", "tree"])


def test_cargo_build_does_not_match() -> None:
    """cargo build is handled by CargoFilter."""
    assert not _FILTER.matches(["cargo", "build"])


def test_cargo_test_does_not_match() -> None:
    assert not _FILTER.matches(["cargo", "test"])


# ---------------------------------------------------------------------------
# matches() — poetry
# ---------------------------------------------------------------------------

def test_poetry_show_matches() -> None:
    assert _FILTER.matches(["poetry", "show"])


def test_poetry_install_does_not_match() -> None:
    assert not _FILTER.matches(["poetry", "install"])


# ---------------------------------------------------------------------------
# matches() — pnpm / yarn
# ---------------------------------------------------------------------------

def test_pnpm_list_matches() -> None:
    assert _FILTER.matches(["pnpm", "list"])


def test_yarn_list_matches() -> None:
    assert _FILTER.matches(["yarn", "list"])


def test_pnpm_install_does_not_match() -> None:
    assert not _FILTER.matches(["pnpm", "install"])


# ---------------------------------------------------------------------------
# Error output preserved unchanged (non-zero exit)
# ---------------------------------------------------------------------------

def test_error_output_preserved_when_stderr_present() -> None:
    """Non-zero exit with stderr must pass through unchanged."""
    stdout = _make_pkg_lines(100)
    stderr = "ERROR: Could not find a version that satisfies the requirement"
    result = _compress(stdout, ["pip", "list"], stderr=stderr, exit_code=1)
    assert "ERROR:" in result
    # The full stderr must survive; no truncation trailer.
    assert "more packages" not in result


def test_error_output_no_trailer_on_failure() -> None:
    """Even very long output must not be truncated when exit_code != 0 and stderr present."""
    output = _make_pkg_lines(200)
    stderr = "fatal: something went wrong"
    result = _compress(output, ["pip", "list"], stderr=stderr, exit_code=2)
    assert "more packages" not in result


def test_zero_exit_no_stderr_still_truncates() -> None:
    """Success path: long output still gets truncated."""
    output = _make_pkg_lines(60)
    result = _compress(output, ["pip", "list"], stderr="", exit_code=0)
    assert "more packages" in result


# ---------------------------------------------------------------------------
# select_filter dispatch — DepListFilter wins for list commands
# ---------------------------------------------------------------------------

def test_select_filter_pip_list_picks_dep_list() -> None:
    """select_filter must choose DepListFilter for 'pip list'."""
    f = select_filter(["pip", "list"])
    assert f is not None
    assert f.name == "dep-list"


def test_select_filter_pip_install_picks_pip() -> None:
    """select_filter must NOT choose DepListFilter for 'pip install'."""
    f = select_filter(["pip", "install", "requests"])
    assert f is not None
    assert f.name != "dep-list"


def test_select_filter_npm_list_picks_dep_list() -> None:
    f = select_filter(["npm", "list"])
    assert f is not None
    assert f.name == "dep-list"


def test_select_filter_npm_install_not_dep_list() -> None:
    f = select_filter(["npm", "install"])
    assert f is not None
    assert f.name != "dep-list"


def test_select_filter_uv_pip_list_picks_dep_list() -> None:
    f = select_filter(["uv", "pip", "list"])
    assert f is not None
    assert f.name == "dep-list"


def test_select_filter_cargo_tree_picks_dep_list() -> None:
    f = select_filter(["cargo", "tree"])
    assert f is not None
    assert f.name == "dep-list"


def test_select_filter_cargo_build_not_dep_list() -> None:
    f = select_filter(["cargo", "build"])
    assert f is not None
    assert f.name != "dep-list"


# ---------------------------------------------------------------------------
# _dep_cmd_hint — trailer hint text
# ---------------------------------------------------------------------------

def test_dep_cmd_hint_pip_list() -> None:
    assert DepListFilter._dep_cmd_hint(["pip", "list"]) == "pip list"


def test_dep_cmd_hint_uv_pip_list() -> None:
    """Three-token uv form should produce 'uv pip list'."""
    assert DepListFilter._dep_cmd_hint(["uv", "pip", "list"]) == "uv pip list"


def test_dep_cmd_hint_cargo_tree() -> None:
    assert DepListFilter._dep_cmd_hint(["cargo", "tree"]) == "cargo tree"


def test_dep_cmd_hint_empty_argv() -> None:
    assert DepListFilter._dep_cmd_hint([]) == "the original command"


# ---------------------------------------------------------------------------
# Pip-list format with header (header lines count toward 30)
# ---------------------------------------------------------------------------

def test_pip_list_with_header_counts_all_lines() -> None:
    """Header lines (Package / -----) count toward the 30-line threshold."""
    header = "Package    Version\n---------- -------\n"
    packages = _make_pkg_lines(40)
    output = header + packages
    result = _compress(output, ["pip", "list"])
    lines = result.split("\n")
    # 30 content lines + 1 trailer
    assert lines[-1].startswith("...[")
    assert "more packages" in lines[-1]
