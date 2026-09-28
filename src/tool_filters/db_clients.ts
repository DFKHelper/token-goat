// Database-client compression filters (batch K2): psql, mysql and mysqldump, sqlite3, and redis-cli, a faithful port of the Python bash_compress.py db-client sub-family. misc.ts imports the four instances and keeps them at the head of MISC_FILTERS, so dispatch order is unchanged.

import { ToolFilter } from './base.js'
import type { CompressContext } from './base.js'
import { maybeNote, pathName } from './helpers.js'

// =========================================================================== PsqlFilter ===========================================================================

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
    // True only when the line most recently pushed into `kept` is a genuine header-text candidate immediately adjacent to this iteration -- i.e. it fell through the generic fallback branch at the bottom of this loop, not a NOTICE/ERROR/rows/border line. Gates the border-1 pop-from-`kept` branch below: `kept.length` alone is not adjacency -- it also stays truthy after any earlier NOTICE/blank line, which used to make a leading \pset border 2 top border wrongly pop that unrelated earlier line as the header.
    let lastLineWasPlainCandidate = false

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
        lastLineWasPlainCandidate = false
        continue
      }
      const stripped = line.trim()
      const isBorder = /^[-+]+$/.test(stripped)
      const rowsM = PSQL_ROWS_RE.exec(stripped)
      if (rowsM) {
        if (inTable) flushTable()
        kept.push(line)
        lastLineWasPlainCandidate = false
        continue
      }
      if (isBorder) {
        if (!inTable) {
          if (lastLineWasPlainCandidate && kept.length) {
            // Default (border-1) style: the header text line was pushed into `kept` in the immediately preceding iteration and this border is the separator right after it.
            headerLines.push(kept.pop()!)
          } else {
            // \pset border 2 style: this is a leading top border with no adjacent header text buffered yet. Peek at the next line -- if it isn't itself a border, it's the header row. Consume it explicitly here so it can't fall through to the generic dataRows bucket below and be misclassified as a data row.
            const next = lines[idx + 1]
            if (next !== undefined && !/^[-+]+$/.test(next.trim())) {
              headerLines.push(line)
              headerLines.push(next)
              idx++
              inTable = true; afterHeader = true
              lastLineWasPlainCandidate = false
              continue
            }
          }
          headerLines.push(line)
          inTable = true; afterHeader = true
        } else {
          if (afterHeader) { headerLines.push(line); afterHeader = false }
          else { flushTable(); kept.push(line) }
        }
        lastLineWasPlainCandidate = false
        continue
      }
      if (inTable) {
        dataRows.push(line)
      } else {
        kept.push(line)
        lastLineWasPlainCandidate = stripped !== ''
      }
    }
    if (inTable) flushTable()
    return this.finalize(kept)
  }
}

export const psqlFilter = new PsqlFilter()

// =========================================================================== MySQLFilter ===========================================================================

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
    // Real mysqldump per-table structure is: leading `--` comment lines (including the "-- Table structure for table" line itself), a blank line, THEN the DROP TABLE/CREATE TABLE body, ending with another blank line. `inCreate` spans the whole section; `sawHeaderBlank` tracks whether we've passed the header's blank line and are inside the actual DDL body yet — only a blank line encountered there ends the section.
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

// =========================================================================== Sqlite3Filter ===========================================================================

const SQLITE3_ERROR_RE = /^(Error:|Parse error:|Runtime error:)/i
const SQLITE3_SCHEMA_RE = /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE VIEW|CREATE TRIGGER)\b/i

export class Sqlite3Filter extends ToolFilter {
  readonly name = 'sqlite3'
  override readonly binaries = new Set(['sqlite3'])

