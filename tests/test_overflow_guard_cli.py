"""Integration tests: the overflow guard fires at the real emit sites.

These drive the same code paths the CLI commands use — ``read FILE::SYMBOL`` /
``section FILE::HEADING`` via ``read_commands._run_read_like_command`` and
``bash-output --full`` / ``web-output --full`` via ``cli._run_output_recall_command``
— with mocked readers / cache modules so no project index or seeded cache is
needed (mirrors tests/test_read_commands.py and tests/test_cli_output_recall.py).

They are real regression tests: each over-budget case asserts BOTH the stable
marker contract substrings AND a bounded output length, so removing the
``overflow_guard.guard(...)`` call from an emit site fails the test rather than
passing silently. The guard's enabled/max_tokens come from a patched
``config.load()`` so the budget is deterministic and independent of the
machine's real config / environment.
"""
from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# Stable contract substrings — asserted verbatim by design (see overflow_guard
# module docstring). Downstream tooling keys off these exact strings.
_MARKER = "[token-goat: output capped"
_PROTECT = "to protect context"

# A body far over any small token budget: ~5000 short lines.
_BIG_TEXT = "\n".join(f"line {i}" for i in range(5_000))


def _fake_config(*, enabled: bool, max_tokens: int) -> SimpleNamespace:
    """A stand-in for ``config.load()`` exposing only ``.overflow_guard``."""
    return SimpleNamespace(
        overflow_guard=SimpleNamespace(enabled=enabled, max_tokens=max_tokens)
    )


def _patch_guard_config(*, enabled: bool, max_tokens: int):
    """Patch the config the guard loads from (overflow_guard imports ``config``)."""
    return patch(
        "token_goat.overflow_guard.config.load",
        return_value=_fake_config(enabled=enabled, max_tokens=max_tokens),
    )


# ---------------------------------------------------------------------------
# read / section (read_commands._run_read_like_command -> _emit_text_result)
# ---------------------------------------------------------------------------

def _make_mock_result(text: str) -> dict:
    return {
        "text": text,
        "start_line": 1,
        "end_line": text.count("\n") + 1,
        "bytes_total": len(text),
        "bytes_extracted": len(text),
        "bytes_saved": 0,
    }


def _make_file_target(rel_path: str = "src/foo.py") -> MagicMock:
    proj = MagicMock()
    proj.hash = "abc123"
    proj.root = MagicMock()
    ft = MagicMock()
    ft.rel_path = rel_path
    ft.project = proj
    ft.current_project = proj  # equal -> no cross-project note branch
    return ft


def _run_read(
    *, separator_label: str, json_output: bool, body: str,
    enabled: bool = True, max_tokens: int = 200,
) -> str:
    """Drive _run_read_like_command in non-TTY mode; return captured stdout.

    ``full=True`` bypasses ``read_replacement.truncate_symbol_body`` (the smart
    head+tail collapse for long symbol bodies) so the overflow guard is the
    *only* size cap on the path — which is precisely the regression we want to
    pin: with smart truncation off, removing the guard would let a giant body
    flood the model's context.
    """
    from token_goat.read_commands import _run_read_like_command

    reader = MagicMock(return_value=_make_mock_result(body))
    file_target = _make_file_target()
    import io
    buf = io.StringIO()
    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        # format_callers_footer hits the DB for symbol reads; stub to empty.
        patch("token_goat.read_commands.read_replacement.format_callers_footer", return_value=""),
        patch.object(sys.stdout, "isatty", return_value=False),
        _patch_guard_config(enabled=enabled, max_tokens=max_tokens),
        patch("sys.stdout", buf),
    ):
        _run_read_like_command(
            target=f"src/foo.py::{'my_func' if separator_label == 'symbol' else 'Install'}",
            session_id=None,
            json_output=json_output,
            context_lines=0,
            separator_label=separator_label,
            missing_label="Symbol" if separator_label == "symbol" else "Section",
            stat_kind="read_replacement",
            reader=reader,
            no_header=True,
            full=True,
        )
    return buf.getvalue()


