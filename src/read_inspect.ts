import * as path from 'node:path'

import { parse as parseToml } from 'smol-toml'

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
import { displaySafeJson, displaySafeText, toDisplayPath } from './paths.js'
import { resolveSpecPath } from './spec_path.js'
import { parseJsonOrJsonc } from './jsonc_text.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import { parseYamlDocument, parseYamlDocumentAsWritten } from './read_structured_data.js'
import { DELETED_TAG, emitGuarded, fileExists, fileIsGone, guardAndFenceFileText, guardJsonRows, healStaleIndex, isValidUtf8, readFileBytes, readFileText, recordReadStat, resolveAgainstProjectRoot, sinkGoneRows, sumFileSizes, healStaleResultFiles, warnIfFilesStale } from './read_commands.js'
import { didYouMean, rankSimilarNames } from './read_suggest.js'
import { emit, emitErr } from './emit.js'
import { fileConfinementRefusal } from './read_spec.js'
import { listSections } from './section_reader.js'
import { compareBinary, FirstRows, forEachSymbol, type SymbolHead, type SymbolScanScope } from './symbol_scan.js'
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
import { fenceFileFieldIfMatched, fenceFileText, fenceJsonStrings } from './untrusted_fence.js'
import { ZipInputTooLargeError, ZipOutputTooLargeError } from './zip_bounds.js'
import { CliError, formatCommandError } from './command_error.js'
import { quotedArg } from './hint_suggestion_guard.js'

export interface ZipListCliOptions {
  file: string
  json?: boolean
}

