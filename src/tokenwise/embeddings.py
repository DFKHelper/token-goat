"""Semantic search using fastembed (ONNX, no external service) + sqlite-vec storage."""
from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import struct
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from . import db, paths
from .project import Project

if TYPE_CHECKING:
    from fastembed import TextEmbedding


class EmbeddingsResult(TypedDict):
    """Result of index_project_embeddings operation."""

    files_visited: int
    chunks_embedded: int
    chunks_skipped_unchanged: int
    duration_sec: float
    model: str

_LOG = logging.getLogger("tokenwise.embeddings")

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_DIM = 384

# Chunk size constraints (chars)
MIN_CHUNK_CHARS = 50
MAX_CHUNK_CHARS = 8000

# Sliding-window fallback for unparsed code
WINDOW_LINES = 100

# Symbol kinds worth chunking
_CODE_SYMBOL_KINDS = frozenset({
    "function", "method", "class", "interface",
    "trait", "type", "enum", "impl", "abi_export",
})

# Languages that get sliding-window fallback
_WINDOW_LANGS = frozenset({"typescript", "javascript", "python", "go", "rust"})


class EmbeddingsUnavailable(Exception):
    """Raised when fastembed/model/sqlite-vec are not usable."""


@dataclass
class Chunk:
    file_rel: str
    start_line: int
    end_line: int
    text: str
    kind: str  # function|class|method|section|window|symbol


@dataclass
class SearchHit:
    file_rel: str
    start_line: int
    end_line: int
    kind: str
    text: str
    distance: float  # smaller = closer (cosine distance via sqlite-vec)


# ---------------------------------------------------------------------------
# Model lifecycle
# ---------------------------------------------------------------------------

_MODEL_CACHE: dict[str, TextEmbedding] = {}  # singleton per model name


def _get_model(model_name: str = DEFAULT_MODEL) -> TextEmbedding:
    """Lazily import + load fastembed. Raises EmbeddingsUnavailable on any failure."""
    if model_name in _MODEL_CACHE:
        return _MODEL_CACHE[model_name]
    try:
        # Point fastembed at our model cache dir
        os.environ.setdefault("FASTEMBED_CACHE_PATH", str(paths.models_dir()))
        paths.models_dir().mkdir(parents=True, exist_ok=True)
        from fastembed import TextEmbedding  # noqa: PLC0415
        _LOG.info(
            "loading fastembed model %s (cache=%s)", model_name, paths.models_dir()
        )
        model = TextEmbedding(model_name=model_name, cache_dir=str(paths.models_dir()))
        _MODEL_CACHE[model_name] = model
        return model
    except Exception as e:  # broad — fastembed can throw many things on bad env
        raise EmbeddingsUnavailable(f"fastembed unavailable: {e}") from e


def is_available() -> bool:
    """Quick check — does not download or load the model."""
    try:
        import fastembed  # noqa: F401, PLC0415
        return True
    except ImportError:
        return False


def embed_texts(
    texts: Sequence[str], *, model_name: str = DEFAULT_MODEL
) -> list[list[float]]:
    """Embed a batch of texts. Raises EmbeddingsUnavailable if model can't be loaded."""
    model = _get_model(model_name)
    vecs: list[list[float]] = []
    for arr in model.embed(list(texts)):  # type: ignore[union-attr]
        vecs.append(arr.tolist())
    return vecs


# ---------------------------------------------------------------------------
# Chunk extraction
# ---------------------------------------------------------------------------

def _fetch_chunk_metadata(
    conn: sqlite3.Connection,
    rel_path: str,
) -> tuple[list[sqlite3.Row], list[sqlite3.Row], str]:
    """Fetch symbols, sections, and file language in one cursor operation.

    Combines three queries into one round-trip to reduce DB overhead.
    """
    sym_rows = conn.execute(
        "SELECT name, kind, line, end_line FROM symbols"
        " WHERE file_rel = ? AND end_line IS NOT NULL ORDER BY line",
        (rel_path,),
    ).fetchall()

    sec_rows = conn.execute(
        "SELECT heading, line, end_line FROM sections"
        " WHERE file_rel = ? AND end_line IS NOT NULL ORDER BY line",
        (rel_path,),
    ).fetchall()

    file_lang_row = conn.execute(
        "SELECT language FROM files WHERE rel_path = ?", (rel_path,)
    ).fetchone()
    language = file_lang_row["language"] if file_lang_row else "other"

    return sym_rows, sec_rows, language


