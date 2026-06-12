"""Tests for grep_hash path normalization (iter 5).

Verifies that path variants that refer to the same directory
produce identical cache keys so redundant Grep calls are detected.
"""
from __future__ import annotations

from token_goat.bash_cache import _normalize_grep_path, grep_hash


class TestNormalizeGrepPath:
    def test_dot_slash_stripped(self) -> None:
        assert _normalize_grep_path("./src") == "src"

    def test_dot_slash_trailing_slash_stripped(self) -> None:
        assert _normalize_grep_path("./src/") == "src"

    def test_trailing_slash_only(self) -> None:
        assert _normalize_grep_path("src/") == "src"

    def test_double_dot_slash(self) -> None:
        assert _normalize_grep_path("././src/") == "src"

    def test_plain_path_unchanged(self) -> None:
        assert _normalize_grep_path("src") == "src"

    def test_backslash_to_forward(self) -> None:
        assert _normalize_grep_path(".\\src\\") == "src"

    def test_parent_relative_preserved(self) -> None:
        # ../foo should NOT have the leading part stripped (not a ./ prefix)
        assert _normalize_grep_path("../foo") == "../foo"

    def test_empty_string_passthrough(self) -> None:
        assert _normalize_grep_path("") == ""

    def test_dot_only(self) -> None:
        assert _normalize_grep_path("./") == ""

    def test_unix_root_not_collapsed(self) -> None:
        # "/" must not collapse to "" (would collide with path=None hash)
        assert _normalize_grep_path("/") == "/"

    def test_absolute_path_trailing_slash(self) -> None:
        assert _normalize_grep_path("/home/user/src/") == "/home/user/src"

    def test_nested_path(self) -> None:
        assert _normalize_grep_path("./src/token_goat/") == "src/token_goat"


class TestGrepHashNormalization:
    def test_dot_slash_same_as_plain(self) -> None:
        h1 = grep_hash("TODO", "src/", None, None, None)
        h2 = grep_hash("TODO", "./src/", None, None, None)
        assert h1 == h2

    def test_trailing_slash_same_as_no_slash(self) -> None:
        h1 = grep_hash("pattern", "src/token_goat", None, None, None)
        h2 = grep_hash("pattern", "src/token_goat/", None, None, None)
        assert h1 == h2

    def test_dot_slash_and_trailing_slash_same_as_bare(self) -> None:
        h1 = grep_hash("fn", "src", None, None, None)
        h2 = grep_hash("fn", "./src/", None, None, None)
        assert h1 == h2

    def test_none_path_unchanged(self) -> None:
        h1 = grep_hash("foo", None, None, None, None)
        h2 = grep_hash("foo", None, None, None, None)
        assert h1 == h2

    def test_different_paths_still_differ(self) -> None:
        h1 = grep_hash("TODO", "src/", None, None, None)
        h2 = grep_hash("TODO", "tests/", None, None, None)
        assert h1 != h2

    def test_different_patterns_still_differ(self) -> None:
        h1 = grep_hash("TODO", "src/", None, None, None)
        h2 = grep_hash("FIXME", "src/", None, None, None)
        assert h1 != h2

    def test_glob_filter_still_differentiates(self) -> None:
        h1 = grep_hash("fn", "./src/", "*.py", None, None)
        h2 = grep_hash("fn", "./src/", "*.ts", None, None)
        assert h1 != h2

    def test_backslash_path_same_as_forward(self) -> None:
        h1 = grep_hash("test", "src/", None, None, None)
        h2 = grep_hash("test", ".\\src\\", None, None, None)
        assert h1 == h2
