"""Central path resolver for cc-saver data directories."""
from pathlib import Path

import platformdirs


def data_dir() -> Path:
    """Get cc-saver data directory."""
    return Path(platformdirs.user_data_dir("cc-saver", "Zelys"))


def global_db_path() -> Path:
    """Path to global.db."""
    return data_dir() / "global.db"


def project_db_path(project_hash: str) -> Path:
    """Path to projects/{hash}.db."""
    return data_dir() / "projects" / f"{project_hash}.db"


def session_cache_path(session_id: str) -> Path:
    """Path to sessions/{session_id}.json."""
    return data_dir() / "sessions" / f"{session_id}.json"


def image_cache_dir() -> Path:
    """Path to images/ directory."""
    return data_dir() / "images"


def models_dir() -> Path:
    """Path to models/ directory."""
    return data_dir() / "models"


def logs_dir() -> Path:
    """Path to logs/ directory."""
    return data_dir() / "logs"


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
