"""Per-project persistent key-value memory for session-start context injection.

Stores arbitrary text facts that the agent should recall at the start of every
session in a project, without repeating them in the conversation history.
Backed by a TOML file per project; reads are instant and writes are atomic.

Public API::

    memory_path(project_hash)           -> Path
    load_entries(project_hash)          -> dict[str, str]
    set_entry(project_hash, key, value) -> None
    unset_entry(project_hash, key)      -> None
    clear_all(project_hash)             -> None
    build_injection(project_hash)       -> str | None
"""
from __future__ import annotations

__all__ = [
    "build_injection",
    "clear_all",
    "load_entries",
    "memory_path",
    "set_entry",
    "unset_entry",
]

import re
from typing import TYPE_CHECKING

from . import paths
from .util import get_logger

if TYPE_CHECKING:
    from pathlib import Path

_LOG = get_logger("project_memory")

# Maximum number of entries surfaced in the session-start injection.
_MAX_ENTRIES: int = 30

# Maximum length of a single value in the injection; longer values are truncated.
_MAX_VALUE_LEN: int = 300

# Hard ceiling on the total injection size (chars). Safety net against a
# pathological CLAUDE.md that sets dozens of large values. 4 000 chars ≈ 1 000
# tokens — generous enough for any normal project, but blocks runaway dumps.
_MAX_TOTAL_CHARS: int = 4_000

# Key validation: alphanumeric, hyphens, underscores only; max 80 chars.
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def memory_path(project_hash: str) -> Path:
    """Return the TOML file path for this project's memory entries."""
    return paths.data_dir() / "projects" / f"{project_hash}_memory.toml"


def _validate_key(key: str) -> None:
    if not _KEY_RE.match(key):
        raise ValueError(
            f"Invalid memory key {key!r}: use only letters, digits, hyphens, underscores (max 80 chars)"
        )


def _load_raw(path: Path) -> dict[str, str]:
    """Read and parse the TOML file; return an empty dict on any failure."""
    if not path.exists():
        return {}
    try:
        import tomllib  # noqa: PLC0415 — lazy: only TOML memory paths import this
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        return {k: str(v) for k, v in data.items() if isinstance(v, (str, int, float, bool))}
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("project_memory: failed to load %s: %s", path, exc)
        return {}


def _save(path: Path, entries: dict[str, str]) -> None:
    """Serialize *entries* to TOML and write atomically."""
    lines: list[str] = []
    for k, v in sorted(entries.items()):
        escaped = v.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n")
        lines.append(f'{k} = "{escaped}"')
    paths.atomic_write_text(path, "\n".join(lines) + ("\n" if lines else ""))


def load_entries(project_hash: str) -> dict[str, str]:
    """Return all memory entries for *project_hash*, or an empty dict."""
    return _load_raw(memory_path(project_hash))


def set_entry(project_hash: str, key: str, value: str) -> None:
    """Set *key* to *value* in this project's memory."""
    _validate_key(key)
    p = memory_path(project_hash)
    paths.ensure_dir(p.parent)
    entries = _load_raw(p)
    entries[key] = value
    _save(p, entries)


def unset_entry(project_hash: str, key: str) -> None:
    """Remove *key* from this project's memory (no-op if absent)."""
    _validate_key(key)
    p = memory_path(project_hash)
    entries = _load_raw(p)
    if key not in entries:
        return
    del entries[key]
    _save(p, entries)


def clear_all(project_hash: str) -> None:
    """Remove all memory entries for *project_hash*."""
    p = memory_path(project_hash)
    if p.exists():
        _save(p, {})


def build_injection(project_hash: str) -> str | None:
    """Build a compact Markdown block of memory entries for session-start injection.

    Returns None when no entries are stored — callers should treat None as
    "nothing to inject" and skip the additionalContext entirely.
    """
    try:
        entries = load_entries(project_hash)
    except Exception:  # noqa: BLE001
        return None
    if not entries:
        return None

    header = "## Project Memory"
    lines = [header]
    total = len(header)
    skipped = 0
    for key, val in list(entries.items())[:_MAX_ENTRIES]:
        display = val if len(val) <= _MAX_VALUE_LEN else val[:_MAX_VALUE_LEN] + "…"
        line = f"- **{key}**: {display}"
        if total + len(line) + 1 > _MAX_TOTAL_CHARS:
            skipped += 1
            continue
        lines.append(line)
        total += len(line) + 1  # +1 for the joining newline
    if skipped:
        lines.append(f"- (+{skipped} more memory entries omitted — total size limit reached)")
    return "\n".join(lines)
