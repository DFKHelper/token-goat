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
import { pathEqClause as pathEq, projectScopeClause } from './sql_path.js'
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
 *
 * `rootDir`, when provided, scopes the query to files under that project root
 * via {@link projectScopeClause} -- required whenever a caller means "symbols
 * in the current project", since `dbPath` (typically `global.db`) is a single
 * machine-wide index shared across every project ever indexed (constants.ts).
 */
/** Push {@link projectScopeClause}'s clause onto `where`/`param` onto `params` when `rootDir` is set. Shared by querySymbols/queryRefs/queryRefCounts, which all need the same "scope to files under this project root" filter against different WHERE-clause shapes. */
function applyRootDirScope(
  rootDir: string | undefined,
  column: string,
  where: string[],
  params: (string | number)[],
): void {
  if (rootDir === undefined) return
  const { clause, param } = projectScopeClause(column)
  where.push(clause)
  params.push(param(rootDir))
}

export function querySymbols(
  opts: {
    name?: string
    filePath?: string
    kind?: string
    limit?: number
    rootDir?: string
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
  applyRootDirScope(opts.rootDir, 'file_path', where, params)

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
 *
 * `rootDir`, when provided, scopes the query to references in files under that
 * project root (see {@link querySymbols} for why this matters against the
 * machine-wide `global.db`).
 */
export function queryRefs(
  opts: {
    name: string
    filePath?: string
    limit?: number
    rootDir?: string
  },
  dbPath: string = globalDbPath(),
): RefEntry[] {
  const where: string[] = ['name = ?']
  const params: (string | number)[] = [opts.name]

  if (opts.filePath !== undefined) {
    where.push(pathEq('file_path'))
    params.push(foldPath(opts.filePath))
  }
  applyRootDirScope(opts.rootDir, 'file_path', where, params)

  const limit = opts.limit ?? 100
  const sql =
    `SELECT file_path, name, line, col, context FROM refs ` +
    `WHERE ${where.join(' AND ')} ORDER BY file_path, line LIMIT ?`

  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(...params, limit) as RefRow[]
  return rows.map(toRefEntry)
}

/**
 * Refs recorded with a given enclosing `context` (the class/function name the ref's line falls
 * inside) in one specific file. Used to resolve a class's extends-clause target: an
 * `extends_clause` ref's `context` is set to the extending class's own name (see the
 * extends-clause parser fix), so `queryRefsByContext(className, classFile)` returns the ref(s)
 * recorded at that class's declaration -- among which the base class name can be picked out.
 * Narrower than {@link queryRefs} (which requires a `name` filter) for exactly this "what did
 * this file/context reference" direction.
 */
export function queryRefsByContext(context: string, filePath: string, dbPath: string = globalDbPath()): RefEntry[] {
  const sql = `SELECT file_path, name, line, col, context FROM refs WHERE context = ? AND ${pathEq('file_path')} ORDER BY line LIMIT 20`
  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(context, foldPath(filePath)) as RefRow[]
  return rows.map(toRefEntry)
}

/**
 * Batched reference count per symbol name, for `outline --stats`/`skeleton --stats`. One
 * `GROUP BY` query over all requested names instead of one query per symbol -- avoids N+1
 * queries when a file has many symbols. Names with zero references are simply absent from
 * the returned map (callers should default to 0).
 *
 * `rootDir`, when provided, counts only references in files under that project root (see
 * {@link querySymbols} for why this matters against the machine-wide `global.db`) -- without
 * it, a symbol name shared with an unrelated project on the same machine inflates the count.
 */
export function queryRefCounts(
  names: string[],
  dbPath: string = globalDbPath(),
  rootDir?: string,
): Map<string, number> {
  const counts = new Map<string, number>()
  if (names.length === 0) return counts

  const db = getDb(dbPath)
  const placeholders = names.map(() => '?').join(', ')
  const params: (string | number)[] = [...names]
  const scopeWhere: string[] = []
  applyRootDirScope(rootDir, 'file_path', scopeWhere, params)
  const scopeSql = scopeWhere.length > 0 ? ` AND ${scopeWhere.join(' AND ')}` : ''
  const sql = `SELECT name, COUNT(*) as c FROM refs WHERE name IN (${placeholders})${scopeSql} GROUP BY name`
  const rows = db.prepare(sql).all(...params) as Array<{ name: string; c: number }>
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

// Quote each whitespace-separated term as an FTS5 string literal so that characters FTS5 treats
// as query operators (`:` `(` `)` `*`, AND/OR/NOT) in a natural-language query are matched
// literally instead of throwing a syntax error that the catch below would swallow into an empty
// result. `join` controls how the quoted terms combine: FTS5 treats bare whitespace between
// terms as implicit AND, so 'AND' (the default) requires every term to co-occur in one symbol --
// exact/narrow searches want this for precision. 'OR' relaxes that to "any term", used as a
// widen-on-empty fallback by searchSymbolsFts below for realistic multi-word natural-language
// queries where requiring every word to co-occur is unrealistically strict.
export function sanitizeFtsQuery(query: string, join: 'AND' | 'OR' = 'AND'): string {
  const terms = query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
  return terms.join(join === 'OR' ? ' OR ' : ' ')
}

/** Runs one FTS5 MATCH query and maps rows to {@link SymbolEntry}. Shared by both the strict
 * AND-joined attempt and the OR-joined widen-on-empty retry in {@link searchSymbolsFts}. */
function runFtsQuery(
  db: ReturnType<typeof getDb>,
  match: string,
  limit: number,
  scope: ReturnType<typeof projectScopeClause> | undefined,
  rootDir: string | undefined,
): SymbolEntry[] {
  // FTS5's MATCH operator and bm25() must name the FTS table directly — a table alias resolves as a bare column reference ("no such column: f"), which the catch below would silently swallow, leaving `semantic` permanently empty.
  const sql =
    `SELECT s.file_path, s.name, s.kind, s.line_start, s.line_end, s.body, s.docstring ` +
    `FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid ` +
    `WHERE symbols_fts MATCH ?${scope !== undefined ? ` AND ${scope.clause}` : ''} ORDER BY bm25(symbols_fts) LIMIT ?`
  const params: (string | number)[] = [match]
  if (scope !== undefined && rootDir !== undefined) {
    params.push(scope.param(rootDir))
  }
  params.push(limit)
  const rows = db.prepare(sql).all(...params) as SymbolRow[]
  return rows.map(toSymbolEntry)
}

/**
 * Full-text symbol search over the `symbols_fts` mirror.
 *
 * Joins FTS hits back to `symbols` to return full {@link SymbolEntry} rows in
 * BM25 relevance order. Falls back to an empty result (rather than throwing) if
 * the FTS5 table is unavailable in this SQLite build or the query is malformed.
 *
 * Tries an AND-joined query first (every term must co-occur in one symbol — the more precise,
 * higher-confidence match) and, only if that returns zero rows, retries with an OR-joined query
 * (any term matches, ranked by bm25()). A realistic natural-language query like "add retry logic
 * to the webfetch cache" rarely has every one of its words co-occurring verbatim in a single
 * symbol's indexed text, so a bare AND join returned nothing for exactly the phrasings this
 * search exists to handle; OR-joining unconditionally risked over-broad, low-relevance results
 * for queries that WOULD have matched under AND. Widening only on a genuine zero-hit AND result
 * keeps the precise path for anyone whose terms do co-occur, while still surfacing something
 * for a phrase that doesn't.
 *
 * `rootDir`, when provided, scopes the search to files under that project root
 * (see {@link querySymbols} for why this matters against the machine-wide
 * `global.db`) -- without it, results leak in symbols from every other project
 * ever indexed on the machine.
 */
export function searchSymbolsFts(
  query: string,
  limit = 50,
  dbPath: string = globalDbPath(),
  rootDir?: string,
): SymbolEntry[] {
  const andMatch = sanitizeFtsQuery(query, 'AND')
  if (andMatch === '') return []

  const db = getDb(dbPath)
  const scope = rootDir !== undefined ? projectScopeClause('s.file_path') : undefined
  try {
    const andResults = runFtsQuery(db, andMatch, limit, scope, rootDir)
    if (andResults.length > 0) return andResults

    const orMatch = sanitizeFtsQuery(query, 'OR')
    if (orMatch === andMatch) return andResults
    return runFtsQuery(db, orMatch, limit, scope, rootDir)
  } catch {
    // FTS5 missing or a syntactically invalid MATCH query — degrade to empty.
    return []
  }
}
