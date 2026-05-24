"""Tests for DRY round-2 helpers (2026-05-24-dry-new-design.md).

Items covered:
- Item 1:  config._apply_env_disable
- Item 7:  hooks_common.bytes_to_tokens
- Item 8:  paths._safe_child_path (additional tests; core tests in test_paths.py)
- Item 9:  util.get_logger uniformity (logging name preservation)
- Item 12: render.ansi.color_stdout / color_stderr
- Item 13: compact._run_git
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Item 1: config._apply_env_disable
# ---------------------------------------------------------------------------

class TestApplyEnvDisable:
    """Tests for config._apply_env_disable."""

    def test_disables_on_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """env_key='0' sets attr to False."""
        from token_goat import config

        monkeypatch.setenv("TG_TEST_FLAG", "0")

        class _Obj:
            enabled = True

        obj = _Obj()
        config._apply_env_disable(obj, "enabled", "TG_TEST_FLAG", "test_feature")
        assert obj.enabled is False

    def test_disables_on_false(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """env_key='false' (case-insensitive) also disables."""
        from token_goat import config

        monkeypatch.setenv("TG_TEST_FLAG2", "FALSE")

        class _Obj:
            enabled = True

        obj = _Obj()
        config._apply_env_disable(obj, "enabled", "TG_TEST_FLAG2", "test_feature")
        assert obj.enabled is False

    def test_no_change_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Unset env-var leaves the attribute unchanged."""
        from token_goat import config

        monkeypatch.delenv("TG_TEST_FLAG3", raising=False)

        class _Obj:
            enabled = True

        obj = _Obj()
        config._apply_env_disable(obj, "enabled", "TG_TEST_FLAG3", "test_feature")
        assert obj.enabled is True

    def test_no_change_on_arbitrary_value(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A non-falsy env value (e.g. '1') leaves the attribute unchanged."""
        from token_goat import config

        monkeypatch.setenv("TG_TEST_FLAG4", "1")

        class _Obj:
            enabled = True

        obj = _Obj()
        config._apply_env_disable(obj, "enabled", "TG_TEST_FLAG4", "test_feature")
        assert obj.enabled is True

    def test_uses_setattr_on_arbitrary_attr(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """_apply_env_disable uses setattr so it works on any attribute name."""
        from token_goat import config

        monkeypatch.setenv("TG_TEST_FLAG5", "off")

        class _Obj:
            prefer_avif = True

        obj = _Obj()
        config._apply_env_disable(obj, "prefer_avif", "TG_TEST_FLAG5", "image_shrink.prefer_avif")
        assert obj.prefer_avif is False

    def test_config_load_respects_bash_compress_env(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """config.load() disables bash_compress when TOKEN_GOAT_BASH_COMPRESS=0."""
        from token_goat import config, paths

        monkeypatch.setattr(paths, "_DATA_DIR_CACHE", tmp_path)
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", "0")

        cfg = config.load()
        assert cfg.bash_compress.enabled is False


# ---------------------------------------------------------------------------
# Item 7: hooks_common.bytes_to_tokens
# ---------------------------------------------------------------------------

class TestBytesToTokens:
    """Tests for hooks_common.bytes_to_tokens."""

    def test_typical_value(self) -> None:
        """350 bytes → 100 tokens (350 / 3.5 = 100)."""
        from token_goat.hooks_common import bytes_to_tokens

        assert bytes_to_tokens(350) == 100

    def test_minimum_one_for_small_input(self) -> None:
        """Single-byte input returns 1, not 0."""
        from token_goat.hooks_common import bytes_to_tokens

        assert bytes_to_tokens(1) == 1

    def test_zero_bytes_returns_one(self) -> None:
        """Zero bytes still returns 1 (max(1, 0) == 1)."""
        from token_goat.hooks_common import bytes_to_tokens

        assert bytes_to_tokens(0) == 1

    def test_large_input(self) -> None:
        """Large byte counts scale correctly."""
        from token_goat.hooks_common import bytes_to_tokens

        # 3500 bytes / 3.5 chars-per-token = 1000 tokens
        assert bytes_to_tokens(3500) == 1000

    def test_matches_inline_formula(self) -> None:
        """Output matches the original inline formula for a range of inputs."""
        from token_goat.hints import CHARS_PER_TOKEN
        from token_goat.hooks_common import bytes_to_tokens

        for n in (0, 1, 7, 100, 350, 1000, 9999):
            expected = max(1, int(n / CHARS_PER_TOKEN))
            assert bytes_to_tokens(n) == expected, f"mismatch at n={n}"


# ---------------------------------------------------------------------------
# Item 12: render.ansi.color_stdout / color_stderr
# ---------------------------------------------------------------------------

class TestColorHelpers:
    """Tests for render.ansi.color_stdout and color_stderr."""

    def test_color_stdout_false_when_no_color_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """NO_COLOR env var suppresses color_stdout."""
        from token_goat.render.ansi import color_stdout

        monkeypatch.setenv("NO_COLOR", "1")
        assert color_stdout() is False

    def test_color_stderr_false_when_no_color_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """NO_COLOR env var suppresses color_stderr."""
        from token_goat.render.ansi import color_stderr

        monkeypatch.setenv("NO_COLOR", "1")
        assert color_stderr() is False

    def test_color_stdout_false_when_not_tty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Non-TTY stdout → color_stdout() is False."""
        import sys

        from token_goat.render.ansi import color_stdout

        monkeypatch.delenv("NO_COLOR", raising=False)
        with patch.object(sys.stdout, "isatty", return_value=False):
            assert color_stdout() is False

    def test_color_stderr_false_when_not_tty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Non-TTY stderr → color_stderr() is False."""
        import sys

        from token_goat.render.ansi import color_stderr

        monkeypatch.delenv("NO_COLOR", raising=False)
        with patch.object(sys.stderr, "isatty", return_value=False):
            assert color_stderr() is False

    def test_color_stdout_true_when_tty_and_no_color_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """TTY stdout + NO_COLOR unset → color_stdout() is True."""
        import sys

        from token_goat.render.ansi import color_stdout

        monkeypatch.delenv("NO_COLOR", raising=False)
        with patch.object(sys.stdout, "isatty", return_value=True):
            assert color_stdout() is True

    def test_color_stderr_true_when_tty_and_no_color_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """TTY stderr + NO_COLOR unset → color_stderr() is True."""
        import sys

        from token_goat.render.ansi import color_stderr

        monkeypatch.delenv("NO_COLOR", raising=False)
        with patch.object(sys.stderr, "isatty", return_value=True):
            assert color_stderr() is True

    def test_use_color_uses_color_stdout(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """USE_COLOR is computed via color_stdout() at import time — it is a bool."""
        from token_goat.render.ansi import USE_COLOR

        assert isinstance(USE_COLOR, bool)


# ---------------------------------------------------------------------------
# Item 13: compact._run_git
# ---------------------------------------------------------------------------

class TestRunGit:
    """Tests for compact._run_git."""

    def test_returns_stdout_on_success(self, tmp_path: Path) -> None:
        """A successful git command returns stripped stdout."""
        from token_goat.compact import _run_git

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "  abc123 initial commit  \n"

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            result = _run_git(["log", "--oneline"], str(tmp_path), timeout=2)

        assert result == "abc123 initial commit"
        mock_run.assert_called_once()

    def test_returns_none_on_nonzero_exit(self, tmp_path: Path) -> None:
        """Non-zero exit code returns None."""
        from token_goat.compact import _run_git

        mock_result = MagicMock()
        mock_result.returncode = 128
        mock_result.stdout = "fatal: not a git repo\n"

        with patch("subprocess.run", return_value=mock_result):
            assert _run_git(["status"], str(tmp_path)) is None

    def test_returns_none_on_empty_output(self, tmp_path: Path) -> None:
        """Zero exit code but empty stdout returns None."""
        from token_goat.compact import _run_git

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "   "

        with patch("subprocess.run", return_value=mock_result):
            assert _run_git(["diff", "--stat", "HEAD"], str(tmp_path)) is None

    def test_returns_none_on_file_not_found(self, tmp_path: Path) -> None:
        """FileNotFoundError (git not installed) returns None, does not raise."""
        from token_goat.compact import _run_git

        with patch("subprocess.run", side_effect=FileNotFoundError("git not found")):
            assert _run_git(["log"], str(tmp_path)) is None

    def test_returns_none_on_timeout(self, tmp_path: Path) -> None:
        """TimeoutExpired returns None, does not raise."""
        from token_goat.compact import _run_git

        with patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired(["git"], 2),
        ):
            assert _run_git(["log"], str(tmp_path), timeout=2) is None

    def test_passes_args_and_cwd(self, tmp_path: Path) -> None:
        """_run_git forwards args and cwd correctly to subprocess.run.

        Since _run_git now delegates to util.run_git, --no-optional-locks is
        automatically prepended to prevent .git/index.lock contention.
        """
        from token_goat.compact import _run_git

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "output\n"

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            _run_git(["diff", "--stat"], str(tmp_path), timeout=3)

        call_kwargs = mock_run.call_args
        assert call_kwargs.args[0] == ["git", "--no-optional-locks", "diff", "--stat"]
        assert call_kwargs.kwargs["cwd"] == str(tmp_path)
        assert call_kwargs.kwargs["timeout"] == 3


# ---------------------------------------------------------------------------
# Item 9: util.get_logger — logger names are preserved
# ---------------------------------------------------------------------------

class TestGetLoggerNames:
    """Verify that files migrated to get_logger still produce the correct logger names."""

    def test_embeddings_logger_name(self) -> None:
        """embeddings._LOG uses the canonical token_goat.embeddings name."""
        import token_goat.embeddings as embeddings_mod

        assert embeddings_mod._LOG.name == "token_goat.embeddings"

    def test_languages_common_logger_name(self) -> None:
        """languages.common._LOG uses the canonical token_goat.languages.common name."""
        import token_goat.languages.common as common_mod

        assert common_mod._LOG.name == "token_goat.languages.common"

    def test_get_logger_returns_child_of_root(self) -> None:
        """get_logger('foo') returns a logger under token_goat.*."""
        import logging

        from token_goat.util import get_logger

        log = get_logger("foo")
        assert log.name == "token_goat.foo"
        assert isinstance(log, logging.Logger)
