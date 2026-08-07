/**
 * Cross-cache full-text search index for `token-goat recall`.
 *
 * bash-output, web-output, and mcp-output entries are already persisted through
 * disk_cache.ts's `storeBlob()` at their three write call sites
 * (`storeBashOutput` in bash_output_cache.ts, `storeWebOutput` in web_cache.ts,
 * `storeMcpOutput` in mcp_cache.ts). Each of those calls {@link indexRecallEntry}
 * right after, so the recall index stays current with no separate rebuild step
 * and no second on-disk store to maintain.
 *
 * The index itself is a table in the same SQLite database as the code index
 * (`globalDbPath()`, see db.ts) rather than a second database file, reusing the
 * existing connection-pool/pragma/migration machinery. `cache_recall_fts` is a
 * content-linked FTS5 virtual table over `cache_recall`, defined in db.ts's
 * SCHEMA_SQL/FTS_SQL exactly like `symbols_fts`. FTS5 is confirmed available in
 * this project's better-sqlite3 build (symbols_fts already relies on it), but
 * db.ts's schema setup wraps FTS_SQL in a try/catch as defense in depth for a
 * SQLite build that lacks it -- {@link searchRecall} mirrors that by falling
 * back to a plain `LIKE` scan over `cache_recall` (no ranking, most-recent-first)
 * when `cache_recall_fts` does not exist.
 */

import { getDb } from './db.js'
import { globalDbPath } from './constants.js'
import { sanitizeFtsQuery } from './index_reader.js'

export type RecallCacheType = 'bash' | 'web' | 'mcp'

export interface RecallHit {
  readonly id: string
  readonly cacheType: RecallCacheType
  readonly label: string
  readonly snippet: string
  readonly storedAt: number
}

const VALID_TYPES: readonly RecallCacheType[] = ['bash', 'web', 'mcp']

export function isRecallCacheType(value: string): value is RecallCacheType {
  return (VALID_TYPES as readonly string[]).includes(value)
}

/**
 * Persist/refresh one searchable entry keyed by (cacheType, id).
 *
 * Fail-soft: never throws, mirroring disk_cache.ts's `storeBlob` contract, so a
 * recall-indexing failure (e.g. a locked or corrupt index DB) never blocks the
 * cache write it accompanies -- the underlying bash/web/mcp cache entry is
 * still stored and recallable by its own id even if it doesn't become
 * searchable via `recall`.
 */
export function indexRecallEntry(cacheType: RecallCacheType, id: string, label: string, content: string, storedAt: number): void {
  try {
    const db = getDb(globalDbPath())
    db.prepare(
      `INSERT INTO cache_recall (cache_type, entry_id, label, content, stored_at)
       VALUES (@cacheType, @id, @label, @content, @storedAt)
       ON CONFLICT(cache_type, entry_id) DO UPDATE SET
         label = excluded.label,
         content = excluded.content,
         stored_at = excluded.stored_at`,
    ).run({ cacheType, id, label, content, storedAt })
  } catch {
    // Fail-soft: see doc comment above.
  }
}

let _ftsAvailable: boolean | null = null

/** Cached per-process check for whether `cache_recall_fts` exists on the current db handle. Reset alongside the rest of the DB layer by registerReset in db.ts closing connections (a fresh getDb() re-runs schema setup, so a stale cached `true` here would only matter if FTS5 support could change within one process's lifetime, which it cannot). */
function hasFtsTable(): boolean {
  if (_ftsAvailable !== null) return _ftsAvailable
  try {
    const db = getDb(globalDbPath())
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache_recall_fts'`).get()
    _ftsAvailable = row !== undefined
  } catch {
    _ftsAvailable = false
  }
  return _ftsAvailable
}

/** Test-only: force the next {@link hasFtsTable} check to be recomputed (e.g. after a test closes/reopens the db). */
export function resetRecallFtsCacheForTesting(): void {
  _ftsAvailable = null
}

/**
 * Test-only: delete every row from `cache_recall` (the `cache_recall_ad` AFTER DELETE trigger
 * keeps `cache_recall_fts` in sync automatically). Nonce-prefixed ids keep separate tests' rows
 * from ever matching each other's queries, but SQLite FTS5's `bm25()` ranking is computed from
 * corpus-wide statistics (average document length, total row count) regardless of which rows a
 * query actually matches -- so a ranking-order assertion between two specific rows can flip
 * simply because unrelated rows accumulated earlier in the same shared worker process shifted
 * those corpus statistics. Call this to give a ranking test a clean, single-tenant corpus.
 */
