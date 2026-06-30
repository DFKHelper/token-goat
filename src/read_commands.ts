/**
 * CLI command handlers for surgical-read commands.
 *
 * Ports the public command functions from ``read_commands.py`` to TypeScript.
 * The DB-query layer lives in ``index_reader.ts``; section extraction lives in
 * ``section_reader.ts``.  This module owns argument parsing, output formatting,
 * and the "did you mean?" hint logic.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { querySymbols, queryRefs } from './index_reader.js'
import { resolveIndexPath } from './paths.js'
import { readSection, listSections, extractSection, listAllSections } from './section_reader.js'
import { runGit, ensureNewline } from './util.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'

// ---- constants --------------------------------------------------------------

const DIDYOUMEAN_LIMIT = 5
const GREP_MAX_LINES = 200

// ---- helpers ----------------------------------------------------------------

function fileExists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function readFileText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

function emit(text: string): void {
  process.stdout.write(ensureNewline(text))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

function didYouMean(candidates: string[]): string {
  if (candidates.length === 0) return ''
  const lines = ['Did you mean:']
  for (const c of candidates.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - ${c}`)
  }
  return lines.join('\n')
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start++
  while (end > start && lines[end - 1]?.trim() === '') end--
  return lines.slice(start, end)
}

function firstBodyLine(body: string): string {
  return body.split('\n').find((l) => l.trim() !== '') ?? ''
}

// ---- symbol lookup ----------------------------------------------------------

export interface SymbolOptions {
  name?: string
  file?: string
  kind?: string
  limit?: number
  json?: boolean
  context?: number
}

/** Handle ``token-goat symbol <name>``. */
export function runSymbol(opts: SymbolOptions): number {
  const queryOpts: Parameters<typeof querySymbols>[0] = {}
  if (opts.name !== undefined) queryOpts.name = opts.name
  if (opts.file !== undefined) queryOpts.filePath = resolveIndexPath(opts.file)
  if (opts.kind !== undefined) queryOpts.kind = opts.kind
  if (opts.limit !== undefined) queryOpts.limit = opts.limit

  const results = querySymbols(queryOpts)

  if (results.length === 0) {
    emitErr(`No matches for '${opts.name ?? '*'}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }

  // Header + short body preview per match (mirrors the richer surface that the native CLI handler used before the two read surfaces were consolidated).
  const blocks = results.map((sym) => {
    const header = `# ${sym.name} (${sym.kind}) — ${sym.filePath}:${sym.lineStart}-${sym.lineEnd}`
    const preview = sym.body.split(/\r?\n/).slice(0, 5).join('\n')
    return preview.trim() !== '' ? `${header}\n${preview}` : header
  })
  emit(blocks.join('\n\n'))
  return 0
}

// ---- read (symbol body) -----------------------------------------------------

export interface ReadOptions {
  spec: string
  json?: boolean
  contextLines?: number
}

function parseReadSpec(spec: string): { file: string; symbol?: string } {
  const colonIdx = spec.indexOf('::')
  if (colonIdx === -1) return { file: spec }
  return { file: spec.slice(0, colonIdx), symbol: spec.slice(colonIdx + 2) }
}

// A line-range read spec ends in `@N` (single line) or `@N-M` (inclusive range), e.g. `src/app.ts@10-20`. The `$`-anchored trailing digits mean a real path that ends in an extension (`report@2024.txt`) never matches; only a bare digit suffix triggers a range read.
function parseLineRange(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null) return null
  const start = parseInt(m[2]!, 10)
  const end = m[3] !== undefined ? parseInt(m[3], 10) : start
  return { file: m[1]!, start, end }
}

// Read an inclusive, 1-indexed line range straight from disk. Index-independent (raw fs read), so it works for files in any project and for paths outside every indexed project root.
function runLineRange(range: { file: string; start: number; end: number }, opts: ReadOptions): number {
  const { file, start, end } = range
  if (start < 1) {
    emitErr(`Invalid line range: start must be >= 1 (got ${start})`)
    return 1
  }
  if (end < start) {
    emitErr(`Invalid line range: end (${end}) is before start (${start})`)
    return 1
  }
  const text = readFileText(file)
  if (text === null) {
    emitErr(`Could not read: ${file}`)
    return 1
  }
  const allLines = text.split(/\r?\n/)
  // A trailing newline terminates the last line rather than starting a new empty one; drop the phantom empty element split() appends so the line count matches editor/symbol-read conventions.
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  if (start > allLines.length) {
    emitErr(`Line ${start} is past end of file (${allLines.length} lines): ${file}`)
    return 1
  }
  const clampedEnd = Math.min(end, allLines.length)
  const slice = allLines.slice(start - 1, clampedEnd)
  if (opts.json === true) {
    emit(JSON.stringify({ file, start, end: clampedEnd, lines: slice }, null, 2))
    return 0
  }
  const tok = Math.ceil(slice.join('\n').length / 4)
  emit([`# lines ${start}-${clampedEnd} of ${allLines.length} (~${tok} tok)`, slice.join('\n')].join('\n'))
  return 0
}

