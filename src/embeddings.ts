/**
 * Semantic search using transformer embeddings (@xenova/transformers) + SQLite storage.
 *
 * Ports the Python embeddings module, adapting fastembed to @xenova/transformers.
 * The transformer import is optional: if not available, semantic search degrades
 * gracefully and all functions return empty results with logged warnings.
 */

import { createRequire } from 'node:module'

import type { Database as BetterSqlite3Database, Statement as BetterSqlite3Statement } from 'better-sqlite3'

import { pathEqClause, projectScopeClause } from './sql_path.js'
import { foldPath } from './util.js'
import { registerReset } from './reset.js'

const _require = createRequire(import.meta.url)

// Optional transformer import; catches both missing package and load failures.
// Deferred to first use (ensureTransformerLoaded), not required eagerly at module
// load time: @xenova/transformers transitively pulls in its own bundled onnxruntime-node
// and a nested, differently-versioned copy of sharp's native libvips binaries.
// Loading it eagerly here — as every real CLI invocation does, since index_prune.ts
// (needed by cmdIndex) imports this module unconditionally — poisons the process's
// Windows DLL search order before image_shrink.ts's own `sharp` gets a chance to
// dlopen, breaking image shrinking with ERR_DLOPEN_FAILED even though sharp loads
// fine in isolation. Only requiring it when a caller actually needs the transformer
// (isAvailable()/embedTexts()) means the CLI's hot hook path never touches it.
let _transformer: unknown = null
let _transformerError: Error | null = null
let _transformerLoadAttempted = false

function ensureTransformerLoaded(): void {
  if (_transformerLoadAttempted) return
  _transformerLoadAttempted = true
  try {
    _transformer = _require('@xenova/transformers')
  } catch (e) {
    _transformerError = e instanceof Error ? e : new Error(String(e))
  }
}

// BAAI/bge-small-en-v1.5 is the smallest BGE model for code retrieval. The 384-dimensional output is native to this checkpoint; do not change DEFAULT_DIM without re-creating all chunk_vectors tables.
export const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5'
export const DEFAULT_DIM = 384

// BGE's retrieval-tuned checkpoints (bge-small/base/large-en) expect an asymmetric
// instruction prefix on the QUERY side only -- passages/documents are embedded plain.
// See https://huggingface.co/BAAI/bge-small-en-v1.5#model-list. Apply this to query
// text only (never to chunk/document text, which would just add noise) to improve
// retrieval quality for this model family.
export const QUERY_INSTRUCTION_PREFIX = 'Represent this sentence for searching relevant passages: '

// pipelineFn('feature-extraction', modelName) rebuilds the whole extractor (model weights +
// tokenizer) from scratch on every call -- @xenova/transformers' pipeline() has no built-in
// memoization of its own. Keyed by model name and cached as a Promise (not the resolved
// extractor) so concurrent embedTexts calls racing on a cold cache share the same in-flight
// construction instead of each kicking off a redundant load. Cleared via registerReset so
// tests that mock the pipeline factory start from a clean slate.
type FeatureExtractor = (text: string, options: Record<string, unknown>) => Promise<unknown>
type PipelineFn = (task: string, model: string) => Promise<FeatureExtractor>
const _extractorCache = new Map<string, Promise<FeatureExtractor>>()

// @xenova/transformers is loaded via createRequire (see ensureTransformerLoaded above), which
// resolves through Node's real CJS loader rather than vitest's mockable module graph, so
// vi.mock('@xenova/transformers', ...) can't intercept it and its `pipeline` export is a
// non-configurable, non-writable property that can't be monkey-patched from a test either.
// This override lets tests substitute a cheap fake factory (mirrors the setXForTesting
// pattern already used in skill_cache.ts) instead of constructing a real transformer pipeline.
let _pipelineFnOverride: PipelineFn | null = null

export function setPipelineFnForTesting(fn: PipelineFn | null): void {
  _pipelineFnOverride = fn
}

registerReset(() => {
  _extractorCache.clear()
  _pipelineFnOverride = null
})

// pipelineFn('feature-extraction', modelName) downloads the model over the network on a cold
// cache (@xenova/transformers has no retry of its own), so a single transient CDN blip fails
// pipeline construction outright. Retrying with backoff absorbs that; PIPELINE_RETRY_DELAY_MS
// is overridable so tests exercising the retry/failure path don't pay real wall-clock delay.
const PIPELINE_RETRY_ATTEMPTS = 3
let PIPELINE_RETRY_DELAY_MS = 250

const DEFAULT_PIPELINE_RETRY_DELAY_MS = PIPELINE_RETRY_DELAY_MS

export function setPipelineRetryDelayForTesting(ms: number): void {
  PIPELINE_RETRY_DELAY_MS = ms
}

