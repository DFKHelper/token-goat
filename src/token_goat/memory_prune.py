"""Automatic pruning and analysis of Claude Code's native auto-memory store.

The auto-memory store lives at ``~/.claude/projects/<slug>/memory/``.  It uses
a lazy-index pattern: ``MEMORY.md`` is a short one-line-per-entry index; each
fact lives in a sibling ``*.md`` file (YAML frontmatter + body).  Claude Code
injects ``MEMORY.md`` at every session start, so its size directly affects
startup context.

**What this module does automatically (safe, structural-only):**
- Remove index lines whose target ``.md`` file is absent (dead links).
- Remove duplicate index lines pointing to the same target file (keep first).

**What it reports but never auto-edits:**
- Near-duplicate sibling bodies (via embedding cosine similarity or Jaccard).
- Exact-duplicate lines / sections inside ``CLAUDE.md`` files.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

# ---------------------------------------------------------------------------
# Index entry parsing
# ---------------------------------------------------------------------------

_ENTRY_RE = re.compile(
    r"^\s*-\s*\[(?P<title>[^\]]+)\]\((?P<target>[^)]+?\.md)\)"
)


@dataclass(frozen=True)
class IndexEntry:
    """One parsed line from MEMORY.md."""

    raw: str
    title: str
    target: str  # filename only, e.g. ``feedback_testing.md``
    lineno: int  # 0-based


def parse_index(text: str) -> tuple[list[tuple[int, str]], list[IndexEntry]]:
    """Parse MEMORY.md text into passthrough lines and entries.

    Returns ``(passthrough, entries)`` where *passthrough* is a list of
    ``(lineno, raw_line)`` tuples for lines that are NOT index entries
    (headers, blank lines, freeform notes).  These are preserved verbatim.
    """
    passthrough: list[tuple[int, str]] = []
    entries: list[IndexEntry] = []
    for lineno, line in enumerate(text.splitlines(keepends=True)):
        m = _ENTRY_RE.match(line)
        if m:
            entries.append(
                IndexEntry(
                    raw=line,
                    title=m.group("title"),
                    target=m.group("target"),
                    lineno=lineno,
                )
            )
        else:
            passthrough.append((lineno, line))
    return passthrough, entries


# ---------------------------------------------------------------------------
# Safe structural pruning
# ---------------------------------------------------------------------------


@dataclass
class PruneResult:
    """Result of a :func:`prune_index` call."""

    removed_dead: list[IndexEntry] = field(default_factory=list)
    removed_dup: list[IndexEntry] = field(default_factory=list)
    kept: int = 0
    changed: bool = False
    tokens_saved: int = 0  # estimate_tokens over removed raw lines


def prune_index(memory_dir: Path, *, dry_run: bool = False) -> PruneResult:
    """Read MEMORY.md, drop dead-link and exact-dup-target entries, rewrite atomically.

    *memory_dir* is the directory containing MEMORY.md and its siblings.
    When *dry_run* is True the file is never written; the returned result still
    reflects what *would* have been removed.

    Returns ``PruneResult(changed=False)`` when the file is absent, unreadable,
    or already clean.  Never raises — caller decides on logging.
    """
    from .compact import estimate_tokens  # noqa: PLC0415

    result = PruneResult()
    memory_md = memory_dir / "MEMORY.md"

    try:
        text = memory_md.read_text(encoding="utf-8")
    except OSError:
        return result

    passthrough, entries = parse_index(text)

    seen_targets: set[str] = set()
    keep: list[IndexEntry] = []
    dead: list[IndexEntry] = []
    dups: list[IndexEntry] = []

    for entry in entries:
        target_path = memory_dir / entry.target
        if not target_path.exists():
            dead.append(entry)
        elif entry.target in seen_targets:
            dups.append(entry)
        else:
            seen_targets.add(entry.target)
            keep.append(entry)

    result.removed_dead = dead
    result.removed_dup = dups
    result.kept = len(keep)
    result.changed = bool(dead or dups)
    result.tokens_saved = estimate_tokens(
        "".join(e.raw for e in dead) + "".join(e.raw for e in dups)
    )

    if not result.changed or dry_run:
        return result

    # Reconstruct in original line order by merging passthrough + kept entries via a lineno map.
    line_map: dict[int, str] = {lineno: raw for lineno, raw in passthrough}
    line_map.update({entry.lineno: entry.raw for entry in keep})

    # Sort by original line number and join.
    reconstructed = "".join(line_map[k] for k in sorted(line_map))

    # Ensure trailing newline.
    if reconstructed and not reconstructed.endswith("\n"):
        reconstructed += "\n"

    try:
        from . import paths  # noqa: PLC0415

        paths.atomic_write_text(memory_md, reconstructed)
    except Exception:  # noqa: BLE001
        result.changed = False  # write failed; report as no-op

    return result


# ---------------------------------------------------------------------------
# Near-duplicate detection in sibling files (report-only)
# ---------------------------------------------------------------------------


@dataclass
class DupCluster:
    """A group of memory files with highly similar content."""

    members: list[Path]
    similarity: float
    method: str  # "embedding" | "jaccard"
    tokens: int  # combined token cost of all members


def _jaccard(a: str, b: str) -> float:
    """Token-set Jaccard similarity (whitespace-tokenised, lowercased)."""
    ta = set(a.lower().split())
    tb = set(b.lower().split())
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _sibling_snippet(path: Path) -> str:
    """Return description + first ~500 body chars for similarity comparison."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    # Strip YAML frontmatter (--- ... ---) to get the body.
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            body = text[end + 4 :].lstrip()
            # Also extract description from frontmatter.
            fm = text[3:end]
            desc = ""
            for line in fm.splitlines():
                if line.startswith("description:"):
                    desc = line[12:].strip().strip('"')
                    break
            return (desc + " " + body[:500]).strip()
        return text[:500]
    return text[:500]


