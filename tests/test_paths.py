"""Test paths module."""
import shlex
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


def test_python_runner_command_cmd_with_inner_double_quotes():
    """--cmd args containing double quotes must round-trip intact.

    Regression for the schtasks /Run bug: naive '"..."' wrapping of
    'powershell.exe -Command "schtasks /Run ..."' closes the outer quote at
    the first inner '"', so the shell sees '--cmd powershell.exe -Command'
    and bare 'schtasks' tokens — causing Windows to run 'schtasks' with no
    subcommand, which dumps all scheduled tasks instead of running one.
    """
    cmd_arg = 'powershell.exe -Command "schtasks /Run /TN \'LiteLLM GLM Proxy\' 2>&1"'
    cmd = paths.python_runner_command("compress", "--cmd", cmd_arg)
    # Parse the generated string exactly as Git Bash does.
    parsed = shlex.split(cmd, posix=True)
    assert "--cmd" in parsed
    cmd_idx = parsed.index("--cmd")
    assert parsed[cmd_idx + 1] == cmd_arg, (
        f"--cmd value was truncated or corrupted.\n"
        f"  Expected: {cmd_arg!r}\n"
        f"  Got:      {parsed[cmd_idx + 1]!r}\n"
        f"  Full cmd: {cmd!r}"
    )


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


def test_roll_log_5mb_under_load_keeps_only_log_and_prev(tmp_path):
    """Simulate a 5 MB burst against the 1 MB cap and verify the directory
    settles to exactly two files: the active ``.log`` and one ``.prev.log``.

    Models the production scenario CLAUDE.md calls out for ``hooks-stderr.log``:
    a misbehaving plugin or hook event storm pushing the crash sink well past
    the 1 MB threshold across many writes.  After the dust settles only the
    most recent 1 MB is in ``.log`` and the previous 1 MB is in ``.prev.log``
    — no additional rotation artefacts (e.g. ``.prev.prev.log``) accumulate.
    """
    log = tmp_path / "hooks-stderr.log"
    cap = paths.HOOKS_STDERR_LOG_MAX_BYTES  # 1 MB
    # Five writes of (cap + 1) bytes each ~= 5 MB total, mirroring a runaway
    # hook session that keeps appending crashes faster than the rollover can
    # catch them.  Each write triggers a roll check before appending.
    for cycle in range(5):
        # Pre-existing file (if any) plus this cycle's append both contribute
        # to oversize detection; mimic the real hook flow: roll then write.
        paths.roll_log_if_oversized(log, max_bytes=cap)
        # Distinguishable marker per cycle so we can confirm the *latest*
        # bytes win the .log slot and the *prior* cycle wins .prev.log.
        marker = bytes([0x30 + cycle]) * (cap + 1)
        with log.open("ab") as fh:
            fh.write(marker)

    # Final settle: one more roll-then-write cycle, mirroring the production
    # contract where every hook-stderr write goes ``roll → append``.  Without
    # the trailing write the .log slot would be empty (the last rename moved
    # its content to .prev.log and nothing recreated it) — but that state
    # never persists in practice because the *next* hook crash always writes
    # again immediately.
    paths.roll_log_if_oversized(log, max_bytes=cap)
    with log.open("ab") as fh:
        fh.write(b"final\n")

    # Directory state: exactly the two files token-goat expects to exist.
    survivors = sorted(p.name for p in tmp_path.iterdir())
    assert survivors == ["hooks-stderr.log", "hooks-stderr.prev.log"], (
        f"5 MB burst left unexpected files behind: {survivors}"
    )
    # Each surviving file is ≤ cap + 1 byte (the single-write quantum); the
    # contract guarantees bounded footprint, not exact 1 MB sizing.
    for survivor in tmp_path.iterdir():
        size = survivor.stat().st_size
        assert size <= cap + 1, (
            f"{survivor.name} is {size} bytes — rotation did not bound footprint"
        )


