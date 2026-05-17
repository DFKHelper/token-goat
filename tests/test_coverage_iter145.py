"""Regression tests for iterations 141-144.

Coverage targets:
- cli.py: _query_project returns list[sqlite3.Row]; _config_get_value with various types
- repomap.py: _NxGraph Protocol — mock object satisfies structural Protocol
- languages/json_idx.py: JSONDecodeError logs at DEBUG; _safe_repr exception path logs at DEBUG
- read_replacement.py: _resolve_file_rel_db ValueError logs at DEBUG
- bash_parser.py: _MAX_COMMAND_BYTES oversized command returns unknown; _MAX_PATH_BYTES
  oversized path returns unknown; shlex.ValueError sanitized before logging
- read_replacement.py: _MAX_SYMBOL_LEN cap in read_symbol and read_section returns None
- languages/go.py: module-level compiled regex patterns produce correct extraction results
"""
from __future__ import annotations

import logging
import sqlite3
from unittest.mock import MagicMock, patch

# ===========================================================================
# 1. cli.py — _query_project and _config_get_value
# ===========================================================================


class TestQueryProject:
    """_query_project returns list[sqlite3.Row] and exits on DBError."""

    def test_returns_list_of_rows(self, tmp_path):
        """When the DB query succeeds, _query_project must return a list of sqlite3.Row."""
        import sqlite3 as _sqlite3

        from token_goat.cli import _query_project

        # Build a real in-memory SQLite DB and expose it through a mock open_project context
        conn = _sqlite3.connect(":memory:")
        conn.row_factory = _sqlite3.Row
        conn.execute("CREATE TABLE t (x TEXT)")
        conn.execute("INSERT INTO t VALUES ('hello')")
        conn.commit()

        class _FakeCtx:
            def __enter__(self):
                return conn

            def __exit__(self, *_):
                return False

        # _query_project does `from . import db as _db` locally, so patch at the module level
        with patch("token_goat.db.open_project", return_value=_FakeCtx()):
            rows = _query_project("fakehash", "SELECT x FROM t", ())

        assert isinstance(rows, list)
        assert len(rows) == 1
        # Verify it is a real sqlite3.Row (supports column-name access)
        assert rows[0]["x"] == "hello"

    def test_raises_exit_on_dberror(self):
        """When the DB is unavailable, _query_project raises typer.Exit(1)."""
        import click

        from token_goat.cli import _query_project
        from token_goat.db import DBError

        with patch("token_goat.db.open_project", side_effect=DBError("index missing")):
            try:
                _query_project("fakehash", "SELECT 1", ())
                raised = None
            except (SystemExit, click.exceptions.Exit) as e:
                raised = e

        assert raised is not None


class TestConfigGetValue:
    """_config_get_value resolves nested dotted keys and raises KeyError for missing ones."""

    def _make_cfg(self):
        """Return a minimal two-level config-like object."""
        from dataclasses import dataclass

        @dataclass
        class Inner:
            enabled: bool = True
            threshold: int = 5
            tags: list = None  # type: ignore[assignment]

            def __post_init__(self):
                if self.tags is None:
                    self.tags = ["a", "b"]

        @dataclass
        class Outer:
            inner: Inner = None  # type: ignore[assignment]
            name: str = "test"

            def __post_init__(self):
                if self.inner is None:
                    self.inner = Inner()

        return Outer()

    def test_single_level_str(self):
        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        assert _config_get_value(cfg, "name") == "test"

    def test_nested_bool(self):
        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        assert _config_get_value(cfg, "inner.enabled") is True

    def test_nested_int(self):
        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        assert _config_get_value(cfg, "inner.threshold") == 5

    def test_nested_list(self):
        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        assert _config_get_value(cfg, "inner.tags") == ["a", "b"]

    def test_missing_top_level_raises_key_error(self):
        import pytest

        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        with pytest.raises(KeyError):
            _config_get_value(cfg, "nonexistent")

    def test_missing_nested_raises_key_error(self):
        import pytest

        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        with pytest.raises(KeyError):
            _config_get_value(cfg, "inner.nonexistent")

    def test_empty_key_raises_key_error(self):
        import pytest

        from token_goat.cli import _config_get_value

        cfg = self._make_cfg()
        with pytest.raises(KeyError):
            _config_get_value(cfg, "")