def find_content_duplicates(
    memory_dir: Path, *, threshold: float = 0.92
) -> list[DupCluster]:
    """Return clusters of sibling memory files with similar content.

    Uses embedding cosine similarity when fastembed is available; falls back to
    Jaccard >= 0.60 (cruder, flag-only).  Pure: never mutates any file.
    """
    from .compact import estimate_tokens  # noqa: PLC0415

    siblings = sorted(
        p for p in memory_dir.glob("*.md") if p.name.lower() != "memory.md"
    )
    if len(siblings) < 2:
        return []

    snippets = [_sibling_snippet(p) for p in siblings]

    # --- Embedding path ---
    try:
        from . import embeddings  # noqa: PLC0415

        if embeddings.is_available():
            vecs = embeddings.embed_texts(snippets)
            import math  # noqa: PLC0415

            def _cosine(a: list[float], b: list[float]) -> float:
                dot = sum(x * y for x, y in zip(a, b, strict=False))
                na = math.sqrt(sum(x * x for x in a))
                nb = math.sqrt(sum(x * x for x in b))
                if na == 0 or nb == 0:
                    return 0.0
                return dot / (na * nb)

            clusters: list[DupCluster] = []
            used: set[int] = set()
            for i in range(len(siblings)):
                if i in used:
                    continue
                group = [i]
                for j in range(i + 1, len(siblings)):
                    if j in used:
                        continue
                    sim = _cosine(vecs[i], vecs[j])
                    if sim >= threshold:
                        group.append(j)
                if len(group) > 1:
                    members = [siblings[k] for k in group]
                    tok = sum(estimate_tokens(snippets[k]) for k in group)
                    max_sim = max(
                        _cosine(vecs[group[a]], vecs[group[b]])
                        for a in range(len(group))
                        for b in range(a + 1, len(group))
                    )
                    clusters.append(
                        DupCluster(
                            members=members,
                            similarity=round(max_sim, 3),
                            method="embedding",
                            tokens=tok,
                        )
                    )
                    used.update(group)
            return clusters
    except Exception:  # noqa: BLE001
        pass

    # --- Jaccard fallback ---
    _JACCARD_THRESHOLD = 0.60
    clusters = []
    used = set()
    for i in range(len(siblings)):
        if i in used:
            continue
        group = [i]
        for j in range(i + 1, len(siblings)):
            if j in used:
                continue
            sim = _jaccard(snippets[i], snippets[j])
            if sim >= _JACCARD_THRESHOLD:
                group.append(j)
        if len(group) > 1:
            members = [siblings[k] for k in group]
            tok = sum(estimate_tokens(snippets[k]) for k in group)
            max_sim = max(
                _jaccard(snippets[group[a]], snippets[group[b]])
                for a in range(len(group))
                for b in range(a + 1, len(group))
            )
            clusters.append(
                DupCluster(
                    members=members,
                    similarity=round(max_sim, 3),
                    method="jaccard",
                    tokens=tok,
                )
            )
            used.update(group)
    return clusters