def test_roll_log_if_oversized_concurrent_writers_are_safe(tmp_path):
    """Race two threads through ``roll_log_if_oversized`` simultaneously.

    Both threads see the same oversized file and both call ``os.replace`` —
    on POSIX one rename wins atomically and the other returns successfully
    (clobbering the first .prev), while on Windows the loser may hit
    ``OSError`` which the function deliberately suppresses.  Either way the
    directory must settle to a consistent state: at most one ``.log`` and at
    most one ``.prev.log``, neither thread raises, no zero-byte or partial
    files left behind.
    """
    import threading

    log = tmp_path / "race.log"
    log.write_bytes(b"R" * 5000)

    errors: list[BaseException] = []
    barrier = threading.Barrier(4)

    def race() -> None:
        try:
            barrier.wait(timeout=5.0)
            # Four concurrent calls simulate the realistic case of multiple
            # hook subprocesses crashing in the same instant — each picks up
            # the same oversized log and tries to roll it.
            paths.roll_log_if_oversized(log, max_bytes=1000)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=race) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10.0)

    assert not errors, f"concurrent rotation raised: {errors!r}"

    # Directory invariant: no third file appeared, no temp turds left over.
    survivors = sorted(p.name for p in tmp_path.iterdir())
    assert set(survivors).issubset({"race.log", "race.prev.log"}), (
        f"unexpected files after concurrent rotation: {survivors}"
    )
    # .prev.log must exist (one writer's rename won the race).
    assert (tmp_path / "race.prev.log").exists(), (
        "no .prev.log produced — concurrent rotation lost the rename entirely"
    )
    # And the rolled-over content is intact (5000 R bytes), not a partial.
    prev_bytes = (tmp_path / "race.prev.log").read_bytes()
    assert prev_bytes == b"R" * 5000, (
        f"rolled content corrupted under concurrent writers: "
        f"len={len(prev_bytes)} head={prev_bytes[:10]!r}"
    )


# ---------------------------------------------------------------------------
# Worker heartbeat-staleness helpers — single source of truth for the
# threshold consumed by hooks_edit._nudge_worker_if_down and cli_doctor.
# ---------------------------------------------------------------------------


