"""Tests for symbol --type filtering, glob patterns, and ranking."""
from __future__ import annotations

from token_goat.cli import (
    _glob_to_sql_like,
    _is_glob_pattern,
    _rank_symbol_results,
    _symbol_kind_filter,
)


class TestIsGlobPattern:
    def test_star_is_glob(self):
        assert _is_glob_pattern("get_*") is True

    def test_question_mark_is_glob(self):
        assert _is_glob_pattern("get_?") is True

    def test_plain_name_is_not_glob(self):
        assert _is_glob_pattern("getUser") is False

    def test_empty_string_is_not_glob(self):
        assert _is_glob_pattern("") is False

    def test_trailing_star_is_glob(self):
        assert _is_glob_pattern("*") is True


class TestGlobToSqlLike:
    def test_star_becomes_percent(self):
        # literal _ is escaped to \_ before * becomes %
        assert _glob_to_sql_like("get_*") == r"get\_%"

    def test_question_becomes_underscore(self):
        # literal _ in the input is escaped to \_ first, then ? becomes _
        assert _glob_to_sql_like("get_?") == r"get\__"

    def test_literal_percent_is_escaped(self):
        assert _glob_to_sql_like("foo%bar") == r"foo\%bar"

    def test_literal_underscore_is_escaped(self):
        assert _glob_to_sql_like("foo_bar") == r"foo\_bar"

    def test_no_special_chars_unchanged(self):
        assert _glob_to_sql_like("getUser") == "getUser"

    def test_prefix_glob(self):
        assert _glob_to_sql_like("get*") == "get%"


class TestSymbolKindFilter:
    def test_fn_expands_to_function(self):
        assert _symbol_kind_filter(["fn"]) == ["function"]

    def test_func_expands_to_function(self):
        assert _symbol_kind_filter(["func"]) == ["function"]

    def test_multiple_kinds_preserved(self):
        result = _symbol_kind_filter(["fn", "class"])
        assert result == ["function", "class"]

    def test_duplicate_deduplication(self):
        result = _symbol_kind_filter(["fn", "func"])
        assert result == ["function"]

    def test_passthrough_for_unknown(self):
        assert _symbol_kind_filter(["method"]) == ["method"]

    def test_case_insensitive(self):
        assert _symbol_kind_filter(["FN"]) == ["function"]

    def test_empty_list(self):
        assert _symbol_kind_filter([]) == []


class TestRankSymbolResults:
    def _make_row(self, name: str, kind: str = "function") -> dict:
        return {"name": name, "kind": kind, "file": "a.py", "line": 1, "signature": ""}

    def test_exact_match_first(self):
        rows = [
            self._make_row("get_user_by_id"),
            self._make_row("get_user"),
            self._make_row("_get_user"),
        ]
        ranked = _rank_symbol_results(rows, "get_user")
        assert ranked[0]["name"] == "get_user"

    def test_prefix_before_substring(self):
        rows = [
            self._make_row("_get_user"),
            self._make_row("get_user_by_id"),
            self._make_row("get_user"),
        ]
        ranked = _rank_symbol_results(rows, "get_user")
        names = [r["name"] for r in ranked]
        assert names[0] == "get_user"
        assert names[1] == "get_user_by_id"
        assert names[2] == "_get_user"

    def test_case_insensitive_tier_assignment(self):
        rows = [
            self._make_row("GetUser"),
            self._make_row("getUser"),
        ]
        ranked = _rank_symbol_results(rows, "getuser")
        assert ranked[0]["name"] in ("GetUser", "getUser")

    def test_glob_query_returns_original_order(self):
        rows = [self._make_row("get_z"), self._make_row("get_a"), self._make_row("get_m")]
        ranked = _rank_symbol_results(rows, "get_*")
        assert [r["name"] for r in ranked] == ["get_z", "get_a", "get_m"]

    def test_empty_results_returns_empty(self):
        assert _rank_symbol_results([], "foo") == []


