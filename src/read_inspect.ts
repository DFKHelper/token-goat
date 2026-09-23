import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  ArchiveDependencyMissingError,
  extractZipEntry,
  formatZipList,
  listZipEntries,
  type ZipEntry,
} from './archive_query.js'
import {
  filterCoverageGapsByFile,
  formatCoverageGaps,
  parseCoverageReport,
} from './coverage_query.js'
import { extractExportNames, extractImports, importsExtensionFor } from './import_export_extract.js'
import { querySymbols } from './index_reader.js'
import { getNote, isNoteStale, listNotes, WHOLE_FILE_NOTE_SYMBOL } from './notes.js'
import type { SymbolEntry } from './parser_types.js'
import { displaySafeJson, displaySafeText, resolveIndexPath, toDisplayPath } from './paths.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import {
  didYouMean,
  emit,
  emitErr,
  emitGuarded,
  fileConfinementRefusal,
  guardJsonRows,
  healStaleIndex,
  isValidUtf8,
  rankSimilarNames,
  readFileBytes,
  readFileText,
  recordReadStat,
  resolveAgainstProjectRoot,
  sumFileSizes,
  healStaleResultFiles,
} from './read_commands.js'
import { listSections } from './section_reader.js'
import { forEachSymbol } from './symbol_scan.js'
import {
  formatSqliteQueryTable,
  formatSqliteSchema,
  formatSqliteTables,
  getSqliteSchema,
  getSqliteTables,
  runReadOnlySqliteQuery,
} from './sqlite_query.js'
import { recordStat } from './stats.js'
import {
  compileGrepMatcher,
  escapeRegExp,
  extractErrorMessage,
  grepFilteredToEmptyNotice,
  requireNonNegativeStrictInt,
} from './util.js'
import { ZipInputTooLargeError, ZipOutputTooLargeError } from './zip_bounds.js'

function fileExists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

export interface ZipListCliOptions {
  file: string
  json?: boolean
}

function archiveReadFailure(err: unknown, file: string): string {
  if (err instanceof ArchiveDependencyMissingError || err instanceof ZipOutputTooLargeError) return err.message
  return `Failed to read archive (not a valid zip-format file): ${file}`
}

