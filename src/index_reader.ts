/** Read side of the symbol index. Queries the `symbols`, `refs`, and `files` tables (schema in `db.ts`) that the `token-goat symbol`, `token-goat refs`, and related CLI commands surface. Mapping from snake_case DB columns to the camelCase {@link SymbolEntry} / {@link RefEntry} / {@link FileIndexEntry} shapes lives here so callers never touch raw rows. Each query accepts an optional `dbPath` (defaulting to the global index DB) so tests can point at a throwaway database. The path is passed straight to {@link getDb}, which caches one connection per resolved path. */

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import type { FileIndexEntry, RefEntry, SymbolEntry } from './parser_types.js'
import { pathEqClause as pathEq, pathSuffixClause, projectScopeClause } from './sql_path.js'
import { foldPath } from './util.js'

/** Raw `symbols` row as returned by SQLite (snake_case columns). */
interface SymbolRow {
  readonly file_path: string
  readonly name: string
  readonly kind: string
  readonly line_start: number
  readonly line_end: number
  readonly body: string | null
  readonly docstring: string | null
  readonly parent: string | null
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
  readonly parser_sha: string | null
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
    parent: row.parent ?? '',
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

/** Push {@link projectScopeClause}'s clause onto `where`/`param` onto `params` when `rootDir` is set. Shared by querySymbols/queryRefs/queryRefCounts, which all need the same "scope to files under this project root" filter against different WHERE-clause shapes. */
function applyRootDirScope(
  rootDir: string | undefined,
  column: string,
  where: string[],
  params: (string | number)[],
): void {
  if (rootDir === undefined) return
  const { clause, params: bounds } = projectScopeClause(column)
  where.push(clause)
  params.push(...bounds(rootDir))
}

interface SymbolQueryOpts {
  name?: string
  filePath?: string
  kind?: string
  rootDir?: string
  fileBaseName?: string
  /** Keep only symbols whose span covers this 1-based line. Pushed into SQL rather than filtered in the caller because `limit` is applied by the database: a caller that fetches a capped page and *then* filters for the enclosing rows silently loses any match that sorted past the cap, and reports the same "nothing encloses this line" it would for a line nothing covers. */
  enclosingLine?: number
}

/** Shared WHERE-clause builder for {@link querySymbols} and {@link countSymbols} -- both filter the same `symbols` table by the same name/filePath/kind/rootDir combination, so the clause/params construction lives in one place instead of drifting between a "fetch rows" and a "count rows" copy. */
function buildSymbolWhere(opts: SymbolQueryOpts): { clause: string; params: (string | number)[] } {
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
  if (opts.fileBaseName !== undefined) {
    const { clause: suffixClause, params: suffixParams } = pathSuffixClause('file_path')
    where.push(suffixClause)
    params.push(...suffixParams(opts.fileBaseName))
  }
  if (opts.enclosingLine !== undefined) {
    where.push('line_start <= ? AND ? <= line_end')
    params.push(opts.enclosingLine, opts.enclosingLine)
  }
  applyRootDirScope(opts.rootDir, 'file_path', where, params)

  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params }
}

/** Rows returned when a caller names no `limit`. Exported because a caller that reports whether its scan was complete has to compare its row count against the window it actually got, and an implicit default it cannot see makes that comparison silently wrong. */
export const DEFAULT_QUERY_LIMIT = 100

/** Query symbols by any combination of name, file, and kind. All filters are optional and AND-combined; an empty `opts` returns every symbol (bounded by `limit`, default 100). Results are ordered by file then starting line for stable output, so `offset` walks a file's symbols in source order and a caller that has to apply its own predicate (one no SQL clause can express, such as a user-supplied regex) can page until it has enough *matching* rows instead of filtering a window the cap already truncated. `rootDir`, when provided, scopes the query to files under that project root via {@link projectScopeClause} -- required whenever a caller means "symbols in the current project", since `dbPath` (typically `global.db`) is a single machine-wide index shared across every project ever indexed (constants.ts). */
export function querySymbols(
  opts: SymbolQueryOpts & { limit?: number; offset?: number } = {},
  dbPath: string = globalDbPath(),
): SymbolEntry[] {
  const { clause, params } = buildSymbolWhere(opts)
  const limit = opts.limit ?? DEFAULT_QUERY_LIMIT
  const offset = opts.offset ?? 0
  const sql =
    `SELECT file_path, name, kind, line_start, line_end, body, docstring, parent ` +
    // `rowid` is the tie-break, not decoration: two symbols can share a `line_start` (a class and its first method on one line, an overload pair, anything in a minified file), and SQLite's sort is not stable, so without it two `OFFSET` pages of the same query can order a tied group differently and drop or repeat a row across the page boundary. That is invisible in a single unpaged query, which is why it only became a correctness issue once a caller started paging.
    `FROM symbols ${clause} ORDER BY file_path, line_start, rowid LIMIT ? OFFSET ?`

  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(...params, limit, offset) as SymbolRow[]
  return rows.map(toSymbolEntry)
}

