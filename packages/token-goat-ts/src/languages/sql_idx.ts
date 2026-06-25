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
  makeSymbolEmitter,
  propagateEndLinesToSymbols,
  stripCstyleComments,
  stripSqlLineComments,
} from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 128

// SQL identifier: bare, double-quoted, backtick-quoted, or bracket-quoted.
// Schema-qualified names (schema.name) captured as a single token.
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
const FUNCTION_RE = makeCreateRe('FUNCTION', '(?:OR\\s+REPLACE\\s+)?')
const PROCEDURE_RE = makeCreateRe('PROCEDURE', '(?:OR\\s+REPLACE\\s+)?')
const INDEX_RE = makeCreateRe('INDEX', '(?:UNIQUE\\s+)?')
const TRIGGER_RE = makeCreateRe('TRIGGER', '(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?')
const TYPE_RE = makeCreateRe('TYPE', '(?:OR\\s+REPLACE\\s+)?')
const SCHEMA_RE = makeCreateRe('SCHEMA')

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [TABLE_RE, 'sql_table'],
  [VIEW_RE, 'sql_view'],
  [FUNCTION_RE, 'sql_function'],
  [PROCEDURE_RE, 'sql_procedure'],
  [INDEX_RE, 'sql_index'],
  [TRIGGER_RE, 'sql_trigger'],
  [TYPE_RE, 'sql_type'],
  [SCHEMA_RE, 'sql_schema'],
]

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

  let stripped = stripSqlLineComments(content)
  stripped = stripCstyleComments(stripped)
  const totalLines = content.split('\n').length

  for (const [pattern, kind] of PATTERNS) {
    // Reset lastIndex since these are global regexes
    pattern.lastIndex = 0
    for (const m of stripped.matchAll(pattern)) {
      const rawName = m[1]
      if (rawName) {
        const name = unquote(rawName).trim()
        if (name) {
          const line = stripped.slice(0, m.index ?? 0).split('\n').length
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
