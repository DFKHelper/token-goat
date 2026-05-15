"""Test paths module."""
from pathlib import Path

import pytest

from token_goat import paths


def test_ensure_dirs_creates_all_dirs(tmp_data_dir):
    """Test that ensure_dirs creates all subdirectories idempotently."""
    paths.ensure_dirs()

    expected_dirs = [
        tmp_data_dir,
        tmp_data_dir / "projects",
        tmp_data_dir / "sessions",
        tmp_data_dir / "images",
        tmp_data_dir / "models",
        tmp_data_dir / "logs",
        tmp_data_dir / "locks",
        tmp_data_dir / "queue",
    ]

    for d in expected_dirs:
        assert d.exists(), f"Directory {d} was not created"

    # Call again to verify idempotency (should not raise)
    paths.ensure_dirs()

    for d in expected_dirs:
        assert d.exists(), f"Directory {d} was not created on second call"


def test_python_runner_argv_basic():
    """Test that python_runner_argv constructs valid argv."""
    argv = paths.python_runner_argv("symbol", "foo")
    assert isinstance(argv, list)
    assert len(argv) >= 3
    assert argv[1] == "-m"
    assert argv[2] == "token_goat.cli"
    assert argv[3] == "symbol"
    assert argv[4] == "foo"


def test_python_runner_argv_no_args():
    """Test python_runner_argv with no subcommands."""
    argv = paths.python_runner_argv()
    assert isinstance(argv, list)
    assert len(argv) == 3
    assert argv[1] == "-m"
    assert argv[2] == "token_goat.cli"


def test_python_runner_argv_multiple_args():
    """Test python_runner_argv with multiple arguments."""
    argv = paths.python_runner_argv("read", "src/foo.py::bar")
    assert argv[3] == "read"
    assert argv[4] == "src/foo.py::bar"


def test_python_runner_command_basic():
    """Test that python_runner_command returns a shell command string."""
    cmd = paths.python_runner_command("symbol", "test")
    assert isinstance(cmd, str)
    assert "token_goat.cli" in cmd
    assert "symbol" in cmd
    assert "test" in cmd
    # Should have forward slashes, not backslashes
    assert "\\" not in cmd


def test_python_runner_command_quotes_paths_with_spaces():
    """Test that python_runner_command quotes paths containing spaces."""
    cmd = paths.python_runner_command("read", "path with spaces.py")
    assert "path with spaces.py" in cmd or '"path' in cmd


def test_python_runner_command_no_args():
    """Test python_runner_command with no subcommands."""
    cmd = paths.python_runner_command()
    assert isinstance(cmd, str)
    assert "token_goat.cli" in cmd


def test_global_db_path_structure(tmp_data_dir):
    """Test that global_db_path returns a valid path."""
    db_path = paths.global_db_path()
    assert isinstance(db_path, Path)
    assert db_path.name == "global.db"
    assert "global.db" in str(db_path)


def test_project_db_path_structure(tmp_data_dir):
    """Test that project_db_path includes project hash."""
    hash_val = "abc123def456"
    db_path = paths.project_db_path(hash_val)
    assert isinstance(db_path, Path)
    assert db_path.name == f"{hash_val}.db"
    assert hash_val in str(db_path)


def test_session_cache_path_structure(tmp_data_dir):
    """Test that session_cache_path includes session ID."""
    session_id = "sess_12345"
    cache_path = paths.session_cache_path(session_id)
    assert isinstance(cache_path, Path)
    assert session_id in str(cache_path)
    assert cache_path.name == f"{session_id}.json"


def test_image_cache_dir_structure(tmp_data_dir):
    """Test that image_cache_dir returns correct path."""
    img_dir = paths.image_cache_dir()
    assert isinstance(img_dir, Path)
    assert img_dir.name == "images"


def test_models_dir_structure(tmp_data_dir):
    """Test that models_dir returns correct path."""
    models = paths.models_dir()
    assert isinstance(models, Path)
    assert models.name == "models"


def test_logs_dir_structure(tmp_data_dir):
    """Test that logs_dir returns correct path."""
    logs = paths.logs_dir()
    assert isinstance(logs, Path)
    assert logs.name == "logs"


def test_locks_dir_structure(tmp_data_dir):
    """Test that locks_dir returns correct path."""
    locks = paths.locks_dir()
    assert isinstance(locks, Path)
    assert locks.name == "locks"


def test_worker_pid_path_structure(tmp_data_dir):
    """Test that worker_pid_path returns correct path."""
    pid_path = paths.worker_pid_path()
    assert isinstance(pid_path, Path)
    assert pid_path.name == "worker.pid"
    assert "locks" in str(pid_path)


def test_worker_heartbeat_path_structure(tmp_data_dir):
    """Test that worker_heartbeat_path returns correct path."""
    hb_path = paths.worker_heartbeat_path()
    assert isinstance(hb_path, Path)
    assert hb_path.name == "worker.heartbeat"
    assert "locks" in str(hb_path)


def test_dirty_queue_path_structure(tmp_data_dir):
    """Test that dirty_queue_path returns correct path."""
    queue_path = paths.dirty_queue_path()
    assert isinstance(queue_path, Path)
    assert queue_path.name == "dirty.txt"
    assert "queue" in str(queue_path)


def test_config_path_structure(tmp_data_dir):
    """Test that config_path returns correct path."""
    config = paths.config_path()
    assert isinstance(config, Path)
    assert config.name == "config.toml"


def test_gdrive_creds_path_structure(tmp_data_dir):
    """Test that gdrive_creds_path returns correct path."""
    creds = paths.gdrive_creds_path()
    assert isinstance(creds, Path)
    assert creds.name == "gdrive_creds.json"


