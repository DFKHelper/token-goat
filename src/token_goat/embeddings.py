"""Semantic search using fastembed (ONNX, no external service) + sqlite-vec storage."""
from __future__ import annotations

__all__ = [
    "DEFAULT_DIM",
    "DEFAULT_MODEL",
    "Chunk",
    "EmbeddingsResult",
    "EmbeddingsUnavailable",
    "SearchHit",
    "SimilarSymbolHit",
    "bm25_search",
    "embed_texts",
    "extract_chunks_for_file",
    "find_similar_symbols",
    "hybrid_search",
    "index_project_embeddings",
    "is_available",
    "merge_nearby_hits",
    "semantic_search",
]

import array
import contextlib
import hashlib
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from . import db, paths
from .util import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from fastembed import TextEmbedding

    from .project import Project


class EmbeddingsResult(TypedDict):
    """Result of index_project_embeddings operation."""

    files_visited: int
    chunks_embedded: int
    chunks_skipped_unchanged: int
    duration_sec: float
    model: str

_LOG = get_logger("embeddings")

# BAAI/bge-small-en-v1.5 is the smallest model in the BGE family that still
# scores well on code-retrieval benchmarks.  At ~130 MB it downloads once and
# fits comfortably in memory during background indexing.  The 384-dimensional
# output is the native dimension for this checkpoint — do not change DEFAULT_DIM
# without re-creating all vec0 tables (schema stores dim at creation time).
DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_DIM = 384

# Chunk size constraints (chars).  MIN_CHUNK_CHARS filters out trivially small
# symbols (blank stubs, one-liner constants) that add noise without semantic signal.
# MAX_CHUNK_CHARS caps chunks before embedding — bge-small-en-v1.5 has a 512-token
# context window (~2 k chars for code); beyond 8 k the model silently truncates,
# so splitting earlier produces better vectors than feeding an oversized block.
MIN_CHUNK_CHARS = 50
MAX_CHUNK_CHARS = 8000

# Line-window size for the sliding-window fallback used on unparsed files.
# 100 lines gives each chunk enough context to be semantically meaningful while
# keeping chunk count manageable for large files (a 1 k-line file → ~10 chunks).
WINDOW_LINES = 100

# Symbol kinds worth chunking.
# Includes both "universal" code kinds (function, class, …) and the
# domain-specific kinds introduced by the structured-file indexers so that
# symbol-based chunks (Pass 1) are produced for SQL tables, GraphQL types,
# Proto messages, CSS rules, and Makefile targets in addition to source code.
_CODE_SYMBOL_KINDS = frozenset({
    # Universal code kinds
    "function", "method", "class", "interface",
    "trait", "type", "enum", "impl", "abi_export",
    # SQL schema kinds (sql_idx.py)
    "sql_table", "sql_view", "sql_function", "sql_procedure",
    "sql_trigger", "sql_type", "sql_schema", "sql_index",
    # GraphQL schema/document kinds (graphql_idx.py)
    "graphql_type", "graphql_input", "graphql_interface", "graphql_enum",
    "graphql_union", "graphql_scalar", "graphql_directive", "graphql_fragment",
    "graphql_query", "graphql_mutation", "graphql_subscription", "graphql_extend",
    "graphql_schema",
    # Protocol Buffer kinds (proto_idx.py)
    "proto_message", "proto_enum", "proto_service", "proto_rpc",
    "proto_oneof", "proto_extend",
    # CSS / SCSS / Less kinds (css_idx.py)
    "css_class", "css_id", "css_keyframes", "css_mixin", "css_atrule",
    "css_custom_property",
    # Makefile kinds (makefile_idx.py)
    "makefile_target", "makefile_define",
})

# Languages that get sliding-window fallback.
# The window pass (Pass 3 in extract_chunks_for_file) covers lines not captured
# by any symbol or section — module-level imports, constants, inline comments,
# variable declarations, etc.  Adding SQL, GraphQL, Proto, CSS, and Makefile
# ensures that preamble content (e.g. SQL SET commands, CSS custom-property
# declarations outside of rule-sets, Makefile variable assignments) is embedded
# alongside the structured symbols extracted by Pass 1.
_WINDOW_LANGS = frozenset({
    "typescript", "javascript", "python", "go", "rust",
    "sql", "graphql", "proto", "css", "makefile",
})

# ---------------------------------------------------------------------------
# Search-time tunables (re-ranking, filtering, threshold)
# ---------------------------------------------------------------------------

# Cosine-distance ceiling for a result to be considered "confident".  bge-small-en-v1.5
# returns cosine distance in [0, 2]; in practice on-topic code/doc matches sit below
# ~1.0 and off-topic noise sits above ~1.3.  We default to 1.2 so we keep recall on
# legitimate paraphrase matches while filtering obvious garbage when the corpus has
# no good answer.  Users can override via the CLI ``--max-distance`` flag.
DEFAULT_DISTANCE_THRESHOLD = 1.2

# Path-segment fragments that mark generated/build/vendored output that we should
# de-prioritise in semantic results.  These are matched as POSIX path *segments*
# (after splitting on '/'), so e.g. ``__pycache__`` matches ``a/__pycache__/x.py``
# but not ``a/pycache.py``.  Hits in these files aren't deleted — they're demoted
# (penalty added to distance) so they only surface when nothing better exists.
_GENERATED_PATH_SEGMENTS = frozenset({
    "node_modules", "dist", "build", "__pycache__", ".next", ".nuxt",
    ".turbo", ".cache", "coverage", "out", "target", "vendor",
    ".venv", "venv", ".tox", "site-packages", "bower_components",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
})

# Distance penalty (in cosine-distance units) added to a hit's score when the
# hit comes from a generated/build path.  Large enough to push it below any
# real source-file match (cosine distance for on-topic hits is typically < 0.8),
# small enough that a generated hit can still appear if nothing else matches.
_GENERATED_PATH_PENALTY = 0.5