export async function runZipList(opts: ZipListCliOptions): Promise<number> {
  let data: Buffer | null
  try {
    data = readFileBytes(opts.file)
  } catch (err) {
    if (err instanceof ZipInputTooLargeError) {
      emitErr(err.message)
      return 1
    }
    throw err
  }
  if (data === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let entries: ZipEntry[]
  try {
    entries = await listZipEntries(data)
  } catch (err) {
    emitErr(archiveReadFailure(err, opts.file))
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(entries, 0)
    emit(jsonText)
    recordReadStat('zip_list', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = formatZipList(entries)
    emitGuarded(text, 'zip-list')
    recordReadStat('zip_list', fullSourceBytes, text, opts.file)
  }
  return 0
}

export interface ZipReadCliOptions {
  file: string
  entry: string
  json?: boolean
}

export async function runZipRead(opts: ZipReadCliOptions): Promise<number> {
  let data: Buffer | null
  try {
    data = readFileBytes(opts.file)
  } catch (err) {
    if (err instanceof ZipInputTooLargeError) {
      emitErr(err.message)
      return 1
    }
    throw err
  }
  if (data === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let entries: ZipEntry[]
  let content: Uint8Array | undefined
  try {
    entries = await listZipEntries(data)
    content = await extractZipEntry(data, opts.entry)
  } catch (err) {
    emitErr(archiveReadFailure(err, opts.file))
    return 1
  }

  const matchedEntry = entries.find((e) => e.path === opts.entry)
  if (matchedEntry?.isDirectory === true) {
    emitErr(`Entry '${opts.entry}' is a directory, not a file, in '${opts.file}'`)
    return 1
  }

  if (content === undefined) {
    const messages = [`Entry '${opts.entry}' not found in '${opts.file}'`]
    const closes = rankSimilarNames(entries.map((e) => e.path), opts.entry)
    if (closes.length > 0) messages.push(didYouMean(closes))
    else if (entries.length > 0) messages.push(`Try: token-goat zip-list ${opts.file}`)
    emitErr(messages.join('\n'))
    return 1
  }

  const buf = Buffer.from(content)
  const text = isValidUtf8(buf) ? buf.toString('utf-8') : '[binary content elided by token-goat]'
  const fullSourceBytes = sumFileSizes([opts.file])

  if (opts.json === true) {
    const jsonText = displaySafeJson({ path: opts.entry, text }, 0)
    emit(jsonText)
    recordReadStat('zip_read', fullSourceBytes, jsonText, opts.entry)
  } else {
    emitGuarded(text, 'zip-read')
    recordReadStat('zip_read', fullSourceBytes, text, opts.entry)
  }
  return 0
}

export interface SqliteSchemaCliOptions {
  file: string
  json?: boolean
}

export function runSqliteSchema(opts: SqliteSchemaCliOptions): number {
  try {
    const schema = getSqliteSchema(opts.file)
    const fullSourceBytes = sumFileSizes([opts.file])
    if (opts.json === true) {
      const jsonText = displaySafeJson(schema, 0)
      emit(jsonText)
      recordReadStat('sqlite_schema', fullSourceBytes, jsonText, opts.file)
    } else {
      const text = formatSqliteSchema(schema)
      emit(text)
      recordReadStat('sqlite_schema', fullSourceBytes, text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface SqliteTablesCliOptions {
  file: string
  json?: boolean
}

export function runSqliteTables(opts: SqliteTablesCliOptions): number {
  try {
    const tables = getSqliteTables(opts.file)
    const fullSourceBytes = sumFileSizes([opts.file])
    if (opts.json === true) {
      const jsonText = displaySafeJson(tables, 0)
      emit(jsonText)
      recordReadStat('sqlite_tables', fullSourceBytes, jsonText, opts.file)
    } else {
      const text = formatSqliteTables(tables)
      emit(text)
      recordReadStat('sqlite_tables', fullSourceBytes, text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface SqliteQueryCliOptions {
  file: string
  sql: string
  head?: string
  json?: boolean
}

export function runSqliteQuery(opts: SqliteQueryCliOptions): number {
  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }

  try {
    const result = runReadOnlySqliteQuery(opts.file, opts.sql)
    const totalCount = result.rows.length
    const headTruncated = head !== undefined && result.rows.length > head
    const rows = head !== undefined ? result.rows.slice(0, head) : result.rows

    if (opts.json === true) {
      const capped = guardJsonRows(rows)
      const jsonText = displaySafeJson({
        columns: result.columns,
        items: capped.items,
        truncated: capped.truncated || headTruncated || result.rowCapped,
        totalCount,
        rowCapped: result.rowCapped,
      }, 0)
      emit(jsonText)
      const uncappedFull = guardJsonRows(result.rows)
      const baselineJsonText = displaySafeJson({
        columns: result.columns,
        items: uncappedFull.items,
        truncated: uncappedFull.truncated || result.rowCapped,
        totalCount,
        rowCapped: result.rowCapped,
      }, 0)
      recordReadStat('sqlite_query', Buffer.byteLength(baselineJsonText, 'utf8'), jsonText, opts.file)
    } else {
      const text = formatSqliteQueryTable({ ...result, rows }, { headTruncated })
      emit(text)
      const baselineText = formatSqliteQueryTable({ ...result, rows: result.rows }, { headTruncated: false })
      recordReadStat('sqlite_query', Buffer.byteLength(baselineText, 'utf8'), text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface CoverageReportGapsCliOptions {
  file: string
  fileFilter?: string
  json?: boolean
}

export function runCoverageReportGaps(opts: CoverageReportGapsCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let report: ReturnType<typeof parseCoverageReport>
  try {
    report = parseCoverageReport(text)
  } catch (e) {
    emitErr(`Failed to parse coverage report (not valid LCOV or Istanbul JSON): ${opts.file}\n${extractErrorMessage(e)}`)
    return 1
  }

  const scoped = opts.fileFilter !== undefined ? filterCoverageGapsByFile(report, opts.fileFilter) : report
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(scoped, 0)
    emit(jsonText)
    recordReadStat('coverage_report_gaps', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = formatCoverageGaps(scoped)
    emitGuarded(text, 'coverage-report-gaps')
    recordReadStat('coverage_report_gaps', fullSourceBytes, text, opts.file)
  }
  return 0
}

function stripInlineComment(s: string): string {
  let inQuote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuote !== null) {
      if (ch === '\\' && i + 1 < s.length) {
        i++
        continue
      }
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === '#' || ch === ';') {
      return s.slice(0, i)
    }
  }
  return s
}

function stripPairedQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return s.slice(1, -1)
    }
  }
  return s
}

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
      return stripPairedQuotes(trimmed.slice(colon + 1).trim())
    }
    parentIndent = indent
    childIndent = -1
    depth++
  }
  return null
}

function extractFrontmatter(lines: readonly string[]): string[] | null {
  if (lines[0]?.trim() !== '---') return null
  let j = 1
  while (j < lines.length && lines[j]?.trim() !== '---') {
    j++
  }
  if (j >= lines.length) return null
  return lines.slice(1, j)
}

export interface ConfigGetOptions {
  file: string
  key: string
}

export function runConfigGet(opts: ConfigGetOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  const frontmatterLines = extractFrontmatter(text.split(/\r?\n/))
  if (frontmatterLines !== null) {
    const value = lookupYaml(frontmatterLines, opts.key)
    if (value === null) {
      emitErr(`Key '${opts.key}' not found in ${opts.file}`)
      return 1
    }
    emit(value)
    return 0
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
      emit(displaySafeJson(obj, 0))
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

  const keyParts = opts.key.split('.')
  const leafKey = keyParts.at(-1) ?? opts.key
  const sectionPath = keyParts.length > 1 ? keyParts.slice(0, -1).join('.') : null
  const lines = text.split('\n')

  let currentSection = ''
  for (const line of lines) {
    const trimmed = line.trim()
    const headerMatch = /^\[([^\]\r\n]+)\]\s*(?:[;#].*)?$/.exec(trimmed)
    if (headerMatch) {
      currentSection = (headerMatch[1] ?? '').trim()
      continue
    }

    if (currentSection !== (sectionPath ?? '')) {
      continue
    }

    if (new RegExp(`^${escapeRegExp(leafKey)}\\s*=`).test(trimmed)) {
      const eqIdx = trimmed.indexOf('=')
      const rawValue = stripInlineComment(trimmed.slice(eqIdx + 1)).trim()
      emit(stripPairedQuotes(rawValue))
      return 0
    }
  }

  emitErr(`Key '${opts.key}' not found in ${opts.file}`)
  return 1
}

export interface ImportsExportsOptions {
  file: string
  json?: boolean
  projectRoot?: string
  grep?: string
}

function runPerFileEmitting(files: string[], label: string, run: (file: string) => number): number {
  let anyOk = false
  files.forEach((file, i) => {
    if (i > 0) emit('')
    emit(`# ${label}: ${file}`)
    if (run(file) === 0) anyOk = true
  })
  return anyOk ? 0 : 1
}

export function runExports(opts: ImportsExportsOptions): number {
  const multiFiles = opts.file.split(',').map((f) => f.trim()).filter(Boolean)
  if (multiFiles.length > 1) return runPerFileEmitting(multiFiles, 'Exports', (file) => runExports({ ...opts, file }))

  const confined = fileConfinementRefusal('This file', opts.file, opts.projectRoot)
  if (confined !== null) {
    emitErr(confined)
    return 1
  }

  const diskPath = resolveAgainstProjectRoot(opts.file, opts.projectRoot)
  const symbols = querySymbols({ filePath: resolveIndexPath(diskPath), limit: -1 })
  const kindOf = (name: string): string => symbols.find((s: SymbolEntry) => s.name === name)?.kind ?? 'export'
  const locOf = (name: string): { lineStart: number; lineEnd: number } | null => {
    const s = symbols.find((sym: SymbolEntry) => sym.name === name)
    return s === undefined ? null : { lineStart: s.lineStart, lineEnd: s.lineEnd }
  }

  const names: string[] = []
  for (const s of symbols) {
    if (/^(?:export|pub\b|public\b)/.test(s.body.trimStart()) && !names.includes(s.name)) {
      names.push(s.name)
    }
  }
  const ext = path.extname(opts.file).toLowerCase()
  const text = readFileText(diskPath)
  if (text === null && symbols.length === 0) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  if (text !== null) {
    if (ext === '.go') {
      for (const s of symbols) if (/^[A-Z]/.test(s.name) && !names.includes(s.name)) names.push(s.name)
    }
    for (const n of extractExportNames(text, ext)) if (!names.includes(n)) names.push(n)
  }

  if (names.length === 0) {
    emit(`No exported symbols found in '${displaySafeText(opts.file)}'`)
    return 0
  }

  const preFilterCount = names.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredNames = matchesGrep !== undefined ? names.filter((n) => matchesGrep(n)) : names
  const fullSourceBytes = sumFileSizes([diskPath])

  if (filteredNames.length === 0) {
    if (opts.json === true) {
      const jsonText = displaySafeJson([])
      emit(jsonText)
      recordReadStat('exports', fullSourceBytes, jsonText, opts.file)
      return 0
    }
    const textOut = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'exported symbol', 'exported symbols')
    emit(textOut)
    recordReadStat('exports', fullSourceBytes, textOut, opts.file)
    return 0
  }

  if (opts.json === true) {
    const jsonText = displaySafeJson(
      filteredNames.map((n) => {
        const loc = locOf(n)
        return { name: n, kind: kindOf(n), lineStart: loc?.lineStart ?? null, lineEnd: loc?.lineEnd ?? null }
      }))
    emit(jsonText)
    recordReadStat('exports', fullSourceBytes, jsonText, opts.file)
    return 0
  }

  const outLines = filteredNames.map((n) => {
    const loc = locOf(n)
    const locSuffix = loc === null ? '' : ` (${loc.lineStart}-${loc.lineEnd})`
    return `${kindOf(n).padEnd(10)} ${n}${locSuffix}`
  })
  for (const line of outLines) {
    emit(line)
  }
  recordReadStat('exports', fullSourceBytes, outLines.join('\n'), opts.file)
  return 0
}

export function runImports(opts: ImportsExportsOptions): number {
  const multiFiles = opts.file.split(',').map((f) => f.trim()).filter(Boolean)
  if (multiFiles.length > 1) return runPerFileEmitting(multiFiles, 'Imports', (file) => runImports({ ...opts, file }))

  const diskPath = resolveAgainstProjectRoot(opts.file, opts.projectRoot)
  const text = readFileText(diskPath)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  const imports = extractImports(text, importsExtensionFor(opts.file))

  if (imports.length === 0) {
    emit(`No imports found in '${displaySafeText(opts.file)}'`)
    return 0
  }

  const preFilterCount = imports.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredImports = matchesGrep !== undefined ? imports.filter((i) => matchesGrep(i)) : imports
  const fullSourceBytes = sumFileSizes([diskPath])

  if (filteredImports.length === 0) {
    if (opts.json === true) {
      const jsonText = displaySafeJson({ items: [], truncated: false, totalCount: 0 })
      emit(jsonText)
      recordReadStat('imports', fullSourceBytes, jsonText, opts.file)
      return 0
    }
    const text2 = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'import', 'imports')
    emit(text2)
    recordReadStat('imports', fullSourceBytes, text2, opts.file)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(filteredImports)
    const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount })
    emit(jsonText)
    recordReadStat('imports', fullSourceBytes, jsonText, opts.file)
    return 0
  }

  const outLines = filteredImports.map((imp) => `import  ${imp}`)
  for (const line of outLines) {
    emit(line)
  }
  recordReadStat('imports', fullSourceBytes, outLines.join('\n'), opts.file)
  return 0
}

export function extractTranscriptText(jsonl: string): string {
  const collected: string[] = []
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null) continue
    const rec = obj as Record<string, unknown>
    if (rec['type'] !== 'assistant') continue
    const msg = rec['message']
    if (typeof msg !== 'object' || msg === null) continue
    const content = (msg as Record<string, unknown>)['content']
    if (typeof content === 'string') {
      if (content.length > 0) collected.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].length > 0) {
        collected.push(b['text'])
      }
    }
  }
  return collected.join('\n')
}

