"""Tests for the experimental `token-goat ask` out-of-band Q&A command."""
from __future__ import annotations

import json
import types
import unittest.mock as mock

from typer.testing import CliRunner

from token_goat import ask
from token_goat.cli import app

runner = CliRunner()


def _hit(file_rel: str, start: int, end: int, text: str, distance: float = 0.2) -> types.SimpleNamespace:
    """Build a SearchHit-shaped stub for mocking embeddings.semantic_search."""
    return types.SimpleNamespace(
        file_rel=file_rel, start_line=start, end_line=end, kind="symbol", text=text, distance=distance
    )


def _make_indexed_project(tmp_path, make_project, monkeypatch):
    from token_goat import parser

    proj_root = tmp_path / "proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "a.py").write_text(
        "def drain_queue(q):\n    return q.pop()\n\ndef shrink_image(p):\n    return p\n"
    )
    proj = make_project(proj_root)
    parser.index_project(proj)
    monkeypatch.chdir(proj_root)
    return proj


# ---------------------------------------------------------------------------
# Pure-function unit tests (fast)
# ---------------------------------------------------------------------------

class TestPureHelpers:
    def test_est_tokens_floor_and_empty(self):
        assert ask._est_tokens("") == 0
        assert ask._est_tokens("a") == 1
        assert ask._est_tokens("x" * 40) == 10

    def test_cache_key_is_deterministic(self):
        slices = [ask.Slice("a.py", 1, 5, "body", 0.1)]
        k1 = ask.cache_key("How does X work?", slices, "claude:m")
        k2 = ask.cache_key("how   does x WORK?", slices, "claude:m")  # normalized: same
        assert k1 == k2

    def test_cache_key_changes_when_slice_text_changes(self):
        k_old = ask.cache_key("q", [ask.Slice("a.py", 1, 5, "old body", 0.1)], "claude:m")
        k_new = ask.cache_key("q", [ask.Slice("a.py", 1, 5, "new body", 0.1)], "claude:m")
        assert k_old != k_new

    def test_cache_key_changes_with_backend(self):
        slices = [ask.Slice("a.py", 1, 5, "body", 0.1)]
        assert ask.cache_key("q", slices, "claude:m") != ask.cache_key("q", slices, "codex:m")

    def test_matches_scope_glob_and_substring(self):
        assert ask._matches_scope("src/token_goat/hooks_edit.py", "src/**")
        assert ask._matches_scope("src/token_goat/hooks_edit.py", "hooks")  # bare substring
        assert not ask._matches_scope("src/token_goat/parser.py", "hooks")
        assert ask._matches_scope("a\\b\\c.py", "a/**")  # windows-path normalized

    def test_cap_answer_truncates(self):
        long = "x" * (ask.MAX_ANSWER_CHARS + 500)
        out = ask._cap_answer(long)
        assert out.endswith("… [truncated]")
        assert len(out) < len(long)
        assert ask._cap_answer("short") == "short"