class TestReadCommandGuard:
    def test_over_budget_read_emits_marker_and_bounds(self) -> None:
        out = _run_read(separator_label="symbol", json_output=False, body=_BIG_TEXT)
        assert _MARKER in out
        assert _PROTECT in out
        # Bounded: the emitted body is far smaller than the raw input.
        assert len(out) < len(_BIG_TEXT)
        # Head preserved, tail dropped.
        assert "line 0" in out
        assert "line 4999" not in out

    def test_over_budget_section_emits_marker(self) -> None:
        """``section FILE::HEADING`` routes through the same guard (label 'heading')."""
        out = _run_read(separator_label="heading", json_output=False, body=_BIG_TEXT)
        assert _MARKER in out
        assert _PROTECT in out
        assert len(out) < len(_BIG_TEXT)
        # The heading/section hint suggests a narrower sub-heading.
        assert "sub-heading" in out.lower() or "#2" in out

    def test_under_budget_read_no_marker(self) -> None:
        """A small body well under budget passes through with no cap marker."""
        small = "alpha\nbeta\ngamma"
        out = _run_read(separator_label="symbol", json_output=False, body=small)
        assert _MARKER not in out
        assert "alpha" in out and "gamma" in out

    def test_disabled_guard_emits_full_body_no_marker(self) -> None:
        """With the guard disabled, the full oversized body is emitted unguarded."""
        out = _run_read(
            separator_label="symbol", json_output=False, body=_BIG_TEXT,
            enabled=False, max_tokens=200,
        )
        assert _MARKER not in out
        # Full body present, including the last line that truncation would drop.
        assert "line 0" in out
        assert "line 4999" in out

    def test_json_output_not_truncated(self) -> None:
        """``--json`` bypasses the guard entirely: valid JSON, full text, no marker."""
        out = _run_read(separator_label="symbol", json_output=True, body=_BIG_TEXT)
        assert _MARKER not in out
        payload = json.loads(out)
        # The structured text field carries the complete body, untruncated.
        assert "line 0" in payload["text"]
        assert "line 4999" in payload["text"]


# ---------------------------------------------------------------------------
# bash-output / web-output --full (cli._run_output_recall_command)
# ---------------------------------------------------------------------------

def _make_cache_module(body: str) -> MagicMock:
    mod = MagicMock()
    mod.load_output.return_value = body
    mod.load_output_meta.return_value = None
    mod.read_sidecar.return_value = None
    return mod


def _run_recall(
    *, stat_kind: str, json_output: bool, body: str,
    enabled: bool = True, max_tokens: int = 200,
) -> str:
    from token_goat.cli import _run_output_recall_command

    cache = _make_cache_module(body)
    import io
    buf = io.StringIO()
    with (
        patch("token_goat.db.record_stat"),
        _patch_guard_config(enabled=enabled, max_tokens=max_tokens),
        patch("sys.stdout", buf),
    ):
        _run_output_recall_command(
            output_id="sess-001",
            head=0,
            tail=0,
            grep=None,
            full=True,  # bypass smart-default slicing so the guard is the only cap
            json_output=json_output,
            cache_module=cache,
            stat_kind=stat_kind,
            not_found_msg="not found",
        )
    return buf.getvalue()


class TestOutputRecallGuard:
    def test_bash_output_full_over_budget_marker_and_bounds(self) -> None:
        out = _run_recall(stat_kind="bash_output_recall", json_output=False, body=_BIG_TEXT)
        assert _MARKER in out
        assert _PROTECT in out
        assert len(out) < len(_BIG_TEXT)
        # bash-output remediation hint mentions the narrowing flags.
        assert "--grep" in out and "--tail" in out

    def test_web_output_full_over_budget_marker(self) -> None:
        out = _run_recall(stat_kind="web_output_recall", json_output=False, body=_BIG_TEXT)
        assert _MARKER in out
        assert "--grep" in out

    def test_bash_output_disabled_emits_full_body(self) -> None:
        out = _run_recall(
            stat_kind="bash_output_recall", json_output=False, body=_BIG_TEXT,
            enabled=False, max_tokens=200,
        )
        assert _MARKER not in out
        assert "line 4999" in out

    def test_bash_output_json_not_truncated(self) -> None:
        """JSON recall bypasses the guard: valid JSON, no marker, full body."""
        out = _run_recall(stat_kind="bash_output_recall", json_output=True, body=_BIG_TEXT)
        assert _MARKER not in out
        payload = json.loads(out)
        assert "line 0" in payload["text"]
        assert "line 4999" in payload["text"]
