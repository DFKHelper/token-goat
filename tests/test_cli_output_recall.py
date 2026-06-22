"""Direct unit tests for the _run_output_recall_command helper (DRY#5)."""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from token_goat.cli import _run_output_recall_command


class _FakeSidecar(SimpleNamespace):
    """Mimics a BashOutputMeta / WebOutputMeta dataclass for sidecar tests."""


def _make_cache_module(
    body: str | None = "line1\nline2\nline3",
    meta: dict | None = None,
    sidecar: object | None = None,
) -> MagicMock:
    mod = MagicMock()
    mod.load_output.return_value = body
    mod.load_output_meta.return_value = meta
    mod.read_sidecar.return_value = sidecar
    return mod


def test_helper_directly_plain_text(capsys: pytest.CaptureFixture[str]) -> None:
    """Plain-text recall returns the full body when no slicing flags are set and
    the output is below the smart-default threshold."""
    cache = _make_cache_module(body="alpha\nbeta\ngamma")
    with patch("token_goat.db.record_stat") as mock_db:
        _run_output_recall_command(
            output_id="sess-abc-001",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    captured = capsys.readouterr()
    assert "alpha" in captured.out
    assert "beta" in captured.out
    assert "gamma" in captured.out
    # record_stat must be called with the correct stat kind
    mock_db.assert_called_once()
    call_args = mock_db.call_args
    assert call_args[0][1] == "bash_output_recall"


def test_helper_directly_grep_filter(capsys: pytest.CaptureFixture[str]) -> None:
    """--grep filters lines correctly."""
    cache = _make_cache_module(body="PASS: foo\nFAIL: bar\nPASS: baz")
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="PASS",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    captured = capsys.readouterr()
    assert "PASS: foo" in captured.out
    assert "PASS: baz" in captured.out
    assert "FAIL" not in captured.out


def test_helper_directly_json_output(capsys: pytest.CaptureFixture[str]) -> None:
    """JSON mode returns valid JSON with expected keys."""
    sidecar = _FakeSidecar(cmd_preview="pytest tests/", exit_code=0, truncated=False)
    cache = _make_cache_module(
        body="line1\nline2",
        meta={"bytes_stored": 12},
        sidecar=sidecar,
    )
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="out-123",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=True,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert data["output_id"] == "out-123"
    assert "numbered_lines" in data
    assert "total_lines" in data
    # sidecar fields written via vars(sidecar)
    assert data["cmd_preview"] == "pytest tests/"
    assert data["exit_code"] == 0
    assert data["bytes_stored"] == 12


def test_helper_directly_not_found() -> None:
    """Missing cache entry raises typer.Exit(1)."""
    import click  # noqa: PLC0415

    cache = _make_cache_module(body=None)
    with patch("token_goat.db.record_stat"), pytest.raises(click.exceptions.Exit) as exc_info:
        _run_output_recall_command(
            output_id="missing",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="no cached output for id: missing",
        )
    assert exc_info.value.exit_code == 1


def test_helper_web_stat_kind(capsys: pytest.CaptureFixture[str]) -> None:
    """web-output recall uses web_output_recall as the stat kind."""
    sidecar = _FakeSidecar(url_preview="https://example.com", status_code=200, truncated=False)
    cache = _make_cache_module(body="hello", sidecar=sidecar)
    with patch("token_goat.db.record_stat") as mock_db:
        _run_output_recall_command(
            output_id="web-001",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="web_output_recall",
            not_found_msg="not found",
        )
    call_args = mock_db.call_args
    assert call_args[0][1] == "web_output_recall"


# ---------------------------------------------------------------------------
# Item 7 — --head-tail flag
# ---------------------------------------------------------------------------

def _make_body(n: int) -> str:
    """Return a body with N numbered lines."""
    return "\n".join(f"line {i}" for i in range(1, n + 1))


def test_head_tail_60_lines_truncates(capsys: pytest.CaptureFixture[str]) -> None:
    """60-line body with --head-tail emits first 20 + omission marker + last 20."""
    body = _make_body(60)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            head_tail=True,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # First 20 lines present
    assert lines[0] == "line 1"
    assert lines[19] == "line 20"
    # Omission marker present
    omit_lines = [ln for ln in lines if "lines omitted" in ln]
    assert len(omit_lines) == 1
    assert "20" in omit_lines[0]
    # Last 20 lines present
    assert lines[-1] == "line 60"
    assert lines[-20] == "line 41"
    # Total: 20 + 1 marker + 20 = 41 lines
    assert len(lines) == 41


def test_head_tail_30_lines_no_truncation(capsys: pytest.CaptureFixture[str]) -> None:
    """30-line body with --head-tail is returned unchanged (no omission marker)."""
    body = _make_body(30)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            head_tail=True,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # All 30 lines present, no marker
    assert len(lines) == 30
    assert not any("lines omitted" in ln for ln in lines)


def test_head_tail_exactly_40_lines_no_truncation(capsys: pytest.CaptureFixture[str]) -> None:
    """Exactly 40-line body (== threshold) is returned unchanged."""
    body = _make_body(40)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            head_tail=True,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert len(lines) == 40
    assert not any("lines omitted" in ln for ln in lines)


# ---------------------------------------------------------------------------
# Item 10 — --grep-max N flag
# ---------------------------------------------------------------------------

def _make_grep_body(match_count: int, noise_count: int = 5) -> str:
    """Return a body with match_count MATCH lines interspersed with noise lines."""
    lines = []
    for i in range(1, match_count + 1):
        lines.append(f"MATCH line {i}")
        if i <= noise_count:
            lines.append(f"noise {i}")
    return "\n".join(lines)


def test_grep_max_caps_results(capsys: pytest.CaptureFixture[str]) -> None:
    """50 matches with --grep-max 5 → 5 lines + count header + truncation footer."""
    body = _make_grep_body(50)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="MATCH",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            grep_max=5,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # First line is the count header
    assert lines[0] == "Match count: 50"
    # Next 5 lines are match lines
    match_lines = [ln for ln in lines[1:] if ln.startswith("MATCH")]
    assert len(match_lines) == 5
    # Footer present
    footer_lines = [ln for ln in lines if "--grep-max 0" in ln]
    assert len(footer_lines) == 1
    assert "50" in footer_lines[0]


def test_grep_max_zero_no_cap(capsys: pytest.CaptureFixture[str]) -> None:
    """--grep-max 0 returns all matching lines with no truncation footer."""
    body = _make_grep_body(50)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="MATCH",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            grep_max=0,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    match_lines = [ln for ln in lines if ln.startswith("MATCH")]
    assert len(match_lines) == 50
    assert not any("--grep-max 0" in ln for ln in lines)


def test_grep_max_default_constant_is_20() -> None:
    """_GREP_MAX_DEFAULT is 20 per the design spec."""
    from token_goat.cli import _GREP_MAX_DEFAULT  # noqa: PLC0415
    assert _GREP_MAX_DEFAULT == 20


def test_apply_grep_cap_no_truncation() -> None:
    """_apply_grep_cap returns unchanged list when matches <= grep_max."""
    from token_goat.cli import _apply_grep_cap  # noqa: PLC0415
    lines = [f"line {i}" for i in range(10)]
    result, footer = _apply_grep_cap(lines, 20)
    assert result == lines
    assert footer == ""


def test_apply_grep_cap_truncates() -> None:
    """_apply_grep_cap truncates and returns footer when matches > grep_max."""
    from token_goat.cli import _apply_grep_cap  # noqa: PLC0415
    lines = [f"line {i}" for i in range(30)]
    result, footer = _apply_grep_cap(lines, 10)
    assert result == lines[:10]
    assert "--grep-max 0" in footer
    assert "30" in footer


# ---------------------------------------------------------------------------
# Tests for _extract_body_section
# ---------------------------------------------------------------------------

def test_extract_body_section_basic() -> None:
    """_extract_body_section returns a named ATX section."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "# Intro\nsome text\n## Installation\ninstall stuff\n## Usage\nuse it"
    result = _extract_body_section(body, "Installation")
    assert result is not None
    assert "## Installation" in result
    assert "install stuff" in result
    # Must not bleed into the next section
    assert "## Usage" not in result
    assert "use it" not in result


def test_extract_body_section_case_insensitive() -> None:
    """_extract_body_section matches headings case-insensitively."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "## Configuration\nconfig text\n## Other\nother"
    result = _extract_body_section(body, "configuration")
    assert result is not None
    assert "config text" in result


def test_extract_body_section_not_found_returns_none() -> None:
    """_extract_body_section returns None when heading is absent."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "## Intro\ntext\n## Usage\nmore text"
    assert _extract_body_section(body, "Nonexistent") is None


def test_extract_body_section_ordinal() -> None:
    """_extract_body_section Heading#2 selects the second occurrence."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "## Example\nfirst\n## Example\nsecond\n## Other\nthird"
    first = _extract_body_section(body, "Example")
    second = _extract_body_section(body, "Example#2")
    assert first is not None and "first" in first
    assert second is not None and "second" in second
    assert "first" not in second


def test_extract_body_section_ordinal_out_of_range() -> None:
    """_extract_body_section returns None when ordinal exceeds occurrences."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "## Example\nonly one"
    assert _extract_body_section(body, "Example#2") is None


def test_extract_body_section_last_section_reaches_eof() -> None:
    """The last section in a document extends to end-of-file."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "## First\nfirst text\n## Last\nlast text"
    result = _extract_body_section(body, "Last")
    assert result is not None
    assert "last text" in result


def test_extract_body_section_subsection_stops_at_same_level() -> None:
    """A section ends when a heading of the same level appears."""
    from token_goat.cli import _extract_body_section  # noqa: PLC0415

    body = "# Top\n## Sub1\nsub one content\n### Nested\nnested content\n## Sub2\nsub two"
    result = _extract_body_section(body, "Sub1")
    assert result is not None
    assert "sub one content" in result
    assert "Nested" in result   # ## Sub1 captures ### Nested below it
    assert "Sub2" not in result


# ---------------------------------------------------------------------------
# Tests for _compile_grep_pattern (regex support)
# ---------------------------------------------------------------------------

def test_compile_grep_pattern_valid_regex() -> None:
    """_compile_grep_pattern compiles valid regex patterns."""
    from token_goat.cli import _compile_grep_pattern  # noqa: PLC0415

    pat = _compile_grep_pattern(r"def \w+", case_sensitive=False)
    assert pat.search("def my_function:")
    assert not pat.search("class MyClass:")


def test_compile_grep_pattern_invalid_regex_falls_back_to_literal() -> None:
    """_compile_grep_pattern treats invalid regex as a literal string."""
    from token_goat.cli import _compile_grep_pattern  # noqa: PLC0415

    # "[unclosed" is invalid regex but a valid literal string
    pat = _compile_grep_pattern("[unclosed", case_sensitive=True)
    assert pat.search("[unclosed bracket here")
    assert not pat.search("something else")


def test_compile_grep_pattern_case_insensitive() -> None:
    """_compile_grep_pattern with case_sensitive=False matches regardless of case."""
    from token_goat.cli import _compile_grep_pattern  # noqa: PLC0415

    pat = _compile_grep_pattern("TODO", case_sensitive=False)
    assert pat.search("todo: fix this")
    assert pat.search("TODO: fix this")
    assert pat.search("Todo: fix this")


def test_compile_grep_pattern_case_sensitive() -> None:
    """_compile_grep_pattern with case_sensitive=True is exact."""
    from token_goat.cli import _compile_grep_pattern  # noqa: PLC0415

    pat = _compile_grep_pattern("TODO", case_sensitive=True)
    assert pat.search("TODO: fix this")
    assert not pat.search("todo: fix this")


# ---------------------------------------------------------------------------
# Tests for --grep regex support in _run_output_recall_command
# ---------------------------------------------------------------------------

def test_grep_regex_pattern_matches(capsys: pytest.CaptureFixture[str]) -> None:
    """--grep with a real regex pattern filters by regex (not literal)."""
    body = "def my_func():\n    pass\nclass MyClass:\n    def method(self):\n        pass\n"
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=r"def \w+",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out
    assert "def my_func" in out
    assert "def method" in out
    assert "class MyClass" not in out


def test_grep_invalid_regex_treated_as_literal(capsys: pytest.CaptureFixture[str]) -> None:
    """--grep with an invalid regex pattern falls back to literal matching."""
    body = "line with [special chars\nnormal line\nanother [special chars line\n"
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="[special chars",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out
    assert "line with [special chars" in out
    assert "another [special chars line" in out
    assert "normal line" not in out


# ---------------------------------------------------------------------------
# Tests for --section in _run_output_recall_command
# ---------------------------------------------------------------------------

def test_section_extracts_named_section(capsys: pytest.CaptureFixture[str]) -> None:
    """--section returns only the named markdown section."""
    body = "# Root\nroot content\n## Installation\nrun pip install\n## Usage\nrun it\n"
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="web_output_recall",
            not_found_msg="not found",
            section="Installation",
        )
    out = capsys.readouterr().out
    assert "run pip install" in out
    assert "## Installation" in out
    assert "## Usage" not in out
    assert "root content" not in out


