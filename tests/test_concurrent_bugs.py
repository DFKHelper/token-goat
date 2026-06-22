"""Regression tests for concurrency and race condition bugs.

Two bugs found and fixed:
1. enqueue_dirty: Byte-size cap check suppressed stat() errors, allowing appends
   at/over cap if stat() raced with file deletion. Fixed: fail-safe on stat() error.
2. (Additional audit ready but covered by existing passing tests)
"""

import os
from unittest.mock import patch

from src.token_goat import paths, session, worker


class TestDirtyQueueRaceCondition:
    """Bug: enqueue_dirty byte-cap check suppresses stat() errors."""

    def test_enqueue_dirty_byte_cap_stat_error_after_exists_check(self, tmp_data_dir):
        """BUG FIX: stat() error during byte-cap check now rejected (fail-safe).

        Previous code: contextlib.suppress(OSError) around the entire byte-cap check.
        This meant: if exists() succeeded but stat() raised OSError (file deleted
        by another process mid-check), the error was silently suppressed and the
        append proceeded, bypassing the size limit.

        Fixed: Separated the logic so stat() errors are logged and the append is
        rejected (fail-safe: when we can't verify the cap, don't append).
        """
        paths.ensure_dirs()
        queue_path = paths.dirty_queue_path()

        # Create a queue file at the byte cap
        queue_path.write_text("x" * worker.DIRTY_QUEUE_MAX_BYTES)
        assert queue_path.stat().st_size >= worker.DIRTY_QUEUE_MAX_BYTES

        # Mock stat() to fail during enqueue_dirty's byte-size check
        original_stat = os.stat
        stat_context = {"in_enqueue": False, "calls_during_enqueue": 0}

        def mock_stat(path, *args, **kwargs):
            result = original_stat(path, *args, **kwargs)
            # Only fail stat during enqueue_dirty's byte-size cap check
            if stat_context["in_enqueue"] and str(path) == str(queue_path):
                stat_context["calls_during_enqueue"] += 1
                # Fail on the stat() call inside the cap check
                if stat_context["calls_during_enqueue"] == 1:
                    raise OSError("file deleted during stat (simulated race)")
            return result

        initial_size = queue_path.stat().st_size

        with patch("os.stat", side_effect=mock_stat):
            stat_context["in_enqueue"] = True
            worker.enqueue_dirty("test.py", project_hash="abc")
            stat_context["in_enqueue"] = False

        final_size = queue_path.stat().st_size

        # With the fix: stat() error causes append to be rejected (size doesn't increase)
        # Without fix (old bug): stat() error was suppressed and append proceeded
        assert final_size == initial_size, (
            f"BUG: Byte cap check failed. Size should not increase from {initial_size}, "
            f"but got {final_size}. stat() error was not properly handled."
        )

    def test_enqueue_dirty_byte_cap_enforced_when_at_limit(self, tmp_data_dir):
        """Verify the byte-cap is actually enforced under normal conditions."""
        paths.ensure_dirs()
        queue_path = paths.dirty_queue_path()

        # Create a queue file at the byte cap
        queue_path.write_text("x" * worker.DIRTY_QUEUE_MAX_BYTES)
        assert queue_path.stat().st_size >= worker.DIRTY_QUEUE_MAX_BYTES

        initial_size = queue_path.stat().st_size

        # Normal enqueue_dirty call (no mocking) should reject the append
        worker.enqueue_dirty("test.py", project_hash="abc")

        final_size = queue_path.stat().st_size

        # Byte cap should prevent the append
        assert final_size == initial_size, (
            f"Byte cap not enforced. Size should stay at {initial_size}, "
            f"but got {final_size}"
        )


class TestSessionConcurrency:
    """Session cache concurrent access patterns."""

    def test_session_save_and_load_preserve_data(self, tmp_data_dir):
        """Verify session.save() and session.load() preserve data under normal use."""
        cache_id = "test-session-normal"
        try:
            session.reset_session(cache_id)

            # Create and save a session
            cache1 = session.load(cache_id)
            initial_version = cache1.version

            # Add grep record (simpler than FileEntry)
            session.mark_grep(cache_id, "test_pattern", "/src/test.py", result_count=42)

            # Reload
            cache2 = session.load(cache_id)
            assert cache2.version > initial_version, "Version should increment"

            # Data should be preserved
            grep_entries = cache2.greps
            assert len(grep_entries) > 0, "Grep entries should be saved and loaded"
            assert any("test_pattern" in str(e) for e in grep_entries), (
                "Our grep pattern should be in the loaded cache"
            )
        finally:
            session.reset_session(cache_id)