export interface NoteGetOptions {
  file: string
  symbol?: string
  json?: boolean
  projectRoot?: string
}

export function runNoteGet(opts: NoteGetOptions): { text: string; code: number } {
  const resolvedPath = resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())
  healStaleIndex(resolvedPath)
  const symbol = opts.symbol ?? WHOLE_FILE_NOTE_SYMBOL
  const note = getNote(resolvedPath, symbol)
  if (note === null) {
    const where = opts.symbol !== undefined ? ` for symbol '${opts.symbol}'` : ' (whole-file note)'
    return { text: `No note found for '${opts.file}'${where}`, code: 1 }
  }

  const stale = isNoteStale(note)
  if (opts.json === true) {
    const payload = {
      filePath: note.filePath,
      symbol: note.symbol === WHOLE_FILE_NOTE_SYMBOL ? null : note.symbol,
      content: note.content,
      stale,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }
    const text = displaySafeJson(payload)
    recordStat('note_read')
    return { text, code: 0 }
  }

  const target = note.symbol === WHOLE_FILE_NOTE_SYMBOL ? opts.file : `${opts.file}::${note.symbol}`
  const staleTag = stale ? ' [STALE — code changed since this note was written]' : ''
  const text = `# note — ${target}${staleTag}\n${note.content}`
  recordStat('note_read')
  return { text, code: 0 }
}

