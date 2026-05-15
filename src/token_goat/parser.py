"""Tree-sitter orchestration: walks a project, dispatches to per-language extractors, writes to DB."""
from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypedDict

from . import db
from .project import Project

_LOG = logging.getLogger("token_goat.parser")

# Extension -> language_key
LANG_BY_EXT: dict[str, str] = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
    ".liquid": "liquid",
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
}

# Directories that should never be indexed
SKIP_DIRS = {
    "node_modules", ".git", ".next", "dist", "build", ".venv", "venv",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    "target", "out", "coverage", ".turbo", ".vercel", ".svelte-kit",
    ".cache", ".idea", ".vscode", ".DS_Store", ".angular",
}

# Skip files larger than this (bytes) — usually generated artifacts
MAX_FILE_SIZE = 2_000_000  # 2 MB


@dataclass
class Symbol:
    """Represents a named entity (function, class, variable, etc.) in source code.

    Attributes:
        name: Symbol name as declared in code (e.g., 'getUserId', 'UserService', 'VERSION').
        kind: Symbol type: 'function', 'class', 'method', 'type', 'interface', 'const',
              'enum', 'var', 'arrow_fn', 'trait', 'impl', 'abi_export', etc. Language-specific.
        line: 1-based line number where symbol definition begins.
        col: 0-based column offset (default 0). Optional; not all languages track column data.
        end_line: 1-based line where symbol definition ends (inclusive). None if single-line or unavailable.
        signature: Parsed signature string for callables (e.g., '(x: int, y: str) -> bool').
                  None if not a callable or signature extraction not implemented for this language.
        parent_name: For nested symbols (methods, inner functions), the name of the enclosing
                    scope (e.g., 'UserService' for method hello). None for top-level symbols.
    """
    name: str
    kind: str            # function|class|method|type|interface|const|enum|var|arrow_fn
    line: int            # 1-indexed
    col: int = 0
    end_line: int | None = None
    signature: str | None = None
    parent_name: str | None = None   # for methods, nested fns


@dataclass
class Ref:
    """Represents a reference to a symbol in source code (usage or mention).

    Used to identify where symbols are invoked/accessed, supporting cross-file tracing
    and dependency analysis.

    Attributes:
        name: Name of the symbol being referenced.
        line: 1-based line number where the reference occurs.
        col: 0-based column offset (default 0).
        context: Optional contextual snippet around the reference (e.g., the surrounding
                statement or method name). Helps disambiguate which 'name' is referenced.
    """
    name: str
    line: int
    col: int = 0
    context: str | None = None


@dataclass
class ImpExp:
    """An import or export relationship extracted from a source file.

    Used to build the cross-reference graph that drives PageRank scoring in
    ``repomap.py``.

    Attributes:
        kind: Relationship type — one of ``"import"``, ``"export"``, or ``"reexport"``.
        target: The module path or symbol being imported/exported (as written in
            the source, e.g. ``"./db"`` or ``"token_goat.session"``).
        line: 1-based line number in the source file where the relationship appears.
    """

    kind: str            # import|export|reexport
    target: str
    line: int


@dataclass
class Section:
    """Represents a heading/section in a document (markdown, HTML, etc.).

    Attributes:
        heading: The text of the heading (e.g., 'Installation', 'API Reference').
        level: Heading hierarchy level. Markdown/HTML: 1-6; Liquid/other: language-specific.
               Lower numbers = higher level in hierarchy (1 = top-level, 6 = nested).
        line: 1-based line number where the heading appears.
        end_line: 1-based line where this section's content ends (before next heading or EOF).
                 None if unavailable.
    """
    heading: str
    level: int
    line: int
    end_line: int | None = None