/** All distinct `kind` values present in the index, optionally scoped to `rootDir` (same scoping as {@link querySymbols}). Lets callers (e.g. `dead --kind`) validate a requested kind against what the index actually contains instead of guessing at a hardcoded list, since valid kinds vary per language adapter. */
export function distinctSymbolKinds(rootDir?: string, dbPath: string = globalDbPath()): string[] {
  const where: string[] = []
  const params: (string | number)[] = []
  applyRootDirScope(rootDir, 'file_path', where, params)
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const db = getDb(dbPath)
  const rows = db.prepare(`SELECT DISTINCT kind FROM symbols ${clause} ORDER BY kind`).all(...params) as Array<{ kind: string }>
  return rows.map((r) => r.kind)
}

/** True count of symbols matching the same name/filePath/kind/rootDir filters {@link querySymbols} accepts, ignoring `limit` entirely -- used so `token-goat symbol --json` can report an honest `totalCount` instead of the count of whatever `querySymbols`'s own SQL `LIMIT` happened to let through (the same "SQL LIMIT applied before the count is taken" shape that undercounted `refs --top`; see that fix's commit for the sibling bug). */
export function countSymbols(opts: SymbolQueryOpts = {}, dbPath: string = globalDbPath()): number {
  const { clause, params } = buildSymbolWhere(opts)
  const sql = `SELECT COUNT(*) as cnt FROM symbols ${clause}`
  const db = getDb(dbPath)
  const row = db.prepare(sql).get(...params) as { cnt: number }
  return row.cnt
}

/** Query references to a name, optionally scoped to one file. `name` is required (callers always know which symbol's uses they want). Results are ordered by file then line; `limit` defaults to 100. `rootDir`, when provided, scopes the query to references in files under that project root (see {@link querySymbols} for why this matters against the machine-wide `global.db`). */
/** Shared WHERE-clause builder for {@link queryRefs} and {@link countRefs} -- both filter the same `refs` table by the same name/filePath/rootDir combination, so the clause/params construction lives in one place instead of drifting between a "fetch rows" and a "count rows" copy (mirrors {@link buildSymbolWhere}). */
function buildRefsWhere(opts: { name: string; filePath?: string; rootDir?: string }): {
  clause: string
  params: (string | number)[]
} {
  const where: string[] = ['name = ?']
  const params: (string | number)[] = [opts.name]

  if (opts.filePath !== undefined) {
    where.push(pathEq('file_path'))
    params.push(foldPath(opts.filePath))
  }
  applyRootDirScope(opts.rootDir, 'file_path', where, params)

  return { clause: `WHERE ${where.join(' AND ')}`, params }
}

export function queryRefs(
  opts: {
    name: string
    filePath?: string
    limit?: number
    rootDir?: string
  },
  dbPath: string = globalDbPath(),
): RefEntry[] {
  const { clause, params } = buildRefsWhere(opts)
  const limit = opts.limit ?? DEFAULT_QUERY_LIMIT
  const sql = `SELECT file_path, name, line, col, context FROM refs ${clause} ORDER BY file_path, line LIMIT ?`

  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(...params, limit) as RefRow[]
  return rows.map(toRefEntry)
}

/** True count of refs matching the same name/filePath/rootDir filters {@link queryRefs} accepts, ignoring `limit` entirely -- used so `token-goat refs --json` can report an honest `totalCount` instead of the count of whatever `queryRefs`'s own SQL `LIMIT` happened to let through (the same shape {@link countSymbols} fixed for `token-goat symbol --json`). */
export function countRefs(opts: { name: string; filePath?: string; rootDir?: string }, dbPath: string = globalDbPath()): number {
  const { clause, params } = buildRefsWhere(opts)
  const sql = `SELECT COUNT(*) as cnt FROM refs ${clause}`
  const db = getDb(dbPath)
  const row = db.prepare(sql).get(...params) as { cnt: number }
  return row.cnt
}