class TestHeartbeatStalenessHelpers:
    """Regression guard: the nudge threshold derives from the watchdog's
    formula, so a tune of ``HEARTBEAT_INTERVAL`` can never leave the
    post-edit nudge stuck on an old magic-number threshold.
    """

    def test_threshold_derives_from_interval_and_grace(self):
        from token_goat import worker

        # The watchdog formula is 2 * interval + grace.  Asserting on the
        # arithmetic rather than the literal pins the contract: if either
        # constant moves, the threshold tracks it automatically.
        expected = 2 * worker.HEARTBEAT_INTERVAL + worker.HEARTBEAT_GRACE_SECONDS
        assert worker.heartbeat_stale_threshold() == expected

    def test_threshold_tracks_a_runtime_tune_of_the_interval(self, monkeypatch):
        """If HEARTBEAT_INTERVAL is tuned at runtime, the threshold follows.

        This is the bug the helper was extracted to prevent: the pre-fix
        nudge hard-coded ``65.0`` so any tune of the interval would have
        silently produced the wrong threshold.
        """
        from token_goat import worker

        monkeypatch.setattr(worker, "HEARTBEAT_INTERVAL", 10.0)
        monkeypatch.setattr(worker, "HEARTBEAT_GRACE_SECONDS", 2.0)
        assert worker.heartbeat_stale_threshold() == 22.0

    def test_is_stale_for_nudge_treats_missing_heartbeat_as_stale(self, tmp_path):
        """A missing heartbeat is the same signal as a stale one — call
        ``ensure_running``."""
        from token_goat import worker

        missing = tmp_path / "nope.heartbeat"
        assert worker.is_heartbeat_stale_for_nudge(missing) is True

    def test_is_stale_for_nudge_fresh_file_returns_false(self, tmp_path):
        from token_goat import worker

        hb = tmp_path / "hb"
        hb.write_text("now", encoding="utf-8")
        # Freshly written: well within the threshold.
        assert worker.is_heartbeat_stale_for_nudge(hb) is False

    def test_is_stale_for_nudge_old_file_returns_true(self, tmp_path):
        """Backdate the heartbeat past the threshold and confirm staleness."""
        import os
        import time

        from token_goat import worker

        hb = tmp_path / "hb"
        hb.write_text("old", encoding="utf-8")
        # Backdate to (threshold + 60) seconds ago — comfortably stale even
        # on slow filesystems where mtime resolution is coarse.
        old = time.time() - (worker.heartbeat_stale_threshold() + 60)
        os.utime(hb, (old, old))

        assert worker.is_heartbeat_stale_for_nudge(hb) is True


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
        with pytest.raises(ValueError, match="outside projects"):
            paths.project_db_path("../../../evil")

    def test_traversal_with_null_byte_raises(self, tmp_data_dir):
        """A hash containing a null byte raises ValueError (escapes base dir)."""
        with pytest.raises((ValueError, Exception)):
            paths.project_db_path("\x00evil")

    def test_absolute_path_as_hash_raises(self, tmp_data_dir):
        """A hash that looks like an absolute path raises ValueError."""
        # On Windows Path("C:/windows/system32") in projects/ resolves outside.
        # On any platform "/etc/passwd" resolves outside.
        with pytest.raises(ValueError, match="outside projects"):
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
        with pytest.raises(ValueError, match="outside sessions"):
            paths.session_cache_path("../../../etc/shadow")

    def test_windows_absolute_path_as_session_id_raises(self, tmp_data_dir):
        """A session ID that resolves to an absolute path outside sessions/ raises."""
        # Choosing a multi-level traversal that definitely escapes the directory.
        with pytest.raises(ValueError, match="outside sessions"):
            paths.session_cache_path("../../leaked")


class TestAtomicWriteCore:
    """_atomic_write_core finally-block: tmp file is only unlinked when rename failed."""

    def test_successful_write_removes_no_file(self, tmp_path):
        """After a successful rename the tmp file no longer exists (consumed by rename).

        Verifying that the finally block does NOT call unlink on a path that
        doesn't exist (missing_ok=True swallows FileNotFoundError anyway, but
        this confirms we aren't touching stale paths unnecessarily).
        """
        target = tmp_path / "out.txt"
        paths.atomic_write_text(target, "hello")
        assert target.read_text(encoding="utf-8") == "hello"
        # No .tmp file should linger.
        leftover = list(tmp_path.glob("*.tmp"))
        assert leftover == [], f"unexpected tmp files: {leftover}"

    def test_failed_rename_cleans_up_tmp(self, tmp_path, monkeypatch):
        """When _rename_with_retry raises, the tmp file must be unlinked."""
        def failing_rename(src: Path, dest: Path) -> None:
            raise PermissionError("rename blocked")

        monkeypatch.setattr(paths, "_rename_with_retry", failing_rename)

        target = tmp_path / "out.txt"
        with pytest.raises(PermissionError):
            paths.atomic_write_text(target, "data")

        # The target was never created.
        assert not target.exists()
        # No tmp files should remain (finally-block cleaned up).
        leftover = list(tmp_path.glob("*.tmp"))
        assert leftover == [], f"tmp file not cleaned up: {leftover}"

    def test_successful_rename_no_unlink_called(self, tmp_path, monkeypatch):
        """After a successful rename, unlink must NOT be called on any path.

        Guards against the fragile-finally pattern where unlink fires even when
        the rename already consumed the source name.
        """
        unlink_calls: list[Path] = []
        original_unlink = Path.unlink

        def tracking_unlink(self: Path, missing_ok: bool = False) -> None:  # type: ignore[override]
            unlink_calls.append(self)
            original_unlink(self, missing_ok=missing_ok)

        monkeypatch.setattr(Path, "unlink", tracking_unlink)

        target = tmp_path / "out.txt"
        paths.atomic_write_text(target, "content")

        # The rename succeeded; no unlink should have been called.
        assert unlink_calls == [], f"unexpected unlink calls: {unlink_calls}"

    def test_lone_surrogate_does_not_abort_write(self, tmp_path):
        """A lone UTF-16 surrogate must not crash the atomic text write.

        Regression: on Windows a Bash pipe carrying an emoji can be mis-decoded
        as cp1252, leaving a lone surrogate like "\\udc8f" in session state.
        ``str.encode("utf-8")`` rejects it ("surrogates not allowed"), which
        previously aborted the rename and silently dropped the session-cache
        turn. The hardened writer must replace the surrogate and persist the
        file instead.
        """
        # Sanity: confirm the input genuinely cannot be UTF-8 encoded strictly,
        # so the test exercises the real failure mode rather than a benign char.
        with pytest.raises(UnicodeEncodeError):
            "before\udc8fafter".encode()

        target = tmp_path / "session.json"
        content = "before\udc8fafter"

        # Must not raise — the write should succeed despite the stray surrogate.
        paths.atomic_write_text(target, content)

        assert target.exists()
        # Round-trips as valid UTF-8 and the raw surrogate is gone.
        written = target.read_text(encoding="utf-8")
        assert "\udc8f" not in written
        # str.encode("utf-8", "replace") emits "?" (0x3F) for an un-encodable
        # surrogate, matching token_goat.util.sanitize_surrogates elsewhere.
        assert written == "before?after"
        # No tmp file lingers after the successful write.
        assert list(tmp_path.glob("*.tmp")) == []

    def test_surrogate_free_text_is_byte_identical(self, tmp_path):
        """Normal UTF-8 (including astral emoji) must survive byte-for-byte.

        Guards against the surrogate-replacement path corrupting well-formed
        multi-byte characters — only lone surrogates should ever change.
        """
        target = tmp_path / "ok.txt"
        content = "tools 🛠️ banner — café"
        paths.atomic_write_text(target, content)
        assert target.read_text(encoding="utf-8") == content


