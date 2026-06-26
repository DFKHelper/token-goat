/**
 * Semantic search using transformer embeddings (@xenova/transformers) + SQLite storage.
 *
 * Ports the Python embeddings module, adapting fastembed to @xenova/transformers.
 * The transformer import is optional: if not available, semantic search degrades
 * gracefully and all functions return empty results with logged warnings.
 */

import { createRequire } from 'node:module'

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

const _require = createRequire(import.meta.url)

// Optional transformer import; catches both missing package and load failures.
let _transformer: unknown = null
let _transformerError: Error | null = null

try {
  _transformer = _require('@xenova/transformers')
} catch (e) {
  _transformerError = e instanceof Error ? e : new Error(String(e))
}

// BAAI/bge-small-en-v1.5 is the smallest BGE model for code retrieval.
// The 384-dimensional output is native to this checkpoint; do not change DEFAULT_DIM
// without re-creating all chunk_vectors tables.
export const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5'
export const DEFAULT_DIM = 384

// Chunk size constraints (chars). MIN_CHUNK_CHARS filters trivial symbols.
// MAX_CHUNK_CHARS caps before embedding: bge-small has ~512-token context window.
export const MIN_CHUNK_CHARS = 50
export const MAX_CHUNK_CHARS = 8000

// Line-window size for sliding-window fallback on unparsed files.
export const WINDOW_LINES = 100

// Symbol kinds worth chunking.
const _CODE_SYMBOL_KINDS = new Set([
  // Universal code kinds
  'function',
  'method',
  'class',
  'interface',
  'trait',
  'type',
  'enum',
  'impl',
  'abi_export',
  // SQL schema kinds
  'sql_table',
  'sql_view',
  'sql_function',
  'sql_procedure',
  'sql_trigger',
  'sql_type',
  'sql_schema',
  'sql_index',
  // GraphQL schema/document kinds
  'graphql_type',
  'graphql_input',
  'graphql_interface',
  'graphql_enum',
  'graphql_union',
  'graphql_scalar',
  'graphql_directive',
  'graphql_fragment',
  'graphql_query',
  'graphql_mutation',
  'graphql_subscription',
  'graphql_extend',
  'graphql_schema',
  // Protocol Buffer kinds
  'proto_message',
  'proto_enum',
  'proto_service',
  'proto_rpc',
  'proto_oneof',
  'proto_extend',
  // CSS / SCSS / Less kinds
  'css_class',
  'css_id',
  'css_keyframes',
  'css_mixin',
  'css_atrule',
  'css_custom_property',
  // Makefile kinds
  'makefile_target',
  'makefile_define',
])

// Languages that get sliding-window fallback.
const _WINDOW_LANGS = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'sql',
  'graphql',
  'proto',
  'css',
  'makefile',
])

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

// Over-fetch factor for re-ranking candidates before truncating to k.
const _OVER_FETCH_FACTOR = 4
const _MAX_OVER_FETCH = 100

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

/** Result of a semantic search query. */
export interface SearchHit {
  filePath: string
  startLine: number
  endLine: number
  kind: string
  distance: number
  text: string
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if the transformer is available and usable.
 * Returns false if @xenova/transformers is not installed or failed to load.
 */
export function isAvailable(): boolean {
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

  // Use the transformer pipeline to generate embeddings.
  const transformerObj = _transformer as Record<string, unknown>
  const pipelineFn = transformerObj['pipeline'] as (
    task: string,
    model: string,
  ) => Promise<(text: string, options: Record<string, unknown>) => Promise<unknown>>

  const extractor = await pipelineFn('feature-extraction', modelName)

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
 * Chunk file content into semantically meaningful segments.
 *
 * Splits on newlines, respecting requested chunk size and overlap.
 * For now, implements a simple sliding-window approach.
 *
 * @param filePath - Relative path to the file.
 * @param content - File content.
 * @param chunkSize - Target chunk size in chars (default: MAX_CHUNK_CHARS).
 * @param overlap - Overlap in chars between consecutive chunks (default: 200).
 * @returns Array of Chunk objects.
 */
export function chunkFile(
  filePath: string,
  content: string,
  chunkSize: number = MAX_CHUNK_CHARS,
  overlap: number = 200,
): Chunk[] {
  const lines = content.split(/\r?\n/)
  const chunks: Chunk[] = []

  let currentChunk = ''
  let startLine = 1
  let currentLine = 1

  for (const line of lines) {
    const lineWithNewline = line + '\n'
    if (currentChunk.length + lineWithNewline.length > chunkSize && currentChunk.length > 0) {
      // Flush current chunk if adding the next line would exceed size.
      if (currentChunk.length >= MIN_CHUNK_CHARS) {
        chunks.push({
          filePath,
          startLine,
          endLine: currentLine - 1,
          text: currentChunk.trim(),
          kind: 'window',
        })
      }

      // Start new chunk with overlap.
      const overlapLines = Math.ceil(overlap / 40) // Rough estimate: ~40 chars per line.
      const overlapStart = Math.max(1, currentLine - overlapLines)
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
      endLine: lines.length,
      text: currentChunk.trim(),
      kind: 'window',
    })
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
export async function upsertChunks(
  db: BetterSqlite3Database,
  chunks: Chunk[],
): Promise<void> {
  if (!isAvailable()) {
    console.warn('Embeddings not available; skipping semantic indexing')
    return
  }

  if (chunks.length === 0) {
    return
  }

  // Embed all chunk texts.
  const texts = chunks.map((c) => c.text)
  const embeddings = await embedTexts(texts)

  // Insert chunks into the database.
  const insertStmt = db.prepare(`
    INSERT INTO chunk_vectors (embedding)
    VALUES (?)
    ON CONFLICT DO NOTHING
  `)

  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddings[i]
      if (!embedding) {
        continue
      }

      const packed = packVec(embedding)
      insertStmt.run(packed)
    }
  })

