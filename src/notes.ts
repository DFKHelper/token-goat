/** Architecture-notes storage layer. The `notes` table (schema in db.ts) holds free-text Markdown notes attached either to a whole file or to one specific indexed symbol within it, plus a fingerprint captured at write time of exactly what the note describes. This module owns the raw SQL and row-shape translation for that table -- the same role index_reader.ts plays for symbols/refs -- so CLI-facing command handlers (note-add in cli.ts, note-get/note-list in read_commands.ts) never touch raw rows or SQL directly. Staleness detection (isNoteStale) is the mechanical half of the feature: it recomputes the same fingerprint against the CURRENT index and compares. It never mutates or deletes a note -- a note whose fingerprint no longer matches is only flagged (via `note-list --stale-only`), never silently rewritten or discarded, so a human/agent decides whether the stale prose is still worth keeping. */

import * as fs from 'node:fs'
import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { fingerprintContent } from './fingerprint.js'
import { querySymbols } from './index_reader.js'
import { indexedSourceText } from './indexed_source.js'
import type { SymbolEntry } from './parser_types.js'
import { FIND_SCAN_LIMIT } from './query_limits.js'
import { findParentName, findSymbolCandidates } from './read_spec.js'
import { pathEqClause as pathEq } from './sql_path.js'
import { foldPath } from './util.js'

/** Sentinel `symbol` value for a note attached to a whole file rather than one indexed symbol. `''` rather than `NULL`: SQLite's `UNIQUE(file_path, symbol)` treats `NULL`s as pairwise-distinct (never conflicting with each other), which would let note-add accumulate unlimited duplicate whole-file notes for the same file instead of upserting one -- `''` is a real, comparable value, so the constraint (and every `WHERE symbol = ?` lookup here) treats "no symbol" the same way for both reads and writes. */
export const WHOLE_FILE_NOTE_SYMBOL = ''

