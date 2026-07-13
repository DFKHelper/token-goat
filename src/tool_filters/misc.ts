// Miscellaneous compression filter family (Batch K2).
//
// Faithful TypeScript port of the Python bash_compress.py db-client, runner, CSS-preprocessor, system-package, util, and generic catch-all sub-families. Dispatch note: - PlaywrightFilter and CypressFilter are exported individually and must be registered in dispatch.ts BEFORE BunFilter so that `bunx playwright test` and `bunx cypress run` route here rather than to the generic bun handler. - MISC_FILTERS (all other 14 filters) spreads AFTER LANGUAGE_FILTERS. - The five generic catch-alls (DotenvFilter, EnvFilter, JsonArrayFilter, SeverityLogFilter, TailTruncFilter) are at the tail of MISC_FILTERS. - TailTruncFilter MUST be the very last entry: its matches() returns true for every command so it must be a fallback of last resort.

import { ToolFilter } from './base.js'
import { loadConfig } from '../config.js'
import {
  ERROR_SIGNAL_RE,
  capBytes,
  hasHighEntropyToken,
  maybeNote,
  pathName,
  pathStem,
  positionalArgs,
} from './helpers.js'

// ===========================================================================
// PlaywrightFilter
// ===========================================================================

const PW_PASS_RE = /^\s+[✓✔]\s/
const PW_DOWNLOAD_RE = /^\s*(Downloading|Downloaded|Installing)\s+\w|^\s*[\d.]+\s+[KMG]b\s+\[/i

export class PlaywrightFilter extends ToolFilter {
  readonly name = 'playwright'
  override readonly binaries = new Set(['playwright'])

  private static readonly SUBCMDS = new Set(['test', 'show-trace', 'codegen', 'screenshot', 'pdf', 'install'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const base = pathStem(argv[0]!.replace(/\\/g, '/')).toLowerCase()
    if (base === 'playwright') {
      return !argv.slice(1).length || (argv[1] !== undefined && PlaywrightFilter.SUBCMDS.has(argv[1].toLowerCase()))
    }
    if (base === 'npx' || base === 'pnpx' || base === 'bunx') {
      const rest = argv.slice(1).filter((a) => !a.startsWith('-'))
      if (rest.length && pathStem(rest[0]!).toLowerCase() === 'playwright') {
        return !rest.slice(1).length || (rest[1] !== undefined && PlaywrightFilter.SUBCMDS.has(rest[1].toLowerCase()))
      }
    }
    return false
  }

  // Override compress() directly — Playwright does NOT use errorPassthrough; it concatenates stdout+stderr itself (matching Python's behavior).
  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const lines = (stdout + stderr).split('\n')
    const kept: string[] = []
    let suppressed = 0
    for (const line of lines) {
      if (PW_PASS_RE.test(line)) { suppressed++; continue }
      if (PW_DOWNLOAD_RE.test(line)) { suppressed++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, suppressed, `suppressed ${suppressed} passed-test / install-progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const playwrightFilter = new PlaywrightFilter()

// ===========================================================================
// CypressFilter
// ===========================================================================

const CY_SEPARATOR_RE = /^\s*[─=]{30,}\s*$/
const CY_RUN_START_RE = /^\s*\(Run Starting\)\s*$/
const CY_RESULTS_RE = /^\s*\(Results\)\s*$/
const CY_VIDEO_RE = /^\s*\(Video\)\s*$/
const CY_RUN_FINISH_RE = /^\s*\(Run Finished\)\s*$/
const CY_BOX_TOP_RE = /^\s*┌[─]+┐\s*$/
const CY_BOX_BOTTOM_RE = /^\s*└[─]+┘\s*$/
const CY_PASS_TEST_RE = /^\s+[✓✔]\s+\S/

export class CypressFilter extends ToolFilter {
  readonly name = 'cypress'
  override readonly binaries = new Set(['cypress'])

  private static readonly SUBCMDS = new Set(['run', 'open'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const base = pathStem(argv[0]!.replace(/\\/g, '/')).toLowerCase()
    if (base === 'cypress') {
      return !argv.slice(1).length || (argv[1] !== undefined && CypressFilter.SUBCMDS.has(argv[1].toLowerCase()))
    }
    if (base === 'npx' || base === 'pnpx' || base === 'bunx') {
      const rest = argv.slice(1).filter((a) => !a.startsWith('-'))
      if (rest.length && pathStem(rest[0]!).toLowerCase() === 'cypress') {
        return !rest.slice(1).length || (rest[1] !== undefined && CypressFilter.SUBCMDS.has(rest[1].toLowerCase()))
      }
    }
    return false
  }

  // Override compress() directly — Cypress concatenates stdout+stderr itself.
  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const lines = (stdout + stderr).split('\n')
    const kept: string[] = []
    let state: 'NORMAL' | 'PRE_BOX' | 'IN_BOX' | 'IN_VIDEO' | 'IN_SUMMARY' = 'NORMAL'
    let nHeader = 0, nSep = 0, nVideo = 0, nPass = 0

    for (const line of lines) {
      const s = line.replace(/\n$/, '')

      if (state === 'IN_SUMMARY') { kept.push(line); continue }

      if (state === 'IN_VIDEO') {
        if (CY_RUN_FINISH_RE.test(s)) { state = 'IN_SUMMARY'; kept.push(line) }
        else if (s.toLowerCase().includes('error')) { kept.push(line) }
        else { nVideo++ }
        continue
      }

      if (state === 'IN_BOX') {
        if (!s.toLowerCase().includes('error')) {
          nHeader++
          if (CY_BOX_BOTTOM_RE.test(s)) state = 'NORMAL'
        } else {
          kept.push(line)
          if (CY_BOX_BOTTOM_RE.test(s)) state = 'NORMAL'
        }
        continue
      }

      if (state === 'PRE_BOX') {
        if (CY_BOX_TOP_RE.test(s)) {
          if (!s.toLowerCase().includes('error')) { nHeader++ } else { kept.push(line) }
          state = 'IN_BOX'
        } else if (!s) {
          nHeader++
        } else {
          kept.push(line)
          state = 'NORMAL'
        }
        continue
      }

      // NORMAL state
      if (CY_RUN_START_RE.test(s) || CY_RESULTS_RE.test(s)) {
        if (!s.toLowerCase().includes('error')) { nHeader++; state = 'PRE_BOX' }
        else { kept.push(line) }
        continue
      }
      if (CY_VIDEO_RE.test(s)) {
        if (!s.toLowerCase().includes('error')) { nVideo++; state = 'IN_VIDEO' }
        else { kept.push(line) }
        continue
      }
      if (CY_RUN_FINISH_RE.test(s)) { state = 'IN_SUMMARY'; kept.push(line); continue }
      if (CY_SEPARATOR_RE.test(s)) {
        if (!s.toLowerCase().includes('error')) { nSep++ } else { kept.push(line) }
        continue
      }
      if (CY_PASS_TEST_RE.test(s) && !s.toLowerCase().includes('error')) {
        nPass++; continue
      }
      kept.push(line)
    }

    if (state === 'IN_BOX' || state === 'PRE_BOX') {
      kept.push('[token-goat] warning: cypress output truncated inside header box')
    } else if (state === 'IN_VIDEO') {
      kept.push('[token-goat] warning: cypress output truncated inside video section')
    }
    const notes: string[] = []
    maybeNote(notes, nHeader, `suppressed ${nHeader} cypress header/results box lines`)
    maybeNote(notes, nSep, `suppressed ${nSep} separator lines`)
    maybeNote(notes, nVideo, `suppressed ${nVideo} video processing lines`)
    maybeNote(notes, nPass, `suppressed ${nPass} passing test lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const cypressFilter = new CypressFilter()

// ===========================================================================
// PsqlFilter
// ===========================================================================

const PSQL_CONN_ERROR_RE = /^psql:\s+error:/i
const PSQL_TIMING_RE = /^Time:\s+[\d.]+\s+ms/i
const PSQL_CMD_TAG_RE = /^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|CREATE|DROP|ALTER|COPY|DO|GRANT|REVOKE|SET|BEGIN|COMMIT|ROLLBACK)\b/i
const PSQL_NOTICE_RE = /^(NOTICE|WARNING|HINT|DETAIL):/i
const PSQL_ERROR_RE = /^(ERROR|FATAL|PANIC):/i
const PSQL_ROWS_RE = /^\((\d+) rows?\)$/
const PSQL_CREATE_RE = /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE SEQUENCE|CREATE TYPE|CREATE FUNCTION|CREATE VIEW|CREATE TRIGGER|ALTER TABLE|ADD CONSTRAINT)\b/i

function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

export class PsqlFilter extends ToolFilter {
  readonly name = 'psql'
  override readonly binaries = new Set(['psql'])

  private static readonly TABLE_ROW_THRESHOLD = 20
  private static readonly TABLE_KEEP_ROWS = 5

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    return this._compressPsql(merged)
  }

  private _compressPsql(text: string): string {
    const lines = text.split('\n')

    // Check for migration-style output (bulk DDL).
    const createTables = lines.filter((ln) => /^CREATE TABLE\b/i.test(ln)).length
    const createIndexes = lines.filter((ln) => /^CREATE (UNIQUE )?INDEX\b/i.test(ln)).length
    const createFunctions = lines.filter((ln) => /^CREATE FUNCTION\b/i.test(ln)).length
    const createViews = lines.filter((ln) => /^CREATE VIEW\b/i.test(ln)).length
    const createTypes = lines.filter((ln) => /^CREATE TYPE\b/i.test(ln)).length
    const createSequences = lines.filter((ln) => /^CREATE SEQUENCE\b/i.test(ln)).length
    const createTriggers = lines.filter((ln) => /^CREATE TRIGGER\b/i.test(ln)).length
    const alterations = lines.filter((ln) => /^(ALTER TABLE|ADD CONSTRAINT)\b/i.test(ln)).length
    if (createTables >= 3) {
      const nonDdl: string[] = []
      for (const ln of lines) {
        if (PSQL_CREATE_RE.test(ln)) continue
        nonDdl.push(ln)
      }
      const summaryParts = [pluralize(createTables, 'table')]
      if (createIndexes) summaryParts.push(pluralize(createIndexes, 'index', 'indexes'))
      if (createFunctions) summaryParts.push(pluralize(createFunctions, 'function'))
      if (createViews) summaryParts.push(pluralize(createViews, 'view'))
      if (createTypes) summaryParts.push(pluralize(createTypes, 'type'))
      if (createSequences) summaryParts.push(pluralize(createSequences, 'sequence'))
      if (createTriggers) summaryParts.push(pluralize(createTriggers, 'trigger'))
      if (alterations) summaryParts.push(pluralize(alterations, 'alteration'))
      nonDdl.unshift(`[token-goat: Created ${summaryParts.join(', ')}]`)
      return this.finalize(nonDdl)
    }

    // State machine for SELECT table output.
    const kept: string[] = []
    let inTable = false
    let headerLines: string[] = []
    let dataRows: string[] = []
    let afterHeader = false

    const flushTable = (): void => {
      if (!headerLines.length) { inTable = false; return }
      const totalRows = dataRows.length
      kept.push(...headerLines)
      if (totalRows > PsqlFilter.TABLE_ROW_THRESHOLD) {
        kept.push(...dataRows.slice(0, PsqlFilter.TABLE_KEEP_ROWS))
        kept.push(`[token-goat: ${totalRows} rows (showing first ${PsqlFilter.TABLE_KEEP_ROWS})]`)
      } else {
        kept.push(...dataRows)
      }
      inTable = false; headerLines = []; dataRows = []; afterHeader = false
    }

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!
      if (PSQL_CONN_ERROR_RE.test(line) || PSQL_ERROR_RE.test(line) || PSQL_TIMING_RE.test(line) ||
          PSQL_CMD_TAG_RE.test(line) || PSQL_NOTICE_RE.test(line)) {
        if (inTable) flushTable()
        kept.push(line)
        continue
      }
      const stripped = line.trim()
      const isBorder = /^[-+]+$/.test(stripped)
      const rowsM = PSQL_ROWS_RE.exec(stripped)
      if (rowsM) {
        if (inTable) flushTable()
        kept.push(line)
        continue
      }
      if (isBorder) {
        if (!inTable) {
          if (kept.length) {
            // Default (border-1) style: the header text line was already buffered in `kept`
            // and this border is the separator right after it.
            headerLines.push(kept.pop()!)
          } else {
            // \pset border 2 style: this is a leading top border with no header text buffered
            // yet. Peek at the next line -- if it isn't itself a border, it's the header row.
            // Consume it explicitly here so it can't fall through to the generic dataRows
            // bucket below and be misclassified as a data row.
            const next = lines[idx + 1]
            if (next !== undefined && !/^[-+]+$/.test(next.trim())) {
              headerLines.push(line)
              headerLines.push(next)
              idx++
              inTable = true; afterHeader = true
              continue
            }
          }
          headerLines.push(line)
          inTable = true; afterHeader = true
        } else {
          if (afterHeader) { headerLines.push(line); afterHeader = false }
          else { flushTable(); kept.push(line) }
        }
        continue
      }
      if (inTable) dataRows.push(line)
      else kept.push(line)
    }
    if (inTable) flushTable()
    return this.finalize(kept)
  }
}

export const psqlFilter = new PsqlFilter()

// ===========================================================================
// MySQLFilter
// ===========================================================================

const MYSQL_ROWS_IN_SET_RE = /^\d+ rows? in set/i
const MYSQL_ROWS_AFFECTED_RE = /^\d+ rows? affected/i
const MYSQL_WARNING_RE = /^(WARNING|WARN)\b/i
const MYSQL_ERROR_RE = /^(ERROR|FATAL)\b/i
const MYSQLDUMP_TABLE_STRUCT_RE = /^-- Table structure for table\b/i
const MYSQLDUMP_BANNER_RE = /^-- (MySQL dump|Host:|Server version:|Dump completed)/i
const MYSQLDUMP_DATA_RE = /^-- Dumping (data|events|routines|triggers) for\b/i
const MYSQL_TABLE_BORDER_RE = /^\+-+/

export class MySQLFilter extends ToolFilter {
  readonly name = 'mysql'
  override readonly binaries = new Set(['mysql', 'mysqldump'])

  private static readonly TABLE_ROW_THRESHOLD = 20
  private static readonly TABLE_KEEP_ROWS = 5
  private static readonly DUMP_KEEP_TABLES = 3

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const binaryName = argv.length ? pathName(argv[0]!).toLowerCase() : ''
    const merged = this.combineOutput(stdout, stderr)
    return binaryName.includes('mysqldump') ? this._compressDump(merged) : this._compressQuery(merged)
  }

  private _compressQuery(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let phase = 0 // 0=outside, 1=top-border, 2=header-row, 3=data-rows
    let headerLines: string[] = []
    let dataRows: string[] = []

    const flushTable = (): void => {
      kept.push(...headerLines)
      const total = dataRows.length
      if (total > MySQLFilter.TABLE_ROW_THRESHOLD) {
        kept.push(...dataRows.slice(0, MySQLFilter.TABLE_KEEP_ROWS))
        kept.push(`[token-goat: ${total} rows (showing first ${MySQLFilter.TABLE_KEEP_ROWS})]`)
      } else {
        kept.push(...dataRows)
      }
      phase = 0; headerLines = []; dataRows = []
    }

    for (const line of lines) {
      if (MYSQL_ERROR_RE.test(line) || MYSQL_WARNING_RE.test(line) ||
          MYSQL_ROWS_IN_SET_RE.test(line) || MYSQL_ROWS_AFFECTED_RE.test(line)) {
        if (phase > 0) flushTable()
        kept.push(line); continue
      }
      const stripped = line.trim()
      const isBorder = MYSQL_TABLE_BORDER_RE.test(stripped)
      if (isBorder) {
        if (phase === 0) { phase = 1; headerLines.push(line) }
        else if (phase === 1) { headerLines.push(line); phase = 2 }
        else if (phase === 2) { headerLines.push(line); phase = 3 }
        else { flushTable(); kept.push(line) }
        continue
      }
      if (phase === 0) { kept.push(line) }
      else if (phase === 1) { headerLines.push(line); phase = 2 }
      else if (phase === 2) { headerLines.push(line) }
      else { dataRows.push(line) }
    }
    if (phase > 0) flushTable()
    return this.finalize(kept)
  }

  private _compressDump(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let tablesKept = 0, tablesCollapsed = 0
    // Real mysqldump per-table structure is: leading `--` comment lines (including
    // the "-- Table structure for table" line itself), a blank line, THEN the
    // DROP TABLE/CREATE TABLE body, ending with another blank line. `inCreate`
    // spans the whole section; `sawHeaderBlank` tracks whether we've passed the
    // header's blank line and are inside the actual DDL body yet — only a blank
    // line encountered there ends the section.
    let inCreate = false, sawHeaderBlank = false, skipBlock = false

    for (const line of lines) {
      if (MYSQL_ERROR_RE.test(line)) { kept.push(line); continue }
      if (MYSQLDUMP_BANNER_RE.test(line) || MYSQLDUMP_DATA_RE.test(line)) { kept.push(line); continue }
      if (MYSQLDUMP_TABLE_STRUCT_RE.test(line)) {
        if (tablesKept < MySQLFilter.DUMP_KEEP_TABLES) {
          tablesKept++; inCreate = true; sawHeaderBlank = false; skipBlock = false; kept.push(line)
        } else {
          tablesCollapsed++; inCreate = true; sawHeaderBlank = false; skipBlock = true
        }
        continue
      }
      if (inCreate) {
        if (!sawHeaderBlank) {
          // Still inside the leading `--` comment block for this table.
          if (!skipBlock) kept.push(line)
          if (!line.trim()) sawHeaderBlank = true
          continue
        }
        if (!line.trim()) {
          // Blank line after the DDL body: this table's structure block is done.
          inCreate = false
          if (!skipBlock) kept.push(line)
          skipBlock = false
          continue
        }
        if (!skipBlock) kept.push(line)
        continue
      }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, tablesCollapsed, `Dumping ${tablesKept + tablesCollapsed} tables...`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const mySQLFilter = new MySQLFilter()

// ===========================================================================
// Sqlite3Filter
// ===========================================================================

const SQLITE3_ERROR_RE = /^(Error:|Parse error:|Runtime error:)/i
const SQLITE3_SCHEMA_RE = /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE VIEW|CREATE TRIGGER)\b/i

export class Sqlite3Filter extends ToolFilter {
  readonly name = 'sqlite3'
  override readonly binaries = new Set(['sqlite3'])

  private static readonly ROW_THRESHOLD = 20
  private static readonly KEEP_ROWS = 5

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const nonEmpty = lines.filter((ln) => ln.trim())
    const schemaLines = nonEmpty.filter((ln) => SQLITE3_SCHEMA_RE.test(ln))
    if (nonEmpty.length && schemaLines.length / nonEmpty.length >= 0.5) return merged

    const errors = lines.filter((ln) => SQLITE3_ERROR_RE.test(ln))
    const dataLines = lines.filter((ln) => !SQLITE3_ERROR_RE.test(ln))
    const nonEmptyData = dataLines.filter((ln) => ln.trim())
    const kept: string[] = [...errors]

    if (nonEmptyData.length > Sqlite3Filter.ROW_THRESHOLD) {
      kept.push(...nonEmptyData.slice(0, Sqlite3Filter.KEEP_ROWS))
      kept.push(`[token-goat: ${nonEmptyData.length} rows (showing first ${Sqlite3Filter.KEEP_ROWS})]`)
    } else {
      kept.push(...dataLines)
    }
    return this.finalize(kept)
  }
}

export const sqlite3Filter = new Sqlite3Filter()

// ===========================================================================
// RedisCLIFilter
// ===========================================================================

const REDIS_ERROR_RE = /^(\(error\)|ERR |WRONGTYPE |NOAUTH |NOSCRIPT |BUSYKEY |MISCONF )/i
const REDIS_OK_RE = /^OK$/
const REDIS_LIST_ITEM_RE = /^\s*\d+\)\s+/

