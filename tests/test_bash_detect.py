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
        assert bash_detect.detect(["npm"]) == "npm_install"

    def test_cargo(self) -> None:
        # cargo maps to the CargoFilter for build/test/check/clippy compression.
        assert bash_detect.detect(["cargo"]) == "cargo"

    def test_docker(self) -> None:
        assert bash_detect.detect(["docker"]) == "docker-compose"

    def test_gradle(self) -> None:
        assert bash_detect.detect(["gradle"]) == "gradle"

    def test_mvn(self) -> None:
        assert bash_detect.detect(["mvn"]) == "maven"

    def test_rg_mapped_to_rg(self) -> None:
        assert bash_detect.detect(["rg"]) == "rg"

    def test_kubectl(self) -> None:
        assert bash_detect.detect(["kubectl"]) == "kubectl-logs"

    def test_find_mapped_to_fd(self) -> None:
        """GNU find shares FdFilter — path-per-line output handled identically."""
        assert bash_detect.detect(["find"]) == "fd"

    def test_wc_mapped_to_wc(self) -> None:
        """wc is registered with its own WcFilter for whitespace normalisation."""
        assert bash_detect.detect(["wc"]) == "wc"


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


class TestBashDetectTableSync:
    """_BINARY_TO_FILTER must stay in sync with bash_compress.FILTERS.

    These tests fail if a new binary is added to bash_compress.FILTERS without
    updating bash_detect._BINARY_TO_FILTER, silently losing the fast-path bypass
    that avoids the 75 ms bash_compress import on every unrecognised command.
    """

    def _expected_table(self):
        """Build expected {binary: first_match_filter_name} from bash_compress.FILTERS."""
        from token_goat.bash_compress import FILTERS
        expected: dict[str, str] = {}
        for f in FILTERS:
            for binary in f.binaries:
                b = binary.lower()
                if b not in expected:
                    expected[b] = f.name
        return expected

    def test_no_binaries_missing_from_detect_table(self) -> None:
        """Every binary in bash_compress.FILTERS must appear in _BINARY_TO_FILTER."""
        from token_goat.bash_detect import _BINARY_TO_FILTER
        expected = self._expected_table()
        missing = sorted(b for b in expected if b not in _BINARY_TO_FILTER)
        assert not missing, (
            "Binaries in bash_compress.FILTERS but absent from bash_detect._BINARY_TO_FILTER "
            "(add them or run the generation script):\n  " + "\n  ".join(missing)
        )

    def test_no_stale_entries_in_detect_table(self) -> None:
        """Every entry in _BINARY_TO_FILTER must point to a real filter name in FILTERS."""
        from token_goat.bash_compress import FILTERS
        from token_goat.bash_detect import _BINARY_TO_FILTER
        valid_names = {f.name for f in FILTERS}
        stale = {b: n for b, n in _BINARY_TO_FILTER.items() if n not in valid_names}
        assert not stale, (
            "Entries in bash_detect._BINARY_TO_FILTER reference non-existent filter names: "
            + str(stale)
        )

    def test_detect_uses_first_match_filter(self) -> None:
        """Each binary must map to the first matching filter in FILTERS order."""
        from token_goat.bash_detect import _BINARY_TO_FILTER
        expected = self._expected_table()
        mismatched = {
            b: (expected[b], _BINARY_TO_FILTER[b])
            for b in expected
            if b in _BINARY_TO_FILTER and expected[b] != _BINARY_TO_FILTER[b]
        }
        assert not mismatched, (
            "Binary→filter mismatch (expected first-match from FILTERS, got different):\n"
            + "\n".join(
                f"  {b!r}: expected {exp!r}, got {act!r}"
                for b, (exp, act) in sorted(mismatched.items())
            )
        )

    def test_table_size_matches_filters(self) -> None:
        """Table entry count must equal the number of distinct binaries across all FILTERS."""
        from token_goat.bash_detect import _BINARY_TO_FILTER
        expected = self._expected_table()
        assert len(_BINARY_TO_FILTER) == len(expected), (
            f"Size mismatch: FILTERS has {len(expected)} distinct binaries, "
            f"_BINARY_TO_FILTER has {len(_BINARY_TO_FILTER)}"
        )


class TestBashCompressNotImportedForUnknownBinary:
    """_handle_bash_compress must not import bash_compress for unrecognised commands.

    Regression: before the bash_detect fast-path, the 75 ms bash_compress import
    was paid on every Bash pre-hook call regardless of whether any filter applied.
    After the fix, bash_compress is only imported when bash_detect.detect() returns
    a filter name (or '&&' is present in the command).
    """

    def test_bash_compress_not_imported_for_unknown_cmd(self, tmp_data_dir, monkeypatch) -> None:
        """An unrecognised binary command must not trigger bash_compress import."""
        # Use monkeypatch so the eviction is undone after the test; a bare
        # sys.modules.pop() would permanently remove the entry in this worker
        # process, causing later imports to produce a new class identity and
        # breaking isinstance() checks in other test modules.
        monkeypatch.delitem(sys.modules, "token_goat.bash_compress", raising=False)

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

