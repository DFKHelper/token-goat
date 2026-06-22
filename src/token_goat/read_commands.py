"""Command helpers for the read/section/deps CLI path."""
from __future__ import annotations

import contextlib
import difflib
import hashlib
import json
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict, deque
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple, TypedDict, cast

import typer

from . import db, hints, overflow_guard, read_replacement, session
from .project import Project, find_project
from .util import get_logger, json_compact

_LOG = get_logger("read_commands")

#: Optional ``--session-id`` / ``-s`` Typer option — mirrors the definition in
#: ``cli.py``.  Defined here to avoid a circular import (``cli`` lazily imports
#: ``read_commands``; a top-level ``from .cli import _OPT_SESSION_ID`` would
#: form a cycle at load time).
_OPT_SESSION_ID: str | None = typer.Option(None, "--session-id", "-s")

# Module-level key functions avoid allocating a new lambda object on every sort call.
# Sorting dep maps is on the hot path when rendering large dependency graphs.
def _key_dep_by_size(item: tuple[str, set[str]]) -> tuple[int, str]:
    """Sort dependency items by descending symbol count, then name."""
    return (-len(item[1]), item[0])


def _key_transitive_by_depth(item: tuple[str, _DepNode]) -> tuple[int, str]:
    """Sort transitive dependency items by depth, then name."""
    return (item[1]["depth"], item[0])

# Precise type alias for the ``reader`` parameter of :func:`_run_read_like_command`.
# ``Callable[..., X]`` accepts any argument shape (including keyword-only
# ``context_lines``) while still constraining the return to a known union.
# Both :func:`~read_replacement.read_symbol` (returns ``SymbolResult | None``)
# and :func:`~read_replacement.read_section` (returns ``SectionResult | None``)
# satisfy this alias because their return types are subtypes of the union.
_ReaderCallable = Callable[
    ...,
    read_replacement.SymbolResult | read_replacement.SectionResult | None,
]


class _DepNode(TypedDict):
    """One node in the transitive dependency BFS result.

    Produced by :func:`_collect_transitive_outgoing` and consumed by
    :func:`deps` for both JSON serialisation and text rendering.
    """

    depth: int
    via: str
    symbols: set[str]


def _not_indexed_hint(project_hash: str) -> str | None:
    """Return a one-line hint when this project has no indexed files.

    Distinguishes three cases:
    - Indexing currently in progress: return "indexing in progress" hint.
    - Indexing previously spawned but PID is gone: return "may have failed" hint.
    - Indexing never started: return generic "not yet indexed" hint.
    """
    try:
        if not db.project_has_files(project_hash):
            # Check if an index spawn is currently active.
            from . import paths, worker

            marker = paths.locks_dir() / f"{project_hash}.indexing"
            if worker._index_spawn_active(marker):
                return (
                    "(indexing is currently in progress — try again in a moment, "
                    "or run `token-goat index --full` to force synchronous indexing.)"
                )

            # Check if marker exists but process is gone (may have failed).
            if marker.exists():
                return (
                    "(a previous indexing attempt may have failed — "
                    "run `token-goat index --full` to retry, or check the logs.)"
                )

            # Marker does not exist — auto-index was never spawned or already cleared.
            return (
                "(project not yet indexed. auto-indexing started in the "
                "background on first SessionStart; if it has not finished, "
                "rerun in a moment, or run `token-goat index --full` to force "
                "synchronous indexing.)"
            )
    except (FileNotFoundError, OSError, sqlite3.Error) as exc:
        _LOG.warning("failed to check project index status: %s", exc)
        return (
            "(unable to check whether this project is indexed right now; "
            "run `token-goat index --full` again or check the logs.)"
        )
    return None


# Maximum bytes hashed when computing a file-content SHA for the in-session
# result cache.  Mirrors the 2 MB cap enforced by read_replacement._MAX_READ_BYTES
# so the SHA is computed over exactly the contents that read_symbol/read_section
# would extract from.  A file larger than this is skipped by the readers anyway,
# so we never need to hash beyond the cap.
_SHA_MAX_BYTES = 2_000_000


def _file_sha1(abs_path: Path) -> str:
    """Return the hex SHA-1 of the file's contents, or empty string on any I/O error.

    Used as a cheap invalidation token for the in-session result cache: when
    the SHA differs from the one stored at cache-write time, the cached slice
    is treated as stale and recomputed.  An empty string is returned on
    ``OSError`` so a missing or unreadable file simply skips the cache rather
    than crashing the read path.

    The SHA is computed over up to ``_SHA_MAX_BYTES`` (2 MB) — files larger than
    that are rejected by the readers anyway, so hashing past the cap would
    waste I/O.  SHA-1 is used because we only need collision resistance against
    accidental same-length edits, not cryptographic strength; SHA-1 is roughly
    2× faster than SHA-256 on the typical 5–50 KB source file.
    """
    try:
        with abs_path.open("rb") as fh:
            data = fh.read(_SHA_MAX_BYTES)
    except OSError as exc:
        _LOG.debug("_file_sha1: cannot read %s: %s", abs_path, exc)
        return ""
    return hashlib.sha1(data, usedforsecurity=False).hexdigest()


# Max number of "did you mean…?" suggestions to surface on a missed lookup.
# Capped at 3: a top-3 spelling-similarity list covers the typo case without
# burning ~50-100 tokens of "is it any of these?" noise per miss. Difflib's
# default ceiling is 5, but in practice the 4th and 5th candidates are almost
# always weaker and rarely chosen by the agent.
_DIDYOUMEAN_LIMIT = 3
# difflib similarity cutoff. 0.6 is difflib's default; lowering would surface
# more candidates but also more noise. The aim is to cover near-typos and
# case mismatches, not arbitrary substring containment.
_DIDYOUMEAN_CUTOFF = 0.6


def _close_db_matches(
    project: Project,
    rel_path: str,
    query_term: str,
    *,
    table: str,
    column: str,
    kind: str,
) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` values from ``column`` in ``table``
    that are close lexical matches for ``query_term``.

    Shared implementation used by :func:`_close_symbol_matches` and
    :func:`_close_section_matches`. ``kind`` is only used in the debug log
    message to identify which lookup produced the error.

    Returns an empty list on any DB error so the caller's miss message still emits.
    """
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                f"SELECT DISTINCT {column} FROM {table}"
                f" WHERE file_rel = ? AND {column} IS NOT NULL",
                (rel_path,),
            ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError, FileNotFoundError) as exc:
        _LOG.debug("close-match query failed for %s in %s: %s", kind, rel_path, exc)
        return []
    candidates = [r[column] for r in rows if r[column]]
    return difflib.get_close_matches(query_term, candidates, n=_DIDYOUMEAN_LIMIT, cutoff=_DIDYOUMEAN_CUTOFF)


def _close_symbol_matches(project: Project, rel_path: str, symbol: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` symbol names from ``rel_path`` that are
    close lexical matches for ``symbol``.

    Used to produce "did you mean…?" suggestions when ``token-goat read`` fails
    to find a symbol in an otherwise-resolved file. Returning even one good
    candidate keeps the agent on the surgical-read path instead of falling
    back to ``Read full-file``.

    Returns an empty list on any DB error so the miss message still emits.
    """
    return _close_db_matches(project, rel_path, symbol, table="symbols", column="name", kind="symbol")


def _close_section_matches(project: Project, rel_path: str, heading: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` section headings from ``rel_path``
    that are close lexical matches for ``heading``.

    The mirror of :func:`_close_symbol_matches` for ``token-goat section``.
    Returns an empty list on any DB error.
    """
    return _close_db_matches(project, rel_path, heading, table="sections", column="heading", kind="section")


