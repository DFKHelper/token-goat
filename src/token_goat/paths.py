"""Central path resolver for token-goat data directories."""
from __future__ import annotations

__all__ = [
    "LOG_FILE_MAX_BYTES",
    "atomic_write_bytes",
    "atomic_write_text",
    "claude_config_dir",
    "claude_plugins_dir",
    "claude_skills_dir",
    "config_path",
    "data_dir",
    "dirty_queue_path",
    "ensure_dir",
    "ensure_dirs",
    "gdrive_cache_dir",
    "gdrive_creds_path",
    "global_db_path",
    "image_cache_dir",
    "is_safe_rel_path",
    "locks_dir",
    "logs_dir",
    "models_dir",
    "project_db_path",
    "python_runner_argv",
    "python_runner_command",
    "open_log_file",
    "roll_log_if_oversized",
    "session_cache_path",
    "web_cache_dir",
    "worker_heartbeat_path",
    "worker_pid_path",
]

import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Literal

_LOG = logging.getLogger("token_goat.paths")

# Size cap for a structured daily log file. The daily logs are date-named and
# age out via the worker's 7-day retention sweep, so they are already bounded
# in count — but a single pathological day (e.g. a worker stuck in a fast error
# loop) could still bloat one file. Rolling it over to a .prev.log sibling caps
# any one day's footprint.
LOG_FILE_MAX_BYTES = 5_000_000


def python_runner_argv(*subcommand: str) -> list[str]:
    """Argv to invoke token-goat via pythonw + module, NOT the launcher .exe.

    AV/EDR products (Bitdefender ATD, Defender ASR, Norton SONAR, ...) flag
    PyInstaller-style launcher .exe files in user-writable directories as
    payload-drop signatures, especially when the parent process is node.exe
    or cmd.exe. pythonw.exe is Python-Software-Foundation-signed, lives in a
    well-known tool venv path, and `python -m module` is the most boring
    spawn pattern on Windows. AV products treat it as benign.
    """
    py = Path(sys.executable)
    pythonw = py.parent / "pythonw.exe"
    runner = pythonw if pythonw.exists() else py
    return [str(runner), "-m", "token_goat.cli", *subcommand]


def python_runner_command(*subcommand: str) -> str:
    """Same as ``python_runner_argv`` but as a single shell-style command string,
    for embedding in settings.json / config.toml hook entries.

    The interpreter path uses forward slashes. Claude Code on Windows runs
    hook commands through Git Bash, which strips backslashes as escape
    sequences (``C:\\Users\\jdoe`` becomes ``C:Usersjdoe``). Windows itself
    accepts forward slashes in paths just fine, so this works for cmd.exe,
    PowerShell, bash, and direct CreateProcess invocations.
    """
    argv = python_runner_argv(*subcommand)
    # Convert backslashes to forward slashes on the interpreter path
    # specifically (first element). Args after that are flags and module
    # names with no separators in them.
    if argv:
        argv[0] = argv[0].replace("\\", "/")
    quoted = [f'"{a}"' if " " in a else a for a in argv]
    return " ".join(quoted)


def _safe_env_dir(value: str) -> Path | None:
    """Validate an environment-variable directory value before using it as a data-dir base.

    Accepts only non-empty, absolute paths so that a crafted env var
    (e.g. ``LOCALAPPDATA=../../etc`` or ``XDG_DATA_HOME=../../tmp/evil``) cannot
    redirect the entire data directory — and with it config, DBs, and OAuth
    credentials — to an attacker-controlled location.

    Returns the resolved ``Path`` when the value passes all checks, or ``None``
    to signal that the caller should fall back to the home-based default.
    """
    stripped = value.strip()
    if not stripped:
        return None
    try:
        p = Path(stripped)
    except (ValueError, TypeError):
        return None
    # Reject relative paths: ``Path("../../tmp")`` is relative, ``Path("/tmp")`` is not.
    if not p.is_absolute():
        _LOG.warning("env dir override rejected (not absolute): %r", stripped)
        return None
    _LOG.debug("env dir accepted: %r", stripped)
    return p


