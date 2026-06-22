"""Tests for discovered bugs."""
import re
from pathlib import Path

_SRC = Path(__file__).parent.parent / "src" / "token_goat"


class TestSemanticSearchEdgeCases:
    """Test semantic search with edge case inputs."""

    def test_semantic_search_empty_query_returns_empty_list(self):
        """Empty query should return [] not raise."""
        from token_goat.embeddings import semantic_search
        result = semantic_search(
            type('obj', (), {'hash': 'nonexistent'}),
            "",
            k=5
        )
        assert result == []

    def test_semantic_search_whitespace_only_returns_empty_list(self):
        """Whitespace-only query should return [] not raise."""
        from token_goat.embeddings import semantic_search
        result = semantic_search(
            type('obj', (), {'hash': 'nonexistent'}),
            "   \n  \t  ",
            k=5
        )
        assert result == []


class TestTargetParsingAffectsAllCommands:
    """All target-parsing CLI commands use rpartition to split on the LAST ::."""

    def test_rpartition_used_in_all_read_commands(self):
        """Verify rpartition is used in all target-parsing sites in read_commands.py.

        Guards against regression back to partition, which would break targets
        whose file path contains '::' (splits on FIRST instead of LAST occurrence).
        Sites covered: _run_read_like_command, _run_read_line_range, read, refs, blame.
        """
        text = (_SRC / "read_commands.py").read_text(encoding="utf-8")
        lines = [ln for ln in text.splitlines() if re.search(r'rpartition.*"::"', ln)]
        assert len(lines) >= 5, f"Expected at least 5 rpartition uses, found {len(lines)}\n" + "\n".join(lines)

    def test_no_bare_partition_on_double_colon_in_read_commands(self):
        """No bare partition('::') calls remain in read_commands.py target-parsing sites."""
        text = (_SRC / "read_commands.py").read_text(encoding="utf-8")
        matches = [ln for ln in text.splitlines() if re.search(r'\.partition\("::"', ln)]
        assert matches == [], (
            f"Found {len(matches)} bare partition('::') call(s) that should be rpartition:\n"
            + "\n".join(matches)
        )

    def test_no_first_split_on_double_colon_in_hints(self):
        """hints.py pinned-symbol lookup uses rsplit (LAST ::) not split (FIRST ::).

        Regression guard: split('::', 1) on a spec like 'my::path.py::sym' would
        yield file='my', sym='path.py::sym' instead of file='my::path.py', sym='sym'.
        """
        text = (_SRC / "hints.py").read_text(encoding="utf-8")
        matches = [ln for ln in text.splitlines() if re.search(r'\.split\("::", 1\)', ln)]
        assert matches == [], (
            f"Found {len(matches)} split('::', 1) in hints.py that should be rsplit:\n"
            + "\n".join(matches)
        )

    def test_no_first_split_on_double_colon_in_target_parsing(self):
        """read_commands.py target-parsing site uses rsplit (LAST ::) not split (FIRST ::)."""
        text = (_SRC / "read_commands.py").read_text(encoding="utf-8")
        # Only rsplit calls should appear; bare split("::", 1) is the bug
        bare = [
            ln for ln in text.splitlines()
            if re.search(r'split\("::", 1\)', ln) and "rsplit" not in ln
        ]
        assert bare == [], (
            f"Found {len(bare)} bare split('::', 1) in read_commands.py that should be rsplit:\n"
            + "\n".join(bare)
        )
