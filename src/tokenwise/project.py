"""Project marker detection + path canonicalization."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

PROJECT_MARKERS = (
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "shopify.app.toml",
    "_config.yml",
    "deno.json",
    "deno.jsonc",
)


@dataclass(frozen=True)
class Project:
    """Detected project with root, hash, and marker file."""

    root: Path  # canonical path
    hash: str  # sha1 of canonical posix path, lowercased drive
    marker: str  # which marker file was found


def canonicalize(path: Path) -> Path:
    """Resolve symlinks, normalize, lowercase the Windows drive letter."""
    resolved = path.resolve()
    s = resolved.as_posix()
    # Lowercase drive letter on Windows (e.g. "C:/foo" → "c:/foo")
    if len(s) >= 2 and s[1] == ":":
        s = s[0].lower() + s[1:]
    return Path(s)


def project_hash(canonical_root: Path) -> str:
    """Return sha1 hash of canonical posix path."""
    return hashlib.sha1(canonical_root.as_posix().encode("utf-8")).hexdigest()


def make_project_at(root: Path) -> Project:
    """Create a Project for any directory without requiring a project marker.

    Used for indexing arbitrary directories like ~/.claude/skills/ that have no
    .git, pyproject.toml, or other marker files.
    """
    canonical = canonicalize(root)
    return Project(root=canonical, hash=project_hash(canonical), marker="manual")


def find_project(cwd: Path | str) -> Project | None:
    r"""
    Walk up from cwd looking for a project marker.

    Returns None if none found (e.g., user is in C:\Projects\ with 100 sibling dirs).
    """
    p = canonicalize(Path(cwd))
    for current in (p, *p.parents):
        for marker in PROJECT_MARKERS:
            if (current / marker).exists():
                return Project(root=current, hash=project_hash(current), marker=marker)
    return None
