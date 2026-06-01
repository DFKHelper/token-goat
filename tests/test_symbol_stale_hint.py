"""Tests for symbol-level stale-edit hint.

Covers:
- snapshots.symbol_changed_since_read()  (the detection helper)
- hints.build_symbol_stale_hint()        (the hint builder)
- _run_read_like_command integration     (via the read command with a real project)
"""
from __future__ import annotations

from token_goat import hints, snapshots

# ---------------------------------------------------------------------------
# snapshots.symbol_changed_since_read
# ---------------------------------------------------------------------------

class TestSymbolChangedSinceRead:
    """Unit tests for the symbol-level snapshot comparison helper."""

    def test_no_snapshot_returns_false(self, tmp_data_dir):
        """When no snapshot exists for the file, returns False (no warning)."""
        result = snapshots.symbol_changed_since_read(
            session_id="stale-1",
            file_path="/proj/src/auth.py",
            symbol_name="login",
            current_start_line=1,
            current_end_line=5,
            current_text="def login():\n    return True\n",
        )
        assert result is False

    def test_unchanged_symbol_returns_false(self, tmp_data_dir):
        """When the symbol body matches the snapshot, returns False."""
        body = "def login():\n    return True\n"
        # Snapshot = exact same file content
        snapshots.store("stale-2", "/proj/src/auth.py", body.encode())
        result = snapshots.symbol_changed_since_read(
            session_id="stale-2",
            file_path="/proj/src/auth.py",
            symbol_name="login",
            current_start_line=1,
            current_end_line=2,
            current_text=body,
        )
        assert result is False

    def test_changed_symbol_returns_true(self, tmp_data_dir):
        """When the symbol body differs from the snapshot, returns True."""
        old_body = "def login():\n    return True\n"
        new_body = "def login():\n    raise NotImplementedError\n"
        # Snapshot = old file
        snapshots.store("stale-3", "/proj/src/auth.py", old_body.encode())
        result = snapshots.symbol_changed_since_read(
            session_id="stale-3",
            file_path="/proj/src/auth.py",
            symbol_name="login",
            current_start_line=1,
            current_end_line=2,
            current_text=new_body,
        )
        assert result is True

    def test_symbol_moved_but_unchanged_returns_false(self, tmp_data_dir):
        """When lines were inserted BEFORE the symbol, body unchanged — returns False.

        This tests the content-search fallback: line numbers shift but the body
        is still present in the snapshot verbatim.
        """
        symbol_body = "def login():\n    return True\n"
        # Old file: symbol at lines 1-2
        old_file = symbol_body
        # New file: 3 new lines before the symbol, pushing it to lines 4-5
        snapshots.store("stale-4", "/proj/src/auth.py", old_file.encode())
        # The caller passes the new (shifted) line numbers; the helper should
        # find the body in the snapshot via substring search and return False.
        result = snapshots.symbol_changed_since_read(
            session_id="stale-4",
            file_path="/proj/src/auth.py",
            symbol_name="login",
            current_start_line=4,
            current_end_line=5,
            current_text=symbol_body,
        )
        assert result is False

    def test_empty_session_id_returns_false(self, tmp_data_dir):
        """Empty session_id is a no-op — returns False without a lookup."""
        result = snapshots.symbol_changed_since_read(
            session_id="",
            file_path="/proj/src/auth.py",
            symbol_name="login",
            current_start_line=1,
            current_end_line=2,
            current_text="def login(): pass\n",
        )
        assert result is False

    def test_empty_file_path_returns_false(self, tmp_data_dir):
        """Empty file_path is a no-op — returns False without a lookup."""
        result = snapshots.symbol_changed_since_read(
            session_id="stale-6",
            file_path="",
            symbol_name="login",
            current_start_line=1,
            current_end_line=2,
            current_text="def login(): pass\n",
        )
        assert result is False

    def test_new_symbol_not_in_snapshot_returns_true(self, tmp_data_dir):
        """A brand-new symbol that did not exist in the snapshot returns True.

        Models a scenario where the agent read the file, then a new function
        was added.  The new body is absent from the snapshot, so it must have
        changed (or been added) since the last read.
        """
        old_file = "# empty module\n"
        new_body = "def new_func():\n    pass\n"
        snapshots.store("stale-7", "/proj/src/new_mod.py", old_file.encode())
        result = snapshots.symbol_changed_since_read(
            session_id="stale-7",
            file_path="/proj/src/new_mod.py",
            symbol_name="new_func",
            current_start_line=1,
            current_end_line=2,
            current_text=new_body,
        )
        assert result is True

    def test_multiline_symbol_change_detected(self, tmp_data_dir):
        """A change to a multi-line function body is detected correctly."""
        old_body = (
            "def compute(x, y):\n"
            "    result = x + y\n"
            "    return result\n"
        )
        new_body = (
            "def compute(x, y):\n"
            "    result = x * y  # changed operator\n"
            "    return result\n"
        )
        snapshots.store("stale-8", "/proj/src/math.py", old_body.encode())
        result = snapshots.symbol_changed_since_read(
            session_id="stale-8",
            file_path="/proj/src/math.py",
            symbol_name="compute",
            current_start_line=1,
            current_end_line=3,
            current_text=new_body,
        )
        assert result is True