class TestSymbolTypeFilter:
    """Integration tests for --type via CLI runner with stubbed DB."""

    def _setup(self, monkeypatch):
        from token_goat import cli, read_commands

        fake_rows = [
            {"name": "login", "kind": "function", "file_rel": "auth.py", "line": 10, "signature": "()"},
            {"name": "login", "kind": "method", "file_rel": "auth.py", "line": 50, "signature": "(self)"},
            {"name": "login", "kind": "class", "file_rel": "models.py", "line": 1, "signature": ""},
        ]

        class _FakeRow(dict):
            def __getitem__(self, key):
                return super().__getitem__(key)

        def _fake_query(_hash, sql, params):
            name_q = params[0]
            if "kind IN" in sql:
                allowed = list(params[1:-1])
                return [r for r in fake_rows if r["name"] == name_q and r["kind"] in allowed]
            return [r for r in fake_rows if r["name"] == name_q]

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)
        return cli, _fake_query

    def test_type_filter_fn_excludes_non_functions(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        captured_sql: list[str] = []
        captured_params: list[tuple] = []

        def _recording_query(_hash, sql, params):
            captured_sql.append(sql)
            captured_params.append(params)
            return []

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(cli, "_query_project", _recording_query)
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "login", "--type", "fn"])
        assert result.exit_code == 0
        assert captured_sql, "query should have been called"
        sql = captured_sql[0]
        assert "kind IN" in sql
        params = captured_params[0]
        assert "function" in params

    def test_multiple_type_flags(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        captured_params: list[tuple] = []

        def _recording_query(_hash, sql, params):
            captured_params.append(params)
            return []

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(cli, "_query_project", _recording_query)
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "login", "--type", "fn", "--type", "method"])
        assert result.exit_code == 0
        assert captured_params
        params = captured_params[0]
        assert "function" in params
        assert "method" in params

    def test_no_type_flag_no_kind_clause(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        captured_sql: list[str] = []

        def _recording_query(_hash, sql, params):
            captured_sql.append(sql)
            return []

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(cli, "_query_project", _recording_query)
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "login"])
        assert result.exit_code == 0
        assert "kind IN" not in (captured_sql[0] if captured_sql else "")


class TestSymbolGlobCli:
    """Integration tests for glob pattern support via CLI runner."""

    def test_glob_uses_like_in_sql(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        captured_sql: list[str] = []
        captured_params: list[tuple] = []

        def _recording_query(_hash, sql, params):
            captured_sql.append(sql)
            captured_params.append(params)
            return []

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(cli, "_query_project", _recording_query)
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "get_*"])
        assert result.exit_code == 0
        assert captured_sql
        assert "LIKE" in captured_sql[0]
        # literal _ in the query is escaped to \_ before * becomes %
        assert r"get\_%" in captured_params[0]

    def test_glob_skips_close_match_redirect(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        pool_called = []

        def _fake_pool(_h):
            pool_called.append(True)
            return ["get_user", "set_user"]

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(cli, "_query_project", lambda _h, _s, _p: [])
        monkeypatch.setattr(cli, "_project_symbol_pool", _fake_pool)
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "get_*"])
        assert result.exit_code == 0
        assert not pool_called, "pool should not be queried for glob patterns"

    def test_exact_name_uses_equality(self, tmp_data_dir, monkeypatch):
        from typer.testing import CliRunner

        from token_goat import cli, read_commands

        captured_sql: list[str] = []

        def _recording_query(_hash, sql, params):
            captured_sql.append(sql)
            return []

        monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
        monkeypatch.setattr(cli, "_query_project", _recording_query)
        monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["symbol", "getUser"])
        assert result.exit_code == 0
        assert captured_sql
        assert "LIKE" not in captured_sql[0]
        assert "name = ?" in captured_sql[0]


class _FakeProject:
    hash = "0" * 64
    root = "/fake/root"
    marker = ".git"
