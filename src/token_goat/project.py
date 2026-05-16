"""Project marker detection + path canonicalization."""
from __future__ import annotations

import hashlib
import os
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

# A directory with at least this many immediate children that are themselves
# independent git repos is treated as a *container* of repos, not a project.
_REPO_CONTAINER_THRESHOLD = 3


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

    Raises ValueError when *root* does not resolve to an existing directory.
    This prevents accidental project creation for symlinks-to-files or
    non-existent paths, which would cause the indexer to crawl nothing useful
    while silently succeeding.
    """
    canonical = canonicalize(root)
    if not canonical.is_dir():
        raise ValueError(f"make_project_at: path is not a directory: {canonical}")
    return Project(root=canonical, hash=project_hash(canonical), marker="manual")


def _is_repo_container(path: Path) -> bool:
    r"""
    True if *path* merely *contains* independent repos rather than being a
    project itself.

    A stray ``git init`` at such a directory (e.g. ``C:\Projects`` holding a
    dozen unrelated checkouts) would otherwise make ``find_project`` return the
    whole supertree, and the entire thing would index as one giant project. We
    detect the pattern by counting immediate child directories that have their
    own ``.git`` — three or more nested independent repos is the container
    signature. A real project, including a monorepo (whose packages share the
    one root ``.git``), does not look like this.
    """
    nested_repos = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                if entry.is_dir(follow_symlinks=False) and (Path(entry.path) / ".git").exists():
                    nested_repos += 1
                    if nested_repos >= _REPO_CONTAINER_THRESHOLD:
                        return True
    except OSError:
        return False
    return False


def _marker_exists(current: Path, marker: str) -> bool:
    """Return True when *marker* exists under *current* and is not a symlink that
    escapes the candidate project root.

    A bare ``(current / marker).exists()`` follows symlinks unconditionally.
    That lets an attacker plant a symlink such as ``mydir/.git -> /etc/passwd``
    to make find_project treat ``mydir`` as a project and trigger indexing of
    arbitrary filesystem paths.  We allow symlinks only when they resolve to a
    path still contained within *current*.
    """
    marker_path = current / marker
    try:
        if not marker_path.exists():
            return False
        # Symlink: verify the resolved target stays inside the candidate root.
        if marker_path.is_symlink():
            resolved = marker_path.resolve()
            try:
                resolved.relative_to(current.resolve())
            except ValueError:
                return False  # symlink escapes the project root — reject
        return True
    except OSError:
        return False


def find_project(cwd: Path | str) -> Project | None:
    r"""
    Walk up from cwd looking for a project marker.

    A directory that looks like a container of repos (see ``_is_repo_container``)
    is skipped even if it carries a marker, so a stray ``.git`` at a parent of
    many checkouts cannot swallow them all into one project.

    Returns None if none found (e.g., user is in C:\Projects\ with 100 sibling dirs).
    """
    p = canonicalize(Path(cwd))
    for current in (p, *p.parents):
        for marker in PROJECT_MARKERS:
            if _marker_exists(current, marker):
                if _is_repo_container(current):
                    break  # not a project — keep walking up
                return Project(root=current, hash=project_hash(current), marker=marker)
    return None