# Verbatim-token boost: subtract from distance when a chunk contains exact
# substring matches for query tokens.  Code search benefits enormously from
# exact-name matching ("RateLimiter" should beat a paraphrase like "throttle
# helper") which pure embedding similarity can miss for novel identifiers.
# Each matched token deducts this much, capped at MAX_VERBATIM_BOOST.
_VERBATIM_TOKEN_BOOST = 0.05
_MAX_VERBATIM_BOOST = 0.25

# Identifier-like tokens we'll boost on.  Tokens shorter than 3 chars are
# usually too generic ("id", "n", "of") to contribute useful signal; we drop
# them to avoid spurious boosts.  Strings of \w+ catch snake_case, camelCase,
# PascalCase, and ALLCAPS identifiers; we also split camelCase below for finer
# matching.
_TOKEN_RE = re.compile(r"\w+")
_MIN_TOKEN_LEN = 3

# How many candidates to over-fetch from sqlite-vec before re-ranking.  Pulling
# OVER_FETCH_FACTOR * k lets the re-ranker (verbatim boost + generated-path
# penalty) reshuffle results without losing recall when good matches happen to
# rank slightly below noise on raw cosine distance.
_OVER_FETCH_FACTOR = 4
_MAX_OVER_FETCH = 100


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
# Re-ranking helpers
# ---------------------------------------------------------------------------

def _is_generated_path(file_rel: str) -> bool:
    """Return True if any POSIX path segment of file_rel is a known generated/build dir.

    Used to demote (not delete) hits from vendored/output trees so on-topic
    source-file results outrank them.  Path is compared segment-by-segment so
    we never false-match on filename substrings (e.g. ``my_dist.py`` should
    not match ``dist``).
    """
    if not file_rel:
        return False
    # Normalise to POSIX separators so Windows-style paths in the DB still match.
    segments = file_rel.replace("\\", "/").split("/")
    return any(seg in _GENERATED_PATH_SEGMENTS for seg in segments)


def _extract_query_tokens(query: str) -> frozenset[str]:
    """Tokenize the query into lowercase identifier-like tokens for verbatim boost.

    Splits on \\w+, drops tokens shorter than ``_MIN_TOKEN_LEN`` (too noisy:
    "id", "n", "of" match nearly everything), and also splits camelCase /
    PascalCase tokens into their components so a query for "RateLimiter" boosts
    chunks that contain "rate" or "limiter" as well as the exact identifier.
    Returns a frozenset for O(1) membership lookup during re-ranking.
    """
    if not query:
        return frozenset()
    raw = _TOKEN_RE.findall(query.lower())
    tokens: set[str] = set()
    for tok in raw:
        if len(tok) >= _MIN_TOKEN_LEN:
            tokens.add(tok)
    # Also split camelCase / PascalCase variants present in the original query
    # (before lowering) — "RateLimiter" -> {"rate", "limiter"}.
    for tok in _TOKEN_RE.findall(query):
        # Split on lowercase->uppercase boundaries (matches PascalCase and camelCase).
        parts = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)", tok)
        for part in parts:
            lower_part = part.lower()
            if len(lower_part) >= _MIN_TOKEN_LEN:
                tokens.add(lower_part)
    return frozenset(tokens)


def _verbatim_boost(text: str, tokens: frozenset[str]) -> float:
    """Return distance reduction (positive value) for verbatim token hits in text.

    Counts how many query tokens appear as substrings in the chunk text and
    returns ``min(count * _VERBATIM_TOKEN_BOOST, _MAX_VERBATIM_BOOST)``.  Capped
    so a chunk that happens to contain every token doesn't dominate purely on
    that signal — the underlying cosine distance still matters.
    """
    if not tokens or not text:
        return 0.0
    text_lower = text.lower()
    hits = sum(1 for tok in tokens if tok in text_lower)
    return min(hits * _VERBATIM_TOKEN_BOOST, _MAX_VERBATIM_BOOST)


def merge_nearby_hits(hits: list[SearchHit], *, proximity: int = 20) -> list[SearchHit]:
    """Merge consecutive hits from the same file whose line ranges overlap or sit within
    ``proximity`` lines of each other.

    When the same function spans multiple chunks (beginning/middle/end), all three
    may surface as top results.  Merging them into a single hit with the combined
    line range (and the best distance) prevents the output from being dominated by
    one large function.

    Algorithm: sort hits by (file_rel, start_line), then do a single-pass merge.
    After merging, re-sort by the minimum (best) distance among merged candidates
    so the merged result inherits the rank of its best constituent chunk.
    Preserves the original order for non-merged hits.
    """
    if len(hits) <= 1:
        return hits

    # Group by file, stable within each group (sort by start_line).
    by_file: dict[str, list[SearchHit]] = {}
    for h in hits:
        by_file.setdefault(h.file_rel, []).append(h)

    merged: list[SearchHit] = []
    for file_hits in by_file.values():
        file_hits.sort(key=lambda h: h.start_line)
        current = file_hits[0]
        cur_start = current.start_line
        cur_end = current.end_line
        cur_dist = current.distance
        cur_kind = current.kind
        cur_text = current.text

        for nxt in file_hits[1:]:
            # Merge if the next chunk starts within (cur_end + proximity).
            if nxt.start_line <= cur_end + proximity:
                # Expand range and keep the best (lowest) distance.
                cur_end = max(cur_end, nxt.end_line)
                if nxt.distance < cur_dist:
                    cur_dist = nxt.distance
                    cur_kind = nxt.kind
                    cur_text = nxt.text
            else:
                merged.append(SearchHit(
                    file_rel=current.file_rel,
                    start_line=cur_start,
                    end_line=cur_end,
                    kind=cur_kind,
                    text=cur_text,
                    distance=cur_dist,
                ))
                current = nxt
                cur_start = nxt.start_line
                cur_end = nxt.end_line
                cur_dist = nxt.distance
                cur_kind = nxt.kind
                cur_text = nxt.text

        merged.append(SearchHit(
            file_rel=current.file_rel,
            start_line=cur_start,
            end_line=cur_end,
            kind=cur_kind,
            text=cur_text,
            distance=cur_dist,
        ))

    merged.sort(key=lambda h: h.distance)
    return merged