export function clearRecallEntriesForTesting(): void {
  const db = getDb(globalDbPath())
  db.exec('DELETE FROM cache_recall')
}

/** Build a short, single-line excerpt of `content` centered on the first case-insensitive occurrence of any query token, falling back to a leading slice when no token is found verbatim (e.g. an FTS prefix/stem match). */
function buildSnippet(content: string, query: string, maxLen = 160): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const tokens = query.split(/\s+/).filter(Boolean)
  let idx = -1
  const lowerFlat = flat.toLowerCase()
  for (const token of tokens) {
    const at = lowerFlat.indexOf(token.toLowerCase())
    if (at !== -1) {
      idx = at
      break
    }
  }
  if (idx === -1) {
    return flat.length > maxLen ? flat.slice(0, maxLen) + '...' : flat
  }
  const start = Math.max(0, idx - Math.floor(maxLen / 3))
  const end = Math.min(flat.length, start + maxLen)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < flat.length ? '...' : ''
  return prefix + flat.slice(start, end) + suffix
}

/** Quote each whitespace-separated token of `query` as an FTS5 string literal via the shared
 * {@link sanitizeFtsQuery} (index_reader.ts), so arbitrary user input -- including FTS5
 * operators like `-`, `*`, `:`, `(` -- is always treated as literal text to match rather than
 * risking a MATCH syntax error. Returns null for an all-whitespace/empty query so callers can
 * skip the search instead of running a MATCH against an empty string. */
function toFtsMatchExpr(query: string): string | null {
  if (query.trim().length === 0) return null
  return sanitizeFtsQuery(query)
}

export interface RecallSearchOptions {
  type?: RecallCacheType
  limit?: number
}

/** Filter to known cache types and map raw query rows to {@link RecallHit}s. Shared by ftsSearch and likeSearch, which produce identically-shaped rows from different queries. */
function mapRowsToHits(
  rows: Array<{ id: string; cacheType: string; label: string | null; content: string | null; storedAt: number | null }>,
  snippetQuery: string,
): RecallHit[] {
  return rows
    .filter((r): r is typeof r & { cacheType: RecallCacheType } => isRecallCacheType(r.cacheType))
    .map((r) => ({
      id: r.id,
      cacheType: r.cacheType,
      label: r.label ?? '',
      snippet: buildSnippet(r.content ?? '', snippetQuery),
      storedAt: r.storedAt ?? 0,
    }))
}

function ftsSearch(query: string, type: RecallCacheType | undefined, limit: number): RecallHit[] {
  const matchExpr = toFtsMatchExpr(query)
  if (matchExpr === null) return []
  const db = getDb(globalDbPath())
  // No alias on cache_recall_fts: aliasing an FTS5 virtual table on the left side of `MATCH` (e.g. `... FROM cache_recall_fts f WHERE f MATCH ?`) throws `no such column: f` in this project's SQLite build (confirmed against better-sqlite3's bundled 3.49.2) -- a MATCH clause against an FTS5 table must reference the table by its real name. Only the content table (cache_recall) is aliased.
  const rows = (
    type !== undefined
      ? db
          .prepare(
            `SELECT c.entry_id AS id, c.cache_type AS cacheType, c.label AS label, c.content AS content, c.stored_at AS storedAt
             FROM cache_recall_fts
             JOIN cache_recall c ON c.row_id = cache_recall_fts.rowid
             WHERE cache_recall_fts MATCH ? AND c.cache_type = ?
             ORDER BY bm25(cache_recall_fts)
             LIMIT ?`,
          )
          .all(matchExpr, type, limit)
      : db
          .prepare(
            `SELECT c.entry_id AS id, c.cache_type AS cacheType, c.label AS label, c.content AS content, c.stored_at AS storedAt
             FROM cache_recall_fts
             JOIN cache_recall c ON c.row_id = cache_recall_fts.rowid
             WHERE cache_recall_fts MATCH ?
             ORDER BY bm25(cache_recall_fts)
             LIMIT ?`,
          )
          .all(matchExpr, limit)
  ) as Array<{ id: string; cacheType: string; label: string | null; content: string | null; storedAt: number | null }>

  return mapRowsToHits(rows, query)
}

