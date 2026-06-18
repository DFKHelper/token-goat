"""Project marker detection + path canonicalization."""
from __future__ import annotations

__all__ = [
    "PROJECT_MARKERS",
    "Project",
    "canonicalize",
    "find_project",
    "make_project_at",
    "project_hash",
]

import hashlib
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .hooks_common import sanitize_log_str
from .util import get_logger

# Cross-shell Windows-drive prefixes that resolve to the same NTFS location.
#
# When a project at ``C:\Projects\foo`` is accessed from different shells, the
# *literal* path string varies even though the underlying directory is one and
# the same:
#
#   * cmd.exe / PowerShell: ``C:\Projects\foo``         (native, backslash)
#   * Git Bash (MSYS):      ``/c/Projects/foo``         (drive as top-level)
#   * Cygwin:               ``/cygdrive/c/Projects/foo``
#   * WSL / Linux mount:    ``/mnt/c/Projects/foo``
#
# Without normalisation, ``project_hash`` would return four different SHA1
# digests for the same directory, causing the index, session cache, and stats
# to fragment across shells.  The regexes below convert each MSYS / WSL /
# Cygwin form to the canonical ``c:/<rest>`` form *before* hashing, so the
# resulting hash is shell-independent.
#
# A real Linux user with a literal top-level ``/c/`` directory would collide
# with the Git Bash MSYS interpretation; ``/c/`` collisions are vanishingly
# rare in practice and the cost of getting one is a shared hash, which the
# user can resolve by renaming the directory.
_WSL_PREFIX_RE = re.compile(r"^/mnt/([a-zA-Z])/(.*)$")
_CYGWIN_PREFIX_RE = re.compile(r"^/cygdrive/([a-zA-Z])/(.*)$")
_MSYS_PREFIX_RE = re.compile(r"^/([a-zA-Z])/(.*)$")


def _normalize_shell_drive_prefix(posix_str: str) -> str:
    """Map WSL / Cygwin / MSYS Windows-drive prefixes to canonical ``c:/`` form.

    Called from :func:`canonicalize` after ``.resolve()`` + ``.as_posix()``.
    Strictly a string transform — it does not touch the filesystem and never
    raises.  Unrecognised paths (e.g. ``/usr/local/bin``, ``/home/user/foo``)
    are returned unchanged.
    """
    m = _WSL_PREFIX_RE.match(posix_str)
    if m:
        return f"{m.group(1).lower()}:/{m.group(2)}"
    m = _CYGWIN_PREFIX_RE.match(posix_str)
    if m:
        return f"{m.group(1).lower()}:/{m.group(2)}"
    m = _MSYS_PREFIX_RE.match(posix_str)
    if m:
        return f"{m.group(1).lower()}:/{m.group(2)}"
    return posix_str

_LOG = get_logger("project")

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
    """Resolve symlinks, normalize, lowercase the Windows drive letter.

    Returns a path string that is identical regardless of which shell or
    operating-system view accessed the same underlying directory:

    * ``C:\\Projects\\foo`` (cmd.exe, PowerShell)
    * ``c:\\Projects\\foo`` (lowercased drive letter)
    * ``C:/Projects/foo``   (forward slashes on Windows)
    * ``/c/Projects/foo``   (Git Bash MSYS)
    * ``/cygdrive/c/Projects/foo`` (Cygwin)
    * ``/mnt/c/Projects/foo`` (WSL / Linux mount)

    All six canonicalize to ``Path("c:/Projects/foo")`` so that
    :func:`project_hash` produces a single, stable SHA1 across shells.  Without
    this step, switching from PowerShell to Git Bash to WSL on the same project
    would fragment the index, session cache, and stats across three different
    project hashes.

    Symlinks are resolved via ``Path.resolve()`` — two paths that point at the
    same target via different symlink chains still hash identically.
    """
    # Pre-resolve normalisation: if the input is a raw MSYS / WSL / Cygwin
    # string like ``/c/Projects/foo``, ``Path.resolve()`` on Windows would
    # misinterpret it as a relative-to-current-drive path (e.g.
    # ``C:\c\Projects\foo``) instead of the intended ``C:\Projects\foo``.
    # Convert the prefix *before* resolve to avoid that misinterpretation.
    pre = _normalize_shell_drive_prefix(str(path).replace("\\", "/"))
    if pre != str(path).replace("\\", "/"):
        path = Path(pre)
    resolved = path.resolve()
    s = resolved.as_posix()
    # Map WSL / Cygwin / MSYS drive prefixes to canonical ``c:/`` form, so the
    # drive-letter lowercase step below sees the same shape regardless of
    # which shell originated the path. (Resolve under WSL keeps ``/mnt/c/...``
    # as-is, so this is where WSL paths get normalised.)
    s = _normalize_shell_drive_prefix(s)
    # Lowercase drive letter on Windows (e.g. "C:/foo" → "c:/foo")
    if len(s) >= 2 and s[1] == ":":
        s = s[0].lower() + s[1:]
    return Path(s)