def _close_file_matches(project: Project, file_part: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` indexed file paths whose basename
    is a close lexical match for the basename of *file_part*.

    Used to produce "did you mean…?" suggestions when a file lookup returns no
    match, so the agent can correct a typo without falling back to a full-repo
    listing.  Matching is basename-only (e.g. ``parsre.py`` → ``parser.py``) but
    the returned strings are the full ``rel_path`` values so the agent can paste
    them directly into the next command.

    Returns an empty list when the project DB is unavailable or no close match
    exists, so the caller's miss message still emits even if suggestions fail.
    """
    basename = Path(file_part).name
    if not basename:
        return []
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                "SELECT rel_path FROM files WHERE rel_path IS NOT NULL",
            ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError, FileNotFoundError) as exc:
        _LOG.debug("close-file-match query failed for %r: %s", file_part, exc)
        return []
    all_rel_paths = [r["rel_path"] for r in rows if r["rel_path"]]
    # Build a basename→rel_path map; when multiple paths share a basename
    # the last one wins (arbitrary but deterministic).
    basename_to_rel: dict[str, str] = {Path(rp).name: rp for rp in all_rel_paths}
    close_basenames = difflib.get_close_matches(
        basename, list(basename_to_rel.keys()), n=_DIDYOUMEAN_LIMIT, cutoff=_DIDYOUMEAN_CUTOFF
    )
    return [basename_to_rel[b] for b in close_basenames]


def _load_skipped_large(project_hash: str) -> list[dict]:
    """Return files recorded as skipped during indexing for exceeding the size cap.

    Reads the ``skipped_large_files`` meta row written by
    :func:`token_goat.parser.index_project`.  Each entry is a dict with
    ``rel_path`` (POSIX, project-relative) and ``size_bytes``.  Returns an empty
    list when the project is unindexed, has no over-cap files, or the meta row is
    absent/malformed — callers then fall back to the generic "not found" path.
    """
    try:
        with db.open_project_readonly(project_hash) as conn:
            row = conn.execute(
                "SELECT value FROM meta WHERE key = ?", ("skipped_large_files",)
            ).fetchone()
    except (sqlite3.OperationalError, sqlite3.DatabaseError, FileNotFoundError) as exc:
        _LOG.debug("skipped-large meta query failed for %s: %s", project_hash[:8], exc)
        return []
    raw = row["value"] if row is not None else None
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)]


def over_cap_file_hint(file_part: str, project: Project | None) -> str | None:
    """Return an actionable hint when *file_part* names a file that exists in the
    project but was skipped at index time for exceeding the size cap.

    The indexer records over-cap files in the ``skipped_large_files`` meta row
    instead of indexing them, so symbol/read/outline lookups miss with a generic
    "not found" plus unrelated "did you mean…?" suggestions.  This surfaces the
    real reason and points at line-range reads, which still work on unindexed
    files.  Returns ``None`` when nothing matches so genuine typos keep the normal
    suggestion behaviour.

    Matching is path-aware (case-insensitive exact path, trailing path-component,
    or shared basename) because callers pass a variety of forms: a full ``a/b/c.js``
    path from ``read``, a partial ``--file`` needle from ``symbol``, or a bare
    basename.  A plain substring test was avoided because it false-matches across
    filename boundaries (``service.py`` inside ``user_service.py``).  The skip list
    is tiny (usually zero entries), so the linear scan is effectively free.
    """
    if project is None or not file_part:
        return None
    entries = _load_skipped_large(project.hash)
    if not entries:
        return None
    for entry in entries:
        rel = str(entry.get("rel_path", ""))
        if rel and _path_part_matches(file_part, rel):
            from .parser import MAX_FILE_SIZE
            limit_mb = MAX_FILE_SIZE / 1024 / 1024
            return (
                f"File '{rel}' exists but was not indexed "
                f"(file size exceeds the {limit_mb:.0f} MB limit). "
                f'Use line-range reads: `token-goat read "{rel}::1-200"` to read sections.'
            )
    return None


def no_indexed_symbols_note(file_rel: str) -> str:
    """Note shown for an indexed file that has zero symbols, where a skeleton or
    outline hint would mislead (running it would just print an empty list)."""
    return f"Note: {file_rel} has no indexed symbols — it may be a config file or too small to parse"


def skeleton_or_empty_hint(project_hash: str, file_rel: str) -> str:
    """Hint to emit after a symbol miss that resolved to a single indexed file.

    When the file actually has symbols, point at ``skeleton`` so the caller can
    see what is available. When the file has zero indexed symbols, suggesting
    skeleton is misleading, so explain why instead (config file / too small).
    """
    if db.count_symbols_for_file(project_hash, file_rel) == 0:
        return no_indexed_symbols_note(file_rel)
    return f'Try: token-goat skeleton "{file_rel}" to see what\'s indexed'


def resolve_scoped_file(project_hash: str, like_param: str) -> str | None:
    """Resolve a partial ``--file`` scope to a single concrete indexed path.

    *like_param* is an already-escaped SQL LIKE pattern (e.g. ``%auth.py%``).
    Queries the ``files`` table — not ``symbols`` — so files with zero indexed
    symbols still resolve. Returns the matched ``rel_path`` only when exactly one
    file matches; ``None`` for zero matches or an ambiguous (multi-file) scope.
    """
    try:
        with db.open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' LIMIT 2",
                (like_param,),
            ).fetchall()
    except (sqlite3.Error, FileNotFoundError, OSError):
        return None
    if len(rows) == 1:
        return str(rows[0]["rel_path"])
    return None


def _path_part_matches(file_part: str, rel_path: str) -> bool:
    """Return whether *file_part* (a user-supplied needle) matches *rel_path*.

    Path-aware, case-insensitive match shared by :func:`over_cap_file_hint` and the
    line-range disk fallback: an exact normalized path, a trailing path-component
    (``a/b/c.js`` ends with ``/c.js``), or a shared basename all count.  A bare
    substring test is deliberately avoided because it false-matches across filename
    boundaries (``service.py`` inside ``user_service.py``).
    """
    needle = file_part.replace("\\", "/").lower()
    needle = needle.removeprefix("./")
    if not needle:
        return False
    rel_norm = rel_path.replace("\\", "/").lower()
    if not rel_norm:
        return False
    needle_base = needle.rsplit("/", 1)[-1]
    rel_base = rel_norm.rsplit("/", 1)[-1]
    return (
        rel_norm == needle
        or rel_norm.endswith("/" + needle)
        or (bool(needle_base) and needle_base == rel_base)
    )


def _safe_resolve_within(candidate: Path, root: Path) -> Path | None:
    """Resolve *candidate* and return it only if it stays inside *root*.

    Security gate for the line-range disk fallback: a needle such as
    ``../../etc/passwd`` joined onto a project root must never resolve to a file
    outside that root.  *root* is expected to already be resolved.  Returns the
    resolved path when it is a descendant of *root*, otherwise ``None``.
    """
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    try:
        resolved.relative_to(root)
    except ValueError:
        return None
    return resolved


def _disk_fallback_search_roots(
    current_project: Project | None,
) -> list[tuple[str, Path]]:
    """Resolve the ``(project_hash, root)`` pairs the disk fallback may scan.

    With an active *current_project* the result holds exactly that one project,
    taken straight from its already-canonical ``root`` Path (no second DB lookup).
    Confining the scan to the active project is the isolation invariant: a
    line-range read issued from project A must never reach into project B.

    With no active project (``current_project`` is ``None`` — a rare edge case,
    e.g. the cwd is outside every indexed project) the scan fans out across every
    registered project so the file can still be located; the caller then discloses
    which root the hit came from so the cross-project origin is never hidden.
    """
    if current_project is not None:
        root = current_project.root
        if not isinstance(root, Path):
            root = Path(root)
        try:
            if not root.is_dir():
                return []
        except OSError:
            return []
        return [(current_project.hash, root)]

    try:
        with db.open_global_readonly() as gconn:
            rows = gconn.execute("SELECT hash, root FROM projects").fetchall()
    except (FileNotFoundError, sqlite3.Error) as exc:
        _LOG.debug("disk-fallback: global project list unavailable: %s", exc)
        return []
    targets: list[tuple[str, Path]] = []
    for row in rows:
        proj_hash = row["hash"]
        root_raw = row["root"]
        if not proj_hash or not root_raw:
            continue
        try:
            root = Path(root_raw).resolve()
        except OSError:
            continue
        if root.is_dir():
            targets.append((proj_hash, root))
    return targets


def _find_unindexed_file_on_disk(
    file_part: str, current_project: Project | None = None
) -> tuple[Path, str, Path] | None:
    """Locate an unindexed (e.g. over-cap) file on disk inside an indexed project.

    The line-range read path normally resolves files through the index.  When a
    file was skipped at index time for exceeding the size cap (or is otherwise not
    indexed) the index lookup misses, yet the file still exists on disk — and the
    over-cap hint actively points users at ``token-goat read "file::N-M"``.  This
    bridges that gap, returning ``(abs_path, rel_path_posix, project_root)`` for the
    first hit or ``None``.

    Project isolation is the invariant.  When *current_project* is supplied the
    search is confined to that single project's root and its ``skipped_large_files``
    meta — a ``read`` issued from project A must never silently serve a same-named
    file from project B.  Only when no project is active (``current_project`` is
    ``None``) does the search fan out across every indexed project, and the caller
    then discloses the source root so the cross-project origin stays visible.

    Two match strategies are tried per project, both confined to the project root
    (no arbitrary filesystem reads):

    1. ``skipped_large_files`` meta entries, matched path-aware via
       :func:`_path_part_matches` — the primary over-cap case.
    2. A direct ``root / file_part`` join for any other on-disk file addressed by
       its exact project-relative path.
    """
    needle = file_part.replace("\\", "/").strip()
    needle = needle.removeprefix("./")
    if not needle:
        return None
    for proj_hash, root in _disk_fallback_search_roots(current_project):
        for entry in _load_skipped_large(proj_hash):
            rel = str(entry.get("rel_path", "")).replace("\\", "/")
            if rel and _path_part_matches(file_part, rel):
                resolved = _safe_resolve_within(root / rel, root)
                if resolved is not None and resolved.is_file():
                    return resolved, resolved.relative_to(root).as_posix(), root
        resolved = _safe_resolve_within(root / needle, root)
        if resolved is not None and resolved.is_file():
            return resolved, resolved.relative_to(root).as_posix(), root
    return None


def _read_disk_line_range(abs_path: Path, start: int, end: int) -> list[str] | None:
    """Stream lines *start*..*end* (1-based, inclusive) from *abs_path*.

    Reads line-by-line so an over-cap file — which the 2 MB ``_read_file_lines``
    cap would reject outright — can still be sampled without loading it entirely
    into memory.  Universal-newline text mode (``utf-8-sig`` + ``errors="replace"``)
    mirrors the encoding handling of the indexed read path.  Returns the collected
    lines, or ``None`` on I/O error or when *start* is past end-of-file.
    """
    collected: list[str] = []
    try:
        with abs_path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            for lineno, raw in enumerate(fh, start=1):
                if lineno < start:
                    continue
                if lineno > end:
                    break
                collected.append(raw.removesuffix("\n"))
    except OSError as exc:
        _LOG.warning("disk-fallback read failed: %s: %s", abs_path, exc)
        return None
    if not collected:
        return None
    return collected


def _emit_read_error(
    *,
    code: str,
    message: str,
    json_output: bool,
    candidates: Sequence[str] = (),
    err: bool = False,
    **details: object,
) -> None:
    """Emit a structured read error in either text or JSON form.

    In JSON mode, outputs {"ok": False, "error": {...}} with code, message, and optional
    candidates/details. In text mode, miss diagnostics (file/symbol not found, did-you-mean
    suggestions) go to stdout so they survive ``2>/dev/null``; pass ``err=True`` for genuine
    input/usage errors that belong on stderr.
    """
    if json_output:
        error: dict[str, object] = {"code": code, "message": message}
        if candidates:
            error["candidates"] = list(candidates)
        error.update(details)
        typer.echo(json_compact({"ok": False, "error": error}))
        return

    typer.echo(message, err=err)
    for candidate in candidates:
        typer.echo(f"  - {candidate}", err=err)


def _emit_ambiguous_file_match(file_part: str, candidates: Sequence[str], *, json_output: bool) -> None:
    """Emit a structured error when a file name matches multiple indexed paths.

    Delegates to _emit_read_error with code='ambiguous_file' and includes all
    candidate paths so the user can disambiguate with a more specific path pattern.
    """
    _emit_read_error(
        code="ambiguous_file",
        message=f"Ambiguous file match: {file_part}",
        candidates=candidates,
        json_output=json_output,
        file_part=file_part,
    )


def _emit_file_not_found_error(
    file_part: str,
    current_proj: Project | None,
    *,
    json_output: bool,
) -> None:
    """Emit a structured error when file resolution returns no match.

    Distinguishes three cases:
    - No project detected at all (``current_proj is None``).
    - Project detected but not yet indexed (``_not_indexed_hint`` returns a hint).
    - Project indexed but the file pattern matched nothing.

    When the project is indexed but the file is not found, close-basename matches
    from the project's file index are included as "did you mean…?" suggestions so
    the caller can correct a typo without a full-repo listing.

    Extracted from the identical ``if rel is None`` blocks in
    :func:`_run_read_like_command` and :func:`deps`.
    """
    if current_proj is None:
        _emit_read_error(
            code="no_project",
            message="No project detected.",
            json_output=json_output,
            file_part=file_part,
        )
    else:
        hint = _not_indexed_hint(current_proj.hash)
        if hint:
            _emit_read_error(
                code="project_not_indexed",
                message=hint,
                json_output=json_output,
                file_part=file_part,
                project_hash=current_proj.hash,
            )
        else:
            over_cap = over_cap_file_hint(file_part, current_proj)
            if over_cap is not None:
                _emit_read_error(
                    code="file_over_cap",
                    message=over_cap,
                    json_output=json_output,
                    file_part=file_part,
                    project_hash=current_proj.hash,
                )
                # Exit non-zero so callers (and shells) see the over-cap miss as a
                # failure, even on read paths whose generic miss returns 0.
                raise typer.Exit(1)
            suggestions = _close_file_matches(current_proj, file_part)
            base_message = f"File not found in any indexed project: {file_part}"
            if suggestions and not json_output:
                base_message = base_message + "\nDid you mean:"
            _emit_read_error(
                code="file_not_found",
                message=base_message,
                json_output=json_output,
                candidates=suggestions,
                file_part=file_part,
                project_hash=current_proj.hash,
            )


def _collect_dependency_graph(
    conn: sqlite3.Connection,
    rel_path: str,
) -> tuple[dict[str, set[str]], dict[str, set[str]], list[str]]:
    """Return file-level dependency edges and unresolved refs for the given file.

    Returns (outgoing, incoming, unresolved_refs):
      - outgoing: files this file depends on, mapped to referenced symbol names
      - incoming: files that depend on this file, mapped to symbol names they use
      - unresolved_refs: ref names in this file that match no indexed symbol
    """
    outgoing: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute(
        """
        SELECT DISTINCT s.file_rel, r.symbol_name
          FROM refs r
          JOIN symbols s ON s.name = r.symbol_name AND s.file_rel != r.file_rel
         WHERE r.file_rel = ?
           AND r.symbol_name != ''
        """,
        (rel_path,),
    ).fetchall():
        outgoing[row["file_rel"]].add(row["symbol_name"])

    incoming: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute(
        """
        SELECT DISTINCT r.file_rel, s.name AS symbol_name
          FROM symbols s
          JOIN refs r ON r.symbol_name = s.name AND r.file_rel != s.file_rel
         WHERE s.file_rel = ?
        """,
        (rel_path,),
    ).fetchall():
        incoming[row["file_rel"]].add(row["symbol_name"])

    unresolved: list[str] = [
        row["symbol_name"]
        for row in conn.execute(
            """
            SELECT DISTINCT r.symbol_name
              FROM refs r
              LEFT JOIN symbols s ON s.name = r.symbol_name
             WHERE r.file_rel = ?
               AND r.symbol_name != ''
               AND s.name IS NULL
             ORDER BY r.symbol_name
            """,
            (rel_path,),
        ).fetchall()
    ]

    return outgoing, incoming, unresolved


def _collect_outgoing_edges(conn: sqlite3.Connection, rel_path: str) -> dict[str, set[str]]:
    """Return only the outgoing file-level edges for rel_path (no incoming, no unresolved)."""
    outgoing: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute(
        """
        SELECT DISTINCT s.file_rel, r.symbol_name
          FROM refs r
          JOIN symbols s ON s.name = r.symbol_name AND s.file_rel != r.file_rel
         WHERE r.file_rel = ?
           AND r.symbol_name != ''
        """,
        (rel_path,),
    ).fetchall():
        outgoing[row["file_rel"]].add(row["symbol_name"])
    return outgoing


def _collect_transitive_outgoing(
    conn: sqlite3.Connection,
    start_rel: str,
    max_depth: int,
) -> dict[str, _DepNode]:
    """BFS over outgoing dependency edges up to max_depth levels.

    Computes transitive dependencies: all files that start_rel depends on,
    directly or indirectly, up to the specified depth limit. Uses breadth-first
    search to discover dependencies in order of distance from the root.

    Args:
        conn: Database connection to query symbol references and definitions.
        start_rel: Repository-relative path of the starting file (project root-relative).
        max_depth: Maximum traversal depth (0 = unlimited, 1 = direct dependencies only).

    Returns:
        Dict keyed by file_rel (dependency path) with entries:
          {"depth": int, "via": str, "symbols": set[str]}
        where:
          - depth: Distance from start_rel (1=direct dependency, 2=indirect, etc.)
          - via: Immediate parent file in the BFS tree (for path reconstruction)
          - symbols: Set of symbol names referenced from start_rel to this file
    """
    result: dict[str, _DepNode] = {}
    # Use a deque for O(1) popleft — list.pop(0) is O(n) and misreads as a stack.
    bfs_queue: deque[tuple[str, int]] = deque([(start_rel, 0)])
    visited: set[str] = {start_rel}

    while bfs_queue:
        current, depth = bfs_queue.popleft()
        next_depth = depth + 1
        if max_depth and next_depth > max_depth:
            continue
        for dep_file, symbols in _collect_outgoing_edges(conn, current).items():
            if dep_file not in visited:
                visited.add(dep_file)
                result[dep_file] = _DepNode(depth=next_depth, via=current, symbols=symbols)
                bfs_queue.append((dep_file, next_depth))
            elif dep_file in result and result[dep_file]["depth"] == next_depth:
                result[dep_file]["symbols"] |= symbols

    return result


def _edge_summary(file_count: int, edge_count: int) -> str:
    """Return a human-readable summary of file and edge counts, with correct plurals.

    Example output: '3 files, 7 edges' or '1 file, 1 edge'.
    """
    files_noun = "file" if file_count == 1 else "files"
    edges_noun = "edge" if edge_count == 1 else "edges"
    return f"{file_count} {files_noun}, {edge_count} {edges_noun}"


def _format_dependency_line(file_rel: str, symbols: set[str]) -> str:
    """Format a dependency entry showing a file and symbols referenced from it.

    Produces indented, comma-separated output for human readability in CLI output.
    Example: "  - path/to/file.py (2 symbols: funcA, funcB)"

    Args:
        file_rel: Repository-relative path of the dependency file.
        symbols: Set of symbol names (functions, classes, etc.) referenced from the file.

    Returns:
        Indented text line with file path and symbol count/list, or just file path
        if no symbols are provided.
    """
    symbol_list = ", ".join(sorted(symbols))
    count = len(symbols)
    noun = "symbol" if count == 1 else "symbols"
    if symbol_list:
        return f"  - {file_rel} ({count} {noun}: {symbol_list})"
    return f"  - {file_rel} ({count} {noun})"


class _FileTarget(NamedTuple):
    """Result of resolving a file-name pattern to a concrete project-relative path.

    Attributes:
        project: The project that owns the resolved file, or ``None`` if not found.
        rel_path: Project-relative path of the resolved file, or ``None`` if not found.
        current_project: The project rooted at the shell's cwd (may differ from
            ``project`` when the cross-project fallback matched a foreign project).
            Callers compare ``project != current_project`` to detect cross-project hits
            and emit an appropriate hint.
    """

    project: Project | None
    rel_path: str | None
    current_project: Project | None


def _resolve_file_target(file_part: str) -> _FileTarget:
    """Resolve a file name pattern to a concrete project-relative path.

    First attempts resolution in the current project; if not found, searches across
    all indexed projects via the cross-project fallback so that ``token-goat read``
    and ``token-goat section`` can reach files in ~/.claude/skills/ or other
    marker-free directories indexed with ``token-goat index --root``, regardless
    of which project the shell's cwd belongs to.
    """
    proj = find_project(Path.cwd())
    if proj is not None:
        rel = read_replacement.resolve_file_rel(proj, file_part)
        if rel is not None:
            _LOG.debug("resolved %r -> %s (current project %s)", file_part, rel, proj.hash[:8])
            return _FileTarget(project=proj, rel_path=rel, current_project=proj)
        _LOG.debug("file %r not found in current project %s; trying cross-project fallback", file_part, proj.hash[:8])
    else:
        _LOG.debug("no current project detected for cwd; trying cross-project fallback for %r", file_part)

    cross = read_replacement.find_in_all_projects(file_part)
    if cross is not None:
        _LOG.info("cross-project fallback: resolved %r -> %s (project %s)", file_part, cross[1], cross[0].hash[:8])
        return _FileTarget(project=cross[0], rel_path=cross[1], current_project=proj)
    _LOG.debug("file %r not found in any indexed project", file_part)
    return _FileTarget(project=None, rel_path=None, current_project=proj)


# ANSI escape for dim/faint text — used to visually distinguish context lines from
# the core symbol body on TTY output.  The reset code (\x1b[0m) restores normal
# rendering after each context line so subsequent lines are unaffected.
_ANSI_DIM = "\x1b[2m"
_ANSI_RESET = "\x1b[0m"


def _apply_context_gutter(
    text: str,
    context_before: int,
    context_after: int,
    *,
    no_color: bool,
) -> str:
    """Return *text* with context lines visually distinguished from the core body.

    On TTY with color enabled, context lines get a dim ``│ `` gutter prefix so the
    core symbol body stands out.  With ``no_color=True`` (or piped output) the text
    is returned unchanged.

    *context_before* and *context_after* are the number of leading/trailing lines
    that are context (not part of the core symbol).  When both are zero the input
    is returned as-is.
    """
    if no_color or (context_before == 0 and context_after == 0):
        return text
    lines = text.split("\n")
    total = len(lines)
    result: list[str] = []
    for i, line in enumerate(lines):
        is_context = i < context_before or i >= total - context_after
        if is_context:
            result.append(f"{_ANSI_DIM}│ {line}{_ANSI_RESET}")
        else:
            result.append(line)
    return "\n".join(result)


def _emit_text_result(
    text: str,
    rel_path: str,
    item: str,
    separator_label: str,
    no_header: bool,
    *,
    context_before: int = 0,
    context_after: int = 0,
    no_color: bool = False,
) -> None:
    """Emit *text* to stdout, optionally prefixed with a ``## …`` header (Item 15).

    The header ``## {rel_path} — {separator_label}: {item}`` is emitted when:
    - ``no_header`` is False, AND
    - stdout is a TTY (interactive terminal).

    In agent / pipe / capture contexts (``isatty() == False``) the header is
    suppressed by default so callers do not pay ~10 tokens per surgical read.
    Pass ``--header`` (``no_header=False`` with explicit override) or redirect
    to a TTY to restore it; pass ``--no-header`` to force suppression.

    When *context_before* or *context_after* is non-zero and stdout is a TTY
    (and ``no_color`` is False), context lines are rendered with a dim ``│ ``
    gutter prefix so the core symbol body stands out visually.

    A token estimate comment (``# {N} lines ({approx_tokens} tokens est.)``) is
    always prepended to the output so the agent can budget its context before
    reading.
    """
    token_header = read_replacement.token_estimate_header(text)
    if not no_header and sys.stdout.isatty():
        typer.echo(f"## {rel_path} — {separator_label}: {item}")
    typer.echo(token_header)
    is_tty = sys.stdout.isatty()
    apply_color = is_tty and not no_color
    display_text = _apply_context_gutter(text, context_before, context_after, no_color=not apply_color)
    # Final safety net: cap pathologically large output so one surgical read can't overflow the model's context. ``separator_label`` ("symbol"/"section"/"lines") doubles as the command hint for the truncation marker. No-op under budget.
    display_text = overflow_guard.guard(display_text, command=separator_label)
    typer.echo(display_text)


def _context_bounds(result: read_replacement.SymbolResult | read_replacement.SectionResult | dict) -> tuple[int, int]:
    """Return (context_before, context_after) line counts from a read result dict.

    Uses ``start_line``/``end_line`` (expanded by context) vs ``core_start_line``/
    ``core_end_line`` (the raw symbol/section bounds before context expansion).
    Falls back to (0, 0) when the core fields are absent (e.g. LineRangeResult or
    a cached result from an older format).
    """
    core_start = result.get("core_start_line")
    core_end = result.get("core_end_line")
    if core_start is None or core_end is None:
        return 0, 0
    start = result.get("start_line", core_start)
    end = result.get("end_line", core_end)
    before = max(0, core_start - start)
    after = max(0, end - core_end)
    return before, after


def _run_read_like_command(
    *,
    target: str,
    session_id: str | None,
    json_output: bool,
    context_lines: int,
    separator_label: str,
    missing_label: str,
    stat_kind: str,
    reader: _ReaderCallable,
    no_header: bool = False,
    no_color: bool = False,
    full: bool = False,
) -> None:
    """Unified handler for read/section/deps CLI commands.

    Parses target (format "file::item"), resolves the file, calls the reader function,
    handles errors (ambiguous file, not found, not indexed), marks the read in session
    cache, records token savings, and emits output (JSON or text).

    Args:
        target: Format "file_pattern::symbol_or_heading". Delimiter must be "::".
        session_id: Session ID for tracking in session cache (optional).
        json_output: If true, emit JSON response; else plain text.
        context_lines: Extra lines before/after the result (for read command).
        separator_label: Display label for the :: separator (e.g., "symbol", "heading").
        missing_label: Label for missing-item error (e.g., "Symbol", "Section").
        stat_kind: Stat kind to record (e.g., "read_replacement", "section_replacement").
        reader: Callable matching :class:`_ReaderCallable` — takes ``(project, rel_path,
            item, *, context_lines)`` and returns a ``SymbolResult``, ``SectionResult``,
            or ``None``.
        no_header: When True, suppress the ``## path — label: item`` header line.
            Defaults to False; auto-suppressed in non-TTY contexts (Item 15).
        no_color: When True, suppress ANSI color/dim escapes even on TTY output.
        full: When True, bypass smart truncation for long symbol bodies and return the
            complete text.  Defaults to False (truncation active for bodies > 60 lines).
    """
    if "::" not in target:
        _emit_read_error(
            code="invalid_target",
            message=f"Error: target must be '<file>::<{separator_label}>'",
            json_output=json_output,
            err=True,
            target=target,
        )
        raise typer.Exit(2)

    file_part, _, item_part = target.rpartition("::")

    try:
        file_target = _resolve_file_target(file_part)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(
            code=exc.code,
            message=str(exc),
            json_output=json_output,
            file_part=file_part,
        )
        raise typer.Exit(0) from None
    except read_replacement.AmbiguousFileMatch as exc:
        _emit_ambiguous_file_match(file_part, exc.candidates, json_output=json_output)
        raise typer.Exit(0) from None

    if file_target.rel_path is None:
        db.record_miss(file_part, "")
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        if db.get_miss_count(file_part, "") >= 3 and not json_output:
            typer.echo(
                f"[hint] Searched for '{file_part}' 3+ times without a match."
                " Consider: token-goat map --compact to check what's indexed,"
                " or add an alias in CLAUDE.md."
            )
        raise typer.Exit(0)

    assert file_target.project is not None  # guaranteed once rel_path is resolved
    db.reset_miss(file_part, "")

    # In-session result cache (per Claude session).  Cache hit on
    # (rel_path, item, kind, file_sha) avoids the DB round-trip and file read.
    # context_lines is folded into the cache key because two reads with different
    # context windows must not share a cached slice — they extract different text.
    cache_kind = "section" if separator_label == "heading" else "symbol"
    cache_item_key = f"{item_part}\x1ec={context_lines}"
    cached_result: dict | None = None
    file_sha = ""
    if session_id:
        abs_path = file_target.project.root / file_target.rel_path
        file_sha = _file_sha1(abs_path)
        if file_sha:
            cached_result = session.get_result_cache(
                session_id,
                file_target.rel_path,
                cache_item_key,
                cache_kind,
                file_sha,
            )
    if cached_result is not None and session_id:
        _LOG.debug(
            "%s cache hit: %s::%s (kind=%s)",
            stat_kind, file_target.rel_path, item_part, cache_kind,
        )
        # Still mark the read so dedup hints see this access.  No stat is recorded
        # for a cache hit — we already counted the savings on the original call.
        session.mark_file_read(session_id, file_target.rel_path, symbol=item_part)
        if json_output:
            out = {k: v for k, v in cached_result.items() if k not in _INTERNAL_RESULT_FIELDS}
            display_text = read_replacement.truncate_symbol_body(out.get("text", ""), full=full)
            out = dict(out)
            out["text"] = display_text
            typer.echo(json_compact(out))
        else:
            cb, ca = _context_bounds(cached_result)
            display_text = read_replacement.truncate_symbol_body(cached_result["text"], full=full)
            if separator_label == "symbol":
                footer = read_replacement.format_callers_footer(
                    file_target.project,
                    cached_result.get("symbol", item_part),
                )
                if footer:
                    display_text = f"{display_text}\n\n{footer}"
            _emit_text_result(
                display_text, file_target.rel_path, item_part, separator_label, no_header,
                context_before=cb, context_after=ca, no_color=no_color,
            )
        return

    result = reader(file_target.project, file_target.rel_path, item_part, context_lines=context_lines)
    if result is None:
        _label_lower = missing_label.lower()
        # Suggest close matches from the same file so the agent has an
        # immediate next step instead of falling back to a full-file Read.
        # The label tells us which table to consult: "Symbol" -> symbols,
        # "Section" -> sections.
        if _label_lower == "symbol":
            suggestions = _close_symbol_matches(file_target.project, file_target.rel_path, item_part)
        elif _label_lower == "section":
            suggestions = _close_section_matches(file_target.project, file_target.rel_path, item_part)
        else:
            suggestions = []
        base_message = f"{missing_label} not found: {item_part} (in {file_target.rel_path})"
        if suggestions and not json_output:
            if len(suggestions) == 1 and _label_lower == "symbol":
                base_message = (
                    base_message
                    + f'\nDid you mean: `token-goat read "{file_target.rel_path}::{suggestions[0]}"`'
                )
                suggestions = []
            else:
                base_message = base_message + "\nDid you mean:"
        elif not json_output and _label_lower == "symbol":
            # No close matches to suggest — point the agent at ``outline``, which
            # lists every symbol in the file, so it has a concrete next step
            # instead of guessing or falling back to a full-file Read.  (Only
            # symbols have a dedicated lister; sections rely on close matches.)
            base_message = (
                base_message
                + f'\nHint: run `token-goat outline "{file_target.rel_path}"`'
                + " to list available symbols"
            )
        # On this path the file resolved cleanly — only the symbol/heading missed.
        # ``rel_path`` is the canonical, normalized form (e.g. "src/index.ts");
        # the raw ``file_part`` ("index.ts") that triggered the lookup is already
        # echoed back in the user's command and isn't useful downstream, so we
        # omit it to save ~30-150 bytes of redundant payload per miss.
        db.record_miss(item_part, file_target.rel_path or "")
        if db.get_miss_count(item_part, file_target.rel_path or "") >= 3 and not json_output:
            base_message += (
                f"\n[hint] Searched for '{item_part}' 3+ times without a match."
                " Consider: token-goat map --compact to check what's indexed,"
                " or add an alias in CLAUDE.md."
            )
        _emit_read_error(
            code=f"{_label_lower}_not_found",
            message=base_message,
            json_output=json_output,
            candidates=suggestions,
            rel_path=file_target.rel_path,
            item=item_part,
            item_kind=_label_lower,
        )
        # Exit non-zero so the caller (agent or shell) can distinguish a genuine
        # miss from a successful read that happened to return empty text.  This
        # matches the skill-section not-found paths, which already exit 1.
        raise typer.Exit(1)

    db.reset_miss(item_part, file_target.rel_path or "")
    if session_id:
        session.mark_file_read(session_id, file_target.rel_path, symbol=item_part)
        # Store the freshly-computed result for future same-session lookups.
        # ``file_sha`` was computed up front above (when session_id was provided);
        # if it is empty here, the file could not be read for hashing, so we
        # skip caching rather than store an entry that would never invalidate.
        if file_sha:
            session.put_result_cache(
                session_id,
                file_target.rel_path,
                cache_item_key,
                cache_kind,
                file_sha,
                dict(result),
            )

    bytes_saved = result.get("bytes_saved", 0)
    tokens_saved = max(1, bytes_saved // 3 + 1) if bytes_saved > 0 else 0
    _LOG.debug(
        "%s served: %s::%s bytes_saved=%d tokens_saved=%d",
        stat_kind, file_target.rel_path, item_part, bytes_saved, tokens_saved,
    )
    db.record_stat(
        file_target.project.hash,
        stat_kind,
        tokens_saved=tokens_saved,
        bytes_saved=bytes_saved,
        detail=f"{file_target.rel_path}::{item_part}",
    )

    # Apply smart truncation to the result text (no-op when full=True or body is short).
    display_text = read_replacement.truncate_symbol_body(result["text"], full=full)

    # Duplicate-heading hint: when read_section returned the first of multiple sections
    # sharing the same heading name, surface a stderr warning so the agent knows to
    # use the #N ordinal suffix next time.  Emitted before the body so it is visible.
    _ambiguous = result.get("ambiguous_at_lines")
    if _ambiguous and not json_output:
        _other = ", ".join(str(ln) for ln in _ambiguous)
        typer.echo(
            f"[tg] Multiple sections named {item_part!r} in {file_target.rel_path} — "
            f"returned line {result.get('start_line')}; others at line(s): {_other}. "
            f"Add #2/#3 to select a specific occurrence.",
            err=True,
        )

    # Symbol-level stale-edit hint: warn the agent when the symbol body has changed
    # since the session's last snapshot of this file.  Only fires for symbol reads
    # (not section/line-range reads) when a session_id is provided.  Emitted to
    # stderr so it appears before the body without corrupting JSON or piped output.
    if session_id and separator_label == "symbol":
        _sym_name = str(result.get("symbol") or item_part)
        stale_hint = hints.build_symbol_stale_hint(
            session_id=session_id,
            file_path=str(file_target.project.root / file_target.rel_path),
            symbol_name=_sym_name,
            current_start_line=result.get("start_line", 1),
            current_end_line=result.get("end_line", 1),
            current_text=result.get("text", ""),
        )
        if stale_hint:
            typer.echo(stale_hint, err=True)

    # Cross-reference footer: append "Referenced by: …" for symbol reads in text mode.
    # Only fires when reading a symbol (not a section or line-range), and is suppressed
    # in JSON output so the structured payload stays clean.
    if separator_label == "symbol" and not json_output:
        footer = read_replacement.format_callers_footer(
            file_target.project,
            str(result.get("symbol") or item_part),
        )
        if footer:
            display_text = f"{display_text}\n\n{footer}"

    # Emit a cross-project attribution note when the result came from a
    # different project than the shell's cwd.  The user needs to know the
    # result is from a foreign repo so they can verify path accuracy.
    if (
        file_target.project != file_target.current_project
        and file_target.current_project is not None
    ):
        note = f"[from project: {file_target.project.root}]"
        if json_output:
            out = {k: v for k, v in result.items() if k not in _INTERNAL_RESULT_FIELDS}
            out["_project_root"] = str(file_target.project.root)
            out["text"] = display_text
            typer.echo(json_compact(out))
            return
        cb, ca = _context_bounds(result)
        typer.echo(note, err=True)
        _emit_text_result(
            display_text, file_target.rel_path, item_part, separator_label, no_header,
            context_before=cb, context_after=ca, no_color=no_color,
        )
        return

    if json_output:
        # Strip internal stat fields — model never acts on them; stats are recorded above.
        out = {k: v for k, v in result.items() if k not in _INTERNAL_RESULT_FIELDS}
        out["text"] = display_text
        typer.echo(json_compact(out))
        return
    cb, ca = _context_bounds(result)
    _emit_text_result(
        display_text, file_target.rel_path, item_part, separator_label, no_header,
        context_before=cb, context_after=ca, no_color=no_color,
    )


def deps(
    file: str,
    json_output: bool = typer.Option(False, "--json"),
    depth: int = typer.Option(1, "--depth", "-d", help="Transitive depth (1=direct, 0=unlimited)"),
) -> None:
    """Show dependency graph for file."""
    try:
        file_target = _resolve_file_target(file)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(
            code=exc.code,
            message=str(exc),
            json_output=json_output,
            file_part=file,
        )
        return

    if file_target.rel_path is None:
        _emit_file_not_found_error(file, file_target.current_project, json_output=json_output)
        return

    assert file_target.project is not None
    with db.open_project(file_target.project.hash) as conn:
        outgoing, incoming, unresolved = _collect_dependency_graph(conn, file_target.rel_path)
        transitive: dict[str, _DepNode] = {}
        if depth != 1:
            transitive = _collect_transitive_outgoing(conn, file_target.rel_path, max_depth=depth)

    outgoing_edge_count = sum(len(v) for v in outgoing.values())
    outgoing_file_count = len(outgoing)
    incoming_edge_count = sum(len(v) for v in incoming.values())
    incoming_file_count = len(incoming)
    _LOG.debug(
        "deps graph for %s: out=%d files/%d edges in=%d files/%d edges unresolved=%d transitive=%d",
        file_target.rel_path, outgoing_file_count, outgoing_edge_count,
        incoming_file_count, incoming_edge_count,
        len(unresolved), len(transitive),
    )

    if json_output:
        payload: dict[str, object] = {
            "file": file_target.rel_path,
            "depth": depth,
            "dependency_file_count": outgoing_file_count,
            "dependency_edge_count": outgoing_edge_count,
            "dependent_file_count": incoming_file_count,
            "dependent_edge_count": incoming_edge_count,
            "unresolved_ref_count": len(unresolved),
            "dependencies": {
                dep: sorted(syms)
                for dep, syms in sorted(outgoing.items(), key=_key_dep_by_size)
            },
            "dependents": {
                dep: sorted(syms)
                for dep, syms in sorted(incoming.items(), key=_key_dep_by_size)
            },
            "unresolved_refs": unresolved,
        }
        if transitive:
            payload["all_dependencies"] = {
                f: {"depth": v["depth"], "via": v["via"], "symbols": sorted(v["symbols"])}
                for f, v in sorted(transitive.items(), key=_key_transitive_by_depth)
            }
        typer.echo(json.dumps(payload))
        return

    outgoing_summary = _edge_summary(outgoing_file_count, outgoing_edge_count)
    incoming_summary = _edge_summary(incoming_file_count, incoming_edge_count)
    typer.echo(f"Dependency graph for {file_target.rel_path}")
    typer.echo(f"Dependencies ({outgoing_summary}):")
    if outgoing:
        for dep_rel, symbols in sorted(outgoing.items(), key=_key_dep_by_size):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")

    if transitive:
        transitive_only = {f: v for f, v in transitive.items() if f not in outgoing}
        if transitive_only:
            typer.echo(f"Transitive dependencies (depth 2–{depth or '∞'}, {len(transitive_only)} more files):")
            for dep_rel, info in sorted(transitive_only.items(), key=_key_transitive_by_depth):
                indent = "    " * (info["depth"] - 1)
                via_note = f"  via {info['via']}" if info["via"] != file_target.rel_path else ""
                typer.echo(f"{indent}{_format_dependency_line(dep_rel, info['symbols'])}{via_note}")

    typer.echo(f"Dependents ({incoming_summary}):")
    if incoming:
        for dep_rel, symbols in sorted(incoming.items(), key=_key_dep_by_size):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")

    if unresolved:
        noun = "ref" if len(unresolved) == 1 else "refs"
        typer.echo(f"Unresolved {noun} ({len(unresolved)}): {', '.join(unresolved[:20])}"
                   + (" ..." if len(unresolved) > 20 else ""))


_DISK_FALLBACK_MAX_LINES = 5000  # one line-range disk read may span at most this many lines


def _run_disk_fallback_line_range(
    *,
    abs_path: Path,
    rel_path: str,
    start: int,
    end: int,
    item_part: str,
    session_id: str | None,
    json_output: bool,
    no_header: bool,
    source_root: Path | None = None,
) -> None:
    """Emit a bounded raw line-range read for an unindexed/over-cap on-disk file.

    Reached from :func:`_run_read_line_range` when the index misses but
    :func:`_find_unindexed_file_on_disk` located the file inside a project root.
    The read is capped at :data:`_DISK_FALLBACK_MAX_LINES`; a wider span is a usage
    error.  Output carries a ``[disk-fallback: <rel> (not indexed)]`` banner on
    stderr so callers know this is a raw read, not a symbol extraction.

    *source_root* is set only when the file was located outside the active project
    (the no-current-project fan-out path).  When present, the project root is
    disclosed in both the banner and the JSON envelope (``_project_root``) so the
    cross-project origin matches the disclosure the indexed cross-project path
    provides and is never hidden.
    """
    span = end - start + 1
    if span > _DISK_FALLBACK_MAX_LINES:
        _emit_read_error(
            code="disk_fallback_range_too_large",
            message=(
                f"Line range {start}-{end} spans {span} lines, exceeding the "
                f"{_DISK_FALLBACK_MAX_LINES}-line disk-fallback cap for unindexed files. "
                f"Narrow the range (≤{_DISK_FALLBACK_MAX_LINES} lines per call)."
            ),
            json_output=json_output,
            err=True,
            rel_path=rel_path,
            item=item_part,
        )
        raise typer.Exit(2)

    lines = _read_disk_line_range(abs_path, start, end)
    if lines is None:
        _emit_read_error(
            code="line_range_out_of_bounds",
            message=f"Line range {start}-{end} is out of bounds for {rel_path}",
            json_output=json_output,
            rel_path=rel_path,
            item=item_part,
        )
        raise typer.Exit(0)

    if session_id:
        session.mark_file_read(session_id, rel_path)

    text = "\n".join(lines)
    end_line = start + len(lines) - 1
    if json_output:
        out = {
            "file": rel_path,
            "start_line": start,
            "end_line": end_line,
            "text": text,
            "disk_fallback": True,
        }
        if source_root is not None:
            out["_project_root"] = str(source_root)
        typer.echo(json_compact(out))
        return

    if source_root is not None:
        typer.echo(f"[disk-fallback: {rel_path} from {source_root} (not indexed)]", err=True)
    else:
        typer.echo(f"[disk-fallback: {rel_path} (not indexed)]", err=True)
    _emit_text_result(text, rel_path, item_part, "lines", no_header)


def _run_read_line_range(
    *,
    target: str,
    session_id: str | None,
    json_output: bool,
    no_header: bool,
) -> None:
    """Handle ``token-goat read file::N-M`` (line-range variant).

    Called from :func:`read` after :func:`~read_replacement.parse_line_range`
    confirms the item part is a ``start-end`` integer pair.  Resolves the file,
    reads the requested lines, emits result, and records stats.
    """
    file_part, _, item_part = target.rpartition("::")
    range_parsed = read_replacement.parse_line_range(item_part)
    if range_parsed is None:
        _emit_read_error(
            code="invalid_target",
            message=f"Error: line range '{item_part}' is invalid (expected 'N-M' or '@N-M' with N≥1 and M≥N)",
            json_output=json_output,
            target=target,
            err=True,
        )
        raise typer.Exit(2)

    start, end = range_parsed

    try:
        file_target = _resolve_file_target(file_part)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(code=exc.code, message=str(exc), json_output=json_output, file_part=file_part)
        raise typer.Exit(0) from None
    except read_replacement.AmbiguousFileMatch as exc:
        _emit_ambiguous_file_match(file_part, exc.candidates, json_output=json_output)
        raise typer.Exit(0) from None

    if file_target.rel_path is None:
        disk_match = _find_unindexed_file_on_disk(file_part, file_target.current_project)
        if disk_match is not None:
            abs_path, rel_path, source_root = disk_match
            # Disclose the source root only on the no-current-project fan-out path;
            # an in-project hit needs no disclosure (the file belongs to the cwd's
            # own project, exactly like the normal indexed read).
            disclose_root = source_root if file_target.current_project is None else None
            _run_disk_fallback_line_range(
                abs_path=abs_path,
                rel_path=rel_path,
                start=start,
                end=end,
                item_part=item_part,
                session_id=session_id,
                json_output=json_output,
                no_header=no_header,
                source_root=disclose_root,
            )
            return
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        raise typer.Exit(0)

    assert file_target.project is not None

    result = read_replacement.read_line_range(file_target.project, file_target.rel_path, start, end)
    if result is None:
        _emit_read_error(
            code="line_range_out_of_bounds",
            message=f"Line range {start}-{end} is out of bounds for {file_target.rel_path}",
            json_output=json_output,
            rel_path=file_target.rel_path,
            item=item_part,
        )
        raise typer.Exit(0)

    if session_id:
        session.mark_file_read(session_id, file_target.rel_path)

    bytes_saved = result.get("bytes_saved", 0)
    db.record_stat(
        file_target.project.hash,
        "read_replacement",
        tokens_saved=max(1, bytes_saved // 3 + 1) if bytes_saved > 0 else 0,
        bytes_saved=bytes_saved,
        detail=f"{file_target.rel_path}::{item_part}",
    )

    cross_project = (
        file_target.project != file_target.current_project
        and file_target.current_project is not None
    )
    if json_output:
        out: dict[str, object] = {k: v for k, v in result.items() if k not in _INTERNAL_RESULT_FIELDS}
        if cross_project:
            out["_project_root"] = str(file_target.project.root)
        typer.echo(json_compact(out))
        return

    if cross_project:
        typer.echo(f"[from project: {file_target.project.root}]", err=True)
    _emit_text_result(result["text"], file_target.rel_path, item_part, "lines", no_header)


def read(
    target: str = typer.Argument(..., help="<file>::<symbol|N-M> — e.g., 'parser.py::index_project', 'auth.py::Session.refresh' for a method, or 'parser.py::100-200' (also '@100-200') for a line range."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after the symbol body. Context lines are visually distinguished on TTY output."),
    no_header: bool = typer.Option(False, "--no-header", help="Suppress the '## path — symbol: name' header line (auto-suppressed in non-TTY contexts)"),
    header: bool = typer.Option(False, "--header", help="Force the '## path — symbol: name' header even in non-TTY contexts"),
    no_color: bool = typer.Option(False, "--no-color", help="Suppress ANSI color/dim escapes (useful when piping output)"),
    full: bool = typer.Option(False, "--full", "-f", help="Return the complete symbol body without smart truncation (bypasses the 60-line threshold)."),
) -> None:
    """Read just <symbol> from <file>, not the whole file.

    Accepts a symbol name (``file::MyFunc``), a qualified method
    (``file::Class.method``), or a line range (``file::100-200``).

    In agent/capture contexts (non-TTY stdout) the path header is suppressed
    by default to avoid paying ~10 tokens per call for information the agent
    already has.  Pass ``--header`` to force it on, or ``--no-header`` to
    force it off regardless of TTY state.

    Long symbol bodies (> 60 lines) are smart-truncated by default: the
    signature, optional docstring, first 15 body lines, an ellipsis comment,
    and last 5 lines are shown.  Pass ``--full`` (``-f``) to bypass truncation.
    """
    _no_header = no_header or (not header and not sys.stdout.isatty())

    # Route line-range syntax ``file::N-M`` to a dedicated handler that skips
    # the symbol DB entirely and slices the file directly by line numbers.
    if "::" in target:
        _, _, item_part = target.rpartition("::")
        if read_replacement.parse_line_range(item_part) is not None:
            _run_read_line_range(
                target=target,
                session_id=session_id,
                json_output=json_output,
                no_header=_no_header,
            )
            return

    _run_read_like_command(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        separator_label="symbol",
        missing_label="Symbol",
        stat_kind="read_replacement",
        reader=read_replacement.read_symbol,
        no_header=_no_header,
        no_color=no_color,
        full=full,
    )


def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'. Append #N to disambiguate duplicate headings, e.g. 'doc.md::Setup#2'."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after the section body. Context lines are visually distinguished on TTY output."),
    no_header: bool = typer.Option(False, "--no-header", help="Suppress the '## path — heading: name' header line (auto-suppressed in non-TTY contexts)"),
    header: bool = typer.Option(False, "--header", help="Force the '## path — heading: name' header even in non-TTY contexts"),
    no_color: bool = typer.Option(False, "--no-color", help="Suppress ANSI color/dim escapes (useful when piping output)"),
) -> None:
    """Extract just <heading> section from <file>, not the whole file.

    In agent/capture contexts (non-TTY stdout) the path header is suppressed
    by default to avoid paying ~10 tokens per call for information the agent
    already has.  Pass ``--header`` to force it on, or ``--no-header`` to
    force it off regardless of TTY state.
    """
    _run_read_like_command(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        separator_label="heading",
        missing_label="Section",
        stat_kind="section_replacement",
        reader=read_replacement.read_section,
        no_header=no_header or (not header and not sys.stdout.isatty()),
        no_color=no_color,
    )


def skill_section(
    skill_name: str,
    heading: str,
    session_id: str | None = None,
    json_output: bool = False,
    context_lines: int = 0,
    no_header: bool = False,
    no_color: bool = False,
) -> None:
    """Extract a named heading section from an installed or cached skill file.

    Resolution order:

    1. Resolve *skill_name* to its on-disk path (checking the skill body cache
       ``source_path`` first, then ``~/.claude/skills/<name>/SKILL.md`` and
       plugin install locations).  When found, read the file from disk.
    2. **Skill-cache fallback**: when the disk file is not found (e.g. after a
       ``uv tool install --reinstall``) but a cached skill body exists from this
       or a previous session, extract the section from the cached body without
       touching the filesystem.  The section content is identical — the cache
       stores the full body verbatim.

    Does not require the skill file to be indexed in the token-goat DB.

    When neither disk nor cache can provide the skill, emits a human-readable
    error and exits with code 1, including a hint to index via
    ``token-goat index --root ~/.claude/skills/``.
    """
    import typer

    from . import compact as _compact
    from . import db as _db
    from . import skill_cache

    body: str | None = None
    source_label: str = f"skills/{skill_name}"

    # Strategy 1: resolve to an on-disk file and read it.
    skill_path = skill_cache.get_skill_file_path(skill_name)
    if skill_path is not None:
        try:
            body = skill_path.read_text(encoding="utf-8", errors="replace")
            source_label = str(skill_path)
        except OSError as exc:
            _emit_read_error(
                code="skill_read_error",
                message=f"Could not read skill file '{skill_path}': {exc}",
                json_output=json_output,
            )
            raise typer.Exit(1) from None

    # Strategy 2: fall back to the skill body cache when the disk file is
    # unavailable.  This handles the common case where the skill was loaded in
    # a prior or current session but the SKILL.md is no longer reachable (e.g.
    # the tool was reinstalled and the venv path changed).
    if body is None:
        for candidate in skill_cache.lookup_all_by_name(skill_name):
            cached_body = skill_cache.load_output(candidate.output_id)
            if cached_body is not None:
                body = cached_body
                source_label = f"cache:{candidate.output_id[:16]}"
                break

    if body is None:
        _emit_read_error(
            code="skill_not_found",
            message=(
                f"Skill '{skill_name}' not found on disk or in cache. "
                "Index with: token-goat index --root ~/.claude/skills/"
            ),
            json_output=json_output,
        )
        raise typer.Exit(1)

    section_text = skill_cache.extract_named_section(body, heading)
    if section_text is None:
        all_headings = skill_cache.extract_all_headings(body, max_level=4)
        if all_headings:
            heading_labels = [
                f"    {title}" if level >= 4 else (f"  {title}" if level >= 3 else title)
                for level, title in all_headings
            ]
            msg = (
                f"Section {heading!r} not found in skill {skill_name!r}. "
                f"Available (##, ###, ####): {', '.join(heading_labels)}"
            )
        else:
            msg = f"Section {heading!r} not found in skill {skill_name!r} (no headings detected)"
        _emit_read_error(
            code="section_not_found",
            message=msg,
            json_output=json_output,
        )
        raise typer.Exit(1)

    body_bytes = len(body.encode())
    returned_bytes = len(section_text.encode())
    saved_bytes = max(0, body_bytes - returned_bytes)
    _tokens_saved = max(0, _compact.estimate_tokens(body) - _compact.estimate_tokens(section_text))
    _db.record_stat(
        None,
        "section_replacement",
        bytes_saved=saved_bytes,
        tokens_saved=_tokens_saved,
        detail=f"{skill_name[:40]}::{heading[:16]}",
    )

    if json_output:

        payload: dict[str, object] = {
            "ok": True,
            "skill_name": skill_name,
            "heading": heading,
            "source": source_label,
            "text": section_text,
            "body_bytes": body_bytes,
        }
        typer.echo(json_compact(payload))
        return

    rel_label = f"skills/{skill_name}"
    _emit_text_result(
        section_text,
        rel_label,
        heading,
        "heading",
        no_header or not sys.stdout.isatty(),
        context_before=0,
        context_after=0,
        no_color=no_color,
    )


# Symbol kinds worth including in a skeleton view.  Excludes variables, imports,
# and other non-structural items that add noise without aiding navigation.
_STUB_VIEW_INCLUDE_KINDS: frozenset[str] = frozenset({
    "function", "method", "class", "interface", "struct", "trait", "enum",
    "type_alias", "constructor", "property", "decorator",
})

# Cap on symbols listed; large files with 200+ symbols still produce a useful
# skeleton without hitting context limits.
_STUB_VIEW_MAX_SYMBOLS: int = 80

#: Internal stat fields stored in ``SymbolResult`` / ``SectionResult`` dicts that
#: are never forwarded to callers — they drive savings accounting only.
#: Defined once here to avoid repeating the same tuple in every JSON-emission site.
_INTERNAL_RESULT_FIELDS: frozenset[str] = frozenset({"bytes_total", "bytes_extracted", "ambiguous_at_lines"})


def _format_stub_line(name: str, kind: str, line: int, signature: str | None) -> str:
    """Render one symbol entry for the skeleton view."""
    sig = f"  {signature}" if signature else ""
    return f"  {line:>5}  {kind:<12}  {name}{sig}"


# ---------------------------------------------------------------------------
# outline — top-level symbol list with docstring first-lines
# ---------------------------------------------------------------------------

# Maximum characters to show from a docstring first-line before truncating.
_OUTLINE_DOCSTRING_MAX_CHARS: int = 80

# How many lines past the symbol start line to scan for a docstring.
_OUTLINE_DOCSTRING_SCAN_LINES: int = 5

# Symbol kinds included in the outline view (same as skeleton but used
# independently so the two commands can diverge independently in future).
_OUTLINE_INCLUDE_KINDS: frozenset[str] = frozenset({
    "function", "async_function", "class", "interface", "struct", "trait",
    "enum", "type_alias", "constructor",
})

# Kinds treated as depth-1 (nested / member symbols) for --max-depth filtering.
# Since the DB stores all symbols at parent_id=NULL, we use the kind field to
# infer logical depth: methods and constructors are depth-1 (inside a class),
# everything in _OUTLINE_INCLUDE_KINDS is depth-0.
_OUTLINE_DEPTH1_KINDS: frozenset[str] = frozenset({
    "method", "constructor",
})

# All kinds that may be shown at any depth (union of depth-0 and depth-1 kinds).
_OUTLINE_ALL_KINDS: frozenset[str] = _OUTLINE_INCLUDE_KINDS | _OUTLINE_DEPTH1_KINDS

# Maximum top-level symbols to list; a single file rarely has more than this
# in practice, but the cap prevents OOM on pathological auto-generated files.
_OUTLINE_MAX_SYMBOLS: int = 200


def _extract_docstring_first_line(
    source_lines: list[str],
    symbol_start: int,
    symbol_end: int,
) -> str | None:
    """Return the first meaningful line of the symbol's docstring, or None.

    *source_lines* is the full file content as a list (1-indexed via [line-1]).
    *symbol_start* and *symbol_end* are 1-based line numbers.

    Scans up to :data:`_OUTLINE_DOCSTRING_SCAN_LINES` lines starting from
    ``symbol_start + 1`` (the line after the def/class header).  Recognises
    Python triple-quote docstrings and single-line doc comments
    (``//``, ``#``, ``/*``, ``*``).  Returns ``None`` when nothing
    docstring-like is found within the scan window.
    """
    scan_end = min(symbol_start + _OUTLINE_DOCSTRING_SCAN_LINES, symbol_end, len(source_lines))
    inside_triple_quote = False
    for lineno in range(symbol_start + 1, scan_end + 1):
        raw = source_lines[lineno - 1]
        stripped = raw.strip()
        if not stripped:
            continue

        # Python triple-quote: """..., '''...
        for q in ('"""', "'''"):
            if stripped.startswith(q):
                # Could be one-liner: """text""" or opening of multi-line block.
                inner = stripped[3:]
                # Remove trailing closing quote if present (one-liner).
                if inner.endswith(q):
                    inner = inner[:-3]
                content = inner.strip()
                if content:
                    return content[:_OUTLINE_DOCSTRING_MAX_CHARS]
                # Empty opening line of multi-line triple-quote — mark that we
                # are inside a block so subsequent lines are treated as body.
                inside_triple_quote = True
                break
        else:
            # No triple-quote match on this line.
            if inside_triple_quote:
                # We already entered a triple-quote block — this line is body text.
                # Stop if it looks like a closing quote line (""" alone).
                if stripped not in ('"""', "'''"):
                    return stripped[:_OUTLINE_DOCSTRING_MAX_CHARS]
                # Closing quote with no body text — no docstring.
                return None

            # Single-line doc comment styles: // #
            for prefix in ("//", "#"):
                if stripped.startswith(prefix):
                    content = stripped[len(prefix):].strip()
                    if content:
                        return content[:_OUTLINE_DOCSTRING_MAX_CHARS]
            # Block-comment styles: /** or /* or leading *
            if stripped.startswith(("/**", "/*")):
                inner = stripped[stripped.index("*") + 1:].strip().lstrip("*").strip()
                if inner and not inner.startswith("/"):
                    return inner[:_OUTLINE_DOCSTRING_MAX_CHARS]
            if stripped.startswith("*") and not stripped.startswith("*/"):
                inner = stripped[1:].strip()
                if inner:
                    return inner[:_OUTLINE_DOCSTRING_MAX_CHARS]
            # First non-comment, non-empty line that doesn't match any doc pattern
            # means there is no docstring — stop scanning.
            break
    return None


def _format_outline_line(
    name: str,
    kind: str,
    start_line: int,
    end_line: int,
    docstring_line: str | None,
    depth: int = 0,
    show_line_count: bool = True,
) -> str:
    """Render one symbol entry for the outline view.

    Format: ``  L1-L2  kind            name  (N lines)  # docstring first line``

    The kind column is left-padded to 16 chars so names align regardless
    of kind length (``async_function`` is the longest at 14 chars).
    Nested symbols are indented by ``depth * 2`` spaces.
    """
    indent = "  " * depth
    range_str = f"{start_line}-{end_line}"
    line_count = end_line - start_line + 1
    count_part = f"  ({line_count} lines)" if show_line_count else ""
    doc_part = f"  # {docstring_line}" if docstring_line else ""
    return f"{indent}  {range_str:<10}  {kind:<16}  {name}{count_part}{doc_part}"


def outline(
    file: str,
    json_output: bool = False,
    max_depth: int | None = None,
    quiet: bool = False,
    min_lines: int = 0,
) -> None:
    """List symbols in <file> with line ranges, line counts, and docstring hints.

    Returns a compact structured list of symbols in the file — kind, name, line
    range, line count, and the first line of each symbol's docstring if one
    exists.  By default only top-level symbols are shown.

    Use ``--max-depth N`` (N >= 1) to include nested symbols up to N levels deep
    (e.g. ``--max-depth 2`` also shows methods inside classes).

    Use ``--min-lines N`` to show only symbols whose body spans at least N lines.
    Useful for finding large functions worth reading.

    Use ``token-goat read <file>::<symbol>`` to retrieve any symbol body.
    """
    target = _resolve_file_target(file)
    if target.project is None or target.rel_path is None:
        over_cap = over_cap_file_hint(file, target.current_project)
        if over_cap is not None:
            typer.echo(over_cap)
            raise typer.Exit(1)
        typer.echo(f"File not found in any indexed project: {file}")
        hint = _not_indexed_hint(target.current_project.hash) if target.current_project else None
        if hint:
            typer.echo(hint)
        raise typer.Exit(1)

    proj = target.project
    file_rel = target.rel_path

    # Normalise max_depth: None or 0 → top-level only (depth 0); 1 → also
    # include depth-1 symbols (methods/constructors), etc.
    # Note: the DB stores all symbols with parent_id=NULL because the indexer
    # does not write parent FKs.  We infer logical depth from the `kind` field:
    #   depth 0 — function, async_function, class, interface, struct, …
    #   depth 1 — method, constructor
    effective_max_depth = 0 if max_depth is None or max_depth <= 0 else max_depth

    with db.open_project_readonly(proj.hash) as conn:
        try:
            rows = conn.execute(
                "SELECT name, kind, line, end_line "
                "FROM symbols "
                "WHERE file_rel = ? AND end_line IS NOT NULL "
                "ORDER BY line",
                (file_rel,),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []

    # Assign logical depth based on kind and apply max_depth filter.
    def _kind_depth(kind: str) -> int:
        return 1 if kind in _OUTLINE_DEPTH1_KINDS else 0

    rows_with_depth = [
        (row, _kind_depth(row["kind"]))
        for row in rows
        if row["kind"] in _OUTLINE_ALL_KINDS and _kind_depth(row["kind"]) <= effective_max_depth
    ]

    # Apply --min-lines filter: only retain symbols whose body spans >= min_lines.
    if min_lines > 0:
        rows_with_depth = [
            (row, depth)
            for row, depth in rows_with_depth
            if (int(row["end_line"]) - int(row["line"]) + 1) >= min_lines
        ]

    if not rows_with_depth:
        if json_output:
            typer.echo(json_compact(
                {"file": file_rel, "symbols": [], "results": [], "total": 0},
            ))
        elif not quiet:
            if db.count_symbols_for_file(proj.hash, file_rel) == 0:
                typer.echo(no_indexed_symbols_note(file_rel))
            else:
                typer.echo(f"No indexed top-level symbols found for {file_rel}.")
                typer.echo("(Run `token-goat index --full` if this file has not been indexed yet.)")
        return

    filtered = rows_with_depth[:_OUTLINE_MAX_SYMBOLS]

    if not filtered:
        # All symbols exist but none pass the kind + depth filter.
        if json_output:
            typer.echo(json_compact(
                {"file": file_rel, "symbols": [], "results": [], "total": 0},
            ))
        elif not quiet:
            typer.echo(f"No structural top-level symbols found for {file_rel}.")
        return

    # Read source lines once to extract docstrings for all symbols.
    source_lines: list[str] = []
    abs_path = proj.root / file_rel
    with contextlib.suppress(OSError):
        source_lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()

    if json_output:
        out = []
        for row, depth in filtered:
            doc = _extract_docstring_first_line(
                source_lines, int(row["line"]), int(row["end_line"]),
            ) if source_lines else None
            line_count = int(row["end_line"]) - int(row["line"]) + 1
            out.append({
                "name": row["name"],
                "kind": row["kind"],
                "start_line": row["line"],
                "end_line": row["end_line"],
                "line_count": line_count,
                "depth": depth,
                "docstring": doc,
            })
        typer.echo(json_compact(
            {"file": file_rel, "symbols": out, "results": out, "total": len(out)},
        ))
        return

    # Render lines once — reuse for display and savings accounting.
    rendered_outline: list[str] = []
    for row, depth in filtered:
        doc = _extract_docstring_first_line(
            source_lines, int(row["line"]), int(row["end_line"]),
        ) if source_lines else None
        rendered_outline.append(_format_outline_line(
            row["name"], row["kind"],
            int(row["line"]), int(row["end_line"]),
            doc, depth=depth,
        ))

    if not quiet:
        typer.echo(f"# Outline: {file_rel}  ({len(filtered)} symbols)")
    for line in rendered_outline:
        typer.echo(line)

    # Record token savings: outline costs ~5% of a full file read.
    try:
        src_bytes = abs_path.stat().st_size
        outline_bytes = sum(len(line.encode()) for line in rendered_outline)
        saved = max(0, src_bytes - outline_bytes)
        db.record_stat(None, "outline", bytes_saved=saved, tokens_saved=max(1, saved // 3 + 1) if saved > 0 else 0, detail=file_rel)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# scope — symbols in scope at a given line
# ---------------------------------------------------------------------------

# Maximum imports to list in the "Module-level imports:" section before truncating.
_SCOPE_MAX_IMPORTS: int = 15

# Symbol kinds that count as "enclosing scope" for scope resolution.
# We include all structural kinds — a variable or import at module level can also
# enclose a line if it appears before it, but for enclosing scope we want the
# function/class/method nesting chain.
_SCOPE_ENCLOSING_KINDS: frozenset[str] = frozenset({
    # Standard code constructs (Python, TypeScript, Go, Rust, Java, etc.)
    "function", "async_function", "method", "class", "interface",
    "struct", "trait", "enum", "constructor",
    # CSS / SCSS / Less — selectors, mixins, keyframes, and @rules are
    # block-scoped constructs agents navigate inside.
    "css_selector", "css_mixin", "css_keyframe", "css_rule",
    # SQL — only statement-body kinds (functions, procedures, triggers have
    # procedural bodies).  Tables and views are definition containers that
    # agents frequently navigate inside too.
    "sql_function", "sql_procedure", "sql_trigger",
    "sql_table", "sql_view",
    # GraphQL — all definition blocks have a body.
    "graphql_type", "graphql_interface", "graphql_input", "graphql_enum",
    "graphql_union", "graphql_fragment", "graphql_query",
    "graphql_mutation", "graphql_subscription", "graphql_extend",
    # Makefile — targets and define blocks are procedural scopes.
    "makefile_target", "makefile_define",
})


def scope(
    target: str,
    json_output: bool = False,
) -> None:
    """Show what symbols are in scope at <file>:<line>.

    Accepts ``src/foo.py:42`` or an absolute path with a colon-separated line number.
    Returns:
    - **Enclosing scope** — function/class chain enclosing the line, outermost first.
    - **Module-level imports** — up to 15 imports at the top of the file.
    - **Suggestion** — a ``token-goat read`` command to read the innermost enclosing function.
    """
    # Parse <file>:<line>
    if ":" not in target:
        typer.echo(
            "Error: target must be '<file>:<line>' — e.g., 'src/foo.py:42'",
            err=True,
        )
        raise typer.Exit(2)

    # Split on the last colon to allow absolute Windows paths like C:\foo\bar.py:42
    last_colon = target.rfind(":")
    file_part = target[:last_colon]
    line_part = target[last_colon + 1:]

    # Validate line number
    try:
        target_line = int(line_part)
        if target_line < 1:
            raise ValueError("must be >= 1")
    except ValueError:
        typer.echo(
            f"Error: line number must be a positive integer, got '{line_part}'",
            err=True,
        )
        raise typer.Exit(2) from None

    # Resolve file
    file_target = _resolve_file_target(file_part)
    if file_target.rel_path is None:
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        raise typer.Exit(0)

    assert file_target.project is not None
    proj = file_target.project
    file_rel = file_target.rel_path

    # Query DB
    enclosing_rows: list = []
    import_rows: list = []
    out_of_range = False

    with db.open_project_readonly(proj.hash) as conn:
        # Find total line count to check if target_line is out of range
        try:
            file_row = conn.execute(
                "SELECT line_count FROM files WHERE rel_path = ?",
                (file_rel,),
            ).fetchone()
            if file_row is not None and file_row["line_count"] is not None and target_line > file_row["line_count"]:
                out_of_range = True
        except (sqlite3.OperationalError, TypeError):
            pass

        # Find enclosing symbols: all symbols whose range spans the target line,
        # filtered to structural kinds, ordered outermost→innermost.
        try:
            enclosing_rows = conn.execute(
                "SELECT name, kind, line, end_line "
                "FROM symbols "
                "WHERE file_rel = ? "
                "  AND line <= ? AND end_line >= ? "
                "  AND end_line IS NOT NULL "
                "ORDER BY line ASC",
                (file_rel, target_line, target_line),
            ).fetchall()
        except sqlite3.OperationalError:
            enclosing_rows = []

        # Filter to structural enclosing kinds
        enclosing_rows = [r for r in enclosing_rows if r["kind"] in _SCOPE_ENCLOSING_KINDS]

        # Find module-level imports from imports_exports table
        try:
            import_rows = conn.execute(
                "SELECT target, line "
                "FROM imports_exports "
                "WHERE file_rel = ? AND kind = 'import' "
                "ORDER BY line ASC",
                (file_rel,),
            ).fetchall()
        except sqlite3.OperationalError:
            import_rows = []

    if out_of_range:
        warn_msg = (
            f"Warning: line {target_line} is beyond the end of {file_rel}; "
            "showing module-level scope only."
        )
        if json_output:
            _LOG.warning(warn_msg)
        else:
            typer.echo(warn_msg, err=True)
        enclosing_rows = []

    # Determine the innermost enclosing function (for the suggestion)
    innermost_fn: str | None = None
    for row in reversed(enclosing_rows):
        if row["kind"] in ("function", "async_function", "method"):
            innermost_fn = row["name"]
            break

    # Truncate imports list
    total_imports = len(import_rows)
    display_imports = import_rows[:_SCOPE_MAX_IMPORTS]
    truncated_imports = total_imports - len(display_imports)

    if json_output:
        enclosing_out = [
            {
                "name": row["name"],
                "kind": row["kind"],
                "start_line": row["line"],
                "end_line": row["end_line"],
            }
            for row in enclosing_rows
        ]
        imports_out = [r["target"] for r in display_imports]
        result: dict[str, object] = {
            "file": file_rel,
            "line": target_line,
            "enclosing": enclosing_out,
            "imports": imports_out,
        }
        if truncated_imports:
            result["imports_truncated"] = truncated_imports
        if innermost_fn:
            result["suggestion"] = f'token-goat read "{file_rel}::{innermost_fn}"'
        typer.echo(json_compact(result))
        return

    # Text output
    typer.echo(f"# Scope at {file_rel}:{target_line}")
    typer.echo("")

    typer.echo("Enclosing scope:")
    if enclosing_rows:
        for row in enclosing_rows:
            typer.echo(f"  {row['kind']:<16}  {row['name']}  (lines {row['line']}–{row['end_line']})")
    else:
        typer.echo("  (module level — no enclosing function or class)")

    typer.echo("")
    typer.echo("Module-level imports:")
    if display_imports:
        for imp in display_imports:
            typer.echo(f"  {imp['target']}")
        if truncated_imports:
            typer.echo(f"  ... and {truncated_imports} more")
    else:
        typer.echo("  (none)")

    if innermost_fn:
        typer.echo("")
        typer.echo(f'Suggestion: token-goat read "{file_rel}::{innermost_fn}"')


# Cap on how many indexed paths a directory listing prints, so pointing
# ``skeleton`` at a large directory cannot dump thousands of lines and defeat
# the token-saving purpose of token-goat.
_DIR_LISTING_MAX = 200


def _all_indexed_projects() -> list[Project]:
    """Return every project recorded in the global index DB (fail-soft).

    Used to resolve a directory argument that lives outside the cwd project
    (e.g. ``~/.claude/skills/...``).  Any DB error yields an empty list so the
    caller falls back to the standard "not found" path instead of crashing.
    """
    try:
        with db.open_global_readonly() as gconn:
            rows = gconn.execute("SELECT hash, root, marker FROM projects").fetchall()
    except (FileNotFoundError, OSError, sqlite3.Error):
        return []
    except Exception:
        return []
    projects: list[Project] = []
    for row in rows:
        try:
            projects.append(Project(root=Path(row["root"]), hash=row["hash"], marker=row["marker"]))
        except (KeyError, TypeError, ValueError):
            continue
    return projects


def _indexed_paths_under(project: Project, prefix: str) -> list[str]:
    """Return indexed rel_paths in *project* that live under directory *prefix*.

    *prefix* must already be normalised to forward slashes and end with ``/``.
    Matching is a case-sensitive prefix on the stored project-relative path,
    using a LIKE with escaped wildcards so ``_`` in paths is matched literally.
    """
    like = read_replacement._escape_like_pattern(prefix) + "%"
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' ORDER BY rel_path",
                (like,),
            ).fetchall()
    except (sqlite3.Error, OSError):
        return []
    return [str(row["rel_path"]) for row in rows]


def _indexed_dir_listing(file_part: str, target: _FileTarget) -> list[str] | None:
    """Treat *file_part* as a directory and list indexed files beneath it.

    Returns:
        * ``None`` when *file_part* is not a directory — it is neither a real
          filesystem directory nor a path prefix shared by any indexed file.
          Callers fall back to the standard "File not found" error (exit 1).
        * An empty list when *file_part* names a real directory that holds no
          indexed files.
        * A sorted list of project-relative paths indexed beneath the directory.
    """
    norm = file_part.replace("\\", "/").strip().rstrip("/")
    if not norm:
        return None
    prefix = norm + "/"

    # Search the cwd project first, then every other indexed project so that a
    # directory outside the current repo still resolves.
    seen_hashes: set[str] = set()
    projects: list[Project] = []
    if target.current_project is not None:
        projects.append(target.current_project)
        seen_hashes.add(target.current_project.hash)
    for proj in _all_indexed_projects():
        if proj.hash not in seen_hashes:
            projects.append(proj)
            seen_hashes.add(proj.hash)

    matches: list[str] = []
    for proj in projects:
        found = _indexed_paths_under(proj, prefix)
        if found:
            matches = found
            break

    if matches:
        return sorted(set(matches))

    # No indexed files beneath the prefix — is it a real filesystem directory?
    with contextlib.suppress(OSError):
        if Path(file_part).is_dir():
            return []
    return None


def _echo_dir_listing(file_part: str, files: list[str]) -> None:
    """Print the indexed-directory result for *file_part* to stdout (exit 0)."""
    if not files:
        typer.echo(f"token-goat: '{file_part}' is a directory with no indexed files.")
        return
    shown = files[:_DIR_LISTING_MAX]
    typer.echo(f"token-goat: '{file_part}' is a directory. Indexed files under it:")
    for rel in shown:
        typer.echo(f"  {rel}")
    if len(files) > len(shown):
        typer.echo(f"  ... and {len(files) - len(shown)} more (showing first {len(shown)} of {len(files)}).")


def stub_view(
    file: str,
    json_output: bool = False,
    include_private: bool = False,
) -> None:
    """Show all signatures in <file> without bodies — typically 70-90% fewer tokens.

    Queries the indexed symbol DB for the file and prints each symbol's kind,
    line number, and signature.  Use ``--private`` to include underscore-prefixed
    names.

    When *file* names a directory rather than a file, lists the indexed files
    beneath it (exit 0) instead of failing, so an agent that points ``skeleton``
    at a directory gets a useful next step rather than a dead end.
    """
    target = _resolve_file_target(file)
    if target.project is None or target.rel_path is None:
        listing = _indexed_dir_listing(file, target)
        if listing is not None:
            _echo_dir_listing(file, listing)
            return
        typer.echo(f"File not found in any indexed project: {file}")
        raise typer.Exit(1)

    proj = target.project
    file_rel = target.rel_path

    with db.open_project_readonly(proj.hash) as conn:
        try:
            rows = conn.execute(
                "SELECT name, kind, line, signature "
                "FROM symbols "
                "WHERE file_rel = ? AND end_line IS NOT NULL "
                "ORDER BY line",
                (file_rel,),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []

    if not rows:
        typer.echo(f"No indexed symbols found for {file_rel}.")
        return

    filtered = [
        row for row in rows
        if row["kind"] in _STUB_VIEW_INCLUDE_KINDS
        and (include_private or not str(row["name"]).startswith("_"))
    ][:_STUB_VIEW_MAX_SYMBOLS]

    if not filtered:
        if json_output:
            typer.echo(json_compact({"file": file_rel, "symbols": [], "total": 0}))
        else:
            hint = " Use --private / -p to include private names." if not include_private else ""
            label = "symbols" if include_private else "public symbols"
            typer.echo(f"No {label} found for {file_rel}.{hint}")
        return

    if json_output:
        out = [
            {
                "name": row["name"],
                "kind": row["kind"],
                "line": row["line"],
                "signature": row["signature"],
            }
            for row in filtered
        ]
        typer.echo(json_compact({"file": file_rel, "symbols": out, "total": len(out)}))
        return

    abs_path = proj.root / file_rel
    try:
        with abs_path.open("rb") as _lf:
            _total_lines = sum(1 for _ in _lf)
        _file_meta = f", {_total_lines:,} lines"
    except Exception:
        _file_meta = ""

    # Render lines once — reuse for display and savings accounting.
    rendered_lines = [
        _format_stub_line(row["name"], row["kind"], row["line"], row["signature"])
        for row in filtered
    ]
    typer.echo(f"# Skeleton: {file_rel}  ({len(filtered)} symbols{_file_meta})")
    for line in rendered_lines:
        typer.echo(line)

    # Record savings: stub views cost ~5-15% of a full file read.
    try:
        src_bytes = abs_path.stat().st_size
        stub_bytes = sum(len(line.encode()) for line in rendered_lines)
        saved = max(0, src_bytes - stub_bytes)
        db.record_stat(None, "stub_view", bytes_saved=saved, tokens_saved=max(1, saved // 3 + 1) if saved > 0 else 0, detail=file_rel)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# exports — list public/exported symbols in a file
# ---------------------------------------------------------------------------


def exports(
    file: str,
    json_output: bool = False,
) -> None:
    """List public (exported) symbols from <file> with types and docstring hints.

    Returns every top-level symbol whose name does not start with ``_``.
    If the file defines ``__all__``, only names present in that list are shown.

    Output is similar to ``outline`` but filtered to the public API surface,
    labelled ``Exports:`` in the header.  Supports ``--json`` for structured
    output with the same schema as ``outline --json``.
    """
    target = _resolve_file_target(file)
    if target.project is None or target.rel_path is None:
        typer.echo(f"File not found in any indexed project: {file}")
        hint = _not_indexed_hint(target.current_project.hash) if target.current_project else None
        if hint:
            typer.echo(hint)
        raise typer.Exit(1)

    proj = target.project
    file_rel = target.rel_path

    export_rows = db.get_file_exports(proj.hash, file_rel)

    # Read source lines once to extract docstrings.
    source_lines: list[str] = []
    abs_path = proj.root / file_rel
    with contextlib.suppress(OSError):
        source_lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()

    if json_output:
        out = []
        for row in export_rows:
            start = int(row["start_line"])  # type: ignore[call-overload]
            end = int(row["end_line"]) if row["end_line"] is not None else start  # type: ignore[call-overload]
            doc = _extract_docstring_first_line(source_lines, start, end) if source_lines else None
            out.append({
                "name": row["name"],
                "kind": row["kind"],
                "start_line": start,
                "end_line": row["end_line"],
                "docstring": doc,
            })
        typer.echo(json_compact({"file": file_rel, "symbols": out}))
        return

    count = len(export_rows)
    if count == 0:
        typer.echo(f"No public symbols found for {file_rel}.")
        typer.echo("(Run `token-goat index --full` if this file has not been indexed yet.)")
        return

    typer.echo(f"# Exports: {file_rel}  ({count} public symbol{'s' if count != 1 else ''})")
    for row in export_rows:
        start = int(row["start_line"])  # type: ignore[call-overload]
        end = int(row["end_line"]) if row["end_line"] is not None else start  # type: ignore[call-overload]
        doc = _extract_docstring_first_line(source_lines, start, end) if source_lines else None
        typer.echo(_format_outline_line(str(row["name"]), str(row["kind"]), start, end, doc))

    # Record token savings: exports costs ~5% of a full file read.
    try:
        src_bytes = abs_path.stat().st_size
        export_bytes = 0
        for r in export_rows:
            sl = int(r["start_line"])  # type: ignore[call-overload]
            el = int(r["end_line"]) if r["end_line"] is not None else sl  # type: ignore[call-overload]
            export_bytes += len(_format_outline_line(str(r["name"]), str(r["kind"]), sl, el, None).encode())
        saved = max(0, src_bytes - export_bytes)
        db.record_stat(None, "exports", bytes_saved=saved, tokens_saved=max(1, saved // 3 + 1) if saved > 0 else 0, detail=file_rel)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# imports — show import graph for a file (one level deep)
# ---------------------------------------------------------------------------


def imports(
    file_target: str,
    json_output: bool = False,
) -> None:
    """Show the import graph for *file_target* one level deep.

    Two sections are emitted:

    - **Imports from** — project-internal files that this file imports.
    - **Imported by** — project-internal files that import this file.

    Only relative and intra-package imports are included; stdlib / third-party
    imports are excluded because they have no indexed ``file_rel``.

    Examples::

        token-goat imports src/token_goat/db.py
        token-goat imports read_commands.py --json
    """
    target = _resolve_file_target(file_target)
    if target.project is None or target.rel_path is None:
        typer.echo(f"File not found in any indexed project: {file_target}")
        hint = _not_indexed_hint(target.current_project.hash) if target.current_project else None
        if hint:
            typer.echo(hint)
        raise typer.Exit(1)

    proj = target.project
    file_rel = target.rel_path

    imports_from = db.get_file_imports(proj.hash, file_rel)
    imported_by = db.get_file_importers(proj.hash, file_rel)

    if json_output:
        typer.echo(json_compact(
            {
                "file": file_rel,
                "imports_from": imports_from,
                "imported_by": imported_by,
            },
        ))
        return

    typer.echo(f"Imports from ({len(imports_from)}):")
    if imports_from:
        for path in imports_from:
            typer.echo(f"  {path}")
    else:
        typer.echo("  (none)")

    typer.echo(f"Imported by ({len(imported_by)}):")
    if imported_by:
        for path in imported_by:
            typer.echo(f"  {path}")
    else:
        typer.echo("  (none)")


# ---------------------------------------------------------------------------
# refs — find all callers of a symbol defined in a specific file
# ---------------------------------------------------------------------------


def refs(
    target: str,
    limit: int = 50,
    json_output: bool = False,
    callers: bool = False,
) -> None:
    """Show all call-sites that reference a symbol defined in <file>.

    *target* must be in ``<file>::<symbol>`` format, for example::

        token-goat refs src/token_goat/hints.py::build_hint
        token-goat refs hints.py::build_hint --json
        token-goat refs hints.py::build_hint --callers

    The file part is matched as a substring (``LIKE %file%``), so short
    partial paths work.  Results are printed as ``path:line: context``
    (one per line), which replaces a multi-file ``rg`` search for callers.

    With ``--callers``, results are grouped by file and each reference shows
    the enclosing function or method name instead of just the raw line::

        index.ts:
          UserService.hello() at line 11

    This avoids a follow-up ``token-goat scope`` call per reference.
    """
    if "::" not in target:
        typer.echo(
            f"Invalid format {target!r} — expected <file>::<symbol>  "
            "(e.g. 'src/auth.py::login')",
            err=True,
        )
        raise typer.Exit(1)

    file_part, _, symbol_name = target.rpartition("::")
    symbol_name = symbol_name.strip()
    file_part = file_part.strip()

    if not file_part or not symbol_name:
        typer.echo(
            "Both <file> and <symbol> must be non-empty in <file>::<symbol>",
            err=True,
        )
        raise typer.Exit(1)

    file_target = _resolve_file_target(file_part)
    if file_target.project is None or file_target.rel_path is None:
        typer.echo(f"File not found in any indexed project: {file_part}")
        hint = _not_indexed_hint(file_target.current_project.hash) if file_target.current_project else None
        if hint:
            typer.echo(hint)
        raise typer.Exit(1)

    proj = file_target.project
    file_rel = file_target.rel_path

    if callers:
        rows = db.get_refs_with_callers(proj.hash, file_rel, symbol_name, limit=limit)
    else:
        rows = db.get_symbol_refs(proj.hash, file_rel, symbol_name, limit=limit)

    if json_output:
        # Unified envelope: query/results/total + file/symbol/refs for backward compat.
        typer.echo(json_compact(
            {
                "query": target,
                "results": rows,
                "total": len(rows),
                "file": file_rel,
                "symbol": symbol_name,
                "refs": rows,
            },
        ))
        return

    count = len(rows)
    if count == 0:
        typer.echo(f"No references found for {file_rel}::{symbol_name}")
        return

    # Record adoption stat: refs replaces a multi-file rg grep over the project.
    # Estimate bytes_saved as refs_count * ~80 bytes (file+line+context per hit);
    # this represents the grep output the agent would have had to process inline.
    # Best-effort: never block rendering on a DB write failure.
    with contextlib.suppress(Exception):
        _bytes_saved = count * 80
        db.record_stat(
            proj.hash,
            "symbol_read",
            bytes_saved=_bytes_saved,
            tokens_saved=max(1, _bytes_saved // 3 + 1),
            detail=f"{file_rel}::{symbol_name}",
        )

    typer.echo(f"{count} reference{'s' if count != 1 else ''} to {file_rel}::{symbol_name}")

    if callers:
        _render_refs_with_callers(rows)
    else:
        use_tty_color = sys.stdout.isatty()
        for row in rows:
            path = row["path"]
            line = row["line"]
            ctx = str(row["context"] or "").strip()
            loc = f"{path}:{line}"
            if ctx:
                if use_tty_color:
                    typer.echo(f"{loc}: \033[2m{ctx}\033[0m")
                else:
                    typer.echo(f"{loc}: {ctx}")
            else:
                typer.echo(loc)


def _render_refs_with_callers(rows: list[dict[str, object]]) -> None:
    """Render ``--callers`` output grouped by file.

    Each file gets a header line, then indented entries of the form::

        src/foo.py:
          bar() at line 42
          <module level> at line 10

    When the enclosing function is unknown (module-level code or unindexed
    scope), the entry reads ``<module level> at line N``.
    """
    # Group rows by path, preserving insertion order.
    from collections import OrderedDict

    groups: dict[str, list[dict[str, object]]] = OrderedDict()
    for row in rows:
        path = str(row["path"])
        groups.setdefault(path, []).append(row)

    use_tty_color = sys.stdout.isatty()
    for path, file_rows in groups.items():
        if use_tty_color:
            typer.echo(f"\033[1m{path}\033[0m:")
        else:
            typer.echo(f"{path}:")
        for row in file_rows:
            line = int(row["line"])  # type: ignore[call-overload]
            caller_name = row.get("caller_name")
            if caller_name:
                entry = f"  {caller_name}() at line {line}"
            else:
                entry = f"  <module level> at line {line}"
            if use_tty_color:
                typer.echo(f"\033[2m{entry}\033[0m")
            else:
                typer.echo(entry)


# ---------------------------------------------------------------------------
# callers — show which functions call a given symbol
# ---------------------------------------------------------------------------


def callers(
    symbol_name: str,
    *,
    json_output: bool = False,
    limit: int = 100,
) -> None:
    """Show which functions and methods call a given symbol.

    Groups results by (file, caller) — for each function that references the
    symbol, shows the file, caller name, and every reference line.

    Output format (text)::

        src/token_goat/cli.py  install() — 3 calls
          line 142: install(codex=True)
          line 156: install(opencode=True)
          line 201: install()
        src/token_goat/hooks_edit.py  setup()
          line 44: install()

    Output format (JSON)::

        [
          {
            "file": "src/token_goat/cli.py",
            "caller_name": "install",
            "caller_kind": "function",
            "calls": [
              {"line": 142, "context": "install(codex=True)"},
              ...
            ]
          },
          ...
        ]
    """
    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("No project detected — run from a project directory", err=True)
        raise typer.Exit(1)

    symbol_name = symbol_name.strip()
    if not symbol_name:
        typer.echo("Symbol name cannot be empty", err=True)
        raise typer.Exit(1)

    try:
        with db.open_project_readonly(proj.hash) as conn:
            _FUNCTION_KINDS = ("function", "async_function", "method", "constructor")
            kinds_placeholders = ",".join("?" * len(_FUNCTION_KINDS))

            rows = conn.execute(
                f"""
                SELECT
                    r.file_rel,
                    r.line,
                    r.context,
                    (
                        SELECT s.name
                        FROM symbols s
                        WHERE s.file_rel = r.file_rel
                          AND s.kind IN ({kinds_placeholders})
                          AND s.line <= r.line
                          AND (s.end_line IS NULL OR s.end_line >= r.line)
                        ORDER BY s.line DESC, s.id DESC
                        LIMIT 1
                    ) AS caller_name,
                    (
                        SELECT s.kind
                        FROM symbols s
                        WHERE s.file_rel = r.file_rel
                          AND s.kind IN ({kinds_placeholders})
                          AND s.line <= r.line
                          AND (s.end_line IS NULL OR s.end_line >= r.line)
                        ORDER BY s.line DESC, s.id DESC
                        LIMIT 1
                    ) AS caller_kind
                FROM refs r
                WHERE r.symbol_name = ?
                ORDER BY r.file_rel, r.line
                LIMIT ?
                """,
                (*_FUNCTION_KINDS, *_FUNCTION_KINDS, symbol_name, limit),
            ).fetchall()
    except FileNotFoundError:
        typer.echo(f"No callers found for {symbol_name!r}")
        if json_output:
            typer.echo(json.dumps({"query": symbol_name, "callers": []}))
        return
    except Exception as exc:
        typer.echo(f"Database error: {exc}", err=True)
        raise typer.Exit(1) from exc

    if not rows:
        typer.echo(f"No callers found for {symbol_name!r}")
        if json_output:
            typer.echo(json.dumps({"query": symbol_name, "callers": []}))
        return

    with contextlib.suppress(Exception):
        db.record_stat(
            proj.hash,
            "symbol_read",
            bytes_saved=len(rows) * 80,
            tokens_saved=max(1, len(rows) * 80 // 3 + 1),
            detail=f"callers:{symbol_name}",
        )

    if json_output:
        _render_callers_json(rows, symbol_name)
    else:
        _render_callers_text(rows, symbol_name)


def _render_callers_text(rows: list[sqlite3.Row], symbol_name: str) -> None:
    """Render callers output as grouped text."""
    grouped: dict[tuple[str, str | None], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        file_rel = str(row.file_rel)  # type: ignore[attr-defined]
        caller_name = row.caller_name  # type: ignore[attr-defined]
        grouped[(file_rel, caller_name)].append({
            "line": int(row.line),  # type: ignore[attr-defined]
            "context": str(row.context or "").strip(),  # type: ignore[attr-defined]
        })

    use_tty_color = sys.stdout.isatty()
    for (file_rel, caller_name), calls in grouped.items():
        caller_label = f"{caller_name}()" if caller_name else "<module level>"
        num_calls = len(calls)
        if use_tty_color:
            typer.echo(f"\033[1m{file_rel}\033[0m  {caller_label} — {num_calls} call{'s' if num_calls != 1 else ''}")
        else:
            typer.echo(f"{file_rel}  {caller_label} — {num_calls} call{'s' if num_calls != 1 else ''}")

        for call in calls:
            line_num = call["line"]
            ctx = call["context"]
            if ctx:
                if use_tty_color:
                    typer.echo(f"  line {line_num}: \033[2m{ctx}\033[0m")
                else:
                    typer.echo(f"  line {line_num}: {ctx}")
            else:
                typer.echo(f"  line {line_num}")


def _render_callers_json(rows: list[sqlite3.Row], symbol_name: str) -> None:
    """Render callers output as JSON."""
    grouped: dict[tuple[str, str | None, str | None], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        file_rel = str(row.file_rel)  # type: ignore[attr-defined]
        caller_name = row.caller_name  # type: ignore[attr-defined]
        caller_kind = row.caller_kind  # type: ignore[attr-defined]
        grouped[(file_rel, caller_name, caller_kind)].append({
            "line": int(row.line),  # type: ignore[attr-defined]
            "context": str(row.context or "").strip(),  # type: ignore[attr-defined]
        })

    result = []
    for (file_rel, caller_name, caller_kind), calls in grouped.items():
        result.append({
            "file": file_rel,
            "caller_name": caller_name if caller_name is None else str(caller_name),
            "caller_kind": caller_kind if caller_kind is None else str(caller_kind),
            "calls": calls,
        })

    typer.echo(json_compact({"query": symbol_name, "callers": result}))


# ---------------------------------------------------------------------------
# call_chain — multi-level caller traversal
# ---------------------------------------------------------------------------


def _callers_of(
    conn: sqlite3.Connection,
    symbol_name: str,
    limit: int,
) -> list[tuple[str, str | None, int]]:
    """Return (file_rel, caller_name_or_None, call_count) for each direct caller."""
    _FK = ("function", "async_function", "method", "constructor")
    kp = ",".join("?" * len(_FK))
    rows = conn.execute(
        f"""
        SELECT r.file_rel,
               (SELECT s.name FROM symbols s
                WHERE s.file_rel = r.file_rel AND s.kind IN ({kp})
                  AND s.line <= r.line AND (s.end_line IS NULL OR s.end_line >= r.line)
                ORDER BY s.line DESC, s.id DESC LIMIT 1) AS cname,
               COUNT(*) AS n
        FROM refs r
        WHERE r.symbol_name = ?
        GROUP BY r.file_rel, cname
        ORDER BY n DESC
        LIMIT ?
        """,
        (*_FK, symbol_name, limit),
    ).fetchall()
    return [(str(r[0]), str(r[1]) if r[1] is not None else None, int(r[2])) for r in rows]


def _build_chain(
    conn: sqlite3.Connection,
    target: str,
    depth: int,
    per_level_limit: int,
    path: frozenset[str],
) -> list[dict[str, object]]:
    if depth <= 0 or not target:
        return []
    nodes: list[dict[str, object]] = []
    for file_rel, cname, count in _callers_of(conn, target, per_level_limit):
        display = cname if cname else "<module>"
        node_key = f"{file_rel}::{display}"
        if node_key in path:
            continue
        sub = _build_chain(conn, cname or "", depth - 1, per_level_limit, path | {node_key})
        nodes.append({"symbol": display, "file": file_rel, "calls": count, "callers": sub})
    return nodes


def _render_chain_text(nodes: list[dict[str, object]], prefix: str) -> None:
    use_color = sys.stdout.isatty()
    for node in nodes:
        sym = str(node["symbol"])
        file_rel = str(node["file"])
        n = cast(int, node["calls"])
        call_word = "call" if n == 1 else "calls"
        if use_color:
            typer.echo(f"{prefix}\033[1m{sym}\033[0m  \033[2m{file_rel}\033[0m  {n} {call_word}")
        else:
            typer.echo(f"{prefix}{sym}  {file_rel}  {n} {call_word}")
        sub = cast(list[dict[str, object]], node.get("callers") or [])
        if sub:
            _render_chain_text(sub, prefix + "  ")


def call_chain(
    symbol_name: str,
    *,
    depth: int = 3,
    json_output: bool = False,
    limit: int = 10,
) -> None:
    """Show who calls a symbol, and who calls those callers, up to N levels deep.

    Traverses the caller graph starting from <name>, recursing up the call tree
    until reaching --depth levels or hitting a cycle. Useful for tracing how a
    low-level helper ripples through the codebase before changing its signature.

    Examples::

        token-goat call-chain dispatch --depth 4
        token-goat call-chain index_file --json
    """
    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("No project detected — run from a project directory", err=True)
        raise typer.Exit(1)

    symbol_name = symbol_name.strip()
    if not symbol_name:
        typer.echo("Symbol name cannot be empty", err=True)
        raise typer.Exit(1)

    try:
        with db.open_project_readonly(proj.hash) as conn:
            tree = _build_chain(conn, symbol_name, depth, limit, frozenset())
    except FileNotFoundError:
        typer.echo("No index found. Run `token-goat index` first.", err=True)
        raise typer.Exit(1) from None
    except Exception as exc:
        typer.echo(f"Database error: {exc}", err=True)
        raise typer.Exit(1) from exc

    if not tree:
        typer.echo(f"No callers found for {symbol_name!r}", err=True)
        if json_output:
            typer.echo(json_compact(
                {"query": symbol_name, "depth": depth, "tree": []},
            ))
        return

    with contextlib.suppress(Exception):
        db.record_stat(
            proj.hash,
            "symbol_read",
            bytes_saved=len(tree) * 60,
            tokens_saved=max(1, len(tree) * 20),
            detail=f"call-chain:{symbol_name}",
        )

    if json_output:
        typer.echo(json_compact(
            {"query": symbol_name, "depth": depth, "tree": tree},
        ))
        return

    use_color = sys.stdout.isatty()
    if use_color:
        typer.echo(f"\033[1mcall-chain:\033[0m {symbol_name}  (depth {depth})")
    else:
        typer.echo(f"call-chain: {symbol_name}  (depth {depth})")
    _render_chain_text(tree, prefix="  ")


# ---------------------------------------------------------------------------
# impact — blast-radius view: callers + refs + test coverage
# ---------------------------------------------------------------------------


def impact(symbol_name: str, *, json_output: bool = False) -> None:
    """Show the change impact for a symbol: immediate callers, reference count, and test coverage.

    Combines the output of callers, refs, and test-for into one concise report
    so you can assess risk before touching a symbol's signature or behavior.

    Examples::

        token-goat impact build_read_hint
        token-goat impact dispatch --json
    """
    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("No project detected — run from a project directory", err=True)
        raise typer.Exit(1)

    symbol_name = symbol_name.strip()
    if not symbol_name:
        typer.echo("Symbol name cannot be empty", err=True)
        raise typer.Exit(1)

    _FK = ("function", "async_function", "method", "constructor")

    try:
        with db.open_project_readonly(proj.hash) as conn:
            kp = ",".join("?" * len(_FK))
            caller_rows = conn.execute(
                f"""
                SELECT DISTINCT r.file_rel,
                       (SELECT s.name FROM symbols s
                        WHERE s.file_rel = r.file_rel AND s.kind IN ({kp})
                          AND s.line <= r.line AND (s.end_line IS NULL OR s.end_line >= r.line)
                        ORDER BY s.line DESC, s.id DESC LIMIT 1) AS cname
                FROM refs r
                WHERE r.symbol_name = ?
                ORDER BY r.file_rel
                """,
                (*_FK, symbol_name),
            ).fetchall()

            ref_count_row = conn.execute(
                "SELECT COUNT(*) FROM refs WHERE symbol_name = ?",
                (symbol_name,),
            ).fetchone()
            total_refs = int(ref_count_row[0]) if ref_count_row else 0

            sym_file_row = conn.execute(
                "SELECT file_rel FROM symbols WHERE name = ? ORDER BY id LIMIT 1",
                (symbol_name,),
            ).fetchone()
    except FileNotFoundError:
        typer.echo("No index found. Run `token-goat index` first.", err=True)
        raise typer.Exit(1) from None
    except Exception as exc:
        typer.echo(f"Database error: {exc}", err=True)
        raise typer.Exit(1) from exc

    test_files: list[str] = []
    if sym_file_row:
        impl_stem = Path(str(sym_file_row[0])).stem
        test_files = [rel for rel, _ in _find_test_files_for(proj, impl_stem)]

    caller_list = [
        {"file": str(r[0]), "caller": str(r[1]) if r[1] is not None else "<module>"}
        for r in caller_rows
    ]

    if json_output:
        typer.echo(json_compact(
            {
                "symbol": symbol_name,
                "direct_callers": len(caller_list),
                "ref_count": total_refs,
                "test_files": test_files,
                "callers": caller_list,
            },
        ))
        return

    use_color = sys.stdout.isatty()
    label = f"\033[1mimpact:\033[0m {symbol_name}" if use_color else f"impact: {symbol_name}"
    typer.echo(label)

    nc = len(caller_list)
    typer.echo(
        f"  {nc} direct caller{'s' if nc != 1 else ''}  •  "
        f"{total_refs} total reference{'s' if total_refs != 1 else ''}"
    )

    if caller_list:
        typer.echo("\nCallers:")
        for item in caller_list:
            file_rel = item["file"]
            cname = item["caller"]
            if use_color:
                typer.echo(f"  \033[2m{file_rel}\033[0m  {cname}")
            else:
                typer.echo(f"  {file_rel}  {cname}")

    if test_files:
        typer.echo("\nTest coverage:")
        for tf in test_files:
            typer.echo(f"  {tf}")
    elif sym_file_row:
        typer.echo("\nNo test files found.")


# ---------------------------------------------------------------------------
# changed — list symbols that changed since a git ref
# ---------------------------------------------------------------------------


def changed(
    since_ref: str = "HEAD~5",
    json_output: bool = False,
    limit: int = 50,
    symbol_mode: bool = False,
    quiet: bool = False,
) -> None:
    """List symbols that changed since *since_ref* (default ``HEAD~5``).

    Runs ``git diff --unified=0 <since_ref>..HEAD`` on Python files and
    parses each hunk header for the surrounding function or class name.
    Results are deduplicated by (file, symbol) and line counts are summed
    across multiple hunks touching the same symbol.

    When *symbol_mode* is True, queries the tree-sitter DB instead of git
    hunk context for more reliable symbol identification.  Output is grouped
    by file: ``src/auth.py: login(), logout() — 2 symbols changed``.

    Output format (text, default)::

        3 symbol changes since HEAD~5

        src/token_goat/hints.py      build_hint           +12 -3
        src/token_goat/cli.py        _extract_diff_symbols  +5 -1

    Output format (text, --symbol)::

        2 files changed since HEAD~1

        src/token_goat/hints.py: build_hint(), format_hint() — 2 symbols changed
        src/token_goat/cli.py: cmd_changed() — 1 symbol changed

    Output format (JSON)::

        {"since": "HEAD~5", "count": 2, "symbols": [...]}

    Output format (JSON, --symbol)::

        {"since": "HEAD~1", "count": 2, "files": [...]}
    """
    import os as _os

    cwd = _os.getcwd()

    if symbol_mode:
        from .git_history import get_changed_symbols_db

        file_entries = get_changed_symbols_db(cwd, since_ref=since_ref, limit=limit)

        # Record adoption stat regardless of output mode (JSON or text).
        # bytes_saved ≈ result_count * 400 — the raw diff context this replaces.
        with contextlib.suppress(Exception):
            _n = len(file_entries)
            _bs = _n * 400
            db.record_stat(
                None,
                "changed_lookup",
                bytes_saved=_bs,
                tokens_saved=max(1, _bs // 3 + 1) if _bs > 0 else 0,
                detail=f"since={since_ref} mode=symbol hits={_n}",
            )

        if json_output:
            # Unified envelope + backward-compat aliases (files/count).
            typer.echo(json_compact(
                {
                    "since": since_ref,
                    "query": since_ref,
                    "results": file_entries,
                    "total": len(file_entries),
                    "count": len(file_entries),
                    "files": file_entries,
                },
            ))
            return

        if not file_entries:
            if not quiet:
                typer.echo(f"No symbol changes since {since_ref} (--symbol mode)")
            return

        count = len(file_entries)
        noun = "file changed" if count == 1 else "files changed"
        if not quiet:
            typer.echo(f"{count} {noun} since {since_ref}")
            typer.echo("")

        for entry in file_entries:
            sym_list = entry["symbols"]
            sym_count = entry["symbol_count"]
            sym_noun = "symbol changed" if sym_count == 1 else "symbols changed"
            sym_display = ", ".join(f"{s}()" for s in sym_list)  # type: ignore[union-attr,attr-defined]
            typer.echo(f"  {entry['file']}: {sym_display} — {sym_count} {sym_noun}")
        return

    from .git_history import get_changed_symbols

    entries = get_changed_symbols(cwd, since_ref=since_ref, limit=limit)

    # Record adoption stat regardless of output mode (JSON or text).
    # bytes_saved ≈ result_count * 400 — the raw diff context this replaces.
    with contextlib.suppress(Exception):
        _n = len(entries)
        _bs = _n * 400
        db.record_stat(
            None,
            "changed_lookup",
            bytes_saved=_bs,
            tokens_saved=max(1, _bs // 3 + 1) if _bs > 0 else 0,
            detail=f"since={since_ref} mode=default hits={_n}",
        )

    if json_output:
        # Unified envelope + backward-compat aliases (symbols/count).
        typer.echo(json_compact(
            {
                "since": since_ref,
                "query": since_ref,
                "results": entries,
                "total": len(entries),
                "count": len(entries),
                "symbols": entries,
            },
        ))
        return

    if not entries:
        if not quiet:
            typer.echo(f"No symbol changes since {since_ref}")
        return

    count = len(entries)
    noun = "symbol change" if count == 1 else "symbol changes"
    if not quiet:
        typer.echo(f"{count} {noun} since {since_ref}")
        typer.echo("")

    # Compute column widths for aligned output.
    file_w = max(len(str(e["file"])) for e in entries)
    sym_w = max(len(str(e["symbol"])) for e in entries)
    # Cap widths to keep lines readable on narrow terminals.
    file_w = min(file_w, 50)
    sym_w = min(sym_w, 40)

    for entry in entries:
        file_col = str(entry["file"])[:file_w].ljust(file_w)
        sym_col = str(entry["symbol"])[:sym_w].ljust(sym_w)
        added = entry["lines_added"]
        removed = entry["lines_removed"]
        typer.echo(f"  {file_col}  {sym_col}  +{added} -{removed}")


# ---------------------------------------------------------------------------
# blame — git blame for a specific symbol's lines
# ---------------------------------------------------------------------------


def blame(
    target: str,
    json_output: bool = False,
) -> None:
    """Show git blame for the lines of *target* (``file::symbol`` format).

    Resolves the symbol's line range from the DB, then runs
    ``git blame -L start,end --porcelain`` and formats each line as::

        a1b2c3d4 (Author Name 2026-01-15) 42: def my_function():

    Args:
        target: ``"<file>::<symbol>"`` — e.g., ``"src/auth.py::login"``.
        json_output: When True, emit a JSON array of line dicts instead.

    JSON line-dict keys: ``line_no``, ``commit_hash``, ``author``, ``date``, ``content``.
    """
    import os as _os

    from .git_history import blame_symbol

    if "::" not in target:
        _emit_read_error(
            code="invalid_target",
            message="Error: target must be '<file>::<symbol>'",
            json_output=json_output,
            target=target,
            err=True,
        )
        raise typer.Exit(2)

    file_part, _, symbol_name = target.rpartition("::")
    file_part = file_part.strip()
    symbol_name = symbol_name.strip()

    if not file_part or not symbol_name:
        _emit_read_error(
            code="invalid_target",
            message="Error: both <file> and <symbol> must be non-empty",
            json_output=json_output,
            target=target,
            err=True,
        )
        raise typer.Exit(2)

    # Resolve the file to a project-relative path.
    try:
        file_target = _resolve_file_target(file_part)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(code=exc.code, message=str(exc), json_output=json_output, file_part=file_part)
        raise typer.Exit(0) from None
    except read_replacement.AmbiguousFileMatch as exc:
        _emit_ambiguous_file_match(file_part, exc.candidates, json_output=json_output)
        raise typer.Exit(0) from None

    if file_target.rel_path is None:
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        raise typer.Exit(0)

    assert file_target.project is not None
    proj = file_target.project
    file_rel = file_target.rel_path

    # Look up the symbol's line range from the DB.
    start_line: int | None = None
    end_line: int | None = None
    try:
        with db.open_project_readonly(proj.hash) as conn:
            row = conn.execute(
                "SELECT line, end_line FROM symbols "
                "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL "
                "ORDER BY line LIMIT 1",
                (file_rel, symbol_name),
            ).fetchone()
    except Exception:
        row = None

    if row is None:
        suggestions = _close_symbol_matches(proj, file_rel, symbol_name)
        base_message = f"Symbol not found: {symbol_name} (in {file_rel})"
        if suggestions and not json_output:
            base_message = base_message + "\nDid you mean:"
        _emit_read_error(
            code="symbol_not_found",
            message=base_message,
            json_output=json_output,
            candidates=suggestions,
            rel_path=file_rel,
            item=symbol_name,
        )
        raise typer.Exit(0)

    start_line = int(row["line"])
    end_line = int(row["end_line"])

    # Determine repo root (git root of the project).
    repo_root = _os.getcwd()
    if proj is not None:
        repo_root = str(proj.root)

    blame_lines = blame_symbol(repo_root, file_rel, start_line, end_line)

    if not blame_lines:
        # Git not available or file not in a git repo — graceful fallback.
        msg = f"git blame returned no output for {file_rel} lines {start_line}-{end_line}"
        if json_output:
            typer.echo(json_compact({"ok": False, "error": msg}))
        else:
            typer.echo(msg)
        raise typer.Exit(0)

    if json_output:
        typer.echo(json_compact(
            {
                "file": file_rel,
                "symbol": symbol_name,
                "start_line": start_line,
                "end_line": end_line,
                "lines": blame_lines,
            },
        ))
        return

    # Text output: "a1b2c3d4 (Author 2026-01-15) 42: content"
    hash_width = 8
    for entry in blame_lines:
        short_hash = str(entry["commit_hash"])[:hash_width]
        author = str(entry["author"])
        date = str(entry["date"])
        line_no = int(str(entry["line_no"]))
        content = str(entry["content"])
        typer.echo(f"{short_hash} ({author} {date}) {line_no}: {content}")


# ---------------------------------------------------------------------------
# test_for — find test files for an implementation file
# ---------------------------------------------------------------------------

# Maximum number of test function names shown inline in the text summary line.
# Showing all names for a 40-test file would make the line unreadable; cap at
# 10 and append "…" so the reader knows more exist.
_TEST_FOR_INLINE_CAP = 10


def _get_test_functions(project_hash: str, test_rel: str) -> list[str]:
    """Return test function names (kind='function', name starts with 'test_')
    from *test_rel* in the given project, ordered by line number.

    Returns an empty list on any DB or I/O error (fail-soft).
    """
    try:
        with db.open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT name FROM symbols "
                "WHERE file_rel = ? AND kind IN ('function', 'async_function') "
                "AND name LIKE 'test_%' "
                "ORDER BY line",
                (test_rel,),
            ).fetchall()
        return [str(r["name"]) for r in rows]
    except Exception:
        return []


def _find_test_files_for(
    proj: Project,
    module: str,
) -> list[tuple[str, str]]:
    """Return a list of ``(rel_path, source)`` pairs for test files that
    correspond to *module* (the stem of the implementation file, e.g.
    ``"read_commands"`` for ``src/token_goat/read_commands.py``).

    Heuristic search order:
    a. ``tests/test_{module}.py`` — canonical pytest layout.
    b. ``test_{module}.py`` in any indexed directory (sibling-test layout).
    c. Any indexed ``.py`` file whose path begins with ``test`` and whose DB
       symbol or refs table mentions *module* as an import target.

    ``source`` is a short label explaining which heuristic matched, e.g.
    ``"heuristic-a"`` / ``"heuristic-b"`` / ``"heuristic-c"``.

    Returns an empty list when no test files are found.
    """
    import sqlite3 as _sqlite3

    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    # Helper: add a candidate if its file actually exists and is indexed.
    def _add(rel: str, source: str) -> None:
        if rel in seen:
            return
        try:
            with db.open_project_readonly(proj.hash) as conn:
                row = conn.execute(
                    "SELECT 1 FROM files WHERE rel_path = ? LIMIT 1",
                    (rel,),
                ).fetchone()
        except (_sqlite3.Error, FileNotFoundError):
            row = None
        if row is not None:
            seen.add(rel)
            found.append((rel, source))
        else:
            # File not indexed — fall back to filesystem check so freshly
            # created test files (not yet re-indexed) are still discovered.
            abs_path = proj.root / rel
            if abs_path.is_file():
                seen.add(rel)
                found.append((rel, source))

    # Heuristic a: tests/test_{module}.py
    _add(f"tests/test_{module}.py", "heuristic-a")

    # Heuristic b: any indexed .py file at path **/test_{module}.py (excluding
    # the canonical tests/ path already tried above).
    if len(found) == 0:
        try:
            with db.open_project_readonly(proj.hash) as conn:
                rows = conn.execute(
                    "SELECT rel_path FROM files "
                    "WHERE rel_path LIKE ? AND rel_path LIKE '%.py' "
                    "ORDER BY rel_path",
                    (f"%test_{module}.py",),
                ).fetchall()
            for r in rows:
                rel = str(r["rel_path"])
                if rel not in seen:
                    seen.add(rel)
                    found.append((rel, "heuristic-b"))
        except (_sqlite3.Error, FileNotFoundError):
            pass

    # Heuristic c: any test_*.py file in the DB that imports the module.
    # We query the refs table for any symbol where caller_file matches test_*.py
    # and target_module contains the module stem.  This covers cases like
    # ``from token_goat.read_commands import foo`` in an otherwise-named test.
    if len(found) == 0:
        try:
            with db.open_project_readonly(proj.hash) as conn:
                rows = conn.execute(
                    "SELECT DISTINCT caller_file FROM refs "
                    "WHERE caller_file LIKE '%test%.py' "
                    "AND (target_module LIKE ? OR target_module LIKE ?) "
                    "ORDER BY caller_file",
                    (f"%.{module}", f"%{module}"),
                ).fetchall()
            for r in rows:
                rel = str(r["caller_file"])
                if rel not in seen:
                    seen.add(rel)
                    found.append((rel, "heuristic-c"))
        except (_sqlite3.Error, FileNotFoundError):
            pass

    return found


def test_for(
    file_target: str,
    json_output: bool = False,
) -> None:
    """Given an implementation file, find the corresponding test file(s).

    Searches for test files using the following heuristics (in order):

    a. ``tests/test_{module}.py`` where module = stem of the input file.
    b. ``test_{module}.py`` in any indexed directory (sibling layout).
    c. Any ``test_*.py`` in the project whose imports reference the module.

    For each test file found, lists its top-level test function names
    (functions whose names start with ``test_``).

    Output format (text)::

        tests/test_read_commands.py — 12 tests: test_symbol_cmd, test_read_cmd, …

    Output format (JSON)::

        {"impl": "src/token_goat/read_commands.py", "test_files": [
          {"path": "tests/test_read_commands.py", "test_count": 12,
           "tests": ["test_symbol_cmd", ...]}
        ]}
    """
    target = _resolve_file_target(file_target)
    if target.project is None or target.rel_path is None:
        typer.echo(f"File not found in any indexed project: {file_target}")
        hint = _not_indexed_hint(target.current_project.hash) if target.current_project else None
        if hint:
            typer.echo(hint)
        raise typer.Exit(1)

    proj = target.project
    impl_rel = target.rel_path

    # Derive module stem: basename without extension.
    module = Path(impl_rel).stem

    test_entries = _find_test_files_for(proj, module)

    if json_output:
        result_list = []
        for test_rel, _source in test_entries:
            fns = _get_test_functions(proj.hash, test_rel)
            result_list.append({
                "path": test_rel,
                "test_count": len(fns),
                "tests": fns,
            })
        typer.echo(json_compact(
            {"impl": impl_rel, "test_files": result_list},
        ))
        return

    if not test_entries:
        typer.echo(
            f"No test file found for {impl_rel}.\n"
            f"Expected: tests/test_{module}.py or test_{module}.py"
        )
        return

    for test_rel, _source in test_entries:
        fns = _get_test_functions(proj.hash, test_rel)
        count = len(fns)
        if count == 0:
            typer.echo(f"{test_rel} — 0 tests")
            continue
        noun = "test" if count == 1 else "tests"
        if count <= _TEST_FOR_INLINE_CAP:
            names_str = ", ".join(fns)
        else:
            names_str = ", ".join(fns[:_TEST_FOR_INLINE_CAP]) + ", …"
        typer.echo(f"{test_rel} — {count} {noun}: {names_str}")


# ---------------------------------------------------------------------------
# types — list type definitions in a file or project
# ---------------------------------------------------------------------------

# Compact kind labels for display (keeps columns narrow)
_TYPE_KIND_LABEL: dict[str, str] = {
    "TypedDict": "TypedDict",
    "Protocol": "Protocol",
    "dataclass": "dataclass",
    "namedtuple": "namedtuple",
    "NamedTuple": "NamedTuple",
    "pydantic": "pydantic",
}

# Maximum field names to inline before truncating with "…"
_TYPES_FIELDS_INLINE_CAP: int = 6


def types(
    file_target: str | None = None,
    json_output: bool = False,
) -> None:
    """List type definitions (TypedDict, Protocol, dataclass, namedtuple, Pydantic) in a file or project.

    When *file_target* is provided, restricts the search to that file.
    When omitted, searches the entire current project.

    Output (text)::

        TypedDict   MyDict          src/foo.py:10   fields: x, y, z
        dataclass   Point           src/foo.py:25   fields: x, y
        Protocol    Readable        src/bar.py:5    fields: (none)

    Output (JSON)::

        {"project": "...", "types": [
          {"name": "MyDict", "type_kind": "TypedDict", "file": "src/foo.py",
           "start_line": 10, "fields": ["x", "y", "z"]},
          ...
        ]}
    """
    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("Not inside an indexed project.")
        raise typer.Exit(1)

    # Resolve optional file target to a project-relative path (partial LIKE match filter).
    file_rel: str | None = None
    if file_target is not None:
        ft = _resolve_file_target(file_target)
        if ft.rel_path is None:
            typer.echo(f"File not found in any indexed project: {file_target}")
            hint = _not_indexed_hint(proj.hash)
            if hint:
                typer.echo(hint)
            raise typer.Exit(1)
        file_rel = ft.rel_path

    type_defs = db.get_type_definitions(proj.hash, file_path=file_rel)

    if json_output:
        scope_label = file_rel or str(proj.root)
        typer.echo(json_compact(
            {"project": scope_label, "types": type_defs},
            default=list,
        ))
        return

    if not type_defs:
        if file_rel:
            typer.echo(f"No type definitions found in {file_rel}.")
        else:
            typer.echo("No type definitions found in this project.")
        return

    # Header
    scope_desc = file_rel or "project"
    typer.echo(f"# Type definitions: {scope_desc}  ({len(type_defs)} found)\n")

    # Compute column widths for alignment
    max_kind = max(len(_TYPE_KIND_LABEL.get(str(t["type_kind"]), str(t["type_kind"]))) for t in type_defs)
    max_name = max(len(str(t["name"])) for t in type_defs)
    max_loc = max(len(f"{t['file']}:{t['start_line']}") for t in type_defs)

    for t in type_defs:
        kind_label = _TYPE_KIND_LABEL.get(str(t["type_kind"]), str(t["type_kind"]))
        name = str(t["name"])
        loc = f"{t['file']}:{t['start_line']}"
        fields: list[str] = cast("list[str]", t["fields"])
        if fields:
            if len(fields) <= _TYPES_FIELDS_INLINE_CAP:
                fields_str = ", ".join(fields)
            else:
                fields_str = ", ".join(fields[:_TYPES_FIELDS_INLINE_CAP]) + ", …"
            fields_part = f"  fields: {fields_str}"
        else:
            fields_part = "  (no annotated fields)"
        typer.echo(
            f"  {kind_label:<{max_kind}}  {name:<{max_name}}  {loc:<{max_loc}}{fields_part}"
        )


# ---------------------------------------------------------------------------
# grep — session-aware grep wrapper
# ---------------------------------------------------------------------------

# Maximum total output lines before compression kicks in.
_GREP_MAX_LINES: int = 200
# Number of leading lines to show before the "... N more ..." marker.
_GREP_HEAD_LINES: int = 100
# Number of trailing lines to show after the "... N more ..." marker.
_GREP_TAIL_LINES: int = 20


def _compress_grep_output(lines: list[str]) -> list[str]:
    """Compress *lines* to at most :data:`_GREP_MAX_LINES` lines.

    When the total line count exceeds the cap, the first
    :data:`_GREP_HEAD_LINES` lines are shown, followed by a
    ``... N more lines ...`` marker, then the last
    :data:`_GREP_TAIL_LINES` lines.

    Returns *lines* unchanged when the total is within the cap.
    """
    total = len(lines)
    if total <= _GREP_MAX_LINES:
        return lines
    omitted = total - _GREP_HEAD_LINES - _GREP_TAIL_LINES
    return [
        *lines[:_GREP_HEAD_LINES],
        f"... {omitted} more lines ...",
        *lines[total - _GREP_TAIL_LINES:],
    ]


def _grep_output_hash(output: str) -> str:
    """Return an 8-hex-char content hash for *output*.

    Used as the key in the session's ``grep_result_hashes`` dict; truncated to
    8 characters to keep the session JSON compact (collisions are astronomically
    unlikely at the scale of per-session grep results).
    """
    return hashlib.sha1(output.encode("utf-8", errors="replace"), usedforsecurity=False).hexdigest()[:8]


def grep(
    pattern: str,
    path: str = ".",
    session_id: str | None = None,
    json_output: bool = False,
) -> None:
    """Session-aware grep wrapper: run ``rg`` and cache result hashes within the session.

    On a cache hit (same pattern + path appeared in session history AND the
    result hash matches a previously seen result), prints the output with a
    ``⚡ Cached grep result (session hit)`` hint.  On a miss, runs
    ``rg {pattern} {path}``, compresses output to at most
    :data:`_GREP_MAX_LINES` lines, records the pattern + hash in the session,
    and emits the result.

    Args:
        pattern: The regex pattern to search for (forwarded verbatim to ``rg``).
        path: Directory or file to search (default: current directory).
        session_id: Session ID for cache lookup and recording.
        json_output: When True, emit a JSON object instead of plain text.
    """
    # Load session cache for history look-up.
    cache: session.SessionCache | None = None
    if session_id:
        cache = session.load(session_id)

    # Find the most-recent history entry for this pattern+path combination so
    # we can report how long ago the search was run (elapsed_seconds).
    elapsed_seconds: int = 0
    seen_before: bool = False
    if cache is not None and not cache.unavailable:
        norm_path = path or "."
        for entry in reversed(cache.greps):
            entry_path = entry.path or "."
            if entry.pattern == pattern and entry_path == norm_path:
                elapsed_seconds = max(0, int(time.time() - entry.ts))
                seen_before = True
                break

    # Run rg.
    try:
        proc = subprocess.run(
            ["rg", pattern, path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        raw_output = proc.stdout
        # rg exits 1 when there are no matches — treat as empty, not an error.
        # Exit code 2 signals an actual error.
        if proc.returncode == 2:
            error_msg = proc.stderr.strip() or "rg returned exit code 2"
            if json_output:
                typer.echo(json_compact({"ok": False, "error": error_msg}))
            else:
                typer.echo(f"grep error: {error_msg}", err=True)
            return
    except FileNotFoundError:
        error_msg = "rg (ripgrep) not found — install ripgrep to use token-goat grep"
        if json_output:
            typer.echo(json_compact({"ok": False, "error": error_msg}))
        else:
            typer.echo(error_msg, err=True)
        return

    output_lines = raw_output.splitlines()
    total_lines = len(output_lines)
    result_hash = _grep_output_hash(raw_output)

    # A cache hit requires both: (a) this pattern+path was searched before,
    # and (b) the result content hash matches a hash we stored previously.
    # Condition (b) ensures we only claim a hit when the results are identical —
    # the filesystem may have changed since the last search.
    cache_hit = False
    if seen_before and cache is not None and not cache.unavailable:
        stored_pattern = cache.get_grep_result_pattern(result_hash)
        if stored_pattern is not None:
            cache_hit = True

    compressed_lines = _compress_grep_output(output_lines)
    compressed_output = "\n".join(compressed_lines)

    if json_output:
        payload: dict[str, object] = {
            "ok": True,
            "pattern": pattern,
            "path": path,
            "total_lines": total_lines,
            "lines_shown": len(compressed_lines),
            "cache_hit": cache_hit,
            "output": compressed_output,
        }
        if cache_hit:
            payload["cache_age_seconds"] = elapsed_seconds
        typer.echo(json_compact(payload))
    else:
        if cache_hit:
            typer.echo(
                f"⚡ Cached grep result (session hit) — same results as {elapsed_seconds} seconds ago"
            )
        typer.echo(compressed_output)

    # Record the search in the session so future calls can detect duplicates.
    if session_id:
        # mark_grep returns an updated (possibly freshly loaded) cache object —
        # use that for the subsequent record_grep_result_hash + save so the
        # two mutations land in the same write.
        updated_cache = session.mark_grep(
            session_id,
            pattern,
            path=path if path != "." else None,
            result_count=total_lines,
        )
        if not updated_cache.unavailable:
            updated_cache.record_grep_result_hash(result_hash, pattern)
            session.save(updated_cache)


# ---------------------------------------------------------------------------
# recent — show N most recently edited files (session + git) with symbols
# ---------------------------------------------------------------------------


def _get_recent_git_files(project_hash: str, limit: int) -> list[tuple[str, str]]:
    """Return up to *limit* (file_rel, commit_label) pairs from recent git history.

    Reads the ``git_commits`` table ordered by recency and flattens the
    ``changed_files`` JSON array.  Returns an empty list on any failure
    (missing DB, table not yet created, etc.).  ``commit_label`` is a short
    human-readable string like "1 commit ago" or "3 commits ago".

    Each file is returned at most once (first commit wins, i.e. most recent).
    """
    import sqlite3 as _sqlite3

    from . import db as _db

    try:
        with _db.open_project_readonly(project_hash) as conn:
            try:
                rows = conn.execute(
                    "SELECT commit_short, summary, author_ts, changed_files "
                    "FROM git_commits "
                    "ORDER BY author_ts DESC "
                    "LIMIT 50",
                ).fetchall()
            except _sqlite3.OperationalError:
                # Table not yet created (history never indexed).
                return []
    except (FileNotFoundError, _sqlite3.Error, OSError):
        return []

    seen: dict[str, str] = {}  # file_rel -> label
    commit_idx = 1
    for row in rows:
        if len(seen) >= limit:
            break
        try:
            files: list[str] = json.loads(row["changed_files"] or "[]")
        except (json.JSONDecodeError, TypeError):
            files = []
        label = f"{commit_idx} commit{'s' if commit_idx > 1 else ''} ago"
        for f in files:
            if f not in seen:
                seen[f] = label
        commit_idx += 1

    return list(seen.items())[:limit]


def _symbols_for_file(project_hash: str, file_rel: str, session_cache: session.SessionCache | None) -> list[str]:
    """Return changed/accessed symbol names for *file_rel*.

    Priority: session ``symbol_access_counts`` keys matching this file first,
    then fall through to the DB symbol list as a fallback.  Only structural
    symbol kinds are included.  Returns an empty list on any failure.
    """
    symbols: list[str] = []

    # Session surgical reads: symbol_access_counts keys are "file_rel::symbol_name".
    if session_cache is not None and not session_cache.unavailable:
        prefix = f"{file_rel}::"
        for key in session_cache.symbol_access_counts:
            if key.startswith(prefix):
                sym_name = key[len(prefix):]
                if sym_name and sym_name not in symbols:
                    symbols.append(sym_name)

    if symbols:
        return symbols

    # Fallback: list indexed symbols for the file (structural kinds only).

    from . import db as _db

    _STRUCT_KINDS = frozenset({
        "function", "async_function", "method", "class", "interface",
        "struct", "trait", "enum", "type_alias",
    })
    try:
        with _db.open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                f"SELECT DISTINCT name FROM symbols "
                f"WHERE file_rel = ? AND kind IN ({','.join('?' * len(_STRUCT_KINDS))}) "
                f"ORDER BY line LIMIT 10",
                (file_rel, *_STRUCT_KINDS),
            ).fetchall()
        return [str(r["name"]) for r in rows]
    except Exception:
        return []


def recent(
    n: int = 10,
    session_id: str | None = None,
    json_output: bool = False,
) -> None:
    """Show the N most recently edited/accessed files from this session and recent git commits.

    Merges three sources in priority order:
    1. Session edited files (files modified by Write/Edit/MultiEdit this session)
    2. Session read files (files read via Read/Grep/token-goat read this session, not yet edited)
    3. Recent git commits' changed files (from the indexed git history)

    Session edits are listed first; session reads fill the next slots (marked "read this
    session" so the agent knows it already has these in context); git-history files fill
    the remainder up to *n*.  Files are deduplicated by path (highest-priority source wins).

    For each file, shows the symbol names that were surgically accessed this session
    (from ``symbol_access_counts``) or, as a fallback, the structural symbols indexed
    for that file.

    Output format (text)::

        src/token_goat/hints.py  (edited this session)
          build_high_frequency_hint, dedup_hints
        src/token_goat/session.py  (read this session)
          SessionCache, FileEntry
        src/token_goat/compact.py  (1 commit ago)
          _render, build_manifest

    Output format (JSON)::

        {"files": [
          {"path": "src/token_goat/hints.py", "source": "edited this session",
           "symbols": ["build_high_frequency_hint", "dedup_hints"]},
          {"path": "src/token_goat/session.py", "source": "read this session",
           "symbols": ["SessionCache", "FileEntry"]},
          ...
        ]}
    """
    import os as _os

    from . import project as _project

    cwd = _os.getcwd()
    proj = _project.find_project(Path(cwd))

    # Load session cache for edited_files, files (reads), and symbol_access_counts.
    sess: session.SessionCache | None = None
    if session_id:
        sess = session.load(session_id)
        if sess is not None and sess.unavailable:
            sess = None

    # --- Source 1: session edited files (most relevant, highest priority) ---
    # edited_files keys are normalized paths (may be absolute or rel).
    # Convert to project-relative where possible.
    session_entries: list[tuple[str, str]] = []  # (rel_path, source_label)
    if sess is not None:
        for raw_path in sess.edited_files:
            if proj is not None:
                try:
                    rel = Path(raw_path).relative_to(proj.root).as_posix()
                except ValueError:
                    rel = raw_path
            else:
                rel = raw_path
            session_entries.append((rel, "edited this session"))

    # --- Source 2: session read files (files read but not edited this session) ---
    # sess.files tracks every Read/Grep/token-goat read call.  Files already in
    # edited_files are skipped here (they'll appear under "edited this session").
    # Sort by most-recently read so the most relevant reads appear first.
    edited_paths_normalized: set[str] = set()
    if sess is not None:
        for raw_path in sess.edited_files:
            edited_paths_normalized.add(Path(raw_path).as_posix().lower())

    session_read_entries: list[tuple[str, str, float]] = []  # (rel_path, label, last_read_ts)
    if sess is not None and hasattr(sess, "files"):
        for file_entry in sess.files.values():
            raw_path = file_entry.rel_or_abs
            # Skip files that were also edited — they are already in Source 1.
            if Path(raw_path).as_posix().lower() in edited_paths_normalized:
                continue
            if proj is not None:
                try:
                    rel = Path(raw_path).relative_to(proj.root).as_posix()
                except ValueError:
                    rel = raw_path
            else:
                rel = raw_path
            session_read_entries.append((rel, "read this session", file_entry.last_read_ts))

    # Sort by most-recently read first so the freshest context appears at the top.
    session_read_entries.sort(key=lambda x: x[2], reverse=True)

    # --- Source 3: recent git commits ---
    git_entries: list[tuple[str, str]] = []
    if proj is not None:
        git_entries = _get_recent_git_files(proj.hash, n * 2)

    # --- Merge: session edits first, session reads second, git fills remainder ---
    seen: set[str] = set()
    merged: list[tuple[str, str]] = []  # (file_rel, source_label)

    for rel, label in session_entries:
        if rel not in seen:
            seen.add(rel)
            merged.append((rel, label))
        if len(merged) >= n:
            break

    for rel, label, _ts in session_read_entries:
        if rel not in seen and len(merged) < n:
            seen.add(rel)
            merged.append((rel, label))

    for rel, label in git_entries:
        if rel not in seen and len(merged) < n:
            seen.add(rel)
            merged.append((rel, label))

    # --- Resolve symbols for each file ---
    project_hash = proj.hash if proj is not None else ""
    results: list[dict[str, object]] = []
    for file_rel, source_label in merged:
        syms = _symbols_for_file(project_hash, file_rel, sess) if project_hash else []
        results.append({
            "path": file_rel,
            "source": source_label,
            "symbols": syms,
        })

    if json_output:
        typer.echo(json_compact({"files": results}))
        return

    if not results:
        typer.echo("No recently edited or committed files found.")
        return

    for entry in results:
        path_str = str(entry["path"])
        label = str(entry["source"])
        typer.echo(f"{path_str}  ({label})")
        syms = cast("list[str]", entry["symbols"])
        if syms:
            typer.echo(f"  {', '.join(syms)}")


def find(
    query: str,
    json_output: bool = False,
) -> None:
    """Unified search: runs symbol (exact/fuzzy) and semantic search in parallel, merges results.

    Results are presented in two sections:
    - ``Exact/fuzzy matches:`` — symbols whose name matches exactly or closely (up to 5)
    - ``Semantic matches:`` — embedding-based nearest-neighbour hits not already shown above (up to 5)

    Deduplication is by ``(file_rel, name/kind)``: a hit that appears in the symbol section
    is suppressed from the semantic section so the same location is never shown twice.

    JSON output shape::

        {
          "query": "<query>",
          "symbol_matches": [
            {"file": "...", "line": N, "kind": "...", "name": "...", "signature": "..."},
            ...
          ],
          "semantic_matches": [
            {"file": "...", "start": N, "end": N, "kind": "...", "distance": F, "preview": "..."},
            ...
          ]
        }
    """
    import os as _os

    from . import project as _project

    cwd = _os.getcwd()
    proj = _project.find_project(Path(cwd))
    if proj is None:
        typer.echo("Not inside an indexed project.  Run `token-goat index` first.")
        return

    _SECTION_LIMIT = 5

    # ------------------------------------------------------------------
    # Branch 1 — symbol (exact + fuzzy) search
    # ------------------------------------------------------------------
    sym_sql = (
        "SELECT name, kind, file_rel, line, signature "
        "FROM symbols WHERE name = ? LIMIT ?"
    )

    exact_rows = []
    fuzzy_rows: list[dict] = []
    with contextlib.suppress(db.DBError), db.open_project(proj.hash) as conn:
        exact_rows = conn.execute(sym_sql, (query, _SECTION_LIMIT * 2)).fetchall()

        if len(exact_rows) < _SECTION_LIMIT:
            # Also grab fuzzy (LIKE) matches — e.g. partial name
            like_sql = (
                "SELECT name, kind, file_rel, line, signature "
                "FROM symbols WHERE name LIKE ? AND name != ? LIMIT ?"
            )
            like_param = f"%{query}%"
            fuzzy_rows_raw = conn.execute(
                like_sql, (like_param, query, _SECTION_LIMIT * 2)
            ).fetchall()
            # Convert to dicts
            fuzzy_rows = [
                {
                    "file": r["file_rel"],
                    "line": r["line"],
                    "kind": r["kind"],
                    "name": r["name"],
                    "signature": r["signature"],
                }
                for r in fuzzy_rows_raw
            ]

    # Combine: exact first, then fuzzy, deduplicate by (file_rel, name), limit to 5
    sym_results: list[dict] = []
    seen_sym: set[tuple[str, str]] = set()
    for r in exact_rows:
        key = (r["file_rel"], r["name"])
        if key not in seen_sym:
            seen_sym.add(key)
            sym_results.append({
                "file": r["file_rel"],
                "line": r["line"],
                "kind": r["kind"],
                "name": r["name"],
                "signature": r["signature"],
            })
    for rd in fuzzy_rows:
        key = (rd["file"], rd["name"])
        if key not in seen_sym and len(sym_results) < _SECTION_LIMIT:
            seen_sym.add(key)
            sym_results.append(rd)

    sym_results = sym_results[:_SECTION_LIMIT]

    # ------------------------------------------------------------------
    # Branch 2 — semantic search
    # ------------------------------------------------------------------
    sem_results: list[dict] = []
    try:
        from . import embeddings as _embeddings

        hits = _embeddings.semantic_search(
            proj,
            query,
            k=_SECTION_LIMIT * 2,
            max_distance=_embeddings.DEFAULT_DISTANCE_THRESHOLD,
        )
        # Build dedup key set from symbol results: (file, line)
        sym_locations: set[tuple[str, int]] = {
            (r["file"], r["line"]) for r in sym_results
        }
        for h in hits:
            if len(sem_results) >= _SECTION_LIMIT:
                break
            # Suppress if the same file+line already appeared in symbol section
            if (h.file_rel, h.start_line) in sym_locations:
                continue
            sem_results.append({
                "file": h.file_rel,
                "start": h.start_line,
                "end": h.end_line,
                "kind": h.kind,
                "distance": h.distance,
                "preview": h.text[:200],
            })
    except Exception:
        pass  # Embeddings not available — semantic section stays empty

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------
    if json_output:
        typer.echo(
            json_compact(
                {
                    "query": query,
                    "symbol_matches": sym_results,
                    "semantic_matches": sem_results,
                },
            )
        )
        return

    # Plain text output
    if sym_results:
        typer.echo("Exact/fuzzy matches:")
        for r in sym_results:
            sig = f"  {r['signature']}" if r.get("signature") else ""
            typer.echo(f"  {r['file']}:{r['line']}: {r['kind']} {r['name']}{sig}")
    else:
        typer.echo("Exact/fuzzy matches: (none)")

    if sem_results:
        typer.echo("Semantic matches:")
        for r in sem_results:
            snippet = str(r.get("preview", "")).replace("\n", " ")[:100]
            typer.echo(f"  {r['file']}:{r['start']}  {snippet}")
    else:
        typer.echo("Semantic matches: (none)")


# ---------------------------------------------------------------------------
# similar
# ---------------------------------------------------------------------------


def similar(target: str, *, json_output: bool = False, top_k: int = 5) -> None:
    """Find the top-k symbols most semantically similar to ``file::symbol``.

    Args:
        target: ``"<file>::<symbol>"`` string, e.g. ``"src/auth.py::login"``.
        json_output: When True, emit JSON instead of plain text.
        top_k: Number of results to return (default 5).
    """
    from . import embeddings

    # ------------------------------------------------------------------
    # Parse target
    # ------------------------------------------------------------------
    if "::" not in target:
        typer.echo(
            "Error: target must be in 'file::symbol' format, "
            f"e.g. 'src/auth.py::login'. Got: {target!r}",
            err=True,
        )
        raise typer.Exit(code=1)

    file_part, symbol_part = target.split("::", 1)
    file_part = file_part.strip()
    symbol_part = symbol_part.strip()

    if not file_part or not symbol_part:
        typer.echo(
            "Error: both file and symbol must be non-empty in 'file::symbol'.",
            err=True,
        )
        raise typer.Exit(code=1)

    # ------------------------------------------------------------------
    # Resolve project
    # ------------------------------------------------------------------
    import os as _os

    cwd = _os.getcwd()
    proj = find_project(Path(cwd))
    if proj is None:
        typer.echo("Not inside an indexed project.  Run `token-goat index` first.")
        return

    # ------------------------------------------------------------------
    # Normalise file path to project-relative form
    # ------------------------------------------------------------------
    # Accept absolute paths or paths starting with the project root.
    input_path = Path(file_part)
    if input_path.is_absolute():
        try:
            rel_path = str(input_path.relative_to(proj.root))
        except ValueError:
            rel_path = file_part
    else:
        rel_path = file_part
    # Normalise separators to forward slashes (DB stores POSIX paths).
    rel_path = rel_path.replace("\\", "/")

    # ------------------------------------------------------------------
    # Look up symbol existence — give a helpful message if not indexed
    # ------------------------------------------------------------------
    symbol_found = False
    with contextlib.suppress(db.DBError), db.open_project(proj.hash) as conn:
        row = conn.execute(
            "SELECT 1 FROM symbols WHERE file_rel = ? AND name = ? LIMIT 1",
            (rel_path, symbol_part),
        ).fetchone()
        symbol_found = row is not None

    if not symbol_found:
        msg = (
            f"Symbol {symbol_part!r} not found in {rel_path!r}. "
            "Run `token-goat index` to (re-)index the project."
        )
        if json_output:
            typer.echo(json_compact({"error": msg, "results": []}))
        else:
            typer.echo(msg)
        return

    # ------------------------------------------------------------------
    # Find similar symbols
    # ------------------------------------------------------------------
    hits = embeddings.find_similar_symbols(
        proj.hash, rel_path, symbol_part, top_k=top_k
    )

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------
    if json_output:
        typer.echo(
            json_compact(
                {
                    "query": target,
                    "results": [
                        {
                            "file": h.file,
                            "name": h.name,
                            "kind": h.kind,
                            "similarity_score": round(h.similarity_score, 4),
                        }
                        for h in hits
                    ],
                },
            )
        )
        return

    if not hits:
        typer.echo(
            f"No similar symbols found for {target!r}. "
            "Run `token-goat index --embeddings` to build the embedding index."
        )
        return

    for h in hits:
        pct = int(round(h.similarity_score * 100))
        typer.echo(f"{h.file} — {h.name} ({h.kind}) — {pct}% similar")


# ---------------------------------------------------------------------------
# context_for — task-aware context assembly
# ---------------------------------------------------------------------------



def context_for(
    task: str,
    *,
    budget: int = 20_000,
    top: int = 8,
    json_output: bool = False,
) -> None:
    """Build a prioritized read list for a task description, respecting a token budget.

    Runs semantic search against the indexed codebase and ranks the results by
    relevance, then emits a ``token-goat read`` command list trimmed to fit
    within --budget tokens.  Use this before starting a task to pull only the
    relevant slices rather than reading entire files.

    Examples::

        token-goat context-for "add rate limiting to the API"
        token-goat context-for "fix the session cache race condition" --budget 40000
        token-goat context-for "refactor the hook dispatch" --json
    """
    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("No project detected — run from a project directory", err=True)
        raise typer.Exit(1)

    task = task.strip()
    if not task:
        typer.echo("Task description cannot be empty", err=True)
        raise typer.Exit(1)

    ctx_hits: list[dict[str, object]] = []
    used_embeddings = False
    try:
        from . import embeddings as _embeddings

        raw_hits = _embeddings.semantic_search(
            proj,
            task,
            k=top * 3,
            max_distance=_embeddings.DEFAULT_DISTANCE_THRESHOLD,
        )
        seen_files: dict[str, bool] = {}
        for h in raw_hits:
            if h.file_rel not in seen_files:
                seen_files[h.file_rel] = True
                ctx_hits.append({
                    "file_rel": h.file_rel,
                    "text": h.text,
                    "distance": h.distance,
                    "start_line": h.start_line,
                    "end_line": h.end_line,
                })
        ctx_hits = ctx_hits[:top]
        used_embeddings = True
    except Exception:
        pass

    if not ctx_hits:
        try:
            with db.open_project_readonly(proj.hash) as conn:
                words = [w for w in task.split() if len(w) >= 4][:6]
                if words:
                    like_clauses = " OR ".join("name LIKE ?" for _ in words)
                    kw_rows = conn.execute(
                        f"SELECT DISTINCT file_rel FROM symbols WHERE {like_clauses} LIMIT ?",
                        tuple(f"%{w}%" for w in words) + (top * 2,),
                    ).fetchall()
                    ctx_hits = [
                        {"file_rel": str(r[0]), "text": "", "distance": 0.5, "start_line": 0, "end_line": 0}
                        for r in kw_rows
                    ][:top]
        except Exception:
            pass

    if not ctx_hits:
        if json_output:
            typer.echo(json_compact(
                {
                    "task": task,
                    "budget_tokens": budget,
                    "used_tokens": 0,
                    "used_embeddings": used_embeddings,
                    "entries": [],
                },
            ))
        else:
            typer.echo(
                "No relevant context found. "
                "Run `token-goat index --embeddings` to enable semantic search."
            )
        return

    entries: list[dict[str, object]] = []
    tokens_used = 0
    for ctx_h in ctx_hits:
        file_rel = cast(str, ctx_h["file_rel"])
        text = cast(str, ctx_h["text"])
        distance = cast(float, ctx_h["distance"])
        start_line = cast(int, ctx_h["start_line"])
        end_line = cast(int, ctx_h["end_line"])

        est_tokens = max(1, len(text) // 3 + 1)
        if tokens_used + est_tokens > budget:
            break
        tokens_used += est_tokens
        relevance_pct = max(0, int((1.0 - distance) * 100))
        entry: dict[str, object] = {
            "file": file_rel,
            "start_line": start_line,
            "end_line": end_line,
            "est_tokens": est_tokens,
            "relevance_pct": relevance_pct,
        }
        entries.append(entry)

    if json_output:
        typer.echo(json_compact(
            {
                "task": task,
                "budget_tokens": budget,
                "used_tokens": tokens_used,
                "used_embeddings": used_embeddings,
                "entries": entries,
            },
        ))
        return

    use_color = sys.stdout.isatty()
    header = f"\033[1mcontext-for:\033[0m {task}" if use_color else f"context-for: {task}"
    typer.echo(header)
    typer.echo(
        f"  {len(entries)} file{'s' if len(entries) != 1 else ''}  •  "
        f"~{tokens_used:,} tokens of {budget:,} budget"
        + ("  •  semantic" if used_embeddings else "  •  keyword fallback")
    )
    typer.echo("")

    for entry in entries:
        file_rel = str(entry["file"])
        sl = cast(int, entry["start_line"])
        el = cast(int, entry["end_line"])
        pct = cast(int, entry["relevance_pct"])
        est = cast(int, entry["est_tokens"])
        loc = f":{sl}-{el}" if sl else ""
        read_cmd = f'token-goat read "{file_rel}{loc}"'
        if use_color:
            typer.echo(
                f"  \033[36m{read_cmd}\033[0m"
                f"  \033[2m~{est} tok  {pct}% relevant\033[0m"
            )
        else:
            typer.echo(f"  {read_cmd}  ~{est} tok  {pct}% relevant")