class TestResolveBackend:
    def test_none_when_no_cli_on_path(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        with mock.patch("token_goat.ask.shutil.which", return_value=None):
            assert ask.resolve_backend(None) is None

    def test_claude_defaults_to_haiku_when_unconfigured(self, monkeypatch):
        # No model set: claude (Claude Code) defaults to its cheapest tier, Haiku, so ask works out of the box.
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        with mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/usr/bin/claude" if c == "claude" else None):
            b = ask.resolve_backend(None)
        assert b is not None
        assert b.label == "claude:claude-haiku-4-5"
        assert b.argv == ["/usr/bin/claude", "--print", "--model", "claude-haiku-4-5"]

    def test_codex_defaults_to_own_default_when_unconfigured(self, monkeypatch):
        # No model set, only codex present: token-goat won't guess codex's cheapest, so it runs codex with no --model (codex uses its own default).
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        with mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/usr/bin/codex" if c == "codex" else None):
            b = ask.resolve_backend(None)
        assert b is not None
        assert b.label == "codex:default"
        assert b.argv == ["/usr/bin/codex", "exec"]

    def test_custom_cmd_wins(self, monkeypatch):
        monkeypatch.setenv("TOKEN_GOAT_ASK_CMD", "claude --print")
        b = ask.resolve_backend(None)
        assert b is not None
        assert b.argv == ["claude", "--print"]
        assert b.label.startswith("custom:")

    def test_model_resolves_claude(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "claude-haiku-4-5")
        with mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/usr/bin/claude" if c == "claude" else None):
            b = ask.resolve_backend(None)
        assert b is not None
        assert b.argv[0] == "/usr/bin/claude"  # regression: resolved path, not bare "claude"
        assert b.argv[1] == "--print"
        assert "claude-haiku-4-5" in b.argv

    def test_uses_resolved_cmd_path_not_bare_name(self, monkeypatch):
        # Regression: on Windows the CLI is claude.CMD; subprocess (CreateProcess) cannot launch a bare "claude", so resolve_backend must put the full resolved path in argv[0].
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "m")
        cmd_path = r"C:\Users\me\AppData\Roaming\npm\claude.CMD"
        with mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: cmd_path if c == "claude" else None):
            b = ask.resolve_backend(None)
        assert b is not None
        assert b.argv[0] == cmd_path
        assert b.argv[0] != "claude"

    def test_model_falls_back_to_codex(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "gpt-x")
        with mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/usr/bin/codex" if c == "codex" else None):
            b = ask.resolve_backend(None)
        assert b is not None
        assert b.argv[0] == "/usr/bin/codex"
        assert b.argv[1] == "exec"

    def test_model_set_but_no_cli_degrades(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "whatever")
        with mock.patch("token_goat.ask.shutil.which", return_value=None):
            assert ask.resolve_backend(None) is None

    def test_model_override_beats_env(self, monkeypatch):
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "env-model")
        with mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/x/claude" if c == "claude" else None):
            b = ask.resolve_backend("override-model")
        assert b is not None
        assert "override-model" in b.argv
        assert "env-model" not in b.argv


class TestSynthesize:
    def test_synthesize_returns_stdout(self):
        completed = types.SimpleNamespace(returncode=0, stdout="  the answer  ", stderr="")
        with mock.patch("token_goat.ask.subprocess.run", return_value=completed):
            out = ask.synthesize("prompt", ask.Backend("claude:m", ["claude", "--print"]), timeout=5)
        assert out == "the answer"

    def test_synthesize_raises_on_nonzero(self):
        completed = types.SimpleNamespace(returncode=1, stdout="", stderr="boom")
        with mock.patch("token_goat.ask.subprocess.run", return_value=completed):
            try:
                ask.synthesize("p", ask.Backend("claude:m", ["claude"]), timeout=5)
                raise AssertionError("expected RuntimeError")
            except RuntimeError as e:
                assert "boom" in str(e)

    def test_synthesize_raises_on_empty(self):
        completed = types.SimpleNamespace(returncode=0, stdout="   ", stderr="")
        with mock.patch("token_goat.ask.subprocess.run", return_value=completed):
            try:
                ask.synthesize("p", ask.Backend("claude:m", ["claude"]), timeout=5)
                raise AssertionError("expected RuntimeError")
            except RuntimeError:
                pass


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------

