"""Stable-doc compact serving for large reference docs.

A compact is a user-created or auto-extractive summary of a large reference doc,
stored as a sidecar file in the token-goat data dir.  When pre_read detects that
a compact exists and is fresh (source hash matches), it serves the compact instead
of the full file, saving 80-95% of context tokens on the first read of each new
session.

Compact lifecycle:
  create:     token-goat compact-doc <path>  (extractive, deterministic)
  serve:      pre_read hook injects compact text + section map + escape instruction
  invalidate: worker/skill_cache marks compact stale when source file is edited

Sidecar layout:
  <data_dir>/doc_compacts/<project_hash>/<slug>.compact.md
  slug = sha256(abs_path_lower)[:12] + "_" + stem_slug[:32]

Compact file format:
  Line 1: <!-- token-goat doc-compact source-hash:<sha256> source:<rel_path> -->
  Line 2+: compact body (markdown)

Staleness: when the source file is edited the worker calls mark_compact_stale(),
  which replaces the sha256 with "STALE" so the next pre_read emits a warning
  hint instead of serving the (now-wrong) compact.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .util import get_logger

_LOG = get_logger("doc_compact")

# Maximum heading preview items in section-map hints.
_SECTION_MAP_MAX = 10

# Extractive compact: sentences collected per section heading.
_DEFAULT_SENTENCES_PER_SECTION = 2

# Header line format (must fit on one line).
_HEADER_PREFIX = "<!-- token-goat doc-compact source-hash:"
_HEADER_RE = re.compile(
    r"^<!-- token-goat doc-compact source-hash:(\S+) source:(.+?) -->$"
)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def _doc_compacts_dir(project_hash: str) -> Path:
    from . import paths
    return paths.data_dir() / "doc_compacts" / project_hash


def _compact_slug(abs_path_str: str) -> str:
    """Deterministic filename component: hash prefix + stem slug."""
    h = hashlib.sha256(abs_path_str.lower().encode()).hexdigest()[:12]
    stem = Path(abs_path_str).stem
    safe_stem = re.sub(r"[^a-zA-Z0-9_-]", "_", stem)[:32].strip("_")
    return f"{h}_{safe_stem}"


def compact_path_for(file_path: str | Path, project_hash: str) -> Path:
    """Return the sidecar compact path for *file_path* within *project_hash*."""
    abs_str = str(Path(file_path).resolve())
    return _doc_compacts_dir(project_hash) / (_compact_slug(abs_str) + ".compact.md")


def find_compact_for_path(file_path: str | Path, project_hash: str) -> Path | None:
    """Return the compact path if it exists on disk, else None."""
    p = compact_path_for(file_path, project_hash)
    return p if p.exists() else None


# ---------------------------------------------------------------------------
# Header / freshness
# ---------------------------------------------------------------------------


def _source_sha256(source_path: Path) -> str:
    """SHA-256 of source file content."""
    try:
        data = source_path.read_bytes()
        return hashlib.sha256(data).hexdigest()
    except OSError:
        return ""


def read_compact_header(compact_path: Path) -> tuple[str, str] | None:
    """Parse the first line of a compact file.

    Returns (source_hash, source_rel) or None if the header is missing/invalid.
    """
    try:
        with compact_path.open(encoding="utf-8", errors="replace") as fh:
            first_line = fh.readline().rstrip("\n\r")
    except OSError:
        return None
    m = _HEADER_RE.match(first_line)
    if not m:
        return None
    return m.group(1), m.group(2)


def is_compact_fresh(compact_path: Path, source_path: Path) -> bool:
    """Return True if the compact's source hash matches the current source file."""
    header = read_compact_header(compact_path)
    if header is None:
        return False
    stored_hash, _ = header
    if stored_hash == "STALE":
        return False
    current_hash = _source_sha256(source_path)
    return bool(current_hash) and current_hash == stored_hash


def mark_compact_stale(compact_path: Path) -> bool:
    """Replace the source-hash in the header with 'STALE'.

    Called by the worker after the source file is edited.  Fails silently
    (returns False) if the compact does not exist or cannot be rewritten.
    """
    if not compact_path.exists():
        return False
    try:
        text = compact_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    lines = text.splitlines(keepends=True)
    if not lines:
        return False
    m = _HEADER_RE.match(lines[0].rstrip("\n\r"))
    if not m or m.group(1) == "STALE":
        return False  # already stale or wrong format
    old_hash = m.group(1)
    lines[0] = lines[0].replace(f"source-hash:{old_hash}", "source-hash:STALE", 1)
    try:
        from . import paths
        paths.atomic_write_text(compact_path, "".join(lines))
        _LOG.debug("doc_compact.mark_compact_stale: marked stale %s", compact_path.name)
    except OSError as exc:
        _LOG.debug("doc_compact.mark_compact_stale: write failed for %s: %s", compact_path.name, exc)
        return False
    else:
        return True


