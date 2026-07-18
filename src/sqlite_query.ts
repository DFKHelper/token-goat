/**
 * Narrow schema summary + read-only query extraction for `token-goat sqlite-schema` /
 * `sqlite-query`, so a project's `.db`/`.sqlite`/`.sqlite3` fixture never needs a raw-byte
 * `Read` (useless) or a shelled-out `sqlite3` CLI (may not be installed, unstructured output)
 * just to answer "what tables does this have" or "what's in table X where Y = Z". Matches the
 * project's "no premature abstraction" bar (see csv_query.ts / json_query.ts for the same
 * philosophy applied to CSV/JSON).
 *
 * Security posture (sqlite-query only executes text an agent -- or a prompt-injection payload
 * embedded in file content the agent is processing -- hands it, so this is a trust boundary):
 *
 *  1. The connection itself is opened `{ readonly: true }` (a real, supported better-sqlite3 /
 *     libsqlite3 option -- SQLite's core refuses any write at the OS/VFS level under
 *     `SQLITE_OPEN_READONLY`, independent of anything the SQL text says).
 *  2. `validateReadOnlySelect` rejects the SQL text itself before it ever reaches
 *     `db.prepare()`: single-statement only (no `;`-separated multi-statement injection),
 *     must start with `SELECT` or `WITH` (CTE prefix), and must not contain any
 *     data-modification/DDL/transaction/attach/pragma keyword anywhere outside a string
 *     literal or comment.
 *  3. `stmt.reader` (better-sqlite3's own "does this statement return rows" flag) is checked
 *     after `prepare()` as a third, independent layer -- catches any statement shape our
 *     keyword scan didn't anticipate.
 *
 * Row/execution cap: better-sqlite3 is synchronous and exposes no query-cancellation or
 * progress-handler hook (verified against the installed 11.10.0 -- no `interrupt`/`progress`
 * on `Database`/`Statement`), so there is no real wall-clock timeout available. The mitigation
 * is a hard cap on rows pulled from the result iterator (`stmt.iterate()`, not `stmt.all()`,
 * so we stop asking SQLite to produce more rows the moment the cap is hit rather than buffering
 * an unbounded array first). This bounds "give me every row of a huge join" -- the common
 * runaway case -- but does NOT bound a single-row aggregate over a pathological cartesian
 * product (e.g. `SELECT COUNT(*) FROM a, b, c`): SQLite must still fully evaluate the join to
 * produce that one row, and no cap on rows *returned* changes that. That residual risk is the
 * same for a `LIMIT`-wrapping approach (an outer `LIMIT` doesn't stop the inner scan either),
 * so it isn't a reason to prefer one mitigation over the other; documented here rather than
 * silently assumed away.
 */

import * as fs from 'node:fs'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

/** Hard cap on rows pulled from a query's result iterator, independent of any caller-supplied
 * `--head`. Bounds worst-case memory/time for "return everything" queries against a huge table
 * or join; a caller wanting a smaller slice still uses `--head` on top of this. */
export const SQLITE_QUERY_ROW_CAP = 5000

// First 16 bytes of every valid SQLite database file (the fixed "SQLite format 3\0" header
// magic) -- checked before ever handing the path to better-sqlite3, so a non-database file
// (or a corrupt one whose header is intact but body isn't) gets a clean "not a SQLite
// database" message instead of an opaque native-addon exception.
const SQLITE_MAGIC = Buffer.from([0x53,0x51,0x4c,0x69,0x74,0x65,0x20,0x66,0x6f,0x72,0x6d,0x61,0x74,0x20,0x33,0x00])

function readMagicBytes(filePath: string): Buffer | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length)
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
    return bytesRead === buf.length ? buf : null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** True when `filePath` exists and its first 16 bytes match the SQLite file-header magic. Does
 * not guarantee the rest of the file is well-formed (a truncated/corrupt body still opens the
 * header check but fails later at `db.prepare()`/query time, which is caught separately). */
