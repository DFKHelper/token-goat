"""Tests for discovered bugs."""
import subprocess
from pathlib import Path


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
        result = subprocess.run(
            ['rg', 'rpartition.*"::"', 'src/token_goat/read_commands.py'],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent.parent
        )
        lines = [line for line in result.stdout.split('\n') if line.strip()]
        assert len(lines) >= 5, f"Expected at least 5 rpartition uses, found {len(lines)}\n{result.stdout}"

    def test_no_bare_partition_on_double_colon_in_read_commands(self):
        """No bare partition('::') calls remain in read_commands.py target-parsing sites."""
        result = subprocess.run(
            ['rg', r'\.partition\("::"', 'src/token_goat/read_commands.py'],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent.parent
        )
        matches = [line for line in result.stdout.split('\n') if line.strip()]
        assert matches == [], (
            f"Found {len(matches)} bare partition('::') call(s) that should be rpartition:\n"
            + '\n'.join(matches)
        )