def _rerank_hits(
    rows: list[sqlite3.Row],
    query: str,
    *,
    k: int,
    max_distance: float | None,
    boost_verbatim: bool,
    demote_generated: bool,
) -> list[SearchHit]:
    """Apply verbatim-token boost, generated-path penalty, threshold filter, sort.

    Computes an *effective distance* for each row:

        eff = raw_distance + (generated_penalty if generated else 0)
                            - verbatim_boost(text, query_tokens)

    then drops rows whose ``eff`` exceeds ``max_distance`` (when set), sorts
    ascending, and truncates to ``k``.  The returned ``SearchHit.distance``
    field carries the *effective* distance so callers can show a single
    user-meaningful score — the raw embedding distance is internal detail.
    """
    tokens = _extract_query_tokens(query) if boost_verbatim else frozenset()
    scored: list[tuple[float, sqlite3.Row]] = []
    for r in rows:
        raw_dist: float = float(r["distance"])
        eff = raw_dist
        if demote_generated and _is_generated_path(r["file_rel"]):
            eff += _GENERATED_PATH_PENALTY
        if boost_verbatim:
            eff -= _verbatim_boost(r["text"], tokens)
        # Distance is conceptually non-negative; clamp to keep the public
        # ``SearchHit.distance`` field meaningful for users.  Without this an
        # exact-match query against a chunk that also contains the query's
        # tokens could report eff < 0, which is confusing in CLI output.
        if eff < 0.0:
            eff = 0.0
        if max_distance is not None and eff > max_distance:
            continue
        scored.append((eff, r))
    scored.sort(key=lambda t: t[0])
    return [
        SearchHit(
            file_rel=r["file_rel"],
            start_line=r["start_line"],
            end_line=r["end_line"],
            kind=r["kind"],
            text=r["text"],
            distance=eff,
        )
        for eff, r in scored[:k]
    ]


# ---------------------------------------------------------------------------
# Model lifecycle
# ---------------------------------------------------------------------------

_MODEL_CACHE: dict[str, TextEmbedding] = {}  # singleton per model name


def _get_model(model_name: str = DEFAULT_MODEL) -> TextEmbedding:
    """Lazily import + load fastembed. Raises EmbeddingsUnavailable on any failure."""
    if model_name in _MODEL_CACHE:
        _LOG.debug("fastembed model cache hit: %s", model_name)
        return _MODEL_CACHE[model_name]
    try:
        # Point fastembed at our model cache dir
        os.environ.setdefault("FASTEMBED_CACHE_PATH", str(paths.models_dir()))
        paths.ensure_dir(paths.models_dir())
        from fastembed import TextEmbedding
        _LOG.info(
            "loading fastembed model %s (cache=%s)", model_name, paths.models_dir()
        )
        t0 = time.monotonic()
        model = TextEmbedding(model_name=model_name, cache_dir=str(paths.models_dir()))
        elapsed = time.monotonic() - t0
        _LOG.info("fastembed model loaded: %s in %.2fs", model_name, elapsed)
        _MODEL_CACHE[model_name] = model
    except ImportError as e:
        raise EmbeddingsUnavailable(f"fastembed not installed: {e}") from e
    except (OSError, RuntimeError, ValueError) as e:
        _LOG.debug("fastembed model load failed for %r: %s", model_name, e, exc_info=True)
        raise EmbeddingsUnavailable(f"fastembed model load failed: {e}") from e
    except Exception as e:
        _LOG.debug("fastembed unexpected error for %r: %s", model_name, e, exc_info=True)
        raise EmbeddingsUnavailable(f"fastembed unavailable: {e}") from e
    else:
        return model


def is_available() -> bool:
    """Quick check — does not download or load the model.

    Uses ``importlib.util.find_spec`` rather than a real ``import fastembed``
    so the check is side-effect free and immune to transient runtime errors
    from fastembed's heavy dependency chain (onnxruntime, huggingface_hub,
    requests). Under heavy xdist parallel load, executing fastembed's
    top-level imports was occasionally raising — making this gate lie about
    availability — even when the package was correctly installed.
    """
    import importlib.util

    return importlib.util.find_spec("fastembed") is not None


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
    n = len(texts)
    model = _get_model(model_name)
    expected_dim = DEFAULT_DIM if model_name == DEFAULT_MODEL else None
    vecs: list[list[float]] = []
    t0 = time.monotonic()
    try:
        for arr in model.embed(list(texts)):  # type: ignore[union-attr]  # fastembed TextEmbedding.embed() is not in typeshed; duck-typed Iterable[ndarray]
            try:
                vec = arr.tolist()
            except AttributeError as e:
                raise EmbeddingsUnavailable(
                    f"embed() returned non-array object {type(arr).__name__!r}: {e}"
                ) from e
            if expected_dim is not None and len(vec) != expected_dim:
                # A silent dimension mismatch would corrupt the sqlite-vec index:
                # the stored BLOB length determines the assumed dimension at query
                # time, so mixed-dimension rows produce incorrect distance scores
                # without any error.  Fail loudly here instead.
                raise EmbeddingsUnavailable(
                    f"Dimension mismatch: model {model_name!r} returned {len(vec)}-dim vector, "
                    f"expected {expected_dim}. The sqlite-vec index uses {expected_dim}-dim embeddings. "
                    "Re-index with a consistent model."
                )
            vecs.append(vec)
    except EmbeddingsUnavailable:
        raise
    except (RuntimeError, ValueError, TypeError) as e:
        _LOG.debug("embed_texts: embedding iteration failed: %s", e, exc_info=True)
        raise EmbeddingsUnavailable(f"embed() iteration failed: {e}") from e
    elapsed = time.monotonic() - t0
    throughput = n / elapsed if elapsed > 0 else 0.0
    _LOG.debug("embed_texts: n=%d elapsed=%.3fs throughput=%.1f texts/s", n, elapsed, throughput)
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