@dataclass
class FileIndex:
    """Complete analysis of a single file: symbols, references, imports/exports, and sections.

    Produced by index_file() and persisted in the SQLite DB. Enables symbol search, cross-file
    dependency tracking, and section-based document navigation.

    Attributes:
        rel_path: Path to the file, relative to project root (normalized to POSIX style).
        language: Detected language ('python', 'typescript', 'go', 'rust', 'markdown', etc.).
        size: File size in bytes.
        line_count: Exact number of newline-delimited lines in the file.
        mtime: Last-modified timestamp (unix epoch, float).
        content_sha256: SHA256 hash of file content. Used to detect changes and skip re-indexing.
        symbols: List of named definitions (functions, classes, variables, etc.) in the file.
        refs: List of symbol references (usages) within the file.
        imports_exports: List of import/export statements (modules pulled in, symbols exposed).
        sections: List of headings/sections (only for document formats like markdown, HTML).
    """
    rel_path: str
    language: str
    size: int
    line_count: int
    mtime: float
    content_sha256: str
    symbols: list[Symbol] = field(default_factory=list)
    refs: list[Ref] = field(default_factory=list)
    imports_exports: list[ImpExp] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)


# Each language module exposes: extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]
Extractor = Callable[[bytes, str], tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]]


class IndexProjectResult(TypedDict):
    """Result of index_project operation."""

    total_files: int
    indexed: int
    skipped_unchanged: int
    errors: int
    languages: list[str]
    duration_sec: float


def get_extractor(language: str) -> Extractor | None:
    """Lazy-import the per-language extractor."""
    if language in ("typescript", "javascript"):
        from .languages import typescript  # noqa: PLC0415
        return typescript.extract
    if language == "python":
        from .languages import python  # noqa: PLC0415
        return python.extract
    if language == "go":
        from .languages import go  # noqa: PLC0415
        return go.extract
    if language == "rust":
        from .languages import rust  # noqa: PLC0415
        return rust.extract
    if language == "liquid":
        from .languages import liquid  # noqa: PLC0415
        return liquid.extract
    if language == "markdown":
        from .languages import markdown  # noqa: PLC0415
        return markdown.extract
    if language == "html":
        from .languages import html  # noqa: PLC0415
        return html.extract
    if language == "json":
        from .languages import json_idx  # noqa: PLC0415
        return json_idx.extract
    return None


def iter_source_files(project: Project) -> Iterable[Path]:
    """Yield absolute paths of indexable source files under the project root."""
    root = project.root
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        base = Path(dirpath)
        for name in files:
            if name in SKIP_DIRS:
                continue
            path = base / name
            if path.suffix.lower() not in LANG_BY_EXT:
                continue
            try:
                if path.stat().st_size > MAX_FILE_SIZE:
                    continue
            except OSError:
                continue
            yield path


def _line_count_from_bytes(raw: bytes) -> int:
    """Return the exact number of newline-delimited lines in *raw*."""
    if not raw:
        return 0
    return raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1)


def index_file(project: Project, file_path: Path) -> FileIndex | None:
    """Read and parse one file. Return FileIndex (no DB write yet). Returns None on errors."""
    t0 = time.time()
    try:
        raw = file_path.read_bytes()
    except OSError as e:
        _LOG.warning("read failed: %s: %s", file_path, e)
        return None
    rel = file_path.relative_to(project.root).as_posix()
    language = LANG_BY_EXT[file_path.suffix.lower()]
    line_count = _line_count_from_bytes(raw)
    extractor = get_extractor(language)
    if extractor is None:
        _LOG.debug("no extractor for %s (%s)", rel, language)
        return None
    try:
        symbols, refs, imp_exp, sections = extractor(raw, rel)
    except Exception:
        _LOG.exception("extractor crashed on %s", rel)
        return None

    try:
        stat = file_path.stat()
    except OSError as e:
        _LOG.warning("stat failed after reading: %s: %s", file_path, e)
        return None

    elapsed = time.time() - t0
    _LOG.debug(
        "indexed %s: symbols=%d refs=%d imports=%d sections=%d size=%d elapsed=%.3fs",
        rel, len(symbols), len(refs), len(imp_exp), len(sections), stat.st_size, elapsed
    )

    return FileIndex(
        rel_path=rel,
        language=language,
        size=stat.st_size,
        line_count=line_count,
        mtime=stat.st_mtime,
        content_sha256=hashlib.sha256(raw).hexdigest(),
        symbols=symbols,
        refs=refs,
        imports_exports=imp_exp,
        sections=sections,
    )


