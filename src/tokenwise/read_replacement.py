"""Read-replacement: return just a symbol's source instead of the whole file."""
from __future__ import annotations

import logging
from pathlib import Path

from . import db
from .project import Project

_LOG = logging.getLogger("tokenwise.read_replacement")

# Lower value = higher priority when multiple symbols share the same name
_KIND_PRIORITY: dict[str, int] = {
    "class": 0,
    "interface": 1,
    "trait": 1,
    "type": 2,
    "enum": 2,
    "function": 3,
    "method": 4,
    "const": 5,
    "var": 6,
    "heading": 2,
}


def _is_safe_rel_path(rel_path: str) -> bool:
    """Validate that rel_path cannot escape project root via path traversal."""
    # Reject absolute paths and parent directory references
    if rel_path.startswith("/") or rel_path.startswith("\\"):
        return False
    # Reject parent directory traversal
    if ".." in rel_path.split("/") or ".." in rel_path.split("\\"):
        return False
    return True


def resolve_file_rel(project: Project, file_part: str) -> str | None:
    """Given the file part from a 'file::symbol' target, find the matching rel_path.

    Accepts:
    - Full relative path  (e.g., 'src/tokenwise/parser.py')
    - Bare filename       (e.g., 'parser.py' — picks best match)
    - Partial path        (e.g., 'tokenwise/parser.py' — endswith match)
    - Absolute path       (resolved against project root)
    """
    file_part = file_part.replace("\\", "/").strip()

    with db.open_project(project.hash) as conn:
        # 1. Exact relative match
        row = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path = ?", (file_part,)
        ).fetchone()
        if row:
            return row["rel_path"]

        # 2. Absolute path — make it relative to project root
        p = Path(file_part)
        if p.is_absolute():
            try:
                rel = p.resolve().relative_to(project.root.resolve()).as_posix()
                row = conn.execute(
                    "SELECT rel_path FROM files WHERE rel_path = ?", (rel,)
                ).fetchone()
                if row:
                    return row["rel_path"]
            except (ValueError, OSError):
                pass

        # 3. Endswith match — handles bare filename or partial path
        rows = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path LIKE ?",
            (f"%{file_part}",),
        ).fetchall()
        if len(rows) == 1:
            return rows[0]["rel_path"]
        if len(rows) > 1:
            # Prefer the shortest path (most specific match without extra nesting)
            return min((r["rel_path"] for r in rows), key=len)

    return None


def read_symbol(
    project: Project,
    rel_path: str,
    symbol: str,
    *,
    context_lines: int = 0,
) -> dict | None:
    """Look up symbol in DB, slice the file, return extraction dict.

    Returns a dict with keys:
        file, symbol, kind, start_line, end_line, text,
        signature, bytes_total, bytes_extracted, bytes_saved
    Returns None if the symbol is not found or the file cannot be read.
    """
    # Prevent path traversal attacks
    if not _is_safe_rel_path(rel_path):
        _LOG.warning("rejected unsafe rel_path: %s", rel_path)
        return None

    with db.open_project(project.hash) as conn:
        rows = conn.execute(
            "SELECT name, kind, line, end_line, signature FROM symbols "
            "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL ORDER BY line",
            (rel_path, symbol),
        ).fetchall()
        if not rows:
            return None

    # If multiple matches (e.g., a top-level function and a method of the same name),
    # prefer by kind priority then by earliest line.
    chosen = min(rows, key=lambda r: (_KIND_PRIORITY.get(r["kind"], 9), r["line"]))

    abs_path = project.root / rel_path
    try:
        full_text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        _LOG.warning("read failed: %s: %s", abs_path, e)
        return None

    lines = full_text.splitlines()
    if not lines:
        return None

    start = max(1, chosen["line"] - context_lines)
    end = min(len(lines), chosen["end_line"] + context_lines)
    snippet = "\n".join(lines[start - 1 : end])

    full_bytes = len(full_text.encode("utf-8"))
    snippet_bytes = len(snippet.encode("utf-8"))

    return {
        "file": rel_path,
        "symbol": chosen["name"],
        "kind": chosen["kind"],
        "start_line": start,
        "end_line": end,
        "text": snippet,
        "signature": chosen["signature"],
        "bytes_total": full_bytes,
        "bytes_extracted": snippet_bytes,
        "bytes_saved": max(0, full_bytes - snippet_bytes),
    }


def read_section(
    project: Project,
    rel_path: str,
    heading: str,
    *,
    context_lines: int = 0,
) -> dict | None:
    """Same as read_symbol but for markdown/HTML/Liquid section headings.

    Returns a dict with keys:
        file, heading, level, start_line, end_line, text,
        bytes_total, bytes_extracted, bytes_saved
    Returns None if the heading is not found or the file cannot be read.
    """
    # Prevent path traversal attacks
    if not _is_safe_rel_path(rel_path):
        _LOG.warning("rejected unsafe rel_path: %s", rel_path)
        return None

    with db.open_project(project.hash) as conn:
        rows = conn.execute(
            "SELECT heading, level, line, end_line FROM sections "
            "WHERE file_rel = ? AND heading = ? AND end_line IS NOT NULL ORDER BY line",
            (rel_path, heading),
        ).fetchall()
        if not rows:
            # Fallback: case-insensitive match
            rows = conn.execute(
                "SELECT heading, level, line, end_line FROM sections "
                "WHERE file_rel = ? AND lower(heading) = lower(?) AND end_line IS NOT NULL ORDER BY line",
                (rel_path, heading),
            ).fetchall()
            if not rows:
                return None

    chosen = rows[0]  # first match by line order

    abs_path = project.root / rel_path
    try:
        full_text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        _LOG.warning("read failed: %s: %s", abs_path, e)
        return None

    lines = full_text.splitlines()
    start = max(1, chosen["line"] - context_lines)
    end = min(len(lines), chosen["end_line"] + context_lines)
    snippet = "\n".join(lines[start - 1 : end])

    full_bytes = len(full_text.encode("utf-8"))
    snippet_bytes = len(snippet.encode("utf-8"))

    return {
        "file": rel_path,
        "heading": chosen["heading"],
        "level": chosen["level"],
        "start_line": start,
        "end_line": end,
        "text": snippet,
        "bytes_total": full_bytes,
        "bytes_extracted": snippet_bytes,
        "bytes_saved": max(0, full_bytes - snippet_bytes),
    }