def test_gdrive_cache_dir_structure(tmp_data_dir):
    """Test that gdrive_cache_dir returns correct path."""
    gdrive_cache = paths.gdrive_cache_dir()
    assert isinstance(gdrive_cache, Path)
    assert gdrive_cache.name == "gdrive_cache"


def test_web_cache_dir_structure(tmp_data_dir):
    """Test that web_cache_dir returns correct path."""
    web_cache = paths.web_cache_dir()
    assert isinstance(web_cache, Path)
    assert web_cache.name == "web_cache"


def test_roll_log_if_oversized_under_cap_is_noop(tmp_path):
    """A log under the size cap is left untouched — no .prev.log produced."""
    log = tmp_path / "2026-05-14.log"
    log.write_bytes(b"x" * 100)

    paths.roll_log_if_oversized(log, max_bytes=1000)

    assert log.exists()
    assert log.read_bytes() == b"x" * 100
    assert not (tmp_path / "2026-05-14.prev.log").exists()


def test_roll_log_if_oversized_over_cap_rolls_to_prev(tmp_path):
    """A log over the cap is rolled to a .prev.log sibling, content intact.

    Regression guard: without the size cap a single day's log (or the
    worker-stderr crash sink) grows without an upper bound on its footprint.
    """
    log = tmp_path / "2026-05-14.log"
    payload = b"y" * 2000
    log.write_bytes(payload)

    paths.roll_log_if_oversized(log, max_bytes=1000)

    prev = tmp_path / "2026-05-14.prev.log"
    assert prev.exists(), "oversized log must roll over to .prev.log"
    assert prev.read_bytes() == payload, "rolled-over content must be preserved intact"
    assert not log.exists(), "the live log path is freed for the caller to recreate"
    # .prev.log ends in .log so the worker's 7-day retention sweep still reaps it.
    assert prev.suffix == ".log"


def test_roll_log_if_oversized_missing_file_is_silent(tmp_path):
    """A missing log path is a no-op, not an error (first run before any log)."""
    paths.roll_log_if_oversized(tmp_path / "nonexistent.log", max_bytes=1000)


def test_roll_log_if_oversized_exactly_at_cap_is_noop(tmp_path):
    """A log whose size equals max_bytes exactly is NOT rolled (boundary: <=, not <)."""
    log = tmp_path / "boundary.log"
    log.write_bytes(b"z" * 1000)

    paths.roll_log_if_oversized(log, max_bytes=1000)

    assert log.exists(), "file exactly at cap must be left in place"
    assert not (tmp_path / "boundary.prev.log").exists()


# ---------------------------------------------------------------------------
# Path-traversal guard on project_db_path / session_cache_path
# ---------------------------------------------------------------------------


class TestProjectDbPathTraversal:
    """Regression tests for the resolver-level traversal guard added to paths.py.

    project_db_path() resolves the candidate path and raises ValueError when
    the resolved path escapes the projects/ subdirectory.  This is distinct
    from the db._validate_project_hash() check: the guard in paths.py is the
    last line of defence regardless of whether the caller bypassed validation.
    """

    def test_normal_hash_returns_path_inside_projects(self, tmp_data_dir):
        """A well-formed hash produces a path strictly inside projects/."""
        h = "abc123def456"
        p = paths.project_db_path(h)
        projects_dir = (tmp_data_dir / "projects").resolve()
        assert p.is_relative_to(projects_dir), (
            f"Expected path inside {projects_dir}, got {p}"
        )
        assert p.name == f"{h}.db"

    def test_traversal_hash_raises_value_error(self, tmp_data_dir):
        """A traversal sequence like '../../../evil' raises ValueError."""
        with pytest.raises(ValueError, match="outside the projects directory"):
            paths.project_db_path("../../../evil")

    def test_traversal_with_null_byte_raises(self, tmp_data_dir):
        """A hash containing a null byte raises ValueError (escapes base dir)."""
        with pytest.raises((ValueError, Exception)):
            paths.project_db_path("\x00evil")

    def test_absolute_path_as_hash_raises(self, tmp_data_dir):
        """A hash that looks like an absolute path raises ValueError."""
        # On Windows Path("C:/windows/system32") in projects/ resolves outside.
        # On any platform "/etc/passwd" resolves outside.
        with pytest.raises(ValueError, match="outside the projects directory"):
            paths.project_db_path("/etc/passwd")


class TestSessionCachePathTraversal:
    """Regression tests for the resolver-level traversal guard on session_cache_path."""

    def test_normal_session_id_returns_path_inside_sessions(self, tmp_data_dir):
        """A well-formed session ID produces a path strictly inside sessions/."""
        sid = "my-valid-session-001"
        p = paths.session_cache_path(sid)
        sessions_dir = (tmp_data_dir / "sessions").resolve()
        assert p.is_relative_to(sessions_dir), (
            f"Expected path inside {sessions_dir}, got {p}"
        )
        assert p.name == f"{sid}.json"

    def test_traversal_session_id_raises_value_error(self, tmp_data_dir):
        """A traversal sequence raises ValueError."""
        with pytest.raises(ValueError, match="outside the sessions directory"):
            paths.session_cache_path("../../../etc/shadow")

    def test_windows_absolute_path_as_session_id_raises(self, tmp_data_dir):
        """A session ID that resolves to an absolute path outside sessions/ raises."""
        # Choosing a multi-level traversal that definitely escapes the directory.
        with pytest.raises(ValueError, match="outside the sessions directory"):
            paths.session_cache_path("../../leaked")