/** Refs recorded with a given enclosing `context` (the class/function name the ref's line falls inside) in one specific file. Used to resolve a class's extends-clause target: an `extends_clause` ref's `context` is set to the extending class's own name (see the extends-clause parser fix), so `queryRefsByContext(className, classFile)` returns the ref(s) recorded at that class's declaration -- among which the base class name can be picked out. Narrower than {@link queryRefs} (which requires a `name` filter) for exactly this "what did this file/context reference" direction. */
export function queryRefsByContext(context: string, filePath: string, dbPath: string = globalDbPath()): RefEntry[] {
  const sql = `SELECT file_path, name, line, col, context FROM refs WHERE context = ? AND ${pathEq('file_path')} ORDER BY line LIMIT 20`
  const db = getDb(dbPath)
  const rows = db.prepare(sql).all(context, foldPath(filePath)) as RefRow[]
  return rows.map(toRefEntry)
}

/** Batched reference count per symbol name, for `outline --stats`/`skeleton --stats`. One `GROUP BY` query over all requested names instead of one query per symbol -- avoids N+1 queries when a file has many symbols. Names with zero references are simply absent from the returned map (callers should default to 0). `rootDir`, when provided, counts only references in files under that project root (see {@link querySymbols} for why this matters against the machine-wide `global.db`) -- without it, a symbol name shared with an unrelated project on the same machine inflates the count. */
/** How many names go into one `IN (...)` list. SQLite caps the highest host-parameter index a statement may use (`SQLITE_LIMIT_VARIABLE_NUMBER`), which with the anonymous `?` placeholders here is the same as a cap on how many it may carry, and it enforces the cap at `prepare` time by throwing `too many SQL variables` rather than answering short -- so the caller gets no reference counts at all rather than fewer. Measured on the build shipped here: 32,766 prepares, 32,767 throws. That number is not a constant to design against. It is the default only since SQLite 3.32; before that the default was 999, a custom build may compile in less, and a connection may lower it at runtime with `sqlite3_limit`. 900 leaves room for the two parameters the project-root scope adds under the pre-3.32 default, which is the lowest value anything is likely to be built with -- a choice, not a proof, and `a_batch_stays_under_the_lowest_sqlite_parameter_cap` is what pins it. */
const REF_COUNT_BATCH = 900

export function queryRefCounts(
  names: string[],
  dbPath: string = globalDbPath(),
  rootDir?: string,
): Map<string, number> {
  const counts = new Map<string, number>()
  if (names.length === 0) return counts

  const db = getDb(dbPath)
  const scopeWhere: string[] = []
  const scopeParams: (string | number)[] = []
  applyRootDirScope(rootDir, 'file_path', scopeWhere, scopeParams)
  const scopeSql = scopeWhere.length > 0 ? ` AND ${scopeWhere.join(' AND ')}` : ''
  const sqlFor = (width: number): string =>
    `SELECT name, COUNT(*) as c FROM refs WHERE name IN (${Array.from({ length: width }, () => '?').join(', ')})${scopeSql} GROUP BY name`
  // Every full batch is the same statement, so it is prepared once and run with different names. A
  // file with 400,000 symbols is 445 batches, and preparing that statement 445 times is 445 parses
  // of a 900-placeholder string for no gain. The last batch is usually a different width and gets
  // its own.
  const full = names.length >= REF_COUNT_BATCH ? db.prepare(sqlFor(REF_COUNT_BATCH)) : undefined
  // One read transaction over all the batches. `global.db` is written by the background indexer while this reads, so without it batch 1 and batch 445 can see different databases and the map would mix counts from either side of a reindex -- something the single statement this replaced could not do. The cost is that the snapshot is pinned for the whole loop: in WAL, which is what `db.ts` puts every connection in, that does not block the writer but does defer checkpointing for as long as the read runs. Measured against the live 400,157-symbol index on 2026-09-14: 135,079 names is 150 batches and 420 ms end to end, 50,000 names 75 ms, 5,000 names 4 ms. Half a second of deferred checkpointing is a smaller price than a count that is half from before a reindex and half from after.
  db.transaction(() => {
    for (let start = 0; start < names.length; start += REF_COUNT_BATCH) {
      const batch = names.slice(start, start + REF_COUNT_BATCH)
      const stmt = batch.length === REF_COUNT_BATCH && full !== undefined ? full : db.prepare(sqlFor(batch.length))
      for (const row of stmt.all(...batch, ...scopeParams) as Array<{ name: string; c: number }>) {
        counts.set(row.name, row.c)
      }
    }
  })()
  return counts
}

