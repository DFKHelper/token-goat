/**
 * Architecture-notes storage layer.
 *
 * The `notes` table (schema in db.ts) holds free-text Markdown notes attached
 * either to a whole file or to one specific indexed symbol within it, plus a
 * fingerprint captured at write time of exactly what the note describes. This
 * module owns the raw SQL and row-shape translation for that table -- the
 * same role index_reader.ts plays for symbols/refs -- so CLI-facing command
 * handlers (note-add in cli.ts, note-get/note-list in read_commands.ts) never
 * touch raw rows or SQL directly.
 *
 * Staleness detection (isNoteStale) is the mechanical half of the feature: it
 * recomputes the same fingerprint against the CURRENT index and compares. It
 * never mutates or deletes a note -- a note whose fingerprint no longer
 * matches is only flagged (via `note-list --stale-only`), never silently
 * rewritten or discarded, so a human/agent decides whether the stale prose is
 * still worth keeping.
 */

import * as fs from 'node:fs'
import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { fingerprintContent } from './fingerprint.js'
import { querySymbols } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { pathEqClause as pathEq } from './sql_path.js'
import { foldPath } from './util.js'

/**
 * Sentinel `symbol` value for a note attached to a whole file rather than one
 * indexed symbol. `''` rather than `NULL`: SQLite's `UNIQUE(file_path,
 * symbol)` treats `NULL`s as pairwise-distinct (never conflicting with each
 * other), which would let note-add accumulate unlimited duplicate whole-file
 * notes for the same file instead of upserting one -- `''` is a real,
 * comparable value, so the constraint (and every `WHERE symbol = ?` lookup
 * here) treats "no symbol" the same way for both reads and writes.
 */
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

/** Raw `notes` row as returned by better-sqlite3 (snake_case columns). */
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

/**
 * Deterministic tie-break when more than one indexed symbol in a file shares
 * a name (e.g. overloads, or two same-named methods on different classes):
 * the earliest starting line wins. Used consistently both when a note is
 * written and whenever its fingerprint is later recomputed, so a note always
 * tracks the same symbol occurrence across calls.
 */
function pickEarliest(matches: readonly SymbolEntry[]): SymbolEntry {
  return matches.reduce((best, s) => (s.lineStart < best.lineStart ? s : best))
}

/**
 * Resolve `symbolName` against the symbols currently indexed for `filePath`.
 * Returns `null` when no match exists -- the caller decides what that means
 * (a hard error at note-add time; unconditional staleness at note-list time).
 *
 * A match whose stored `body` is empty gets it filled in from the source file
 * over the symbol's line range, mirroring read_commands.ts's `resolveBody`.
 * Both consumers of this function fingerprint `match.body` to detect that the
 * code under a note has changed, and an empty body fingerprints to the same
 * constant for every such symbol -- so without this fallback a note attached to
 * one would never go stale. Bodies are legitimately empty for symbols an
 * extractor emits without text, and for any symbol over parser.ts's
 * MAX_SYMBOL_BODY_CHARS, which is stored elided precisely so readers re-derive
 * it from source.
 */
export function resolveSymbolMatch(
  filePath: string,
  symbolName: string,
  dbPath: string = globalDbPath(),
): SymbolEntry | null {
  const matches = querySymbols({ filePath, name: symbolName }, dbPath)
  if (matches.length === 0) return null
  const match = pickEarliest(matches)
  if (match.body !== '') return match
  return { ...match, body: bodyFromSource(match) }
}

/** Source text over `entry`'s line range, or '' when the file is unreadable (deleted, permissions). */
function bodyFromSource(entry: SymbolEntry): string {
  try {
    return fs
      .readFileSync(entry.filePath, 'utf8')
      .split(/\r?\n/)
      .slice(Math.max(0, entry.lineStart - 1), entry.lineEnd)
      .join('\n')
  } catch {
    return ''
  }
}

/** Every distinct symbol name currently indexed for `filePath`, sorted -- used to build a "did you mean" list when `--symbol` doesn't resolve to anything. */
export function symbolNamesInFile(filePath: string, dbPath: string = globalDbPath()): string[] {
  const symbols = querySymbols({ filePath, limit: 100_000 }, dbPath)
  return [...new Set(symbols.map((s) => s.name))].sort()
}

/**
 * Fingerprint anchor for a whole-file note: a digest of every currently
 * indexed symbol's name/kind/line-range for `filePath`, sorted for
 * determinism. Adding, removing, or moving any symbol in the file changes
 * this digest even when no single symbol's own body changed -- that is the
 * "did the code shift under this note" signal a file-scoped note is checked
 * against.
 */
export function computeFileFingerprint(filePath: string, dbPath: string = globalDbPath()): string {
  const symbols = querySymbols({ filePath, limit: 1_000_000 }, dbPath)
  const manifest = symbols
    .map((s) => `${s.name}:${s.kind}:${s.lineStart}-${s.lineEnd}`)
    .sort()
    .join('\n')
  return fingerprintContent(manifest)
}

/**
 * Fingerprint anchor for a symbol-attached note: the resolved symbol's
 * current body text. `null` when the symbol name no longer resolves in that
 * file (renamed or removed) -- there is nothing left to fingerprint, so the
 * caller ({@link isNoteStale}) treats `null` as unconditionally stale.
 */
export function computeSymbolFingerprint(
  filePath: string,
  symbolName: string,
  dbPath: string = globalDbPath(),
): string | null {
  const match = resolveSymbolMatch(filePath, symbolName, dbPath)
  return match === null ? null : fingerprintContent(match.body)
}

/**
 * Insert-or-update the note for `(filePath, symbol)` -- re-running note-add
 * for the same attachment point overwrites content/fingerprint/updated_at
 * rather than accumulating duplicate rows, mirroring cache_recall's `ON
 * CONFLICT DO UPDATE` upsert pattern in db.ts.
 */
export function upsertNote(
  filePath: string,
  symbol: string,
  content: string,
  fingerprint: string,
  dbPath: string = globalDbPath(),
): void {
  const db = getDb(dbPath)
  const now = Date.now() / 1000
  db.prepare(
    `INSERT INTO notes (file_path, symbol, content, fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path, symbol) DO UPDATE SET
       content = excluded.content,
       fingerprint = excluded.fingerprint,
       updated_at = excluded.updated_at`,
  ).run(filePath, symbol, content, fingerprint, now, now)
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

/**
 * True when `note`'s stored fingerprint no longer matches the current
 * indexed state of what it's attached to -- i.e. the underlying code changed
 * (or, for a symbol note, the symbol itself vanished or was renamed) since
 * the note was written. Purely a read: never mutates or deletes the note.
 */
export function isNoteStale(note: NoteRow, dbPath: string = globalDbPath()): boolean {
  const current =
    note.symbol === WHOLE_FILE_NOTE_SYMBOL
      ? computeFileFingerprint(note.filePath, dbPath)
      : computeSymbolFingerprint(note.filePath, note.symbol, dbPath)
  return current === null || current !== note.fingerprint
}