export interface NoteRow {
  readonly id: number
  readonly filePath: string
  /** {@link WHOLE_FILE_NOTE_SYMBOL} for a note attached to the whole file. */
  readonly symbol: string
  readonly content: string
  readonly fingerprint: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw `notes` row as returned by SQLite (snake_case columns). */
interface NoteDbRow {
  readonly id: number
  readonly file_path: string
  readonly symbol: string
  readonly content: string
  readonly fingerprint: string
  readonly created_at: number
  readonly updated_at: number
}

function toNoteRow(row: NoteDbRow): NoteRow {
  return {
    id: row.id,
    filePath: row.file_path,
    symbol: row.symbol,
    content: row.content,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** What a symbol name names in one file: nothing, exactly one declaration, or declarations in several containers, each with the qualified name that picks it. */
export type SymbolMatch =
  | { kind: 'ok'; entry: SymbolEntry }
  | { kind: 'none' }
  | { kind: 'ambiguous'; symbol: string; candidates: { entry: SymbolEntry; qualifiedName: string }[] }

/** Split same-named rows into declaration groups by container: rows under one container are one declaration (TypeScript overloads and their implementation, a type and a value sharing a name, a redefined Python function), while a function and a method, or two classes' same-named methods, are different declarations. Grouping by container alone keeps every group nameable, since two groups never share a qualified name. */
function declarationGroups(rows: readonly SymbolEntry[], dbPath: string): { parent: string | null; rows: SymbolEntry[] }[] {
  const fileSymbols = new Map<string, SymbolEntry[]>()
  const groups = new Map<string, { parent: string | null; rows: SymbolEntry[] }>()
  for (const row of rows) {
    let siblings = fileSymbols.get(row.filePath)
    if (siblings === undefined) {
      siblings = querySymbols({ filePath: row.filePath, limit: FIND_SCAN_LIMIT }, dbPath)
      fileSymbols.set(row.filePath, siblings)
    }
    const parent = findParentName(row, siblings)
    const key = JSON.stringify([row.filePath, parent])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { parent, rows: [row] })
    else group.rows.push(row)
  }
  return [...groups.values()]
}

/** One entry standing for a whole declaration group: its first row with the bodies of every row, in line order, joined, so a note on an overloaded function goes stale when the implementation changes and not only when its first signature does. A lone row with a stored body is returned unchanged. */
function groupEntry(group: readonly SymbolEntry[]): SymbolEntry {
  const rows = [...group].sort((x, y) => x.lineStart - y.lineStart)
  const first = rows[0] as SymbolEntry
  if (rows.length === 1 && first.body !== '') return first
  const body = rows.map((r) => (r.body !== '' ? r.body : bodyFromSource(r))).join('\n')
  return { ...first, lineEnd: Math.max(...rows.map((r) => r.lineEnd)), body }
}

/** Resolve `symbolName` against the symbols currently indexed for `filePath`, the way `token-goat read file::symbol` does: a qualified `Class.method` is narrowed to that container, and a bare name shared by unrelated declarations is `ambiguous` instead of bound to whichever starts first. `none` is for the caller to interpret (a hard error at note-add time; unconditional staleness at note-list time). An `ok` entry's `body` is filled in from the source file over the symbol's line range when the stored one is empty, mirroring read_commands.ts's `resolveBody`. Both consumers of this function fingerprint `body` to detect that the code under a note has changed, and an empty body fingerprints to the same constant for every such symbol -- so without this fallback a note attached to one would never go stale. Bodies are legitimately empty for symbols an extractor emits without text, and for any symbol over parser.ts's MAX_SYMBOL_BODY_CHARS, which is stored elided precisely so readers re-derive it from source. */
export function resolveSymbolMatch(
  filePath: string,
  symbolName: string,
  dbPath: string = globalDbPath(),
): SymbolMatch {
  const { candidates, displaySymbol } = findSymbolCandidates(filePath, filePath, symbolName, undefined, dbPath)
  const seen = new Set<string>()
  const distinct = candidates.filter((c) => {
    const key = `${c.filePath}|${c.lineStart}|${c.lineEnd}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (distinct.length === 0) return { kind: 'none' }
  if (distinct.length === 1) return { kind: 'ok', entry: groupEntry(distinct) }
  const groups = declarationGroups(distinct, dbPath)
  if (groups.length === 1) return { kind: 'ok', entry: groupEntry((groups[0] as { rows: SymbolEntry[] }).rows) }
  // A bare name means the file-level declaration that holds it, as it does in the source, and `Class.method` names each of the others; a note cannot store `read`'s `name@line` form, so this is the only way to pick the file-level one.
  const fileLevel = groups.find((g) => g.parent === null)
  if (fileLevel !== undefined && !symbolName.includes('.')) return { kind: 'ok', entry: groupEntry(fileLevel.rows) }
  const declarations = groups
    .map((g) => ({ entry: groupEntry(g.rows), qualifiedName: g.parent === null ? displaySymbol : `${g.parent}.${displaySymbol}` }))
    .sort((x, y) => x.entry.lineStart - y.entry.lineStart)
  return { kind: 'ambiguous', symbol: displaySymbol, candidates: declarations }
}

/** Source text over `entry`'s line range, or '' when the file is unreadable (deleted, permissions). */
function bodyFromSource(entry: SymbolEntry): string {
  try {
    return indexedSourceText(entry.filePath, fs.readFileSync(entry.filePath, 'utf8'))
      .split(/\r?\n/)
      .slice(Math.max(0, entry.lineStart - 1), entry.lineEnd)
      .join('\n')
  } catch {
    return ''
  }
}

/** Every distinct symbol name currently indexed for `filePath`, sorted -- used to build a "did you mean" list when `--symbol` doesn't resolve to anything. */
export function symbolNamesInFile(filePath: string, dbPath: string = globalDbPath()): string[] {
  // Unbounded (-1), not a finite cap: querySymbols orders by (file_path, line_start) with no other predicate on a bare filePath query, so a finite limit silently drops the file's tail symbols from the "did you mean" list instead of bounding a real search. Same fix as ALL_SYMBOLS_IN_FILE_LIMIT in graph_commands.ts.
  const symbols = querySymbols({ filePath, limit: -1 }, dbPath)
  return [...new Set(symbols.map((s) => s.name))].sort()
}

/** Fingerprint anchor for a whole-file note: a digest of every currently indexed symbol's name/kind/line-range for `filePath`, sorted for determinism. Adding, removing, or moving any symbol in the file changes this digest even when no single symbol's own body changed -- that is the "did the code shift under this note" signal a file-scoped note is checked against. */
export function computeFileFingerprint(filePath: string, dbPath: string = globalDbPath()): string {
  // Unbounded (-1), not a finite cap: same bare-filePath-query shape as symbolNamesInFile above, and a truncated manifest would make a symbol added or moved past the cutoff invisible to the fingerprint, so a genuinely-stale note would report as fresh.
  const symbols = querySymbols({ filePath, limit: -1 }, dbPath)
  const manifest = symbols
    .map((s) => `${s.name}:${s.kind}:${s.lineStart}-${s.lineEnd}`)
    .sort()
    .join('\n')
  return fingerprintContent(manifest)
}

/** Every fingerprint `symbolName` currently has in `filePath`: none when it no longer resolves (renamed or removed), one when it names a single declaration, several when it has since become ambiguous (a note set before another same-named symbol appeared is still current while the declaration it was bound to is unchanged). */
export function computeSymbolFingerprints(
  filePath: string,
  symbolName: string,
  dbPath: string = globalDbPath(),
): string[] {
  const match = resolveSymbolMatch(filePath, symbolName, dbPath)
  if (match.kind === 'none') return []
  return (match.kind === 'ok' ? [match.entry] : match.candidates.map((c) => c.entry)).map((e) => fingerprintContent(e.body))
}

/** Fingerprint anchor for a symbol-attached note: the resolved symbol's current body text. `null` unless the name resolves to exactly one declaration in that file (renamed, removed, or ambiguous) -- there is nothing single to fingerprint. */
export function computeSymbolFingerprint(
  filePath: string,
  symbolName: string,
  dbPath: string = globalDbPath(),
): string | null {
  const all = computeSymbolFingerprints(filePath, symbolName, dbPath)
  return all.length === 1 ? (all[0] as string) : null
}

/** Insert-or-update the note for `(filePath, symbol)` -- re-running note-add for the same attachment point overwrites content/fingerprint/updated_at rather than accumulating duplicate rows; the match is path-fold aware, like getNote. */
export function upsertNote(
  filePath: string,
  symbol: string,
  content: string,
  fingerprint: string,
  dbPath: string = globalDbPath(),
): void {
  const db = getDb(dbPath)
  const now = Date.now() / 1000
  // The UNIQUE(file_path, symbol) constraint compares raw bytes, so on a case-folding volume the update has to match the way getNote does or `Src/A.ts` and `src/a.ts` become two rows and the older one wins the read
  db.transaction(() => {
    const updated = db
      .prepare(`UPDATE notes SET content = ?, fingerprint = ?, updated_at = ? WHERE ${pathEq('file_path')} AND symbol = ?`)
      .run(content, fingerprint, now, foldPath(filePath), symbol)
    if (updated.changes > 0) return
    db.prepare('INSERT INTO notes (file_path, symbol, content, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      filePath,
      symbol,
      content,
      fingerprint,
      now,
      now,
    )
  }).immediate()
}

/** Look up the note attached to `(filePath, symbol)`, or `null` if none exists. */
export function getNote(filePath: string, symbol: string, dbPath: string = globalDbPath()): NoteRow | null {
  const db = getDb(dbPath)
  const row = db
    .prepare(
      `SELECT id, file_path, symbol, content, fingerprint, created_at, updated_at FROM notes WHERE ${pathEq('file_path')} AND symbol = ?`,
    )
    .get(foldPath(filePath), symbol) as NoteDbRow | undefined
  return row === undefined ? null : toNoteRow(row)
}

/** Every note across every indexed file, ordered by file then symbol for stable listing output. */
export function listNotes(dbPath: string = globalDbPath()): NoteRow[] {
  const db = getDb(dbPath)
  const rows = db
    .prepare(
      'SELECT id, file_path, symbol, content, fingerprint, created_at, updated_at FROM notes ORDER BY file_path, symbol',
    )
    .all() as NoteDbRow[]
  return rows.map(toNoteRow)
}

/** True when `note`'s stored fingerprint no longer matches the current indexed state of what it's attached to -- i.e. the underlying code changed (or, for a symbol note, the symbol itself vanished or was renamed) since the note was written. Purely a read: never mutates or deletes the note. */
export function isNoteStale(note: NoteRow, dbPath: string = globalDbPath()): boolean {
  if (note.symbol !== WHOLE_FILE_NOTE_SYMBOL) return !computeSymbolFingerprints(note.filePath, note.symbol, dbPath).includes(note.fingerprint)
  return computeFileFingerprint(note.filePath, dbPath) !== note.fingerprint
}