/** Handle ``token-goat read "file::symbol"`` and ``token-goat read "file@N-M"``. */
export function runRead(opts: ReadOptions): number {
  const range = parseLineRange(opts.spec)
  if (range !== null) return runLineRange(range, opts)

  const { file, symbol } = parseReadSpec(opts.spec)

  if (symbol === undefined || symbol === '') {
    const text = readFileText(file)
    if (text === null) {
      emitErr(`Could not read: ${file}`)
      return 1
    }
    emit(text)
    return 0
  }

  // For a dotted path (e.g. "Session.refresh" or "Outer.Inner.refresh"), the symbol we want is the leaf — the LAST segment — since methods are indexed by their bare name. Using split('.')[1] would pick the middle segment of a 3+ part path and resolve to the wrong symbol (e.g. the inner class instead of its method).
  const dotParts = symbol.split('.')
  const [symBase, methodName] =
    dotParts.length > 1
      ? [dotParts[0] ?? symbol, dotParts[dotParts.length - 1]]
      : [symbol, undefined]

  // When a method name is given (e.g. "Session.refresh"), query for the method name directly. Querying for symBase (the class name) and then searching for methodName among those results always fails because all returned symbols have name === symBase, never name === methodName.
  const lookupName = methodName ?? symBase
  const resolved = resolveIndexPath(file)
  let candidates = querySymbols({ name: lookupName, filePath: resolved, limit: 10 })
  if (candidates.length === 0) {
    // Partial-path fallback: resolve `worker.ts::foo` against an index keyed by `src/worker.ts` by matching on a path suffix when the exact key misses.
    candidates = querySymbols({ name: lookupName, limit: 50 }).filter(
      (s) => s.filePath === file || s.filePath.endsWith(file) || file.endsWith(s.filePath),
    )
  }

  const match = candidates[0]

  if (match === undefined) {
    emitErr(`Symbol '${symbol}' not found in '${file}'`)
    const closes = querySymbols({ filePath: resolved, limit: DIDYOUMEAN_LIMIT }).map((s) => s.name)
    if (closes.length > 0) emitErr(didYouMean(closes))
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(match, null, 2))
    return 0
  }

  const bodyLen = match.lineEnd - match.lineStart + 1
  const lines: string[] = [
    `# ${bodyLen} lines (~${Math.ceil(match.body.length / 4)} tok)`,
    match.body,
  ]
  emit(trimBlankLines(lines).join('\n'))
  return 0
}

// ---- section ----------------------------------------------------------------

export interface SectionOptions {
  spec: string
  json?: boolean
}

/** Handle ``token-goat section "file::Heading"``. */
export function runSection(opts: SectionOptions): number {
  const colonIdx = opts.spec.indexOf('::')
  if (colonIdx === -1) {
    emitErr(`Invalid section spec — expected "file::Heading", got: ${opts.spec}`)
    return 1
  }
  const filePath = opts.spec.slice(0, colonIdx)
  const heading = opts.spec.slice(colonIdx + 2)

  const result = readSection(filePath, heading)
  if (result === null) {
    emitErr(`Section '${heading}' not found in '${filePath}'`)
    const available = listAllSections(filePath)
    if (available.length > 0) {
      const lines = ['Available sections:']
      for (const s of available) {
        lines.push(`  - ${s}`)
      }
      emitErr(lines.join('\n'))
    }
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(result, null, 2))
    return 0
  }

  const redirectNote =
    result.redirectedFrom !== undefined ? ` (redirected from: '${result.redirectedFrom}')` : ''
  emit(`# ${result.heading} — ${filePath}:${result.lineStart}-${result.lineEnd}${redirectNote}\n${result.content}`)
  return 0
}

// ---- refs -------------------------------------------------------------------

export interface RefsOptions {
  spec: string
  callers?: boolean
  json?: boolean
  limit?: number
}