def _default_data_dir() -> Path:
    """Compute the platform-appropriate data directory without platformdirs.

    Matches platformdirs.user_data_dir("token-goat", "dfk-helper") exactly:
    - Windows: %LOCALAPPDATA%\\dfk-helper\\token-goat
    - Linux/BSD: $XDG_DATA_HOME/token-goat  (falls back to ~/.local/share/token-goat)
    - macOS:  ~/Library/Application Support/token-goat

    Inlined rather than calling platformdirs because token-goat must be importable in
    contexts where only the stdlib is guaranteed (e.g. the hooks entry point runs before
    the venv is fully activated on some CI images). platformdirs is a dev/install extra,
    not a hard runtime dependency.

    Environment variables (``LOCALAPPDATA``, ``XDG_DATA_HOME``) are validated via
    ``_safe_env_dir`` before use: only absolute paths are accepted.  A relative or
    otherwise malformed value falls back to the home-based default so a crafted env var
    cannot redirect data paths to an attacker-controlled location.
    """
    if sys.platform == "win32":
        raw = os.environ.get("LOCALAPPDATA", "")
        base_path = _safe_env_dir(raw) if raw else None
        if base_path is not None:
            result = base_path / "dfk-helper" / "token-goat"
            _LOG.debug("data dir resolved via LOCALAPPDATA: %s", result)
        else:
            result = Path(os.path.expanduser("~")) / "dfk-helper" / "token-goat"
            _LOG.debug("data dir resolved via home fallback (LOCALAPPDATA absent/invalid): %s", result)
        return result
    if sys.platform == "darwin":
        result = Path.home() / "Library" / "Application Support" / "token-goat"
        _LOG.debug("data dir resolved via macOS default: %s", result)
        return result
    # Linux / BSD / WSL — honour XDG_DATA_HOME
    xdg = os.environ.get("XDG_DATA_HOME", "")
    base_dir = _safe_env_dir(xdg) if xdg else None
    if base_dir is not None:
        result = base_dir / "token-goat"
        _LOG.debug("data dir resolved via XDG_DATA_HOME: %s", result)
    else:
        result = Path.home() / ".local" / "share" / "token-goat"
        _LOG.debug("data dir resolved via XDG fallback (~/.local/share): %s", result)
    return result


# Module-level cache for the data directory.  _default_data_dir() reads
# os.environ and constructs a Path on every call; since the data directory
# never changes within a process lifetime it is safe — and measurably faster
# on the hot hook path — to compute it once and reuse the result.
# Initialised at import time so every subsequent call is a single attribute
# lookup instead of an env-var read + string manipulation + Path allocation.
_DATA_DIR_CACHE: Path = _default_data_dir()


def data_dir() -> Path:
    """Get token-goat data directory."""
    return _DATA_DIR_CACHE


def global_db_path() -> Path:
    """Path to global.db."""
    return data_dir() / "global.db"


def project_db_path(project_hash: str) -> Path:
    """Path to projects/{hash}.db.

    Raises ValueError if the resolved path escapes the projects/ subdirectory,
    which would happen with traversal sequences like ``../../../evil``.
    """
    if "\x00" in project_hash:
        raise ValueError(f"project_hash contains null byte: {project_hash!r}")
    base = data_dir() / "projects"
    candidate = (base / f"{project_hash}.db").resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError as exc:
        raise ValueError(f"project_hash produces a path outside the projects directory: {project_hash!r}") from exc
    return candidate


def is_safe_rel_path(rel_path: str) -> bool:
    """Return True when rel_path is safe to join under a project root.

    Rejects POSIX absolute paths, Windows drive/UNC paths, and any parent
    directory traversal components on either separator style.
    """
    if not rel_path:
        return False

    candidate = rel_path.strip()
    if not candidate or "\x00" in candidate:
        return False

    normalized = candidate.replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("//"):
        return False
    if len(normalized) >= 2 and normalized[1] == ":" and normalized[0].isalpha():
        return False

    return all(part != ".." for part in normalized.split("/"))


def session_cache_path(session_id: str) -> Path:
    """Path to sessions/{session_id}.json.

    Raises ValueError if the resolved path escapes the sessions/ subdirectory,
    which would happen with traversal sequences like ``../../../evil``.
    Also rejects null bytes, which some filesystems treat as path terminators
    and which Python's os module passes through on POSIX.

    On Windows, also rejects paths whose total length would reach or exceed
    MAX_PATH (260 characters).  The ``sessions/`` base directory is typically
    ~60–80 chars; combined with a 128-char session_id cap the path stays well
    under the limit, but the explicit check ensures correctness even on systems
    with unusually deep ``%LOCALAPPDATA%`` paths (e.g. long usernames, managed
    profiles, or roaming AppData redirections).
    """
    import sys

    if "\x00" in session_id:
        raise ValueError(f"session_id contains null byte: {session_id!r}")
    base = data_dir() / "sessions"
    candidate = (base / f"{session_id}.json").resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError as exc:
        raise ValueError(f"session_id produces a path outside the sessions directory: {session_id!r}") from exc
    if sys.platform == "win32" and len(str(candidate)) >= 260:
        raise ValueError(
            f"session_id produces a path that exceeds Windows MAX_PATH (260 chars): "
            f"len={len(str(candidate))}"
        )
    return candidate