def test_section_not_found_exits_with_error(capsys: pytest.CaptureFixture[str]) -> None:
    """--section with a missing heading emits an error and exits 1."""
    import click  # noqa: PLC0415

    body = "## Intro\nsome text\n"
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"), pytest.raises(click.exceptions.Exit) as exc:
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="web_output_recall",
            not_found_msg="not found",
            section="Nonexistent",
        )
    assert exc.value.exit_code == 1


def test_section_combined_with_grep(capsys: pytest.CaptureFixture[str]) -> None:
    """--section and --grep can be combined: section first, then grep."""
    body = (
        "## Installation\n"
        "run: pip install foo\n"
        "run: pip install bar\n"
        "note: you also need baz\n"
        "## Usage\n"
        "run: foo --help\n"
    )
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="pip install",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="web_output_recall",
            not_found_msg="not found",
            section="Installation",
        )
    out = capsys.readouterr().out
    assert "pip install foo" in out
    assert "pip install bar" in out
    # grep filters out non-matching lines within the section
    assert "note: you also need baz" not in out
    # Usage section was never included
    assert "foo --help" not in out


def test_section_in_json_output_includes_section_field(capsys: pytest.CaptureFixture[str]) -> None:
    """JSON output includes a 'section' key when --section is used."""
    body = "## API\napi content\n## Other\nother content\n"
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=True,
            cache_module=cache,
            stat_kind="web_output_recall",
            not_found_msg="not found",
            section="API",
        )
    payload = json.loads(capsys.readouterr().out)
    assert payload["section"] == "API"
    assert "api content" in payload["text"]