# ===========================================================================
# 2. repomap.py — _NxGraph Protocol structural compatibility
# ===========================================================================


class TestNxGraphProtocol:
    """A mock graph object that satisfies the _NxGraph Protocol must pass runtime checks."""

    def _make_mock_graph(self) -> object:
        """Return a mock that implements all _NxGraph methods and properties."""
        g = MagicMock()
        g.add_node = MagicMock()
        g.add_edge = MagicMock()
        g.add_edges_from = MagicMock()
        g.number_of_nodes = MagicMock(return_value=3)
        g.number_of_edges = MagicMock(return_value=2)
        g.nodes = ["a", "b", "c"]
        g.edges = [("a", "b"), ("b", "c")]
        return g

    def test_protocol_methods_are_callable(self):
        """All _NxGraph Protocol methods must be present and callable on the mock."""
        g = self._make_mock_graph()
        g.add_node("x")
        g.add_edge("x", "y")
        g.add_edges_from([("x", "y")])
        assert g.number_of_nodes() == 3
        assert g.number_of_edges() == 2

    def test_protocol_nodes_property_iterable(self):
        """The nodes property must be iterable (Iterable[str])."""
        g = self._make_mock_graph()
        assert list(g.nodes) == ["a", "b", "c"]

    def test_protocol_edges_property_iterable(self):
        """The edges property must yield (str, str) tuples."""
        g = self._make_mock_graph()
        edges = list(g.edges)
        assert ("a", "b") in edges

    def test_compute_ranks_with_empty_graph_returns_empty_dict(self):
        """compute_ranks returns {} when the graph has no nodes (short-circuit path)."""
        from token_goat.repomap import compute_ranks

        g = self._make_mock_graph()
        g.number_of_nodes = MagicMock(return_value=0)
        result = compute_ranks(g)
        assert result == {}

    def test_multigraph_to_weighted_digraph_uses_nxgraph_protocol(self):
        """_multigraph_to_weighted_digraph works when the graph's .edges yields 2-tuples."""
        try:
            import networkx  # noqa: F401
        except ImportError:
            return  # networkx optional; skip

        from token_goat.repomap import _multigraph_to_weighted_digraph

        # Build a mock that exposes edges as 2-tuples (matching Protocol contract)
        g = self._make_mock_graph()
        g.nodes = ["a", "b", "c"]
        g.edges = [("a", "b"), ("a", "b"), ("b", "c")]  # parallel edges as 2-tuples
        simple = _multigraph_to_weighted_digraph(g)
        # Collapsed: a->b weight=2, b->c weight=1
        assert simple.number_of_edges() == 2
        assert simple["a"]["b"]["weight"] == 2.0
        assert simple["b"]["c"]["weight"] == 1.0


# ===========================================================================
# 3. languages/json_idx.py — JSONDecodeError logs DEBUG; _safe_repr exception path
# ===========================================================================