# ---------------------------------------------------------------------------
# CLAUDE.md audit (report-only — never edits)
# ---------------------------------------------------------------------------


@dataclass
class ClaudeMdReport:
    """Audit findings for a single CLAUDE.md file."""

    path: Path
    tokens: int
    exact_dup_lines: list[tuple[int, int, str]]  # (first_ln, dup_ln, stripped_text)
    dup_sections: list[tuple[str, list[int]]]  # (heading, [linenos])
    cross_file_overlaps: list[str]  # overlap descriptions vs. other files


def audit_claude_md(files: list[Path]) -> list[ClaudeMdReport]:
    """Return duplicate-line and duplicate-section findings across CLAUDE.md files.

    Report-only: never edits any file.
    """
    from .compact import estimate_tokens  # noqa: PLC0415

    reports: list[ClaudeMdReport] = []
    all_lines: list[tuple[Path, int, str]] = []  # (path, lineno, stripped)

    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        lines = text.splitlines()
        tokens = estimate_tokens(text)
        exact_dups: list[tuple[int, int, str]] = []
        dup_sections: list[tuple[str, list[int]]] = []

        # Exact duplicate non-blank lines within this file.
        seen_lines: dict[str, int] = {}
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if stripped in seen_lines:
                exact_dups.append((seen_lines[stripped], i, stripped))
            else:
                seen_lines[stripped] = i

        # Duplicate headings (## / ###).
        seen_headings: dict[str, list[int]] = {}
        for i, line in enumerate(lines):
            if line.startswith("##"):
                heading = line.strip()
                seen_headings.setdefault(heading, []).append(i)
        dup_sections.extend((heading, lnos) for heading, lnos in seen_headings.items() if len(lnos) > 1)

        reports.append(
            ClaudeMdReport(
                path=path,
                tokens=tokens,
                exact_dup_lines=exact_dups,
                dup_sections=dup_sections,
                cross_file_overlaps=[],  # filled below
            )
        )

        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped:
                all_lines.append((path, i, stripped))

    # Cross-file overlaps: non-blank lines that appear verbatim in >1 file.
    from collections import defaultdict  # noqa: PLC0415

    line_to_files: dict[str, set[Path]] = defaultdict(set)
    for path, _i, stripped in all_lines:
        line_to_files[stripped].add(path)

    for report in reports:
        overlaps: list[str] = []
        for stripped, paths_set in line_to_files.items():
            if report.path in paths_set and len(paths_set) > 1:
                others = [str(p.name) for p in paths_set if p != report.path]
                if others:
                    overlaps.append(
                        f"{stripped[:60]!r}… also in {', '.join(others)}"
                        if len(stripped) > 60
                        else f"{stripped!r} also in {', '.join(others)}"
                    )
        report.cross_file_overlaps = overlaps[:10]  # cap to avoid noise

    return reports
