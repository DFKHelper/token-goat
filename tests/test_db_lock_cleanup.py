"""Test for project_writer_lock cleanup on write failure (regression test for fd leak)."""
from __future__ import annotations

from unittest.mock import patch

import pytest

import token_goat.paths as paths
from token_goat import db


def test_project_writer_lock_cleans_up_on_write_failure(tmp_data_dir):
    """When os.write fails after lock file creation, the lock file is cleaned up.

    Regression test: if os.write() raised an exception after os.open(O_EXCL)
    succeeded, the lock file remained on disk, causing TimeoutError on
    subsequent acquisition attempts.
    """
    project_hash = "deadbeef0102"

    def failing_write(fd, data):
        raise OSError("Simulated write failure")

    with (
        patch("os.write", side_effect=failing_write),
        pytest.raises(OSError, match="Simulated write failure"),
        db.project_writer_lock(project_hash, timeout_sec=0.5),
    ):
        pass

    lock_path = paths.locks_dir() / f"{project_hash}.lock"
    assert not lock_path.exists(), "Lock file was not cleaned up after write failure"

    with db.project_writer_lock(project_hash, timeout_sec=0.5):
        assert lock_path.exists()

    assert not lock_path.exists()