/** Handle ``token-goat refs file::symbol``. */
export function runRefs(opts: RefsOptions): number {
  const { file, symbol } = parseReadSpec(opts.spec)
  const symName = symbol ?? file

  const queryOpts: Parameters<typeof queryRefs>[0] = { name: symName }
  if (symbol !== undefined) queryOpts.filePath = resolveIndexPath(file)
  if (opts.limit !== undefined) queryOpts.limit = opts.limit

  const results = queryRefs(queryOpts)

  if (results.length === 0) {
    emitErr(`No references found for '${symName}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }

  if (opts.callers === true) {
    emitCallerGroups(results)
  } else {
    for (const ref of results) {
      emit(`${ref.filePath}:${ref.line}: ${ref.context}`)
    }
  }
  return 0
}

function emitCallerGroups(refs: RefEntry[]): void {
  const byFile = new Map<string, RefEntry[]>()
  for (const ref of refs) {
    const bucket = byFile.get(ref.filePath)
    if (bucket !== undefined) {
      bucket.push(ref)
    } else {
      byFile.set(ref.filePath, [ref])
    }
  }
  for (const [file, fileRefs] of byFile) {
    emit(`${file}:`)
    for (const ref of fileRefs) {
      emit(`  :${ref.line}  ${ref.context !== '' ? ref.context : '(module scope)'}`)
    }
  }
}

// ---- skeleton / stub_view ---------------------------------------------------

export interface SkeletonOptions {
  file: string
  json?: boolean
  minLines?: number
}

/** Handle ``token-goat skeleton file``. */
export function runSkeleton(opts: SkeletonOptions): number {
  const symbols = querySymbols({ filePath: resolveIndexPath(opts.file), limit: 500 })

  if (symbols.length === 0) {
    emitErr(`No indexed symbols found in '${opts.file}'`)
    return 1
  }

  if (opts.json === true) {
    emit(
      JSON.stringify(
        symbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          lineStart: s.lineStart,
          lineEnd: s.lineEnd,
        })),
        null,
        2,
      ),
    )
    return 0
  }

  const filtered =
    opts.minLines !== undefined
      ? symbols.filter((s) => s.lineEnd - s.lineStart + 1 >= (opts.minLines ?? 0))
      : symbols

  const totalLines = filtered.at(-1)?.lineEnd ?? 0
  emit(`# Skeleton: ${opts.file}  (${filtered.length} symbols, ${totalLines} lines)`)
  for (const sym of filtered) {
    const lineStr = sym.lineStart.toString().padStart(6)
    emit(`  ${lineStr}  ${sym.kind.padEnd(10)}  ${sym.name}  ${firstBodyLine(sym.body)}`)
  }
  return 0
}

// ---- outline ----------------------------------------------------------------

export interface OutlineOptions {
  file: string
  json?: boolean
  minLines?: number
}

/** Handle ``token-goat outline file``. */
export function runOutline(opts: OutlineOptions): number {
  const symbols = querySymbols({ filePath: resolveIndexPath(opts.file), limit: 500 })

  if (symbols.length === 0) {
    emitErr(`No indexed symbols found in '${opts.file}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(symbols, null, 2))
    return 0
  }

  const filtered =
    opts.minLines !== undefined
      ? symbols.filter((s) => s.lineEnd - s.lineStart + 1 >= (opts.minLines ?? 0))
      : symbols

  emit(`# Outline: ${opts.file}  (${filtered.length} symbols)`)
  for (const sym of filtered) {
    const rangeStr = `${sym.lineStart.toString().padStart(4)}-${sym.lineEnd.toString().padEnd(6)}`
    const kindStr = sym.kind.padEnd(14)
    const bodyLen = sym.lineEnd - sym.lineStart + 1
    const docFirst = sym.docstring ? `  # ${sym.docstring.split('\n')[0] ?? ''}` : ''
    emit(`  ${rangeStr}  ${kindStr}  ${sym.name}  (${bodyLen}ℓ)${docFirst}`)
  }
  return 0
}

// ---- find -------------------------------------------------------------------

export interface FindOptions {
  pattern: string
  json?: boolean
  limit?: number
}

/** Handle ``token-goat find <pattern>``. */
export function runFind(opts: FindOptions): number {
  const symbols = querySymbols({ name: opts.pattern, limit: opts.limit ?? 50 })
  const files = [...new Set(symbols.map((s) => s.filePath))]

  if (files.length === 0) {
    emitErr(`No indexed files match '${opts.pattern}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(files, null, 2))
    return 0
  }

  for (const f of files) {
    emit(f)
  }
  return 0
}

// ---- section listing --------------------------------------------------------

export interface ListSectionsOptions {
  file: string
  json?: boolean
}

/** Handle ``token-goat section --list file``. */
export function runListSections(opts: ListSectionsOptions): number {
  const sections = listSections(opts.file)

  if (sections.length === 0) {
    emitErr(`No sections found in '${opts.file}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(sections, null, 2))
    return 0
  }

  for (const s of sections) {
    emit(s)
  }
  return 0
}

// ---- changed ----------------------------------------------------------------

export interface ChangedOptions {
  ref?: string
  symbolMode?: boolean
  json?: boolean
  projectRoot?: string
}

/** Handle ``token-goat changed`` (plain file list, or `--symbol` for changed symbols). */
export function runChanged(opts: ChangedOptions = {}): number {
  const ref = opts.ref ?? 'HEAD~5'
  const projectRoot = opts.projectRoot ?? process.cwd()

  let changedFiles: string[]
  try {
    const result = runGit(['diff', ref, '--name-only'], { cwd: projectRoot })
    if (result.exitCode !== 0) {
      emitErr(`git diff failed: ${result.stderr}`)
      return 1
    }
    changedFiles = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  } catch {
    emitErr(`Could not run git diff against '${ref}'`)
    return 1
  }

  if (changedFiles.length === 0) {
    emit('No files changed.')
    return 0
  }

  if (opts.symbolMode === true) {
    const allSymbols: SymbolEntry[] = []
    for (const f of changedFiles) {
      allSymbols.push(...querySymbols({ filePath: resolveIndexPath(f, projectRoot), limit: 1000 }))
    }
    if (allSymbols.length === 0) {
      emit('No symbols changed.')
      return 0
    }
    if (opts.json === true) {
      emit(JSON.stringify(allSymbols, null, 2))
      return 0
    }
    for (const s of allSymbols) {
      emit(`${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}`)
    }
    return 0
  }

  if (opts.json === true) {
    emit(JSON.stringify(changedFiles, null, 2))
    return 0
  }
  for (const f of changedFiles) {
    emit(f)
  }
  return 0
}

// ---- grep -------------------------------------------------------------------

export interface GrepOptions {
  pattern: string
  path?: string
  maxLines?: number
  json?: boolean
  recursive?: boolean
}

/** Handle ``token-goat grep <pattern>``. */
export function runGrep(opts: GrepOptions): number {
  const searchPath = opts.path ?? process.cwd()
  const maxLines = opts.maxLines ?? GREP_MAX_LINES

  let regex: RegExp
  try {
    regex = new RegExp(opts.pattern)
  } catch {
    emitErr(`Invalid regex: ${opts.pattern}`)
    return 1
  }

  const hits: Array<{ file: string; line: number; text: string }> = []

  function searchFile(filePath: string): void {
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      const lines = text.split('\n')
      lines.forEach((lineText, idx) => {
        if (regex.test(lineText)) {
          hits.push({ file: filePath, line: idx + 1, text: lineText })
        }
      })
    } catch {
      // skip unreadable files
    }
  }

  function searchDir(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.')) continue
        const full = path.join(dir, entry)
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          if (opts.recursive !== false) searchDir(full)
        } else {
          searchFile(full)
        }
      }
    } catch {
      // skip
    }
  }

  if (!fileExists(searchPath)) {
    emitErr(`Path not found: ${searchPath}`)
    return 1
  }

  const stat = fs.statSync(searchPath)
  if (stat.isDirectory()) {
    searchDir(searchPath)
  } else {
    searchFile(searchPath)
  }

  if (hits.length === 0) {
    emitErr(`No matches for '${opts.pattern}'`)
    return 1
  }

  const truncated = hits.slice(0, maxLines)

  if (opts.json === true) {
    emit(JSON.stringify(truncated, null, 2))
    return 0
  }

  for (const hit of truncated) {
    emit(`${hit.file}:${hit.line}: ${hit.text}`)
  }

  if (hits.length > maxLines) {
    emitErr(`... (${hits.length - maxLines} more lines omitted)`)
  }

  return 0
}

// ---- config-get -------------------------------------------------------------

export interface ConfigGetOptions {
  file: string
  key: string
}

/**
 * Resolve a scalar value at a dotted path in a YAML document, line-based (no YAML
 * library). Handles flat keys, indentation-nested keys at any consistent indent
 * width, quoted values, and values containing a colon; skips comment and blank
 * lines. Does not handle lists, multi-line/block scalars, flow mappings, inline
 * comments after a value, or a literal dotted key.
 */
function lookupYaml(lines: readonly string[], key: string): string | null {
  const parts = key.split('.')
  let depth = 0
  let parentIndent = -1
  let childIndent = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (depth > 0 && indent <= parentIndent) return null
    if (childIndent !== -1 && indent !== childIndent) continue
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    if (childIndent === -1) childIndent = indent
    const k = trimmed.slice(0, colon).trim()
    if (k !== parts[depth]) continue
    if (depth === parts.length - 1) {
      return trimmed
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    }
    parentIndent = indent
    childIndent = -1
    depth++
  }
  return null
}

