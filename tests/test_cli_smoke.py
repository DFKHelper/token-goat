"""Smoke test for CLI."""
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat import cli

runner = CliRunner()


def test_cli_help_runs():
    """Test that token-goat --help doesn't crash."""
    result = runner.invoke(cli.app, ["--help"])
    assert result.exit_code == 0
    assert "symbol" in result.stdout
    assert "ref" in result.stdout
    assert "semantic" in result.stdout
    assert "map" in result.stdout


def test_doctor_command_runs(tmp_data_dir, monkeypatch):
    """Test that token-goat doctor runs successfully.

    Mocks 'uv --version' subprocess call (takes 6s on Windows per invocation)
    and uses tmp_data_dir to avoid opening the production global.db.
    """
    _real_run = subprocess.run

    def _mock_run(args, **kwargs):
        if args and args[0] == "uv" and args[1:] == ["--version"]:
            return subprocess.CompletedProcess(args=args, returncode=0, stdout="uv 0.x.y\n", stderr="")
        return _real_run(args, **kwargs)

    monkeypatch.setattr(subprocess, "run", _mock_run)
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0
    assert "token-goat doctor" in result.stdout
    assert "Python:" in result.stdout
    assert "SQLite" in result.stdout


def test_hook_help_runs():
    """Test that token-goat hook --help shows subcommands."""
    result = runner.invoke(cli.app, ["hook", "--help"])
    assert result.exit_code == 0
    assert "session-start" in result.stdout or "session_start" in result.stdout


def test_cli_version_flag():
    """`token-goat --version` prints the package version and exits 0.

    SECURITY.md instructs reporters to run this command, so it must work.
    """
    result = runner.invoke(cli.app, ["--version"])
    assert result.exit_code == 0
    assert "token-goat" in result.stdout
    # Version string starts with a digit (semver) — guards against a placeholder.
    assert any(ch.isdigit() for ch in result.stdout)


def test_cli_version_short_flag():
    """`-V` is accepted as a short alias for --version."""
    result = runner.invoke(cli.app, ["-V"])
    assert result.exit_code == 0
    assert "token-goat" in result.stdout


# ---------------------------------------------------------------------------
# semantic --compact / --full output format tests
# ---------------------------------------------------------------------------

def _make_hits(n: int = 3):
    """Return n fake semantic search hit objects."""
    return [
        SimpleNamespace(
            file_rel=f"src/module_{i}.py",
            start_line=10 * i,
            end_line=10 * i + 5,
            kind="function",
            distance=0.1 * i,
            text=f"def func_{i}(): pass  # snippet content {i}",
        )
        for i in range(1, n + 1)
    ]


def _invoke_semantic(args: list, hits=None):
    """Invoke the semantic command with a mocked project and embeddings."""
    if hits is None:
        hits = _make_hits()

    fake_proj = SimpleNamespace(hash="abc123")

    with (
        patch("token_goat.cli._require_project", return_value=fake_proj),
        patch("token_goat.embeddings.semantic_search", return_value=hits),
        patch(
            "token_goat.embeddings.DEFAULT_DISTANCE_THRESHOLD",
            0.5,
        ),
    ):
        return runner.invoke(cli.app, ["semantic", "test query", *args])


def test_semantic_compact_default_one_line_per_result():
    """Default (compact) output: exactly one line per hit, no blank separators."""
    hits = _make_hits(3)
    result = _invoke_semantic([], hits=hits)
    assert result.exit_code == 0, result.output
    lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
    assert len(lines) == len(hits), f"Expected {len(hits)} lines, got {len(lines)}: {result.stdout!r}"


def test_semantic_compact_line_format():
    """Compact lines follow <path>:<line>  <snippet> format."""
    hits = _make_hits(2)
    result = _invoke_semantic([], hits=hits)
    assert result.exit_code == 0, result.output
    lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
    for i, (line, hit) in enumerate(zip(lines, hits, strict=True)):
        assert line.startswith(f"{hit.file_rel}:{hit.start_line}"), (
            f"Line {i} missing path:lineno prefix: {line!r}"
        )
        # snippet present (first non-space chars after the path:line prefix)
        assert hit.text[:20].replace("\n", " ") in line, f"Snippet missing in line {i}: {line!r}"


def test_semantic_compact_no_kind_distance_in_output():
    """Compact mode must not emit kind or distance metadata."""
    hits = _make_hits(2)
    result = _invoke_semantic([], hits=hits)
    assert result.exit_code == 0, result.output
    assert "d=0." not in result.stdout, "Distance leaked into compact output"
    assert "(function" not in result.stdout, "Kind leaked into compact output"


def test_semantic_full_two_lines_per_result():
    """--full mode emits two lines per result: header + indented snippet."""
    hits = _make_hits(3)
    result = _invoke_semantic(["--full"], hits=hits)
    assert result.exit_code == 0, result.output
    lines = result.stdout.splitlines()
    # Every even line (0-indexed) is a header; every odd line is indented snippet.
    non_empty = [ln for ln in lines if ln.strip()]
    assert len(non_empty) == len(hits) * 2, (
        f"Expected {len(hits) * 2} non-empty lines in --full mode, got {len(non_empty)}"
    )


def test_semantic_full_contains_kind_and_distance():
    """--full mode must include kind and distance on the header line."""
    hits = _make_hits(1)
    result = _invoke_semantic(["--full"], hits=hits)
    assert result.exit_code == 0, result.output
    assert "function" in result.stdout
    assert "d=" in result.stdout


def test_semantic_compact_shorter_than_full():
    """Compact output must be strictly shorter (in bytes) than --full output."""
    hits = _make_hits(5)
    compact_result = _invoke_semantic([], hits=hits)
    full_result = _invoke_semantic(["--full"], hits=hits)
    assert len(compact_result.stdout) < len(full_result.stdout), (
        f"Compact ({len(compact_result.stdout)} bytes) not shorter than full ({len(full_result.stdout)} bytes)"
    )