def write_file_index(conn: sqlite3.Connection, fi: FileIndex) -> None:
    """Replace all rows for this file with the new index."""
    now = int(time.time())
    # Delete old rows (cascade handles symbols/refs/imports_exports/sections)
    conn.execute("DELETE FROM files WHERE rel_path = ?", (fi.rel_path,))
    conn.execute(
        "INSERT INTO files (rel_path, language, size, line_count, mtime, content_sha256, indexed_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            fi.rel_path,
            fi.language,
            fi.size,
            fi.line_count,
            fi.mtime,
            fi.content_sha256,
            now,
        ),
    )
    # Batch insert symbols (filter malformed rows)
    symbol_rows = [
        (sym.name, sym.kind, fi.rel_path, sym.line, sym.col, sym.end_line, sym.signature)
        for sym in fi.symbols if sym.name and sym.kind
    ]
    if symbol_rows:
        conn.executemany(
            "INSERT INTO symbols (name, kind, file_rel, line, col, end_line, signature, parent_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
            symbol_rows,
        )

    # Batch insert refs (filter empty names)
    ref_rows = [
        (ref.name, fi.rel_path, ref.line, ref.col, ref.context)
        for ref in fi.refs if ref.name
    ]
    if ref_rows:
        conn.executemany(
            "INSERT INTO refs (symbol_name, file_rel, line, col, context) "
            "VALUES (?, ?, ?, ?, ?)",
            ref_rows,
        )

    # Batch insert imports/exports (filter invalid rows)
    ie_rows = [
        (fi.rel_path, ie.kind, ie.target, ie.line)
        for ie in fi.imports_exports if ie.kind and ie.target is not None
    ]
    if ie_rows:
        conn.executemany(
            "INSERT INTO imports_exports (file_rel, kind, target, line) "
            "VALUES (?, ?, ?, ?)",
            ie_rows,
        )

    # Batch insert sections (filter empty headings)
    sec_rows = [
        (fi.rel_path, sec.heading, sec.level, sec.line, sec.end_line)
        for sec in fi.sections if sec.heading
    ]
    if sec_rows:
        conn.executemany(
            "INSERT INTO sections (file_rel, heading, level, line, end_line) "
            "VALUES (?, ?, ?, ?, ?)",
            sec_rows,
        )