def extract_chunks_for_file(
    project: Project,
    conn: sqlite3.Connection,
    rel_path: str,
) -> list[Chunk]:
    """Build chunks for one file from its indexed symbols/sections + windowed fallback."""
    abs_path = project.root / rel_path
    try:
        text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        _LOG.warning("read failed for %s: %s", abs_path, e)
        return []
    lines = text.splitlines()
    if not lines:
        return []

    chunks: list[Chunk] = []
    covered: list[tuple[int, int]] = []  # (start_line, end_line) already covered

    # Combine symbol, section, and file language queries into one round-trip
    sym_rows, sec_rows, language = _fetch_chunk_metadata(conn, rel_path)

    # 1) Symbol-based chunks (functions, classes, methods …)
    for row in sym_rows:
        if row["kind"] not in _CODE_SYMBOL_KINDS:
            continue
        start: int = row["line"]
        end: int = row["end_line"]
        if end <= start:
            continue
        chunk_text = "\n".join(lines[start - 1 : end])
        if not (MIN_CHUNK_CHARS <= len(chunk_text) <= MAX_CHUNK_CHARS):
            continue
        chunks.append(Chunk(rel_path, start, end, chunk_text, row["kind"]))
        covered.append((start, end))

    # 2) Section-based chunks (markdown / html / liquid)
    for row in sec_rows:
        start = row["line"]
        end = row["end_line"]
        if end <= start:
            continue
        chunk_text = "\n".join(lines[start - 1 : end])
        if not (MIN_CHUNK_CHARS <= len(chunk_text) <= MAX_CHUNK_CHARS):
            continue
        chunks.append(Chunk(rel_path, start, end, chunk_text, "section"))
        covered.append((start, end))

    # 3) Sliding-window fallback for uncovered ranges (code files only)
    if language in _WINDOW_LANGS:
        covered_lines: set[int] = set()
        for start, end in covered:
            covered_lines.update(range(start, end + 1))
        n = len(lines)
        i = 1
        while i <= n:
            if i in covered_lines:
                i += 1
                continue
            window_end = min(i + WINDOW_LINES - 1, n)
            chunk_text = "\n".join(lines[i - 1 : window_end])
            if MIN_CHUNK_CHARS <= len(chunk_text) <= MAX_CHUNK_CHARS:
                chunks.append(Chunk(rel_path, i, window_end, chunk_text, "window"))
            i = window_end + 1

    return chunks


# ---------------------------------------------------------------------------
# sqlite-vec storage helpers
# ---------------------------------------------------------------------------

