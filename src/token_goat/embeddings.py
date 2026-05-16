"""Semantic search using fastembed (ONNX, no external service) + sqlite-vec storage."""
from __future__ import annotations

import array
import hashlib
import logging
import os
import sqlite3
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from . import db, paths
from .paths import is_safe_rel_path as _is_safe_rel_path
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

_LOG = logging.getLogger("token_goat.embeddings")

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
    """A contiguous code or text segment suitable for embedding.

    Attributes:
        file_rel: Path to source file, relative to project root.
        start_line: 1-based line number where segment begins.
        end_line: 1-based line number where segment ends (inclusive).
        text: Raw text content of the segment.
        kind: Semantic category: 'function', 'class', 'method', 'section', 'window', or 'symbol'.
              'window' = sliding-window fallback for unparsed code; 'symbol' = parsed definition.
    """
    file_rel: str
    start_line: int
    end_line: int
    text: str
    kind: str  # function|class|method|section|window|symbol


@dataclass
class SearchHit:
    """Result of a semantic search query against indexed chunks.

    Attributes:
        file_rel: Path to source file, relative to project root.
        start_line: 1-based line number where matching segment begins.
        end_line: 1-based line number where matching segment ends (inclusive).
        kind: Semantic category (same as Chunk.kind).
        text: Raw text content of the matching segment.
        distance: Cosine distance from query vector (0=identical, 2=opposite). Smaller = closer match.
    """
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
    """Embed a batch of texts to fixed-dimension semantic vectors.

    Uses fastembed's ONNX-based TextEmbedding model (BAAI/bge-small-en-v1.5 by default,
    384-dimensional output). Model is cached in FASTEMBED_CACHE_PATH (token-goat models/ dir).

    Args:
        texts: Sequence of strings to embed. Empty sequence returns empty list.
        model_name: HuggingFace model name (default: BAAI/bge-small-en-v1.5).

    Returns:
        List of embedding vectors, one per input string. Each vector is a list of floats
        with length = model's dimension (384 for default model).

    Raises:
        EmbeddingsUnavailable: If fastembed is not installed or model cannot be loaded.
        ValueError: If the model returns vectors with unexpected dimensions (dimension
            mismatch would silently corrupt the sqlite-vec index otherwise).
    """
    if not texts:
        return []
    model = _get_model(model_name)
    expected_dim = DEFAULT_DIM if model_name == DEFAULT_MODEL else None
    vecs: list[list[float]] = []
    for arr in model.embed(list(texts)):  # type: ignore[union-attr]
        vec = arr.tolist()
        if expected_dim is not None and len(vec) != expected_dim:
            raise EmbeddingsUnavailable(
                f"Dimension mismatch: model {model_name!r} returned {len(vec)}-dim vector, "
                f"expected {expected_dim}. The sqlite-vec index uses {expected_dim}-dim embeddings. "
                "Re-index with a consistent model."
            )
        vecs.append(vec)
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
    # Prevent path traversal attacks
    if not _is_safe_rel_path(rel_path):
        _LOG.warning("rejected unsafe rel_path: %s", rel_path)
        return []
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
        # Sort covered ranges so the advance pointer (range_cursor) never goes backwards.
        covered.sort()
        n = len(lines)
        line_no = 1
        covered_idx = 0  # advance-only index into sorted covered[]; never reset

        while line_no <= n:
            # Advance covered_idx past ranges that end before line_no (no longer relevant).
            while covered_idx < len(covered) and covered[covered_idx][1] < line_no:
                covered_idx += 1
            line_is_covered = (
                covered_idx < len(covered)
                and covered[covered_idx][0] <= line_no <= covered[covered_idx][1]
            )

            if line_is_covered:
                line_no += 1
                continue

            window_end = min(line_no + WINDOW_LINES - 1, n)
            chunk_text = "\n".join(lines[line_no - 1 : window_end])
            if MIN_CHUNK_CHARS <= len(chunk_text) <= MAX_CHUNK_CHARS:
                chunks.append(Chunk(rel_path, line_no, window_end, chunk_text, "window"))
            line_no = window_end + 1

    return chunks


# ---------------------------------------------------------------------------
# sqlite-vec storage helpers
# ---------------------------------------------------------------------------

def _pack_vec(vec: Sequence[float]) -> bytes:
    """Pack a float vector into the binary format expected by sqlite-vec (IEEE 754 floats).

    Uses the ``array`` module instead of ``struct.pack(*vec)`` to avoid the
    O(N) Python-level argument unpacking overhead for 384-dim vectors.
    ``array.tobytes()`` is implemented in C and is ~3-5x faster than unpacking
    384 floats as positional args to struct.pack.
    """
    return array.array("f", vec).tobytes()


