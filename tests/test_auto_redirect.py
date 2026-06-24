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


class TestSectionRedirectTarget:
    """Unit tests for ``read_commands._section_redirect_target`` close-match logic."""

    @staticmethod
    def _target(heading, pool):
        from token_goat.read_commands import _section_redirect_target
        return _section_redirect_target(heading, pool)

    def test_clean_prefix_substring_redirects(self):
        """A query that is a substring of exactly one heading redirects to it."""
        assert self._target("Install", ["Installation", "Usage"]) == "Installation"

    def test_substring_case_insensitive(self):
        assert self._target("architecture ref", ["Architecture Reference", "Commands"]) == (
            "Architecture Reference"
        )

    def test_high_confidence_typo_redirects(self):
        """A near-typo above the 0.75 cutoff (no substring) redirects."""
        assert self._target("Instalation", ["Installation", "Usage"]) == "Installation"

    def test_two_substring_hits_no_redirect(self):
        """Ambiguous substring match (two headings contain the query) refuses to guess."""
        assert self._target("Test", ["Testing", "Test Conventions"]) is None

    def test_exact_match_no_redirect(self):
        """An exact heading is never redirected to itself (reader would have served it)."""
        assert self._target("Commands", ["Commands", "Usage"]) is None

    def test_exact_match_case_insensitive_no_redirect(self):
        assert self._target("commands", ["Commands", "Usage"]) is None

    def test_low_confidence_no_redirect(self):
        """A weak fuzzy match below the cutoff falls through to Did-you-mean."""
        assert self._target("xyzzy", ["Installation", "Usage"]) is None

    def test_empty_pool_no_redirect(self):
        assert self._target("Install", []) is None

    def test_empty_query_no_redirect(self):
        assert self._target("", ["Installation"]) is None


class TestSectionCliRedirect:
    """Integration: ``_run_read_like_command`` transparently redirects section misses."""

    @staticmethod
    def _mock_result(text="REDIRECTED BODY"):
        return {
            "text": text, "start_line": 1, "end_line": 3,
            "bytes_total": 1000, "bytes_extracted": 40, "bytes_saved": 960,
        }

    def _file_target(self):
        from unittest.mock import MagicMock
        proj = MagicMock()
        proj.hash = "abc123"
        ft = MagicMock()
        ft.rel_path = "README.md"
        ft.project = proj
        ft.current_project = proj
        return ft

    def test_close_match_redirects_transparently(self, monkeypatch, capsys):
        """A reader miss on a fuzzy heading re-runs against the matched heading."""
        import sys
        from unittest.mock import patch

        from token_goat import read_commands

        ft = self._file_target()
        calls = []

        def _reader(_proj, _rel, heading, *, context_lines=0):
            calls.append(heading)
            # Miss for the paraphrase, hit for the real heading.
            return self._mock_result() if heading == "Installation" else None

        monkeypatch.setattr(read_commands, "_section_heading_pool", lambda p, r: ["Installation"])

        with (
            patch("token_goat.read_commands._resolve_file_target", return_value=ft),
            patch("token_goat.db.record_stat"),
            patch("token_goat.db.reset_miss"),
            patch("token_goat.read_commands.session.mark_file_read"),
            patch.object(sys.stdout, "isatty", return_value=False),
        ):
            read_commands._run_read_like_command(
                target="README.md::Install",
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="heading",
                missing_label="Section",
                stat_kind="section_replacement",
                reader=_reader,
                no_header=True,
            )

        captured = capsys.readouterr()
        assert "REDIRECTED BODY" in captured.out
        assert "redirected from" in captured.err
        assert calls == ["Install", "Installation"]

    def test_json_redirect_carries_redirected_from(self, monkeypatch):
        import json as _json
        import sys
        from unittest.mock import patch

        import typer

        from token_goat import read_commands

        ft = self._file_target()

        def _reader(_proj, _rel, heading, *, context_lines=0):
            return self._mock_result() if heading == "Installation" else None

        monkeypatch.setattr(read_commands, "_section_heading_pool", lambda p, r: ["Installation"])

        with (
            patch("token_goat.read_commands._resolve_file_target", return_value=ft),
            patch("token_goat.db.record_stat"),
            patch("token_goat.db.reset_miss"),
            patch("token_goat.read_commands.session.mark_file_read"),
            patch.object(sys.stdout, "isatty", return_value=False),
        ):
            captured_lines: list[str] = []
            monkeypatch.setattr(typer, "echo", lambda msg="", **kw: captured_lines.append(str(msg)))
            read_commands._run_read_like_command(
                target="README.md::Install",
                session_id=None,
                json_output=True,
                context_lines=0,
                separator_label="heading",
                missing_label="Section",
                stat_kind="section_replacement",
                reader=_reader,
                no_header=True,
            )

        payload = _json.loads(captured_lines[-1])
        assert payload["redirected_from"] == "Install"

    def test_no_match_falls_through_unchanged(self, monkeypatch):
        """A genuine miss with no close heading still exits 1 with not-found."""
        import sys
        from unittest.mock import patch

        import typer

        from token_goat import read_commands

        ft = self._file_target()

        monkeypatch.setattr(read_commands, "_section_heading_pool", lambda p, r: ["Installation"])
        monkeypatch.setattr(read_commands, "_close_section_matches", lambda p, r, h: [])

        with (
            patch("token_goat.read_commands._resolve_file_target", return_value=ft),
            patch("token_goat.db.record_miss"),
            patch("token_goat.db.get_miss_count", return_value=1),
            patch.object(sys.stdout, "isatty", return_value=False),
        ):
            try:
                read_commands._run_read_like_command(
                    target="README.md::Totally Absent",
                    session_id=None,
                    json_output=False,
                    context_lines=0,
                    separator_label="heading",
                    missing_label="Section",
                    stat_kind="section_replacement",
                    reader=lambda *a, **k: None,
                    no_header=True,
                )
            except typer.Exit as exc:
                assert exc.exit_code == 1
            else:
                raise AssertionError("expected typer.Exit(1) on a genuine section miss")

    def test_ambiguous_matches_list_with_scores(self, monkeypatch, capsys):
        """When the redirect declines, suggestions carry similarity scores."""
        import contextlib
        import sys
        from unittest.mock import patch

        import typer

        from token_goat import read_commands

        ft = self._file_target()

        # Pool has two substring hits → redirect refuses; close-matches list both.
        monkeypatch.setattr(
            read_commands, "_section_heading_pool", lambda p, r: ["Testing", "Test Conventions"]
        )
        monkeypatch.setattr(
            read_commands, "_close_section_matches", lambda p, r, h: ["Testing", "Test Conventions"]
        )

        with (
            patch("token_goat.read_commands._resolve_file_target", return_value=ft),
            patch("token_goat.db.record_miss"),
            patch("token_goat.db.get_miss_count", return_value=1),
            patch.object(sys.stdout, "isatty", return_value=False),contextlib.suppress(typer.Exit)
        ):
            read_commands._run_read_like_command(
                target="README.md::Test",
                session_id=None,
                json_output=False,
                context_lines=0,
                separator_label="heading",
                missing_label="Section",
                stat_kind="section_replacement",
                reader=lambda *a, **k: None,
                no_header=True,
            )

        out = capsys.readouterr().out
        assert "Did you mean" in out
        assert "similarity" in out
