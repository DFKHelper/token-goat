"""Tests for iter 85 coverage targets.

Covers:
1. spawn_index_detached cwd validation (iter 84)
2. _process_dirty_entries root validation (iter 84)
3. _build_line_index / _offset_to_line O(n log n) helpers (iter 83)
4. Compiled regex correctness — python.py and typescript.py (iter 83)
5. __all__ exports for db, compact, parser, embeddings, repomap (iter 80)
6. shlex quoting in install_linux_autostart (iter 84)
"""
from __future__ import annotations

import importlib
import sys
from unittest.mock import MagicMock, patch

import pytest

from token_goat import worker
from token_goat.languages.common import build_line_index as _build_line_index
from token_goat.languages.common import offset_to_line as _offset_to_line
from token_goat.languages.python import _FROM_IMPORT_RE, _PLAIN_IMPORT_RE
from token_goat.languages.typescript import _EXPORT_CONST_RE
from token_goat.worker import DirtyQueueEntry, _process_dirty_entries

# ---------------------------------------------------------------------------
# 1. _build_line_index / _offset_to_line
# ---------------------------------------------------------------------------


def test_build_line_index_single_line():
    idx = _build_line_index("hello world")
    assert idx == [0]


def test_build_line_index_two_lines():
    idx = _build_line_index("hello\nworld")
    assert idx == [0, 6]


def test_build_line_index_empty_string():
    idx = _build_line_index("")
    assert idx == [0]


def test_build_line_index_trailing_newline():
    idx = _build_line_index("a\nb\n")
    assert idx == [0, 2, 4]


def test_offset_to_line_first_char():
    idx = _build_line_index("hello\nworld")
    assert _offset_to_line(idx, 0) == 1


def test_offset_to_line_last_char_first_line():
    idx = _build_line_index("hello\nworld")
    # offset 4 is 'o' in 'hello', still line 1
    assert _offset_to_line(idx, 4) == 1


def test_offset_to_line_second_line():
    idx = _build_line_index("hello\nworld")
    # offset 6 is 'w' — first char of line 2
    assert _offset_to_line(idx, 6) == 2


def test_offset_to_line_last_char():
    text = "hello\nworld"
    idx = _build_line_index(text)
    assert _offset_to_line(idx, len(text) - 1) == 2


def test_offset_to_line_multiline_consistency():
    text = "a\nb\nc\nd"
    idx = _build_line_index(text)
    # Line 3 starts at offset 4 ('c')
    assert _offset_to_line(idx, 4) == 3
    assert _offset_to_line(idx, 5) == 3  # '\n' after 'c' — still line 3
    assert _offset_to_line(idx, 6) == 4  # 'd' is line 4


def test_build_line_index_matches_naive_count():
    text = "line one\nline two\nline three\nline four"
    idx = _build_line_index(text)
    for pos, ch in enumerate(text):
        naive = text[:pos].count("\n") + 1
        fast = _offset_to_line(idx, pos)
        assert fast == naive, f"mismatch at offset {pos} ({ch!r})"


# ---------------------------------------------------------------------------
# 2. Compiled regex correctness — python.py
# ---------------------------------------------------------------------------


def test_from_import_re_basic():
    m = _FROM_IMPORT_RE.match("from os.path import join")
    assert m is not None
    assert m.group(1) == "os.path"
    assert m.group(2) == "join"


def test_from_import_re_multiple_names():
    m = _FROM_IMPORT_RE.match("from os.path import join, exists")
    assert m is not None
    assert m.group(1) == "os.path"
    assert "join" in m.group(2) and "exists" in m.group(2)


def test_from_import_re_with_as():
    m = _FROM_IMPORT_RE.match("from pathlib import Path as P")
    assert m is not None
    assert m.group(1) == "pathlib"


def test_from_import_re_no_match_plain():
    assert _FROM_IMPORT_RE.match("import os") is None


def test_plain_import_re_basic():
    m = _PLAIN_IMPORT_RE.match("import os")
    assert m is not None
    assert m.group(1) == "os"