/** Substring fallback used when `cache_recall_fts` is unavailable (see {@link hasFtsTable}'s doc comment). No relevance ranking -- results are ordered most-recently-stored first. */
function likeSearch(query: string, type: RecallCacheType | undefined, limit: number): RecallHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const db = getDb(globalDbPath())
  // Backslash must be escaped first -- ESCAPE '\' means an unescaped literal `\` in the pattern (e.g. from a Windows path like `C:\Users`) is otherwise consumed as an escape marker and silently stripped, so the pattern never matches the real backslash in the text.
  const needle = `%${trimmed.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`)}%`
  const rows = (
    type !== undefined
      ? db
          .prepare(
            `SELECT entry_id AS id, cache_type AS cacheType, label, content, stored_at AS storedAt
             FROM cache_recall
             WHERE cache_type = ? AND (label LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
             ORDER BY stored_at DESC
             LIMIT ?`,
          )
          .all(type, needle, needle, limit)
      : db
          .prepare(
            `SELECT entry_id AS id, cache_type AS cacheType, label, content, stored_at AS storedAt
             FROM cache_recall
             WHERE label LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
             ORDER BY stored_at DESC
             LIMIT ?`,
          )
          .all(needle, needle, limit)
  ) as Array<{ id: string; cacheType: string; label: string | null; content: string | null; storedAt: number | null }>

  return mapRowsToHits(rows, trimmed)
}

/** Test-only: exercises the LIKE fallback directly, without needing to disable the real `cache_recall_fts` schema (dropping/rebuilding an FTS5 virtual table mid-suite corrupts the shared test db). */
export function likeSearchForTesting(query: string, type?: RecallCacheType, limit = 10): RecallHit[] {
  return likeSearch(query, type, limit)
}

/**
 * Browse the cross-cache recall index with no query: every cached entry, newest
 * first, optionally narrowed to one cache type. This is the browse counterpart to
 * {@link searchRecall}, and it exists for the same reason `recall` does at all --
 * an agent that doesn't know which cache type holds a result shouldn't have to run
 * `bash-history`, `web-history`, and `mcp-history` in turn. Snippets are built with
 * an empty query, which {@link buildSnippet} renders as a leading extract.
 * Fail-soft like the rest of this module: any query-time failure yields no rows
 * rather than surfacing an error for a best-effort lookup.
 */
export function listRecentRecall(opts: RecallSearchOptions = {}): RecallHit[] {
  const limit = opts.limit ?? 10
  const columns = `SELECT entry_id AS id, cache_type AS cacheType, label, content, stored_at AS storedAt FROM cache_recall`
  try {
    const db = getDb(globalDbPath())
    const rows = (
      opts.type !== undefined
        ? db.prepare(`${columns} WHERE cache_type = ? ORDER BY stored_at DESC LIMIT ?`).all(opts.type, limit)
        : db.prepare(`${columns} ORDER BY stored_at DESC LIMIT ?`).all(limit)
    ) as Array<{ id: string; cacheType: string; label: string | null; content: string | null; storedAt: number | null }>
    return mapRowsToHits(rows, '')
  } catch {
    return []
  }
}

/**
 * Search the cross-cache recall index. Empty/whitespace-only `query` returns no
 * hits (never throws, never returns every entry) -- {@link listRecentRecall} is
 * the deliberate "list all" entry point, so that a caller asking to *search* for
 * nothing never silently receives everything.
 */
export function searchRecall(query: string, opts: RecallSearchOptions = {}): RecallHit[] {
  const limit = opts.limit ?? 10
  if (query.trim() === '') return []
  try {
    if (hasFtsTable()) {
      return ftsSearch(query, opts.type, limit)
    }
    return likeSearch(query, opts.type, limit)
  } catch {
    // A MATCH-syntax edge case toFtsMatchExpr's quoting didn't anticipate, or any other query-time failure: degrade to the substring fallback rather than surfacing an error for what is fundamentally a best-effort recall lookup.
    try {
      return likeSearch(query, opts.type, limit)
    } catch {
      return []
    }
  }
}
