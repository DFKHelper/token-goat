/**
 * Type definitions shared between the tree-sitter parser (Layer 7) and the
 * layers that query the index (index_reader, read commands).
 *
 * These mirror the row shapes of the `symbols`, `refs`, and `files` tables
 * defined in `db.ts`, plus the language-detection table used to decide which
 * tree-sitter grammar (later) or section parser (now) applies to a file.
 *
 * Pure types + one pure function: no I/O, no DB, no Node built-ins beyond the
 * path-extension lookup. Importable from any layer without side effects.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { isAblSource } from './languages/abl.js'
import { EXACT_FILENAME_LANGUAGE, EXTENSION_LANGUAGE, FILENAME_LANGUAGE, LANGUAGE_SPECS, type Language } from './language_specs.js'

/** One extracted definition: function, class, method, type, variable, etc. */
export interface SymbolEntry {
  readonly filePath: string
  readonly name: string
  readonly kind: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly body: string
  readonly docstring: string
  /**
   * The symbol's containing type/class name, as recovered by the regex adapters
   * (`makeLineSymbol`/`makeSpanSymbol`/`makeSymbolEmitter` in languages/common.ts) that emit a
   * single-line class-header span too short to contain a method body for line-containment to work.
   * Separate from `docstring`, which those same adapters used to overload with this value before
   * this field existed -- see the `parent` column comment in db.ts's SCHEMA_SQL for the full
   * history. `''` for symbols that don't need a recovered parent (tree-sitter extractors, or any
   * top-level symbol).
   */
  readonly parent: string
}

/** One reference/usage of a name, with the surrounding line for context. */
export interface RefEntry {
  readonly filePath: string
  readonly name: string
  readonly line: number
  readonly col: number
  readonly context: string
}

/** One indexed source file: its SHA, mtime, language, index timestamp, and embedding freshness. */
export interface FileIndexEntry {
  readonly filePath: string
  readonly sha: string
  readonly mtime: number
  readonly language: string
  readonly indexedAt: number
  // The sha of the content that was last SUCCESSFULLY embedded, tracked separately from `sha`
  // (the last successfully PARSED content) so a worker crash or a thrown error mid-embedding
  // never gets masked by the parse-sha gate -- see makeIndexer in worker.ts. Empty string when
  // the file has never been embedded (or its last embedding attempt never completed).
  readonly embedSha: string
  // The fingerprint of the extraction logic that produced this file's symbol and ref rows, tracked separately from `sha` for the same reason `embedSha` is: content freshness and parse freshness are different questions. Empty string for a row written before the column existed, which the freshness gates read as stale and reparse once.
  readonly parserSha: string
}

export type { Language } from './language_specs.js'
export { TREE_SITTER_LANGUAGES } from './language_specs.js'

// Matches ".env" itself and any ".env.<suffix>" variant (.local, .example, .sample, .test,
// .production, plus anything a project invents -- .development, .staging, .ci, .docker, ...).
// A fixed enumeration in FILENAME_LANGUAGE (src/language_specs.ts) could only ever cover the variants someone
// remembered to list, silently falling through to 'unknown' for every other suffix. Does not
// match ".envrc" (no dot after "env"), which FILENAME_LANGUAGE already handles separately.
const DOTENV_VARIANT_RE = /^\.env(\..+)?$/

// How far into a `.cls` the VB6 class-module header is looked for: the `VERSION 1.0 CLASS` / `BEGIN ... END` block plus its `Attribute VB_*` lines is under a dozen lines in every VB6 class module, so this bound is generous without scanning an Apex class body.
const VB6_HEADER_SCAN_LINES = 40

/**
 * True when `content` is a VB6 class module: after an optional BOM and blank lines it opens with `VERSION 1.0 CLASS`, or its header carries an `Attribute VB_Name = "..."` line. Neither form is valid Apex, so an Apex class never matches.
 */
export function isVb6ClassModule(content: string): boolean {
  if (content.includes('\0')) return false
  const lines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/, VB6_HEADER_SCAN_LINES)
  const first = lines.find((l) => l.trim() !== '')
  if (first !== undefined && /^VERSION\s+1\.0\s+CLASS\b/i.test(first.trim())) return true
  return lines.some((l) => /^Attribute\s+VB_Name\s*=\s*"/i.test(l.trim()))
}

/**
 * The language of a file once its content is known. {@link detectLanguage} is path-only, and `.cls` is an Apex class, a VB6 class module or an OpenEdge ABL class, while `.p` and `.w` are ABL only on an ABL marker (Pascal and CWEB use them too), so the indexer's two entry points (indexFileSync, parseFile) call this after reading the file and store the refined language. Every other language passes through unchanged. A consumer that prints the language or picks a reader by it (section_reader, the ref-blindness notices, the `map` language tally) refines too, through this or {@link detectLanguageOfFile}; the path-only ones left (the read/grep/bash hooks, the fold gates) treat `apex` and `vb` identically, since neither has a tree-sitter grammar or a reference index.
 */
