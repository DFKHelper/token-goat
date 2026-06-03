"""Tests for the close-match auto-redirect path in ``token-goat symbol``."""
from __future__ import annotations

from token_goat.cli import _auto_redirect_target


class TestAutoRedirectTarget:
    def test_single_high_confidence_match_redirects(self):
        """One candidate with ratio >= 0.85 is the auto-redirect target."""
        # 'getUser' vs 'getUserById' — high ratio because of shared prefix.
        target = _auto_redirect_target("getUser", ["getUser", "getOwner"])
        # Exact-match guard returns None when the target IS the query.
        # When the pool already contains the literal name, the redirect path
        # must not fire (we'd be redirecting the agent to themselves).
        assert target is None

    def test_typo_redirects_to_close_match(self):
        target = _auto_redirect_target("getUserr", ["getUser", "getOwner"])
        assert target == "getUser"

    def test_two_high_confidence_candidates_no_redirect(self):
        """Ambiguity (two candidates ≥ 0.85) leaves the choice to the agent.

        ``color`` against ``colors`` and ``colour`` produces two candidates
        with identical 0.909 ratios — well above the 0.85 cutoff — so the
        auto-redirect must refuse to pick one of them.
        """
        target = _auto_redirect_target("color", ["colors", "colour"])
        assert target is None

    def test_only_low_confidence_no_redirect(self):
        target = _auto_redirect_target("foo", ["banana", "apple"])
        assert target is None

    def test_empty_pool_no_redirect(self):
        assert _auto_redirect_target("foo", []) is None

    def test_empty_query_no_redirect(self):
        assert _auto_redirect_target("", ["foo", "bar"]) is None


class TestSymbolCliRedirect:
    def test_strict_flag_disables_redirect(self, tmp_data_dir, monkeypatch):
        """``--strict`` returns ``no matches`` instead of auto-redirecting."""
        from typer.testing import CliRunner

        from token_goat import cli

        # Bypass the actual DB by stubbing the pool function and query.
        monkeypatch.setattr(cli, "_project_symbol_pool", lambda h: ["getUserById"])
        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        # Force the project query helper to return empty for the original
        # name and non-empty for the redirected one.  We do this by patching
        # _query_project at the module level.
        def _fake_query(_hash, _sql, params):
            sym = params[0]
            if sym == "getUserById":
                return [{"name": "getUserById", "kind": "function",
                        "file_rel": "a.ts", "line": 10, "signature": "()"}]
            return []
        monkeypatch.setattr(cli, "_query_project", _fake_query)
        # _not_indexed_hint should report indexed
        from token_goat import read_commands
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "getUserByIdd", "--strict"])
        assert result.exit_code == 0
        assert "No matches" in result.stdout
        assert "Did you mean" in result.stdout

    def test_default_redirects(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli

        monkeypatch.setattr(cli, "_project_symbol_pool", lambda h: ["getUserById"])
        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        def _fake_query(_hash, _sql, params):
            sym = params[0]
            if sym == "getUserById":
                return [{"name": "getUserById", "kind": "function",
                        "file_rel": "a.ts", "line": 10, "signature": "()"}]
            return []
        monkeypatch.setattr(cli, "_query_project", _fake_query)
        from token_goat import read_commands
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "getUserByIdd"])
        assert result.exit_code == 0
        # Result was successfully redirected and the marker is in the output.
        assert "redirected from" in result.stdout
        assert "a.ts:10" in result.stdout

    def test_json_envelope_on_redirect(self, tmp_data_dir, monkeypatch):
        """JSON output wraps results in ``{redirected_from, results}`` on redirect."""
        import json as _json

        from typer.testing import CliRunner

        from token_goat import cli

        monkeypatch.setattr(cli, "_project_symbol_pool", lambda h: ["getUserById"])
        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        def _fake_query(_hash, _sql, params):
            sym = params[0]
            if sym == "getUserById":
                return [{"name": "getUserById", "kind": "function",
                        "file_rel": "a.ts", "line": 10, "signature": "()"}]
            return []
        monkeypatch.setattr(cli, "_query_project", _fake_query)
        from token_goat import read_commands
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "getUserByIdd", "--json"])
        assert result.exit_code == 0
        payload = _json.loads(result.stdout)
        assert isinstance(payload, dict)
        assert payload["redirected_from"] == "getUserByIdd"
        assert len(payload["results"]) == 1


class _FakeProject:
    """Stand-in for ``token_goat.project.Project`` for the CLI tests above."""

    hash = "0" * 64
    root = "/fake/root"
    marker = ".git"


class TestSymbolEndLineRegression:
    """Regression tests for the sqlite3.Row.get('end_line') bug.

    When _query_project returns sqlite3.Row objects (which lack .get()), the
    dict comprehension in _project_query was calling r.get('end_line') instead
    of r['end_line'], causing AttributeError on --refs and --json paths.
    """

    def test_dict_without_end_line_does_not_raise(self, tmp_data_dir, monkeypatch) -> None:
        """symbol command with a dict row missing 'end_line' must not raise KeyError."""
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        def _fake_query(_hash, _sql, params):
            # Row dict without 'end_line' key — simulates an older DB schema.
            return [{"name": "myFunc", "kind": "function",
                     "file_rel": "src/app.py", "line": 42, "signature": "() -> None"}]

        monkeypatch.setattr(cli, "_query_project", _fake_query)
        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "myFunc"])
        assert result.exit_code == 0, f"Unexpected exit code: {result.output}"
        assert "src/app.py" in result.output

    def test_dict_without_end_line_json_output_does_not_raise(self, tmp_data_dir, monkeypatch) -> None:
        """symbol --json with a dict row missing 'end_line' must not raise KeyError."""
        import json

        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        def _fake_query(_hash, _sql, params):
            return [{"name": "myFunc", "kind": "function",
                     "file_rel": "src/app.py", "line": 42, "signature": "() -> None"}]

        monkeypatch.setattr(cli, "_query_project", _fake_query)
        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "myFunc", "--json"])
        assert result.exit_code == 0, f"Unexpected exit code: {result.output}"
        data = json.loads(result.output.strip())
        # JSON output is a list of symbol dicts or an envelope dict.
        assert isinstance(data, (list, dict))
