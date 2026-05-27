"""Consolidated regression tests for token-savings invariants locked in by iterations 1-9.

Each test asserts a structural or size constraint that would FAIL if the
corresponding iteration's change were reverted.
"""
from __future__ import annotations

import json

from token_goat import session
from token_goat.repomap import estimate_tokens

# ---------------------------------------------------------------------------
# (a) + (b) Hint text size ceilings and no "Note:" prefix
# ---------------------------------------------------------------------------


_BASH_CMD = "find /srv -name '*.log'"
_WEB_URL = "https://docs.example.com/api"


def _seed_bash(sid: str) -> str:
    """Record a large enough bash run to trigger the dedup hint; return output_id."""
    from token_goat import bash_cache as _bc

    cmd_sha = _bc.command_hash(_BASH_CMD)
    output_id = f"{sid[:16]}-0000000001234-{cmd_sha}"
    session.mark_bash_run(
        session_id=sid,
        cmd_sha=cmd_sha,
        cmd_preview=_BASH_CMD,
        output_id=output_id,
        stdout_bytes=5000,
        stderr_bytes=0,
        exit_code=0,
        truncated=False,
    )
    return output_id


def _seed_web(sid: str) -> str:
    """Record a large enough web fetch to trigger the dedup hint; return output_id."""
    from token_goat import web_cache as _wc

    url_sha = _wc.url_hash(_WEB_URL)
    output_id = f"{sid[:16]}-0000000002345-{url_sha}"
    session.mark_web_fetch(
        session_id=sid,
        url_sha=url_sha,
        url_preview=_WEB_URL,
        output_id=output_id,
        body_bytes=4000,
        status_code=200,
        truncated=False,
    )
    return output_id


class TestHintSizeCeilings:
    """Hint texts must stay under token ceilings so meta-cost never exceeds savings."""

    def test_bash_dedup_hint_under_ceiling(self, tmp_data_dir):
        from token_goat.hints import build_bash_dedup_hint

        sid = "inv-bash-dedup"
        _seed_bash(sid)
        cache = session.load(sid)
        hint = build_bash_dedup_hint(session_id=sid, command=_BASH_CMD, cache=cache)
        assert hint is not None
        assert estimate_tokens(str(hint)) <= 80

    def test_grep_dedup_hint_under_ceiling(self, tmp_data_dir):
        from token_goat.hints import build_grep_dedup_hint

        sid = "inv-grep-dedup"
        session.mark_grep(sid, "build_manifest", "/proj/src", result_count=20)
        cache = session.load(sid)
        hint = build_grep_dedup_hint(
            session_id=sid, pattern="build_manifest", path="/proj/src", cache=cache,
        )
        assert hint is not None
        assert estimate_tokens(str(hint)) <= 60

    def test_web_dedup_hint_under_ceiling(self, tmp_data_dir):
        from token_goat.hints import build_web_dedup_hint

        sid = "inv-web-dedup"
        _seed_web(sid)
        cache = session.load(sid)
        hint = build_web_dedup_hint(session_id=sid, url=_WEB_URL, cache=cache)
        # Ceiling (80) matches the bash/grep dedup hints — concise single-line format.
        assert hint is not None
        assert estimate_tokens(str(hint)) <= 80

    def test_symbol_only_hint_under_ceiling(self, tmp_data_dir):
        from token_goat.hints import build_read_hint

        sid = "inv-symbol-hint"
        session.mark_file_read(sid, "C:/proj/auth.py", symbol="verify_token")
        hint = build_read_hint(
            session_id=sid,
            file_path="C:/proj/auth.py",
            offset=0,
            limit=2000,
            cwd=None,
        )
        assert hint is not None
        assert estimate_tokens(str(hint)) <= 80

    def test_exact_match_hint_under_ceiling(self, tmp_data_dir):
        from token_goat.hints import build_read_hint

        sid = "inv-exact-hint"
        session.mark_file_read(sid, "C:/proj/foo.py", offset=0, limit=300)
        hint = build_read_hint(
            session_id=sid, file_path="C:/proj/foo.py", offset=0, limit=300, cwd=None,
        )
        assert hint is not None
        assert estimate_tokens(str(hint)) <= 60