export function refineLanguageByContent(filePath: string, language: Language, content: string): Language {
  const ext = path.extname(filePath).toLowerCase()
  if (language === 'apex' && ext === '.cls') {
    if (isVb6ClassModule(content)) return 'vb'
    if (isAblSource(content)) return 'abl'
    return language
  }
  // A `.p` or `.w` is ABL only on an ABL marker; a Pascal program or a CWEB file stays unknown, as it was before ABL was indexed.
  if (language === 'unknown' && ABL_SNIFFED_EXTENSIONS.has(ext) && isAblSource(content)) return 'abl'
  return language
}

/** Extensions {@link detectLanguage} leaves unknown that are OpenEdge ABL when {@link isAblSource} says so. */
const ABL_SNIFFED_EXTENSIONS: ReadonlySet<string> = new Set(['.p', '.w'])

/** True when {@link refineLanguageByContent} could change the path language of `filePath`, so its head is worth reading. */
function needsContentSniff(filePath: string, language: Language): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return (language === 'apex' && ext === '.cls') || (language === 'unknown' && ABL_SNIFFED_EXTENSIONS.has(ext))
}

/** How many leading bytes {@link detectLanguageOfFile} reads from a `.cls`: comfortably more than the {@link VB6_HEADER_SCAN_LINES} lines the sniff looks at. */
const LANGUAGE_SNIFF_BYTES = 8192

/** {@link detectLanguage} for a file that exists on disk, for a consumer that has no content in hand but reports or branches on the language: a `.cls` has its first few KB read so a VB6 or ABL class is not reported as Apex, and a `.p` or `.w` so an ABL source is not reported as unknown; every other path reads nothing. */
export function detectLanguageOfFile(filePath: string): Language {
  const language = detectLanguage(filePath)
  if (!needsContentSniff(filePath, language)) return language
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(LANGUAGE_SNIFF_BYTES)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      return refineLanguageByContent(filePath, language, buf.subarray(0, n).toString('utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return language
  }
}

/**
 * Detect the {@link Language} of a file from its path.
 *
 * Checks the exact-case basename against {@link EXACT_FILENAME_LANGUAGE} and the lowercased one against {@link FILENAME_LANGUAGE} first (so `Dockerfile`
 * and named config files win), then falls back to the lowercased extension via
 * {@link EXTENSION_LANGUAGE}. Returns `'unknown'` when neither matches.
 */
export function detectLanguage(filePath: string): Language {
  const exactBase = path.basename(filePath)
  const base = exactBase.toLowerCase()
  if (DOTENV_VARIANT_RE.test(base)) return 'env_file'

  const byName = EXACT_FILENAME_LANGUAGE.get(exactBase) ?? FILENAME_LANGUAGE.get(base)
  if (byName !== undefined) return byName

  if (base.endsWith('-meta.xml')) {
    return 'salesforce_metadata'
  }

  const ext = path.extname(base).toLowerCase()
  return EXTENSION_LANGUAGE.get(ext) ?? 'unknown'
}

/**
 * Extensions for languages token-goat recognizes by name but has neither a tree-sitter
 * grammar nor a regex-fallback extractor for (see {@link NO_TREE_SITTER_EXTRACTORS} in
 * parser.ts). These are not part of the {@link Language} union -- detectLanguage() maps them
 * to `'unknown'` -- so a file in one of these languages indexes to zero symbols exactly like
 * a genuinely empty or unrecognized file, with nothing to tell the two apart. This map exists
 * purely to make that distinction visible in diagnostics (index/outline/skeleton), not to
 * change indexing behavior.
 */
export const UNSUPPORTED_LANGUAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.f', 'Fortran'],
  ['.for', 'Fortran'],
  ['.f77', 'Fortran'],
  ['.f90', 'Fortran'],
  ['.f95', 'Fortran'],
  ['.f03', 'Fortran'],
  ['.f08', 'Fortran'],
  ['.rpg', 'RPG II or RPG III'],
  ['.nsm', 'Natural map'],
  ['.nsd', 'Natural DDM'],
])


/** How many languages index without tree-sitter: every mapped language except the grammar ones and notebooks, which parse as Python. */
export function nonTreeSitterLanguageCount(): number {
  return LANGUAGE_SPECS.filter((s) => s.extraction !== 'tree-sitter' && s.id !== 'ipynb').length
}

/**
 * Returns a human-readable language name (e.g. `'Swift'`) if `filePath` is a recognized but
 * unsupported language -- one token-goat has no symbol extractor for at all -- so callers can
 * surface a distinct diagnostic instead of silently reporting "no symbols" indistinguishably
 * from an empty file. Returns `undefined` for anything else, including genuinely unrecognized
 * extensions and languages that do have an extractor.
 */
export function unsupportedLanguageName(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return UNSUPPORTED_LANGUAGE_EXTENSIONS.get(ext)
}