def project_hash(canonical_root: Path) -> str:
    """Return sha1 hash of canonical posix path.

    Must always receive the output of ``canonicalize()`` — never a raw
    Path.cwd() or user-supplied path — so that the hash is stable across
    drive-letter case variation, symlinks, and relative vs. absolute forms.
    """
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
    try:
        canonical = canonicalize(root)
    except OSError as exc:
        raise ValueError(f"make_project_at: could not resolve path {root!r}: {exc}") from exc
    if not canonical.is_dir():
        raise ValueError(f"make_project_at: path is not a directory: {canonical}")
    ph = project_hash(canonical)
    _LOG.debug(
        "make_project_at: created manual project (root=%s hash=%s)",
        sanitize_log_str(canonical.as_posix()),
        ph[:8],
    )
    return Project(root=canonical, hash=ph, marker="manual")


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
                        _LOG.debug("repo container detected: %s (>=%d nested .git dirs)", path, _REPO_CONTAINER_THRESHOLD)
                        return True
    except OSError as exc:
        _LOG.debug("_is_repo_container: scandir failed for %s: %s", path, exc)
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
        if not marker_path.is_symlink():
            return True
        # Symlink: verify the resolved target stays inside the candidate root.
        resolved = marker_path.resolve()
        resolved.relative_to(current.resolve())  # raises ValueError if it escapes
        return True
    except (OSError, ValueError):
        return False


def find_project(cwd: Path | str) -> Project | None:
    r"""
    Walk up from cwd looking for a project marker.

    A directory that looks like a container of repos (see ``_is_repo_container``)
    is skipped even if it carries a marker, so a stray ``.git`` at a parent of
    many checkouts cannot swallow them all into one project.

    Returns None if none found (e.g., user is in C:\Projects\ with 100 sibling dirs).

    The walk stops at the system temp directory (``tempfile.gettempdir()``).  A
    stray project-marker file landing in ``%TEMP%`` or ``/tmp`` — e.g. from a
    package manager that runs an install step there — must not be treated as a
    real project root.
    """
    t0 = time.monotonic()
    try:
        p = canonicalize(Path(cwd))
    except (OSError, ValueError) as exc:
        _LOG.debug("find_project: could not canonicalize cwd %r: %s", cwd, exc)
        return None
    try:
        _sys_temp: Path | None = canonicalize(Path(tempfile.gettempdir()))
    except (OSError, ValueError):
        _sys_temp = None
    levels_walked = 0
    for current in (p, *p.parents):
        if _sys_temp is not None and current == _sys_temp:
            _LOG.debug("find_project: stopping walk at system temp dir %s", current)
            break
        for marker in PROJECT_MARKERS:
            if _marker_exists(current, marker):
                if _is_repo_container(current):
                    _LOG.debug("find_project: skipping container at %s (marker=%s)", current, marker)
                    break  # not a project — keep walking up
                elapsed = time.monotonic() - t0
                _LOG.debug(
                    "find_project: found %s (marker=%s, levels_walked=%d, %.3fs)",
                    current, marker, levels_walked, elapsed,
                )
                return Project(root=current, hash=project_hash(current), marker=marker)
        levels_walked += 1
    elapsed = time.monotonic() - t0
    _LOG.debug("find_project: no project found from %s (levels_walked=%d, %.3fs)", p, levels_walked, elapsed)
    return None