# ---------------------------------------------------------------------------
# Item 8: _safe_child_path traversal-guard helper
# ---------------------------------------------------------------------------

class TestSafeChildPath:
    """Tests for paths._safe_child_path (Item 8 DRY consolidation)."""

    def test_happy_path_returns_correct_path(self, tmp_path: Path) -> None:
        """A valid child name returns base / (name + extension)."""
        base = tmp_path / "subdir"
        base.mkdir()
        result = paths._safe_child_path(base, "abc123", ".db", "project_hash")
        assert result == (base / "abc123.db").resolve()

    def test_null_byte_raises_value_error(self, tmp_path: Path) -> None:
        """A null byte in child_name raises ValueError with the label."""
        base = tmp_path / "subdir"
        base.mkdir()
        with pytest.raises(ValueError, match="project_hash"):
            paths._safe_child_path(base, "abc\x00def", ".db", "project_hash")

    def test_traversal_raises_value_error(self, tmp_path: Path) -> None:
        """A path-traversal sequence raises ValueError."""
        base = tmp_path / "subdir"
        base.mkdir()
        with pytest.raises(ValueError, match="path outside"):
            paths._safe_child_path(base, "../evil", ".db", "project_hash")

    def test_empty_extension_works(self, tmp_path: Path) -> None:
        """An empty extension string produces name-only file."""
        base = tmp_path / "subdir"
        base.mkdir()
        result = paths._safe_child_path(base, "manifest_sha_mysession", "", "session_id")
        assert result.name == "manifest_sha_mysession"

    def test_safe_child_path_rejects_empty_string(self, tmp_path: Path) -> None:
        """An empty child_name raises ValueError."""
        base = tmp_path / "subdir"
        base.mkdir()
        with pytest.raises(ValueError, match="must not be empty"):
            paths._safe_child_path(base, "", ".db", "test_label")