class TestAskCLI:
    def test_no_project(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["ask", "anything"])
        assert result.exit_code != 0
        assert "project" in result.output.lower()

    def test_empty_question(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        result = runner.invoke(app, ["ask", "   "])
        assert result.exit_code != 0

    def test_no_context_message(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        with mock.patch("token_goat.embeddings.semantic_search", return_value=[]):
            result = runner.invoke(app, ["ask", "zzz no match qqx"])
        assert result.exit_code == 0
        assert "no relevant indexed context" in result.output.lower()

    def test_degrade_when_no_backend(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        hits = [_hit("a.py", 1, 2, "def drain_queue(q):\n    return q.pop()\n")]
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", return_value=None),
        ):
            result = runner.invoke(app, ["ask", "how does the queue drain?"])
        assert result.exit_code == 0
        assert "no synthesis backend" in result.output.lower()
        assert 'token-goat read "a.py::1-2"' in result.output

    def test_degrade_json_shape(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        hits = [_hit("a.py", 1, 2, "body text here")]
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", return_value=None),
        ):
            result = runner.invoke(app, ["ask", "q", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["synthesized"] is False
        assert data["answer"] is None
        assert data["backend"] is None
        assert data["citations"][0]["file"] == "a.py"
        assert data["entries"][0]["start_line"] == 1

    def test_scope_filters_hits(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        hits = [_hit("a.py", 1, 2, "aaa"), _hit("other/b.py", 3, 4, "bbb")]
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", return_value=None),
        ):
            result = runner.invoke(app, ["ask", "q", "--scope", "other/**", "--json"])
        data = json.loads(result.output.strip())
        files = [c["file"] for c in data["citations"]]
        assert files == ["other/b.py"]

    def test_synthesis_path(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "claude-haiku-4-5")
        hits = [_hit("a.py", 1, 2, "def drain_queue(q):\n    return q.pop()\n")]
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/x/claude" if c == "claude" else None),
            mock.patch("token_goat.ask.synthesize", return_value="It pops the last item."),
        ):
            result = runner.invoke(app, ["ask", "how does the queue drain?", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["synthesized"] is True
        assert data["cached"] is False
        assert data["answer"] == "It pops the last item."
        assert data["backend"] == "claude:claude-haiku-4-5"
        assert data["citations"][0]["file"] == "a.py"
        assert data["saved_tokens"] >= 0

    def test_synthesis_failure_degrades(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "m")
        hits = [_hit("a.py", 1, 2, "body")]
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/x/claude" if c == "claude" else None),
            mock.patch("token_goat.ask.synthesize", side_effect=RuntimeError("backend down")),
        ):
            result = runner.invoke(app, ["ask", "q", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["synthesized"] is False
        assert "synthesis unavailable" in data["notice"].lower()

    def test_cache_hit_skips_backend(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "claude-haiku-4-5")
        hits = [_hit("a.py", 1, 2, "def drain_queue(q):\n    return q.pop()\n")]
        synth = mock.Mock(return_value="cached answer body")
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/x/claude" if c == "claude" else None),
            mock.patch("token_goat.ask.synthesize", synth),
        ):
            r1 = runner.invoke(app, ["ask", "how does the queue drain?", "--json"])
            r2 = runner.invoke(app, ["ask", "how does the queue drain?", "--json"])
        assert r1.exit_code == 0 and r2.exit_code == 0
        assert synth.call_count == 1  # second call served from cache
        d2 = json.loads(r2.output.strip())
        assert d2["cached"] is True
        assert d2["answer"] == "cached answer body"

    def test_no_cache_flag_bypasses_cache(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.setenv("TOKEN_GOAT_ASK_MODEL", "m")
        hits = [_hit("a.py", 1, 2, "body")]
        synth = mock.Mock(return_value="fresh answer")
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", side_effect=lambda c: "/x/claude" if c == "claude" else None),
            mock.patch("token_goat.ask.synthesize", synth),
        ):
            runner.invoke(app, ["ask", "q", "--no-cache", "--json"])
            runner.invoke(app, ["ask", "q", "--no-cache", "--json"])
        assert synth.call_count == 2  # --no-cache forces re-synthesis both times

    def test_show_sources_dumps_slices(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        _make_indexed_project(tmp_path, make_project, monkeypatch)
        monkeypatch.delenv("TOKEN_GOAT_ASK_MODEL", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_ASK_CMD", raising=False)
        hits = [_hit("a.py", 1, 2, "UNIQUE_SLICE_MARKER body")]
        with (
            mock.patch("token_goat.embeddings.semantic_search", return_value=hits),
            mock.patch("token_goat.ask.shutil.which", return_value=None),
        ):
            result = runner.invoke(app, ["ask", "q", "--show-sources"])
        assert "UNIQUE_SLICE_MARKER" in result.output