def _try_add_chunk(
    rel_path: str,
    start: int,
    end: int,
    lines: list[str],
    kind: str,
    chunks: list[Chunk],
    covered: list[tuple[int, int]] | None = None,
) -> bool:
    """Append a Chunk if its text falls within [MIN_CHUNK_CHARS, MAX_CHUNK_CHARS].

    Returns True when appended (and extends covered if provided), False when dropped.
    Silently drops chunks with line numbers outside file bounds.
    """
    if start < 1 or end > len(lines) or start > end:
        return False
    chunk_text = "\n".join(lines[start - 1 : end])
    if not (MIN_CHUNK_CHARS <= len(chunk_text) <= MAX_CHUNK_CHARS):
        return False
    chunks.append(Chunk(rel_path, start, end, chunk_text, kind))
    if covered is not None:
        covered.append((start, end))
    return True


def extract_chunks_for_file(
    project: Project,
    conn: sqlite3.Connection,
    rel_path: str,
) -> list[Chunk]:
    """Build embeddable chunks for a single file using a three-pass strategy.

    Pass 1 — Symbol-based chunks: each function, class, method, etc. that has a
    known ``end_line`` becomes one chunk. This gives semantically coherent units
    that map cleanly to what a developer would call "a function" or "a class".

    Pass 2 — Section-based chunks: headings from markdown/HTML/Liquid files are
    chunked with their body text. This makes documentation sections searchable
    alongside code.

    Pass 3 — Sliding-window fallback (code files only): any lines not yet covered
    by a symbol or section are emitted in WINDOW_LINES-sized non-overlapping
    windows. This catches module-level code (imports, constants, type aliases,
    inline comments) that the parser doesn't assign to a named symbol.

    Chunks outside the [MIN_CHUNK_CHARS, MAX_CHUNK_CHARS] range are discarded:
    too-short chunks produce noisy low-signal embeddings; too-long chunks exceed
    what the embedding model handles well and often span unrelated concepts.

    Args:
        project: Project metadata — root path used to resolve the absolute file path.
        conn: Open project DB connection — used to fetch pre-indexed symbol/section rows.
        rel_path: Repository-relative POSIX path of the file to chunk.

    Returns:
        List of Chunk objects ready for embedding. Empty list if the file cannot
        be read, is empty, or contains an unsafe path.
    """
    # Prevent path traversal attacks
    if not paths.is_safe_rel_path(rel_path):
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
    n_dropped_size = 0  # chunks rejected because they fall outside [MIN_CHUNK_CHARS, MAX_CHUNK_CHARS]

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
        if not _try_add_chunk(rel_path, start, end, lines, row["kind"], chunks, covered):
            n_dropped_size += 1

    # 2) Section-based chunks (markdown / html / liquid)
    for row in sec_rows:
        start = row["line"]
        end = row["end_line"]
        if end <= start:
            continue
        if not _try_add_chunk(rel_path, start, end, lines, "section", chunks, covered):
            n_dropped_size += 1

    # 3) Sliding-window fallback for uncovered ranges (code files only)
    #
    # The goal is to embed code that wasn't captured by symbol or section
    # extraction: top-level statements, module-level constants, inline type
    # aliases, long comments, etc.  We slide a WINDOW_LINES-sized window over
    # the file, emitting one chunk per uncovered gap.
    #
    # Covered-range membership check uses a sorted list + advance-only pointer
    # (covered_idx) instead of a set or interval tree. Because both covered[]
    # and line_no always advance, covered_idx never needs to reset, making the
    # inner loop O(C + L) where C = len(covered) and L = len(lines), rather
    # than O(L * C) for a naïve "is line_no in any range?" scan.
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
            # line_no is covered if the next (or current) range starts at or before it
            # and ends at or after it.
            line_is_covered = (
                covered_idx < len(covered)
                and covered[covered_idx][0] <= line_no <= covered[covered_idx][1]
            )

            if line_is_covered:
                line_no += 1
                continue

            # Emit one window chunk starting at line_no, jumping forward by the
            # full window size so windows don't overlap (non-overlapping is intentional:
            # overlapping windows would produce near-duplicate embeddings that inflate
            # the index without improving recall).
            window_end = min(line_no + WINDOW_LINES - 1, n)
            if not _try_add_chunk(rel_path, line_no, window_end, lines, "window", chunks):
                n_dropped_size += 1
            line_no = window_end + 1

    if _LOG.isEnabledFor(logging.DEBUG):
        # Single O(n) pass instead of three separate generator scans.
        # The isEnabledFor guard avoids the loop entirely when DEBUG is off,
        # which is the common case in production (INFO level).
        n_sym = n_sec = n_win = 0
        for c in chunks:
            if c.kind == "section":
                n_sec += 1
            elif c.kind == "window":
                n_win += 1
            else:
                n_sym += 1
        _LOG.debug(
            "extract_chunks_for_file: %s -> %d chunks (sym=%d sec=%d win=%d dropped_size=%d)",
            rel_path, len(chunks), n_sym, n_sec, n_win, n_dropped_size,
        )
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
    except sqlite3.OperationalError:
        return False
    else:
        return True