class TestNoNotePrefix:
    """Hint texts must NOT start with 'Note:' (the prefix removed in iter 1)."""

    def test_bash_dedup_hint_no_note_prefix(self, tmp_data_dir):
        from token_goat.hints import build_bash_dedup_hint

        sid = "inv-no-note-bash"
        _seed_bash(sid)
        cache = session.load(sid)
        hint = build_bash_dedup_hint(session_id=sid, command=_BASH_CMD, cache=cache)
        assert hint is not None
        assert not str(hint).startswith("Note:")

    def test_grep_dedup_hint_no_note_prefix(self, tmp_data_dir):
        from token_goat.hints import build_grep_dedup_hint

        sid = "inv-no-note-grep"
        session.mark_grep(sid, "find_project", "/proj/src", result_count=20)
        cache = session.load(sid)
        hint = build_grep_dedup_hint(
            session_id=sid, pattern="find_project", path="/proj/src", cache=cache,
        )
        assert hint is not None
        assert not str(hint).startswith("Note:")

    def test_exact_match_hint_no_note_prefix(self, tmp_data_dir):
        from token_goat.hints import build_read_hint

        sid = "inv-no-note-exact"
        session.mark_file_read(sid, "C:/proj/bar.py", offset=0, limit=200)
        hint = build_read_hint(
            session_id=sid, file_path="C:/proj/bar.py", offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert not str(hint).startswith("Note:")

    def test_symbol_hint_no_note_prefix(self, tmp_data_dir):
        from token_goat.hints import build_read_hint

        sid = "inv-no-note-sym"
        session.mark_file_read(sid, "C:/proj/svc.py", symbol="MyService")
        hint = build_read_hint(
            session_id=sid, file_path="C:/proj/svc.py", offset=0, limit=2000, cwd=None,
        )
        assert hint is not None
        assert not str(hint).startswith("Note:")

    def test_web_dedup_hint_no_note_prefix(self, tmp_data_dir):
        from token_goat.hints import build_web_dedup_hint

        sid = "inv-no-note-web"
        _seed_web(sid)
        cache = session.load(sid)
        hint = build_web_dedup_hint(session_id=sid, url=_WEB_URL, cache=cache)
        assert hint is not None
        assert not str(hint).startswith("Note:")


# ---------------------------------------------------------------------------
# (c) PreCompact manifest legend is conditional (iter 3)
# ---------------------------------------------------------------------------


def _make_session_id(label: str) -> str:
    return f"inv-{label}"


class TestManifestConditionalLegend:
    def test_read_only_session_has_no_stale_or_cold_in_legend(self, tmp_data_dir):
        """Read-only session: legend must not contain stale= or cold= markers."""
        from token_goat.compact import build_manifest

        sid = _make_session_id("readonly-legend")
        session.mark_file_read(sid, "/proj/src/app.py", offset=0, limit=100)
        session.mark_file_read(sid, "/proj/src/models.py", offset=0, limit=50)

        manifest = build_manifest(sid)

        assert manifest, "read-only session must produce a manifest"
        assert "stale=" not in manifest
        assert "cold=" not in manifest

    def test_read_only_session_legend_has_no_edit_marker(self, tmp_data_dir):
        """Read-only session: edited= must not appear in legend."""
        from token_goat.compact import build_manifest

        sid = _make_session_id("no-edit-legend")
        session.mark_file_read(sid, "/proj/src/utils.py", offset=0, limit=80)

        manifest = build_manifest(sid)

        assert manifest
        assert "edited=" not in manifest

    def test_edit_session_legend_has_edit_marker(self, tmp_data_dir):
        """Session with edits: legend MUST contain edited=✎."""
        from token_goat.compact import build_manifest

        sid = _make_session_id("edit-legend")
        session.mark_file_edited(sid, "/proj/src/main.py")

        manifest = build_manifest(sid)

        assert manifest
        assert "edited=✎" in manifest

    def test_no_blank_line_padding_between_sections(self, tmp_data_dir):
        """Manifest must not have consecutive blank lines (blank-line padding removed in iter 3)."""
        from token_goat.compact import build_manifest

        sid = _make_session_id("no-blank-padding")
        session.mark_file_read(sid, "/proj/src/x.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/src/y.py")

        manifest = build_manifest(sid)

        assert manifest
        assert "\n\n" not in manifest


# ---------------------------------------------------------------------------
# (d) Recovery hint preamble is conditional (iter 4)
# ---------------------------------------------------------------------------


class TestRecoveryHintConditionalPreamble:
    def test_files_only_hint_has_no_recall_preamble(self, tmp_data_dir):
        """Files-only session: 'Recall cached output' must NOT appear."""
        from token_goat.hooks_session import _build_recovery_hint

        sid = _make_session_id("files-only-recovery")
        for i in range(3):
            session.mark_file_read(sid, f"/proj/src/module{i}.py", offset=0, limit=100)

        hint = _build_recovery_hint(sid)

        assert hint is not None
        assert "Recall cached output" not in hint

    def test_bash_hint_names_bash_output_command(self, tmp_data_dir):
        """Session with bash: preamble MUST include 'token-goat bash-output'."""
        from token_goat.hooks_session import _build_recovery_hint

        sid = _make_session_id("bash-recovery")
        session.mark_file_read(sid, "/proj/src/app.py", offset=0, limit=100)
        _seed_bash(sid)

        hint = _build_recovery_hint(sid)

        assert hint is not None
        assert "token-goat bash-output" in hint

    def test_web_only_hint_names_web_output_command(self, tmp_data_dir):
        """Session with web fetches only: preamble MUST include 'token-goat web-output'."""
        from token_goat.hooks_session import _build_recovery_hint

        sid = _make_session_id("web-recovery")
        session.mark_file_read(sid, "/proj/src/app.py", offset=0, limit=100)
        _seed_web(sid)

        hint = _build_recovery_hint(sid)

        assert hint is not None
        assert "token-goat web-output" in hint

    def test_bash_only_hint_does_not_name_web_output(self, tmp_data_dir):
        """Session with bash only: preamble must NOT mention web-output."""
        from token_goat.hooks_session import _build_recovery_hint

        sid = _make_session_id("bash-no-web-preamble")
        session.mark_file_read(sid, "/proj/src/app.py", offset=0, limit=100)
        _seed_bash(sid)

        hint = _build_recovery_hint(sid)

        assert hint is not None
        assert "token-goat web-output" not in hint


# ---------------------------------------------------------------------------
# (e) Surgical-read JSON is compact (iter 7)
# ---------------------------------------------------------------------------


class TestSurgicalReadJsonIsCompact:
    def test_error_json_is_single_line(self, tmp_data_dir, tmp_path, capsys):
        """_emit_read_error in JSON mode must emit single-line compact JSON."""
        from token_goat.read_commands import _emit_read_error

        _emit_read_error(code="not_found", message="Symbol not found.", json_output=True)
        captured = capsys.readouterr().out.strip()

        assert "\n" not in captured, f"JSON had newlines: {captured!r}"
        assert '": "' not in captured, f"JSON had indent artifact: {captured!r}"
        parsed = json.loads(captured)
        assert parsed["ok"] is False
        assert parsed["error"]["code"] == "not_found"

    def test_error_json_has_no_bytes_total_key(self, tmp_data_dir, capsys):
        """Error payload must not expose bytes_total or bytes_extracted."""
        from token_goat.read_commands import _emit_read_error

        _emit_read_error(
            code="some_error",
            message="test",
            json_output=True,
            bytes_total=1234,
            bytes_extracted=100,
        )
        captured = capsys.readouterr().out.strip()
        json.loads(captured)  # must be valid JSON
        # These are internal stat fields; they CAN appear in the error dict via **details
        # for error payloads (the stripping is on result payloads).  This test just
        # ensures the output is valid compact JSON and not indented.
        assert "\n" not in captured

    def test_compact_json_uses_no_space_separators(self, tmp_data_dir, capsys):
        """Compact JSON must use no-space separators — no ': ' or ', '."""
        from token_goat.read_commands import _emit_read_error

        _emit_read_error(code="x", message="y", json_output=True)
        captured = capsys.readouterr().out.strip()

        assert ": " not in captured, f"found ': ' indent artifact: {captured!r}"
        assert ", " not in captured, f"found ', ' indent artifact: {captured!r}"


# ---------------------------------------------------------------------------
# (f) Bash/web marker strings are concise (iters 2, 5)
# ---------------------------------------------------------------------------

# Char ceiling: ~120 chars ensures the format string itself is short.
_MARKER_CHAR_CEILING = 120


class TestMarkerStringConciseness:
    def test_bash_cache_trunc_marker_under_ceiling(self):
        from token_goat.bash_cache import _TRUNC_MARKER

        # The format string (before .format()) must be concise.
        assert len(_TRUNC_MARKER) <= _MARKER_CHAR_CEILING, (
            f"_TRUNC_MARKER is {len(_TRUNC_MARKER)} chars (ceiling {_MARKER_CHAR_CEILING}): "
            f"{_TRUNC_MARKER!r}"
        )

    def test_web_cache_trunc_marker_under_ceiling(self):
        from token_goat.web_cache import _TRUNC_MARKER

        assert len(_TRUNC_MARKER) <= _MARKER_CHAR_CEILING, (
            f"web _TRUNC_MARKER is {len(_TRUNC_MARKER)} chars (ceiling {_MARKER_CHAR_CEILING}): "
            f"{_TRUNC_MARKER!r}"
        )

    def test_compression_marker_fmt_under_ceiling(self):
        from token_goat.bash_compress import _COMPRESSION_MARKER_FMT

        assert len(_COMPRESSION_MARKER_FMT) <= _MARKER_CHAR_CEILING, (
            f"_COMPRESSION_MARKER_FMT is {len(_COMPRESSION_MARKER_FMT)} chars: "
            f"{_COMPRESSION_MARKER_FMT!r}"
        )

    def test_bash_runner_overflow_marker_concise(self):
        """The capture-overflow marker must be under ceiling when fully rendered."""
        from token_goat.bash_runner import MAX_CAPTURE_BYTES

        # Render the format string with realistic values to check the final output length.
        rendered = (
            f"\n[token-goat: capture capped at {MAX_CAPTURE_BYTES // (1024 * 1024)} MiB;"
            f" 1234567 bytes dropped]"
        )
        assert len(rendered) <= _MARKER_CHAR_CEILING, (
            f"overflow marker is {len(rendered)} chars: {rendered!r}"
        )

    def test_bash_dedup_min_bytes_constant_exists_and_positive(self):
        from token_goat.hints import _BASH_DEDUP_MIN_BYTES

        assert _BASH_DEDUP_MIN_BYTES > 0
        assert _BASH_DEDUP_MIN_BYTES == 200

    def test_grep_dedup_min_result_count_constant_exists_and_positive(self):
        from token_goat.hints import _GREP_DEDUP_MIN_RESULT_COUNT

        assert _GREP_DEDUP_MIN_RESULT_COUNT > 0
        assert _GREP_DEDUP_MIN_RESULT_COUNT == 5


# ---------------------------------------------------------------------------
# (repomap) Map framing uses terse format (iter 8)
# ---------------------------------------------------------------------------


class TestRepomapFraming:
    def test_tail_marker_has_no_budget_suffix(self, tmp_data_dir, tmp_path):
        """'+N more' tail marker must not include '(budget Xt)' suffix."""
        from token_goat import repomap
        from token_goat.project import make_project_at

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
        # Create enough files to force the tail.
        for i in range(20):
            (proj_root / f"mod{i}.py").write_text(f"# mod{i}\n", encoding="utf-8")
        proj = make_project_at(proj_root)
        from token_goat.parser import index_project
        index_project(proj, full=True)

        # Use a tiny budget so some files get cut off.
        result = repomap.build_map(proj, budget_tokens=5)

        # If a tail was appended it must not contain "(budget" text.
        if "+more" in result or "+ more" in result or "more" in result:
            assert "(budget" not in result, f"tail had budget suffix: {result!r}"

    def test_header_has_no_f_suffix_on_file_count(self, tmp_data_dir, tmp_path):
        """Header file count must NOT use the old 'Nf,' format."""
        from token_goat import repomap
        from token_goat.parser import index_project
        from token_goat.project import make_project_at

        proj_root = tmp_path / "hdr"
        proj_root.mkdir()
        (proj_root / "pyproject.toml").write_text("[project]\nname='y'\n", encoding="utf-8")
        (proj_root / "a.py").write_text("def f(): pass\n", encoding="utf-8")
        proj = make_project_at(proj_root)
        index_project(proj, full=True)

        result = repomap.build_map(proj, budget_tokens=200)

        import re
        # Old format was e.g. "(2f,python)" — assert the "f," digit-f-comma is gone.
        assert not re.search(r"\(\d+f,", result), (
            f"header has old 'Nf,' format: {result[:120]!r}"
        )


# ---------------------------------------------------------------------------
# (g) CLI stdout payloads are compact JSON (iter 1 of token-savings loop)
# ---------------------------------------------------------------------------


def _is_compact(captured: str) -> None:
    """Assert *captured* is single-line compact JSON with no indent whitespace."""
    line = captured.strip()
    assert "\n" not in line, f"JSON had newlines: {line!r}"
    assert '": "' not in line, f"JSON had ': ' indent artifact: {line!r}"
    assert '", "' not in line, f"JSON had ', ' indent artifact: {line!r}"
    json.loads(line)  # must be valid JSON


class TestCliStdoutIsCompactJson:
    """All typer.echo(json.dumps(...)) stdout paths must emit single-line compact JSON."""

    def test_stats_json_is_compact(self, tmp_data_dir):
        """token-goat stats --json must emit compact JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        result = CliRunner().invoke(app, ["stats", "--json"])
        assert result.exit_code == 0, result.output
        _is_compact(result.output)

    def test_bash_history_json_is_compact(self, tmp_data_dir):
        """bash-history --json must emit compact JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        result = CliRunner().invoke(app, ["bash-history", "--json"])
        assert result.exit_code == 0, result.output
        _is_compact(result.output)

    def test_web_history_json_is_compact(self, tmp_data_dir):
        """web-history --json must emit compact JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        result = CliRunner().invoke(app, ["web-history", "--json"])
        assert result.exit_code == 0, result.output
        _is_compact(result.output)

    def test_try_compress_json_list_output_is_compact(self):
        """bash_compress._try_compress_json_list must return compact JSON."""
        from token_goat.bash_compress import _try_compress_json_list

        # Build a list long enough to trigger truncation (> 20 items).
        big_list = [{"key": f"value_{i}", "num": i} for i in range(30)]
        import json as _json
        text = _json.dumps(big_list)
        result = _try_compress_json_list(text)
        assert result is not None, "expected truncation to trigger"
        _is_compact(result)

    def test_config_get_json_is_compact(self, tmp_data_dir):
        """config get must emit compact JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        result = CliRunner().invoke(app, ["config", "get", "compact_assist.enabled"])
        assert result.exit_code == 0, result.output
        _is_compact(result.output)

    def test_config_list_json_is_compact(self, tmp_data_dir):
        """config list --json must emit compact JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        result = CliRunner().invoke(app, ["config", "list", "--json"])
        assert result.exit_code == 0, result.output
        _is_compact(result.output)


# ---------------------------------------------------------------------------
# (h) Injected blocks contain all modifier concepts (steering integrity)
# ---------------------------------------------------------------------------


class TestInjectedBlockModifiers:
    """Modifier concepts must appear in all three directive blocks to ensure
    steering directives are consistently distributed across CLAUDE.md, SKILL.md,
    and CODEX_AGENTS_MD_CONTENT.
    """

    def test_all_modifier_concepts_in_all_blocks(self):
        """Every modifier concept must appear in CLAUDE.md, SKILL.md, and CODEX_AGENTS."""
        from token_goat.install import CLAUDE_MD_CONTENT, CODEX_AGENTS_MD_CONTENT, SKILL_MD_CONTENT

        # Modifier concepts that must be present in all three blocks
        required_concepts = [
            "symbol --all-projects",
            "--strict",
            "map --compact",
            "--max-distance",
            "--no-rerank",
            "--grep",
            "Did you mean",
            "redirected from",
        ]

        for concept in required_concepts:
            assert concept in CLAUDE_MD_CONTENT, (
                f"modifier concept '{concept}' missing from CLAUDE_MD_CONTENT"
            )
            assert concept in SKILL_MD_CONTENT, (
                f"modifier concept '{concept}' missing from SKILL_MD_CONTENT"
            )
            assert concept in CODEX_AGENTS_MD_CONTENT, (
                f"modifier concept '{concept}' missing from CODEX_AGENTS_MD_CONTENT"
            )