export interface NoteListOptions {
  staleOnly?: boolean
  json?: boolean
}

export function runNoteList(opts: NoteListOptions = {}): { text: string; code: number } {
  const withStale = listNotes().map((note) => ({ note, stale: isNoteStale(note) }))
  const filtered = opts.staleOnly === true ? withStale.filter((n) => n.stale) : withStale

  if (opts.json === true) {
    const items = filtered.map(({ note, stale }) => ({
      filePath: note.filePath,
      symbol: note.symbol === WHOLE_FILE_NOTE_SYMBOL ? null : note.symbol,
      stale,
      updatedAt: note.updatedAt,
    }))
    recordStat('note_list')
    return { text: displaySafeJson(items), code: 0 }
  }

  recordStat('note_list')
  if (filtered.length === 0) {
    if (opts.staleOnly === true && withStale.length > 0) {
      const noun = withStale.length === 1 ? 'note' : 'notes'
      return { text: `No stale notes (${withStale.length} ${noun} recorded, none stale).`, code: 0 }
    }
    return { text: opts.staleOnly === true ? 'No stale notes.' : 'No notes recorded.', code: 0 }
  }
  const noteListDisplayRoot = getDisplayRoot()
  const lines = filtered.map(({ note, stale }) => {
    const displayFile = toDisplayPath(noteListDisplayRoot, note.filePath)
    const target = note.symbol === WHOLE_FILE_NOTE_SYMBOL ? displayFile : `${displayFile}::${note.symbol}`
    return `${stale ? '[STALE] ' : ''}${target}`
  })
  return { text: lines.join('\n'), code: 0 }
}

