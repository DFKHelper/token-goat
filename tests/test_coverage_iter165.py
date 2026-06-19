"""Regression tests for iterations 161–164.

Coverage targets:
- hints.py: narrowed except (db.DBError, sqlite3.Error, OSError) — verify sqlite3.Error
  and db.DBError both trigger debug log in _get_indexed_symbols_and_line_count
- cli_doctor.py: PackageNotFoundError handled; FileNotFoundError for uv subprocess handled
- languages/liquid.py: JSON decode error logs at DEBUG when schema JSON is malformed
- paths.py: _open_restricted creates file with 0o600 permissions on POSIX (skipped on Windows)
- gdrive.py: _write_creds_secure uses timestamped tmp name, not predictable .tmp suffix
- worker.py: spawn_index_detached returns None for invalid hash format
- db.py: _is_readonly_or_transient returns True for transient error strings
- webfetch.py: _CONTENT_TYPE_EXT contains expected MIME types
"""
from __future__ import annotations

import importlib
import logging
import os
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ===========================================================================
# 1. hints.py — narrowed exception types in _get_indexed_symbols_and_line_count
# ===========================================================================


class TestHintsExceptionHandling:
    """_get_indexed_symbols_and_line_count must debug-log db.DBError and sqlite3.Error."""

    def test_sqlite3_error_triggers_debug_log(self, tmp_data_dir, caplog):
        """A sqlite3.Error raised by db.open_project_readonly must be caught and logged at DEBUG."""
        from token_goat.hints import _get_indexed_symbols_and_line_count

        with (
            caplog.at_level(logging.DEBUG, logger="token_goat.hints"),
            patch("token_goat.hints.db.open_project_readonly", side_effect=sqlite3.Error("disk I/O error")),
        ):
            symbols, n_lines, exact = _get_indexed_symbols_and_line_count(
                "src/foo.py", "a" * 40
            )

        assert symbols == []
        assert n_lines is None
        assert exact is False
        assert any("disk I/O error" in r.message for r in caplog.records if r.levelno == logging.DEBUG)

    def test_db_error_triggers_debug_log(self, tmp_data_dir, caplog):
        """A db.DBError raised by db.open_project_readonly must be caught and logged at DEBUG."""
        from token_goat import db
        from token_goat.hints import _get_indexed_symbols_and_line_count

        with (
            caplog.at_level(logging.DEBUG, logger="token_goat.hints"),
            patch("token_goat.hints.db.open_project_readonly", side_effect=db.DBError("corrupted")),
        ):
            symbols, n_lines, exact = _get_indexed_symbols_and_line_count(
                "src/bar.py", "b" * 40
            )

        assert symbols == []
        assert n_lines is None
        assert exact is False
        assert any("corrupted" in r.message for r in caplog.records if r.levelno == logging.DEBUG)

    def test_os_error_triggers_debug_log(self, tmp_data_dir, caplog):
        """An OSError raised by db.open_project_readonly must be caught and logged at DEBUG."""
        from token_goat.hints import _get_indexed_symbols_and_line_count

        with (
            caplog.at_level(logging.DEBUG, logger="token_goat.hints"),
            patch("token_goat.hints.db.open_project_readonly", side_effect=OSError("no such file")),
        ):
            symbols, n_lines, exact = _get_indexed_symbols_and_line_count(
                "src/baz.py", "c" * 40
            )

        assert symbols == []
        assert n_lines is None
        assert exact is False
        assert any("no such file" in r.message for r in caplog.records if r.levelno == logging.DEBUG)

    def test_uses_readonly_connection_not_write_capable(self, tmp_data_dir):
        """_get_indexed_symbols_and_line_count must use open_project_readonly, not open_project.

        Regression guard: the function only performs SELECT queries.  Using the
        write-capable open_project loads the sqlite-vec extension and applies
        schema DDL on every call, adding ~10 ms of latency to every pre_read
        hook invocation that reaches the index path.
        """
        import token_goat.hints as hints_mod
        from token_goat.hints import _get_indexed_symbols_and_line_count

        with (
            patch.object(hints_mod.db, "open_project") as mock_write,
            patch.object(hints_mod.db, "open_project_readonly", side_effect=FileNotFoundError("not found")),
        ):
            _get_indexed_symbols_and_line_count("src/any.py", "a" * 40)

        mock_write.assert_not_called()


# ===========================================================================
# 2. cli_doctor.py — narrowed exception types for version checks
# ===========================================================================