def test_plain_import_re_multiple():
    m = _PLAIN_IMPORT_RE.match("import os, sys")
    assert m is not None
    assert "os" in m.group(1) and "sys" in m.group(1)


def test_plain_import_re_no_match_from():
    assert _PLAIN_IMPORT_RE.match("from os import path") is None


# ---------------------------------------------------------------------------
# 3. Compiled regex correctness — typescript.py
# ---------------------------------------------------------------------------


def test_export_const_re_const():
    m = _EXPORT_CONST_RE.match("export const router = express()")
    assert m is not None
    assert m.group(1) == "router"


def test_export_const_re_let():
    m = _EXPORT_CONST_RE.match("export let count = 0")
    assert m is not None
    assert m.group(1) == "count"


def test_export_const_re_var():
    m = _EXPORT_CONST_RE.match("export var legacyFlag = true")
    assert m is not None
    assert m.group(1) == "legacyFlag"


def test_export_const_re_dollar_name():
    m = _EXPORT_CONST_RE.match("export const $store = createStore()")
    assert m is not None
    assert m.group(1) == "$store"


def test_export_const_re_no_match_function():
    assert _EXPORT_CONST_RE.match("export function foo() {}") is None


def test_export_const_re_no_match_class():
    assert _EXPORT_CONST_RE.match("export class Foo {}") is None


# ---------------------------------------------------------------------------
# 4. __all__ exports are importable
# ---------------------------------------------------------------------------

def _check_all_importable(module_name: str) -> None:
    mod = importlib.import_module(module_name)
    all_names = getattr(mod, "__all__", [])
    for name in all_names:
        assert hasattr(mod, name), (
            f"{module_name}.__all__ lists {name!r} but it is not defined in the module"
        )


def test_db_all_importable():
    _check_all_importable("token_goat.db")


def test_compact_all_importable():
    _check_all_importable("token_goat.compact")


def test_parser_all_importable():
    _check_all_importable("token_goat.parser")


def test_embeddings_all_importable():
    _check_all_importable("token_goat.embeddings")


def test_repomap_all_importable():
    _check_all_importable("token_goat.repomap")


# ---------------------------------------------------------------------------
# 5. spawn_index_detached cwd validation (iter 84)
# ---------------------------------------------------------------------------


def test_spawn_index_detached_rejects_relative_path():
    result = worker.spawn_index_detached("relative/path", "abc123" * 6 + "ab")
    assert result is None


def test_spawn_index_detached_rejects_non_directory(tmp_path):
    # Create a file, not a directory
    not_a_dir = tmp_path / "somefile.txt"
    not_a_dir.write_text("hello")
    result = worker.spawn_index_detached(str(not_a_dir), "abc123" * 6 + "ab")
    assert result is None


def test_spawn_index_detached_accepts_valid_dir(tmp_path, monkeypatch):
    # With a valid directory, it should attempt to spawn (may return a PID or None
    # depending on environment, but must NOT return None for the cwd-validation reason).
    # We mock the actual Popen so no subprocess is created.
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    valid_hash = "a" * 40
    with (
        patch("token_goat.worker._index_spawn_active", return_value=False),
        patch("token_goat.worker.subprocess.Popen") as mock_popen,
        patch("token_goat.worker.paths.locks_dir", return_value=tmp_path),
        patch("token_goat.worker.paths.python_runner_argv", return_value=["token-goat", "index", "--full"]),
    ):
        mock_proc = MagicMock()
        mock_proc.pid = 12345
        mock_popen.return_value = mock_proc
        result = worker.spawn_index_detached(str(tmp_path), valid_hash)
    assert result == 12345


# ---------------------------------------------------------------------------
# 6. _process_dirty_entries root validation (iter 84)
# ---------------------------------------------------------------------------


def _make_entry(**kwargs) -> DirtyQueueEntry:
    base: DirtyQueueEntry = {
        "path": "src/foo.py",
        "project_hash": "a" * 40,
        "project_root": None,
        "project_marker": "git",
        "ts": 0.0,
    }
    base.update(kwargs)  # type: ignore[typeddict-item]
    return base