export interface FindOptions {
  pattern: string
  limit?: number
  json?: boolean
}

export function runFind(opts: FindOptions): number {
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const patternLower = opts.pattern.toLowerCase()
  // Walk the whole scope rather than one capped page: the name test is a JS substring match with no SQL equivalent, so a cap applied ahead of it drops every match that sorted past it -- and that miss falls straight into the near-name branch below, which answers a symbol that IS indexed with a confident list of unrelated files. Only file paths and names are kept, both bounded by the project rather than by its symbol count.
  const matchedFiles = new Set<string>()
  const allNames = new Set<string>()
  forEachSymbol({ rootDir }, (s: SymbolEntry) => {
    allNames.add(s.name)
    if (s.name.toLowerCase().includes(patternLower)) matchedFiles.add(s.filePath)
  })

  let fuzzyNames: string[] = []
  if (matchedFiles.size === 0) {
    fuzzyNames = rankSimilarNames([...allNames], opts.pattern)
    if (fuzzyNames.length > 0) {
      // Grouped by name and emitted in ranked order, so the files listed for the closest name come first -- the same order the single-pass filter produced when every row was in hand at once.
      const byName = new Map<string, string[]>(fuzzyNames.map((n: string) => [n, []]))
      forEachSymbol({ rootDir }, (s: SymbolEntry) => { byName.get(s.name)?.push(s.filePath) })
      for (const n of fuzzyNames) for (const f of byName.get(n) ?? []) matchedFiles.add(f)
    }
  }
  const allFiles = [...matchedFiles]
  const files = allFiles.slice(0, opts.limit ?? 50)
  const limitDropped = allFiles.length - files.length
  const truncated = limitDropped > 0

  if (files.length === 0) {
    emitErr(`No indexed files match '${opts.pattern}'`)
    return 1
  }

  if (opts.json === true) {
    const fuzzyPayload = fuzzyNames.length > 0 ? { fuzzy: true, matchedNames: fuzzyNames } : {}
    emit(displaySafeJson({ files, truncated, totalCount: allFiles.length, ...fuzzyPayload }))
    return 0
  }

  if (fuzzyNames.length > 0) {
    emitErr(`No symbol name contains '${opts.pattern}'; showing files for the nearest indexed ${fuzzyNames.length === 1 ? 'name' : 'names'}: ${fuzzyNames.join(', ')}`)
  }

  for (const f of files) {
    emit(toDisplayPath(rootDir, f))
  }

  if (limitDropped > 0) {
    emitErr(`Showing ${files.length} of ${allFiles.length} matching files; rerun with --limit ${allFiles.length} to see them all`)
  }

  return 0
}

