/**
 * SQL DDL extractor — CREATE TABLE/VIEW/FUNCTION/PROCEDURE/INDEX/TRIGGER names.
 *
 * Pure-regex, case-insensitive. Handles multiple SQL dialects (PostgreSQL,
 * MySQL, SQLite, SQL Server, Oracle) via permissive CREATE DDL patterns.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import {
  assignFlatEndLines,
  buildLineIndex,
  makeSymbolEmitter,
  offsetToLine,
  propagateEndLinesToSymbols,
  stripCstyleComments,
} from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 128

// SQL identifier: bare, double-quoted, backtick-quoted, or bracket-quoted. Schema-qualified names (schema.name) captured as a single token.
const BARE = '[A-Za-z_][A-Za-z0-9_$]*'
const QUOTED = '"[^"]{1,128}"|`[^`]{1,128}`|\\[[^\\]]{1,128}\\]'
const NAME_PAT = `(?:${QUOTED}|${BARE})(?:\\.(?:${QUOTED}|${BARE}))?`

function makeCreateRe(objectKw: string, optPrefix = ''): RegExp {
  return new RegExp(
    `(?<!\\w)CREATE\\s+${optPrefix}${objectKw}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME_PAT})`,
    'gi',
  )
}

const TABLE_RE = makeCreateRe('TABLE', '(?:TEMP(?:ORARY)?\\s+)?')
const VIEW_RE = makeCreateRe('VIEW', '(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?')
const MATERIALIZED_VIEW_RE = makeCreateRe('MATERIALIZED\\s+VIEW', '(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?')
const FUNCTION_RE = makeCreateRe('FUNCTION', '(?:OR\\s+REPLACE\\s+)?')
const PROCEDURE_RE = makeCreateRe('PROCEDURE', '(?:OR\\s+REPLACE\\s+)?')
const INDEX_RE = new RegExp(
  `(?<!\\w)CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+CONCURRENTLY)?\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME_PAT})`,
  'gi',
)
const TRIGGER_RE = makeCreateRe('TRIGGER', '(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?')
const TYPE_RE = makeCreateRe('TYPE', '(?:OR\\s+REPLACE\\s+)?')
const SCHEMA_RE = makeCreateRe('SCHEMA')

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [TABLE_RE, 'sql_table'],
  [VIEW_RE, 'sql_view'],
  [MATERIALIZED_VIEW_RE, 'sql_view'],
  [FUNCTION_RE, 'sql_function'],
  [PROCEDURE_RE, 'sql_procedure'],
  [INDEX_RE, 'sql_index'],
  [TRIGGER_RE, 'sql_trigger'],
  [TYPE_RE, 'sql_type'],
  [SCHEMA_RE, 'sql_schema'],
]

/**
 * Blank the contents of SQL single-quoted string literals and `--` line comments in a single
 * linear scan, replacing interior characters with spaces (keeping the quote delimiters and any
 * newlines) so DDL keywords that merely appear inside a string value (e.g. dynamic SQL passed to
 * `EXECUTE '...'`) are never matched by the `CREATE ...` patterns below, and `--` never gets
 * treated as a comment marker while inside an open string literal. Double-quoted spans are left
 * untouched since double quotes delimit SQL identifiers (e.g. `CREATE TABLE "user"`), not string
 * literals - blanking them would destroy legitimate delimited names. Length- and
 * offset-preserving, like the other `strip*` helpers in `common.ts`, so `match.index` positions
 * stay valid for line lookup.
 *
 * SQL's standard escape for a literal quote inside a string is a doubled quote (`''` inside a
 * `'...'` string, `""` inside a `"..."` string) rather than a backslash - `common.ts`'s
 * `isInsideStringLiteral`/`stripStringLiterals` assume backslash escaping, so they don't fit SQL's
 * rule and this file needs its own quote-aware scanner.
 *
 * `--` comment handling used to live in a separate line-scoped pre-pass (`stripSqlLineComments`,
 * run before this function) whose quote-tracking reset at every newline, with no awareness that
 * the current line started mid-way through an already-open multi-line string literal from a
 * prior line - so a `--` inside a multi-line string got treated as a comment marker, blanking
 * out whatever closing quote followed it on that line and flipping string-parity tracking for
 * the rest of the file. Folding `--` handling into this single stateful scan (which already
 * tracks whether a string is open across line boundaries) fixes that: `--` is only treated as a
 * comment start when the scanner is not currently inside an open string.
 */
function stripSqlStringLiterals(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      // Double quotes delimit SQL identifiers (e.g. `CREATE TABLE "user"`), not string
      // literals - blanking them would destroy legitimate delimited names. Dynamic-SQL DDL
      // keywords that need masking (e.g. `EXECUTE 'CREATE TABLE ...'`) are always inside a
      // single-quoted string literal, never a double-quoted identifier.
      const quote = ch
      out += quote
      i++
      while (i < text.length) {
        const c = text[i]
        if (c === quote) {
          if (text[i + 1] === quote) {
            // Doubled quote: an escaped literal quote inside the string, not the terminator.
            out += '  '
            i += 2
            continue
          }
          out += quote
          i++
          break
        }
        out += c === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    if (ch === '-' && text[i + 1] === '-') {
      // `--` line comment: only recognized outside a string literal (guaranteed here, since the
      // branch above consumes any open `'...'` span in full before returning to this point).
      // Blank to end of line, preserving the newline itself.
      while (i < text.length && text[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

function unquote(name: string): string {
  if (
    name.length >= 2 &&
    ((name[0] === '"' && name[name.length - 1] === '"') ||
      (name[0] === '`' && name[name.length - 1] === '`') ||
      (name[0] === '[' && name[name.length - 1] === ']'))
  ) {
    return name.slice(1, -1)
  }
  return name
}

export function extractSql(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const stripped = stripCstyleComments(content)
  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(stripped)
  // Blanks string literals AND `--` line comments in one linear scan, so `--` inside a
  // multi-line string literal is never mistaken for a comment marker (see docstring below).
  const noStrings = stripSqlStringLiterals(stripped)

  for (const [pattern, kind] of PATTERNS) {
    // Reset lastIndex since these are global regexes
    pattern.lastIndex = 0
    for (const m of noStrings.matchAll(pattern)) {
      const rawName = m[1]
      if (rawName) {
        const name = unquote(rawName).trim()
        if (name) {
          const line = offsetToLine(lineIndex, m.index ?? 0)
          emit(name, kind, line)
        }
      }
    }
  }

  sections.sort((a, b) => a.line - b.line)
  symbols.sort((a, b) => a.lineStart - b.lineStart)
  assignFlatEndLines(sections, totalLines)
  return propagateEndLinesToSymbols(symbols, sections)
}