def image_cache_dir() -> Path:
    """Path to images/ directory."""
    return data_dir() / "images"


def models_dir() -> Path:
    """Path to models/ directory."""
    return data_dir() / "models"


def logs_dir() -> Path:
    """Path to logs/ directory."""
    return data_dir() / "logs"


def roll_log_if_oversized(path: Path, max_bytes: int) -> None:
    """Roll a log file over to a .prev.log sibling once it exceeds max_bytes.

    Called at handler-attach time by the worker and every hook invocation, and
    by spawn_detached for the worker-stderr crash sink. Best-effort: on Windows
    os.replace fails if another process holds the file open (the daily log is
    shared by the worker and every hook), so the roll is suppressed on OSError
    and simply retried by the next process that opens the log while it is
    briefly unheld. The caller then appends to the still-large file — never
    worse than not rolling at all. The .prev.log name ends in .log so the
    worker's 7-day retention sweep reaps it too.
    """
    try:
        size = path.stat().st_size
        if size <= max_bytes:
            return
    except OSError:
        return
    dest = path.with_suffix(".prev.log")
    try:
        os.replace(path, dest)
        print(
            f"token-goat: rolled oversized log {path.name} -> {dest.name} "
            f"({size} bytes > {max_bytes} limit)",
            file=sys.stderr,
        )
    except OSError:
        pass


def locks_dir() -> Path:
    """Path to locks/ directory."""
    return data_dir() / "locks"


def worker_pid_path() -> Path:
    """Path to worker.pid."""
    return locks_dir() / "worker.pid"


def worker_heartbeat_path() -> Path:
    """Path to worker.heartbeat."""
    return locks_dir() / "worker.heartbeat"


def dirty_queue_path() -> Path:
    """Path to queue/dirty.txt."""
    return data_dir() / "queue" / "dirty.txt"


def config_path() -> Path:
    """Path to config.toml."""
    return data_dir() / "config.toml"


def gdrive_creds_path() -> Path:
    """Path to gdrive_creds.json (stored OAuth tokens)."""
    return data_dir() / "gdrive_creds.json"


def gdrive_cache_dir() -> Path:
    """Path to gdrive_cache/ directory."""
    return data_dir() / "gdrive_cache"


def web_cache_dir() -> Path:
    """Path to web_cache/ directory."""
    return data_dir() / "web_cache"


def claude_config_dir() -> Path:
    """Path to Claude Code's config directory (~/.claude)."""
    return Path.home() / ".claude"


def claude_skills_dir() -> Path:
    """Path to Claude Code skills directory (~/.claude/skills)."""
    return claude_config_dir() / "skills"


def claude_plugins_dir() -> Path:
    """Path to Claude Code plugins directory (~/.claude/plugins)."""
    return claude_config_dir() / "plugins"


def ensure_dir(path: Path) -> Path:
    """Create the directory (and any missing parents) and return it.

    Centralises the `path.mkdir(parents=True, exist_ok=True)` boilerplate
    that several modules repeat. Returns the same path so callers can
    chain on a single line:
        cache_dir = paths.ensure_dir(paths.image_cache_dir())
    """
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_dirs() -> None:
    """Create all needed subdirectories idempotently."""
    dirs = [
        data_dir(),
        data_dir() / "projects",
        data_dir() / "sessions",
        image_cache_dir(),
        models_dir(),
        logs_dir(),
        locks_dir(),
        data_dir() / "queue",
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)


def _rename_with_retry(src: Path, dest: Path) -> None:
    """Rename *src* to *dest*, retrying on PermissionError (Windows file-lock race).

    Windows briefly holds an exclusive lock on a file that was just opened by
    another process, so a rename that races with a concurrent reader can raise
    PermissionError.  Three attempts with short back-off cover the common case
    without meaningfully delaying the caller.
    """
    last_exc: PermissionError | None = None
    for delay in (0.0, 0.05, 0.15):
        if delay:
            time.sleep(delay)
        try:
            src.replace(dest)
            return
        except PermissionError as exc:
            last_exc = exc
    if last_exc is not None:
        raise last_exc from None


def _open_restricted(tmp: Path) -> int:
    """Open *tmp* for writing with owner-only permissions (0o600) on POSIX.

    On POSIX, ``Path.write_text/write_bytes`` honours the process umask, which
    means the temp file may be world-readable (e.g. 0o644 with the common 0o022
    umask) for the brief window between creation and rename.  Session caches,
    config files, and CLAUDE.md written by token-goat should not be visible to
    other local users even transiently.

    On Windows ``os.open`` with ``O_CREAT`` still works but ``os.chmod`` has no
    meaningful effect (NTFS ACLs govern access), so we fall back to a plain open
    there — the user-profile location already provides the needed isolation.
    """
    if sys.platform == "win32":
        return os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    return os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)