/** Handle ``token-goat config-get file key``. */
export function runConfigGet(opts: ConfigGetOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  const ext = path.extname(opts.file).toLowerCase()

  if (ext === '.json') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = JSON.parse(text)
      for (const part of opts.key.split('.')) {
        if (typeof obj !== 'object' || obj === null) {
          emitErr(`Key '${opts.key}' not found in ${opts.file}`)
          return 1
        }
        obj = obj[part]
        if (obj === undefined) {
          emitErr(`Key '${opts.key}' not found in ${opts.file}`)
          return 1
        }
      }
      emit(JSON.stringify(obj))
      return 0
    } catch {
      emitErr(`Failed to parse JSON: ${opts.file}`)
      return 1
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    const value = lookupYaml(text.split(/\r?\n/), opts.key)
    if (value === null) {
      emitErr(`Key '${opts.key}' not found in ${opts.file}`)
      return 1
    }
    emit(value)
    return 0
  }

  // For TOML/INI: section-aware line-based extraction Split the key into section path and leaf key: "tool.ruff.line-length" -> ["tool.ruff"] + "line-length"
  const keyParts = opts.key.split('.')
  const leafKey = keyParts.at(-1) ?? opts.key
  const sectionPath = keyParts.length > 1 ? keyParts.slice(0, -1).join('.') : null
  const lines = text.split('\n')

  // Build the expected section header(s) for TOML-style [section] or [section.subsection] For a key like "tool.ruff.line-length", look for [tool.ruff] or [tool] followed by [ruff]
  let currentSection = ''
  for (const line of lines) {
    const trimmed = line.trim()

    // Check for section header like [tool.ruff] or [tool]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1)
      continue
    }

    // Check if we're in the right section (if a section path is specified)
    if (sectionPath !== null) {
      // For a nested path like "tool.ruff.line-length", the section should be "tool.ruff"
      if (currentSection !== sectionPath) {
        continue
      }
    }

    // Look for the leaf key in a key=value line
    if (trimmed.startsWith(`${leafKey} =`) || trimmed.startsWith(`${leafKey}=`)) {
      const eqIdx = trimmed.indexOf('=')
      emit(trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, ''))
      return 0
    }
  }

  emitErr(`Key '${opts.key}' not found in ${opts.file}`)
  return 1
}

