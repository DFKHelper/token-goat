"""Tests for the session-summary CLI command."""
from __future__ import annotations

import json
import os
import time
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat import paths as paths_mod
from token_goat import session as session_mod
from token_goat.cli import app

runner = CliRunner()


class TestSessionSummaryCommand:
    """Tests for cmd_session_summary."""

    def test_text_output_format(self, tmp_data_dir):
        """Test that text output follows the expected format."""
        # Create a minimal session
        session_id = "test-session-abc123"
        sess = session_mod.SessionCache(
            session_id=session_id,
            started_ts=time.time() - 300,  # 5 minutes ago
            last_activity_ts=time.time(),
        )
        sess.files = {
            "src/foo.py": session_mod.FileEntry(
                rel_or_abs="src/foo.py",
                read_count=2,
                line_ranges=[(1, 50)],
                symbols_read=[],
                last_read_ts=time.time(),
            ),
            "src/bar.py": session_mod.FileEntry(
                rel_or_abs="src/bar.py",
                read_count=1,
                line_ranges=[(10, 20)],
                symbols_read=[],
                last_read_ts=time.time(),
            ),
        }
        sess.edited_files = {
            "src/baz.py": 3,
            "src/qux.py": 1,
        }
        session_mod.save(sess)

        result = runner.invoke(app, ["session-summary", "--session-id", session_id])
        assert result.exit_code == 0
        output = result.stdout
        assert "Session" in output
        assert "test-session" in output  # Short ID (first 12 chars)
        assert "2 files read" in output  # 2 files in sess.files
        assert "2 edited" in output  # 2 files in sess.edited_files
        assert "commits" in output
        assert "tokens saved" in output

    def test_json_output_structure(self, tmp_data_dir):
        """Test that JSON output has correct structure."""
        session_id = "test-json-session"
        sess = session_mod.SessionCache(
            session_id=session_id,
            started_ts=time.time() - 100,
            last_activity_ts=time.time(),
        )
        sess.files = {"src/a.py": session_mod.FileEntry(
            rel_or_abs="src/a.py",
            read_count=1,
            line_ranges=[],
            symbols_read=[],
            last_read_ts=time.time(),
        )}
        sess.edited_files = {"src/b.py": 2}
        session_mod.save(sess)

        result = runner.invoke(app, ["session-summary", "--session-id", session_id, "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)

        assert "session_id" in data
        assert data["session_id"] == session_id
        assert "files_read" in data
        assert data["files_read"] == 1
        assert "files_edited" in data
        assert data["files_edited"] == 1
        assert "commits_this_session" in data
        assert isinstance(data["commits_this_session"], int)
        assert "tokens_saved_estimate" in data
        assert isinstance(data["tokens_saved_estimate"], int)

    def test_no_session_text_message(self, tmp_data_dir):
        """Test graceful message when no session exists."""
        result = runner.invoke(app, ["session-summary", "--session-id", "nonexistent-session-xyz"])
        assert result.exit_code == 0
        assert "No active session" in result.stdout

    def test_no_session_json_message(self, tmp_data_dir):
        """Test JSON output when no session exists."""
        result = runner.invoke(
            app,
            ["session-summary", "--session-id", "nonexistent-session-xyz", "--json"],
        )
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert data["session_id"] == "nonexistent-session-xyz"
        assert data["files_read"] == 0
        assert data["files_edited"] == 0
        assert "message" in data or data["commits_this_session"] == 0

    def test_auto_detect_most_recent_session(self, tmp_data_dir):
        """Test automatic detection of most recent session when no --session-id is given."""
        # Create two sessions
        session_id_1 = "old-session-1"
        session_id_2 = "new-session-2"

        sess1 = session_mod.SessionCache(
            session_id=session_id_1,
            started_ts=time.time() - 1000,
            last_activity_ts=time.time() - 1000,
        )
        sess1.files = {"src/old.py": session_mod.FileEntry(
            rel_or_abs="src/old.py",
            read_count=1,
            line_ranges=[],
            symbols_read=[],
            last_read_ts=time.time(),
        )}
        session_mod.save(sess1)

        # Backdate sess1's file mtime so sess2 is unambiguously newer without sleeping.
        sess1_path = paths_mod.session_cache_path(session_id_1)
        past_ts = sess1_path.stat().st_mtime - 2.0
        os.utime(str(sess1_path), (past_ts, past_ts))

        sess2 = session_mod.SessionCache(
            session_id=session_id_2,
            started_ts=time.time() - 100,
            last_activity_ts=time.time(),
        )
        sess2.files = {
            "src/new.py": session_mod.FileEntry(
                rel_or_abs="src/new.py",
                read_count=2,
                line_ranges=[],
                symbols_read=[],
                last_read_ts=time.time(),
            ),
        }
        sess2.edited_files = {"src/new2.py": 1}
        session_mod.save(sess2)

        # Auto-detect (no --session-id)
        result = runner.invoke(app, ["session-summary"])
        assert result.exit_code == 0
        output = result.stdout
        # Should pick the newer session (sess2)
        assert "new-session-2" in output or "2 files read" in output or "1 edited" in output

    def test_env_var_detection(self, tmp_data_dir):
        """Test CLAUDE_SESSION_ID environment variable detection."""
        session_id = "env-test-session"
        sess = session_mod.SessionCache(
            session_id=session_id,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        sess.files = {"src/x.py": session_mod.FileEntry(
            rel_or_abs="src/x.py",
            read_count=1,
            line_ranges=[],
            symbols_read=[],
            last_read_ts=time.time(),
        )}
        session_mod.save(sess)

        # Set env var
        with patch.dict(os.environ, {"CLAUDE_SESSION_ID": session_id}):
            result = runner.invoke(app, ["session-summary"])
            assert result.exit_code == 0
            output = result.stdout
            # Session ID gets truncated to 12 chars in output
            short_id = session_id[:12]
            assert short_id in output

    def test_short_id_in_output(self, tmp_data_dir):
        """Test that session ID is shortened to 12 chars in text output."""
        long_session_id = "this-is-a-very-long-session-id-that-exceeds-twelve-chars"
        sess = session_mod.SessionCache(
            session_id=long_session_id,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session_mod.save(sess)

        result = runner.invoke(app, ["session-summary", "--session-id", long_session_id])
        assert result.exit_code == 0
        output = result.stdout
        # Check that the 12-char truncation is used
        short_expected = long_session_id[:12]
        assert short_expected in output

    def test_empty_session(self, tmp_data_dir):
        """Test output for an empty session with no files or edits."""
        session_id = "empty-session"
        sess = session_mod.SessionCache(
            session_id=session_id,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session_mod.save(sess)

        result = runner.invoke(app, ["session-summary", "--session-id", session_id])
        assert result.exit_code == 0
        output = result.stdout
        assert "0 files read" in output
        assert "0 edited" in output
        assert "0 commits" in output

    def test_json_always_has_required_keys(self, tmp_data_dir):
        """Test that JSON output always includes required keys, even for empty sessions."""
        session_id = "minimal-session"
        sess = session_mod.SessionCache(
            session_id=session_id,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session_mod.save(sess)

        result = runner.invoke(app, ["session-summary", "--session-id", session_id, "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)

        required_keys = {
            "session_id",
            "files_read",
            "files_edited",
            "commits_this_session",
            "tokens_saved_estimate",
        }
        assert required_keys.issubset(data.keys()), f"Missing keys: {required_keys - set(data.keys())}"