class TestProjectDbPath:
    """project_db_path now delegates to _safe_child_path."""

    def test_valid_hash(self, tmp_data_dir: Path) -> None:
        p = paths.project_db_path("deadbeef1234")
        assert p.name == "deadbeef1234.db"
        assert "projects" in str(p)

    def test_null_byte_rejected(self, tmp_data_dir: Path) -> None:
        with pytest.raises(ValueError, match="null byte"):
            paths.project_db_path("abc\x00def")

    def test_traversal_rejected(self, tmp_data_dir: Path) -> None:
        with pytest.raises(ValueError):
            paths.project_db_path("../../evil")


class TestSessionCachePath:
    """session_cache_path now delegates to _safe_child_path."""

    def test_valid_session_id(self, tmp_data_dir: Path) -> None:
        p = paths.session_cache_path("valid-session-id")
        assert p.name == "valid-session-id.json"

    def test_null_byte_rejected(self, tmp_data_dir: Path) -> None:
        with pytest.raises(ValueError, match="null byte"):
            paths.session_cache_path("abc\x00def")


class TestNormalizeKey:
    """paths.normalize_key — canonical path-key normalizer.

    Contract (must match session._normalize_path exactly):
    - Backslashes → forward slashes
    - Uppercase drive letter (``C:`` style) → lowercase (``c:``) on ALL platforms
    - WSL processes emit Windows-format paths on Linux; unconditional lowercasing
      ensures both forms produce the same cache key
    - Idempotent: normalize(normalize(p)) == normalize(p)
    - Empty/short strings pass through without crashing
    """

    def test_backslash_to_forward_slash(self) -> None:
        # Backslashes always become forward slashes regardless of platform.
        assert paths.normalize_key("src\\foo\\bar.py") == "src/foo/bar.py"

    def test_mixed_separators(self) -> None:
        # Mixed separators collapse to all forward slashes.
        assert paths.normalize_key("src\\foo/bar\\baz.py") == "src/foo/bar/baz.py"

    def test_windows_drive_lowercased(self) -> None:
        assert paths.normalize_key("C:\\Projects\\foo.py") == "c:/Projects/foo.py"

    def test_windows_drive_already_lowercase(self) -> None:
        # No change to already-lowercased drive letters.
        assert paths.normalize_key("c:\\Projects\\foo.py") == "c:/Projects/foo.py"

    def test_windows_drive_lowercased_on_all_platforms(self) -> None:
        # Drive-letter lowercasing is unconditional — WSL processes emit
        # C:/... on Linux and must produce the same cache key as /mnt/c/...
        assert paths.normalize_key("C:\\foo") == "c:/foo"

    def test_already_normalized_idempotent(self) -> None:
        # Forward-slash absolute POSIX path — no change expected.
        p = "/usr/local/bin/foo"
        assert paths.normalize_key(p) == p
        # Idempotency: applying twice yields the same result.
        assert paths.normalize_key(paths.normalize_key(p)) == p

    def test_already_normalized_windows_lower_drive(self) -> None:
        # Lowercase drive + forward slashes is the canonical form: idempotent.
        p = "c:/projects/foo.py"
        assert paths.normalize_key(p) == p
        assert paths.normalize_key(paths.normalize_key(p)) == p

    def test_trailing_separator_preserved(self) -> None:
        # No rstrip — trailing slashes are preserved (after backslash conversion).
        assert paths.normalize_key("src\\foo\\") == "src/foo/"
        assert paths.normalize_key("src/foo/") == "src/foo/"

    def test_empty_string(self) -> None:
        assert paths.normalize_key("") == ""

    def test_single_character(self) -> None:
        # Too short for a drive prefix; no transformation.
        assert paths.normalize_key("a") == "a"
        assert paths.normalize_key("/") == "/"
        # A lone backslash still flips to forward slash.
        assert paths.normalize_key("\\") == "/"

    def test_dot_path(self) -> None:
        # Relative dot paths pass through unchanged on POSIX-form inputs;
        # backslash dot paths flip separators.
        assert paths.normalize_key(".") == "."
        assert paths.normalize_key("./foo") == "./foo"
        assert paths.normalize_key(".\\foo") == "./foo"

    def test_relative_windows_path_no_drive(self) -> None:
        # No drive letter — nothing to lowercase, only separator conversion.
        assert paths.normalize_key("src\\foo.py") == "src/foo.py"

    def test_session_alias_delegates(self) -> None:
        # session._normalize_path must continue to return identical output;
        # it is kept as a thin alias for backward compatibility.
        from token_goat import session
        sample_paths = [
            "src\\foo.py",
            "src/bar.py",
            "C:\\Projects\\x.py",
            "c:/projects/x.py",
            "",
            ".",
            "./foo",
            "/usr/local/bin",
        ]
        for p in sample_paths:
            assert session._normalize_path(p) == paths.normalize_key(p)


