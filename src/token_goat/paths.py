"""Central path resolver for token-goat data directories."""
from __future__ import annotations

__all__ = [
    "HOOKS_STDERR_LOG_MAX_BYTES",
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
    "has_windows_drive_prefix",
    "hook_wrapper_content",
    "hook_wrapper_path",
    "hooks_stderr_log_path",
    "set_hooks_stderr_log_override",
    "image_cache_dir",
    "is_safe_rel_path",
    "locks_dir",
    "logs_dir",
    "models_dir",
    "normalize_key",
    "project_db_path",
    "python_runner_argv",
    "python_runner_command",
    "open_log_file",
    "roll_log_if_oversized",
    "manifest_sha_sidecar_path",
    "recovery_pending_path",
    "sentinels_dir",
    "safe_join",
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

from .util import get_logger

_LOG = get_logger("paths")

# Size cap for a structured daily log file. The daily logs are date-named and
# age out via the worker's 7-day retention sweep, so they are already bounded
# in count — but a single pathological day (e.g. a worker stuck in a fast error
# loop) could still bloat one file. Rolling it over to a .prev.log sibling caps
# any one day's footprint.
LOG_FILE_MAX_BYTES = 5_000_000

# Size cap for the hooks crash-sink log. Hook processes cannot write to the
# daily log when _setup_logging has not been called (e.g. they crash during
# payload parsing), and their stderr is normally redirected to nul:/dev/null
# by the harness — so the trace would be lost entirely. hooks-stderr.log is a
# dedicated append-only crash sink for that window. Rolled at 1 MB (same
# threshold as the worker's stderr sink) so a broken plugin cannot flood disk.
HOOKS_STDERR_LOG_MAX_BYTES = 1_000_000


_hooks_stderr_log_override: Path | None = None


def set_hooks_stderr_log_override(path: Path | None) -> None:
    """Override the hooks-stderr.log path for testing.

    Pass a ``tmp_path``-rooted path to redirect crash-sink writes away from the
    real production log during test runs.  Pass ``None`` to restore the default.
    This is the only supported test-isolation mechanism for hooks-stderr.log;
    use the ``isolate_hooks_stderr_log`` autouse fixture in conftest.py.
    """
    global _hooks_stderr_log_override  # noqa: PLW0603
    _hooks_stderr_log_override = path


def hooks_stderr_log_path() -> Path:
    """Path to the hook-process crash sink: ``logs/hooks-stderr.log``."""
    if _hooks_stderr_log_override is not None:
        return _hooks_stderr_log_override
    return logs_dir() / "hooks-stderr.log"


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


def _safe_child_path(base: Path, child_name: str, extension: str, label: str) -> Path:
    """Return ``base / (child_name + extension)`` after null-byte and traversal checks.

    Raises ``ValueError`` if *child_name* contains a null byte (some filesystems
    treat these as path terminators) or if the resolved candidate escapes *base*
    (e.g. via ``../../evil`` sequences).

    Args:
        base:       The directory that must contain the returned path.
        child_name: The filename stem to join under *base* (no extension).
        extension:  File extension including the leading dot (e.g. ``".db"``),
                    or ``""`` if the child name already includes it.
        label:      Human-readable label used in ``ValueError`` messages
                    (e.g. ``"project_hash"``, ``"session_id"``).
    """
    if "\x00" in child_name:
        raise ValueError(f"{label} contains null byte: {child_name!r}")
    candidate = (base / f"{child_name}{extension}").resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError as exc:
        raise ValueError(
            f"{label} produces a path outside {base.name}/: {child_name!r}"
        ) from exc
    return candidate


def safe_join(base: Path, fragment: str, *, ext: str = "") -> Path:
    """Return ``base / (fragment + ext)`` after comprehensive safety checks.

    This is the canonical public helper for joining a base directory with a
    user-controlled fragment (session_id, hash, CLI arg, hook payload value,
    or file-derived string).  It subsumes ``_safe_child_path`` and adds an
    additional check for embedded colons, which are POSIX-legal but
    Windows-illegal and can appear in Codex session IDs.

    Checks performed (in order):
    1. Null-byte rejection — some POSIX filesystems treat ``\\x00`` as a path
       terminator, allowing an attacker to truncate or redirect the path.
    2. Colon rejection — ``C:/evil`` is a Windows absolute path when used as a
       fragment; Codex session IDs can contain ``:`` which silently breaks
       ``Path`` construction on Windows.
    3. Traversal rejection — ``resolve()`` + ``relative_to()`` ensures the
       candidate does not escape *base* via ``..`` sequences (POSIX or Windows).
    4. Absolute-path rejection — covered implicitly by the ``relative_to``
       check, but the null-byte and colon guards run first for clarity.

    Args:
        base:     The directory that must contain the returned path.
        fragment: The filename fragment to join (no extension).  Must not be
                  empty, contain null bytes, contain colons, or produce a path
                  outside *base* after resolution.
        ext:      Optional extension including the leading dot (e.g. ``".json"``).
                  Defaults to ``""`` when the fragment already carries the
                  extension or when the result is an extensionless file.

    Returns:
        The resolved ``Path`` object inside *base*.

    Raises:
        ValueError: On any of the rejection conditions above.
    """
    if not fragment:
        raise ValueError("safe_join: fragment must not be empty")
    if "\x00" in fragment:
        raise ValueError(f"safe_join: fragment contains null byte: {fragment!r}")
    if ":" in fragment:
        raise ValueError(f"safe_join: fragment contains colon (possible Windows absolute path): {fragment!r}")
    # Delegate to _safe_child_path which performs the resolve/relative_to check.
    return _safe_child_path(base, fragment, ext, "fragment")


def project_db_path(project_hash: str) -> Path:
    """Path to projects/{hash}.db.

    Raises ValueError if the resolved path escapes the projects/ subdirectory,
    which would happen with traversal sequences like ``../../../evil``.
    """
    return _safe_child_path(data_dir() / "projects", project_hash, ".db", "project_hash")


def has_windows_drive_prefix(s: str) -> bool:
    """Return True when *s* begins with a Windows drive letter followed by a colon.

    Accepts both upper- and lowercase drive letters (``C:``, ``c:``) so it can be
    used both for case-aware normalization and for absolute-path classification.
    """
    return len(s) >= 2 and s[1] == ":" and s[0].isalpha()


# Back-compat alias: kept module-private name pointing at the public function so
# any in-tree callers using the underscore form continue to work.
_has_windows_drive_prefix = has_windows_drive_prefix


def normalize_key(p: str) -> str:
    """Canonical path-key normalizer for session/hint/compact/stats lookups.

    Transformations:

    * Backslashes -> forward slashes (always, on every platform).
    * Windows only: an uppercase ASCII drive letter (``C:`` style) at the
      start of the string is lowercased to ``c:``. Lowercasing is restricted
      to the leading drive-letter byte; all other path-component case is
      preserved verbatim.

    This is the public canonical form used across token-goat for cache keys,
    dedup fingerprints, and dict lookups that must agree between hook
    processes that can observe the same file with different casings (e.g.
    ``C:\\foo`` vs ``c:\\foo``) when spawned independently by the harness.

    Fast path: paths with no backslashes skip the allocation entirely.

    Scope and known limitations (by design — this is a *string* canonicalizer,
    not a *filesystem* canonicalizer; resolving any of the following would
    require ``os.stat`` / ``readlink`` I/O on every hook call):

    * **Symlinks, junctions, WSL bind mounts.** ``C:\\Projects\\X`` and
      ``/mnt/c/Projects/X`` resolve to the same underlying file under WSL,
      but ``normalize_key`` operates on the input string only and will emit
      different keys for the two forms. Callers that need filesystem identity
      must resolve via ``Path.resolve()`` *before* calling ``normalize_key``.
    * **Case-insensitive path components on NTFS.** NTFS treats
      ``C:\\foo\\Bar.py`` and ``C:\\foo\\bar.py`` as the same file, but
      ``normalize_key`` preserves component case and will emit different keys
      for the two forms. Lowercasing every component would clobber genuine
      case-sensitive paths on case-sensitive filesystems (POSIX, WSL native),
      so this is intentional. Same workaround: resolve first if filesystem
      identity is required.
    * **UNC paths** (``\\\\server\\share\\path``) and the long-path prefix
      ``\\\\?\\C:\\...`` are converted purely via the backslash->slash rule;
      the leading double separator is preserved as ``//`` in the canonical
      form. Two callers observing the same UNC share via different but
      string-equivalent forms will agree.
    * **Trailing whitespace and trailing separators** are preserved
      (no ``rstrip``).
    """
    # Fast path: no backslashes — skip the str.replace allocation.
    if "\\" not in p:
        if sys.platform == "win32" and has_windows_drive_prefix(p) and p[0].isupper():
            return p[0].lower() + p[1:]
        return p
    s = p.replace("\\", "/")
    if sys.platform == "win32" and has_windows_drive_prefix(s) and s[0].isupper():
        s = s[0].lower() + s[1:]
    return s


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

    candidate = _safe_child_path(data_dir() / "sessions", session_id, ".json", "session_id")
    if sys.platform == "win32" and len(str(candidate)) >= 260:
        raise ValueError(
            f"session_id produces a path that exceeds Windows MAX_PATH (260 chars): "
            f"len={len(str(candidate))}"
        )
    return candidate


def hook_wrapper_path() -> Path:
    """Path to the persistent hook wrapper script.

    The wrapper lives in the data dir (not the uv tool venv) so it survives
    ``uv tool install --reinstall .``.  During that command, uv tears down
    the venv at ``%LOCALAPPDATA%\\..\\Roaming\\uv\\tools\\token-goat\\`` and
    rebuilds it; in the ~10s window between teardown and rebuild any hook
    invocation against ``pythonw.exe -m token_goat.cli`` crashes with
    ``ModuleNotFoundError`` because the site-packages module is gone.

    The wrapper bridges that window: it checks for the module's presence on
    disk first, and if absent emits ``{"continue":true}`` and exits 0 — Python
    never gets the chance to crash visibly.  Settings.json points at the
    wrapper instead of ``pythonw.exe`` directly.
    """
    name = "tg-hook.cmd" if sys.platform == "win32" else "tg-hook.sh"
    return data_dir() / "bin" / name


def hook_wrapper_content() -> str:
    """Build the contents of the hook wrapper script for this platform.

    The wrapper checks for ``token_goat/__init__.py`` in the running
    interpreter's site-packages and short-circuits to a fail-soft response if
    absent, then forwards all args to ``pythonw -m token_goat.cli``.
    """
    py = Path(sys.executable)
    pythonw = py.parent / "pythonw.exe"
    runner = pythonw if (sys.platform == "win32" and pythonw.exists()) else py
    # Locate the site-packages copy of token_goat to probe before forwarding.
    sentinel = None
    for cand in (
        py.parent.parent / "Lib" / "site-packages" / "token_goat" / "__init__.py",
        py.parent.parent
        / "lib"
        / f"python{sys.version_info.major}.{sys.version_info.minor}"
        / "site-packages"
        / "token_goat"
        / "__init__.py",
    ):
        if cand.exists():
            sentinel = cand
            break
    if sentinel is None:
        # Fall back to a best-effort guess that at least exists today.
        sentinel = py.parent.parent / "Lib" / "site-packages" / "token_goat" / "__init__.py"

    if sys.platform == "win32":
        # CRLF + cmd.exe syntax. The probe is a one-stat-call file existence
        # check (~1 ms), so the wrapper adds negligible latency on the hot path.
        return (
            "@echo off\r\n"
            "REM token-goat hook wrapper - auto-generated by `token-goat install`.\r\n"
            "REM Survives `uv tool install --reinstall` race window where\r\n"
            "REM site-packages/token_goat is briefly absent.\r\n"
            f'if not exist "{sentinel}" (\r\n'
            '  echo {"continue":true}\r\n'
            "  exit /b 0\r\n"
            ")\r\n"
            f'"{runner}" -m token_goat.cli %*\r\n'
        )
    return (
        "#!/bin/sh\n"
        "# token-goat hook wrapper - auto-generated by `token-goat install`.\n"
        f'if [ ! -f "{sentinel}" ]; then\n'
        '  printf \'%s\\n\' \'{"continue":true}\'\n'
        "  exit 0\n"
        "fi\n"
        f'exec "{runner}" -m token_goat.cli "$@"\n'
    )


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


def compact_skip_sentinel_path(session_id: str) -> Path:
    """Path to compact_skip/{session_id}.sentinel.

    The sentinel file is written when the pre-compact hook determines that the
    session has too little activity to warrant building a manifest (iter 19
    activity-floor).  On subsequent calls the entry point reads this file
    *before* importing any token_goat modules, exits immediately, and saves
    ~150 ms of Python import overhead.

    The sentinel auto-expires after 5 minutes (mtime check by the caller) —
    no explicit cleanup is needed, and stale sentinels are silently ignored.

    Raises ``ValueError`` if *session_id* contains a null byte or would
    produce a path outside the ``compact_skip/`` subdirectory.
    """
    return _safe_child_path(data_dir() / "compact_skip", session_id, ".sentinel", "session_id")


def sentinels_dir() -> Path:
    """Path to ``sentinels/`` — general-purpose small sidecar files.

    Used for manifest SHA sidecars (``manifest_sha_{session_id}``) and any
    future lightweight cross-invocation state that does not belong in the
    session JSON (which would force a full deserialise/serialise round-trip).
    Created on first access by callers; no explicit setup required.
    """
    return data_dir() / "sentinels"


def recovery_pending_path(session_id: str) -> Path:
    """Path to ``sentinels/recovery_pending_{session_id}``.

    Written by the SessionStart handler when ``source == "compact"`` so that
    the pre-read hook can inject the recovery hint on the first actual Read or
    Bash tool call rather than at session-start time (item 2 — deferred recovery).

    The file stores the recovery hint text as UTF-8.  The pre-read hook reads
    and deletes it on first hit, injecting the payload as ``additionalContext``.

    Raises ``ValueError`` if *session_id* contains a null byte or escapes the
    ``sentinels/`` directory.
    """
    return _safe_child_path(sentinels_dir(), f"recovery_pending_{session_id}", "", "session_id")


def manifest_sha_sidecar_path(session_id: str) -> Path:
    """Path to the manifest-SHA sidecar for *session_id*.

    The sidecar stores ``sha256(manifest_text)|fingerprint|emit_ts`` so the
    next PreCompact can detect an unchanged session without rendering the full
    manifest.  Written atomically after every full manifest emit; read at the
    start of every PreCompact before calling ``_render``.

    Raises ``ValueError`` if *session_id* contains a null byte or would
    produce a path outside the ``sentinels/`` directory.
    """
    return _safe_child_path(sentinels_dir(), f"manifest_sha_{session_id}", "", "session_id")


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

    Race-tolerant on Windows: ``pathlib.Path.mkdir(parents=True, exist_ok=True)``
    has a known race where two concurrent processes can both raise
    ``FileExistsError`` even with ``exist_ok=True``. Python's pathlib catches
    OSError from os.mkdir and re-raises unless ``self.is_dir()`` returns True,
    but ``is_dir()`` does a ``stat()`` that can transiently return stale data
    on Windows right after another process creates the directory — so pathlib
    spuriously re-raises a FileExistsError on a directory that genuinely
    exists. We retry briefly and fall back to ``path.exists()`` which is more
    forgiving than ``is_dir()`` under filesystem-attribute lag.
    """
    last_exc: FileExistsError | None = None
    for attempt in range(3):
        try:
            path.mkdir(parents=True, exist_ok=True)
            return path
        except FileExistsError as exc:
            last_exc = exc
            # Race: another process beat us; Windows stat may not have synced
            # yet. Yield briefly and re-check.
            time.sleep(0.005 * (attempt + 1))
            try:
                if path.is_dir():
                    return path
            except OSError:
                continue  # is_dir itself raced; keep retrying
    # Final check: trust ``exists()`` (cheaper than ``is_dir`` and less
    # sensitive to stat-attribute lag). If anything at all is at this path
    # we treat ``exist_ok=True`` as satisfied — same intent the caller has.
    if path.exists():
        return path
    if last_exc is not None:
        raise last_exc
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
        ensure_dir(d)


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
    ensure_dir(path.parent)
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