def _load_existing_chunk_hashes(
    conn: sqlite3.Connection,
    file_rels: list[str] | None = None,
) -> dict[tuple[str, int, int], str]:
    """Return a mapping of (file_rel, start_line, end_line) -> content_sha256 for indexed chunks.

    Used by :func:`index_project_embeddings` to skip re-embedding chunks whose
    content hasn't changed since the last index run.  Must be called before the
    file-scan loop starts so the snapshot reflects the pre-run DB state; calling
    it mid-loop would cause already-inserted chunks to appear as pre-existing.

    Args:
        conn: Open project DB connection.
        file_rels: If ``None`` (default), load hashes for *all* files (full-index
            path).  If a list is provided, load hashes only for those files
            (incremental/dirty-queue path) — avoids loading 30–50 MB of chunk
            data for the entire project on every 2-second poll cycle.
            An empty list returns ``{}`` immediately without touching the DB.

    Note on the SQLite variable limit (``SQLITE_MAX_VARIABLE_NUMBER``): the
    default limit is 999 bound parameters per statement.  When ``len(file_rels)``
    exceeds 900 the IN-list is split into batches of 500 and results are merged,
    keeping well clear of that boundary.
    """
    if file_rels is not None and not file_rels:
        return {}

    existing: dict[tuple[str, int, int], str] = {}

    if file_rels is None:
        # Full-table scan: preserve original behaviour for the full-index path.
        for row in conn.execute(
            "SELECT file_rel, start_line, end_line, content_sha256 FROM chunks"
        ):
            existing[(row["file_rel"], row["start_line"], row["end_line"])] = row["content_sha256"]
        return existing

    # Incremental path: query only the requested files.
    # SQLITE_MAX_VARIABLE_NUMBER defaults to 999; batch at 500 to stay safe.
    _SQLITE_BATCH_SIZE = 500
    for batch_start in range(0, len(file_rels), _SQLITE_BATCH_SIZE):
        batch = file_rels[batch_start : batch_start + _SQLITE_BATCH_SIZE]
        placeholders = ",".join("?" for _ in batch)
        for row in conn.execute(
            f"SELECT file_rel, start_line, end_line, content_sha256 FROM chunks"
            f" WHERE file_rel IN ({placeholders})",
            batch,
        ):
            existing[(row["file_rel"], row["start_line"], row["end_line"])] = row["content_sha256"]
    return existing


def _insert_chunks_and_collect_embed_rows(
    conn: sqlite3.Connection,
    batch: list[tuple[Chunk, str]],
    vecs: list[list[float]],
) -> list[tuple[int, bytes]]:
    """Insert chunk rows and return (chunk_id, packed_vec) pairs ready for bulk embedding insert.

    For each (chunk, sha256) / vector triple: inserts a row into ``chunks`` and
    pairs the new ``lastrowid`` with the packed vector bytes.  The caller is
    responsible for running :func:`_delete_stale_chunks` *before* this function
    so the UNIQUE constraint on (file_rel, start_line, end_line) is satisfied.

    Returns a list of (chunk_id, embedding_bytes) suitable for ``executemany``
    into the ``embeddings`` table.
    """
    embed_rows: list[tuple[int, bytes]] = []
    for (ch, sha), vec in zip(batch, vecs, strict=True):
        cur = conn.execute(
            "INSERT INTO chunks"
            " (file_rel, start_line, end_line, content_sha256, kind, text)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (ch.file_rel, ch.start_line, ch.end_line, sha, ch.kind, ch.text),
        )
        chunk_id: int = cur.lastrowid  # type: ignore[assignment]  # INSERT always sets lastrowid
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute(
                "INSERT INTO chunks_fts(rowid, text) VALUES(?,?)",
                (chunk_id, ch.text),
            )
        embed_rows.append((chunk_id, _pack_vec(vec)))
    return embed_rows


def _delete_stale_chunks(
    conn: sqlite3.Connection,
    batch_keys: list[tuple[str, int, int]],
) -> int:
    """Delete chunks and their embeddings for the given (file_rel, start_line, end_line) keys.

    Issues one SELECT…IN to find chunk IDs, then two DELETE…IN statements (one for
    embeddings, one for chunks) — avoiding the N+1 pattern of per-chunk operations.
    Must run before the corresponding INSERT in the same batch: the chunks table has
    a UNIQUE constraint on (file_rel, start_line, end_line), so inserting a moved or
    rehashed chunk at an existing position would raise a conflict without this cleanup.

    Returns the number of chunk rows deleted (0 if none were stale).
    """
    key_placeholders = ",".join("(?,?,?)" for _ in batch_keys)
    stale_rows = conn.execute(
        f"SELECT id, text FROM chunks WHERE (file_rel, start_line, end_line) IN ({key_placeholders})",
        [v for key in batch_keys for v in key],
    ).fetchall()
    if not stale_rows:
        return 0
    stale_ids = [row["id"] for row in stale_rows]
    # Remove stale entries from FTS before the chunk rows disappear (external content table requires old text).
    try:
        for row in stale_rows:
            conn.execute(
                "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete',?,?)",
                (row["id"], row["text"]),
            )
    except sqlite3.OperationalError:
        pass
    id_placeholders = ",".join("?" for _ in stale_ids)
    conn.execute(f"DELETE FROM embeddings WHERE chunk_id IN ({id_placeholders})", stale_ids)
    conn.execute(f"DELETE FROM chunks WHERE id IN ({id_placeholders})", stale_ids)
    _LOG.debug("cleaned %d stale chunks for re-embed", len(stale_ids))
    return len(stale_ids)


# ---------------------------------------------------------------------------
# Incremental indexing
# ---------------------------------------------------------------------------