def index_project(
    project: Project,
    *,
    full: bool = True,
    progress: Callable[[int, int], None] | None = None,
) -> IndexProjectResult:
    """Full or incremental indexing. Returns summary dict with keys:
    total_files, indexed, skipped_unchanged, errors, languages, duration_sec.
    """
    index_mode = "full" if full else "incremental"
    _LOG.info("index_project started: mode=%s path=%s", index_mode, project.root)

    # Register the project in the global registry up front, before the
    # potentially slow (or hang-prone) file walk. The final registry update
    # below fills in real file_count/languages once indexing completes. Without
    # this, the project is unresolvable for the entire indexing window: the
    # worker's dirty-queue drain hits "unknown project hash" and silently drops
    # every edit made while indexing is in flight — permanently, if the index
    # spawn crashes before reaching the end.
    with db.open_global() as gconn:
        now = int(time.time())
        gconn.execute(
            "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
            "VALUES (?, ?, ?, ?, ?, 0, '') "
            "ON CONFLICT(hash) DO UPDATE SET last_seen=excluded.last_seen, marker=excluded.marker",
            (project.hash, project.root.as_posix(), project.marker, now, now),
        )

    files = list(iter_source_files(project))
    n_total = len(files)
    _LOG.debug("index walk: found %d source files", n_total)
    n_indexed = 0
    n_skipped_unchanged = 0
    n_errors = 0
    languages: set[str] = set()
    t0 = time.time()

    with db.project_writer_lock(project.hash, timeout_sec=30.0):
        with db.open_project(project.hash) as conn:
            # For incremental: pre-load existing mtimes + SHAs
            existing_sha: dict[str, str] | None = None
            existing_mtime: dict[str, float] | None = None
            if not full:
                existing_sha = {}
                existing_mtime = {}
                for row in conn.execute("SELECT rel_path, mtime, content_sha256 FROM files"):
                    existing_sha[row["rel_path"]] = row["content_sha256"]
                    existing_mtime[row["rel_path"]] = row["mtime"]
                _LOG.debug("incremental mode: loaded %d cached mtimes+hashes", len(existing_sha))

            for i, fp in enumerate(files):
                rel = fp.relative_to(project.root).as_posix()

                # mtime fast-path: skip file read + SHA entirely when mtime is unchanged
                if existing_mtime is not None and rel in existing_mtime:
                    try:
                        if fp.stat().st_mtime == existing_mtime[rel]:
                            n_skipped_unchanged += 1
                            _LOG.debug("skipped unchanged (mtime): %s", rel)
                            if progress and (i + 1) % 100 == 0:
                                progress(i + 1, n_total)
                            continue
                    except OSError:
                        pass  # stat failed — fall through to full index_file

                fi = index_file(project, fp)
                if fi is None:
                    n_errors += 1
                else:
                    # SHA check guards against same-mtime content changes (copies, touch+overwrite)
                    if existing_sha is not None and existing_sha.get(fi.rel_path) == fi.content_sha256:
                        n_skipped_unchanged += 1
                        _LOG.debug("skipped unchanged (sha): %s", fi.rel_path)
                    else:
                        write_file_index(conn, fi)
                        n_indexed += 1
                        languages.add(fi.language)
                        if existing_sha is not None:
                            _LOG.debug("updated changed file: %s", fi.rel_path)
                if progress and (i + 1) % 100 == 0:
                    progress(i + 1, n_total)

            # Prune index entries for files that no longer exist on disk.
            # Without this, deleted/renamed files linger forever — tokenwise
            # symbol/read/map would surface dead paths. FK ON DELETE CASCADE
            # cleans up symbols/refs/sections/chunks for the removed file.
            on_disk = {fp.relative_to(project.root).as_posix() for fp in files}
            db_rel_paths = {r["rel_path"] for r in conn.execute("SELECT rel_path FROM files")}
            stale = db_rel_paths - on_disk
            if stale:
                # Single DELETE … IN (…) instead of one DELETE per file — O(1)
                # round-trips vs O(N). FK ON DELETE CASCADE cleans up child rows.
                stale_list = list(stale)
                ph = ",".join("?" for _ in stale_list)
                conn.execute(f"DELETE FROM files WHERE rel_path IN ({ph})", stale_list)  # noqa: S608
            if stale:
                _LOG.info(
                    "pruned %d deleted file(s) from index: %s",
                    len(stale),
                    ", ".join(sorted(stale)[:5]),
                )

            # Update project meta
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('last_full_index_at', ?)",
                (str(int(time.time())),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('project_root', ?)",
                (project.root.as_posix(),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('project_marker', ?)",
                (project.marker,),
            )

        # Update global registry
        with db.open_global() as gconn:
            now = int(time.time())
            gconn.execute(
                "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(hash) DO UPDATE SET last_seen=excluded.last_seen, "
                "file_count=excluded.file_count, languages=excluded.languages, marker=excluded.marker",
                (
                    project.hash,
                    project.root.as_posix(),
                    project.marker,
                    now,
                    now,
                    n_total,
                    ",".join(sorted(languages)),
                ),
            )
            # Refresh global symbols snapshot
            gconn.execute(
                "DELETE FROM symbols_global WHERE project_hash = ?", (project.hash,)
            )
            with db.open_project(project.hash) as pconn:
                rows = pconn.execute(
                    "SELECT name, kind, file_rel, line, signature FROM symbols"
                ).fetchall()
            gconn.executemany(
                "INSERT INTO symbols_global(project_hash, name, kind, file_rel, line, signature) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (project.hash, r["name"], r["kind"], r["file_rel"], r["line"], r["signature"])
                    for r in rows
                ],
            )

    elapsed = time.time() - t0
    result: IndexProjectResult = {
        "total_files": n_total,
        "indexed": n_indexed,
        "skipped_unchanged": n_skipped_unchanged,
        "errors": n_errors,
        "languages": sorted(languages),
        "duration_sec": round(elapsed, 2),
    }

    _LOG.info(
        "index_project completed: indexed=%d skipped=%d errors=%d languages=%s duration=%.2fs",
        n_indexed,
        n_skipped_unchanged,
        n_errors,
        ",".join(sorted(languages)),
        elapsed,
    )
    return result
