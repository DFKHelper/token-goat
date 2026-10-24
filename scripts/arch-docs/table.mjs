// The component table between the ARCH_COMPONENTS markers: parse, render and splice. Contract: SKILL.md "Component Table Contract" of the arch-doc-sync skill; the reference engine is sync_arch_docs.py, section "table.mts".
import { ArchDocError, layerOrder } from './config.mjs'

export const START_MARKER = '<!-- ARCH_COMPONENTS_START -->'
export const END_MARKER = '<!-- ARCH_COMPONENTS_END -->'
export const NO_EXPORTS = '—'

const HEADER_CELLS = ['Module', 'Layer', 'Role', 'Key exports']
const TABLE_HEADER = `| ${HEADER_CELLS.join(' | ')} |`
const TABLE_SEPARATOR = '| --- | --- | --- | --- |'
const SEPARATOR_CELL = /^:?-{3,}:?$/
const CELL = String.raw`((?:\\.|[^|\\])*)`
const ROW_RE = new RegExp(String.raw`^\|\s*` + '`([^`]+)`' + String.raw`\s*\|${CELL}\|${CELL}\|${CELL}\|$`)
const FOUR_CELLS = new RegExp(String.raw`^\|${CELL}\|${CELL}\|${CELL}\|${CELL}\|$`)
const LINE_EDGE = /^[\s\u200B\u2060]+|[\s\u200B\u2060]+$/g
const UNREPRESENTABLE = /[`|\r\n]|<!--|--!?>/

/** Bytewise (UTF-8) comparison, the order every list and the table use. */
export const byteCompare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

const escapeCell = (value) => value.replace(/[\\|]/g, (ch) => `\\${ch}`)
const unescapeCell = (value) => value.replace(/\\([\\|])/g, '$1')

function isHeaderOrSeparator(line) {
  const match = FOUR_CELLS.exec(line)
  if (match === null) return false
  const cells = match.slice(1, 5).map((cell) => cell.trim())
  return cells.every((cell, i) => cell === HEADER_CELLS[i]) || cells.every((cell) => SEPARATOR_CELL.test(cell))
}

/** Rows keyed by module path; blank lines, the header and the separator are skipped, and any other line that is not a row is an error. */
export function parseTable(inner) {
  const rows = new Map()
  inner.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.replace(LINE_EDGE, '')
    if (trimmed === '' || isHeaderOrSeparator(trimmed)) return
    const match = ROW_RE.exec(trimmed)
    if (match === null) throw new ArchDocError(`malformed table row on line +${index} from the start marker: ${trimmed}`)
    const [, module, layer, role, exports] = match
    if (rows.has(module)) throw new ArchDocError(`duplicate table row for module ${module} on line +${index} from the start marker`)
    rows.set(module, { module, layer: unescapeCell(layer.trim()), role: unescapeCell(role.trim()), exports: unescapeCell(exports.trim()) })
  })
  return rows
}

/** Throws unless the module path can be written into a backtick-quoted cell and parsed back unchanged. */
export function assertTableable(key) {
  if (UNREPRESENTABLE.test(key)) {
    throw new ArchDocError(`${JSON.stringify(key)}: path contains a backtick, |, newline, or HTML comment marker and cannot be tabled; exclude it`)
  }
}

function renderRow(row) {
  assertTableable(row.module)
  return `| \`${row.module}\` | ${escapeCell(row.layer)} | ${escapeCell(row.role)} | ${escapeCell(row.exports)} |`
}

/** Text strictly between the markers, LF-terminated: layer order, then bytewise by module path within a layer. */
export function renderTable(rows, layers) {
  const order = layerOrder(layers)
  const rank = (row) => (order.includes(row.layer) ? order.indexOf(row.layer) : order.length)
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || byteCompare(a.module, b.module))
  return `\n${[TABLE_HEADER, TABLE_SEPARATOR, ...sorted.map(renderRow)].join('\n')}\n`
}

/** Locates the single marker pair; a missing, duplicated or reversed marker is a usage error. */
export function findMarkers(doc) {
  const offsets = (needle) => {
    const found = []
    for (let at = doc.indexOf(needle); at !== -1; at = doc.indexOf(needle, at + needle.length)) found.push(at)
    return found
  }
  const starts = offsets(START_MARKER)
  const ends = offsets(END_MARKER)
  if (starts.length === 0) throw new ArchDocError('missing ARCH_COMPONENTS_START marker')
  if (ends.length === 0) throw new ArchDocError('missing ARCH_COMPONENTS_END marker')
  if (starts.length > 1) throw new ArchDocError('duplicated ARCH_COMPONENTS_START marker')
  if (ends.length > 1) throw new ArchDocError('duplicated ARCH_COMPONENTS_END marker')
  if (ends[0] < starts[0]) throw new ArchDocError('ARCH_COMPONENTS_END precedes ARCH_COMPONENTS_START')
  return { contentStart: starts[0] + START_MARKER.length, contentEnd: ends[0] }
}

/** Throws when the doc holds a carriage return that is not followed by a line feed. */
export function assertNoLoneCr(doc, name) {
  for (let i = doc.indexOf('\r'); i !== -1; i = doc.indexOf('\r', i + 1)) {
    if (doc[i + 1] !== '\n') {
      throw new ArchDocError(`${name}: carriage return without a line feed at byte ${Buffer.byteLength(doc.slice(0, i))}; use LF or CRLF line endings`)
    }
  }
}

/** The doc's own line ending: CRLF when it holds one anywhere, else LF. */
export const detectNewline = (doc) => (doc.includes('\r\n') ? '\r\n' : '\n')

export const toNewline = (text, newline) => text.replace(/\r\n/g, '\n').replace(/\n/g, newline)

export const currentInner = (doc, markers) => doc.slice(markers.contentStart, markers.contentEnd)

/** The doc with only the bytes between the markers replaced. */
export const splice = (doc, markers, inner) => doc.slice(0, markers.contentStart) + inner + doc.slice(markers.contentEnd)