const BINARY_ENTRY_ELIDED = '[binary content elided by token-goat]'

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
      emitErr(formatCommandError(err.message))
      return 1
    }
    throw err
  }
  if (data === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  let entries: ZipEntry[]
  try {
    entries = await listZipEntries(data)
  } catch (err) {
    emitErr(formatCommandError(archiveReadFailure(err, opts.file)))
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = displaySafeJson(entries.map((e) => ({ ...e, path: fenceFileFieldIfMatched(e.path) })), 0)
    emit(jsonText)
    recordReadStat('zip_list', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = guardAndFenceFileText(formatZipList(entries), 'zip-list')
    emit(text)
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
      emitErr(formatCommandError(err.message))
      return 1
    }
    throw err
  }
  if (data === null) {
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  let entries: ZipEntry[]
  let content: Uint8Array | undefined
  try {
    entries = await listZipEntries(data)
    content = await extractZipEntry(data, opts.entry)
  } catch (err) {
    emitErr(formatCommandError(archiveReadFailure(err, opts.file)))
    return 1
  }

  const matchedEntry = entries.find((e) => e.path === opts.entry)
  if (matchedEntry?.isDirectory === true) {
    emitErr(formatCommandError(`Entry '${opts.entry}' is a directory, not a file, in '${opts.file}'`))
    return 1
  }

  if (content === undefined) {
    const messages = [`Entry '${opts.entry}' not found in '${opts.file}'`]
    const closes = rankSimilarNames(entries.map((e) => e.path), opts.entry)
    if (closes.length > 0) messages.push(didYouMean(closes))
    else if (entries.length > 0) messages.push(`Try: token-goat zip-list ${quotedArg(opts.file)}`)
    emitErr(formatCommandError(new CliError(messages)))
    return 1
  }

  const buf = Buffer.from(content)
  // The binary placeholder is token-goat's own words, so it stays outside the fence: inside, its marker would be escaped as payload.
  const text = isValidUtf8(buf) ? buf.toString('utf-8') : null
  const fullSourceBytes = sumFileSizes([opts.file])

  if (opts.json === true) {
    const jsonText = displaySafeJson({ path: opts.entry, text: text === null ? BINARY_ENTRY_ELIDED : fenceFileFieldIfMatched(text) }, 0)
    emit(jsonText)
    recordReadStat('zip_read', fullSourceBytes, jsonText, opts.entry)
  } else {
    const printed = text === null ? BINARY_ENTRY_ELIDED : guardAndFenceFileText(text, 'zip-read')
    emit(printed)
    recordReadStat('zip_read', fullSourceBytes, printed, opts.entry)
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
      const jsonText = displaySafeJson(fenceJsonStrings(schema, fenceFileFieldIfMatched), 0)
      emit(jsonText)
      recordReadStat('sqlite_schema', fullSourceBytes, jsonText, opts.file)
    } else {
      const text = fenceFileText(formatSqliteSchema(schema))
      emit(text)
      recordReadStat('sqlite_schema', fullSourceBytes, text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
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
      const jsonText = displaySafeJson(fenceJsonStrings(tables, fenceFileFieldIfMatched), 0)
      emit(jsonText)
      recordReadStat('sqlite_tables', fullSourceBytes, jsonText, opts.file)
    } else {
      const text = fenceFileText(formatSqliteTables(tables))
      emit(text)
      recordReadStat('sqlite_tables', fullSourceBytes, text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
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
    emitErr(formatCommandError(e))
    return 1
  }

  try {
    const result = runReadOnlySqliteQuery(opts.file, opts.sql)
    const totalCount = result.rows.length
    const headTruncated = head !== undefined && result.rows.length > head
    const rows = head !== undefined ? result.rows.slice(0, head) : result.rows

    if (opts.json === true) {
      const capped = guardJsonRows(rows.map((r) => fenceJsonStrings(r, fenceFileFieldIfMatched)))
      const jsonText = displaySafeJson({
        columns: result.columns.map(fenceFileFieldIfMatched),
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
      const text = fenceFileText(formatSqliteQueryTable({ ...result, rows }, { headTruncated }))
      emit(text)
      const baselineText = formatSqliteQueryTable({ ...result, rows: result.rows }, { headTruncated: false })
      recordReadStat('sqlite_query', Buffer.byteLength(baselineText, 'utf8'), text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(formatCommandError(e))
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
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  let report: ReturnType<typeof parseCoverageReport>
  try {
    report = parseCoverageReport(text)
  } catch (e) {
    emitErr(formatCommandError(new CliError([`Failed to parse coverage report (not valid LCOV or Istanbul JSON): ${opts.file}`, extractErrorMessage(e)])))
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

/** The printable value of `key` in YAML `text`: a scalar as the file spells it, a mapping or sequence as JSON, `null` for a key with no value; null when the document lacks the key, undefined when the text is not valid YAML. */
function lookupYaml(text: string, key: string): string | null | undefined {
  let typed: unknown
  let written: unknown
  try {
    typed = parseYamlDocument(text)
    written = parseYamlDocumentAsWritten(text)
  } catch {
    return undefined
  }
  const parts = key.split('.').map((name) => ({ name, joinable: true }))
  const found = resolveConfigKey(typed, parts)
  if (found === undefined) return null
  if (found === null) return 'null'
  if (typeof found === 'object' && !(found instanceof Date)) return displaySafeJson(found, 0)
  const asWritten = resolveConfigKey(written, parts)
  return typeof asWritten === 'string' ? asWritten : String(found)
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
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
    return 1
  }

  const frontmatterLines = extractFrontmatter(text.split(/\r?\n/))
  if (frontmatterLines !== null) {
    const value = lookupYaml(frontmatterLines.join('\n'), opts.key)
    if (value === undefined) {
      emitErr(formatCommandError(`Failed to parse YAML frontmatter: ${opts.file}`))
      return 1
    }
    if (value === null) {
      emitErr(formatCommandError(`Key '${opts.key}' not found in ${opts.file}`))
      return 1
    }
    emit(value)
    return 0
  }

  const ext = path.extname(opts.file).toLowerCase()

  if (ext === '.json' || ext === '.jsonc') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = parseJsonOrJsonc(text)
      for (const part of opts.key.split('.')) {
        if (typeof obj !== 'object' || obj === null) {
          emitErr(formatCommandError(`Key '${opts.key}' not found in ${opts.file}`))
          return 1
        }
        obj = obj[part]
        if (obj === undefined) {
          emitErr(formatCommandError(`Key '${opts.key}' not found in ${opts.file}`))
          return 1
        }
      }
      emit(displaySafeJson(obj, 0))
      return 0
    } catch {
      emitErr(formatCommandError(`Failed to parse JSON: ${opts.file}`))
      return 1
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    const value = lookupYaml(text, opts.key)
    if (value === undefined) {
      emitErr(formatCommandError(`Failed to parse YAML: ${opts.file}`))
      return 1
    }
    if (value === null) {
      emitErr(formatCommandError(`Key '${opts.key}' not found in ${opts.file}`))
      return 1
    }
    emit(value)
    return 0
  }

  if (ext === '.toml') {
    const toml = lookupToml(text, opts.key)
    if (toml !== undefined) {
      if (toml === null) {
        emitErr(formatCommandError(`Key '${opts.key}' not found in ${opts.file}`))
        return 1
      }
      emit(toml)
      return 0
    }
  }

  const flavour = flatKeyFlavour(opts.file)
  const lines = text.split('\n')
  // A flat key such as `spring.datasource.url` is looked up whole first, since a .properties or .env file has no sections; the section split is the INI/TOML reading of the same dots.
  const keyParts = opts.key.split('.')
  const attempts = [{ section: '', leaf: opts.key }]
  if (keyParts.length > 1) attempts.push({ section: keyParts.slice(0, -1).join('.'), leaf: keyParts.at(-1) ?? opts.key })
  for (const attempt of attempts) {
    const value = lookupFlatKey(lines, attempt.section, attempt.leaf, flavour)
    if (value !== null) {
      // A TOML file that failed to parse reaches this line scan; a value it can only see the first line of must not print as if whole.
      if (ext === '.toml' && isTomlFragment(value)) {
        emitErr(formatCommandError(`Key '${opts.key}' in ${opts.file} spans several lines and the file is not valid TOML, so it cannot be read whole`))
        return 1
      }
      emit(value)
      return 0
    }
  }

  emitErr(formatCommandError(`Key '${opts.key}' not found in ${opts.file}`))
  return 1
}

/** True when a line-scanned TOML value is the opening of a multi-line array, inline table or string, or a lone quote. */
function isTomlFragment(v: string): boolean {
  if (v === '"' || v === "'" || v.startsWith('"""') || v.startsWith("'''")) return true
  return (v.startsWith('[') && !v.endsWith(']')) || (v.startsWith('{') && !v.endsWith('}'))
}

/** One part of a config-get TOML key path; `joinable` is false for a part only quoting could have produced, so it is never merged with a neighbour into one dotted key. */
interface TomlKeyPart {
  name: string
  joinable: boolean
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

/** Split a config-get key the way TOML splits a dotted key, by handing `<key> = 0` and `<key> = 1` to the same parser: a "double" or 'single' quoted segment stays one part with its dots and escapes as TOML reads them, so `site."google.com"` names the quoted key even when a `[site.google]` table also matches the unquoted spelling. Two probe values are needed because key text such as `a = 0 #` carries a value and comments out the probe's; it reads the same under both probes only if it is a key and nothing more. A key that is not a valid TOML key falls back to a plain split on every dot. */
function splitTomlKeyPath(key: string): TomlKeyPart[] {
  const zero = tomlProbePath(key, 0)
  const one = tomlProbePath(key, 1)
  if (zero === null || one === null || JSON.stringify(zero) !== JSON.stringify(one)) return key.split('.').map((name) => ({ name, joinable: true }))
  return zero.map((name) => ({ name, joinable: TOML_BARE_KEY.test(name) }))
}

/** The key parts TOML reads from the line `<key> = <value>`, or null unless that line holds exactly one key path whose value is `value`. */
function tomlProbePath(key: string, value: number): string[] | null {
  const parts: string[] = []
  try {
    let node: unknown = parseToml(`${key} = ${value}`)
    while (typeof node === 'object' && node !== null && !Array.isArray(node)) {
      const keys = Object.keys(node)
      if (keys.length !== 1) return null
      const k = keys[0] as string
      parts.push(k)
      node = (node as Record<string, unknown>)[k]
    }
    return node === value && parts.length > 0 ? parts : null
  } catch {
    return null
  }
}

/** Resolve a dotted `key` against parsed TOML or YAML, trying longer runs of unquoted parts as one key so a quoted key containing a dot still resolves from its unquoted spelling; a quoted part is never merged with its neighbours. */
function resolveConfigKey(node: unknown, parts: readonly TomlKeyPart[]): unknown {
  if (parts.length === 0) return node
  if (typeof node !== 'object' || node === null || Array.isArray(node) || node instanceof Date) return undefined
  const table = node as Record<string, unknown>
  for (let n = 1; n <= parts.length; n++) {
    if (n > 1 && !((parts[0] as TomlKeyPart).joinable && (parts[n - 1] as TomlKeyPart).joinable)) break
    const head = parts.slice(0, n).map((p) => p.name).join('.')
    if (!Object.hasOwn(table, head)) continue
    const found = resolveConfigKey(table[head], parts.slice(n))
    if (found !== undefined) return found
  }
  return undefined
}

/** The printable value of `key` in TOML `text`: a string, null when the file parses but lacks the key, undefined when the file is not valid TOML (the caller falls back to the line scan). */
function lookupToml(text: string, key: string): string | null | undefined {
  let doc: unknown
  try {
    doc = parseToml(text)
  } catch {
    return undefined
  }
  const found = resolveConfigKey(doc, splitTomlKeyPath(key))
  if (found === undefined) return null
  if (typeof found === 'string') return found
  if (typeof found === 'object' && found !== null && !(found instanceof Date)) {
    return displaySafeJson(JSON.parse(JSON.stringify(found, (_k, x: unknown) => typeof x === 'bigint' ? x.toString() : x)), 0)
  }
  return String(found)
}

type FlatKeyFlavour = 'properties' | 'env' | 'ini'

/** Which flat key/value dialect `file` is written in, by name. */
function flatKeyFlavour(file: string): FlatKeyFlavour {
  const base = (file.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (base.endsWith('.properties')) return 'properties'
  if (/^\.env(?:\.|$)/.test(base) || base.endsWith('.env')) return 'env'
  return 'ini'
}

/** The value of `leaf` inside INI section `section` ('' for the top of the file), or null. A .properties key ends at its first `=`, `:` or whitespace and has no inline comments (java.util.Properties#load); a .env line may lead with `export `; an INI/TOML key takes `=` only. */
function lookupFlatKey(lines: readonly string[], section: string, leaf: string, flavour: FlatKeyFlavour): string | null {
  const prefix = flavour === 'env' ? '(?:export[ \\t]+)?' : ''
  const separator = flavour === 'properties' ? '(?:[ \\t]*[=:][ \\t]*|[ \\t]+)' : '\\s*=\\s*'
  const lineRe = new RegExp(`^${prefix}${escapeRegExp(leaf)}${separator}(.*)$`)
  let currentSection = ''
  for (const line of lines) {
    const trimmed = line.trim()
    const headerMatch = flavour === 'properties' ? null : /^\[([^\]\r\n]+)\]\s*(?:[;#].*)?$/.exec(trimmed)
    if (headerMatch) {
      currentSection = (headerMatch[1] ?? '').trim()
      continue
    }
    if (currentSection !== section) continue
    const m = lineRe.exec(trimmed)
    if (m === null) continue
    const raw = m[1] ?? ''
    return stripPairedQuotes((flavour === 'properties' ? raw : stripInlineComment(raw)).trim())
  }
  return null
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
    emitErr(formatCommandError(confined))
    return 1
  }

  const diskPath = resolveAgainstProjectRoot(opts.file, opts.projectRoot)
  const symbols = querySymbols({ filePath: resolveSpecPath(diskPath), limit: -1 })
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
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
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
    emitErr(formatCommandError(`Could not read: ${opts.file}`))
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

/** Collect assistant text in order from a Claude Code / subagent JSONL transcript. Each line is one JSON record; keep `type:"assistant"` records and pull their `message.content[]` text blocks (or a plain-string `content`), joined in order. Malformed lines, non-assistant records, and non-text blocks (thinking, tool_use, tool_result) are skipped. Returns the joined text, or '' when nothing matches, which keeps `--transcript` harmless on a file that is not a transcript. */
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
  const resolvedPath = resolveSpecPath(opts.file, opts.projectRoot ?? process.cwd())
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
    emitErr(formatCommandError(`--limit must be a positive number, got: ${opts.limit}`))
    return 1
  }

  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const patternLower = opts.pattern.toLowerCase()
  // Walk the whole scope rather than one capped page: the name test is a JS substring match with no SQL equivalent, so a cap applied ahead of it drops every match that sorted past it -- and that miss falls straight into the near-name branch below, which answers a symbol that IS indexed with a confident list of unrelated files. Only file paths and names are kept, both bounded by the project rather than by its symbol count.
  const matchedFiles = new Set<string>()
  const allNames = new Set<string>()
  forEachSymbol({ rootDir }, (s: SymbolHead) => {
    allNames.add(s.name)
    if (s.name.toLowerCase().includes(patternLower)) matchedFiles.add(s.filePath)
  })

  let fuzzyNames: string[] = []
  // Files in index path order, as a walk in `file_path` order listed them first-seen; the scan itself visits them in folded-path order.
  let allFiles = [...matchedFiles].sort(compareBinary)
  if (matchedFiles.size === 0) {
    fuzzyNames = rankSimilarNames([...allNames], opts.pattern)
    if (fuzzyNames.length > 0) {
      // Grouped by name and emitted in ranked order, so the files listed for the closest name come first -- the same order the single-pass filter produced when every row was in hand at once.
      const byName = new Map<string, Set<string>>(fuzzyNames.map((n: string) => [n, new Set()]))
      forEachSymbol({ rootDir }, (s: SymbolHead) => { byName.get(s.name)?.add(s.filePath) })
      for (const n of fuzzyNames) for (const f of [...(byName.get(n) ?? [])].sort(compareBinary)) matchedFiles.add(f)
      allFiles = [...matchedFiles]
    }
  }
  const files = allFiles.slice(0, opts.limit ?? 50)
  const limitDropped = allFiles.length - files.length
  const truncated = limitDropped > 0

  if (files.length === 0) {
    emitErr(formatCommandError(`No indexed files match '${opts.pattern}'`))
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
  /** Present only when the hit's file is gone from disk, as on refs' JSON items. */
  deleted?: true
}

export function runLocate(opts: LocateOptions): number {
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(formatCommandError(`--limit must be a positive number, got: ${opts.limit}`))
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

  const scanOpts: SymbolScanScope = {}

  if (targetFile !== undefined) {
    scanOpts.filePath = resolveSpecPath(targetFile, rootDir)
    healStaleIndex(scanOpts.filePath)
  } else {
    scanOpts.rootDir = rootDir
  }

  const limit = opts.limit ?? 25
  const specLower = targetSpec.toLowerCase()
  // Walked in full rather than fetched as one capped page, for the reason runFind gives above: the name tests below are JS string matches with no SQL equivalent, and a cap ahead of them hides matches that sorted past it behind the near-name fallback. Exact matches are kept ahead of contains matches, and each list stops at `limit` because that is all `shown` can display -- the counts beside them stay exact, so the totals reported below still describe every match in the project rather than the rows held in memory.
  interface LocateScan { exact: FirstRows<SymbolHead>; exactCount: number; partial: FirstRows<SymbolHead>; partialCount: number; names: Set<string>; files: Set<string> }
  const scan = (): LocateScan => {
    const found: LocateScan = { exact: new FirstRows(limit), exactCount: 0, partial: new FirstRows(limit), partialCount: 0, names: new Set(), files: new Set() }
    forEachSymbol(scanOpts, (s: SymbolHead) => {
      found.names.add(s.name)
      found.files.add(s.filePath)
      const nameLower = s.name.toLowerCase()
      if (nameLower === specLower) {
        found.exactCount++
        found.exact.offer(s)
      } else if (nameLower.includes(specLower)) {
        found.partialCount++
        found.partial.offer(s)
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
  let combined = [...found.exact.rows(), ...found.partial.rows()]
  let fuzzyNames: string[] = []
  if (matchCount === 0) {
    fuzzyNames = rankSimilarNames([...found.names], targetSpec)
    if (fuzzyNames.length > 0) {
      // Grouped by name and emitted in ranked order so the closest name's locations come first, matching the order a single pass over every row produced.
      const byName = new Map<string, FirstRows<SymbolHead>>(fuzzyNames.map((n: string) => [n, new FirstRows(limit)]))
      forEachSymbol(scanOpts, (s: SymbolHead) => {
        const bucket = byName.get(s.name)
        if (bucket === undefined) return
        matchCount++
        bucket.offer(s)
      })
      combined = fuzzyNames.flatMap((n: string) => byName.get(n)?.rows() ?? [])
    }
  }

  // Live rows first, as symbol and refs order them: a deleted checkout's rows outlive it for the missing-root grace and can sort ahead of the live copy.
  const shown = sinkGoneRows(combined, (s) => s.filePath).slice(0, limit)

  if (shown.length === 0) {
    emitErr(formatCommandError(`No landmark or symbol located for '${targetSpec}'`))
    return 1
  }

  // A span is only as current as the rows it came from: warn on stderr (both modes) and book the answer, as refs does for its result files.
  warnIfFilesStale(shown.map((s) => s.filePath), 'locate')

  const hits: LocateHit[] = shown.map((s: SymbolHead) => ({
    filePath: toDisplayPath(rootDir, s.filePath),
    name: s.name,
    kind: s.kind,
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
    span: `${s.lineStart}-${s.lineEnd}`,
    ...(fileIsGone(s.filePath) ? { deleted: true as const } : {}),
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
    emit(`${displaySafeText(hit.filePath)}:${hit.span} [${displaySafeText(hit.kind)}] ${displaySafeText(hit.name)}${hit.deleted === true ? `  ${DELETED_TAG}` : ''}`)
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
      emitErr(formatCommandError(`Could not read: ${opts.file}`))
      return 1
    }
    emitErr(formatCommandError(`No sections found in '${opts.file}'`))
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