  private static readonly ROW_THRESHOLD = 20
  private static readonly KEEP_ROWS = 5
  // Rows kept from the END of the result set. A head-only cut assumed the first rows answer the query, which is false for the ordinary shapes: an `ORDER BY` puts the extreme the caller asked for on the last row, and `sqlite3 -json` closes its array there, so cutting the tail both hid the answer and left output that no longer parses as JSON.
  private static readonly KEEP_TAIL_ROWS = 5

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[], ctx: CompressContext = {}): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const nonEmpty = lines.filter((ln) => ln.trim())
    const schemaLines = nonEmpty.filter((ln) => SQLITE3_SCHEMA_RE.test(ln))
    if (nonEmpty.length && schemaLines.length / nonEmpty.length >= 0.5) return merged

    const errors = lines.filter((ln) => SQLITE3_ERROR_RE.test(ln))
    const dataLines = lines.filter((ln) => !SQLITE3_ERROR_RE.test(ln))
    const kept: string[] = [...errors]

    // `.mode column`/`.headers on` output prefixes a header row + a dash-separator row before the actual data; without carving those out first they get eaten by the row-threshold slice below, so "showing first N" silently shows fewer than N real rows.
    let headerRows: string[] = []
    let bodyLines = dataLines
    if (dataLines.length >= 2 && dataLines[0]!.trim() && /^[\s\-+]+$/.test(dataLines[1]!) && dataLines[1]!.trim()) {
      headerRows = dataLines.slice(0, 2)
      bodyLines = dataLines.slice(2)
    }
    kept.push(...headerRows)

    const nonEmptyBody = bodyLines.filter((ln) => ln.trim())
    if (nonEmptyBody.length > Sqlite3Filter.ROW_THRESHOLD) {
      const head = Sqlite3Filter.KEEP_ROWS
      const tail = Math.min(Sqlite3Filter.KEEP_TAIL_ROWS, nonEmptyBody.length - head)
      kept.push(...nonEmptyBody.slice(0, head))
      // The row count answers "how big is this result set", so it is a claim about the query's data rather than a description of what this filter did. When the pre-filter clamp already dropped part of stdout, the surviving rows are all this can count, which makes the figure a floor: say so, instead of letting a clamped read of a 90000-row table print an exact `2000 rows` nothing here can prove.
      kept.push(
        ctx.inputTruncated === true
          ? `[token-goat: at least ${nonEmptyBody.length} rows (counted over a truncated input; showing first ${head}, last ${tail})]`
          : `[token-goat: ${nonEmptyBody.length} rows (showing first ${head}, last ${tail})]`,
      )
      if (tail > 0) kept.push(...nonEmptyBody.slice(-tail))
    } else {
      kept.push(...bodyLines)
    }
    return this.finalize(kept)
  }
}

export const sqlite3Filter = new Sqlite3Filter()

// =========================================================================== RedisCLIFilter ===========================================================================

const REDIS_ERROR_RE = /^(\(error\)|ERR |WRONGTYPE |NOAUTH |NOSCRIPT |BUSYKEY |MISCONF )/i
const REDIS_OK_RE = /^OK$/
const REDIS_LIST_ITEM_RE = /^\s*\d+\)\s+/
// A SCAN reply is a two-element array whose first element is the cursor. The Redis command reference for SCAN says that element is "a string representing an unsigned 64 bit number", so redis-cli renders it quoted (`1) "17"`), never as `1) (integer) 0`: keying detection on the integer form meant this path never fired on a real reply.
const REDIS_SCAN_CURSOR_RE = /^\s*1\)\s+"\d+"\s*$/
// redis-cli prints the first key of the nested second element on the same line as that element's own `2)` index (`2)  1) "key:12"`) and indents the rest (`    2) "key:8"`), so the outer index has to be optional or the first key is dropped.
const REDIS_SCAN_KEY_RE = /^\s*(?:\d+\)\s+)?\d+\)\s+"(.*)"\s*$/

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
    const first = lines.findIndex((ln) => ln.trim() !== '')
    if (first < 0) return false
    if (!REDIS_SCAN_CURSOR_RE.test(lines[first]!)) return false
    return lines.slice(first + 1).some((ln) => REDIS_SCAN_KEY_RE.test(ln))
  }

  private _compressScan(lines: string[]): string {
    const allKeys: string[] = []
    const errors: string[] = []
    let cursorLine: string | null = null
    let unrecognised = 0
    for (const line of lines) {
      if (!line.trim()) continue
      if (REDIS_ERROR_RE.test(line)) { errors.push(line); continue }
      if (cursorLine === null && REDIS_SCAN_CURSOR_RE.test(line)) { cursorLine = line; continue }
      const m = REDIS_SCAN_KEY_RE.exec(line)
      if (m) { allKeys.push(m[1]!); continue }
      unrecognised++
    }
    const kept: string[] = [...errors]
    // The cursor is the half of a SCAN reply the caller cannot reconstruct: a non-zero value means the keyspace was only partially walked and the next call must pass this value back. Emitting it verbatim keeps that resumable, and pulling it out of the key stream stops it being printed and counted as if it were a key.
    if (cursorLine !== null) kept.push(cursorLine)
    const total = allKeys.length
    if (total > RedisCLIFilter.LIST_KEEP) {
      kept.push(...allKeys.slice(0, RedisCLIFilter.LIST_KEEP).map((k) => `"${k}"`))
      kept.push(`[token-goat: ${total} keys total (showing first ${RedisCLIFilter.LIST_KEEP})]`)
    } else {
      kept.push(...allKeys.map((k) => `"${k}"`))
    }
    // This branch is a whitelist: anything that is neither an error, the cursor, nor an indexed key is discarded. Saying how many lines that was keeps a silent drop from reading as an empty keyspace.
    if (unrecognised) {
      kept.push(
        `[token-goat: dropped ${unrecognised} unrecognised line${unrecognised === 1 ? '' : 's'}; disable via TOKEN_GOAT_BASH_COMPRESS for the raw reply]`,
      )
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
