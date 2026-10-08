/** Full-text symbol search split by kind, for the `search` command's symbol and heading channels. Headings and code symbols share one `symbols_fts` table, so an unfiltered query capped at `limit` can come back all headings and leave the symbol channel empty, or the reverse; filtering on `kind` inside the SQL, before the LIMIT, gives each channel its own `limit` rows. This lives here rather than as a parameter on index_reader.ts::searchSymbolsFts because index_reader.ts is an embedding-fingerprint source (scripts/parser-fingerprint.mjs::embedFingerprintSources): any edit to it moves EMBED_FINGERPRINT and makes every user re-embed their whole index, which a search-only filter has no reason to cost. */

import { getReadDb } from '../db.js'
import { sanitizeFtsQuery } from '../index_reader.js'
import type { SymbolEntry } from '../parser_types.js'
import { ownProjectScope } from '../nested_worktrees.js'

/** Which side of the heading/symbol split a query keeps. */
export type SymbolKindFilter = { readonly equals: string } | { readonly notEquals: string }

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

function runKindFtsQuery(dbPath: string, match: string, limit: number, rootDir: string | undefined, kind: SymbolKindFilter): SymbolEntry[] {
  const scope = rootDir !== undefined ? ownProjectScope('s.file_path', rootDir) : undefined
  const kindClause = 'equals' in kind ? 's.kind = ?' : 's.kind != ?'
  // FTS5's MATCH operator and bm25() must name the FTS table directly: a table alias resolves as a bare column reference.
  const sql =
    `SELECT s.file_path, s.name, s.kind, s.line_start, s.line_end, s.body, s.docstring, s.parent ` +
    `FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid ` +
    `WHERE symbols_fts MATCH ?${scope !== undefined ? ` AND ${scope.clause}` : ''} AND ${kindClause} ORDER BY bm25(symbols_fts) LIMIT ?`
  const params: (string | number)[] = [match]
  if (scope !== undefined) params.push(...scope.params)
  params.push('equals' in kind ? kind.equals : kind.notEquals, limit)
  const rows = getReadDb(dbPath).prepare(sql).all(...params) as SymbolRow[]
  return rows.map((row) => ({
    filePath: row.file_path,
    name: row.name,
    kind: row.kind,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    body: row.body ?? '',
    docstring: row.docstring ?? '',
    parent: row.parent ?? '',
  }))
}

/** Same matching as index_reader.ts::searchSymbolsFts (every term first, any term when that finds nothing), restricted to one side of `kind`. Degrades to empty when FTS5 is missing or the MATCH expression is invalid. */
export function searchSymbolsFtsByKind(query: string, limit: number, dbPath: string, rootDir: string | undefined, kind: SymbolKindFilter): SymbolEntry[] {
  const andMatch = sanitizeFtsQuery(query, 'AND')
  if (andMatch === '') return []
  try {
    const andResults = runKindFtsQuery(dbPath, andMatch, limit, rootDir, kind)
    if (andResults.length > 0) return andResults
    const orMatch = sanitizeFtsQuery(query, 'OR')
    if (orMatch === andMatch) return andResults
    return runKindFtsQuery(dbPath, orMatch, limit, rootDir, kind)
  } catch {
    return []
  }
}