// ---- exports/imports --------------------------------------------------------

export interface ImportsExportsOptions {
  file: string
  json?: boolean
}

/**
 * Extract exported symbol names from source text. The tree-sitter indexer
 * stores a symbol's body starting at the inner declaration (e.g. `function`),
 * not the `export` modifier on its parent statement, so a body-prefix heuristic
 * misses real exports — this scans the source so `exports` is functional for the
 * flagship TS/JS case as well as Python, Rust, and Java.
 */
export function extractExportNames(text: string, ext: string): string[] {
  const names: string[] = []
  const push = (s: string | undefined): void => {
    let v = (s ?? '').trim()
    if (v.includes(' as ')) v = v.split(/\s+as\s+/).pop()?.trim() ?? v
    if (v !== '' && v !== 'default' && !names.includes(v)) names.push(v)
  }
  const e = ext.toLowerCase()
  const lines = text.split(/\r?\n/)

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e)) {
    const declRe = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
    const defaultRe = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/g
    const namedRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = declRe.exec(text)) !== null) push(m[1])
    while ((m = defaultRe.exec(text)) !== null) push(m[1])
    while ((m = namedRe.exec(text)) !== null) {
      for (const part of (m[1] ?? '').split(',')) push(part)
    }
  } else if (e === '.py') {
    for (const line of lines) {
      const m = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line)
      if (m && !(m[1] ?? '').startsWith('_')) push(m[1])
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const m = /^\s*pub(?:\s*\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod|static)\s+([A-Za-z_]\w*)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /\bpublic\s+(?:static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/.exec(line)
      if (m) push(m[1])
    }
  }
  return names
}