/** Every indexed file under `rootDir`, keyed by its folded path. The bulk counterpart to {@link getFileEntry}, for the one caller that needs the whole project's rows at once: `reconcile.ts` compares each tracked file on disk against its indexed fingerprint, and doing that through per-file `getFileEntry` calls would mean one prepared statement execution per file -- hundreds of round trips on the session-start hot path, to answer a question a single scoped scan answers. Keyed by folded path so the caller can look up a disk path without re-deriving the case-folding rule the query already applied. */
export function getProjectFileEntries(
  rootDir: string,
  dbPath: string = globalDbPath(),
): Map<string, FileIndexEntry> {
  const db = getDb(dbPath)
  const { clause, params } = projectScopeClause('path')
  const rows = db
    .prepare(`SELECT path, sha, mtime, language, indexed_at, embed_sha, parser_sha FROM files WHERE ${clause}`)
    .all(...params(rootDir)) as FileRow[]

  const out = new Map<string, FileIndexEntry>()
  for (const row of rows) {
    out.set(foldPath(row.path), {
      filePath: row.path,
      sha: row.sha ?? '',
      mtime: row.mtime ?? 0,
      language: row.language ?? 'unknown',
      indexedAt: row.indexed_at ?? 0,
      embedSha: row.embed_sha ?? '',
      parserSha: row.parser_sha ?? '',
    })
  }
  return out
}

/** Fetch the index entry for one file by its stored path. Returns `null` when the file is not in the index. */
export function getFileEntry(
  filePath: string,
  dbPath: string = globalDbPath(),
): FileIndexEntry | null {
  const db = getDb(dbPath)
  const row = db
    .prepare(
      `SELECT path, sha, mtime, language, indexed_at, embed_sha, parser_sha FROM files WHERE ${pathEq('path')}`,
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
    parserSha: row.parser_sha ?? '',
  }
}

// Quote each whitespace-separated term as an FTS5 string literal so that characters FTS5 treats as query operators (`:` `(` `)` `*`, AND/OR/NOT) in a natural-language query are matched literally instead of throwing a syntax error that the catch below would swallow into an empty result. `join` controls how the quoted terms combine: FTS5 treats bare whitespace between terms as implicit AND, so 'AND' (the default) requires every term to co-occur in one symbol -- exact/narrow searches want this for precision. 'OR' relaxes that to "any term", used as a widen-on-empty fallback by searchSymbolsFts below for realistic multi-word natural-language queries where requiring every word to co-occur is unrealistically strict.
export function sanitizeFtsQuery(query: string, join: 'AND' | 'OR' = 'AND'): string {
  const terms = query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
  return terms.join(join === 'OR' ? ' OR ' : ' ')
}

/** Runs one FTS5 MATCH query and maps rows to {@link SymbolEntry}. Shared by both the strict AND-joined attempt and the OR-joined widen-on-empty retry in {@link searchSymbolsFts}. */
function runFtsQuery(
  db: ReturnType<typeof getDb>,
  match: string,
  limit: number,
  scope: ReturnType<typeof projectScopeClause> | undefined,
  rootDir: string | undefined,
): SymbolEntry[] {
  // FTS5's MATCH operator and bm25() must name the FTS table directly — a table alias resolves as a bare column reference ("no such column: f"), which the catch below would silently swallow, leaving `semantic` permanently empty.
  const sql =
    `SELECT s.file_path, s.name, s.kind, s.line_start, s.line_end, s.body, s.docstring, s.parent ` +
    `FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid ` +
    `WHERE symbols_fts MATCH ?${scope !== undefined ? ` AND ${scope.clause}` : ''} ORDER BY bm25(symbols_fts) LIMIT ?`
  const params: (string | number)[] = [match]
  if (scope !== undefined && rootDir !== undefined) {
    params.push(...scope.params(rootDir))
  }
  params.push(limit)
  const rows = db.prepare(sql).all(...params) as SymbolRow[]
  return rows.map(toSymbolEntry)
}

/** Full-text symbol search over the `symbols_fts` mirror. Joins FTS hits back to `symbols` to return full {@link SymbolEntry} rows in BM25 relevance order. Falls back to an empty result (rather than throwing) if the FTS5 table is unavailable in this SQLite build or the query is malformed. Tries an AND-joined query first (every term must co-occur in one symbol — the more precise, higher-confidence match) and, only if that returns zero rows, retries with an OR-joined query (any term matches, ranked by bm25()). A realistic natural-language query like "add retry logic to the webfetch cache" rarely has every one of its words co-occurring verbatim in a single symbol's indexed text, so a bare AND join returned nothing for exactly the phrasings this search exists to handle; OR-joining unconditionally risked over-broad, low-relevance results for queries that WOULD have matched under AND. Widening only on a genuine zero-hit AND result keeps the precise path for anyone whose terms do co-occur, while still surfacing something for a phrase that doesn't. `rootDir`, when provided, scopes the search to files under that project root (see {@link querySymbols} for why this matters against the machine-wide `global.db`) -- without it, results leak in symbols from every other project ever indexed on the machine. */
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
