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
 * Blank the contents of SQL single-quoted string literals, `--` line comments, and `/* *\/` block
 * comments in a single linear scan, replacing interior characters with spaces (keeping the quote
 * delimiters and any newlines) so DDL keywords that merely appear inside a string value (e.g.
 * dynamic SQL passed to `EXECUTE '...'`) are never matched by the `CREATE ...` patterns below, and
 * neither comment marker ever gets treated as real syntax while inside an open string literal.
 * Double-quoted spans are left untouched since double quotes delimit SQL identifiers (e.g.
 * `CREATE TABLE "user"`), not string literals - blanking them would destroy legitimate delimited
 * names. Length- and offset-preserving, like the other `strip*` helpers in `common.ts`, so
 * `match.index` positions stay valid for line lookup.
 *
 * SQL's standard escape for a literal quote inside a string is a doubled quote (`''` inside a
 * `'...'` string, `""` inside a `"..."` string) rather than a backslash - `common.ts`'s
 * `isInsideStringLiteral`/`stripStringLiterals` assume backslash escaping, so they don't fit SQL's
 * rule and this file needs its own quote-aware scanner.
 *
 * `--` and `/* *\/` comment handling used to live in separate pre-passes
 * (`stripSqlLineComments`/`common.ts`'s `stripCstyleComments`) that ran before string-literal
 * stripping. Both reset their quote-tracking at every newline, with no awareness that the current
 * line started mid-way through an already-open multi-line string literal from a prior line - so a
 * `--` or a `/*`-looking sequence inside a multi-line string got treated as real comment syntax,
 * corrupting the rest of the file two ways: blanking a closing quote and flipping string-parity
 * tracking for everything after (under-stripping: real string content eaten), or - worse - opening
 * a phantom block comment that never finds a real `*\/` closer anywhere later in the file (since
 * the file's actual `*\/`-shaped text, if any, is itself inside the same open string), silently
 * dropping every real DDL statement after it to EOF (over-stripping: real code swallowed as
 * comment). Folding both comment forms into this single stateful scan - which already tracks
 * whether a string is open across line boundaries - fixes both directions: `--` and `/*` are only
 * ever treated as comment starts when the scanner is not currently inside an open string.
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
    if (ch === '"') {
      // A `"..."` delimited identifier's *contents* must pass through unblanked (unlike a
      // single-quoted literal's contents, which are masked) - the whole point of this branch is
      // preserving legitimate delimited names for downstream regex matching. But the span still
      // needs to be consumed as one opaque unit here: standard SQL permits ANY character inside a
      // delimited identifier, including `'`, `--`, and `/*`. Without this branch those characters
      // fell through to the generic `out += ch` path below one at a time, so a `'` inside a
      // quoted identifier (e.g. `"user's_data"`, a common possessive/label-style column or table
      // name) opened a phantom single-quoted string on the *next* scan iteration that never found
      // a real closing `'`, blanking every DDL statement after it through EOF. `""` is honored as
      // the doubled-quote escape for a literal `"` inside the identifier, symmetric to `''` above.
      out += ch
      i++
      while (i < text.length) {
        const c = text[i]
        if (c === '"') {
          if (text[i + 1] === '"') {
            out += '""'
            i += 2
            continue
          }
          out += c
          i++
          break
        }
        out += c
        i++
      }
      continue
    }
    if (ch === '`') {
      // MySQL backtick-delimited identifier - same opaque-span rationale and phantom-string risk
      // as the `"..."` branch above (an apostrophe inside `` `user's_data` `` would otherwise open
      // an unterminated single-quoted string and blank the rest of the file). `` `` `` is the
      // doubled-backtick escape for a literal backtick inside the identifier.
      out += ch
      i++
      while (i < text.length) {
        const c = text[i]
        if (c === '`') {
          if (text[i + 1] === '`') {
            out += '``'
            i += 2
            continue
          }
          out += c
          i++
          break
        }
        out += c
        i++
      }
      continue
    }
    if (ch === '[') {
      // SQL Server bracket-delimited identifier - same rationale as the `"..."` and `` `...` ``
      // branches above (an apostrophe inside `[user's_data]` would otherwise open an unterminated
      // single-quoted string). `]]` is the doubled-bracket escape for a literal `]` inside the
      // identifier. Unlike the other two forms the open/close delimiters differ, so there is no
      // risk of misreading a bare `[` elsewhere in the file as a closer.
      out += ch
      i++
      while (i < text.length) {
        const c = text[i]
        if (c === ']') {
          if (text[i + 1] === ']') {
            out += ']]'
            i += 2
            continue
          }
          out += c
          i++
          break
        }
        out += c
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
    if (ch === '#') {
      // `#` line comment: MySQL/MariaDB's third comment form, alongside `--` and `/* */`. Same
      // string-literal guarantee as `--` above. Without this branch, a `CREATE TABLE ...`
      // sitting inside a `#` comment (leading or trailing) survives masking and gets matched by
      // the DDL patterns below as a live symbol.
      while (i < text.length && text[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      // `/* ... */` block comment: only recognized outside a string literal, same guarantee as
      // `--` above. Blanks through to the closing `*/` (preserving newlines so line/offset
      // positions downstream stay valid), or to EOF if unterminated.
      out += '  '
      i += 2
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out += '  '
          i += 2
          break
        }
        out += text[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

function unquoteSegment(segment: string): string {
  if (
    segment.length >= 2 &&
    ((segment[0] === '"' && segment[segment.length - 1] === '"') ||
      (segment[0] === '`' && segment[segment.length - 1] === '`') ||
      (segment[0] === '[' && segment[segment.length - 1] === ']'))
  ) {
    return segment.slice(1, -1)
  }
  return segment
}

// NAME_PAT captures a schema-qualified name (e.g. "public"."users") as a single token, so a
// naive unquote() that only strips one outer quote pair off the whole string leaves a
// schema-qualified quoted name corrupted: "public"."users" only has its outermost quotes
// stripped, yielding the garbage literal public"."users. Splitting on the dot that separates the
// two independently-quoted segments (while staying inside quote/bracket delimiters, since a
// quoted segment could itself legally contain a literal dot) and unquoting each segment
// separately avoids that.
function splitQualifiedSegments(name: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]
    if (quote) {
      if (
        (quote === '"' && ch === '"') ||
        (quote === '`' && ch === '`') ||
        (quote === '[' && ch === ']')
      ) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      quote = ch
      continue
    }
    if (ch === '.') {
      segments.push(name.slice(start, i))
      start = i + 1
    }
  }
  segments.push(name.slice(start))
  return segments
}

function unquote(name: string): string {
  return splitQualifiedSegments(name).map(unquoteSegment).join('.')
}

/**
 * Find the next top-level `;` in `noStrings` starting at `fromIndex`, skipping over any
 * "..."/`...`/[...] delimited-identifier span so a `;` embedded in a quoted identifier's name
 * (e.g. `CREATE TABLE "a;b" (...)`) is never mistaken for the statement's real terminator.
 * stripSqlStringLiterals preserves those spans verbatim (needed so NAME_PAT can still extract
 * the identifier text) while single-quoted string literals are already blanked to spaces, so
 * only these three delimiter forms need to be skipped here.
 */
function findStatementTerminator(noStrings: string, fromIndex: number): number {
  let i = fromIndex
  while (i < noStrings.length) {
    const c = noStrings[i]
    if (c === ';') return i
    if (c === '"' || c === '`') {
      const close = c
      i++
      while (i < noStrings.length) {
        if (noStrings[i] === close) {
          if (noStrings[i + 1] === close) {
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
      i++
      while (i < noStrings.length) {
        if (noStrings[i] === ']') {
          if (noStrings[i + 1] === ']') {
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
    i++
  }
  return -1
}

export function extractSql(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(content)
  // Blanks string literals, `--` line comments, AND `/* */` block comments in one linear scan
  // over the raw content, so neither comment marker is ever mistaken for real syntax while
  // inside an open (possibly multi-line) string literal - see docstring below. Running this
  // directly on `content` instead of a separate `stripCstyleComments` pre-pass is required for
  // that: a `/* */` pre-pass with no string-literal awareness would itself misparse a `/*`- or
  // `*/`-shaped sequence sitting inside a multi-line string.
  const noStrings = stripSqlStringLiterals(content)

  // name+line -> true lineEnd for a statement confirmed to terminate with `;` on its own start
  // line. assignFlatEndLines/propagateEndLinesToSymbols only do flat "ends where the next
  // section starts" propagation: when several complete statements share one physical line (e.g.
  // `CREATE TABLE a (id INT); CREATE FUNCTION b() ...;`), the shared model has no way to tell
  // which of them is genuinely the "last" one on that line, and its next-section-start heuristic
  // extends whichever statement happens to sort last into that position all the way to the next
  // *distinct* line (or EOF) -- silently absorbing unrelated statements that merely follow on
  // later lines. A statement whose own terminating `;` is found on the same line as its `CREATE`
  // keyword is unambiguous regardless of sort order, so it can be pinned to a single-line span
  // directly instead of trusting the flat model's guess. Left untouched (flat-model behavior
  // unchanged) whenever the terminator isn't on the start line -- e.g. a real multi-line
  // function/procedure body -- since this file has no brace/END-matching scan to compute those
  // real end lines precisely.
  const singleLineEndLines = new Map<string, number>()

  for (const [pattern, kind] of PATTERNS) {
    // Reset lastIndex since these are global regexes
    pattern.lastIndex = 0
    for (const m of noStrings.matchAll(pattern)) {
      const rawName = m[1]
      if (rawName) {
        const name = unquote(rawName).trim()
        if (name) {
          const line = offsetToLine(lineIndex, m.index ?? 0)
          const semiIdx = findStatementTerminator(noStrings, m.index ?? 0)
          if (semiIdx !== -1 && offsetToLine(lineIndex, semiIdx) === line) {
            // kind must be part of the key, same reasoning as makeSymbolEmitter's own `seen`
            // key: a name can legitimately repeat across kinds on the same line (e.g. a
            // same-line `CREATE TABLE foo (...); CREATE FUNCTION foo() ...`), and a name+line-
            // only key would let one kind's single-line pin leak onto a different kind sharing
            // that same name and line.
            singleLineEndLines.set(`${name}\0${kind}\0${line}`, line)
          }
          emit(name, kind, line)
        }
      }
    }
  }

  sections.sort((a, b) => a.line - b.line)
  symbols.sort((a, b) => a.lineStart - b.lineStart)
  assignFlatEndLines(sections, totalLines)
  return propagateEndLinesToSymbols(symbols, sections).map((sym) => {
    const pinnedEndLine = singleLineEndLines.get(`${sym.name}\0${sym.kind}\0${sym.lineStart}`)
    return pinnedEndLine !== undefined && pinnedEndLine !== sym.lineEnd
      ? { ...sym, lineEnd: pinnedEndLine }
      : sym
  })
}