export function isSqliteFile(filePath: string): boolean {
  const magic = readMagicBytes(filePath)
  return magic !== null && magic.equals(SQLITE_MAGIC)
}

/** Opens `filePath` as a read-only SQLite connection. Never creates a file (fileMustExist) and
 * never accepts a path that doesn't exist or doesn't look like a SQLite database -- both fail
 * fast with a plain Error instead of reaching the native addon with a bogus path. */
export function openReadonlySqlite(filePath: string): BetterSqlite3Database {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`)
  }
  if (!isSqliteFile(filePath)) {
    throw new Error(`not a valid SQLite database (bad file header): ${filePath}`)
  }
  try {
    return new Database(filePath, { readonly: true, fileMustExist: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`failed to open SQLite database: ${msg}`, { cause: e })
  }
}

function quoteIdent(name: string): string {
  // PRAGMA statements can't take bound (`?`) parameters in SQLite -- the table/index name has
  // to be interpolated into the statement text. Standard SQLite double-quoted-identifier
  // escaping (embedded `"` doubled) makes this safe even though the name isn't attacker
  // input in the adversarial sense (it always comes from this same database's own
  // sqlite_master, not from the CLI caller).
  return `"${name.replace(/"/g, '""')}"`
}

export interface SqliteColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
  defaultValue: string | null
}

export interface SqliteIndexInfo {
  name: string
  unique: boolean
  columns: string[]
}

export interface SqliteForeignKeyInfo {
  table: string
  from: string
  to: string
}

export interface SqliteTableInfo {
  name: string
  kind: 'table' | 'view'
  columns: SqliteColumnInfo[]
  indexes: SqliteIndexInfo[]
  foreignKeys: SqliteForeignKeyInfo[]
  /** Row count via `SELECT COUNT(*)`, or null when that count itself fails (e.g. a view over a
   * missing/broken dependency). */
  rowCount: number | null
}

export interface SqliteSchemaResult {
  tables: SqliteTableInfo[]
}

interface TableInfoRow {
  name: string
  type: string
  notnull: number
  pk: number
  dflt_value: string | null
}
interface IndexListRow {
  name: string
  unique: number
}
interface IndexInfoRow {
  name: string
}
interface ForeignKeyRow {
  table: string
  from: string
  to: string
}

/**
 * Structural summary of a SQLite database: every table/view with its column list (name,
 * declared type, nullable/PK flags from `PRAGMA table_info`), indexes (`PRAGMA index_list` +
 * `PRAGMA index_info`), foreign keys (`PRAGMA foreign_key_list`), and a row count. Mirrors what
 * `outlineJson` does for JSON structure -- concise structural facts, not a dump.
 */