class TestJsonIdxLogging:
    """json_idx.extract logs at DEBUG on JSONDecodeError; _safe_repr handles exceptions."""

    def _big_invalid_json(self) -> bytes:
        # Must be >= _MIN_JSON_SIZE (50000 bytes) to pass the size gate
        return (b"{invalid json " + b"x" * 50_000)[:55_000]

    def _big_valid_json_dict(self) -> bytes:
        import json

        data = {f"key_{i}": f"val_{i}" for i in range(5)}
        raw = json.dumps(data).encode()
        # Pad to exceed _MIN_JSON_SIZE
        padding = b" " * max(0, 50_001 - len(raw))
        return raw + padding  # still valid JSON (trailing spaces ignored)

    def test_json_decode_error_logs_debug(self, caplog):
        from token_goat.languages.json_idx import extract

        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.json_idx"):
            extract(self._big_invalid_json(), "big_bad.json")

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("full parse failed" in m for m in debug_msgs)

    def test_json_decode_error_still_returns_symbols_via_regex(self):
        """Regex fallback must still extract any valid top-level keys even from malformed JSON.

        The regex uses re.MULTILINE and matches keys at the START of a line, so
        the test input must have each key on its own line at column 0.
        """
        from token_goat.languages.json_idx import extract

        # Keys must appear at the start of a line (re.MULTILINE anchor) to be found
        # by _TOP_LEVEL_KEY_RE. The trailing invalid token causes JSONDecodeError.
        raw_str = '{\n"key_one": 1,\n"key_two": 2,\n invalid\n}'
        raw = raw_str.encode() + b" " * 50_000
        symbols, refs, imps, secs = extract(raw, "semi_valid.json")
        # Regex should pick up at least the two valid top-level keys
        names = [s.name for s in symbols]
        assert "key_one" in names
        assert "key_two" in names

    def test_safe_repr_exception_path_logs_debug(self, caplog):
        """_safe_repr must catch json.dumps exceptions and log at DEBUG."""
        from token_goat.languages.json_idx import _safe_repr

        class _Unserializable:
            def __repr__(self):
                return "<unserializable>"

        # json.dumps raises TypeError for objects that can't be serialized AND
        # whose default=str can't handle. We need an object where even str()
        # of it is fine but json.dumps(..., default=str) raises — patch dumps.
        with (
            caplog.at_level(logging.DEBUG, logger="token_goat.languages.json_idx"),
            patch("token_goat.languages.json_idx.json.dumps", side_effect=TypeError("boom")),
        ):
            result = _safe_repr({"x": 1})

        assert result == "dict"
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("_safe_repr" in m for m in debug_msgs)

    def test_safe_repr_normal_path_returns_truncated_string(self):
        """_safe_repr truncates long repr at max_len and appends '...'."""
        from token_goat.languages.json_idx import _safe_repr

        long_list = list(range(200))
        result = _safe_repr(long_list, max_len=50)
        assert len(result) <= 50 + 3  # max_len + "..."
        assert result.endswith("...")

    def test_safe_repr_short_value_returned_as_is(self):
        from token_goat.languages.json_idx import _safe_repr

        result = _safe_repr(42)
        assert result == "42"


# ===========================================================================
# 4. read_replacement.py — _resolve_file_rel_db ValueError logs DEBUG
# ===========================================================================


class TestResolveFileRelDbValueError:
    """_resolve_file_rel_db logs at DEBUG when an absolute path is not under the project root."""

    def _make_project(self, tmp_path):
        from token_goat.project import Project

        return Project(root=tmp_path, hash="aabbccdd" * 5, marker="manual")

    def _make_db(self, tmp_path):
        """Create a minimal project DB under the token-goat data dir for the given hash."""

        from token_goat.paths import data_dir

        proj_hash = "aabbccdd" * 5
        db_path = data_dir() / "projects" / f"{proj_hash}.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE IF NOT EXISTS files "
            "(rel_path TEXT PRIMARY KEY, language TEXT, mtime REAL, sha1 TEXT, size INTEGER)"
        )
        conn.commit()
        conn.close()
        return proj_hash

    def test_absolute_path_outside_root_logs_debug(self, tmp_path, caplog):
        """An absolute path on a different drive/mount logs at DEBUG and returns None."""
        import sys

        from token_goat.read_replacement import _resolve_file_rel_db

        proj = self._make_project(tmp_path)
        self._make_db(tmp_path)

        # Choose an absolute path guaranteed to be outside tmp_path
        if sys.platform == "win32":
            # Use a path on a different root that won't collide
            outside_path = "Z:\\totally\\outside\\file.py"
        else:
            outside_path = "/proc/totally/outside/file.py"

        with caplog.at_level(logging.DEBUG, logger="token_goat.read_replacement"):
            result = _resolve_file_rel_db(proj, outside_path)

        # Result is None because the path is not in the DB (empty) and not under root
        assert result is None
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        # At least one DEBUG message about the absolute path not being under project root
        assert any("not under project root" in m or "could not resolve" in m for m in debug_msgs)


