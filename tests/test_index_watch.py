"""Tests for token-goat index --watch (polling file watcher)."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch


class TestWatchProject:
    """Unit tests for the _watch_project helper."""

    def _make_proj(self, tmp_path: Path):
        from token_goat.project import make_project_at

        root = tmp_path / "proj"
        root.mkdir()
        (root / "foo.py").write_text("def hello(): pass\n", encoding="utf-8")
        return make_project_at(root)

    def test_exits_on_keyboard_interrupt(self, tmp_data_dir, tmp_path):
        """_watch_project stops cleanly on KeyboardInterrupt."""
        from token_goat.cli import _watch_project
        from token_goat.parser import index_project

        proj = self._make_proj(tmp_path)
        index_project(proj, full=True)

        # Patch time.sleep to raise KeyboardInterrupt on the first call
        with patch("token_goat.cli.time") as mock_time:
            mock_time.sleep.side_effect = KeyboardInterrupt
            # Should not raise — KeyboardInterrupt is caught internally
            _watch_project(proj)

    def test_reindexes_changed_file(self, tmp_data_dir, tmp_path):
        """When a file's mtime changes, _watch_project calls index_file and write_file_index."""
        from token_goat.cli import _watch_project
        from token_goat.parser import index_project

        proj = self._make_proj(tmp_path)
        index_project(proj, full=True)

        py_file = proj.root / "foo.py"

        call_count = 0

        def _fake_sleep(_interval: float) -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Simulate a file change by bumping the mtime via a write
                py_file.write_text("def hello(): pass\ndef bye(): pass\n", encoding="utf-8")
            else:
                raise KeyboardInterrupt

        with patch("token_goat.cli.time") as mock_time:
            mock_time.sleep.side_effect = _fake_sleep
            _watch_project(proj)

        # After one cycle of changes, verify the DB has the updated symbol count
        from token_goat import db

        with db.open_project_readonly(proj.hash) as conn:
            rows = list(conn.execute("SELECT name FROM symbols WHERE file_rel = 'foo.py'"))
        names = {r["name"] for r in rows}
        assert "hello" in names
        assert "bye" in names

    def test_no_reindex_when_unchanged(self, tmp_data_dir, tmp_path):
        """When no files change, index_file is never called."""
        from token_goat.cli import _watch_project
        from token_goat.parser import index_project

        proj = self._make_proj(tmp_path)
        index_project(proj, full=True)

        call_count = 0

        def _fake_sleep(_interval: float) -> None:
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise KeyboardInterrupt

        with patch("token_goat.cli.time") as mock_time, \
             patch("token_goat.parser.index_file") as mock_index_file:
            mock_time.sleep.side_effect = _fake_sleep
            _watch_project(proj)

        # index_file should not have been called (no changes)
        mock_index_file.assert_not_called()

    def test_skips_generated_files(self, tmp_data_dir, tmp_path):
        """Generated files (e.g. package-lock.json) are not watched."""
        from token_goat.cli import _watch_project
        from token_goat.parser import index_project

        proj = self._make_proj(tmp_path)
        lockfile = proj.root / "package-lock.json"
        lockfile.write_text("{}", encoding="utf-8")
        index_project(proj, full=True)

        call_count = 0

        def _fake_sleep(_interval: float) -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Modify the lockfile — should be ignored
                lockfile.write_text('{"updated": true}', encoding="utf-8")
            else:
                raise KeyboardInterrupt

        with patch("token_goat.cli.time") as mock_time, \
             patch("token_goat.parser.index_file") as mock_index_file:
            mock_time.sleep.side_effect = _fake_sleep
            _watch_project(proj)

        mock_index_file.assert_not_called()


class TestIndexWatchCli:
    """CLI-level smoke tests for `token-goat index --watch`."""

    def test_watch_flag_accepted(self, tmp_data_dir, tmp_path):
        """--watch is a recognised flag and the command exits 0 on Ctrl+C."""
        from typer.testing import CliRunner

        from token_goat.cli import app
        from token_goat.parser import index_project
        from token_goat.project import make_project_at

        root = tmp_path / "proj"
        root.mkdir()
        (root / "mod.py").write_text("x = 1\n", encoding="utf-8")
        proj = make_project_at(root)
        index_project(proj, full=True)

        with patch("token_goat.cli.time") as mock_time:
            mock_time.sleep.side_effect = KeyboardInterrupt
            runner = CliRunner()
            result = runner.invoke(app, ["index", "--root", str(root), "--watch"])

        assert result.exit_code == 0
        assert "Watching" in result.output or "Stopped" in result.output