# ---------------------------------------------------------------------------
# Read / write compact body
# ---------------------------------------------------------------------------


def read_compact_body(compact_path: Path) -> str | None:
    """Read the compact body (everything after the header line).

    Returns None if the file cannot be read or has no body.
    """
    try:
        text = compact_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    lines = text.splitlines(keepends=True)
    if len(lines) < 2:
        return None
    body = "".join(lines[1:]).lstrip("\n")
    return body if body.strip() else None


def write_compact(
    compact_path: Path,
    source_path: str | Path,
    compact_body: str,
    *,
    source_rel: str = "",
) -> None:
    """Write a compact sidecar file with the correct header.

    Args:
        compact_path: Destination path (parent dir must exist or will be created).
        source_path:  Absolute path to the source document (used for hash).
        compact_body: Markdown compact text (no header line).
        source_rel:   Optional relative path for display in the header.
    """
    from . import paths

    src = Path(source_path)
    sha = _source_sha256(src)
    display_rel = source_rel or src.name
    header = f"{_HEADER_PREFIX}{sha} source:{display_rel} -->\n"
    full_text = header + compact_body.lstrip("\n")
    paths.ensure_dir(compact_path.parent)
    paths.atomic_write_text(compact_path, full_text)
    _LOG.debug("doc_compact.write_compact: wrote %d chars to %s", len(full_text), compact_path.name)


# ---------------------------------------------------------------------------
# Extractive compact builder
# ---------------------------------------------------------------------------


def build_extractive_compact(
    text: str,
    *,
    max_sentences: int = _DEFAULT_SENTENCES_PER_SECTION,
) -> str:
    """Build a compact from markdown text: headings + first N sentences per section.

    Algorithm:
      - Emit every ATX heading verbatim (# / ## / ### etc.).
      - After each heading, collect the first `max_sentences` non-empty
        non-heading lines that form "sentences" (ending with punctuation or
        being code fences).
      - Code blocks (``` fences) are included verbatim up to 10 lines.
      - Front-matter (--- fences at top) is skipped.

    This is intentionally simple and deterministic — no NLP, no LLM.
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)

    # Skip YAML front-matter
    if lines and lines[0].strip() == "---":
        i = 1
        while i < n and lines[i].strip() != "---":
            i += 1
        i += 1  # skip closing ---

    in_code_block = False
    code_block_lines = 0
    current_heading: str | None = None
    sentences_emitted = 0

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Track fenced code blocks
        if stripped.startswith(("```", "~~~")):
            if not in_code_block:
                in_code_block = True
                code_block_lines = 0
                if current_heading is not None and sentences_emitted < max_sentences:
                    out.append(line)
                    code_block_lines += 1
            else:
                in_code_block = False
                if current_heading is not None and sentences_emitted < max_sentences:
                    out.append(line)
                    sentences_emitted += 1
            i += 1
            continue

        if in_code_block:
            if code_block_lines < 10 and current_heading is not None and sentences_emitted < max_sentences:
                out.append(line)
                code_block_lines += 1
            i += 1
            continue

        # ATX heading
        heading_match = re.match(r"^(#{1,6})\s+(.*)", stripped)
        if heading_match:
            current_heading = stripped
            sentences_emitted = 0
            out.append("")
            out.append(line)
            i += 1
            continue

        # Collect content lines after a heading
        if current_heading is not None and sentences_emitted < max_sentences and stripped:
            out.append(line)
            sentences_emitted += 1
        i += 1

    # Clean up: deduplicate blank lines, strip trailing whitespace
    result_lines: list[str] = []
    prev_blank = False
    for ln in out:
        is_blank = not ln.strip()
        if is_blank and prev_blank:
            continue
        result_lines.append(ln)
        prev_blank = is_blank

    return "\n".join(result_lines).strip() + "\n"


# ---------------------------------------------------------------------------
# Section map query (for hints)
# ---------------------------------------------------------------------------


def get_section_headings(rel_path: str, project_hash: str, *, limit: int = 20) -> list[str]:
    """Query the DB for section headings in a markdown file.

    Returns heading strings in line order.  Returns [] on any error.
    """
    try:
        from . import db
        with db.open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT heading FROM sections WHERE file_rel = ? AND end_line IS NOT NULL ORDER BY line LIMIT ?",
                (rel_path, limit),
            ).fetchall()
        return [r["heading"] for r in rows]
    except Exception as exc:
        _LOG.debug("doc_compact.get_section_headings: DB error for %s: %s", rel_path, exc)
        return []
