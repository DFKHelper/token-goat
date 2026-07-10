/**
 * Read side of the symbol index.
 *
 * Queries the `symbols`, `refs`, and `files` tables (schema in `db.ts`) that the
 * `token-goat symbol`, `token-goat refs`, and related CLI commands surface.
 * Mapping from snake_case DB columns to the camelCase {@link SymbolEntry} /
 * {@link RefEntry} / {@link FileIndexEntry} shapes lives here so callers never
 * touch raw rows.
 *
 * Each query accepts an optional `dbPath` (defaulting to the global index DB) so
 * tests can point at a throwaway database. The path is passed straight to
 * {@link getDb}, which caches one connection per resolved path.
 */

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import type { FileIndexEntry, RefEntry, SymbolEntry } from './parser_types.js'
import { pathEqClause as pathEq } from './sql_path.js'
import { foldPath } from './util.js'

/** Raw `symbols` row as returned by better-sqlite3 (snake_case columns). */
interface SymbolRow {
  readonly file_path: string
  readonly name: string
  readonly kind: string
  readonly line_start: number
  readonly line_end: number
  readonly body: string | null
  readonly docstring: string | null
}

/** Raw `refs` row. */
interface RefRow {
  readonly file_path: string
  readonly name: string
  readonly line: number
  readonly col: number
  readonly context: string | null
}

/** Raw `files` row. */
interface FileRow {
  readonly path: string
  readonly sha: string | null
  readonly mtime: number | null
  readonly language: string | null
  readonly indexed_at: number | null
  readonly embed_sha: string | null
}

function toSymbolEntry(row: SymbolRow): SymbolEntry {
  return {
    filePath: row.file_path,
    name: row.name,
    kind: row.kind,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    body: row.body ?? '',
    docstring: row.docstring ?? '',
  }
}

function toRefEntry(row: RefRow): RefEntry {
  return {
    filePath: row.file_path,
    name: row.name,
    line: row.line,
    col: row.col,
    context: row.context ?? '',
  }
}

/**
 * Query symbols by any combination of name, file, and kind.
 *
 * All filters are optional and AND-combined; an empty `opts` returns every
 * symbol (bounded by `limit`, default 100). Results are ordered by file then
 * starting line for stable output.
 */
export function querySymbols(
  opts: {
    name?: string
    filePath?: string
    kind?: string
    limit?: number
  } = {},
  dbPath: string = globalDbPath(),
): SymbolEntry[] {
  const where: string[] = []
  const params: (string | number)[] = []

  if (opts.name !== undefined) {
    where.push('name = ?')
    params.push(opts.name)
  }
  if (opts.filePath !== undefined) {
    where.push(pathEq('file_path'))
    params.push(foldPath(opts.filePath))
  }
  if (opts.kind !== undefined) {
    where.push('kind = ?')
    params.push(opts.kind)
  }

  const limit = opts.limit ?? 100
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const sql =
    `SELECT file_path, name, kind, line_start, line_end, body, docstring ` +
    `FROM symbols ${clause} ORDER BY file_path, line_start LIMIT ?`

  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(...params, limit) as SymbolRow[]
  return rows.map(toSymbolEntry)
}

/**
 * Query references to a name, optionally scoped to one file.
 *
 * `name` is required (callers always know which symbol's uses they want).
 * Results are ordered by file then line; `limit` defaults to 100.
 */
export function queryRefs(
  opts: {
    name: string
    filePath?: string
    limit?: number
  },
  dbPath: string = globalDbPath(),
): RefEntry[] {
  const where: string[] = ['name = ?']
  const params: (string | number)[] = [opts.name]

  if (opts.filePath !== undefined) {
    where.push(pathEq('file_path'))
    params.push(foldPath(opts.filePath))
  }

  const limit = opts.limit ?? 100
  const sql =
    `SELECT file_path, name, line, col, context FROM refs ` +
    `WHERE ${where.join(' AND ')} ORDER BY file_path, line LIMIT ?`

  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(...params, limit) as RefRow[]
  return rows.map(toRefEntry)
}

/**
 * Batched reference count per symbol name, for `outline --stats`/`skeleton --stats`. One
 * `GROUP BY` query over all requested names instead of one query per symbol -- avoids N+1
 * queries when a file has many symbols. Names with zero references are simply absent from
 * the returned map (callers should default to 0).
 */
export function queryRefCounts(names: string[], dbPath: string = globalDbPath()): Map<string, number> {
  const counts = new Map<string, number>()
  if (names.length === 0) return counts

  const db = getDb(dbPath)
  const placeholders = names.map(() => '?').join(', ')
  const sql = `SELECT name, COUNT(*) as c FROM refs WHERE name IN (${placeholders}) GROUP BY name`
  const rows = db.prepare(sql).all(...names) as Array<{ name: string; c: number }>
  for (const row of rows) {
    counts.set(row.name, row.c)
  }
  return counts
}

/**
 * Fetch the index entry for one file by its stored path. Returns `null` when
 * the file is not in the index.
 */
export function getFileEntry(
  filePath: string,
  dbPath: string = globalDbPath(),
): FileIndexEntry | null {
  const db = getDb(dbPath)
  const row = db
    .prepare(
      `SELECT path, sha, mtime, language, indexed_at, embed_sha FROM files WHERE ${pathEq('path')}`,
    )
    .get(foldPath(filePath)) as FileRow | undefined

  if (row === undefined) return null
  return {
    filePath: row.path,
    sha: row.sha ?? '',
    mtime: row.mtime ?? 0,
    language: row.language ?? 'unknown',
    indexedAt: row.indexed_at ?? 0,
    embedSha: row.embed_sha ?? '',
  }
}

// Quote each whitespace-separated term as an FTS5 string literal so that characters FTS5 treats as query operators (`:` `(` `)` `*`, AND/OR/NOT) in a natural-language query are matched literally instead of throwing a syntax error that the catch below would swallow into an empty result.
function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
    .join(' ')
}

/**
 * Full-text symbol search over the `symbols_fts` mirror.
 *
 * Joins FTS hits back to `symbols` to return full {@link SymbolEntry} rows in
 * BM25 relevance order. Falls back to an empty result (rather than throwing) if
 * the FTS5 table is unavailable in this SQLite build or the query is malformed.
 */
export function searchSymbolsFts(
  query: string,
  limit = 50,
  dbPath: string = globalDbPath(),
): SymbolEntry[] {
  const match = sanitizeFtsQuery(query)
  if (match === '') return []

  const db = getDb(dbPath)
  // FTS5's MATCH operator and bm25() must name the FTS table directly — a table alias resolves as a bare column reference ("no such column: f"), which the catch below would silently swallow, leaving `semantic` permanently empty.
  const sql =
    `SELECT s.file_path, s.name, s.kind, s.line_start, s.line_end, s.body, s.docstring ` +
    `FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid ` +
    `WHERE symbols_fts MATCH ? ORDER BY bm25(symbols_fts) LIMIT ?`
  try {
    const rows = db.prepare(sql).all(match, limit) as SymbolRow[]
    return rows.map(toSymbolEntry)
  } catch {
    // FTS5 missing or a syntactically invalid MATCH query — degrade to empty.
    return []
  }
}