def index_project_embeddings(
    project: Project,
    *,
    model_name: str = DEFAULT_MODEL,
    batch_size: int = 32,
    progress: Callable[[int, int], None] | None = None,
    file_rels: list[str] | None = None,
) -> EmbeddingsResult:
    """Compute embeddings for chunks in a project. Idempotent on chunk SHA256.

    Args:
        project: Project to embed.
        model_name: Fastembed model identifier.
        batch_size: Number of chunks to embed per batch.
        progress: Optional callback ``(done, total)`` for progress reporting.
        file_rels: If ``None`` (default), embed chunks for *all* project files
            (full-index path).  Pass a list of relative paths to restrict
            embedding to those files only — used by the dirty-queue worker to
            avoid loading the entire chunk table on each 2-second poll cycle.
    """
    if not is_available():
        _LOG.debug("embeddings unavailable: fastembed not installed")
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

        existing = _load_existing_chunk_hashes(conn, file_rels)
        if file_rels is None:
            file_rows = conn.execute("SELECT rel_path, size FROM files").fetchall()
        else:
            placeholders = ",".join("?" for _ in file_rels)
            file_rows = conn.execute(
                f"SELECT rel_path, size FROM files WHERE rel_path IN ({placeholders})",
                file_rels,
            ).fetchall() if file_rels else []
        n_files = len(file_rows)

        # Determine the symbol-only size threshold from config.  Files larger than
        # this were indexed for symbols only and must not receive an embedding pass —
        # their content is too large to chunk meaningfully and would skew the index.
        # Fail soft: if config is unavailable, embed all files (no threshold).
        try:
            from . import config as _embed_config
            _embed_symbol_only_threshold = _embed_config.load().indexing.large_file_symbol_only_kb * 1024
        except Exception as _e:
            _LOG.debug("index_project_embeddings: failed to load config: %s", _e, exc_info=True)
            _embed_symbol_only_threshold = 0

        # Build full list of chunks that need (re)embedding.
        # Bind sha256_fn locally to avoid a module-level attribute lookup + dict
        # lookup through the hashlib namespace on every iteration — measurable
        # at scale when processing thousands of chunks per project.
        sha256_fn = hashlib.sha256
        new_chunks: list[tuple[Chunk, str]] = []  # (chunk, content_sha256)
        n_symbol_only_skipped = 0
        for fi_row in file_rows:
            rel = fi_row["rel_path"]
            # Skip files that exceeded the symbol-only threshold — they were indexed
            # for symbols only during the parse pass; embedding them would be expensive
            # and their large size produces low-quality chunks.
            if _embed_symbol_only_threshold > 0:
                try:
                    _file_size = int(fi_row["size"] or 0)
                except (TypeError, ValueError):
                    _file_size = 0
                if _file_size > _embed_symbol_only_threshold:
                    n_symbol_only_skipped += 1
                    _LOG.debug(
                        "embeddings: skipping symbol-only file %s (%d bytes)", rel, _file_size
                    )
                    continue
            for ch in extract_chunks_for_file(project, conn, rel):
                sha = sha256_fn(ch.text.encode("utf-8", errors="replace")).hexdigest()
                key = (ch.file_rel, ch.start_line, ch.end_line)
                if existing.get(key) == sha:
                    n_chunks_skipped += 1
                    continue
                new_chunks.append((ch, sha))

        # Embed + persist in batches
        n_pending_embed = len(new_chunks)
        if n_symbol_only_skipped > 0:
            _LOG.info(
                "embeddings: skipped %d symbol-only file(s) (size > %d bytes)",
                n_symbol_only_skipped, _embed_symbol_only_threshold,
            )
        if n_pending_embed == 0:
            duration = time.time() - t0
            _LOG.info(
                "embeddings up-to-date: project=%s files=%d chunks_skipped=%d symbol_only_skipped=%d duration=%.2fs",
                project.hash[:8], n_files, n_chunks_skipped, n_symbol_only_skipped, duration,
            )
            return EmbeddingsResult(
                files_visited=n_files,
                chunks_embedded=0,
                chunks_skipped_unchanged=n_chunks_skipped,
                duration_sec=round(duration, 2),
                model=model_name,
            )
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
            # before reinserting.  One DELETE…IN per batch instead of per chunk.
            batch_keys = [(ch.file_rel, ch.start_line, ch.end_line) for ch, _ in batch]
            n_stale_deleted += _delete_stale_chunks(conn, batch_keys)

            embed_rows = _insert_chunks_and_collect_embed_rows(conn, batch, vecs)
            n_chunks_new += len(embed_rows)
            conn.executemany(
                "INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)",
                embed_rows,
            )
            if progress:
                progress(i + len(batch), n_pending_embed)

        # Persist model metadata
        conn.executemany(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            [("embedding_model", model_name), ("embedding_dim", str(DEFAULT_DIM))],
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
    k: int = 8,
    model_name: str = DEFAULT_MODEL,
    max_distance: float | None = DEFAULT_DISTANCE_THRESHOLD,
    boost_verbatim: bool = True,
    demote_generated: bool = True,
) -> list[SearchHit]:
    """Find semantically similar code/text chunks via vector similarity search.

    Embeds the query string and over-fetches candidates from sqlite-vec (k *
    ``_OVER_FETCH_FACTOR``), then re-ranks with two precision-oriented signals
    before truncating to k:

      * **Verbatim-token boost** — chunks containing the query's identifier
        tokens (camelCase / snake_case split) get a small distance discount.
        This rescues exact-name matches that pure embedding similarity can
        rank below paraphrases for novel identifiers like ``RateLimiter``.
      * **Generated-path penalty** — hits from ``node_modules/``, ``dist/``,
        ``__pycache__/``, etc. are demoted (not deleted) so real source-file
        matches surface first; vendored hits still appear when nothing else
        matches.

    Optionally drops results whose *effective* distance exceeds
    ``max_distance``, so a corpus with no good answer returns an empty list
    instead of garbage.

    Args:
        project: Project metadata (root, hash, etc.).
        query: Natural language or code snippet to search for. Examples: 'rate limit retry',
               'async/await boundary', 'null guard'.
        k: Number of top results to return (default 8).
        model_name: Embedding model (default: BAAI/bge-small-en-v1.5).
        max_distance: Drop hits with effective distance above this threshold.
            Set to ``None`` to disable threshold filtering (return up to k
            results regardless of confidence).  Default
            :data:`DEFAULT_DISTANCE_THRESHOLD`.
        boost_verbatim: When True (default), chunks containing exact query
            tokens get a small distance discount during re-rank.
        demote_generated: When True (default), hits in known generated/build
            paths get a distance penalty.

    Returns:
        List of SearchHit objects, sorted by *effective* distance (closest
        first). Empty list if no chunks indexed, query has no semantic
        content, or all candidates exceed ``max_distance``.

    Raises:
        EmbeddingsUnavailable: If fastembed not installed, sqlite-vec not loaded, or
                                project has no indexed chunks.
    """
    if not is_available():
        _LOG.debug("embeddings unavailable: fastembed not installed")
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

    # Over-fetch: ask sqlite-vec for more candidates than k so the re-ranker
    # (verbatim boost + generated-path penalty) has room to shuffle the top
    # results without losing recall.  Cap at _MAX_OVER_FETCH to bound cost.
    fetch_k = min(max(k * _OVER_FETCH_FACTOR, k), _MAX_OVER_FETCH)

    t_search_start = time.time()
    with db.open_project(project.hash) as conn:
        if not _check_vec_available(conn):
            raise EmbeddingsUnavailable("sqlite-vec not loaded")
        # sqlite-vec uses a non-standard KNN syntax: ``WHERE embedding MATCH <blob>
        # AND k = <int>`` is a virtual table constraint that triggers the ANN scan,
        # not a conventional SQL WHERE clause.  Both constraints must be present;
        # omitting ``k`` causes a full-table scan; omitting ``MATCH`` raises an error.
        rows = conn.execute(
            """
            SELECT c.file_rel, c.start_line, c.end_line, c.kind, c.text, e.distance
            FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE e.embedding MATCH ?
              AND k = ?
            ORDER BY e.distance
            """,
            (_pack_vec(qvec), fetch_k),
        ).fetchall()
    search_elapsed = time.time() - t_search_start

    hits = _rerank_hits(
        list(rows),
        query,
        k=k,
        max_distance=max_distance,
        boost_verbatim=boost_verbatim,
        demote_generated=demote_generated,
    )
    hits = merge_nearby_hits(hits)

    if rows:
        raw_distances = [r["distance"] for r in rows]
        _LOG.info(
            "semantic search completed: query_len=%d k=%d fetched=%d returned=%d "
            "search_elapsed=%.3fs embed_elapsed=%.3fs dist_min=%.4f dist_max=%.4f "
            "threshold=%s",
            len(query), k, len(rows), len(hits), search_elapsed, embed_elapsed,
            raw_distances[0], raw_distances[-1],
            "off" if max_distance is None else f"{max_distance:.2f}",
        )
    else:
        _LOG.info(
            "semantic search completed: query_len=%d k=%d fetched=0 returned=0 "
            "search_elapsed=%.3fs embed_elapsed=%.3fs",
            len(query), k, search_elapsed, embed_elapsed,
        )

    return hits


