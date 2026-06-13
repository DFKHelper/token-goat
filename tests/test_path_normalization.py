"""Tests for paths.normalize_path_key — relative-to-absolute dedup normalization.

Covers the scenarios described in the improvement plan:
- Relative vs absolute form of the same file produce the same key
- Backslash vs forward-slash variants map to the same key
- Mixed drive-letter case (Windows) maps to the same key
- No-cwd fallback: relative path uses string-only normalize_key
- Fail-soft: bad paths never raise
- record_grep_target deduplicates across relative/absolute forms
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from token_goat import paths, session

# ---------------------------------------------------------------------------
# normalize_path_key unit tests
# ---------------------------------------------------------------------------


class TestNormalizePathKeyAbsolute:
    """Absolute paths are resolved and normalized."""

    def test_backslash_to_forward_slash(self, tmp_path: Path) -> None:
        f = tmp_path / "scripts" / "ads.js"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
        win_path = str(f).replace("/", "\\")
        key = paths.normalize_path_key(win_path)
        assert "\\" not in key
        assert key == paths.normalize_path_key(str(f))

    def test_drive_letter_lowercased(self, tmp_path: Path) -> None:
        f = tmp_path / "file.py"
        f.write_text("x")
        abs_path = str(f.resolve())
        key = paths.normalize_path_key(abs_path)
        # Drive letter (if present) must be lowercase.
        if len(key) >= 2 and key[1] == ":":
            assert key[0].islower(), f"Drive letter not lowercased in {key!r}"

    def test_same_result_with_and_without_cwd_for_absolute(self, tmp_path: Path) -> None:
        f = tmp_path / "target.js"
        f.write_text("x")
        abs_path = str(f.resolve())
        assert paths.normalize_path_key(abs_path) == paths.normalize_path_key(abs_path, cwd=str(tmp_path))


class TestNormalizePathKeyRelative:
    """Relative paths resolve to the same key as their absolute equivalent when cwd is given."""

    def test_dot_slash_relative_matches_absolute(self, tmp_path: Path) -> None:
        sub = tmp_path / "scripts"
        sub.mkdir()
        f = sub / "ads.js"
        f.write_text("x")

        rel = "./scripts/ads.js"
        abs_key = paths.normalize_path_key(str(f.resolve()))
        rel_key = paths.normalize_path_key(rel, cwd=str(tmp_path))
        assert rel_key == abs_key, f"rel_key={rel_key!r} != abs_key={abs_key!r}"

    def test_bare_relative_matches_absolute(self, tmp_path: Path) -> None:
        f = tmp_path / "util.py"
        f.write_text("x")

        rel = "util.py"
        abs_key = paths.normalize_path_key(str(f.resolve()))
        rel_key = paths.normalize_path_key(rel, cwd=str(tmp_path))
        assert rel_key == abs_key

    def test_nested_relative_matches_absolute(self, tmp_path: Path) -> None:
        deep = tmp_path / "src" / "lib" / "core.ts"
        deep.parent.mkdir(parents=True)
        deep.write_text("x")

        rel = "src/lib/core.ts"
        abs_key = paths.normalize_path_key(str(deep.resolve()))
        rel_key = paths.normalize_path_key(rel, cwd=str(tmp_path))
        assert rel_key == abs_key

    def test_no_cwd_falls_back_to_normalize_key(self) -> None:
        # Without cwd, relative paths cannot be resolved; must not raise.
        result = paths.normalize_path_key("./scripts/ads.js")
        assert isinstance(result, str)
        # Should equal the string-only normalization fallback.
        assert result == paths.normalize_key("./scripts/ads.js")

    def test_backslash_relative_with_cwd(self, tmp_path: Path) -> None:
        f = tmp_path / "a" / "b.py"
        f.parent.mkdir()
        f.write_text("x")

        rel_backslash = "a\\b.py"
        abs_key = paths.normalize_path_key(str(f.resolve()))
        rel_key = paths.normalize_path_key(rel_backslash, cwd=str(tmp_path))
        assert rel_key == abs_key


@pytest.mark.skipif(sys.platform != "win32", reason="Windows drive-letter test")
class TestNormalizePathKeyWindowsDriveLetter:
    """Drive-letter case variants produce identical keys (Windows only)."""

    def test_upper_and_lower_drive_same_key(self, tmp_path: Path) -> None:
        f = tmp_path / "file.py"
        f.write_text("x")
        abs_path = str(f.resolve())
        # Manually construct uppercase-drive variant.
        if len(abs_path) >= 2 and abs_path[1] == ":":
            upper = abs_path[0].upper() + abs_path[1:]
            lower = abs_path[0].lower() + abs_path[1:]
            assert paths.normalize_path_key(upper) == paths.normalize_path_key(lower)


class TestNormalizePathKeyFailSoft:
    """Edge cases and failure modes never raise."""

    def test_empty_string(self) -> None:
        result = paths.normalize_path_key("")
        assert isinstance(result, str)

    def test_nonexistent_absolute_path(self, tmp_path: Path) -> None:
        gone = tmp_path / "does_not_exist.py"
        # resolve() on a non-existent path still returns an absolute path in Python 3.6+.
        result = paths.normalize_path_key(str(gone))
        assert isinstance(result, str)

    def test_nonexistent_relative_with_cwd(self, tmp_path: Path) -> None:
        result = paths.normalize_path_key("no_such_file.py", cwd=str(tmp_path))
        assert isinstance(result, str)

    def test_stdin_placeholder(self) -> None:
        result = paths.normalize_path_key("-")
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# record_grep_target dedup across relative/absolute forms
# ---------------------------------------------------------------------------


class TestRecordGrepTargetPathNormalization:
    """record_grep_target treats relative and absolute forms of the same file identically."""

    def test_absolute_then_relative_counts_together(self, tmp_data_dir: Path, tmp_path: Path) -> None:
        f = tmp_path / "target.py"
        f.write_text("x = 1")

        cache = session.load("rgt-norm-1")
        abs_path = str(f.resolve())
        rel_path = "target.py"

        # First hit: absolute
        cache.record_grep_target(abs_path)
        # Second hit: relative, with cwd
        cache.record_grep_target(rel_path, cwd=str(tmp_path))
        # Third hit: relative with dot-slash prefix, with cwd — should trigger
        result = cache.record_grep_target("./target.py", cwd=str(tmp_path))
        assert result is True, "Expected True on 3rd hit (relative and absolute forms combined)"

    def test_relative_then_absolute_counts_together(self, tmp_data_dir: Path, tmp_path: Path) -> None:
        f = tmp_path / "util.py"
        f.write_text("x = 1")

        cache = session.load("rgt-norm-2")
        abs_path = str(f.resolve())

        cache.record_grep_target("./util.py", cwd=str(tmp_path))
        cache.record_grep_target("util.py", cwd=str(tmp_path))
        result = cache.record_grep_target(abs_path)
        assert result is True

    def test_backslash_and_forward_slash_same_key(self, tmp_data_dir: Path, tmp_path: Path) -> None:
        f = tmp_path / "mod.py"
        f.write_text("x = 1")

        cache = session.load("rgt-norm-3")
        abs_fwd = str(f.resolve()).replace("\\", "/")
        abs_back = abs_fwd.replace("/", "\\")

        cache.record_grep_target(abs_fwd)
        cache.record_grep_target(abs_back)
        result = cache.record_grep_target(abs_fwd)
        assert result is True

    def test_no_cwd_relative_paths_use_string_key(self, tmp_data_dir: Path, tmp_path: Path) -> None:
        """Without cwd, relative paths key on the normalized string — no cross-form dedup."""
        f = tmp_path / "x.py"
        f.write_text("x = 1")

        cache = session.load("rgt-norm-4")
        abs_path = str(f.resolve())
        rel_path = "./x.py"

        # Absolute hits
        cache.record_grep_target(abs_path)
        cache.record_grep_target(abs_path)
        # Relative without cwd — different string key, so counter stays at 1 for this key
        result = cache.record_grep_target(rel_path)
        # Relative key only hit once; should NOT trigger (count=1 for rel key)
        assert result is False
