"""Scan indexed project files for TODO/FIXME/HACK/XXX/NOTE markers."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Match markers only after a comment delimiter (#, //, --, or *).
# This avoids false positives from string literals, regex patterns, and help text
# that happen to contain the marker words.
_MARKER_RE = re.compile(
    r"(?:#|//|--|(?<!\w)\*)\s*(TODO|FIXME|HACK|XXX|NOTE)\b[:\s]*(.*?)$",
    re.IGNORECASE,
)


@dataclass
class TodoItem:
    file_rel: str
    line: int
    kind: str
    text: str


def find_todos(
    project_hash: str,
    project_root: Path,
    *,
    kinds: frozenset[str] | None = None,
) -> list[TodoItem]:
    """Return all TODO-family markers found in indexed project files.

    Reads indexed file paths from the DB, then scans each file on disk.
    ``kinds`` filters to a subset of markers, e.g. ``frozenset({"TODO", "FIXME"})``.
    When ``None``, all five are returned.
    """
    from . import db

    _kinds = kinds or frozenset({"TODO", "FIXME", "HACK", "XXX", "NOTE"})
    upper_kinds = frozenset(k.upper() for k in _kinds)

    try:
        with db.open_project_readonly(project_hash) as conn:
            rows = conn.execute("SELECT rel_path FROM files ORDER BY rel_path").fetchall()
    except Exception as e:
        logger.warning("failed to read indexed files for TODOs: %s", e)
        return []

    items: list[TodoItem] = []
    for (rel_path,) in rows:
        full_path = project_root / rel_path
        try:
            content = full_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        for lineno, raw_line in enumerate(content.splitlines(), start=1):
            m = _MARKER_RE.search(raw_line)
            if m is None:
                continue
            kind = m.group(1).upper()
            if kind not in upper_kinds:
                continue
            comment = m.group(2).strip()
            items.append(TodoItem(file_rel=rel_path, line=lineno, kind=kind, text=comment))

    return items


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


def format_todos_text(items: list[TodoItem], *, group_by: str = "file") -> str:
    if not items:
        return "No markers found."

    lines: list[str] = []

    if group_by == "kind":
        by_kind: dict[str, list[TodoItem]] = {}
        for item in items:
            by_kind.setdefault(item.kind, []).append(item)

        _ORDER = ("TODO", "FIXME", "HACK", "XXX", "NOTE")
        _rank = {k: i for i, k in enumerate(_ORDER)}
        for kind in sorted(by_kind, key=lambda k: (_rank.get(k, len(_ORDER)), k)):
            group = by_kind[kind]
            lines.append(f"{kind} ({len(group)})")
            col = max(len(f"{it.file_rel}:{it.line}") for it in group)
            for it in group:
                loc = f"{it.file_rel}:{it.line}"
                lines.append(f"  {loc:<{col}}  {it.text}")
            lines.append("")
    else:
        # Group by file (default)
        from itertools import groupby

        sorted_items = sorted(items, key=lambda x: (x.file_rel, x.line))
        for file_rel, group_iter in groupby(sorted_items, key=lambda x: x.file_rel):
            group = list(group_iter)
            lines.append(f"{file_rel}")
            for it in group:
                marker = f"[{it.kind}]"
                lines.append(f"  {it.line:>5}  {marker:<8}  {it.text}")
            lines.append("")

    total = len(items)
    noun = "item" if total == 1 else "items"
    file_count = len({it.file_rel for it in items})
    fnoun = "file" if file_count == 1 else "files"
    lines.append(f"{total} {noun} across {file_count} {fnoun}")
    return "\n".join(lines)


def format_todos_json(items: list[TodoItem]) -> str:
    import json

    return json.dumps(
        [{"file": it.file_rel, "line": it.line, "kind": it.kind, "text": it.text} for it in items],
        indent=2,
    )