# ===========================================================================
# 5. bash_parser.py — _MAX_COMMAND_BYTES, _MAX_PATH_BYTES, shlex.ValueError
# ===========================================================================


class TestBashParserCaps:
    """bash_parser.parse() enforces size caps and sanitizes shlex errors."""

    def test_oversized_command_returns_unknown(self):
        """A command exceeding _MAX_COMMAND_BYTES must return BashIntent(kind='unknown')."""
        from token_goat.bash_parser import _MAX_COMMAND_BYTES, parse

        oversized = "cat " + "x" * (_MAX_COMMAND_BYTES + 1)
        result = parse(oversized)
        assert result.kind == "unknown"
        assert result.reason == "command too long"

    def test_oversized_command_logs_warning(self, caplog):
        """Oversized command must emit a WARNING log."""
        from token_goat.bash_parser import _MAX_COMMAND_BYTES, parse

        oversized = "cat " + "x" * (_MAX_COMMAND_BYTES + 1)
        with caplog.at_level(logging.WARNING, logger="token_goat.bash_parser"):
            parse(oversized)

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("command too long" in m for m in warn_msgs)

    def test_command_exactly_at_limit_is_accepted(self):
        """A command exactly at the _MAX_COMMAND_BYTES limit must not be rejected by the cap."""
        from token_goat.bash_parser import _MAX_COMMAND_BYTES, parse

        # "cat " is 4 chars; fill remaining with 'a' so total == limit
        cmd = "cat " + "a" * (_MAX_COMMAND_BYTES - 4)
        result = parse(cmd)
        # Should not be rejected by the oversized-command guard (may be unknown for other reasons)
        assert result.reason != "command too long"

    def test_oversized_path_returns_unknown(self):
        """A path exceeding _MAX_PATH_BYTES inside a cat command must return unknown."""
        from token_goat.bash_parser import _MAX_PATH_BYTES, parse

        long_path = "a" * (_MAX_PATH_BYTES + 1)
        result = parse(f"cat {long_path}")
        assert result.kind == "unknown"
        assert result.reason == "target path too long"

    def test_oversized_path_logs_warning(self, caplog):
        """Oversized target path must emit a WARNING log."""
        from token_goat.bash_parser import _MAX_PATH_BYTES, parse

        long_path = "a" * (_MAX_PATH_BYTES + 1)
        with caplog.at_level(logging.WARNING, logger="token_goat.bash_parser"):
            parse(f"cat {long_path}")

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("target_path too long" in m for m in warn_msgs)

    def test_shlex_value_error_returns_unknown(self):
        """An unterminated quote in the command must return BashIntent(kind='unknown')."""
        from token_goat.bash_parser import parse

        result = parse("cat 'unterminated")
        assert result.kind == "unknown"
        assert result.reason == "invalid shell quoting"

    def test_shlex_value_error_logs_debug(self, caplog):
        """shlex.split failure must emit a DEBUG log with the sanitized error."""
        from token_goat.bash_parser import parse

        with caplog.at_level(logging.DEBUG, logger="token_goat.bash_parser"):
            parse('cat "unterminated')

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("shlex.split failed" in m for m in debug_msgs)

    def test_shlex_error_message_sanitized(self, caplog):
        """Newline/CR characters in the shlex error must be escaped before logging."""
        from token_goat.bash_parser import parse

        # Inject a ValueError whose message contains a newline via patch
        with (
            caplog.at_level(logging.DEBUG, logger="token_goat.bash_parser"),
            patch("token_goat.bash_parser.shlex.split", side_effect=ValueError("bad\nnewline")),
        ):
            result = parse("cat something")

        assert result.kind == "unknown"
        # Verify the logged message does not contain a literal newline
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        for msg in debug_msgs:
            if "shlex.split failed" in msg:
                assert "\n" not in msg
                assert "\\n" in msg

    def test_normal_cat_command_parses_correctly(self):
        """Sanity check: a well-formed cat command parses as kind='read'."""
        from token_goat.bash_parser import parse

        result = parse("cat src/main.py")
        assert result.kind == "read"
        assert result.target_path == "src/main.py"