export interface LocateOptions {
  spec: string
  file?: string
  limit?: number
  json?: boolean
  projectRoot?: string
}

export interface LocateHit {
  filePath: string
  name: string
  kind: string
  lineStart: number
  lineEnd: number
  span: string
}

export function runLocate(opts: LocateOptions): number {
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
  let targetSpec = opts.spec
  let targetFile = opts.file

  if (targetSpec.includes('::')) {
    const colonIdx = targetSpec.indexOf('::')
    targetFile = targetSpec.slice(0, colonIdx)
    targetSpec = targetSpec.slice(colonIdx + 2)
  }

  const scanOpts: Parameters<typeof forEachSymbol>[0] = {}

  if (targetFile !== undefined) {
    scanOpts.filePath = resolveIndexPath(targetFile, rootDir)
    healStaleIndex(scanOpts.filePath)
  } else {
    scanOpts.rootDir = rootDir
  }

  const limit = opts.limit ?? 25
  const specLower = targetSpec.toLowerCase()
  // Walked in full rather than fetched as one capped page, for the reason runFind gives above: the name tests below are JS string matches with no SQL equivalent, and a cap ahead of them hides matches that sorted past it behind the near-name fallback. Exact matches are kept ahead of contains matches, and each list stops at `limit` because that is all `shown` can display -- the counts beside them stay exact, so the totals reported below still describe every match in the project rather than the rows held in memory.
  interface LocateScan { exact: SymbolEntry[]; exactCount: number; partial: SymbolEntry[]; partialCount: number; names: Set<string>; files: Set<string> }
  const scan = (): LocateScan => {
    const found: LocateScan = { exact: [], exactCount: 0, partial: [], partialCount: 0, names: new Set(), files: new Set() }
    forEachSymbol(scanOpts, (s: SymbolEntry) => {
      found.names.add(s.name)
      found.files.add(s.filePath)
      const nameLower = s.name.toLowerCase()
      if (nameLower === specLower) {
        found.exactCount++
        if (found.exact.length < limit) found.exact.push(s)
      } else if (nameLower.includes(specLower)) {
        found.partialCount++
        if (found.partial.length < limit) found.partial.push(s)
      }
    })
    return found
  }

  let found = scan()
  if (targetFile === undefined) {
    const heal = healStaleResultFiles([...found.files])
    if (heal.healed) found = scan()
  }

  let matchCount = found.exactCount + found.partialCount
  let combined = [...found.exact, ...found.partial]
  let fuzzyNames: string[] = []
  if (matchCount === 0) {
    fuzzyNames = rankSimilarNames([...found.names], targetSpec)
    if (fuzzyNames.length > 0) {
      // Grouped by name and emitted in ranked order so the closest name's locations come first, matching the order a single pass over every row produced.
      const byName = new Map<string, SymbolEntry[]>(fuzzyNames.map((n: string) => [n, []]))
      forEachSymbol(scanOpts, (s: SymbolEntry) => {
        const bucket = byName.get(s.name)
        if (bucket === undefined) return
        matchCount++
        if (bucket.length < limit) bucket.push(s)
      })
      combined = fuzzyNames.flatMap((n: string) => byName.get(n) ?? [])
    }
  }

  const shown = combined.slice(0, limit)

  if (shown.length === 0) {
    emitErr(`No landmark or symbol located for '${targetSpec}'`)
    return 1
  }

  const hits: LocateHit[] = shown.map((s: SymbolEntry) => ({
    filePath: toDisplayPath(rootDir, s.filePath),
    name: s.name,
    kind: s.kind,
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
    span: `${s.lineStart}-${s.lineEnd}`,
  }))

  if (opts.json === true) {
    emit(displaySafeJson({
      items: hits,
      totalCount: matchCount,
      truncated: matchCount > limit,
      ...(fuzzyNames.length > 0 ? { fuzzy: true, matchedNames: fuzzyNames } : {}),
    }))
    return 0
  }

  if (fuzzyNames.length > 0) {
    emitErr(`No exact landmark for '${targetSpec}'; nearest matches: ${fuzzyNames.join(', ')}`)
  }

  for (const hit of hits) {
    emit(`${displaySafeText(hit.filePath)}:${hit.span} [${displaySafeText(hit.kind)}] ${displaySafeText(hit.name)}`)
  }

  if (matchCount > limit) {
    emitErr(`Showing ${limit} of ${matchCount} locations; rerun with --limit ${matchCount} to see them all`)
  }

  return 0
}