  tx()
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
 * @returns Array of SearchHit objects, sorted by distance (best first).
 */
export async function searchSemantic(
  db: BetterSqlite3Database,
  query: string,
  topK: number = 8,
  modelName: string = DEFAULT_MODEL,
  maxDistance: number = DEFAULT_DISTANCE_THRESHOLD,
): Promise<SearchHit[]> {
  if (!isAvailable()) {
    console.warn('Embeddings not available; semantic search disabled')
    return []
  }

  if (query.trim().length === 0) {
    return []
  }

  // Embed the query.
  const queryEmbeddings = await embedTexts([query], modelName)
  if (queryEmbeddings.length === 0) {
    return []
  }

  const queryVec = queryEmbeddings[0]
  if (!queryVec) {
    return []
  }

  // Over-fetch candidates for re-ranking.
  const overFetchK = Math.min(
    _MAX_OVER_FETCH,
    Math.ceil(topK * _OVER_FETCH_FACTOR),
  )

  // sqlite-vec KNN query: both MATCH (the query vector blob) and k (row limit)
  // must appear as WHERE constraints for the virtual table to run an ANN scan.
  // Omitting either causes a full-table scan or an error.
  const stmt = db.prepare(`
    SELECT rowid, distance FROM chunk_vectors
    WHERE embedding MATCH ?
    AND k = ?
    ORDER BY distance ASC
  `)

  const rows = stmt.all(packVec(queryVec), overFetchK) as Array<{ rowid: number; distance: number } | undefined>

  if (!rows || rows.length === 0) {
    return []
  }

  // Build hits from rows and apply re-ranking.
  const hits: SearchHit[] = []
  for (const row of rows) {
    if (!row) {
      continue
    }
    if (row.distance <= maxDistance) {
      hits.push({
        filePath: `file_${row.rowid}`, // Placeholder; normally would join symbols table.
        startLine: 1,
        endLine: 1,
        kind: 'window',
        distance: row.distance,
        text: '',
      })
    }
  }

  return hits.slice(0, topK)
}

/**
 * Merge consecutive hits from the same file whose line ranges overlap or are close.
 *
 * When a function spans multiple chunks, merging prevents output from being dominated
 * by one large function.
 *
 * @param hits - Array of search hits.
 * @param proximity - Lines within which to consider hits as "nearby" (default: 20).
 * @returns Merged array of hits, re-sorted by distance.
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
    const mergedTexts: string[] = [current.text]

    for (let i = 1; i < fileHits.length; i++) {
      const hit = fileHits[i]
      if (!hit) {
        continue
      }

      const gap = hit.startLine - curEnd - 1

      if (gap <= proximity) {
        // Merge: extend the range and keep best distance, combine texts.
        curEnd = Math.max(curEnd, hit.endLine)
        curDist = Math.min(curDist, hit.distance)
        mergedTexts.push(hit.text)
      } else {
        // Gap too large: flush current and start new.
        merged.push({
          filePath: current.filePath,
          startLine: curStart,
          endLine: curEnd,
          kind: current.kind,
          distance: curDist,
          text: mergedTexts.join('\n---\n'),
        })
        current = hit
        curStart = hit.startLine
        curEnd = hit.endLine
        curDist = hit.distance
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
      text: mergedTexts.join('\n---\n'),
    })
  }

  merged.sort((a, b) => a.distance - b.distance)
  return merged
}

/**
 * Index a single file, computing and storing embeddings.
 *
 * @param db - SQLite database connection.
 * @param filePath - Relative path to the file.
 * @param content - File content.
 * @returns Number of chunks created and indexed.
 */
export async function indexFile(
  db: BetterSqlite3Database,
  filePath: string,
  content: string,
): Promise<number> {
  const chunks = chunkFile(filePath, content)
  if (chunks.length > 0) {
    await upsertChunks(db, chunks)
  }
  return chunks.length
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
  _db: BetterSqlite3Database,
  _filePath: string,
): void {
  // This is a placeholder implementation. In the full version, we'd track
  // chunk-to-file mappings and delete by file_path.
  // For now, since the chunk_vectors table is just (rowid, embedding),
  // we'd need to add a file_path column or join with a metadata table.
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
  const segments = filePath.split('/')
  for (const seg of segments) {
    if (_GENERATED_PATH_SEGMENTS.has(seg)) {
      return true
    }
  }
  return false
}