class TestNormalizeKeyCrossPlatformAudit:
    """Cross-platform audit coverage for ``paths.normalize_key``.

    These tests pin down behavior on the edges that gave the canonical-form
    contract its ambiguity: UNC paths, the Windows long-path ``\\\\?\\``
    prefix, the fast-path branch (no backslash) for forward-slash drive
    inputs, and the by-design string-only limitations (symlinks, WSL bind
    mounts, NTFS case folding).

    The string-only limitations are pinned as *negative* assertions: the
    function does NOT collapse these aliases. If a future change adds
    filesystem resolution, these tests must be updated *deliberately* (not
    silently) — that is the point of asserting current behavior.
    """

    # ---- (b) UNC paths ---------------------------------------------------

    def test_unc_backslash_normalizes_to_double_slash(self) -> None:
        # Pure-backslash UNC share root: leading \\ -> //, separators flipped.
        assert paths.normalize_key("\\\\server\\share\\file.py") == "//server/share/file.py"

    def test_unc_mixed_separators(self) -> None:
        # Mixed UNC form: \\server/share\file -> //server/share/file.
        assert paths.normalize_key("\\\\server/share\\file.py") == "//server/share/file.py"

    def test_unc_already_forward_slash(self) -> None:
        # Already-canonical UNC: idempotent, no double-collapse to single /.
        p = "//server/share/file.py"
        assert paths.normalize_key(p) == p
        assert paths.normalize_key(paths.normalize_key(p)) == p

    def test_unc_long_path_prefix(self) -> None:
        # Windows long-path prefix \\?\C:\... must survive the conversion
        # without collapsing the leading //? or losing the embedded drive.
        assert paths.normalize_key("\\\\?\\C:\\foo\\bar.py") == "//?/C:/foo/bar.py"

    def test_unc_lone_double_backslash(self) -> None:
        # Just \\: the bare UNC root marker -> //.
        assert paths.normalize_key("\\\\") == "//"

    # ---- (e) Drive-letter case on the fast path --------------------------

    def test_fast_path_forward_slash_drive_lowercased(self) -> None:
        # Fast path (no backslashes) must still lowercase an uppercase drive.
        assert paths.normalize_key("C:/Projects/foo.py") == "c:/Projects/foo.py"

    def test_fast_path_drive_only(self) -> None:
        # Drive-only string ``C:`` -> ``c:``.
        assert paths.normalize_key("C:") == "c:"

    def test_drive_root_backslash(self) -> None:
        # ``C:\`` -> ``c:/`` (drive + root separator).
        assert paths.normalize_key("C:\\") == "c:/"

    # ---- (a) Symlinks / WSL bind mount — known string-only limitation ----

    def test_wsl_bind_mount_same_as_windows_form(self) -> None:
        # /mnt/c/Projects/X (WSL bind-mount form) and C:\Projects\X
        # (Windows form) resolve to the same physical file under WSL.
        # normalize_key now converts WSL /mnt/<drive>/... → <drive>:/...
        # so both forms produce the same canonical key.
        wsl = "/mnt/c/Projects/X"
        win = "C:\\Projects\\X"
        assert paths.normalize_key(wsl) == paths.normalize_key(win)
        assert paths.normalize_key(wsl) == "c:/Projects/X"

    # ---- (c) NTFS case folding — known string-only limitation ------------

    def test_ntfs_case_variants_distinct_keys(self) -> None:
        # NTFS treats Bar.py and bar.py as the same file but normalize_key
        # preserves component case. Same rationale as the WSL case: a
        # case-folding pass would clobber genuine case-sensitive paths on
        # POSIX. Callers that need filesystem identity must resolve first.
        a = "C:/foo/Bar.py"
        b = "C:/foo/bar.py"
        # Distinct inputs -> distinct keys. Update deliberately if
        # filesystem-aware folding is ever introduced.
        assert paths.normalize_key(a) != paths.normalize_key(b)

    # ---- Hardening: surrogate and control bytes don't crash --------------

    def test_does_not_crash_on_surrogate(self) -> None:
        # Lone surrogate (U+D800) survives the function — no UnicodeError.
        # The function never encodes; it only does .replace and slicing.
        s = "C:\\foo\\\ud800.py"
        result = paths.normalize_key(s)
        assert "\ud800" in result
        assert result.startswith("c:/")