export class RedisCLIFilter extends ToolFilter {
  readonly name = 'redis-cli'
  override readonly binaries = new Set(['redis-cli'])

  private static readonly LIST_THRESHOLD = 20
  private static readonly LIST_KEEP = 10

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    if (this._isScanOutput(lines)) return this._compressScan(lines)
    const okCount = lines.filter((ln) => REDIS_OK_RE.test(ln.trim())).length
    if (okCount >= 5) return this._compressBulkOk(lines, okCount)
    const listItems = lines.filter((ln) => REDIS_LIST_ITEM_RE.test(ln))
    if (listItems.length > RedisCLIFilter.LIST_THRESHOLD) return this._compressList(lines, listItems)
    return this.finalize(lines)
  }

  private _isScanOutput(lines: string[]): boolean {
    return lines.some((ln) => /^\d+\) \(integer\) \d+/.test(ln))
  }

  private _compressScan(lines: string[]): string {
    const allKeys: string[] = []
    const errors: string[] = []
    for (const line of lines) {
      if (REDIS_ERROR_RE.test(line)) { errors.push(line); continue }
      const m = /^\s*\d+\)\s+"(.+)"/.exec(line)
      if (m) allKeys.push(m[1]!)
    }
    const kept: string[] = [...errors]
    const total = allKeys.length
    if (total > RedisCLIFilter.LIST_KEEP) {
      kept.push(...allKeys.slice(0, RedisCLIFilter.LIST_KEEP).map((k) => `"${k}"`))
      kept.push(`[token-goat: ${total} keys total (showing first ${RedisCLIFilter.LIST_KEEP})]`)
    } else {
      kept.push(...allKeys.map((k) => `"${k}"`))
    }
    return this.finalize(kept)
  }

  private _compressBulkOk(lines: string[], okCount: number): string {
    const kept: string[] = []
    for (const line of lines) {
      if (REDIS_OK_RE.test(line.trim())) continue
      if (REDIS_ERROR_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    kept.push(`[token-goat: ${okCount} OK responses]`)
    return this.finalize(kept)
  }

  private _compressList(lines: string[], listItems: string[]): string {
    const kept: string[] = []
    let itemCount = 0
    const total = listItems.length
    for (const line of lines) {
      if (REDIS_ERROR_RE.test(line)) { kept.push(line); continue }
      if (REDIS_LIST_ITEM_RE.test(line)) {
        if (itemCount < RedisCLIFilter.LIST_KEEP) kept.push(line)
        itemCount++
      } else {
        kept.push(line)
      }
    }
    if (total > RedisCLIFilter.LIST_KEEP) {
      kept.push(`[token-goat: ${total} items (showing first ${RedisCLIFilter.LIST_KEEP})]`)
    }
    return this.finalize(kept)
  }
}

export const redisCLIFilter = new RedisCLIFilter()

// ===========================================================================
// SysPackageFilter
// ===========================================================================

const APT_GET_RE = /^Get:\d+\s+http/i
const APT_FETCHED_RE = /^Fetched\s+\d/
const APT_BOILERPLATE_RE = /^(?:Reading package lists|Building dependency tree|Reading state information|Calculating upgrade|Correcting dependencies|Hit:\d+\s)/
const APT_INSTALL_PROGRESS_RE = /^(?:Unpacking |Setting up |Preparing to unpack |Selecting previously unselected)/
const APT_TRIGGERS_RE = /^Processing triggers for /i
const APT_PKG_LIST_HDR_RE = /^The following (?:NEW|extra|additional) packages|^The following packages will be (?:upgraded|removed|installed|REMOVED)|^NEW packages the following|^\d+ upgraded,\s+\d+ newly installed/i
const APK_FETCH_RE = /^fetch\s+http/i
const APK_INSTALLING_RE = /^\(\s*\d+\/\d+\)\s+(?:Installing|Upgrading|Purging|Reinstalling)\s+\S/i
const APK_OK_RE = /^OK:\s+\d+/i
const BREW_PROGRESS_RE = /^==> (?:Downloading|Fetching|Installing|Pouring|Tapping|Untapping|Auto-updated|Updating|Cloning)/i
const BREW_ALREADY_RE = /already installed/i
const BREW_SUMMARY_RE = /^Warning:|^Error:|^==> Summary|^🍺|^\s*[\w-]+\s+\d+\.\d/i

export class SysPackageFilter extends ToolFilter {
  readonly name = 'sys-pkg'
  override readonly binaries = new Set(['apt-get', 'apt', 'apt-cache', 'apk', 'brew'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const binary = argv.length ? pathStem(argv[0]!).toLowerCase() : 'apt-get'
    if (binary === 'apt-get' || binary === 'apt' || binary === 'apt-cache') return this._compressApt(stdout, stderr)
    if (binary === 'apk') return this._compressApk(stdout, stderr)
    return this._compressBrew(stdout, stderr)
  }

  private _compressApt(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let dlCount = 0, installProgress = 0, triggerCount = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (APT_GET_RE.test(line)) { dlCount++; continue }
      if (APT_BOILERPLATE_RE.test(line)) { kept.push(line); continue }
      if (APT_PKG_LIST_HDR_RE.test(line)) { kept.push(line); continue }
      if (APT_FETCHED_RE.test(line)) { kept.push(line); continue }
      if (APT_INSTALL_PROGRESS_RE.test(line)) { installProgress++; continue }
      if (APT_TRIGGERS_RE.test(line)) { triggerCount++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, dlCount, `collapsed ${dlCount} 'Get:N' download lines`)
    maybeNote(notes, installProgress, `collapsed ${installProgress} 'Unpacking/Setting up' lines`)
    maybeNote(notes, triggerCount, `collapsed ${triggerCount} 'Processing triggers' lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressApk(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let fetchCount = 0, installCount = 0
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (APK_OK_RE.test(line)) { kept.push(line); continue }
      if (APK_FETCH_RE.test(line)) { fetchCount++; continue }
      if (APK_INSTALLING_RE.test(line)) { installCount++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, fetchCount, `collapsed ${fetchCount} 'fetch' download lines`)
    maybeNote(notes, installCount, `collapsed ${installCount} 'Installing' progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressBrew(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const progressSample: string[] = []
    let progressExtra = 0
    const SAMPLE = 3
    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || BREW_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (BREW_ALREADY_RE.test(line)) { kept.push(line); continue }
      if (BREW_PROGRESS_RE.test(line)) {
        if (progressSample.length < SAMPLE) progressSample.push(line)
        else progressExtra++
        continue
      }
      kept.push(line)
    }
    const out: string[] = [...progressSample]
    if (progressExtra) out.push(`[token-goat: +${progressExtra} more brew progress lines collapsed]`)
    out.push(...kept)
    return this.finalize(out)
  }
}

export const sysPackageFilter = new SysPackageFilter()

// ===========================================================================
// ProtocFilter
// ===========================================================================

const PROTOC_INFO_RE = /^\[libprotobuf INFO /
const PROTOC_LIB_WARN_RE = /^\[libprotobuf (?:WARNING|ERROR) /
const PROTOC_DIAG_RE = /^[^\s:][^:]*\.proto:\d+:\d+: (?:warning|error):/i
const PROTOC_NOT_FOUND_RE = /^[^\s:][^:]*\.proto: File not found\./
const PROTOC_SUMMARY_RE = /^\d+ (?:errors?|warnings?) generated\./i

export class ProtocFilter extends ToolFilter {
  readonly name = 'protoc'
  override readonly binaries = new Set(['protoc', 'protoc-gen-go', 'protoc-gen-grpc', 'buf'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedInfo = 0
    const warnSeen = new Map<string, number>()
    let dedupedWarns = 0

    for (const line of lines) {
      if (PROTOC_INFO_RE.test(line)) { droppedInfo++; continue }
      if (PROTOC_LIB_WARN_RE.test(line) || PROTOC_DIAG_RE.test(line) || PROTOC_NOT_FOUND_RE.test(line)) {
        const key = line.trim()
        const count = (warnSeen.get(key) ?? 0) + 1
        warnSeen.set(key, count)
        if (count === 1) kept.push(line)
        else dedupedWarns++
        continue
      }
      if (PROTOC_SUMMARY_RE.test(line) || ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, droppedInfo, `dropped ${droppedInfo} [libprotobuf INFO] lines`)
    maybeNote(notes, dedupedWarns, `collapsed ${dedupedWarns} repeated warning lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const protocFilter = new ProtocFilter()

// ===========================================================================
// SassFilter
// ===========================================================================

const SASS_RENDERING_RE = /^\s*Rendering Complete|^\s*Wrote CSS to\b|^\s*Compiled\s+\S+\s+to\s+\S+|^\s*\S+\.(?:scss|sass|less)\s*→\s*\S+\.css/i
const SASS_WRITE_RE = /^\s+(?:write|wrote|output|compiled|created|Compiled)\s+\S+\.css/i
const SASS_MAP_WRITE_RE = /^\s+(?:write|wrote)\s+\S+\.(?:css\.map|map)\s*$/i
const SASS_DEPRECATION_RE = /^\s*(?:Deprecation\s+Warning|DEPRECATION\s+WARNING|DeprecationWarning)\b/i
const SASS_ERROR_RE = /^\s*(?:Error:|on\s+line\s+\d+\s+of\b)/i
const SASS_SUMMARY_RE = /^\s*(?:Compilation\s+(?:complete|failed)|sass\s+\d+\.\d+|\d+\s+file[s]?\s+(?:compiled|written|processed)|Finished\s+'sass'|Done\s+compiling\s+sass|No\s+changes,?\s+done|done\s+in\s+[\d.]+)/i
const LESS_ERROR_RE = /^\s*(?:ParseError|NameError|FileError):\s/i

export class SassFilter extends ToolFilter {
  readonly name = 'sass'
  override readonly binaries = new Set(['sass', 'scss', 'lessc', 'node-sass'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    const name = pathName(argv[0]!).toLowerCase()
    return this.binaries.has(stem) || this.binaries.has(name)
  }

  private static readonly WRITE_SAMPLE = 5
  private static readonly KEEP_PER_DEPRECATION = 2

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const writeSample: string[] = []
    let writeExtra = 0, droppedMap = 0, collapsedDeprecations = 0
    const dedupDeprecations = new Map<string, number>()

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || SASS_ERROR_RE.test(line) || LESS_ERROR_RE.test(line)) {
        kept.push(line); continue
      }
      if (SASS_SUMMARY_RE.test(line) || SASS_RENDERING_RE.test(line)) { kept.push(line); continue }
      if (SASS_MAP_WRITE_RE.test(line)) { droppedMap++; continue }
      if (SASS_DEPRECATION_RE.test(line)) {
        const key = line.trim().slice(0, 60)
        const cnt = (dedupDeprecations.get(key) ?? 0) + 1
        dedupDeprecations.set(key, cnt)
        if (cnt <= SassFilter.KEEP_PER_DEPRECATION) kept.push(line)
        else collapsedDeprecations++
        continue
      }
      if (SASS_WRITE_RE.test(line)) {
        if (writeSample.length < SassFilter.WRITE_SAMPLE) writeSample.push(line)
        else writeExtra++
        continue
      }
      kept.push(line)
    }

    const out: string[] = [...writeSample]
    if (writeExtra) out.push(`[token-goat: +${writeExtra} more compiled CSS files; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
    out.push(...kept)
    const notes: string[] = []
    maybeNote(notes, droppedMap, `dropped ${droppedMap} source-map write lines`)
    maybeNote(notes, collapsedDeprecations, `collapsed ${collapsedDeprecations} duplicate deprecation warnings`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const sassFilter = new SassFilter()

// ===========================================================================
// ToxFilter
// ===========================================================================

const TOX_ENV_CREATE_RE = /^\s*(?:\S+:\s+create(?:virtualenv)?|\S+:\s+install(?:pkg|_deps|_package)?\s*$|\.pkg\s+(?:create|install|build-wheel|_check_passed))/i
const TOX_SESSION_HEADER_RE = /^\s*(?:tox\s+run\b|ROOT:|default\s+environments:|configured\s+environments:|additional\s+environments:|run-test(?:-pre)?:\s|GLOB\s+sdist\s*[-–])/i
const TOX_PASSED_RE = /^\s*(?:\S+:\s+)?commands\s+succeeded\s*$/i
const TOX_FAILED_RE = /^\s*(?:\S+:\s+)?commands\s+failed\s*$|^\s*ERROR:\s+/i
const TOX_FINAL_SUMMARY_RE = /^\s*(?:congratulations\s*[:)]+|\d+\s+(?:passed|failed|error).*in\s+[\d.]+s|(?:all\s+)?\d+\s+test[s]?\s+(?:passed|failed)|={3,}\s+\d+\s+(?:passed|failed))/i
const TOX_ENV_RESULT_RE = /^\s*(?:\S+\s+)+(?:OK|FAIL(?:ED)?|PASSED|skipped)\s*(?:\(\d+[\d.]*s\))?\s*$/i
const TOX_PKG_INSTALL_RE = /^\s*\.pkg:\s+(?:inst|install|build-wheel|wheel-editable|_check_passed)\b/i
const TOX_RUN_LABEL_RE = /^\s*\S+:\s+(?:run-test-pre|run-test|create|recreate|inst(?:all(?:pkg|deps)?)?)\s*$/i
const TOX_ENV_HEADER_RE = /^\s*\S+\s+(?:run-test(?:-pre)?|recreate|install(?:pkg|deps)?):\s+/
const TOX_PIP_PROGRESS_RE = /^\s*(?:Collecting\s|Downloading\s|Using\s+cached\s|Installing\s+collected\s+packages|Building\s+wheel\s+for|Created\s+wheel\s+for|Preparing\s+metadata|Obtaining\s+file:\/\/|Getting\s+requirements\s+to\s+build)/
const TOX_PIP_BAR_RE = /^\s*━+\s+[\d.]+\/[\d.]/
const TOX_REQ_SATISFIED_RE = /^\s*Requirement\s+already\s+satisfied:/
const TOX_SEPARATOR_RE = /^\s*━{5,}\s+\S+\s+━{5,}\s*$/
const TOX_STILL_RUNNING_RE = /^\s*\S+:\s+still\s+running\b/i

export class ToxFilter extends ToolFilter {
  readonly name = 'tox'
  override readonly binaries = new Set(['tox'])
  override readonly errorPassthrough = true

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let droppedCreate = 0, droppedPip = 0, droppedReqSatisfied = 0, droppedSeparators = 0, droppedPolling = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || TOX_FAILED_RE.test(line)) { kept.push(line); continue }
      if (TOX_SESSION_HEADER_RE.test(line) || TOX_FINAL_SUMMARY_RE.test(line) ||
          TOX_ENV_RESULT_RE.test(line) || TOX_PASSED_RE.test(line)) { kept.push(line); continue }
      if (TOX_ENV_HEADER_RE.test(line)) { kept.push(line); continue }
      if (TOX_ENV_CREATE_RE.test(line) || TOX_PKG_INSTALL_RE.test(line) || TOX_RUN_LABEL_RE.test(line)) {
        droppedCreate++; continue
      }
      if (TOX_PIP_PROGRESS_RE.test(line) || TOX_PIP_BAR_RE.test(line)) { droppedPip++; continue }
      if (TOX_REQ_SATISFIED_RE.test(line)) { droppedReqSatisfied++; continue }
      if (TOX_SEPARATOR_RE.test(line)) { droppedSeparators++; continue }
      if (TOX_STILL_RUNNING_RE.test(line)) { droppedPolling++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    if (droppedCreate) notes.push(`collapsed ${droppedCreate} tox env-create/install progress lines`)
    maybeNote(notes, droppedPip, `collapsed ${droppedPip} pip install progress lines`)
    maybeNote(notes, droppedReqSatisfied, `collapsed ${droppedReqSatisfied} 'Requirement already satisfied' lines`)
    maybeNote(notes, droppedSeparators, `dropped ${droppedSeparators} tox separator lines`)
    maybeNote(notes, droppedPolling, `dropped ${droppedPolling} tox parallel-runner polling lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const toxFilter = new ToxFilter()

// ===========================================================================
// NoxFilter
// ===========================================================================

const NOX_CREATE_VENV_RE = /^nox\s+>\s+Creating\s+virtual\s+environment\b/i
const NOX_REUSE_VENV_RE = /^nox\s+>\s+Re-?using\s+existing\s+virtual\s+environment\b/i
const NOX_REQ_SATISFIED_RE = /^Requirement already satisfied:/
const NOX_PIP_PROGRESS_RE = /^\s*(?:Collecting\s|Downloading\s|Using\s+cached\s|Installing\s+collected\s+packages|Building\s+wheel\s+for|Created\s+wheel\s+for|Preparing\s+metadata|Obtaining\s+file:\/\/|Getting\s+requirements\s+to\s+build)/i
const NOX_PIP_BAR_RE = /^\s*━+\s+[\d.]/

export class NoxFilter extends ToolFilter {
  readonly name = 'nox'
  override readonly binaries = new Set(['nox'])
  override readonly errorPassthrough = true

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let envNoise = 0, pipNoise = 0, reqSatisfied = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (NOX_CREATE_VENV_RE.test(line) || NOX_REUSE_VENV_RE.test(line)) { envNoise++; continue }
      if (NOX_PIP_PROGRESS_RE.test(line)) { pipNoise++; continue }
      if (NOX_PIP_BAR_RE.test(line)) { pipNoise++; continue }
      if (NOX_REQ_SATISFIED_RE.test(line)) { reqSatisfied++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, envNoise, `collapsed ${envNoise} nox env-create/reuse lines`)
    maybeNote(notes, pipNoise, `collapsed ${pipNoise} pip install progress lines`)
    maybeNote(notes, reqSatisfied, `collapsed ${reqSatisfied} 'Requirement already satisfied' lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const noxFilter = new NoxFilter()

// ===========================================================================
// WasmPackFilter
// ===========================================================================

const WASMPACK_INFO_RE = /^\s*\[INFO\]:\s+/i
const WASMPACK_DONE_RE = /(?:✨\s+Done|Your\s+wasm\s+pkg\s+is\s+ready|wasm-pack\s+\S+\s+succeeded|Successfully\s+ran)/i
const WASMPACK_WARN_RE = /^\s*\[WARN\]:\s+/i
const WASMPACK_CARGO_COMPILING_RE = /^\s+(?:Compiling|Downloading|Fetching|Unpacking|Checking)\s+\S+\s+v\d+\./i
const WASMPACK_CARGO_FINISHED_RE = /^\s+Finished\s+/i
const WASMPACK_TEST_SUMMARY_RE = /^\s*(?:running\s+\d+\s+test|test\s+result:\s+(?:ok|FAILED))/i

export class WasmPackFilter extends ToolFilter {
  readonly name = 'wasm-pack'
  override readonly binaries = new Set(['wasm-pack'])
  override readonly errorPassthrough = true

  override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let droppedInfo = 0, droppedCompiling = 0

    for (const line of lines) {
      // WASMPACK_DONE_RE uses search (not match) since done message may be inside [INFO]: :-)
      if (ERROR_SIGNAL_RE.test(line) || WASMPACK_WARN_RE.test(line) ||
          WASMPACK_DONE_RE.test(line) || WASMPACK_TEST_SUMMARY_RE.test(line) ||
          WASMPACK_CARGO_FINISHED_RE.test(line)) { kept.push(line); continue }
      // INFO lines come AFTER done check to preserve [INFO]: :-) Your wasm pkg is ready
      if (WASMPACK_INFO_RE.test(line)) { droppedInfo++; continue }
      if (WASMPACK_CARGO_COMPILING_RE.test(line)) { droppedCompiling++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedInfo, `dropped ${droppedInfo} [INFO] step announcement lines`)
    maybeNote(notes, droppedCompiling, `dropped ${droppedCompiling} Cargo dependency compile lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const wasmPackFilter = new WasmPackFilter()

// ===========================================================================
// NgFilter
// ===========================================================================

const NG_WEBPACK_CHUNK_RE = /^chunk \{\d+\} /
const NG_CHUNK_ROW_RE = /^\S+\.(?:js|css|mjs)\s+\|/
const NG_TABLE_HEADER_RE = /^(?:Initial [Cc]hunk [Ff]iles|Lazy [Cc]hunk [Ff]iles)\s+\|/i
const NG_BUILD_AT_RE = /^(?:Build at:|Date:)\s/
const NG_BUNDLE_COMPLETE_RE = /(?:Browser application bundle|Application bundle) generation complete/i
const NG_BUILD_PROGRESS_RE = /^- (?:Generating|Building)\s|^Building\.\.\.\s*$|^Generating browser application bundles/
const NG_BUDGET_WARN_RE = /budget\s+exceeded|exceeded\s+(?:maximum\s+)?budget|Warning:\s+budget/i
const NG_KARMA_LOG_RE = /^\d{2} \d{2} \d{4} \d{2}:\d{2}:\d{2}[.:]\d{3}:(?:INFO|DEBUG|WARN)\s|^(?:INFO|WARN)\s+\[(?:karma|launcher|karma-server|Chrome|Firefox|Safari)/i
const NG_KARMA_RESULT_RE = /(?:Chrome|Firefox|Safari|HeadlessChrome|ChromeHeadless)\s.*Executed\s+\d+\s+of\s+\d+/i
const NG_KARMA_TOTAL_RE = /^TOTAL:\s+\d+\s+(?:SUCCESS|FAILED)/i
const NG_TABLE_KEEP_EACH = 3

export class NgFilter extends ToolFilter {
  readonly name = 'ng'
  override readonly binaries = new Set(['ng'])
  override readonly errorPassthrough = true

  override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const positionals = positionalArgs(argv.slice(1))
    const subcommand = positionals.length ? positionals[0]!.toLowerCase() : ''
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    if (subcommand === 'test') return this._compressTest(lines)
    if (subcommand === 'build' || subcommand === 'serve' || subcommand === '') return this._compressBuild(lines)
    return capBytes(combined, 8192)
  }

  private _compressBuild(lines: string[]): string {
    const kept: string[] = []
    let tableRows: string[] = []
    let inTable = false
    let webpackRun: string[] = []
    let droppedProgress = 0

    const flushRows = (rows: string[], label: string): void => {
      const n = NG_TABLE_KEEP_EACH
      if (rows.length <= n * 2) { kept.push(...rows) }
      else {
        kept.push(...rows.slice(0, n))
        const midCount = rows.length - n * 2
        kept.push(`[token-goat: collapsed ${midCount} ${label}]`)
        kept.push(...rows.slice(-n))
      }
    }

    for (const line of lines) {
      if (webpackRun.length && !NG_WEBPACK_CHUNK_RE.test(line)) { flushRows(webpackRun, 'webpack chunk lines'); webpackRun = [] }
      if (inTable && !NG_CHUNK_ROW_RE.test(line)) { flushRows(tableRows, 'chunk table rows'); tableRows = []; inTable = false }
      if (NG_BUDGET_WARN_RE.test(line)) { kept.push(line); continue }
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (NG_BUILD_AT_RE.test(line) || NG_BUNDLE_COMPLETE_RE.test(line)) { kept.push(line); continue }
      if (NG_TABLE_HEADER_RE.test(line)) { kept.push(line); inTable = true; tableRows = []; continue }
      if (inTable && NG_CHUNK_ROW_RE.test(line)) { tableRows.push(line); continue }
      if (NG_WEBPACK_CHUNK_RE.test(line)) { webpackRun.push(line); continue }
      if (NG_BUILD_PROGRESS_RE.test(line)) { droppedProgress++; continue }
      kept.push(line)
    }
    if (webpackRun.length) flushRows(webpackRun, 'webpack chunk lines')
    if (inTable && tableRows.length) flushRows(tableRows, 'chunk table rows')

    const notes: string[] = []
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} build progress lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressTest(lines: string[]): string {
    const kept: string[] = []
    let droppedKarma = 0
    for (const line of lines) {
      if (NG_KARMA_RESULT_RE.test(line) || NG_KARMA_TOTAL_RE.test(line)) { kept.push(line); continue }
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (NG_BUNDLE_COMPLETE_RE.test(line)) { kept.push(line); continue }
      if (NG_KARMA_LOG_RE.test(line)) { droppedKarma++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, droppedKarma, `dropped ${droppedKarma} Karma log lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const ngFilter = new NgFilter()

// ===========================================================================
// DotenvFilter
// ===========================================================================

const DOTENV_PARSE_WARN_RE = /python-dotenv|could not parse|failed to parse|parse error/i
const DOTENV_EXPORT_COUNT_RE = /\b(?:Exported|Loaded|loaded)\s+(\d+)\s+var(?:iable)?s?\b/i
const DOTENV_SKIPPED_RE = /\bSkipped\s+\d+\s+var(?:iable)?s?\b/i
const DOTENV_PLAIN_LOAD_RE = /(?:^|\s)\[dotenv\]\s+Load|(?:Loading|Loaded)\b[^\n]*\.env|\.env environment variables/i

function isDotenvBanner(line: string): boolean {
  if (DOTENV_PARSE_WARN_RE.test(line) || ERROR_SIGNAL_RE.test(line)) return false
  return DOTENV_EXPORT_COUNT_RE.test(line) || DOTENV_SKIPPED_RE.test(line) || DOTENV_PLAIN_LOAD_RE.test(line)
}

export class DotenvFilter extends ToolFilter {
  readonly name = 'dotenv'
  override readonly binaries = new Set(['dotenv'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const bannerIdx = new Set<number>()
    for (let i = 0; i < lines.length; i++) if (isDotenvBanner(lines[i]!)) bannerIdx.add(i)
    if (bannerIdx.size < 2) return this.finalize(lines)

    const kept: string[] = []
    let loadedTotal = 0
    let insertPos: number | null = null
    for (let i = 0; i < lines.length; i++) {
      if (bannerIdx.has(i)) {
        if (insertPos === null) insertPos = kept.length
        const m = DOTENV_EXPORT_COUNT_RE.exec(lines[i]!)
        if (m) loadedTotal += parseInt(m[1]!, 10)
        continue
      }
      kept.push(lines[i]!)
    }
    const summary = loadedTotal ? `[dotenv] loaded ${loadedTotal} vars` : '[dotenv] loaded .env'
    kept.splice(insertPos ?? 0, 0, summary)
    return this.finalize(kept)
  }
}

export const dotenvFilter = new DotenvFilter()

// ===========================================================================
// EnvFilter
// ===========================================================================

const ENV_KEEP_VARS = new Set([
  'PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV', 'CONDA_PREFIX',
  'NODE_ENV', 'NODE_VERSION', 'NODE_PATH',
  'GOPATH', 'GOROOT', 'GOBIN',
  'JAVA_HOME', 'JAVA_OPTS',
  'CARGO_HOME', 'RUSTUP_HOME', 'RUST_LOG',
  'GEM_HOME', 'BUNDLE_PATH',
  'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD',
  'TERM', 'LANG', 'LC_ALL', 'TZ',
  'VIRTUAL_ENV_PROMPT',
  'npm_config_prefix', 'npm_config_cache',
])
const ENV_KEEP_PREFIXES = [
  'CLAUDE_', 'TOKEN_GOAT_', 'CI_', 'GITHUB_', 'GITLAB_', 'CIRCLECI_',
  'AWS_', 'GCP_', 'AZURE_', 'GOOGLE_',
  'PYTHON', 'UV_', 'PIP_',
  'CONDA_', 'NPM_', 'PNPM_', 'YARN_',
  'DOCKER_', 'KUBECONFIG', 'KUBE_',
  'TF_', 'PULUMI_',
  'JAVA_', 'MAVEN_', 'GRADLE_',
  'CARGO_', 'RUSTUP_', 'RUST_',
]
const ENV_PASSTHROUGH_THRESHOLD = 20
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)/

export class EnvFilter extends ToolFilter {
  readonly name = 'env'
  override readonly binaries = new Set(['env', 'printenv'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const totalVars = lines.filter((ln) => ENV_LINE_RE.test(ln)).length
    if (totalVars <= ENV_PASSTHROUGH_THRESHOLD) return merged

    const kept: string[] = []
    let suppressed = 0
    for (const line of lines) {
      const m = ENV_LINE_RE.exec(line)
      if (!m) { kept.push(line); continue }
      const varName = m[1]!
      if (ENV_KEEP_VARS.has(varName) || ENV_KEEP_PREFIXES.some((p) => varName.startsWith(p))) {
        kept.push(line)
      } else {
        suppressed++
      }
    }
    if (suppressed) {
      kept.push(`[token-goat: ${suppressed} env vars suppressed (${totalVars} total) — run \`env | grep NAME\` to inspect]`)
    }
    return this.finalize(kept)
  }
}

export const envFilter = new EnvFilter()

// ===========================================================================
// JsonArrayFilter
// ===========================================================================

const JSON_ARRAY_MAX_ITEMS = 50

// Canonical JSON serialization (object keys sorted recursively) so dedup compares actual
// VALUE content rather than being sensitive to key ordering.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export class JsonArrayFilter extends ToolFilter {
  readonly name = 'json_array'
  override readonly binaries = new Set(['json'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    return this.binaries.has(pathStem(argv[0]!).toLowerCase())
  }

  override detectFromCommand(_cmd: string): boolean {
    return false // content-based only
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const text = stdout.trim() ? stdout : stdout + stderr
    const stripped = text.trim()
    if (!(stripped.startsWith('[') && stripped.endsWith(']'))) return text
    let data: unknown[]
    try {
      const parsed = JSON.parse(stripped)
      if (!Array.isArray(parsed)) return text
      data = parsed
    } catch {
      return text
    }

    // Value-based deduplication (dicts only) — dedup on actual content, not just which
    // fields are present, so that homogeneous arrays of distinct records (the common case)
    // are not mistaken for duplicates.
    const seen = new Map<string, number>() // value→first-index
    const kept: unknown[] = []
    const dupCounts = new Map<string, number>() // key-signature→count, for the summary label
    for (const item of data) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const valueKey = stableStringify(item)
        const ks = Object.keys(item as Record<string, unknown>).sort().join(',')
        const preserve = Object.values(item as Record<string, unknown>).some(
          (v) => typeof v === 'string' && hasHighEntropyToken(v),
        )
        if (seen.has(valueKey) && !preserve) {
          dupCounts.set(ks, (dupCounts.get(ks) ?? 0) + 1)
        } else {
          if (!seen.has(valueKey)) seen.set(valueKey, kept.length)
          kept.push(item)
        }
      } else {
        kept.push(item)
      }
    }
    let changed = dupCounts.size > 0

    const suffixLines: string[] = []
    if (dupCounts.size) {
      for (const [ks, n] of dupCounts) {
        const keysRepr = ks.split(',').join(', ')
        suffixLines.push(`[... ${n} duplicate objects with keys {${keysRepr}} omitted]`)
      }
    }
    if (kept.length > JSON_ARRAY_MAX_ITEMS) {
      const extra = kept.length - JSON_ARRAY_MAX_ITEMS
      kept.splice(JSON_ARRAY_MAX_ITEMS)
      suffixLines.push(`[... ${extra} more items not shown]`)
      changed = true
    }
    if (!changed) return text
    return [JSON.stringify(kept, null, 2), ...suffixLines].join('\n')
  }
}

export const jsonArrayFilter = new JsonArrayFilter()

// ===========================================================================
// SeverityLogFilter
// ===========================================================================

const LOG_LEVEL_RE = /\b(ERROR|FAIL(?:URE|ED)?|CRITICAL|EXCEPTION|FATAL)\b|\[ERROR\]|\[CRITICAL\]|\[FATAL\]|level=(?:error|critical|fatal)/i
const LOG_WARN_RE = /\b(WARN(?:ING)?)\b|\[WARN(?:ING)?\]|level=warn/i
const LOG_INFO_RE = /\b(INFO)\b|\[INFO\]|level=info/i
const LOG_DEBUG_RE = /\b(DEBUG|TRACE|VERBOSE)\b|\[DEBUG\]|\[TRACE\]|level=(?:debug|trace)/i
const LOG_ANY_RE = /\b(?:ERROR|FAIL(?:URE|ED)?|CRITICAL|EXCEPTION|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|VERBOSE)\b|\[(?:ERROR|CRITICAL|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\]|level=(?:error|critical|fatal|warn|info|debug|trace)/i
const TRACE_CONTINUATION_RE = /^\s+(?:at |File "|in |\w+Error:|\w+Exception:)|^\s+\w+[\w.]+\(.*\)$|^\s+\.{3}\s*\d+\s+more|^Caused by:|^During handling of the above exception/

function scoreLogLine(line: string): number {
  if (LOG_LEVEL_RE.test(line)) return 1.0
  if (LOG_WARN_RE.test(line)) return 0.5
  if (LOG_INFO_RE.test(line)) return 0.1
  if (LOG_DEBUG_RE.test(line)) return 0.0
  return 0.0
}

function compressSeverityLog(text: string, contextN: number, threshold: number): string {
  const lines = text.split('\n')
  const n = lines.length
  const scores = lines.map(scoreLogLine)
  const primary = new Set<number>()
  let inTrace = false
  for (let i = 0; i < n; i++) {
    const ln = lines[i]!
    const score = scores[i]!
    if (inTrace) {
      if (!ln.trim()) { inTrace = false }
      else if (TRACE_CONTINUATION_RE.test(ln)) { primary.add(i) }
      else {
        inTrace = false
        if (score >= threshold) { primary.add(i); if (score >= 1.0) inTrace = true }
      }
    } else {
      if (score >= threshold) { primary.add(i); if (score >= 1.0) inTrace = true }
    }
  }
  // Expand by contextN around each primary line
  const expanded = new Set<number>()
  for (const idx of primary) {
    for (let j = Math.max(0, idx - contextN); j < Math.min(n, idx + contextN + 1); j++) {
      expanded.add(j)
    }
  }
  const result: string[] = []
  let suppressed = 0
  for (let i = 0; i < n; i++) {
    if (expanded.has(i)) {
      if (suppressed > 0) { result.push(`[suppressed ${suppressed} lines]`); suppressed = 0 }
      result.push(lines[i]!)
    } else {
      suppressed++
    }
  }
  if (suppressed > 0) result.push(`[suppressed ${suppressed} lines]`)
  return result.join('\n')
}

export class SeverityLogFilter extends ToolFilter {
  readonly name = 'severity_log'
  override readonly binaries: ReadonlySet<string> = new Set()

  /** True when stdout looks like a structured log stream (≥5 lines, ≥30% with log keywords). */
  static detect(stdout: string): boolean {
    const lines = stdout.split('\n')
    if (lines.length < 5) return false
    const keywordCount = lines.filter((ln) => LOG_ANY_RE.test(ln)).length
    return keywordCount / lines.length >= 0.3
  }

  override detectFromCommand(_cmd: string): boolean { return false }
  override matches(_argv: string[]): boolean { return false }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    if (!SeverityLogFilter.detect(combined)) return combined
    // Config: [bash_severity_log] context_lines (default 3), score_threshold
    // (default 0.5, WARN and above). Falls back to those defaults on config
    // load failure so severity-log compression never hard-fails.
    let contextLines = 3
    let scoreThreshold = 0.5
    try {
      const sl = loadConfig().bash_severity_log
      contextLines = sl.context_lines
      scoreThreshold = sl.score_threshold
    } catch {
      // use defaults above
    }
    return compressSeverityLog(combined, contextLines, scoreThreshold)
  }
}

export const severityLogFilter = new SeverityLogFilter()

// ===========================================================================
// TailTruncFilter — MUST BE LAST in MISC_FILTERS
// ===========================================================================

export class TailTruncFilter extends ToolFilter {
  readonly name = 'tail-trunc'
  override readonly binaries: ReadonlySet<string> = new Set()

  // Returns false: like SeverityLogFilter, this is content-based and applied explicitly (via filterByName or post-execution paths), not auto-matched by command. In Python's post-execution model matches()=true is fine; in TS the pre-bash hook rewrites commands before they run, making a catch-all prohibitively expensive for trivial commands (echo, ls, head, etc.).
  override matches(_argv: string[]): boolean { return false }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    if (lines.length <= 500) return merged
    const suppressed = lines.length - 100
    const marker = `[... ${suppressed} lines suppressed — use TOKEN_GOAT_BASH_COMPRESS=0 to disable ...]`
    return [...lines.slice(0, 50), marker, ...lines.slice(-50)].join('\n')
  }
}

export const tailTruncFilter = new TailTruncFilter()

// ===========================================================================
// MISC_FILTERS registry
// ===========================================================================
// NOTE: PlaywrightFilter and CypressFilter are NOT in this array — they are registered individually in dispatch.ts BEFORE BunFilter. TailTruncFilter is LAST: its matches() returns true for every command.
export const MISC_FILTERS: ToolFilter[] = [
  psqlFilter,
  mySQLFilter,
  sqlite3Filter,
  redisCLIFilter,
  sysPackageFilter,
  protocFilter,
  sassFilter,
  toxFilter,
  noxFilter,
  wasmPackFilter,
  ngFilter,
  dotenvFilter,
  envFilter,
  jsonArrayFilter,
  severityLogFilter,
  tailTruncFilter, // MUST BE LAST
]
