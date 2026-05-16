"""Central path resolver for token-goat data directories."""
import contextlib
import os
import sys
from pathlib import Path

import platformdirs

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


def data_dir() -> Path:
    """Get token-goat data directory."""
    return Path(platformdirs.user_data_dir("token-goat", "dfk-helper"))


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
    """
    base = data_dir() / "sessions"
    candidate = (base / f"{session_id}.json").resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError as exc:
        raise ValueError(f"session_id produces a path outside the sessions directory: {session_id!r}") from exc
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
        if path.stat().st_size <= max_bytes:
            return
    except OSError:
        return
    with contextlib.suppress(OSError):
        os.replace(path, path.with_suffix(".prev.log"))


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