export function getSqliteSchema(filePath: string): SqliteSchemaResult {
  const db = openReadonlySqlite(filePath)
  try {
    const objects = db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>

    const tables: SqliteTableInfo[] = objects.map((o) => {
      const columns: SqliteColumnInfo[] = (db.prepare(`PRAGMA table_info(${quoteIdent(o.name)})`).all() as TableInfoRow[]).map(
        (c) => ({
          name: c.name,
          type: c.type || '',
          notNull: c.notnull === 1,
          primaryKey: c.pk > 0,
          defaultValue: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
        }),
      )

      const indexes: SqliteIndexInfo[] = (db.prepare(`PRAGMA index_list(${quoteIdent(o.name)})`).all() as IndexListRow[]).map(
        (idx) => {
          const idxColumns = (db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as IndexInfoRow[]).map((c) => c.name)
          return { name: idx.name, unique: idx.unique === 1, columns: idxColumns }
        },
      )

      const foreignKeys: SqliteForeignKeyInfo[] = (
        db.prepare(`PRAGMA foreign_key_list(${quoteIdent(o.name)})`).all() as ForeignKeyRow[]
      ).map((fk) => ({ table: fk.table, from: fk.from, to: fk.to }))

      let rowCount: number | null
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(o.name)}`).get() as { c: number }
        rowCount = row.c
      } catch {
        // A view over a missing/broken dependency, or any other count failure -- report the
        // table/view's shape without a row count rather than failing the whole schema summary.
        rowCount = null
      }

      return { name: o.name, kind: o.type === 'view' ? 'view' : 'table', columns, indexes, foreignKeys, rowCount }
    })

    return { tables }
  } finally {
    db.close()
  }
}

export function formatSqliteSchema(result: SqliteSchemaResult): string {
  if (result.tables.length === 0) return '(no tables or views found)'
  return result.tables
    .map((t) => {
      const lines = [`${t.name}  (${t.kind}${t.rowCount !== null ? `, ${t.rowCount} row${t.rowCount === 1 ? '' : 's'}` : ''})`]
      for (const c of t.columns) {
        const flags = [c.primaryKey ? 'PK' : null, c.notNull ? 'NOT NULL' : null, c.defaultValue !== null ? `DEFAULT ${c.defaultValue}` : null]
          .filter((f): f is string => f !== null)
          .join(' ')
        lines.push(`  ${c.name} ${c.type || '(untyped)'}${flags ? `  ${flags}` : ''}`)
      }
      if (t.indexes.length > 0) {
        lines.push('  indexes:')
        for (const idx of t.indexes) {
          lines.push(`    ${idx.name}${idx.unique ? ' (unique)' : ''}: ${idx.columns.join(', ')}`)
        }
      }
      if (t.foreignKeys.length > 0) {
        lines.push('  foreign keys:')
        for (const fk of t.foreignKeys) {
          lines.push(`    ${fk.from} -> ${fk.table}.${fk.to}`)
        }
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

// Keywords that mutate data/schema, change transaction state, or reach outside this one
// database file (ATTACH). Checked as whole words against the SQL text with string literals and
// comments stripped out first, so a literal like `WHERE note = 'please DELETE me'` or a
// `-- DROP the old rows first` comment never trips the scan. `REPLACE` gets special treatment
// below: SQLite also has a scalar `replace(x, y, z)` string function, so a bare word-boundary
// match on `REPLACE` would reject a completely read-only `SELECT replace(name, 'a', 'b') ...`.
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'ATTACH',
  'DETACH',
  'TRUNCATE',
  'VACUUM',
  'REINDEX',
  'PRAGMA',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'GRANT',
  'REVOKE',
]

/**
 * Replaces the contents of string/quoted-identifier literals and comments with spaces
 * (preserving overall shape, not positions) so keyword/semicolon scanning below never matches
 * text that's actually inert data or commentary rather than SQL syntax.
 */
function stripSqlLiteralsAndComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += ' '
      i++
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '[') {
      out += ' '
      i++
      while (i < n && sql[i] !== ']') i++
      if (i < n) i++
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Rejects anything that isn't a single, read-only `SELECT` (optionally CTE-prefixed via
 * `WITH`/`WITH RECURSIVE`) statement. Throws with a specific reason on failure; returns nothing
 * on success. This is the SQL-text half of sqlite-query's defense-in-depth -- the connection is
 * also opened read-only (openReadonlySqlite), and `stmt.reader` is re-checked after prepare().
 */
export function validateReadOnlySelect(sql: string): void {
  const stripped = stripSqlLiteralsAndComments(sql)
  const trimmed = stripped.trim()
  if (trimmed === '') {
    throw new Error('empty query')
  }

  const withoutTrailingSemicolons = trimmed.replace(/;+\s*$/, '')
  if (withoutTrailingSemicolons.includes(';')) {
    throw new Error('multiple statements are not allowed (sqlite-query accepts exactly one read-only SELECT statement)')
  }

  const upper = withoutTrailingSemicolons.toUpperCase()
  if (!/^(SELECT|WITH)\b/.test(upper.trimStart())) {
    throw new Error('only SELECT statements are allowed (sqlite-query is read-only)')
  }

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      throw new Error(`statement contains forbidden keyword '${kw}' (sqlite-query only allows read-only SELECT queries)`)
    }
  }
  // REPLACE is only forbidden as the "REPLACE INTO ..." / "INSERT OR REPLACE" statement form,
  // not as the scalar replace(...) function -- reject a bare REPLACE keyword only when it is
  // NOT immediately followed by '(' (a function call).
  if (/\bREPLACE\b(?!\s*\()/.test(upper)) {
    throw new Error("statement contains forbidden keyword 'REPLACE' (sqlite-query only allows read-only SELECT queries)")
  }
}

export type SqliteScalar = string | number | bigint | null | Uint8Array

export interface SqliteQueryRow {
  [column: string]: SqliteScalar
}

export interface SqliteQueryResult {
  columns: string[]
  rows: SqliteQueryRow[]
  /** True when the result was truncated by SQLITE_QUERY_ROW_CAP (more rows existed than were
   * fetched from the iterator). Independent of any caller-side `--head` limiting. */
  rowCapped: boolean
}

/**
 * Runs a validated, read-only `SELECT` against `filePath` and returns up to `rowCap` rows.
 * Iterates (`stmt.iterate()`) rather than buffering the whole result (`stmt.all()`) so a
 * runaway "return everything" query stops pulling rows from SQLite the moment the cap is hit,
 * instead of materializing an unbounded array first. See the module doc for why this does not
 * bound a single-row pathological aggregate.
 */
export function runReadOnlySqliteQuery(filePath: string, sql: string, opts: { rowCap?: number } = {}): SqliteQueryResult {
  validateReadOnlySelect(sql)
  const rowCap = opts.rowCap ?? SQLITE_QUERY_ROW_CAP

  const db = openReadonlySqlite(filePath)
  try {
    let stmt
    try {
      stmt = db.prepare(sql)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`invalid SQL: ${msg}`, { cause: e })
    }

    // Third defense-in-depth layer: better-sqlite3's own classification of whether this
    // statement produces rows. Catches any non-SELECT shape the keyword scan didn't
    // anticipate (e.g. a future SQLite statement form not yet in FORBIDDEN_KEYWORDS).
    if (!stmt.reader) {
      throw new Error('only read-only SELECT statements are allowed (sqlite-query is read-only)')
    }

    let columns: string[] = []
    try {
      columns = stmt.columns().map((c) => c.name)
    } catch {
      columns = []
    }

    const rows: SqliteQueryRow[] = []
    let rowCapped = false
    for (const row of stmt.iterate() as IterableIterator<SqliteQueryRow>) {
      if (rows.length >= rowCap) {
        rowCapped = true
        break
      }
      rows.push(row)
    }

    return { columns, rows, rowCapped }
  } finally {
    db.close()
  }
}

function formatSqliteCell(value: SqliteScalar | undefined): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return `<blob ${value.length} bytes>`
  return String(value)
}

export function formatSqliteQueryTable(result: SqliteQueryResult, opts: { headTruncated?: boolean } = {}): string {
  if (result.columns.length === 0 && result.rows.length === 0) return '(no rows)'
  const lines = [
    result.columns.map(quoteCsvCellLocal).join(','),
    ...result.rows.map((r) => result.columns.map((c) => quoteCsvCellLocal(formatSqliteCell(r[c]))).join(',')),
  ]
  if (opts.headTruncated === true) {
    lines.push('...(more rows elided; use --head to see more)')
  }
  if (result.rowCapped) {
    lines.push(`...(result truncated at the ${SQLITE_QUERY_ROW_CAP}-row safety cap; narrow the query with WHERE/LIMIT for a complete result)`)
  }
  return lines.join('\n')
}

// Local copy of csv_query.ts's quoteCsvCell RFC-4180 quoting rule (comma/quote/newline -> quoted,
// embedded quotes doubled) so sqlite_query.ts doesn't need a cross-module dependency just for
// this one formatting helper.
function quoteCsvCellLocal(cell: string): string {
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`
  }
  return cell
}
