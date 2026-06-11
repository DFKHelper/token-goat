"""Regression tests for bash_detect — lightweight binary→filter lookup.

Covers the P2-3/Code-10 fix: bash_detect.detect() must return the correct filter
name for known binaries (replacing the 75 ms bash_compress import with a <1 ms
dict lookup on the hot path) and None for unknown ones.
"""
from __future__ import annotations

import sys
from unittest.mock import patch

from token_goat import bash_detect


class TestDetectKnownBinaries:
    """detect() maps known binary stems to their filter names."""

    def test_pytest(self) -> None:
        assert bash_detect.detect(["pytest"]) == "pytest"

    def test_git(self) -> None:
        assert bash_detect.detect(["git"]) == "git-log"

    def test_npm(self) -> None:
        assert bash_detect.detect(["npm"]) == "npm"

    def test_cargo(self) -> None:
        assert bash_detect.detect(["cargo"]) == "cargo"

    def test_docker(self) -> None:
        assert bash_detect.detect(["docker"]) == "docker-compose"

    def test_gradle(self) -> None:
        assert bash_detect.detect(["gradle"]) == "gradle"

    def test_mvn(self) -> None:
        assert bash_detect.detect(["mvn"]) == "maven"

    def test_rg_mapped_to_grep(self) -> None:
        assert bash_detect.detect(["rg"]) == "grep"

    def test_kubectl(self) -> None:
        assert bash_detect.detect(["kubectl"]) == "kubectl-logs"


class TestDetectEdgeCases:
    """detect() handles stems, extensions, paths, and case normalization."""

    def test_unknown_binary_returns_none(self) -> None:
        assert bash_detect.detect(["totally_unknown_cmd_xyz"]) is None

    def test_empty_argv_returns_none(self) -> None:
        assert bash_detect.detect([]) is None

    def test_extension_stripped_from_stem(self) -> None:
        """pytest.exe → stem 'pytest' → matches filter."""
        assert bash_detect.detect(["pytest.exe"]) == "pytest"

    def test_path_prefix_stripped(self) -> None:
        """/usr/bin/pytest → stem 'pytest' → matches filter."""
        assert bash_detect.detect(["/usr/bin/pytest"]) == "pytest"

    def test_windows_path_prefix_stripped(self) -> None:
        r"""C:\tools\git.exe → stem 'git' → matches filter."""
        assert bash_detect.detect([r"C:\tools\git.exe"]) == "git-log"

    def test_case_insensitive_match(self) -> None:
        """PYTEST → lowercased → pytest → matches filter."""
        assert bash_detect.detect(["PYTEST"]) == "pytest"

    def test_extra_argv_elements_ignored(self) -> None:
        """Only argv[0] is used; extra arguments do not affect the result."""
        assert bash_detect.detect(["pytest", "-v", "--tb=short"]) == "pytest"
        assert bash_detect.detect(["totally_unknown", "pytest"]) is None


class TestBashCompressNotImportedForUnknownBinary:
    """_handle_bash_compress must not import bash_compress for unrecognised commands.

    Regression: before the bash_detect fast-path, the 75 ms bash_compress import
    was paid on every Bash pre-hook call regardless of whether any filter applied.
    After the fix, bash_compress is only imported when bash_detect.detect() returns
    a filter name (or '&&' is present in the command).
    """

    def test_bash_compress_not_imported_for_unknown_cmd(self, tmp_data_dir) -> None:
        """An unrecognised binary command must not trigger bash_compress import."""
        sys.modules.pop("token_goat.bash_compress", None)

        payload: dict = {
            "session_id": "det_sess_1",
            "tool_name": "Bash",
            "tool_input": {"command": "totally_unknown_binary_xyz --flag"},
        }
        with patch("token_goat.hooks_read._bash_compress_enabled", return_value=True):
            from token_goat.hooks_read import _handle_bash_compress
            result = _handle_bash_compress(payload)

        assert result is None
        assert "token_goat.bash_compress" not in sys.modules

