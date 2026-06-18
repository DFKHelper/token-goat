"""Central path resolver for token-goat data directories."""
from __future__ import annotations

__all__ = [
    "HOOKS_STDERR_LOG_MAX_BYTES",
    "LOG_FILE_MAX_BYTES",
    "atomic_write_bytes",
    "atomic_write_text",
    "baseline_advisory_sent_path",
    "claude_config_dir",
    "claude_plugins_dir",
    "claude_projects_dir",
    "claude_session_tool_results_dir",
    "claude_skills_dir",
    "config_path",
    "data_dir",
    "dirty_queue_path",
    "ensure_dir",
    "ensure_dirs",
    "gdrive_cache_dir",
    "gdrive_creds_path",
    "global_db_path",
    "hook_wrapper_content",
    "hook_wrapper_path",
    "hooks_stderr_log_path",
    "image_cache_dir",
    "is_safe_rel_path",
    "is_wsl",
    "locks_dir",
    "logs_dir",
    "manifest_sha_sidecar_path",
    "manifest_text_sidecar_path",
    "models_dir",
    "normalize_key",
    "normalize_path_key",
    "open_log_file",
    "precompact_estimate_path",
    "project_db_path",
    "project_ignore_file_path",
    "python_runner_argv",
    "python_runner_command",
    "recovery_pending_path",
    "roll_log_if_oversized",
    "safe_join",
    "sentinels_dir",
    "session_cache_path",
    "sessions_dir",
    "set_hooks_stderr_log_override",
    "skill_pregen_sentinel_path",
    "web_cache_dir",
    "worker_heartbeat_path",
    "worker_pid_path",
]

import logging
import os
import shlex
import sys
import threading
import time
from pathlib import Path
from typing import IO, Any, Literal

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
    global _hooks_stderr_log_override
    _hooks_stderr_log_override = path


def hooks_stderr_log_path() -> Path:
    """Path to the hook-process crash sink: ``logs/hooks-stderr.log``."""
    if _hooks_stderr_log_override is not None:
        return _hooks_stderr_log_override
    return logs_dir() / "hooks-stderr.log"