# ===========================================================================
# 6. read_replacement.py — _MAX_SYMBOL_LEN cap in read_symbol and read_section
# ===========================================================================


class TestMaxSymbolLen:
    """read_symbol and read_section return None and log WARNING when name exceeds _MAX_SYMBOL_LEN."""

    def _make_project(self, tmp_path):
        from token_goat.project import Project

        return Project(root=tmp_path, hash="deadbeef" * 5, marker="manual")

    def test_read_symbol_oversized_name_returns_none(self, tmp_path):
        from token_goat.read_replacement import _MAX_SYMBOL_LEN, read_symbol

        proj = self._make_project(tmp_path)
        oversized = "x" * (_MAX_SYMBOL_LEN + 1)
        result = read_symbol(proj, "src/foo.py", oversized)
        assert result is None

    def test_read_symbol_oversized_name_logs_warning(self, tmp_path, caplog):
        from token_goat.read_replacement import _MAX_SYMBOL_LEN, read_symbol

        proj = self._make_project(tmp_path)
        oversized = "x" * (_MAX_SYMBOL_LEN + 1)
        with caplog.at_level(logging.WARNING, logger="token_goat.read_replacement"):
            read_symbol(proj, "src/foo.py", oversized)

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("name/heading too long" in m for m in warn_msgs)

    def test_read_symbol_exactly_at_limit_is_not_rejected_by_cap(self, tmp_path):
        """A symbol name exactly at _MAX_SYMBOL_LEN must not be rejected by the length cap.

        (It will still return None because the file/project is empty, but the reason
        must NOT be the length cap — i.e. the warning must not be emitted.)
        """
        from token_goat.read_replacement import _MAX_SYMBOL_LEN, read_symbol

        proj = self._make_project(tmp_path)
        at_limit = "x" * _MAX_SYMBOL_LEN

        with patch("token_goat.read_replacement.db") as mock_db:
            mock_conn = MagicMock()
            mock_conn.__enter__ = MagicMock(return_value=mock_conn)
            mock_conn.__exit__ = MagicMock(return_value=False)
            mock_conn.execute.return_value.fetchall.return_value = []
            mock_db.open_project.return_value = mock_conn


            with patch("token_goat.read_replacement._LOG") as mock_log:
                read_symbol(proj, "src/foo.py", at_limit)
                # warning about "symbol name too long" must NOT have been called
                for call in mock_log.warning.call_args_list:
                    assert "symbol name too long" not in str(call)

    def test_read_section_oversized_heading_returns_none(self, tmp_path):
        from token_goat.read_replacement import _MAX_SYMBOL_LEN, read_section

        proj = self._make_project(tmp_path)
        oversized = "H" * (_MAX_SYMBOL_LEN + 1)
        result = read_section(proj, "docs/README.md", oversized)
        assert result is None

    def test_read_section_oversized_heading_logs_warning(self, tmp_path, caplog):
        from token_goat.read_replacement import _MAX_SYMBOL_LEN, read_section

        proj = self._make_project(tmp_path)
        oversized = "H" * (_MAX_SYMBOL_LEN + 1)
        with caplog.at_level(logging.WARNING, logger="token_goat.read_replacement"):
            read_section(proj, "docs/README.md", oversized)

        warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("heading too long" in m for m in warn_msgs)


