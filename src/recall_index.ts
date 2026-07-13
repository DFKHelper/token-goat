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

/** Quote each whitespace-separated token of `query` as an FTS5 string literal (doubling embedded quotes) and join with implicit AND, so arbitrary user input -- including FTS5 operators like `-`, `*`, `:`, `(` -- is always treated as literal text to match rather than risking a MATCH syntax error. */
function toFtsMatchExpr(query: string): string | null {
  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

export interface RecallSearchOptions {
  type?: RecallCacheType
  limit?: number
}

function ftsSearch(query: string, type: RecallCacheType | undefined, limit: number): RecallHit[] {
  const matchExpr = toFtsMatchExpr(query)
  if (matchExpr === null) return []
  const db = getDb(globalDbPath())
  const rows = (
    type !== undefined
      ? db
          .prepare(
            `SELECT c.entry_id AS id, c.cache_type AS cacheType, c.label AS label, c.content AS content, c.stored_at AS storedAt
             FROM cache_recall_fts f
             JOIN cache_recall c ON c.row_id = f.rowid
             WHERE f MATCH ? AND c.cache_type = ?
             ORDER BY bm25(cache_recall_fts)
             LIMIT ?`,
          )
          .all(matchExpr, type, limit)
      : db
          .prepare(
            `SELECT c.entry_id AS id, c.cache_type AS cacheType, c.label AS label, c.content AS content, c.stored_at AS storedAt
             FROM cache_recall_fts f
             JOIN cache_recall c ON c.row_id = f.rowid
             WHERE f MATCH ?
             ORDER BY bm25(cache_recall_fts)
             LIMIT ?`,
          )
          .all(matchExpr, limit)
  ) as Array<{ id: string; cacheType: string; label: string | null; content: string | null; storedAt: number | null }>

  return rows
    .filter((r): r is typeof r & { cacheType: RecallCacheType } => isRecallCacheType(r.cacheType))
    .map((r) => ({
      id: r.id,
      cacheType: r.cacheType,
      label: r.label ?? '',
      snippet: buildSnippet(r.content ?? '', query),
      storedAt: r.storedAt ?? 0,
    }))
}

/** Substring fallback used when `cache_recall_fts` is unavailable (see {@link hasFtsTable}'s doc comment). No relevance ranking -- results are ordered most-recently-stored first. */
function likeSearch(query: string, type: RecallCacheType | undefined, limit: number): RecallHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const db = getDb(globalDbPath())
  const needle = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`
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

  return rows
    .filter((r): r is typeof r & { cacheType: RecallCacheType } => isRecallCacheType(r.cacheType))
    .map((r) => ({
      id: r.id,
      cacheType: r.cacheType,
      label: r.label ?? '',
      snippet: buildSnippet(r.content ?? '', trimmed),
      storedAt: r.storedAt ?? 0,
    }))
}

/**
 * Search the cross-cache recall index. Empty/whitespace-only `query` returns no
 * hits (never throws, never returns every entry -- there is no "list all"
 * mode here, use `bash-history`/`web-history`/`mcp-history` for that).
 */
export function searchRecall(query: string, opts: RecallSearchOptions = {}): RecallHit[] {
  const limit = opts.limit ?? 10
  if (query.trim() === '') return []
  try {
    if (hasFtsTable()) return ftsSearch(query, opts.type, limit)
    return likeSearch(query, opts.type, limit)
  } catch {
    // A MATCH-syntax edge case toFtsMatchExpr's quoting didn't anticipate, or any other
    // query-time failure: degrade to the substring fallback rather than surfacing an error
    // for what is fundamentally a best-effort recall lookup.
    try {
      return likeSearch(query, opts.type, limit)
    } catch {
      return []
    }
  }
}