export interface ListSectionsOptions {
  file: string
  json?: boolean
  grep?: string
}

export function runListSections(opts: ListSectionsOptions): number {
  const sections = listSections(opts.file)

  if (sections.length === 0) {
    if (!fileExists(opts.file)) {
      emitErr(`Could not read: ${opts.file}`)
      return 1
    }
    emitErr(`No sections found in '${opts.file}'`)
    return 1
  }

  const preFilterCount = sections.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const totals = new Map<string, number>()
  for (const heading of sections) totals.set(heading, (totals.get(heading) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labelled = sections.map((heading) => {
    const nth = (seen.get(heading) ?? 0) + 1
    seen.set(heading, nth)
    return (totals.get(heading) ?? 1) > 1 ? `${heading}#${nth}` : heading
  })
  const filtered =
    matchesGrep !== undefined
      ? labelled.filter((_, i) => matchesGrep(sections[i] ?? ''))
      : labelled

  if (filtered.length === 0) {
    if (opts.json === true) {
      emit(displaySafeJson({ items: [], truncated: false, totalCount: 0 }))
      return 0
    }
    emit(grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'section', 'sections'))
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(filtered)
    emit(displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }))
    return 0
  }

  for (const heading of filtered) {
    emit(heading)
  }
  return 0
}