def _pack_vec(vec: Sequence[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _check_vec_available(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT vec_version()").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


# ---------------------------------------------------------------------------
# Incremental indexing
# ---------------------------------------------------------------------------

def index_project_embeddings(
    project: Project,
    *,
    model_name: str = DEFAULT_MODEL,
    batch_size: int = 32,
    progress: Callable[[int, int], None] | None = None,
) -> EmbeddingsResult:
    """Compute embeddings for all chunks in a project. Idempotent on chunk SHA256."""
    if not is_available():
        raise EmbeddingsUnavailable("fastembed not installed")

    t0 = time.time()
    n_files = 0
    n_chunks_new = 0
    n_chunks_skipped = 0

    with (
        db.project_writer_lock(project.hash, timeout_sec=30.0),
        db.open_project(project.hash) as conn,
    ):
        if not _check_vec_available(conn):
            raise EmbeddingsUnavailable(
                "sqlite-vec not loaded; embeddings disabled"
            )

        # Load existing chunk hashes per (file, start, end)
        existing: dict[tuple[str, int, int], str] = {}
        for row in conn.execute(
            "SELECT file_rel, start_line, end_line, content_sha256 FROM chunks"
        ):
            existing[
                (row["file_rel"], row["start_line"], row["end_line"])
            ] = row["content_sha256"]

        file_rows = conn.execute("SELECT rel_path FROM files").fetchall()
        n_files = len(file_rows)

        # Build full list of chunks that need (re)embedding
        new_chunks: list[tuple[Chunk, str]] = []  # (chunk, sha256)
        for fi_row in file_rows:
            rel = fi_row["rel_path"]
            for ch in extract_chunks_for_file(project, conn, rel):
                sha = hashlib.sha256(
                    ch.text.encode("utf-8", errors="replace")
                ).hexdigest()
                key = (ch.file_rel, ch.start_line, ch.end_line)
                if existing.get(key) == sha:
                    n_chunks_skipped += 1
                    continue
                new_chunks.append((ch, sha))

        # Embed + persist in batches
        for i in range(0, len(new_chunks), batch_size):
            batch = new_chunks[i : i + batch_size]
            texts = [ch.text for ch, _ in batch]
            vecs = embed_texts(texts, model_name=model_name)
            for (ch, sha), vec in zip(batch, vecs, strict=True):
                # Remove stale row at same (file, line range) before reinserting
                old = conn.execute(
                    "SELECT id FROM chunks"
                    " WHERE file_rel=? AND start_line=? AND end_line=?",
                    (ch.file_rel, ch.start_line, ch.end_line),
                ).fetchone()
                if old:
                    conn.execute(
                        "DELETE FROM embeddings WHERE chunk_id=?", (old["id"],)
                    )
                    conn.execute(
                        "DELETE FROM chunks WHERE id=?", (old["id"],)
                    )
                cur = conn.execute(
                    "INSERT INTO chunks"
                    " (file_rel, start_line, end_line, content_sha256, kind, text)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        ch.file_rel,
                        ch.start_line,
                        ch.end_line,
                        sha,
                        ch.kind,
                        ch.text,
                    ),
                )
                chunk_id = cur.lastrowid
                conn.execute(
                    "INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)",
                    (chunk_id, _pack_vec(vec)),
                )
                n_chunks_new += 1
            if progress:
                progress(i + len(batch), len(new_chunks))

        # Persist model metadata
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            ("embedding_model", model_name),
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            ("embedding_dim", str(DEFAULT_DIM)),
        )

    return EmbeddingsResult(
        files_visited=n_files,
        chunks_embedded=n_chunks_new,
        chunks_skipped_unchanged=n_chunks_skipped,
        duration_sec=round(time.time() - t0, 2),
        model=model_name,
    )


# ---------------------------------------------------------------------------
# Semantic search
# ---------------------------------------------------------------------------

def semantic_search(
    project: Project,
    query: str,
    *,
    k: int = 5,
    model_name: str = DEFAULT_MODEL,
) -> list[SearchHit]:
    """Embed query, vec-search the project DB. Returns top-k hits sorted by distance."""
    if not is_available():
        raise EmbeddingsUnavailable("fastembed not installed")
    qvec = embed_texts([query], model_name=model_name)[0]
    with db.open_project(project.hash) as conn:
        if not _check_vec_available(conn):
            raise EmbeddingsUnavailable("sqlite-vec not loaded")
        rows = conn.execute(
            """
            SELECT c.file_rel, c.start_line, c.end_line, c.kind, c.text, e.distance
            FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE e.embedding MATCH ?
              AND k = ?
            ORDER BY e.distance
            """,
            (_pack_vec(qvec), k),
        ).fetchall()
    return [
        SearchHit(
            file_rel=r["file_rel"],
            start_line=r["start_line"],
            end_line=r["end_line"],
            kind=r["kind"],
            text=r["text"],
            distance=r["distance"],
        )
        for r in rows
    ]