def is_wsl() -> bool:
    """Return True when running inside Windows Subsystem for Linux (WSL).

    WSL processes report ``sys.platform == "linux"`` but may benefit from
    Windows-specific guidance (e.g. data-directory locations, doctor output).
    Detection uses the environment variables that the WSL kernel injector
    populates for every Linux process inside a WSL distro:

    * ``WSL_DISTRO_NAME`` — set by WSL 2 (and WSL 1 on recent builds) to the
      distribution name (e.g. ``Ubuntu``).
    * ``WSL_INTEROP`` — socket path written by WSL 2 for Win32 interop; absent
      in WSL 1 and in plain Linux containers, so it is checked second.

    Both checks are purely env-var reads (no file I/O, no subprocess) so the
    function is safe to call on the hot hook path.
    """
    return bool(os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"))


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
    if argv:
        argv[0] = argv[0].replace("\\", "/")
    quoted = [
        shlex.quote(a) if '"' in a else f'"{a}"' if " " in a else a
        for a in argv
    ]
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

    On Windows, also raises ``ValueError`` when *child_name* contains a colon.
    A colon in a Windows filename silently creates an NTFS Alternate Data Stream
    instead of a regular file — the write succeeds, ``os.path.exists`` returns
    True, but the file never appears in directory listings and ``iterdir()`` skips
    it.  Codex session IDs can contain ``:``; rejecting them here lets callers
    either sanitize first or surface a clear error rather than silently losing data.

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
    if sys.platform == "win32" and ":" in child_name:
        raise ValueError(
            f"{label} contains colon (would create NTFS Alternate Data Stream on Windows): "
            f"{child_name!r}"
        )
    # Reject UNC-style paths before calling .resolve().  On Windows,
    # Path("//server/share/...").resolve() triggers a network lookup and can
    # stall for several seconds when the host is unreachable.  Check the raw
    # string first so we raise immediately without touching the network.
    _norm = child_name.replace("\\", "/")
    if _norm.startswith("//"):
        raise ValueError(
            f"{label} produces a path outside {base.name}/: {child_name!r}"
        )
    candidate = (base / f"{child_name}{extension}").resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError as exc:
        raise ValueError(
            f"{label} produces a path outside {base.name}/: {child_name!r}"
        ) from exc
    return candidate


def _sanitize_session_id_for_filename(session_id: str) -> str:
    """Return a filesystem-safe version of *session_id* for use in filenames.

    On Windows, colons in filenames silently create NTFS Alternate Data Streams
    instead of regular files (see ``_safe_child_path`` for details).  Codex
    session IDs can contain ``:``; this helper replaces each colon with ``_`` so
    the sanitized ID is safe to embed in compound filenames like
    ``manifest_sha_{session_id}`` or ``recovery_pending_{session_id}``.

    The substitution is reversible in context (the prefix ``manifest_sha_`` is
    unique enough that collision with a genuine underscore in the session ID does
    not matter — these files are never looked up by session_id in reverse), and
    it is idempotent (already-safe IDs pass through unchanged).
    """
    if sys.platform == "win32" and ":" in session_id:
        sanitized = session_id.replace(":", "_")
        _LOG.debug(
            "paths: session_id contains colon; sanitized for filename: %r -> %r",
            session_id[:24], sanitized[:24],
        )
        return sanitized
    return session_id


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


def normalize_key(p: str) -> str:
    """Canonical path-key normalizer for session/hint/compact/stats lookups.

    Delegates to :func:`token_goat.util.normalize_path` for the actual
    transformations:

    * WSL paths ``/mnt/<drive>/rest`` are converted to ``<drive>:/rest``.
    * Backslashes are replaced with forward slashes.
    * An uppercase drive letter prefix (``C:``) is lowercased to ``c:``.

    All callers benefit automatically: session dict keys, hint fingerprints,
    compact manifest lookups, and stats queries all produce the same canonical
    form regardless of whether the path arrived from a Windows process
    (``C:\\foo``), a WSL process (``/mnt/c/foo``), or an already-normalized
    form (``c:/foo``).

    Scope and known limitations (by design):

    * **Symlinks, junctions, WSL bind mounts.** ``normalize_key`` converts
      the string form of WSL paths (``/mnt/<single-letter-drive>/...``) but
      does not follow arbitrary symlinks or other WSL mount points.
    * **Case-insensitive path components on NTFS.** Component case is
      preserved verbatim; only the leading drive letter is lowercased.
    * **UNC paths** and the long-path prefix ``\\\\?\\...`` are
      converted via the backslash-to-slash rule only.
    * **Trailing whitespace and trailing separators** are preserved.
    """
    from .util import normalize_path

    return normalize_path(p)


def normalize_path_key(path: str, cwd: str | None = None) -> str:
    """Normalize a path to a canonical absolute key for cross-form dedup lookups.

    Extends :func:`normalize_key` with relative-path resolution so that
    ``./scripts/ads.js`` and ``C:/Projects/.../scripts/ads.js`` produce the
    same key when the working directory is known:

    * If *path* is absolute (as judged by both string analysis and
      :meth:`pathlib.Path.is_absolute`): resolve symlinks, then apply the
      standard :func:`normalize_key` transformations (backslash → slash,
      drive-letter lowercase, WSL ``/mnt/<drive>/`` → ``<drive>:/``).
    * If *path* appears rooted (starts with ``/``) but ``pathlib`` does not
      consider it absolute (POSIX-rooted path on Windows such as
      ``/proj/src/foo.py``): apply :func:`normalize_key` string-only, because
      calling ``.resolve()`` would anchor the path to the current Windows
      drive and produce a key inconsistent with what :func:`session.mark_file_read`
      stores (which also uses :func:`normalize_key` string-only).
    * If *path* is relative and *cwd* is provided: join ``Path(cwd) / path``,
      resolve, then normalize.
    * If *path* is relative and *cwd* is ``None``: fall back to
      :func:`normalize_key` (best-effort; cross-form dedup may miss).

    Always fail-soft: any :exc:`OSError` or other exception falls back to
    :func:`normalize_key` so callers are never interrupted.

    Args:
        path: The raw path string to normalize (absolute or relative).
        cwd: Optional working directory for resolving relative paths.  Pass
            the ``cwd`` value from ``get_session_context(payload)`` when
            available.

    Returns:
        A canonical forward-slash string with a lowercased drive letter prefix
        on Windows, suitable for use as a dict key or SQLite lookup value.
    """
    try:
        from pathlib import Path as _P
        # Detect whether the path is "rooted" using string analysis first so that
        # POSIX-rooted paths on Windows (e.g. /proj/src/foo.py, which
        # Path.is_absolute() rejects because there is no drive letter) are handled
        # correctly without calling .resolve() and inadvertently anchoring them to
        # the current Windows drive.
        normalized_str = path.replace("\\", "/")
        is_posix_rooted = normalized_str.startswith("/")
        has_drive = len(normalized_str) >= 2 and normalized_str[1] == ":" and normalized_str[0].isalpha()
        is_string_absolute = is_posix_rooted or has_drive
        if is_string_absolute:
            p = _P(path)
            if p.is_absolute():
                # Truly absolute on the current OS — safe to resolve symlinks.
                return normalize_key(str(p.resolve()))
            # POSIX-rooted on Windows: use string-only normalization to stay
            # consistent with session.mark_file_read (which also uses normalize_key).
            return normalize_key(path)
        # Relative path: resolve against cwd when available.
        if cwd:
            return normalize_key(str((_P(cwd) / _P(path)).resolve()))
    except Exception:
        pass
    return normalize_key(path)


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
    if normalized.startswith(("/", "//")):
        return False
    if len(normalized) >= 2 and normalized[1] == ":" and normalized[0].isalpha():
        return False

    return all(part != ".." for part in normalized.split("/"))


def sessions_dir() -> Path:
    """Path to the sessions/ directory where per-session cache files are stored.

    Each session is tracked in a JSON file: ``sessions/{session_id}.json``.
    This directory is used by the doctor to report session count, oldest age,
    and total size.
    """
    return data_dir() / "sessions"


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

    The wrapper probes for the *real* ``token_goat/__init__.py`` of the running
    interpreter and short-circuits to a fail-soft ``{"continue":true}`` response
    when it is absent (the ``uv tool install --reinstall`` race window where the
    venv's ``token_goat`` is briefly gone), then forwards all args to
    ``pythonw -m token_goat.cli``.

    The probe is resolved via :func:`importlib.util.find_spec`, which returns the
    correct ``__init__.py`` for *both* editable installs (resolves into ``src/``)
    and regular / uv-tool installs (resolves into ``site-packages``).  A prior
    version probed *only* the conventional ``site-packages/token_goat`` location;
    for an editable install that file never exists, so the wrapper fell back to a
    guessed path and baked in an ``if not exist`` gate that was permanently true,
    silently no-op'ing every hook (it echoed ``{"continue":true}`` without ever
    forwarding).  When no existing sentinel can be located at all, the wrapper is
    emitted *ungated* (forwards unconditionally) rather than gating on a phantom
    path — an ungated wrapper works whenever the module is importable, whereas a
    phantom gate disables hooks entirely.
    """
    py = Path(sys.executable)
    pythonw = py.parent / "pythonw.exe"
    runner = pythonw if (sys.platform == "win32" and pythonw.exists()) else py

    # Resolve the real token_goat/__init__.py via the import system first; this is
    # correct for editable (src/) and regular (site-packages/) installs alike.
    sentinel: Path | None = None
    try:
        import importlib.util as _ilu

        _spec = _ilu.find_spec("token_goat")
        if _spec is not None and _spec.origin:
            _cand = Path(_spec.origin)
            if _cand.exists():
                sentinel = _cand
    except Exception:
        sentinel = None

    if sentinel is None:
        # Fall back to the conventional site-packages locations.
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

    if sys.platform == "win32":
        if sentinel is None:
            # No reliable sentinel — forward unconditionally rather than gate on a
            # non-existent path (which would no-op every hook).
            return (
                "@echo off\r\n"
                "REM token-goat hook wrapper - auto-generated by `token-goat install`.\r\n"
                f'"{runner}" -m token_goat.cli %*\r\n'
            )
        # CRLF + cmd.exe syntax. The probe is a one-stat-call file existence
        # check (~1 ms), so the wrapper adds negligible latency on the hot path.
        return (
            "@echo off\r\n"
            "REM token-goat hook wrapper - auto-generated by `token-goat install`.\r\n"
            "REM Survives `uv tool install --reinstall` race window where\r\n"
            "REM token_goat is briefly absent.\r\n"
            f'if not exist "{sentinel}" (\r\n'
            '  echo {"continue":true}\r\n'
            "  exit /b 0\r\n"
            ")\r\n"
            f'"{runner}" -m token_goat.cli %*\r\n'
        )
    if sentinel is None:
        return (
            "#!/bin/sh\n"
            "# token-goat hook wrapper - auto-generated by `token-goat install`.\n"
            f'exec "{runner}" -m token_goat.cli "$@"\n'
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


def project_ignore_file_path(project_root: Path) -> Path:
    """Path to the per-project custom exclusion file (.tokengoatignore at project root)."""
    return project_root / ".tokengoatignore"


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

    On Windows, colons in *session_id* are sanitized to underscores before
    path construction to prevent silent NTFS Alternate Data Stream creation.
    """
    safe_id = _sanitize_session_id_for_filename(session_id)
    return _safe_child_path(data_dir() / "compact_skip", safe_id, ".sentinel", "session_id")


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

    On Windows, colons in *session_id* are sanitized to underscores before
    path construction to prevent silent NTFS Alternate Data Stream creation.
    """
    safe_id = _sanitize_session_id_for_filename(session_id)
    return _safe_child_path(sentinels_dir(), f"recovery_pending_{safe_id}", "", "session_id")


def baseline_advisory_sent_path(session_id: str) -> Path:
    """Path to ``sentinels/baseline_advisory_{session_id}``.

    Written by the SessionStart handler the first time it emits the
    environmental-baseline advisory for a session, so the advisory fires at most
    once per session even though SessionStart re-runs on resume and compact.

    The file's contents are irrelevant — its existence is the flag.

    Raises ``ValueError`` if *session_id* contains a null byte or escapes the
    ``sentinels/`` directory.

    On Windows, colons in *session_id* are sanitized to underscores before
    path construction to prevent silent NTFS Alternate Data Stream creation.
    """
    safe_id = _sanitize_session_id_for_filename(session_id)
    return _safe_child_path(sentinels_dir(), f"baseline_advisory_{safe_id}", "", "session_id")


def precompact_estimate_path(session_id: str) -> Path:
    """Path to ``sentinels/precompact_estimate_{session_id}``.

    Written by the PreCompact hook immediately after loading the session cache,
    before compaction destroys the bash/web history.  The file stores a JSON
    payload::

        {"bytes_estimate": N, "bash_count": M, "web_count": K, "session_id": "A", "ts": float}

    The SessionStart handler (source=="compact") reads this file to recover the
    byte estimate for the stat pair written by ``_check_recovery_pending`` in
    ``hooks_read.py``.  The session ID embedded in the payload lets the reader
    confirm the sentinel is from the expected compaction cycle.

    Raises ``ValueError`` if *session_id* contains a null byte or escapes the
    ``sentinels/`` directory.

    On Windows, colons in *session_id* are sanitized to underscores before
    path construction to prevent silent NTFS Alternate Data Stream creation.
    """
    safe_id = _sanitize_session_id_for_filename(session_id)
    return _safe_child_path(sentinels_dir(), f"precompact_estimate_{safe_id}", ".json", "session_id")


def skill_pregen_sentinel_path() -> Path:
    """Path to ``sentinels/skill_pregen_sentinel.json``.

    Written by ``pregen_skill_compacts()`` in ``install.py`` (and by
    ``token-goat skill-compact --all``) after a successful pre-generation run.
    The file stores a JSON payload::

        {"ts": float, "skill_count": int, "compact_count": int}

    ``token-goat doctor`` reads this file to detect skills installed after the
    last pre-generation run by comparing the sentinel mtime against plugin dir
    mtimes.  A missing sentinel means pre-generation has never run.
    """
    return sentinels_dir() / "skill_pregen_sentinel.json"


def manifest_sha_sidecar_path(session_id: str) -> Path:
    """Path to the manifest-SHA sidecar for *session_id*.

    The sidecar stores ``sha256(manifest_text)|fingerprint|emit_ts`` so the
    next PreCompact can detect an unchanged session without rendering the full
    manifest.  Written atomically after every full manifest emit; read at the
    start of every PreCompact before calling ``_render``.

    Raises ``ValueError`` if *session_id* contains a null byte or would
    produce a path outside the ``sentinels/`` directory.

    On Windows, colons in *session_id* are sanitized to underscores before
    path construction to prevent silent NTFS Alternate Data Stream creation.
    """
    safe_id = _sanitize_session_id_for_filename(session_id)
    return _safe_child_path(sentinels_dir(), f"manifest_sha_{safe_id}", "", "session_id")


def manifest_text_sidecar_path(session_id: str) -> Path:
    """Path to the manifest-text sidecar for *session_id*.

    Stores the full rendered manifest text from the last emit so that
    ``token-goat compact-hint --diff`` can show a unified diff against the
    current manifest without needing to reconstruct the prior text from its SHA.

    Lives alongside :func:`manifest_sha_sidecar_path` under ``sentinels/``
    with a ``manifest_text_`` prefix.  Written atomically after every full
    manifest emit; read only by developer tooling (``compact-hint --diff``).

    Raises ``ValueError`` if *session_id* contains a null byte or would produce
    a path outside the ``sentinels/`` directory.
    """
    safe_id = _sanitize_session_id_for_filename(session_id)
    return _safe_child_path(sentinels_dir(), f"manifest_text_{safe_id}", ".txt", "session_id")


def claude_config_dir() -> Path:
    """Path to Claude Code's config directory (~/.claude)."""
    return Path.home() / ".claude"


def claude_projects_dir() -> Path:
    """Path to Claude Code's per-project session store (``~/.claude/projects``).

    Each subdirectory is one project; its name is a slug of the project's
    absolute path (non-alphanumerics collapsed to ``-``). Inside live
    ``<session-id>.jsonl`` transcripts and, for sessions that persisted large
    tool/hook output, a sibling ``<session-id>/tool-results/`` directory holding
    one ``hook-<uuid>-stdout.txt`` per persisted hook dump.
    """
    return claude_config_dir() / "projects"


def claude_session_tool_results_dir(session_id: str) -> Path | None:
    """Return the ``tool-results`` directory for *session_id*, or ``None``.

    Scans :func:`claude_projects_dir` for the project that owns *session_id*
    rather than reconstructing Claude Code's path-slug scheme (which token-goat
    deliberately does not reimplement). Returns the first existing
    ``<project>/<session_id>/tool-results`` directory.

    *session_id* is validated as a bare path segment — no separators, ``..``,
    or null byte — so a crafted value cannot escape the projects root via the
    join. Returns ``None`` on any validation failure, a missing projects root,
    or when no project owns the session. Never raises.
    """
    if not session_id or "\x00" in session_id:
        return None
    if "/" in session_id or "\\" in session_id or session_id in (".", ".."):
        return None
    root = claude_projects_dir()
    try:
        if not root.is_dir():
            return None
        for proj_dir in root.iterdir():
            try:
                if not proj_dir.is_dir():
                    continue
                candidate = proj_dir / session_id / "tool-results"
                if candidate.is_dir():
                    return candidate
            except OSError:
                continue
    except OSError:
        return None
    return None


def claude_session_project_dir(session_id: str) -> Path | None:
    """Return the ``~/.claude/projects/<slug>`` directory that owns *session_id*.

    Matches by scanning for a ``<session_id>.jsonl`` transcript file rather than
    reconstructing Claude Code's path-slug scheme (which token-goat deliberately
    does not reimplement).  The transcript exists at session start, unlike the
    ``tool-results`` subdir which may not be created until a hook fires.

    *session_id* undergoes the same path-segment validation as
    :func:`claude_session_tool_results_dir`.  Returns ``None`` on any validation
    failure, a missing projects root, or when no project owns the session.
    Never raises.
    """
    if not session_id or "\x00" in session_id:
        return None
    if "/" in session_id or "\\" in session_id or session_id in (".", ".."):
        return None
    root = claude_projects_dir()
    try:
        if not root.is_dir():
            return None
        for proj_dir in root.iterdir():
            try:
                if not proj_dir.is_dir():
                    continue
                if (proj_dir / f"{session_id}.jsonl").is_file():
                    return proj_dir
            except OSError:
                continue
    except OSError:
        return None
    return None


def claude_skills_dir() -> Path:
    """Path to Claude Code skills directory (~/.claude/skills)."""
    return claude_config_dir() / "skills"


def claude_plugins_dir() -> Path:
    """Path to Claude Code plugins directory (~/.claude/plugins)."""
    return claude_config_dir() / "plugins"


def ensure_dir(path: Path, mode: int = 0o700) -> Path:
    """Create the directory (and any missing parents) and return it.

    Centralises the `path.mkdir(parents=True, exist_ok=True)` boilerplate
    that several modules repeat. Returns the same path so callers can
    chain on a single line:
        cache_dir = paths.ensure_dir(paths.image_cache_dir())

    On POSIX, directories are created with `mode` (default 0o700, owner-only)
    to prevent other local users from reading sensitive data (session caches,
    embeddings). On Windows, NTFS ACLs already provide isolation via the
    user-profile location, so mode has no effect.

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
            path.mkdir(parents=True, exist_ok=True, mode=mode)
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

    def _open(self) -> IO[Any]:  # type: ignore[override]  # parent returns IO[Any]; os.fdopen() returns IO[Any] but mypy cannot verify the subtype from the overloaded fdopen signature
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
                # Encode to bytes ourselves with surrogate-safe handling rather
                # than letting the text-mode writer encode lazily. A lone UTF-16
                # surrogate (e.g. "\udc8f") can slip into session state when a
                # Bash pipe is mis-decoded as cp1252 on Windows; a plain
                # encoding="utf-8" writer raises UnicodeEncodeError ("surrogates
                # not allowed") mid-write, aborting the rename and silently
                # dropping the turn's session-cache state. Replacing surrogates
                # with `?` (U+003F) keeps the write valid and the state intact.
                encoded = content.encode("utf-8", "replace")
                with os.fdopen(fd, "wb") as fh:
                    fh.write(encoded)
        except Exception as _write_err:
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