registerReset(() => {
  PIPELINE_RETRY_DELAY_MS = DEFAULT_PIPELINE_RETRY_DELAY_MS
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function buildExtractorWithRetry(
  pipelineFn: PipelineFn,
  modelName: string,
): Promise<FeatureExtractor> {
  let lastError: unknown
  for (let attempt = 1; attempt <= PIPELINE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await pipelineFn('feature-extraction', modelName)
    } catch (e) {
      lastError = e
      if (attempt < PIPELINE_RETRY_ATTEMPTS) await sleep(PIPELINE_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// Chunk size constraints (chars). MIN_CHUNK_CHARS filters trivial symbols. MAX_CHUNK_CHARS caps before embedding: bge-small has ~512-token context window.
export const MIN_CHUNK_CHARS = 50
export const MAX_CHUNK_CHARS = 8000

// Line-window size for sliding-window fallback on unparsed files.
export const WINDOW_LINES = 100

// Search-time tunables (re-ranking, filtering, threshold)
export const DEFAULT_DISTANCE_THRESHOLD = 1.2

// Path-segment fragments that mark generated/build/vendored output.
const _GENERATED_PATH_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '.tox',
  'site-packages',
  'bower_components',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
])

// Distance penalty added to generated/build path hits.
const _GENERATED_PATH_PENALTY = 0.5

// Verbatim-token boost parameters.
const _VERBATIM_TOKEN_BOOST = 0.05
const _MAX_VERBATIM_BOOST = 0.25
const _TOKEN_RE = /\w+/g
const _MIN_TOKEN_LEN = 3

// Over-fetch factor for re-ranking candidates before truncating to k. Exported (matching this
// file's other public constants' no-underscore naming) so callers like cli.ts's cmdSemantic can
// over-fetch by the same ratio for mergeNearbyHits headroom, instead of inventing a new one.
export const OVER_FETCH_FACTOR = 4
export const MAX_OVER_FETCH = 100

// ============================================================================
// Types
// ============================================================================

/** Result of an embedding/index operation. */
export interface EmbeddingsResult {
  filesVisited: number
  chunksEmbedded: number
  chunksSkippedUnchanged: number
  durationSec: number
  model: string
}

/** A contiguous code or text segment suitable for embedding. */
export interface Chunk {
  filePath: string
  startLine: number
  endLine: number
  text: string
  kind: string // function|class|method|section|window|symbol
}

/**
 * A structural cut point chunkFile can snap to instead of slicing blindly through a
 * fixed-size sliding window. Sourced from the same indexing pass's already-committed
 * symbol rows (kind: 'symbol') for source files, or from markdown heading extraction
 * (kind: 'section') for doc files - see `indexFileEmbeddings` in parser.ts. `start`/`end`
 * are 1-based, inclusive line numbers.
 */
export interface ChunkBoundary {
  start: number
  end: number
  kind: 'symbol' | 'section'
}

/** Result of a semantic search query. */
export interface SearchHit {
  filePath: string
  startLine: number
  endLine: number
  kind: string
  distance: number
  text: string
  /**
   * Rerank score (distance - verbatimBoost + generatedPathPenalty) computed by
   * rerankHits. Absent on hits that never went through reranking. Downstream
   * consumers that resort hits (e.g. mergeNearbyHits) must sort by this field
   * when present so the rerank order survives merging - falling back to
   * `distance` would silently discard the verbatim-token boost and
   * generated-path penalty.
   */
  adjustedDistance?: number
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if the transformer is available and usable.
 * Returns false if @xenova/transformers is not installed or failed to load.
 */
export function isAvailable(): boolean {
  ensureTransformerLoaded()
  return _transformer !== null && _transformerError === null
}

/**
 * Embed a batch of texts to fixed-dimension semantic vectors.
 *
 * Uses @xenova/transformers with bge-small-en-v1.5 (384-dimensional output).
 *
 * @param texts - Strings to embed. Empty array returns empty array.
 * @param modelName - HuggingFace model identifier (default: bge-small-en-v1.5).
 * @returns List of embedding vectors, one per input string.
 * @throws Error if transformer is not available or dimension mismatch occurs.
 */
export async function embedTexts(
  texts: string[],
  modelName: string = DEFAULT_MODEL,
): Promise<number[][]> {
  if (!isAvailable()) {
    throw new Error(
      `Transformer not available: ${_transformerError?.message ?? 'unknown error'}`,
    )
  }

  if (texts.length === 0) {
    return []
  }

  if (!_transformer || typeof _transformer !== 'object') {
    throw new Error('Transformer module is unavailable')
  }

  // Use the transformer pipeline to generate embeddings, memoized per model name so the
  // extractor is only constructed once per process (see _extractorCache above) instead of
  // reloading model weights + tokenizer on every embedTexts call.
  let extractorPromise = _extractorCache.get(modelName)
  if (!extractorPromise) {
    const transformerObj = _transformer as Record<string, unknown>
    const pipelineFn: PipelineFn =
      _pipelineFnOverride ??
      (transformerObj['pipeline'] as PipelineFn)
    // @xenova/transformers' pipeline() downloads the model over the network on a cold cache
    // with no retry of its own, so a single transient CDN blip (a dropped connection, a brief
    // rate-limit window) fails outright. Retrying here absorbs that. The cache MUST be
    // populated with a promise that only resolves on eventual success, never with the raw
    // pipelineFn() promise directly - on a terminal failure (all attempts exhausted) the entry
    // is deleted rather than left holding a rejected promise, because this cache is keyed by
    // model name and lives for the process lifetime: a rejected promise cached here would
    // permanently poison every future embedTexts call for that model, even long after a
    // transient outage clears, since a Promise's settled state never changes once observed.
    extractorPromise = buildExtractorWithRetry(pipelineFn, modelName)
    _extractorCache.set(modelName, extractorPromise)
    extractorPromise.catch(() => {
      if (_extractorCache.get(modelName) === extractorPromise) _extractorCache.delete(modelName)
    })
  }
  const extractor = await extractorPromise

  const vecs: number[][] = []
  const expectedDim = DEFAULT_DIM

  try {
    for (const text of texts) {
      const embedding = await extractor(text, {
        pooling: 'mean',
        normalize: true,
      })

      // embedding is a Tensor; convert to array.
      let vec: number[]
      const embeddingObj = embedding as Record<string, unknown> | null
      const embData = embeddingObj?.['data']
      if (Array.isArray(embData)) {
        vec = Array.from(embData as unknown as ArrayLike<number>)
      } else if (embData instanceof Float32Array) {
        vec = Array.from(embData)
      } else {
        throw new Error(
          `Unexpected embedding type: ${typeof embData}`,
        )
      }

      if (vec.length !== expectedDim) {
        throw new Error(
          `Dimension mismatch: model returned ${vec.length}-dim vector, expected ${expectedDim}`,
        )
      }

      vecs.push(vec)
    }
  } finally {
    // Clean up resources if needed (transformer pipeline may cache).
  }

  return vecs
}

/**
 * Pack a float vector into the binary format expected by sqlite-vec (IEEE 754).
 *
 * Uses Float32Array for efficiency, mirroring Python's array.tobytes().
 *
 * @param vec - Array of floats to pack.
 * @returns Binary representation suitable for storage in vec0 table.
 */
export function packVec(vec: number[]): Buffer {
  const view = new Float32Array(vec.length)
  for (const [i, val] of vec.entries()) {
    view[i] = val
  }
  return Buffer.from(view.buffer)
}

/**
 * Split one line range into size-capped chunks via a sliding window.
 *
 * Shared core for the no-boundary fallback (the whole file is one range, tagged
 * 'window') and for emitting/sub-splitting a single structural boundary passed in
 * from chunkFile: a boundary whose body fits under `chunkSize` comes back as exactly
 * one chunk, because the accumulation loop below never trips its overflow branch;
 * an oversized boundary is sub-split the same way the old whole-file window logic
 * always worked, still tagged with the boundary's own `kind`. Overlap is clamped to
 * `rangeStart` so a sub-split never bleeds backward into a preceding, differently
 * tagged range.
 */
function splitRangeIntoChunks(
  filePath: string,
  lines: string[],
  rangeStart: number,
  rangeEnd: number,
  chunkSize: number,
  overlap: number,
  kind: string,
): Chunk[] {
  const chunks: Chunk[] = []

  let currentChunk = ''
  let startLine = rangeStart
  let currentLine = rangeStart

  for (let lineNo = rangeStart; lineNo <= rangeEnd; lineNo++) {
    const line = lines[lineNo - 1] ?? ''
    const lineWithNewline = line + '\n'
    if (currentChunk.length + lineWithNewline.length > chunkSize && currentChunk.length > 0) {
      // Flush current chunk if adding the next line would exceed size.
      if (currentChunk.length >= MIN_CHUNK_CHARS) {
        chunks.push({
          filePath,
          startLine,
          endLine: currentLine - 1,
          text: currentChunk.trim(),
          kind,
        })
      }

      // Start new chunk with overlap, never reaching before this range's own start.
      const overlapLines = Math.ceil(overlap / 40) // Rough estimate: ~40 chars per line.
      const overlapStart = Math.max(rangeStart, currentLine - overlapLines)
      const overlapText = lines
        .slice(overlapStart - 1, currentLine - 1)
        .join('\n')
      currentChunk = overlapText + '\n'
      startLine = overlapStart
    }

    currentChunk += lineWithNewline
    currentLine++
  }

  // Flush final chunk.
  if (currentChunk.length >= MIN_CHUNK_CHARS) {
    chunks.push({
      filePath,
      startLine,
      endLine: rangeEnd,
      text: currentChunk.trim(),
      kind,
    })
  }

  return chunks
}

/**
 * Chunk file content into semantically meaningful segments.
 *
 * With no boundaries (the default), splits on newlines using a fixed-size sliding
 * window, respecting requested chunk size and overlap - the original behavior,
 * unchanged, and the fallback for any file with zero parsed symbols/headings.
 *
 * With `boundaries` supplied (symbol rows for source files, markdown headings for doc
 * files - see `indexFileEmbeddings` in parser.ts), chunk cuts snap to structure
 * instead of slicing blindly: one chunk per boundary, tagged with its `kind`. An
 * oversized boundary is sub-split with the same sliding-window logic the fallback
 * path uses. Small gaps between boundaries - or before the first one - are folded
 * into the nearest adjacent chunk rather than becoming their own tiny fragment; a gap
 * large enough to clear MIN_CHUNK_CHARS on its own still becomes a standalone
 * 'window' chunk. Overlapping/nested boundaries (a class symbol row and its own
 * methods' rows both cover the same lines) collapse to the outermost one so the same
 * lines are never embedded twice under two different chunks.
 *
 * @param filePath - Relative path to the file.
 * @param content - File content.
 * @param chunkSize - Target chunk size in chars (default: MAX_CHUNK_CHARS).
 * @param overlap - Overlap in chars between consecutive chunks (default: 200).
 * @param boundaries - Optional structural cut points (symbol or section ranges).
 * @returns Array of Chunk objects.
 */
export function chunkFile(
  filePath: string,
  content: string,
  chunkSize: number = MAX_CHUNK_CHARS,
  overlap: number = 200,
  boundaries: ChunkBoundary[] = [],
): Chunk[] {
  const lines = content.split(/\r?\n/)
  // splitlines() parity: a trailing newline must not introduce a phantom empty final line (it would inflate endLine by one and append a stray blank line).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const totalLines = lines.length

  if (boundaries.length === 0) {
    return splitRangeIntoChunks(filePath, lines, 1, totalLines, chunkSize, overlap, 'window')
  }

  // Clip to the file's actual line range and drop anything inverted, then sort by
  // start (ties broken longest-first) so the flattening pass below always meets an
  // outer boundary before any boundary nested inside it.
  const clipped = boundaries
    .map((b) => ({
      start: Math.max(1, Math.min(b.start, totalLines)),
      end: Math.max(1, Math.min(b.end, totalLines)),
      kind: b.kind as string,
    }))
    .filter((b) => b.end >= b.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)

  if (clipped.length === 0) {
    return splitRangeIntoChunks(filePath, lines, 1, totalLines, chunkSize, overlap, 'window')
  }

  // Flatten nested/overlapping boundaries (a class row fully contains its own method
  // rows) down to the outermost one - each line belongs to exactly one chunk, never
  // embedded once as part of a member and again as part of its container.
  const flattened: { start: number; end: number; kind: string }[] = []
  let openEnd = 0
  for (const b of clipped) {
    if (b.start <= openEnd) continue
    flattened.push(b)
    openEnd = b.end
  }

  const gapLength = (start: number, end: number): number => {
    let len = 0
    for (let lineNo = start; lineNo <= end; lineNo++) len += (lines[lineNo - 1]?.length ?? 0) + 1
    return len
  }

  interface Range {
    start: number
    end: number
    kind: string
  }
  const ranges: Range[] = []
  let cursor = 1

  for (const b of flattened) {
    let boundaryStart = b.start
    let boundaryKind = b.kind
    const gapStart = cursor
    const gapEnd = b.start - 1
    if (gapEnd >= gapStart) {
      if (gapLength(gapStart, gapEnd) < MIN_CHUNK_CHARS) {
        // Fold the small gap into whichever chunk is adjacent: the previous boundary
        // if one has already been emitted, otherwise forward into this boundary (the
        // "content before the first heading/symbol" case has no previous to join).
        const prev = ranges[ranges.length - 1]
        if (prev !== undefined) {
          prev.end = gapEnd
        } else {
          boundaryStart = gapStart
          // The folded-forward range now spans non-boundary content in addition to
          // this boundary's own lines, so it's no longer purely `b.kind` (e.g.
          // 'symbol') - relabel it 'window', the same generic kind already used
          // above for gap content that isn't tied to a specific boundary.
          boundaryKind = 'window'
        }
      } else {
        ranges.push({ start: gapStart, end: gapEnd, kind: 'window' })
      }
    }
    ranges.push({ start: boundaryStart, end: b.end, kind: boundaryKind })
    cursor = b.end + 1
  }

  if (cursor <= totalLines) {
    const gapStart = cursor
    const gapEnd = totalLines
    if (gapLength(gapStart, gapEnd) < MIN_CHUNK_CHARS) {
      ranges[ranges.length - 1]!.end = gapEnd
    } else {
      ranges.push({ start: gapStart, end: gapEnd, kind: 'window' })
    }
  }

  // A boundary range itself (not just an inter-boundary gap) can still be
  // shorter than MIN_CHUNK_CHARS on its own -- a short-symbol-dominated file
  // (barrel/index re-exports, enum/const modules) would otherwise have every
  // one of its boundary chunks silently dropped by splitRangeIntoChunks's own
  // floor below, one at a time, leaving the file entirely absent from the
  // semantic index. Fold any such range into a neighbor first, same as the
  // gap-folding above: prefer the previous range (already finalized), falling
  // back to merging forward only for a too-short first range.
  let i = 0
  while (i < ranges.length) {
    const r = ranges[i]!
    if (gapLength(r.start, r.end) >= MIN_CHUNK_CHARS) {
      i++
      continue
    }
    if (i > 0) {
      ranges[i - 1]!.end = r.end
      ranges.splice(i, 1)
      i--
    } else if (ranges.length > 1) {
      ranges[i + 1]!.start = r.start
      ranges.splice(i, 1)
    } else {
      i++
    }
  }

  const chunks: Chunk[] = []
  for (const r of ranges) {
    chunks.push(...splitRangeIntoChunks(filePath, lines, r.start, r.end, chunkSize, overlap, r.kind))
  }
  return chunks
}

/**
 * Insert chunks into the database with computed embeddings.
 *
 * Upserts chunks in the index, computing and storing their embeddings
 * in the chunk_vectors table.
 *
 * @param db - SQLite database connection.
 * @param chunks - Array of chunks to insert.
 * @throws Error if embeddings are not available or insertion fails.
 */
// Insert one chunk vector. sqlite-vec's vec0 chunk_vectors table declares rowid as a strict INTEGER PRIMARY KEY that rejects a plain JS number bound by better-sqlite3 ("Only integers are allowed for primary key values"); the rowid must be coerced to BigInt. Centralizing the insert keeps that binding rule in one place so upsertChunks and its tests cannot drift from it.
export function insertChunkVector(
  stmt: BetterSqlite3Statement,
  rowid: number | bigint,
  embedding: number[],
): void {
  stmt.run(BigInt(rowid), packVec(embedding))
}

/**
 * Outcome of an embedding attempt, so callers can distinguish a real embed (or a legitimately
 * empty file) from a skip forced by absent optional deps (@xenova/transformers model or the
 * sqlite-vec `chunk_vectors` table). The caller (parser.ts::indexFileEmbeddings) stamps a bare
 * `embed_sha` for `'embedded'` but an `unavailable:`-prefixed marker for `'unavailable'`, so a
 * file skipped only because deps were missing is re-embedded once the deps are installed instead
 * of masquerading as permanently fresh. See {@link embeddingsDepsAvailable}.
 */
export type EmbedOutcome = 'embedded' | 'unavailable'

export async function upsertChunks(
  db: BetterSqlite3Database,
  chunks: Chunk[],
): Promise<EmbedOutcome> {
  if (chunks.length === 0) {
    return 'embedded'
  }
  // Every chunk here comes from chunkFile(filePath, content) for one file, so they all
  // share the same filePath - safe to read it once, guarded by the length check above.
  const filePath = chunks[0]!.filePath

  if (!isAvailable()) {
    console.warn('Embeddings not available; skipping semantic indexing')
    // Still clear the file's stale rows even though we can't reinsert - matches the
    // unconditional cleanup indexFile used to perform before this delete moved here.
    deleteFileEmbeddings(db, filePath)
    // Report the skip so the caller stamps an unavailable-marker embed_sha (not a bare sha),
    // letting this file be re-embedded once the model dependency is installed.
    return 'unavailable'
  }

  // Without the optional sqlite-vec chunk_vectors table (the table is absent when the native binary did not load), semantic indexing is impossible and chunk rows have no independent reader - they are only ever read as JOIN targets of a vector hit - so skip the whole operation rather than inserting unsearchable rows and paying the embedTexts cost. isAvailable() above gates only the model, which installs independently of sqlite-vec.
  if (!chunkVectorsTableExists(db)) {
    deleteFileEmbeddings(db, filePath)
    return 'unavailable'
  }

  // Embed all chunk texts.
  const texts = chunks.map((c) => c.text)
  const embeddings = await embedTexts(texts)

  // Insert chunks into the database.
  const chunkInsertStmt = db.prepare(`
    INSERT INTO chunks (file_path, start_line, end_line, text, kind)
    VALUES (?, ?, ?, ?, ?)
  `)

  // Explicit rowid ties the vector row to its chunk metadata row so searchSemantic can JOIN by rowid without a separate foreign-key column.
  const vectorInsertStmt = db.prepare(`
    INSERT INTO chunk_vectors (rowid, embedding)
    VALUES (?, ?)
  `)

  const tx = db.transaction(() => {
    // Delete the file's prior chunks/vectors inside the same transaction as the
    // inserts below, so a failed insert rolls back the delete too instead of
    // leaving the file's embeddings deleted-but-not-replaced.
    deleteFileEmbeddings(db, filePath)

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const embedding = embeddings[i]
      if (!chunk || !embedding) {
        continue
      }

      const chunkResult = chunkInsertStmt.run(
        chunk.filePath,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        chunk.kind,
      )
      insertChunkVector(vectorInsertStmt, chunkResult.lastInsertRowid, embedding)
    }
  })

  tx()
  return 'embedded'
}

// sqlite-vec's vec0 `chunk_vectors` table stores only (rowid, embedding) -- there is no
// file_path/partition column on the vector table itself to scope the ANN (MATCH + k) scan
// against, so a project-scoped KNN query in one pass isn't available. Instead we over-fetch
// candidates from the unscoped ANN scan, then post-filter each candidate's chunk metadata
// (joined by rowid) against the project root. If a caller-provided rootDir filters out too
// many candidates to satisfy topK, we retry once with a larger k (BACKFILL_MULTIPLIER, capped
// at MAX_OVER_FETCH) -- this trades a bounded amount of extra query latency (at most one retry)
// for correctness: without it, `token-goat semantic` from project A silently returns chunks
// from unrelated project B sharing the same machine-wide global.db (see constants.ts).
const BACKFILL_MULTIPLIER = 3

/** One over-fetch-and-filter pass: KNN-search `k` candidates, then keep only those within `maxDistance` and (when `rootDir` is set) under that project root. Returns the surviving hits plus how many raw candidates the ANN scan returned, so the caller can tell whether growing `k` further could possibly help (or if the vector index is simply exhausted). Exported (not just used internally by searchSemantic) so tests can exercise the project-scoping/backfill SQL directly with a hand-built query vector, without needing a real embedding-model inference call. */
export function fetchScopedHits(
  db: BetterSqlite3Database,
  queryVec: number[],
  k: number,
  maxDistance: number,
  rootDir: string | undefined,
): { hits: SearchHit[]; candidateCount: number } {
  // sqlite-vec KNN query: both MATCH (the query vector blob) and k (row limit) must appear as WHERE constraints for the virtual table to run an ANN scan. Omitting either causes a full-table scan or an error.
  const stmt = db.prepare(`
    SELECT rowid, distance FROM chunk_vectors
    WHERE embedding MATCH ?
    AND k = ?
    ORDER BY distance ASC
  `)

  const rows = stmt.all(packVec(queryVec), k) as Array<{ rowid: number; distance: number } | undefined>

  if (!rows || rows.length === 0) {
    return { hits: [], candidateCount: 0 }
  }

  // Fetch chunk metadata from the chunks table, scoped to rootDir when provided.
  const scope = rootDir !== undefined ? projectScopeClause('file_path') : undefined
  const chunkSql =
    scope !== undefined
      ? `SELECT file_path, start_line, end_line, text, kind FROM chunks WHERE id = ? AND ${scope.clause}`
      : `SELECT file_path, start_line, end_line, text, kind FROM chunks WHERE id = ?`
  const chunkStmt = db.prepare(chunkSql)
  const scopeParam = scope !== undefined && rootDir !== undefined ? scope.param(rootDir) : undefined

  // Build hits from rows.
  const hits: SearchHit[] = []
  for (const row of rows) {
    if (!row) {
      continue
    }
    if (row.distance <= maxDistance) {
      const chunk = (
        scopeParam !== undefined ? chunkStmt.get(row.rowid, scopeParam) : chunkStmt.get(row.rowid)
      ) as { file_path: string; start_line: number; end_line: number; text: string; kind: string } | null | undefined
      if (chunk) {
        hits.push({
          filePath: chunk.file_path,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          kind: chunk.kind,
          distance: row.distance,
          text: chunk.text,
        })
      }
    }
  }

  return { hits, candidateCount: rows.length }
}

/**
 * Search for semantically similar chunks using vector similarity.
 *
 * Embeds the query, over-fetches candidates from chunk_vectors, and re-ranks
 * with verbatim boosting and generated-path penalties before truncating to topK.
 *
 * @param db - SQLite database connection.
 * @param query - Search query string.
 * @param topK - Number of results to return (default: 8).
 * @param modelName - Model to use for embedding (default: bge-small-en-v1.5).
 * @param maxDistance - Distance threshold; results above this are dropped (default: 1.2).
 * @param rootDir - When provided, scope results to chunks whose file_path lives under this
 *   project root (see {@link BACKFILL_MULTIPLIER} for how this is enforced against sqlite-vec's
 *   partition-less `chunk_vectors` table). `global.db` is a single machine-wide index shared
 *   across every project ever indexed (constants.ts), so callers that mean "search the current
 *   project" MUST pass this.
 * @returns Array of SearchHit objects, sorted by distance (best first).
 */
export async function searchSemantic(
  db: BetterSqlite3Database,
  query: string,
  topK: number = 8,
  modelName: string = DEFAULT_MODEL,
  maxDistance: number = DEFAULT_DISTANCE_THRESHOLD,
  rootDir?: string,
): Promise<SearchHit[]> {
  if (!isAvailable()) {
    console.warn('Embeddings not available; semantic search disabled')
    return []
  }

  if (query.trim().length === 0) {
    return []
  }

  // No chunk_vectors table (sqlite-vec absent) means there is nothing to match against; return no hits before paying the query-embed cost. isAvailable() gates only the model, which is independent of sqlite-vec.
  if (!chunkVectorsTableExists(db)) {
    return []
  }

  // Embed the query. BGE models are asymmetric: only the query side gets the
  // retrieval-instruction prefix (see QUERY_INSTRUCTION_PREFIX) -- document/chunk
  // embedding (the embedTexts call in chunk indexing) must stay unprefixed.
  const queryEmbeddings = await embedTexts([`${QUERY_INSTRUCTION_PREFIX}${query}`], modelName)
  if (queryEmbeddings.length === 0) {
    return []
  }

  const queryVec = queryEmbeddings[0]
  if (!queryVec) {
    return []
  }

  // Over-fetch candidates for re-ranking.
  const overFetchK = Math.min(
    MAX_OVER_FETCH,
    Math.ceil(topK * OVER_FETCH_FACTOR),
  )

  const first = fetchScopedHits(db, queryVec, overFetchK, maxDistance, rootDir)
  let hits = first.hits
  const candidateCount = first.candidateCount

  // Backfill: when scoped and the first pass didn't surface enough hits, retry once with a
  // larger k -- but only if the ANN scan actually returned as many candidates as requested
  // (candidateCount === overFetchK); if it returned fewer, the vector index is exhausted and a
  // bigger k would return the exact same rows, so retrying would just cost latency for nothing.
  if (rootDir !== undefined && hits.length < topK && candidateCount === overFetchK && overFetchK < MAX_OVER_FETCH) {
    const biggerK = Math.min(MAX_OVER_FETCH, overFetchK * BACKFILL_MULTIPLIER)
    if (biggerK > overFetchK) {
      hits = fetchScopedHits(db, queryVec, biggerK, maxDistance, rootDir).hits
    }
  }

  return rerankHits(hits, query, topK)
}

/**
 * Re-rank semantic hits by verbatim-token overlap and a generated-path penalty,
 * then truncate to `topK`. Distance is a cosine distance (smaller = closer), so
 * lower adjusted score ranks higher: a chunk whose text contains query
 * identifiers is pulled up by a bounded boost; a chunk under a generated/build
 * directory is pushed down. Each returned hit keeps its raw `distance` but also
 * gets `adjustedDistance` stamped with the rerank score, so downstream code
 * that resorts hits (e.g. mergeNearbyHits) can preserve this ordering instead
 * of silently reverting to raw-distance order.
 */
export function rerankHits(hits: SearchHit[], query: string, topK: number): SearchHit[] {
  const queryTokens = _extractQueryTokens(query)
  const scored = hits.map((hit, index) => {
    let boost = 0
    if (queryTokens.size > 0) {
      const hitTokens = _extractQueryTokens(hit.text)
      let matches = 0
      for (const token of queryTokens) {
        if (hitTokens.has(token)) {
          matches++
        }
      }
      boost = Math.min(matches * _VERBATIM_TOKEN_BOOST, _MAX_VERBATIM_BOOST)
    }
    const penalty = _isGeneratedPath(hit.filePath) ? _GENERATED_PATH_PENALTY : 0
    return { hit, index, adjusted: hit.distance - boost + penalty }
  })
  scored.sort((a, b) => a.adjusted - b.adjusted || a.index - b.index)
  return scored.slice(0, topK).map((entry) => ({ ...entry.hit, adjustedDistance: entry.adjusted }))
}

/**
 * Merge consecutive hits from the same file whose line ranges overlap or are close.
 *
 * When a function spans multiple chunks, merging prevents output from being dominated
 * by one large function.
 *
 * @param hits - Array of search hits.
 * @param proximity - Lines within which to consider hits as "nearby" (default: 20).
 * @returns Merged array of hits, re-sorted by rerank score (adjustedDistance)
 *   when present, falling back to raw distance otherwise.
 */
export function mergeNearbyHits(
  hits: SearchHit[],
  proximity: number = 20,
): SearchHit[] {
  if (hits.length <= 1) {
    return hits
  }

  // Group by file.
  const byFile = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const fileHits = byFile.get(hit.filePath)
    if (fileHits) {
      fileHits.push(hit)
    } else {
      byFile.set(hit.filePath, [hit])
    }
  }

  const merged: SearchHit[] = []

  for (const fileHits of byFile.values()) {
    fileHits.sort((a, b) => a.startLine - b.startLine)

    let current = fileHits[0]
    if (!current) {
      continue
    }

    let curStart = current.startLine
    let curEnd = current.endLine
    let curDist = current.distance
    let curAdjusted = current.adjustedDistance ?? current.distance
    const mergedTexts: string[] = [current.text]

    for (let i = 1; i < fileHits.length; i++) {
      const hit = fileHits[i]
      if (!hit) {
        continue
      }

      const gap = hit.startLine - curEnd - 1

      if (gap <= proximity) {
        // Merge: extend the range and keep best distance/rerank score, combine texts.
        curEnd = Math.max(curEnd, hit.endLine)
        curDist = Math.min(curDist, hit.distance)
        curAdjusted = Math.min(curAdjusted, hit.adjustedDistance ?? hit.distance)
        mergedTexts.push(hit.text)
      } else {
        // Gap too large: flush current and start new.
        merged.push({
          filePath: current.filePath,
          startLine: curStart,
          endLine: curEnd,
          kind: current.kind,
          distance: curDist,
          adjustedDistance: curAdjusted,
          text: mergedTexts.join('\n---\n'),
        })
        current = hit
        curStart = hit.startLine
        curEnd = hit.endLine
        curDist = hit.distance
        curAdjusted = hit.adjustedDistance ?? hit.distance
        mergedTexts.length = 0
        mergedTexts.push(hit.text)
      }
    }

    // Flush final chunk.
    merged.push({
      filePath: current.filePath,
      startLine: curStart,
      endLine: curEnd,
      kind: current.kind,
      distance: curDist,
      adjustedDistance: curAdjusted,
      text: mergedTexts.join('\n---\n'),
    })
  }

  // Sort by rerank score when available so rerankHits' ordering (verbatim-token
  // boost, generated-path penalty) survives merging, instead of silently
  // reverting to raw-distance order. Hits that never went through rerankHits
  // (no adjustedDistance) fall back to their raw distance.
  merged.sort((a, b) => (a.adjustedDistance ?? a.distance) - (b.adjustedDistance ?? b.distance))
  return merged
}

/**
 * Index a single file, computing and storing embeddings.
 *
 * @param db - SQLite database connection.
 * @param filePath - Relative path to the file.
 * @param content - File content.
 * @param boundaries - Optional structural cut points (symbol or section ranges) to
 *   snap chunking to instead of the plain sliding window - see chunkFile.
 * @returns Number of chunks created and indexed.
 */
export async function indexFile(
  db: BetterSqlite3Database,
  filePath: string,
  content: string,
  boundaries: ChunkBoundary[] = [],
): Promise<EmbedOutcome> {
  const chunks = chunkFile(filePath, content, undefined, undefined, boundaries)
  // Replace, do not append: drop the file's prior chunks (and their vectors) before inserting, so a reindex - or an edit that empties the file - leaves no stale rows behind.
  if (chunks.length > 0) {
    // upsertChunks deletes the file's prior chunks/vectors as part of the same
    // transaction as the new insert, so a failed insert can't leave them
    // deleted-but-not-replaced. It returns 'unavailable' when the optional embedding
    // deps are absent so the caller can avoid falsely stamping the file as embedded.
    return upsertChunks(db, chunks)
  }
  // An empty file has nothing to embed regardless of whether the optional deps are present,
  // so it is a genuinely terminal 'embedded' state (a bare embed_sha), never 'unavailable'.
  deleteFileEmbeddings(db, filePath)
  return 'embedded'
}

// Per-connection cache of whether `chunk_vectors` is actually usable (see chunkVectorsTableExists).
// Keyed on the connection object so it is dropped when the connection is garbage-collected. A
// connection's vec0 load state is fixed for its lifetime (db.ts loads sqlite-vec once at open),
// so caching the boolean is safe and avoids re-probing on every embed/prune/search call.
const _chunkVectorsUsable = new WeakMap<BetterSqlite3Database, boolean>()

// Is the optional sqlite-vec `chunk_vectors` virtual table actually usable on this connection?
// A plain sqlite_master name probe is not enough: the vec0 table row PERSISTS in sqlite_master
// once created, but its backing module is registered per-connection by sqlite-vec's runtime
// load. If global.db was first created while sqlite-vec loaded (so the row exists), then
// token-goat is reinstalled without the optional native dep (--no-optional, or a native build
// failure after a Node upgrade), db.ts silently swallows the failed load -- yet the row is still
// in sqlite_master. A bare name probe would return true, and the next `chunk_vectors` statement
// would throw "no such module: vec0" at prepare time, aborting whatever transaction it ran in
// (e.g. removeFileFromIndex, leaking symbols/refs/files rows) and crashing searchSemantic. So
// probe real usability with a trivial SELECT: it throws "no such table" when the row is absent
// AND "no such module: vec0" when the row exists but the module did not load, covering both.
function chunkVectorsTableExists(db: BetterSqlite3Database): boolean {
  const cached = _chunkVectorsUsable.get(db)
  if (cached !== undefined) {
    return cached
  }
  let usable: boolean
  try {
    db.prepare('SELECT rowid FROM chunk_vectors LIMIT 1').get()
    usable = true
  } catch {
    usable = false
  }
  _chunkVectorsUsable.set(db, usable)
  return usable
}

/**
 * Are BOTH optional embedding dependencies present on this connection: the @xenova/transformers
 * model ({@link isAvailable}) AND a usable sqlite-vec `chunk_vectors` table
 * ({@link chunkVectorsTableExists})? A real embed needs both -- upsertChunks reports
 * `'unavailable'` when either is missing. Freshness gates (worker.ts/cli.ts) use this to decide
 * whether an `unavailable:`-marked embed_sha must trigger a re-embed (deps now present) or can
 * still be treated as fresh (deps still absent, so re-embedding would just re-skip).
 */
export function embeddingsDepsAvailable(db: BetterSqlite3Database): boolean {
  return isAvailable() && chunkVectorsTableExists(db)
}

/**
 * Delete all embeddings for a file.
 *
 * Removes stale entries when a file is modified or deleted.
 *
 * @param _db - SQLite database connection.
 * @param _filePath - Relative path to the file.
 */
export function deleteFileEmbeddings(
  db: BetterSqlite3Database,
  filePath: string,
): void {
  const folded = foldPath(filePath)
  // Skip the vector delete when chunk_vectors is absent (sqlite-vec not installed): the table never exists on such installs, so an unconditional DELETE FROM chunk_vectors throws \"no such table\" and the chunks delete below would never run, leaking the file's chunk rows. The chunks table always exists and must always be cleared. When the vector table IS present, delete its rows first via a correlated subquery (binds zero id params, avoiding the 32766 SQL-variable limit) - the subquery reads chunks, so vectors must go before chunks.
  if (chunkVectorsTableExists(db)) {
    db.prepare(`DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE ${pathEqClause('file_path')})`).run(folded)
  }
  db.prepare(`DELETE FROM chunks WHERE ${pathEqClause('file_path')}`).run(folded)
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extract query tokens (identifiers) for verbatim boosting.
 *
 * @param query - Query string.
 * @returns Normalized set of tokens.
 */
function _extractQueryTokens(query: string): Set<string> {
  const tokens = new Set<string>()
  const matches = query.matchAll(_TOKEN_RE)
  for (const match of matches) {
    const token = match[0].toLowerCase()
    if (token.length >= _MIN_TOKEN_LEN) {
      tokens.add(token)
    }
  }
  return tokens
}

/**
 * Check if a file path is in a generated/build directory.
 *
 * @param filePath - Relative file path.
 * @returns True if any segment is a known generated directory.
 */
function _isGeneratedPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]+/)
  for (const seg of segments) {
    if (_GENERATED_PATH_SEGMENTS.has(seg.toLowerCase())) {
      return true
    }
  }
  return false
}