class TestEnsureDirRaceTolerance:
    """Regression coverage for the Windows mkdir race captured in
    feedback_windows_pathlib_mkdir_race.md. ``paths.ensure_dir`` must not
    raise when two writers create the same target concurrently, even when
    the underlying ``Path.mkdir(parents=True, exist_ok=True)`` spuriously
    raises ``FileExistsError`` (the precise Windows failure mode)."""

    def test_concurrent_threads_creating_same_dir(self, tmp_path):
        """Two threads calling ensure_dir on the same target must both succeed."""
        import threading

        target = tmp_path / "deep" / "nested" / "race-target"
        barrier = threading.Barrier(8)
        errors: list[BaseException] = []
        results: list[Path] = []
        lock = threading.Lock()

        def worker() -> None:
            try:
                barrier.wait(timeout=2.0)
                out = paths.ensure_dir(target)
                with lock:
                    results.append(out)
            except BaseException as exc:  # noqa: BLE001
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5.0)

        assert not errors, f"ensure_dir raised under concurrent writers: {errors!r}"
        assert len(results) == 8
        assert target.is_dir()
        for r in results:
            assert r == target

    def test_returns_path_when_target_already_exists(self, tmp_path):
        """ensure_dir is idempotent: pre-existing directory returns unchanged."""
        target = tmp_path / "already-there"
        target.mkdir()
        out = paths.ensure_dir(target)
        assert out == target
        assert target.is_dir()

    def test_handles_spurious_fileexistserror(self, tmp_path, monkeypatch):
        """Simulate the Windows race where Path.mkdir wrongly raises FileExistsError
        on a directory that genuinely exists (stat-attribute lag). ensure_dir
        must recover via the path.exists() fallback rather than propagating."""
        from pathlib import Path as RealPath

        target = tmp_path / "spurious-race"
        target.mkdir()  # directory actually exists

        original_mkdir = RealPath.mkdir
        calls = {"n": 0}

        def fake_mkdir(self, *args, **kwargs):  # noqa: ANN001
            # Only intercept the race-target; let unrelated mkdir calls pass.
            if self == target:
                calls["n"] += 1
                raise FileExistsError(17, "File exists", str(self))
            return original_mkdir(self, *args, **kwargs)

        monkeypatch.setattr(RealPath, "mkdir", fake_mkdir)

        # Must not raise — the retry + exists() fallback handles the race.
        out = paths.ensure_dir(target)
        assert out == target
        assert calls["n"] >= 1, "fake_mkdir was not exercised"

    def test_raises_when_path_genuinely_cannot_be_created(self, tmp_path):
        """When the path cannot exist (file in the way of a dir), raise."""
        blocker = tmp_path / "blocker"
        blocker.write_text("i am a file, not a directory")

        # Creating a directory at a path occupied by a file must still surface.
        with pytest.raises((FileExistsError, NotADirectoryError, OSError)):
            paths.ensure_dir(blocker / "child")