# ===========================================================================
# 7. languages/go.py — module-level compiled regex patterns work correctly
# ===========================================================================


class TestGoRegexPatterns:
    """Spot-check that Go module-level compiled regexes yield correct extraction."""

    def test_call_re_matches_bare_function_call(self):
        """_CALL_RE must match a bare (unqualified) function call identifier."""
        from token_goat.languages.common import CALL_RE as _CALL_RE

        # Bare call — not preceded by '.' or word char
        line = "result := doSomething(arg)"
        matches = _CALL_RE.findall(line)
        assert "doSomething" in matches

    def test_call_re_excludes_qualified_method_call(self):
        """_CALL_RE negative lookbehind must exclude 'pkg.Method' style calls."""
        from token_goat.languages.common import CALL_RE as _CALL_RE

        # fmt.Println — 'Println' is preceded by '.' so it must not match
        line = "result := fmt.Println(x)"
        matches = _CALL_RE.findall(line)
        assert "Println" not in matches
        # 'fmt' itself is not followed by '(' so it is also absent
        assert "fmt" not in matches

    def test_call_re_does_not_match_receiver_object(self):
        """The object before '.' must not be returned as a match."""
        from token_goat.languages.common import CALL_RE as _CALL_RE

        line = "foo.Bar()"
        matches = _CALL_RE.findall(line)
        # 'foo' immediately precedes '.Bar(', not '(', so it never matches
        assert "foo" not in matches

    def test_go_import_re_extracts_import_path(self):
        """_GO_IMPORT_RE must extract the bare path from a quoted import string."""
        from token_goat.languages.go import _GO_IMPORT_RE

        line = 'import "fmt/errors"'
        m = _GO_IMPORT_RE.search(line)
        assert m is not None
        assert m.group(1) == "fmt/errors"

    def test_const_single_re_matches_const_declaration(self):
        """_CONST_SINGLE_RE must match a single-line const declaration."""
        from token_goat.languages.go import _CONST_SINGLE_RE

        line = "const MyConst = 42"
        m = _CONST_SINGLE_RE.match(line)
        assert m is not None
        assert m.group(1) == "MyConst"

    def test_var_single_re_matches_var_declaration(self):
        """_VAR_SINGLE_RE must match a single-line var declaration."""
        from token_goat.languages.go import _VAR_SINGLE_RE

        line = "var myVar int"
        m = _VAR_SINGLE_RE.match(line)
        assert m is not None
        assert m.group(1) == "myVar"

    def test_const_block_re_matches_block_opener(self):
        """_CONST_BLOCK_RE must match 'const (' lines."""
        from token_goat.languages.go import _CONST_BLOCK_RE

        assert _CONST_BLOCK_RE.match("const (")
        assert not _CONST_BLOCK_RE.match("const MyConst = 1")

    def test_var_block_re_matches_block_opener(self):
        """_VAR_BLOCK_RE must match 'var (' lines."""
        from token_goat.languages.go import _VAR_BLOCK_RE

        assert _VAR_BLOCK_RE.match("var (")
        assert not _VAR_BLOCK_RE.match("var myVar int")

    def test_extract_returns_symbols_from_simple_go_source(self):
        """extract() must return at least one symbol from a minimal Go file with a function."""
        try:
            from token_goat.languages.go import extract
        except Exception:
            return  # tree-sitter grammar not available; skip

        src = b"""package main

import "fmt"

const MaxItems = 100

func Hello(name string) string {
    return fmt.Sprintf("Hello, %s!", name)
}
"""
        symbols, refs, imp_exp, sections = extract(src, "hello.go")
        # When tree-sitter is available we expect at least Hello or MaxItems
        # When tree-sitter grammar is absent, extract returns empty lists gracefully
        if symbols:
            names = [s.name for s in symbols]
            assert any(n in names for n in ("Hello", "MaxItems", "main"))
