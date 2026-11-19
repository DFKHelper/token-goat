// Counts raw file-text read sites and stored-text accessor uses in a TS source, for the read-deny guard.
import { transformSync } from 'esbuild'

/** The spellings that read file text or bytes with no Read-deny check of their own. */
export const READ_NAMES = [
  'readFileSync',
  'readFile',
  'createReadStream',
  'readSync',
  'openSync',
  'readv',
  'readvSync',
  // The repo's own unchecked helpers: each takes a path and returns its text or bytes.
  'readPdfFileWithinBounds',
  'readAllWithinReportedSize',
  'readFilePrefix',
  'readKnownText',
  'readEvidenceFileText',
  'readScopeSingleFile',
  'readConfinedSpoolFile',
  // A database opened from a caller-supplied path returns stored text through its own SQL.
  'openReadonlySqlite',
  // Parses a file and stores its body, docstring and chunk text, so its callers must have asked the deny check.
  'indexFileSync',
]

/** The index accessors that return rows carrying stored text (body, docstring, signature, snippet). */
export const ACCESSORS = [
  'querySymbols',
  'queryFileSymbolsWithIds',
  'queryRefs',
  'queryRefsByContext',
  'searchSymbolsFts',
  'searchSymbolsFtsByKind',
  'searchSemantic',
]

/** A file handle opened through `fs.promises` (or an alias of it), which reads through the handle. */
const PROMISES_OPEN = /\b(?:promises|fsp|fsPromises)\.open\b/g
/** A direct driver open (`new Database(path)`), whatever the path it is given. */
const DRIVER_OPEN = /(?<![\w$])new Database\(/g
const IMPORT_BRACES = /\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(["'`])[^"'`]*\2;?/g
const DESTRUCTURE_ALIAS = new RegExp(`\\b(?:${READ_NAMES.join('|')})\\s*:\\s*([\\w$]+)`, 'g')

/** The code of a source with every comment gone; esbuild's parser knows a glob string from a comment opener. */
export function withoutComments(source: string): string {
  return transformSync(source, { loader: 'ts', minifyWhitespace: true, legalComments: 'none' }).code
}

function countOf(code: string, names: readonly string[]): number {
  if (names.length === 0) return 0
  const re = new RegExp(`(?<![\\w$])(?:${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`, 'g')
  return (code.match(re) ?? []).length
}

export interface SiteCounts {
  /** Raw read spellings, aliases of them and destructured aliases, outside import lists. */
  reads: number
  /** Uses of an index accessor that returns stored text. */
  accessors: number
}

/** The read-site counts of one source file. An aliased import counts once and every use of the alias counts. */
export function countSites(source: string): SiteCounts {
  let code = withoutComments(source)
  const aliases: string[] = []
  let aliasImports = 0
  code = code.replace(IMPORT_BRACES, (_all, specs: string) => {
    for (const spec of specs.split(',')) {
      const m = /^\s*(?:type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(spec)
      if (m !== null && READ_NAMES.includes(m[1]!)) {
        aliases.push(m[2]!)
        aliasImports++
      }
    }
    return ''
  })
  for (const m of code.matchAll(DESTRUCTURE_ALIAS)) aliases.push(m[1]!)
  const handles = (code.match(PROMISES_OPEN) ?? []).length
  const opens = (code.match(DRIVER_OPEN) ?? []).length
  const named = countOf(code, READ_NAMES) + countOf(code, [...new Set(aliases)])
  const reads = named + aliasImports + handles + opens
  return { reads, accessors: countOf(code, ACCESSORS) }
}