class TestPathHelperConsistency:
    """Verify that named path helpers return the same value as inline data_dir() / name patterns.

    These tests guard against callers that inline the path construction instead
    of using the dedicated helper — the helpers must stay in sync with what
    callers expect.
    """

    def test_sessions_dir_matches_inline(self, tmp_data_dir) -> None:
        """sessions_dir() must equal data_dir() / 'sessions'."""
        assert paths.sessions_dir() == paths.data_dir() / "sessions"

    def test_sentinels_dir_matches_inline(self, tmp_data_dir) -> None:
        """sentinels_dir() must equal data_dir() / 'sentinels'."""
        assert paths.sentinels_dir() == paths.data_dir() / "sentinels"

    def test_image_cache_dir_matches_inline(self, tmp_data_dir) -> None:
        """image_cache_dir() must equal data_dir() / 'images'."""
        assert paths.image_cache_dir() == paths.data_dir() / "images"

    def test_locks_dir_matches_inline(self, tmp_data_dir) -> None:
        """locks_dir() must equal data_dir() / 'locks'."""
        assert paths.locks_dir() == paths.data_dir() / "locks"


class TestNormalizePathKey:
    """Tests for paths.normalize_path_key error handling."""

    def test_normalize_path_key_logs_resolve_error(self, caplog, monkeypatch):
        """When Path.resolve() raises OSError, debug message is logged."""
        import logging
        from pathlib import Path as _P
        caplog.set_level(logging.DEBUG, logger="token_goat.paths")
        def failing_resolve(self):  # monkeypatches Path.resolve
            raise OSError("mock error")
        monkeypatch.setattr(_P, "resolve", failing_resolve)
        result = paths.normalize_path_key("some/path", cwd="/some/cwd")
        # Should fall back to normalize_key
        assert isinstance(result, str)
        # Check that debug message was logged
        assert any("normalize_path_key" in r.message and "mock error" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# is_wsl() detection
# ---------------------------------------------------------------------------


def test_is_wsl_returns_false_when_no_wsl_env(monkeypatch):
    """is_wsl() returns False when neither WSL_DISTRO_NAME nor WSL_INTEROP is set."""
    monkeypatch.delenv('WSL_DISTRO_NAME', raising=False)
    monkeypatch.delenv('WSL_INTEROP', raising=False)
    assert paths.is_wsl() is False


def test_is_wsl_returns_true_when_wsl_distro_name_set(monkeypatch):
    """is_wsl() returns True when WSL_DISTRO_NAME is set (WSL 1/2)."""
    monkeypatch.setenv('WSL_DISTRO_NAME', 'Ubuntu')
    monkeypatch.delenv('WSL_INTEROP', raising=False)
    assert paths.is_wsl() is True


def test_is_wsl_returns_true_when_wsl_interop_set(monkeypatch):
    """is_wsl() returns True when WSL_INTEROP is set (WSL 2 interop socket)."""
    monkeypatch.delenv('WSL_DISTRO_NAME', raising=False)
    monkeypatch.setenv('WSL_INTEROP', '/run/WSL/1_interop')
    assert paths.is_wsl() is True


def test_is_wsl_returns_true_when_both_set(monkeypatch):
    """is_wsl() returns True when both WSL env vars are present."""
    monkeypatch.setenv('WSL_DISTRO_NAME', 'Debian')
    monkeypatch.setenv('WSL_INTEROP', '/run/WSL/2_interop')
    assert paths.is_wsl() is True


def test_is_wsl_ignores_empty_string(monkeypatch):
    """is_wsl() treats empty-string env var values as falsy (not WSL)."""
    monkeypatch.setenv('WSL_DISTRO_NAME', '')
    monkeypatch.delenv('WSL_INTEROP', raising=False)
    assert paths.is_wsl() is False