class TestCliDoctorExceptions:
    """cli_doctor handles PackageNotFoundError and FileNotFoundError gracefully."""

    def test_package_not_found_shows_unknown(self, tmp_data_dir, capsys):
        """When importlib.metadata.version raises PackageNotFoundError, doctor shows 'unknown'."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()

        # cli_doctor imports importlib.metadata inside the function body;
        # patch the version attribute on the already-imported module.
        with patch("importlib.metadata.version") as mock_ver:
            mock_ver.side_effect = importlib.metadata.PackageNotFoundError("token-goat")
            result = runner.invoke(app, ["doctor"])

        assert result.exit_code == 0
        assert "unknown" in result.output

    def test_uv_not_found_shows_warn(self, tmp_data_dir, capsys):
        """When the uv subprocess raises FileNotFoundError, doctor flags uv with [WARN]."""

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()

        # subprocess is imported inside the doctor() function body;
        # patch via the standard library module directly.
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError("uv not on PATH")
            result = runner.invoke(app, ["doctor"])

        assert result.exit_code == 0
        # Doctor emits "[WARN] uv: <error message>" when the uv subprocess is unavailable.
        assert "[WARN] uv:" in result.output


# ===========================================================================
# 3. languages/liquid.py — JSON decode error logged at DEBUG
# ===========================================================================


class TestLiquidJsonDecodeLog:
    """Invalid schema JSON inside {% schema %}...{% endschema %} triggers a debug log."""

    def test_malformed_schema_json_logs_debug(self, caplog):
        """Bad JSON in a schema block must produce a DEBUG log, not raise."""
        from token_goat.languages.liquid import extract

        # Use a simple non-JSON string that doesn't contain % format chars
        template = b"{% schema %}\nnot valid json at all\n{% endschema %}"
        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.liquid"):
            symbols, refs, imports, sections = extract(template, "sections/header.liquid")

        # Must not crash
        assert refs == []
        # Must emit a debug log containing the filename
        debug_msgs = [r.getMessage() for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("header.liquid" in msg for msg in debug_msgs), (
            f"Expected debug log mentioning 'header.liquid', got: {debug_msgs}"
        )

    def test_malformed_schema_returns_empty_symbols(self, caplog):
        """Malformed schema JSON produces no liquid_schema symbol but no exception."""
        from token_goat.languages.liquid import extract

        template = b"{% schema %}NOT JSON{% endschema %}"
        with caplog.at_level(logging.DEBUG, logger="token_goat.languages.liquid"):
            symbols, _refs, _imports, _sections = extract(template, "sections/test.liquid")

        liquid_schema_syms = [s for s in symbols if s.kind == "liquid_schema"]
        assert liquid_schema_syms == []


# ===========================================================================
# 4. paths.py — _open_restricted creates 0o600 file on POSIX
# ===========================================================================


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission test; not meaningful on Windows")
class TestOpenRestrictedPermissions:
    """_open_restricted must create files with mode 0o600 on POSIX."""

    def test_owner_only_permissions(self, tmp_path):
        """File created by _open_restricted must have mode 0o600."""
        from token_goat.paths import _open_restricted

        target = tmp_path / "secret.json"
        fd = _open_restricted(target)
        try:
            os.write(fd, b"test content")
        finally:
            os.close(fd)

        stat_result = target.stat()
        actual_mode = stat_result.st_mode & 0o777
        assert actual_mode == 0o600, (
            f"Expected mode 0o600 but got 0o{actual_mode:o} for {target}"
        )

    def test_file_is_created(self, tmp_path):
        """_open_restricted must actually create the file."""
        from token_goat.paths import _open_restricted

        target = tmp_path / "newfile.tmp"
        assert not target.exists()
        fd = _open_restricted(target)
        os.close(fd)
        assert target.exists()


# ===========================================================================
# 5. gdrive.py — _write_creds_secure uses timestamped tmp name
# ===========================================================================


class TestGdriveWriteCredsSecureTmpName:
    """_write_creds_secure must not use the predictable .tmp suffix."""

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX temp-file naming check")
    def test_no_predictable_tmp_suffix_on_posix(self, tmp_path):
        """On POSIX, the temp file name must include thread ID + monotonic_ns, not .tmp only."""
        from token_goat import gdrive

        creds_path = tmp_path / "gdrive_creds.json"
        created_tmp_names: list[str] = []

        original_os_open = os.open

        def spy_open(path_str: str, flags: int, mode: int = 0o777) -> int:
            name = Path(path_str).name
            if name.endswith(".tmp") and "gdrive_creds" in name:
                created_tmp_names.append(name)
            return original_os_open(path_str, flags, mode)

        with patch("token_goat.gdrive.os.open", side_effect=spy_open):
            gdrive._write_creds_secure(creds_path, '{"token": "secret"}')

        assert created_tmp_names, "Expected at least one .tmp file to be created"
        for name in created_tmp_names:
            # Old predictable name was exactly "gdrive_creds.json.tmp"
            # New name contains thread ID and monotonic_ns: "gdrive_creds.json.<tid>.<ns>.tmp"
            assert name != "gdrive_creds.json.tmp", (
                f"Temp file used predictable name {name!r}; expected timestamped name"
            )
            # Must contain at least two dot-separated numeric components before .tmp
            parts = name.rstrip(".tmp").split(".")
            numeric_parts = [p for p in parts if p.isdigit()]
            assert len(numeric_parts) >= 2, (
                f"Expected thread ID + monotonic_ns in tmp name, got: {name!r}"
            )


# ===========================================================================
# 6. worker.py — spawn_index_detached returns None for invalid hash format
# ===========================================================================


class TestSpawnIndexDetachedHashValidation:
    """spawn_index_detached must reject non-hex hashes and return None."""

    def test_uppercase_hash_returns_none(self, tmp_data_dir):
        """An uppercase hash is not a valid SHA-1 hex digest — must return None."""
        from token_goat import worker

        with patch("token_goat.worker.subprocess.Popen") as mock_popen:
            result = worker.spawn_index_detached("/tmp", "AABBCCDDEEFF" * 3 + "AABB")

        assert result is None
        mock_popen.assert_not_called()

    def test_traversal_sequence_hash_returns_none(self, tmp_data_dir):
        """A path traversal sequence in project_hash must be rejected, return None."""
        from token_goat import worker

        with patch("token_goat.worker.subprocess.Popen") as mock_popen:
            result = worker.spawn_index_detached("/tmp", "../../../etc/passwd")

        assert result is None
        mock_popen.assert_not_called()

    def test_empty_hash_returns_none(self, tmp_data_dir):
        """An empty project_hash must be rejected and return None."""
        from token_goat import worker

        with patch("token_goat.worker.subprocess.Popen") as mock_popen:
            result = worker.spawn_index_detached("/tmp", "")

        assert result is None
        mock_popen.assert_not_called()

    def test_valid_lowercase_hex_hash_proceeds(self, tmp_data_dir, monkeypatch):
        """A valid lowercase hex hash must pass validation (Popen attempted)."""
        from token_goat import worker

        monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
        valid_hash = "a" * 40  # 40 lowercase hex chars = valid SHA-1
        fake_proc = MagicMock()
        fake_proc.pid = 12345

        # Use a real absolute path that exists — spawn_index_detached also
        # validates that project_root is an existing directory.
        # Popen must be called since the hash is valid and root exists;
        # the return value may be None only if another guard blocks it.
        with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
            worker.spawn_index_detached(str(tmp_data_dir), valid_hash)

        mock_popen.assert_called_once()


# ===========================================================================
# 7. db.py — _is_readonly_or_transient behavior test
# ===========================================================================


class TestIsReadonlyOrTransient:
    """_is_readonly_or_transient must return True for locked/busy/readonly errors."""

    def test_locked_error_returns_true(self):
        from token_goat.db import _is_readonly_or_transient

        err = sqlite3.OperationalError("database is locked")
        assert _is_readonly_or_transient(err) is True

    def test_busy_error_returns_true(self):
        from token_goat.db import _is_readonly_or_transient

        err = sqlite3.OperationalError("database is busy")
        assert _is_readonly_or_transient(err) is True

    def test_readonly_error_returns_true(self):
        from token_goat.db import _is_readonly_or_transient

        err = sqlite3.OperationalError("attempt to write a readonly database")
        assert _is_readonly_or_transient(err) is True

    def test_io_error_returns_true(self):
        from token_goat.db import _is_readonly_or_transient

        err = sqlite3.OperationalError("disk i/o error")
        assert _is_readonly_or_transient(err) is True

    def test_unrelated_error_returns_false(self):
        from token_goat.db import _is_readonly_or_transient

        err = sqlite3.OperationalError("no such table: symbols")
        assert _is_readonly_or_transient(err) is False

    def test_case_insensitive_match(self):
        """Error messages are matched case-insensitively via str().lower()."""
        from token_goat.db import _is_readonly_or_transient

        # Mixed case to confirm .lower() normalization works
        err = sqlite3.OperationalError("Database Is LOCKED")
        assert _is_readonly_or_transient(err) is True


# ===========================================================================
# 8. webfetch.py — _CONTENT_TYPE_EXT module-level constant
# ===========================================================================


class TestContentTypeExt:
    """_CONTENT_TYPE_EXT must map expected MIME types to their file extensions."""

    def test_contains_jpeg(self):
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        assert _CONTENT_TYPE_EXT["image/jpeg"] == ".jpg"

    def test_contains_png(self):
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        assert _CONTENT_TYPE_EXT["image/png"] == ".png"

    def test_contains_webp(self):
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        assert _CONTENT_TYPE_EXT["image/webp"] == ".webp"

    def test_contains_gif(self):
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        assert _CONTENT_TYPE_EXT["image/gif"] == ".gif"

    def test_contains_avif(self):
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        assert _CONTENT_TYPE_EXT["image/avif"] == ".avif"

    def test_all_values_start_with_dot(self):
        """Every extension in the map must start with a dot."""
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        for mime, ext in _CONTENT_TYPE_EXT.items():
            assert ext.startswith("."), f"Extension for {mime!r} does not start with '.': {ext!r}"

    def test_is_dict(self):
        """_CONTENT_TYPE_EXT must be a dict."""
        from token_goat.webfetch import _CONTENT_TYPE_EXT

        assert isinstance(_CONTENT_TYPE_EXT, dict)