/** Handle ``token-goat exports file``. */
export function runExports(opts: ImportsExportsOptions): number {
  const symbols = querySymbols({ filePath: resolveIndexPath(opts.file), limit: 500 })
  const kindOf = (name: string): string => symbols.find((s) => s.name === name)?.kind ?? 'export'

  // Index-side heuristic: catches languages whose stored body keeps the `export`/`pub`/`public` modifier, and the mocked unit tests.
  const names: string[] = []
  for (const s of symbols) {
    if (/^(?:export|pub\b|public\b)/.test(s.body.trimStart()) && !names.includes(s.name)) {
      names.push(s.name)
    }
  }
  const ext = path.extname(opts.file).toLowerCase()
  // Source scan: catches tree-sitter languages whose body omits the modifier.
  const text = readFileText(opts.file)
  if (text !== null) {
    if (ext === '.go') {
      for (const s of symbols) if (/^[A-Z]/.test(s.name) && !names.includes(s.name)) names.push(s.name)
    }
    for (const n of extractExportNames(text, ext)) if (!names.includes(n)) names.push(n)
  }

  if (names.length === 0) {
    emit(`No exported symbols found in '${opts.file}'`)
    return 0
  }

  if (opts.json === true) {
    emit(JSON.stringify(names.map((n) => ({ name: n, kind: kindOf(n) })), null, 2))
    return 0
  }

  for (const n of names) {
    emit(`${kindOf(n).padEnd(10)} ${n}`)
  }
  return 0
}

/**
 * Extract import/include module specifiers from source text, covering the
 * bundled tree-sitter languages plus a few common extras. Returns one entry per
 * import in source order, de-duplicated. This is deliberately index-independent:
 * the symbol index does not store import statements as rows for the tree-sitter
 * languages, so a query-only `imports` returned nothing for TS/JS/Python/etc.
 */
export function extractImports(text: string, ext: string): string[] {
  const found: string[] = []
  const push = (s: string | undefined): void => {
    const v = (s ?? '').trim()
    if (v !== '' && !found.includes(v)) found.push(v)
  }
  const e = ext.toLowerCase()
  const lines = text.split(/\r?\n/)

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e)) {
    for (const line of lines) {
      const from = /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/.exec(line)
      if (from) { push(from[1]); continue }
      const bare = /^\s*import\s*['"]([^'"]+)['"]/.exec(line)
      if (bare) { push(bare[1]); continue }
      const req = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line)
      if (req) { push(req[1]); continue }
      const dyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line)
      if (dyn) push(dyn[1])
    }
  } else if (e === '.py') {
    for (const line of lines) {
      const from = /^\s*from\s+([.\w]+)\s+import\b/.exec(line)
      if (from) { push(from[1]); continue }
      const imp = /^\s*import\s+(.+)$/.exec(line)
      if (imp) for (const part of (imp[1] ?? '').split(',')) push(part.trim().split(/\s+as\s+/)[0])
    }
  } else if (e === '.go') {
    let inBlock = false
    for (const line of lines) {
      if (/^\s*import\s*\(/.test(line)) { inBlock = true; continue }
      if (inBlock) {
        if (/^\s*\)/.test(line)) { inBlock = false; continue }
        const m = /['"]([^'"]+)['"]/.exec(line)
        if (m) push(m[1])
        continue
      }
      const single = /^\s*import\s+(?:[\w.]+\s+)?['"]([^'"]+)['"]/.exec(line)
      if (single) push(single[1])
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const m = /^\s*(?:pub\s+)?use\s+([^;{]+)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.rb') {
    for (const line of lines) {
      const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(line)
      if (m) push(m[1])
    }
  } else {
    for (const line of lines) {
      const m = /(?:import|require|use|#include)\s+['"<]?([^'">;]+)/.exec(line)
      if (m) push(m[1])
    }
  }
  return found
}

/** Handle ``token-goat imports file``. */
export function runImports(opts: ImportsExportsOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  const imports = extractImports(text, path.extname(opts.file))

  if (imports.length === 0) {
    emit(`No imports found in '${opts.file}'`)
    return 0
  }

  if (opts.json === true) {
    emit(JSON.stringify(imports, null, 2))
    return 0
  }

  for (const imp of imports) {
    emit(`import  ${imp}`)
  }
  return 0
}

// ---- re-export underlying layers -------------------------------------------

export type { SymbolEntry, RefEntry }
export { querySymbols, queryRefs, readSection, listSections, extractSection, listAllSections }