class _OwnerOnlyFileHandler(logging.FileHandler):
    """FileHandler that creates its file with 0o600 (owner-only) permissions.

    The stdlib :class:`logging.FileHandler` opens its file with the process
    umask applied, typically yielding 0o644 (world-readable).  Log files
    contain session IDs and local file paths that should not be visible to
    other local users on a shared host, so we override ``_open`` to apply
    a tighter mode at open time.  Subclassing (rather than returning a bare
    ``StreamHandler``) preserves ``isinstance(h, FileHandler)`` checks that
    callers and tests rely on to distinguish file vs console handlers.
    """

    def _open(self):  # type: ignore[override]
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        fd = os.open(self.baseFilename, flags, 0o600)
        return os.fdopen(fd, self.mode, encoding=self.encoding or "utf-8")


def open_log_file(path: Path) -> logging.FileHandler:
    """Return a ``logging.FileHandler`` for *path* with owner-only permissions.

    On POSIX the returned handler is an :class:`_OwnerOnlyFileHandler` that
    creates its file with mode 0o600 so other local users cannot read session
    IDs / paths from the log.  On Windows the ACL on the user-profile
    directory provides equivalent isolation, so a plain ``FileHandler``
    suffices.  In all cases the returned object is a ``FileHandler`` instance
    so callers that branch on ``isinstance(h, FileHandler)`` to tell file vs
    console handlers apart behave correctly.

    The returned handler writes UTF-8 text in append mode.
    """
    if sys.platform == "win32":
        return logging.FileHandler(str(path), encoding="utf-8")
    return _OwnerOnlyFileHandler(str(path), mode="a", encoding="utf-8")


def _atomic_write_core(path: Path, content: str | bytes, mode: Literal["w", "wb"]) -> None:
    """Write *content* to *path* atomically via a temp file + rename.

    Shared implementation for :func:`atomic_write_text` and :func:`atomic_write_bytes`.
    *mode* is the ``open()`` mode string — ``"w"`` for text, ``"wb"`` for binary.

    Two-component temp name: thread ID prevents collisions when multiple threads
    write the same path concurrently; monotonic_ns prevents collisions across rapid
    sequential calls in the same thread where the thread ID alone would repeat.

    Rename-over rather than writing in place: on POSIX, os.rename() is atomic at the
    filesystem level, so readers always see either the old complete file or the new
    complete file — a mid-write crash or kill cannot leave a partially-written file.
    On Windows, _rename_with_retry handles the brief exclusive-lock window.
    """
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.{time.monotonic_ns()}.tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    renamed = False
    try:
        fd = _open_restricted(tmp)
        try:
            if isinstance(content, bytes):
                with os.fdopen(fd, "wb") as fh:
                    fh.write(content)
            else:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(content)
        except Exception as _write_err:  # noqa: BLE001 — any write error: clean up tmp then re-raise
            tmp.unlink(missing_ok=True)
            _LOG.warning("atomic write failed for %s: %s", path.name, _write_err)
            raise
        _rename_with_retry(tmp, path)
        renamed = True
    finally:
        # Only unlink when the rename did not succeed — on POSIX the rename
        # atomically removes the source name so tmp no longer exists after a
        # successful rename, and calling unlink() on a stale path could
        # theoretically hit a different file that reused the same name.  On
        # Windows the same applies: the rename consumed tmp, so we only need to
        # clean up when we still own it (i.e. the rename was never reached or
        # raised).
        if not renamed:
            tmp.unlink(missing_ok=True)


def atomic_write_text(path: Path, content: str) -> None:
    """Write *content* to *path* atomically via a temp file + rename.

    Avoids partial writes if the process is killed mid-flight.  Creates parent
    directories as needed.  On Windows, uses retry logic to handle the brief
    exclusive lock another process may hold immediately after opening the file.

    On POSIX the temp file is created with owner-only permissions (0o600) so
    it is never world-readable even during the brief window before the rename.

    This is the canonical implementation shared by :mod:`session` and
    :mod:`config` — both previously carried their own private copies.
    """
    _atomic_write_core(path, content, "w")


def atomic_write_bytes(path: Path, content: bytes) -> None:
    """Write *content* (bytes) to *path* atomically via a temp file + rename.

    Equivalent to :func:`atomic_write_text` for binary content.  Creates parent
    directories as needed.  Uses the same retry-on-PermissionError strategy.

    On POSIX the temp file is created with owner-only permissions (0o600) so
    it is never world-readable even during the brief window before the rename.
    """
    _atomic_write_core(path, content, "wb")