# ---------------------------------------------------------------------------
# Keyword and hybrid search
# ---------------------------------------------------------------------------

def bm25_search(
    project: Project,
    query: str,
    *,
    k: int = 8,
) -> list[SearchHit]:
    """Keyword search using SQLite FTS5 BM25 ranking over the chunks table."""
    if not query or not query.strip():
        return []
    if not db.fts_available(project.hash):
        return []
    results: list[SearchHit] = []
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                """SELECT c.file_rel, c.start_line, c.end_line, c.text, c.kind,
                          bm25(chunks_fts) AS bm25_score
                   FROM chunks_fts
                   JOIN chunks c ON c.id = chunks_fts.rowid
                   WHERE chunks_fts MATCH ?
                   ORDER BY bm25_score
                   LIMIT ?""",
                (query, k),
            ).fetchall()
        for row in rows:
            # bm25() returns negative values; store as-is so smaller = better matches SearchHit.distance semantics.
            results.append(SearchHit(
                file_rel=row[0],
                start_line=row[1],
                end_line=row[2],
                text=row[3],
                distance=float(row[5]),
                kind=row[4],
            ))
    except sqlite3.OperationalError:
        pass
    return results


def _rrf_fuse(
    vector_hits: list[SearchHit],
    keyword_hits: list[SearchHit],
    *,
    k: int = 60,
    alpha: float = 0.5,
) -> list[SearchHit]:
    """Fuse two ranked lists via Reciprocal Rank Fusion (RRF)."""
    from collections import defaultdict
    rrf_scores: dict[tuple[str, int], float] = defaultdict(float)
    hits_by_key: dict[tuple[str, int], SearchHit] = {}

    for rank, hit in enumerate(vector_hits):
        key = (hit.file_rel, hit.start_line)
        rrf_scores[key] += alpha * (1.0 / (k + rank + 1))
        hits_by_key[key] = hit

    for rank, hit in enumerate(keyword_hits):
        key = (hit.file_rel, hit.start_line)
        rrf_scores[key] += (1 - alpha) * (1.0 / (k + rank + 1))
        if key not in hits_by_key:
            hits_by_key[key] = hit

    # Sort by RRF score descending; convert to distance (negated) to fit SearchHit semantics.
    fused = sorted(rrf_scores.keys(), key=lambda ky: rrf_scores[ky], reverse=True)
    result = []
    for key in fused:
        hit = hits_by_key[key]
        result.append(SearchHit(
            file_rel=hit.file_rel,
            start_line=hit.start_line,
            end_line=hit.end_line,
            text=hit.text,
            distance=-rrf_scores[key],  # negate so smaller distance = higher RRF score
            kind=hit.kind,
        ))
    return result


def hybrid_search(
    project: Project,
    query: str,
    *,
    k: int = 8,
    alpha: float = 0.5,
    model_name: str = DEFAULT_MODEL,
    max_distance: float | None = DEFAULT_DISTANCE_THRESHOLD,
) -> list[SearchHit]:
    """Hybrid search combining vector and BM25 results via Reciprocal Rank Fusion."""
    vec_hits = semantic_search(
        project, query, k=k * 2, model_name=model_name, max_distance=max_distance
    )
    kw_hits = bm25_search(project, query, k=k * 2)
    fused = _rrf_fuse(vec_hits, kw_hits, alpha=alpha)
    return fused[:k]


# ---------------------------------------------------------------------------
# Per-symbol similarity
# ---------------------------------------------------------------------------