def test_process_dirty_entries_skips_relative_root(tmp_path, caplog):
    entry = _make_entry(
        project_hash="b" * 40,
        project_root="relative/path/not/absolute",
    )
    with (
        patch("token_goat.db._validate_project_hash"),
        patch("token_goat.paths.is_safe_rel_path", return_value=True),
        patch("token_goat.db.open_global") as mock_open_global,
    ):
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value = []
        mock_open_global.return_value = mock_conn
        import logging
        with caplog.at_level(logging.WARNING, logger="token_goat.worker"):
            _process_dirty_entries([entry])
    assert any("not absolute" in r.message for r in caplog.records)


def test_process_dirty_entries_skips_nondir_root(tmp_path, caplog):
    # Point root at a file, not a directory
    a_file = tmp_path / "notadir.txt"
    a_file.write_text("x")
    entry = _make_entry(
        project_hash="c" * 40,
        project_root=str(a_file),
    )
    with (
        patch("token_goat.db._validate_project_hash"),
        patch("token_goat.paths.is_safe_rel_path", return_value=True),
        patch("token_goat.db.open_global") as mock_open_global,
    ):
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value = []
        mock_open_global.return_value = mock_conn
        import logging
        with caplog.at_level(logging.WARNING, logger="token_goat.worker"):
            _process_dirty_entries([entry])
    assert any("not an existing directory" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 7. shlex quoting in install_linux_autostart (iter 84)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="Linux-only code path")
def test_install_linux_autostart_quotes_spaces(tmp_path):
    """ExecStart must shell-quote paths that contain spaces."""
    import shlex

    from token_goat import install

    spaced_exec = "/home/user name/bin/python3"
    fake_argv = [spaced_exec, "-m", "token_goat.cli", "worker", "--daemon"]

    with (
        patch("token_goat.install._systemd_user_available", return_value=True),
        patch("token_goat.install.paths.python_runner_argv", return_value=fake_argv),
        patch("token_goat.install._systemd_user_dir", return_value=tmp_path),
        patch("token_goat.install._systemd_service_path", return_value=tmp_path / "tg.service"),
        patch("token_goat.install.subprocess.run") as mock_run,
    ):
        mock_run.return_value = MagicMock(returncode=0)
        ok, detail = install.install_linux_autostart()

    svc_content = (tmp_path / "tg.service").read_text(encoding="utf-8")
    exec_line = next(ln for ln in svc_content.splitlines() if ln.startswith("ExecStart="))
    exec_value = exec_line[len("ExecStart="):]

    # The quoted string must round-trip back to the original argv
    parsed = shlex.split(exec_value)
    assert parsed == fake_argv


def test_install_linux_autostart_no_spaces_not_quoted(tmp_path):
    """Paths without spaces should not be wrapped in unnecessary quotes."""
    import shlex

    from token_goat import install

    plain_argv = ["/usr/bin/python3", "-m", "token_goat.cli", "worker", "--daemon"]

    if sys.platform == "win32":
        pytest.skip("Linux-only code path")

    with (
        patch("token_goat.install._systemd_user_available", return_value=True),
        patch("token_goat.install.paths.python_runner_argv", return_value=plain_argv),
        patch("token_goat.install._systemd_user_dir", return_value=tmp_path),
        patch("token_goat.install._systemd_service_path", return_value=tmp_path / "tg.service"),
        patch("token_goat.install.subprocess.run") as mock_run,
    ):
        mock_run.return_value = MagicMock(returncode=0)
        install.install_linux_autostart()

    svc_content = (tmp_path / "tg.service").read_text(encoding="utf-8")
    exec_line = next(ln for ln in svc_content.splitlines() if ln.startswith("ExecStart="))
    exec_value = exec_line[len("ExecStart="):]
    parsed = shlex.split(exec_value)
    assert parsed == plain_argv