# ---------------------------------------------------------------------------
# Tests for combined --head and --tail
# ---------------------------------------------------------------------------

def test_head_and_tail_combined(capsys: pytest.CaptureFixture[str]) -> None:
    """--head and --tail together returns first N + last M lines (not sequential).

    When both --head=10 and --tail=20 are specified on a 100-line output,
    the result should include lines 1-10 and lines 81-100 (first 10 + last 20
    of the original 100), not just apply them sequentially which would lose
    most of the output.
    """
    body = _make_body(100)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=10,
            tail=20,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # Should have first 10 + last 20 = 30 lines (no duplication at boundaries)
    assert len(lines) == 30
    # First 10 lines should be present
    assert lines[0] == "line 1"
    assert lines[9] == "line 10"
    # Last 20 lines should be present
    assert lines[10] == "line 81"
    assert lines[29] == "line 100"


def test_head_and_tail_overlap_no_duplicate_lines(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """When --head and --tail ranges overlap, lines are not duplicated.

    For a 20-line body with --head=15 --tail=10 the two ranges overlap
    (15 + 10 >= 20). The result must return every line exactly once (all 20
    lines, in order) rather than concatenating lines[:15] + lines[-10:] which
    would emit 25 lines with lines 11-15 duplicated.
    """
    body = _make_body(20)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=15,
            tail=10,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines == [f"line {i}" for i in range(1, 21)]
    assert len(lines) == len(set(lines))


def test_empty_body_prints_notice(capsys: pytest.CaptureFixture[str]) -> None:
    """Empty output file (body is empty string) prints a clear notice instead of silent nothing."""
    cache = _make_cache_module(body="")
    with patch("token_goat.db.record_stat") as mock_stat:
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out
    assert "empty output" in out
    mock_stat.assert_called_once_with(None, "bash_output_recall", bytes_saved=0, tokens_saved=0, detail="x")


def test_whitespace_only_body_prints_notice(capsys: pytest.CaptureFixture[str]) -> None:
    """Whitespace-only output file prints the empty notice instead of silent nothing."""
    cache = _make_cache_module(body="   \n\n   ")
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out
    assert "empty output" in out


def test_empty_body_json_output(capsys: pytest.CaptureFixture[str]) -> None:
    """Empty body with --json emits a JSON object with output=null, not plain text."""
    cache = _make_cache_module(body="")
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=True,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    out = capsys.readouterr().out.strip()
    data = json.loads(out)
    assert data.get("output") is None
    assert "reason" in data