@dataclass
class SimilarSymbolHit:
    """A symbol that is semantically similar to the query symbol.

    Attributes:
        file: Path to the source file, relative to the project root.
        name: Symbol name (e.g. ``login``, ``UserService``).
        kind: Symbol kind (e.g. ``function``, ``class``).
        similarity_score: Similarity as a value in [0, 1].  1 = identical, 0 = unrelated.
            Derived from cosine distance: ``1 - distance / 2``.
    """

    file: str
    name: str
    kind: str
    similarity_score: float


def find_similar_symbols(
    project_hash: str,
    file_path: str,
    symbol_name: str,
    top_k: int = 5,
) -> list[SimilarSymbolHit]:
    """Find the top-k most semantically similar symbols to the given symbol.

    Looks up the embedding for the named symbol via its chunk (matched by
    file_rel + line overlap), runs an ANN query to find the nearest neighbours
    across all indexed chunks, then correlates each hit back to a symbol row.
    The query symbol itself is excluded from the results.

    Args:
        project_hash: The hash of the project DB to search in.
        file_path: Relative path to the file containing the query symbol.
        symbol_name: Name of the symbol to find similar symbols for.
        top_k: Number of results to return (default 5).

    Returns:
        List of ``SimilarSymbolHit`` objects sorted by descending similarity.
        Empty list if the symbol is not indexed, has no embedding, or an error
        occurs (fail-soft).
    """
    try:
        return _find_similar_symbols_impl(project_hash, file_path, symbol_name, top_k)
    except Exception:
        _LOG.debug(
            "find_similar_symbols failed for %s::%s",
            file_path,
            symbol_name,
            exc_info=True,
        )
        return []


def _find_similar_symbols_impl(
    project_hash: str,
    file_path: str,
    symbol_name: str,
    top_k: int,
) -> list[SimilarSymbolHit]:
    """Inner implementation; exceptions propagate to the fail-soft wrapper."""
    if not is_available():
        raise EmbeddingsUnavailable("fastembed not installed")

    # Over-fetch so we have candidates to exclude + re-rank, then trim to top_k.
    fetch_k = min(max(top_k * _OVER_FETCH_FACTOR, top_k + 10), _MAX_OVER_FETCH)

    with db.open_project(project_hash) as conn:
        if not _check_vec_available(conn):
            raise EmbeddingsUnavailable("sqlite-vec not loaded")

        # Step 1 — find the symbol and its line range.
        sym_row = conn.execute(
            "SELECT line, end_line FROM symbols WHERE file_rel = ? AND name = ? LIMIT 1",
            (file_path, symbol_name),
        ).fetchone()
        if sym_row is None:
            _LOG.debug(
                "find_similar_symbols: symbol %r not found in %r",
                symbol_name,
                file_path,
            )
            return []

        sym_line: int = sym_row["line"]
        sym_end: int = sym_row["end_line"] if sym_row["end_line"] is not None else sym_line

        # Step 2 — find a chunk that overlaps the symbol's line range.
        # Prefer the chunk whose start_line is closest to the symbol start.
        chunk_row = conn.execute(
            """
            SELECT id, embedding
            FROM (
                SELECT c.id, e.embedding
                FROM chunks c
                JOIN embeddings e ON e.chunk_id = c.id
                WHERE c.file_rel = ?
                  AND c.start_line <= ?
                  AND c.end_line   >= ?
                ORDER BY ABS(c.start_line - ?) ASC
                LIMIT 1
            )
            """,
            (file_path, sym_end, sym_line, sym_line),
        ).fetchone()

        if chunk_row is None:
            _LOG.debug(
                "find_similar_symbols: no indexed chunk for %r::%r (lines %d-%d)",
                file_path,
                symbol_name,
                sym_line,
                sym_end,
            )
            return []

        query_chunk_id: int = chunk_row["id"]
        query_embedding_bytes: bytes = chunk_row["embedding"]

        # Step 3 — ANN search against all embeddings in the project.
        rows = conn.execute(
            """
            SELECT c.file_rel, c.start_line, c.end_line, c.kind, e.distance, e.chunk_id
            FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE e.embedding MATCH ?
              AND k = ?
            ORDER BY e.distance
            """,
            (query_embedding_bytes, fetch_k),
        ).fetchall()

        # Step 4 — correlate each candidate chunk to a symbol row.
        # Exclude both (a) the query chunk itself, and (b) any chunk that resolves
        # to the same (file, symbol_name) as the query symbol — handles the case
        # where a large symbol spans multiple chunks.
        results: list[SimilarSymbolHit] = []
        # Pre-populate seen with the query symbol so it can never appear in results.
        seen: set[tuple[str, str]] = {(file_path, symbol_name)}
        for row in rows:
            if len(results) >= top_k:
                break
            # Skip the exact query chunk.
            if row["chunk_id"] == query_chunk_id:
                continue
            c_file: str = row["file_rel"]
            c_start: int = row["start_line"]
            c_end: int = row["end_line"]
            # Find the best-matching symbol for this chunk.
            # Strategy: find the smallest symbol whose line range overlaps the
            # chunk (i.e. symbol starts at or before the chunk's end AND symbol
            # ends at or after the chunk's start).  Prefer symbols with smaller
            # span (more specific match) over large enclosing containers.
            sym = conn.execute(
                """
                SELECT name, kind,
                       (COALESCE(end_line, line) - line) AS span
                FROM symbols
                WHERE file_rel = ?
                  AND line <= ?
                  AND (end_line IS NULL OR end_line >= ?)
                ORDER BY span ASC, ABS(line - ?) ASC
                LIMIT 1
                """,
                (c_file, c_end, c_start, c_start),
            ).fetchone()
            if sym is None:
                continue
            key = (c_file, sym["name"])
            if key in seen:
                continue
            seen.add(key)
            # Convert cosine distance [0, 2] to similarity [0, 1].
            raw_dist = float(row["distance"])
            similarity = max(0.0, min(1.0, 1.0 - raw_dist / 2.0))
            results.append(
                SimilarSymbolHit(
                    file=c_file,
                    name=sym["name"],
                    kind=sym["kind"],
                    similarity_score=similarity,
                )
            )

    return results
