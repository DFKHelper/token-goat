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
import { querySymbols, queryRefs, getFileEntry } from './index_reader.js'
import { readSection, listSections, extractSection } from './section_reader.js'
import { runGit } from './util.js'
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
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

function emitErr(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : text + '\n')
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
  if (opts.file !== undefined) queryOpts.filePath = opts.file
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

  for (const sym of results) {
    emit(`${sym.filePath}:${sym.lineStart}: ${sym.kind}  ${sym.name}`)
  }
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

/** Handle ``token-goat read "file::symbol"``. */
export function runRead(opts: ReadOptions): number {
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

  const [symBase, methodName] = symbol.includes('.')
    ? [symbol.split('.')[0] ?? symbol, symbol.split('.')[1]]
    : [symbol, undefined]

  // When a method name is given (e.g. "Session.refresh"), query for the method
  // name directly. Querying for symBase (the class name) and then searching for
  // methodName among those results always fails because all returned symbols have
  // name === symBase, never name === methodName.
  const lookupName = methodName ?? symBase
  const candidates = querySymbols({ name: lookupName, filePath: file, limit: 10 })

  const match = candidates[0]

  if (match === undefined) {
    emitErr(`Symbol '${symbol}' not found in '${file}'`)
    const closes = querySymbols({ filePath: file, limit: DIDYOUMEAN_LIMIT }).map((s) => s.name)
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
    const available = listSections(filePath)
    if (available.length > 0) emitErr(didYouMean(available))
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify(result, null, 2))
    return 0
  }

  emit(result.content)
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
  if (symbol !== undefined) queryOpts.filePath = file
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
      emit(`  :${ref.line}  ${ref.context}`)
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
  const symbols = querySymbols({ filePath: opts.file, limit: 500 })

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

  const totalLines = symbols.at(-1)?.lineEnd ?? 0
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
  const symbols = querySymbols({ filePath: opts.file, limit: 500 })

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

/** Handle ``token-goat changed``. */
export function runChanged(opts: ChangedOptions = {}): number {
  const ref = opts.ref ?? 'HEAD'
  const projectRoot = opts.projectRoot ?? process.cwd()

  let changedFiles: string[]
  try {
    const result = runGit(['diff', '--name-only', ref], { cwd: projectRoot })
    if (result.exitCode !== 0) {
      emitErr(`Could not run git diff against '${ref}': ${result.stderr}`)
      return 1
    }
    changedFiles = result.stdout.trim().split('\n').filter(Boolean)
  } catch {
    emitErr(`Could not run git diff against '${ref}'`)
    return 1
  }

  if (changedFiles.length === 0) {
    emit('No changed files.')
    return 0
  }

  const results: Array<{ file: string; symbols: string[] }> = []

  for (const f of changedFiles) {
    const abs = path.resolve(projectRoot, f)
    const syms = querySymbols({ filePath: abs, limit: 200 })
    if (syms.length > 0) {
      results.push({ file: f, symbols: syms.map((s) => s.name) })
    }
  }

  if (opts.json === true) {
    emit(JSON.stringify(results, null, 2))
    return 0
  }

  if (opts.symbolMode === true) {
    for (const r of results) {
      for (const sym of r.symbols) {
        emit(sym)
      }
    }
  } else {
    for (const r of results) {
      emit(`${r.file}:`)
      for (const sym of r.symbols) {
        emit(`  ${sym}`)
      }
    }
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

  // For TOML/YAML/INI: naive line-based extraction as fallback
  const leafKey = opts.key.split('.').at(-1) ?? opts.key
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
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

/** Handle ``token-goat exports file``. */
export function runExports(opts: ImportsExportsOptions): number {
  const symbols = querySymbols({ filePath: opts.file, limit: 500 })
  // Heuristic: exported symbols start with an uppercase letter in many TS files,
  // or are declared with `export` keyword (captured in body prefix).
  const exported = symbols.filter((s) => s.body.trimStart().startsWith('export'))

  if (exported.length === 0) {
    emit(`No exported symbols found in '${opts.file}'`)
    return 0
  }

  if (opts.json === true) {
    emit(JSON.stringify(exported, null, 2))
    return 0
  }

  for (const sym of exported) {
    emit(`${sym.kind.padEnd(10)} ${sym.name}`)
  }
  return 0
}

/** Handle ``token-goat imports file``. */
export function runImports(opts: ImportsExportsOptions): number {
  const symbols = querySymbols({ filePath: opts.file, kind: 'import', limit: 500 })

  if (symbols.length === 0) {
    const fileEntry = getFileEntry(opts.file)
    if (fileEntry === null) {
      emitErr(`File not indexed: ${opts.file}`)
      return 1
    }
    emit(`No imports found in '${opts.file}'`)
    return 0
  }

  if (opts.json === true) {
    emit(JSON.stringify(symbols, null, 2))
    return 0
  }

  for (const sym of symbols) {
    emit(`import  ${sym.name}`)
  }
  return 0
}

// ---- re-export underlying layers -------------------------------------------

export type { SymbolEntry, RefEntry }
export { querySymbols, queryRefs, readSection, listSections, extractSection }
