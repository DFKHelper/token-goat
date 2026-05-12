"""Tree-sitter orchestration: walks a project, dispatches to per-language extractors, writes to DB."""
from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from . import db
from .project import Project

_LOG = logging.getLogger("cc_saver.parser")

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
    name: str
    kind: str            # function|class|method|type|interface|const|enum|var|arrow_fn
    line: int            # 1-indexed
    col: int = 0
    end_line: int | None = None
    signature: str | None = None
    parent_name: str | None = None   # for methods, nested fns


@dataclass
class Ref:
    name: str
    line: int
    col: int = 0
    context: str | None = None


@dataclass
class ImpExp:
    kind: str            # import|export|reexport
    target: str
    line: int


@dataclass
class Section:
    heading: str
    level: int
    line: int
    end_line: int | None = None


@dataclass
class FileIndex:
    rel_path: str
    language: str
    size: int
    mtime: float
    content_sha256: str
    symbols: list[Symbol] = field(default_factory=list)
    refs: list[Ref] = field(default_factory=list)
    imports_exports: list[ImpExp] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)


# Each language module exposes: extract(source: bytes, rel_path: str) -> tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]
Extractor = Callable[[bytes, str], tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]]]


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
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        # skip if any parent dir is in SKIP_DIRS
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        if path.suffix.lower() not in LANG_BY_EXT:
            continue
        try:
            if path.stat().st_size > MAX_FILE_SIZE:
                continue
        except OSError:
            continue
        yield path


def index_file(project: Project, file_path: Path) -> FileIndex | None:
    """Read and parse one file. Return FileIndex (no DB write yet). Returns None on errors."""
    try:
        raw = file_path.read_bytes()
    except OSError as e:
        _LOG.warning("read failed: %s: %s", file_path, e)
        return None
    rel = file_path.relative_to(project.root).as_posix()
    language = LANG_BY_EXT[file_path.suffix.lower()]
    extractor = get_extractor(language)
    if extractor is None:
        return None
    try:
        symbols, refs, imp_exp, sections = extractor(raw, rel)
    except Exception:
        _LOG.exception("extractor crashed on %s", rel)
        return None
    stat = file_path.stat()
    return FileIndex(
        rel_path=rel,
        language=language,
        size=stat.st_size,
        mtime=stat.st_mtime,
        content_sha256=hashlib.sha256(raw).hexdigest(),
        symbols=symbols,
        refs=refs,
        imports_exports=imp_exp,
        sections=sections,
    )


def write_file_index(conn, fi: FileIndex) -> None:
    """Replace all rows for this file with the new index."""
    now = int(time.time())
    # Delete old rows (cascade handles symbols/refs/imports_exports/sections)
    conn.execute("DELETE FROM files WHERE rel_path = ?", (fi.rel_path,))
    conn.execute(
        "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (fi.rel_path, fi.language, fi.size, fi.mtime, fi.content_sha256, now),
    )
    for sym in fi.symbols:
        conn.execute(
            "INSERT INTO symbols (name, kind, file_rel, line, col, end_line, signature, parent_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
            (sym.name, sym.kind, fi.rel_path, sym.line, sym.col, sym.end_line, sym.signature),
        )
    for ref in fi.refs:
        conn.execute(
            "INSERT INTO refs (symbol_name, file_rel, line, col, context) "
            "VALUES (?, ?, ?, ?, ?)",
            (ref.name, fi.rel_path, ref.line, ref.col, ref.context),
        )
    for ie in fi.imports_exports:
        conn.execute(
            "INSERT INTO imports_exports (file_rel, kind, target, line) "
            "VALUES (?, ?, ?, ?)",
            (fi.rel_path, ie.kind, ie.target, ie.line),
        )
    for sec in fi.sections:
        conn.execute(
            "INSERT INTO sections (file_rel, heading, level, line, end_line) "
            "VALUES (?, ?, ?, ?, ?)",
            (fi.rel_path, sec.heading, sec.level, sec.line, sec.end_line),
        )


def index_project(
    project: Project,
    *,
    full: bool = True,
    progress: Callable[[int, int], None] | None = None,
) -> dict:
    """Full or incremental indexing. Returns summary dict."""
    files = list(iter_source_files(project))
    n_total = len(files)
    n_indexed = 0
    n_skipped_unchanged = 0
    n_errors = 0
    languages: set[str] = set()
    t0 = time.time()

    with db.project_writer_lock(project.hash, timeout_sec=30.0):
        with db.open_project(project.hash) as conn:
            # For incremental: pre-load existing file SHAs
            existing: dict[str, str] = {}
            if not full:
                for row in conn.execute("SELECT rel_path, content_sha256 FROM files"):
                    existing[row["rel_path"]] = row["content_sha256"]

            for i, fp in enumerate(files):
                fi = index_file(project, fp)
                if fi is None:
                    n_errors += 1
                else:
                    if not full and existing.get(fi.rel_path) == fi.content_sha256:
                        n_skipped_unchanged += 1
                    else:
                        write_file_index(conn, fi)
                        n_indexed += 1
                        languages.add(fi.language)
                if progress and (i + 1) % 100 == 0:
                    progress(i + 1, n_total)

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

    return {
        "total_files": n_total,
        "indexed": n_indexed,
        "skipped_unchanged": n_skipped_unchanged,
        "errors": n_errors,
        "languages": sorted(languages),
        "duration_sec": round(time.time() - t0, 2),
    }