# ---------------------------------------------------------------------------
# hints.build_symbol_stale_hint
# ---------------------------------------------------------------------------

class TestBuildSymbolStaleHint:
    """Unit tests for the public hint-builder wrapper."""

    def test_returns_none_when_no_snapshot(self, tmp_data_dir):
        """No snapshot → no hint (agent has not read this file yet)."""
        result = hints.build_symbol_stale_hint(
            session_id="hint-1",
            file_path="/proj/src/foo.py",
            symbol_name="bar",
            current_start_line=1,
            current_end_line=3,
            current_text="def bar(): pass\n",
        )
        assert result is None

    def test_returns_none_when_symbol_unchanged(self, tmp_data_dir):
        """Unchanged symbol → no hint."""
        body = "def bar(): pass\n"
        snapshots.store("hint-2", "/proj/src/foo.py", body.encode())
        result = hints.build_symbol_stale_hint(
            session_id="hint-2",
            file_path="/proj/src/foo.py",
            symbol_name="bar",
            current_start_line=1,
            current_end_line=1,
            current_text=body,
        )
        assert result is None

    def test_returns_warning_when_symbol_changed(self, tmp_data_dir):
        """Modified symbol → non-None warning string."""
        old_body = "def bar(): return 1\n"
        new_body = "def bar(): return 2\n"
        snapshots.store("hint-3", "/proj/src/foo.py", old_body.encode())
        result = hints.build_symbol_stale_hint(
            session_id="hint-3",
            file_path="/proj/src/foo.py",
            symbol_name="bar",
            current_start_line=1,
            current_end_line=1,
            current_text=new_body,
        )
        assert result is not None
        assert isinstance(result, str)

    def test_warning_mentions_file_and_symbol(self, tmp_data_dir):
        """The hint text references the file and symbol name for agent context."""
        old_body = "def authenticate(): pass\n"
        new_body = "def authenticate(): raise ValueError\n"
        snapshots.store("hint-4", "/proj/src/auth.py", old_body.encode())
        result = hints.build_symbol_stale_hint(
            session_id="hint-4",
            file_path="/proj/src/auth.py",
            symbol_name="authenticate",
            current_start_line=1,
            current_end_line=1,
            current_text=new_body,
        )
        assert result is not None
        assert "authenticate" in result
        assert "auth.py" in result

    def test_returns_none_for_empty_session_id(self, tmp_data_dir):
        """Empty session_id → no hint (no session context)."""
        result = hints.build_symbol_stale_hint(
            session_id="",
            file_path="/proj/src/foo.py",
            symbol_name="bar",
            current_start_line=1,
            current_end_line=1,
            current_text="def bar(): pass\n",
        )
        assert result is None

    def test_hint_contains_modified_indicator(self, tmp_data_dir):
        """The hint text should communicate that the symbol was modified."""
        old_body = "def process(): return None\n"
        new_body = "def process(): return {}\n"
        snapshots.store("hint-5", "/proj/src/worker.py", old_body.encode())
        result = hints.build_symbol_stale_hint(
            session_id="hint-5",
            file_path="/proj/src/worker.py",
            symbol_name="process",
            current_start_line=1,
            current_end_line=1,
            current_text=new_body,
        )
        assert result is not None
        # The hint must communicate that the symbol was modified
        hint_lower = result.lower()
        assert "modif" in hint_lower or "changed" in hint_lower or "⚠" in result