def _check_vec_available(conn: sqlite3.Connection) -> bool:
    """Return True if the sqlite-vec extension is loaded and the vec_version() function responds."""
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
    _LOG.info("starting embedding index for project %s (model=%s)", project.hash[:8], model_name)

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
        n_pending_embed = len(new_chunks)
        total_batches = (n_pending_embed + batch_size - 1) // batch_size
        _LOG.info("processing %d new chunks in %d batches (project=%s)", n_pending_embed, total_batches, project.hash[:8])
        n_stale_deleted = 0
        for i in range(0, n_pending_embed, batch_size):
            batch = new_chunks[i : i + batch_size]
            texts = [ch.text for ch, _ in batch]
            batch_t0 = time.time()
            vecs = embed_texts(texts, model_name=model_name)
            batch_elapsed = time.time() - batch_t0
            batch_num = i // batch_size + 1
            _LOG.info("embedded batch %d/%d: %d texts in %.3fs (project=%s)",
                       batch_num, total_batches,
                       len(texts), batch_elapsed, project.hash[:8])
            # Batch-delete any stale chunks at the same (file, start, end) positions
            # before reinserting.  Doing one DELETE…IN per batch instead of
            # SELECT+DELETE+DELETE per chunk eliminates the N+1 pattern.
            batch_keys = [
                (ch.file_rel, ch.start_line, ch.end_line) for ch, _ in batch
            ]
            placeholders = ",".join("(?,?,?)" for _ in batch_keys)
            stale_ids = [
                row["id"]
                for row in conn.execute(
                    f"SELECT id FROM chunks WHERE (file_rel, start_line, end_line) IN ({placeholders})",  # noqa: S608
                    [v for key in batch_keys for v in key],
                ).fetchall()
            ]
            if stale_ids:
                id_ph = ",".join("?" for _ in stale_ids)
                conn.execute(f"DELETE FROM embeddings WHERE chunk_id IN ({id_ph})", stale_ids)  # noqa: S608
                conn.execute(f"DELETE FROM chunks WHERE id IN ({id_ph})", stale_ids)  # noqa: S608
                n_stale_deleted += len(stale_ids)
                _LOG.debug("cleaned %d stale chunks for re-embed", len(stale_ids))

            embed_rows: list[tuple[int, bytes]] = []
            for (ch, sha), vec in zip(batch, vecs, strict=True):
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
                chunk_id: int = cur.lastrowid  # type: ignore[assignment]  # INSERT always sets lastrowid
                embed_rows.append((chunk_id, _pack_vec(vec)))
                n_chunks_new += 1
            conn.executemany(
                "INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)",
                embed_rows,
            )
            if progress:
                progress(i + len(batch), n_pending_embed)

        # Persist model metadata
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            ("embedding_model", model_name),
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            ("embedding_dim", str(DEFAULT_DIM)),
        )

    duration = time.time() - t0
    _LOG.info(
        "embeddings complete: project=%s files=%d chunks_new=%d chunks_skipped=%d stale_deleted=%d duration=%.2fs",
        project.hash[:8], n_files, n_chunks_new, n_chunks_skipped, n_stale_deleted, duration,
    )
    return EmbeddingsResult(
        files_visited=n_files,
        chunks_embedded=n_chunks_new,
        chunks_skipped_unchanged=n_chunks_skipped,
        duration_sec=round(duration, 2),
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
    """Find semantically similar code/text chunks via vector similarity search.

    Embeds the query string and searches the project's indexed chunks (via sqlite-vec)
    for the k most similar matches, sorted by cosine distance (ascending).

    Args:
        project: Project metadata (root, hash, etc.).
        query: Natural language or code snippet to search for. Examples: 'rate limit retry',
               'async/await boundary', 'null guard'.
        k: Number of top results to return (default 5).
        model_name: Embedding model (default: BAAI/bge-small-en-v1.5).

    Returns:
        List of SearchHit objects, sorted by distance (closest first). Empty list if no
        chunks indexed or query has no semantic content.

    Raises:
        EmbeddingsUnavailable: If fastembed not installed, sqlite-vec not loaded, or
                                project has no indexed chunks.
    """
    if not is_available():
        raise EmbeddingsUnavailable("fastembed not installed")
    if not query or not query.strip():
        _LOG.debug("semantic_search: empty query; returning no results")
        return []
    t_embed_start = time.time()
    results = embed_texts([query], model_name=model_name)
    if not results:
        raise EmbeddingsUnavailable("embed_texts returned no vectors for query")
    qvec = results[0]
    if not qvec:
        raise EmbeddingsUnavailable("embed_texts returned empty vector for query")
    embed_elapsed = time.time() - t_embed_start
    _LOG.debug("query embedded in %.3fs: %d dims", embed_elapsed, len(qvec))

    t_search_start = time.time()
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
    search_elapsed = time.time() - t_search_start
    if rows:
        distances = [r["distance"] for r in rows]
        _LOG.info(
            "semantic search completed: query_len=%d k=%d results=%d search_elapsed=%.3fs "
            "embed_elapsed=%.3fs dist_min=%.4f dist_max=%.4f",
            len(query), k, len(rows), search_elapsed, embed_elapsed,
            distances[0], distances[-1],
        )
    else:
        _LOG.info(
            "semantic search completed: query_len=%d k=%d results=0 search_elapsed=%.3fs embed_elapsed=%.3fs",
            len(query), k, search_elapsed, embed_elapsed,
        )

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
