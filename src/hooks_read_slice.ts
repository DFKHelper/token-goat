/** Line windowing, slice estimation, line diffing, and truncated-read detection. Extracted from hooks_read.ts to isolate window parsing, disk window reading, and diff generation. */

import * as fs from 'node:fs'

import type { HookEvent } from './hook_registry.js'
import { extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS, resolveToolResponseFieldPath } from './hooks_common.js'
import { displaySafePath, hostPathOfIndexKey } from './paths.js'
import { fencedCommand, leadWithCommand, quotedArg, quotedArgs } from './hint_suggestion_guard.js'
import { hintTarget, sliceCommand, sliceForPath } from './hint_target.js'
import { countNoun, decodeSource, statSize, toKB } from './util.js'
import { load as snapshotLoad } from './snapshots.js'
import { BYTE_RANGE_ADVICE } from './hints/file_type_handler.js'

/** A line of a Read result: its number in the file, its text, and the numbered form it occupies in the delivered output. */
export interface NumberedRow {
  readonly no: number
  readonly text: string
  readonly raw: string
}

/** Reads a numeric tool-input param (Read's `offset`/`limit`), tolerating a numeric string. */
export function readIntToolInput(event: HookEvent, key: string): number | undefined {
  const val = event.toolInput[key]
  const n = typeof val === 'number' ? val : typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN
  return Number.isFinite(n) ? n : undefined
}

export interface RequestedSliceWindow {
  /** 1-based start line number, if requested or clamped */
  readonly offset?: number | undefined
  /** Number of lines requested, if bounded */
  readonly limit?: number | undefined
  /** Whether the tool input explicitly requested a bounded or partial window */
  readonly isExplicitSlice: boolean
}

/** Harnesses whose `read_file` hands the hook the file's own text, unnumbered, where Claude Code numbers it: Gemini CLI and its fork Qwen Code return it as `llmContent` (gemini-cli-core 0.62.0 tools/read-file.js, qwen-code 0.24.7), and Grok's `FileContent` is taken the same way. A file line shaped like a `cat -n` row is file text on these, never a rendering. */
type RawTextReadHarness = 'gemini' | 'qwen' | 'grok'

function rawTextReadHarness(event: HookEvent): RawTextReadHarness | null {
  const harness = event.raw['_tg_harness']
  return harness === 'gemini' || harness === 'qwen' || harness === 'grok' ? harness : null
}

/** Normalizes multi-harness line window parameters across Claude Code (`offset`/`limit`), Copilot CLI (`view_range: [start, end]`), and other tools (`lines`, `range`, `start_line`/`end_line`). Qwen Code's `offset`, and the `offset` Gemini CLI sent before it moved to `start_line`, is 0-based (qwen-code 0.24.7 read-file: `startLine = offset || 0`, shown as `startLine + 1`), so it is shifted onto the 1-based line it names. */
export function readRequestedSliceWindow(event: HookEvent): RequestedSliceWindow {
  const rawOffset = readIntToolInput(event, 'offset')
  const rawLimit = readIntToolInput(event, 'limit')

  if (rawOffset !== undefined || rawLimit !== undefined) {
    const harness = rawTextReadHarness(event)
    const zeroBased = harness === 'qwen' || harness === 'gemini'
    const offset = rawOffset === undefined ? 1 : zeroBased ? (rawOffset >= 0 ? Math.floor(rawOffset) + 1 : 1) : rawOffset >= 1 ? Math.floor(rawOffset) : 1
    return {
      offset,
      limit: rawLimit !== undefined && rawLimit > 0 ? Math.floor(rawLimit) : undefined,
      isExplicitSlice: true,
    }
  }

  const rawRange = event.toolInput['view_range'] ?? event.toolInput['lines'] ?? event.toolInput['range']
  if (Array.isArray(rawRange) && rawRange.length >= 1) {
    const rawStart = Number(rawRange[0])
    const startVal = Number.isFinite(rawStart) && rawStart >= 1 ? Math.floor(rawStart) : 1
    if (rawRange.length >= 2) {
      const rawEnd = Number(rawRange[1])
      if (rawEnd === -1) {
        return { offset: startVal, isExplicitSlice: true }
      }
      if (Number.isFinite(rawEnd) && rawEnd >= startVal) {
        const lineCount = Math.floor(rawEnd - startVal + 1)
        return { offset: startVal, limit: lineCount, isExplicitSlice: true }
      }
    }
    return { offset: startVal, isExplicitSlice: true }
  }

  const startLine =
    readIntToolInput(event, 'start_line') ??
    readIntToolInput(event, 'startLine') ??
    readIntToolInput(event, 'start')
  const endLine =
    readIntToolInput(event, 'end_line') ??
    readIntToolInput(event, 'endLine') ??
    readIntToolInput(event, 'end')

  if (startLine !== undefined || endLine !== undefined) {
    const effectiveStart = startLine !== undefined && startLine >= 1 ? Math.floor(startLine) : 1
    const effectiveLimit =
      endLine !== undefined && endLine >= effectiveStart ? Math.floor(endLine - effectiveStart + 1) : undefined
    return { offset: effectiveStart, limit: effectiveLimit, isExplicitSlice: true }
  }

  return { isExplicitSlice: false }
}

/** The 1-based file line the delivered body starts at: Claude Code's `tool_response.file.startLine`, or on a raw-text harness the first line its truncation header names, else the line the request started at. */
export function readStartLine(event: HookEvent): number {
  if (rawTextReadHarness(event) !== null) {
    const shown = splitRawReadHeader(readResponseText(event))?.shown
    return shown?.start ?? readRequestedSliceWindow(event).offset ?? 1
  }
  const resp = event.raw['tool_response'] as Record<string, unknown> | null
  const file = resp?.['file'] as Record<string, unknown> | null
  const start = file?.['startLine']
  return typeof start === 'number' && Number.isSafeInteger(start) && start >= 1 ? start : 1
}

const HARNESS_TRUNCATION_NOTICE_RE = /^[ \t]*\[Truncated: PARTIAL view/m

/** True when the harness numbers this Read's text itself, by position: Claude Code's `{type: 'text', file: {content, startLine, ...}}` envelope, which it renders by prefixing line `i` of `file.content` with `startLine + i` (read off claude.exe 2.1.281, whose renderer splits the field on newlines and emits `${startLine + i}` and a tab ahead of each piece). A rewrite that lands in that field must keep one line per delivered line and put nothing ahead of the first, or every number the model is shown after the change names the wrong line. Decided by the same resolver `serializeOutput` uses to pick the field it writes the rewrite back into, so this answers true exactly when the rewrite will be numbered that way, and never for a harness that takes the rewrite as plain text. */
export function harnessNumbersReadContent(event: HookEvent): boolean {
  const resp = event.raw['tool_response']
  if (resp === null || typeof resp !== 'object') return false
  const fieldPath = resolveToolResponseFieldPath(resp as Record<string, unknown>, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
  return fieldPath !== null && fieldPath.length === 2 && fieldPath[0] === 'file' && fieldPath[1] === 'content'
}

/** What `text` costs once the harness has numbered it from `startLine`: its bytes plus each line's number-and-tab prefix. A ratio gate on a rewrite the harness numbers has to price this on both sides, because a line-aligned rewrite keeps every line, empty ones included, and each still carries its prefix. */
export function numberedRenderBytes(text: string, startLine: number): number {
  let bytes = Buffer.byteLength(text, 'utf-8')
  const lines = text.split('\n').length
  for (let n = startLine; n < startLine + lines; n++) bytes += String(n).length + 1
  return bytes
}

function readResponseText(event: HookEvent): string {
  return extractToolResponseField(event.raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
}

/** The lines a raw-text harness shows and the file length it states, from the header it puts ahead of a partial read. */
interface RawReadShown {
  readonly start: number
  readonly end: number
  readonly total: number
  readonly atLeast: boolean
}

const GEMINI_TRUNCATION_OPENER = 'IMPORTANT: The file content has been truncated.'
const GEMINI_STATUS_RE = /^Status: Showing lines (\d+)-(\d+) of (\d+) total lines\.$/
const GEMINI_CONTENT_MARKER = '--- FILE CONTENT (truncated) ---'
const QWEN_STATUS_RE = /^Showing lines (\d+)-(\d+) of (at least )?(\d+) total lines\.$/
const LINE_CUT_MARKER_RE = /\.\.\. \[truncated\]$/m

/** Split the header Gemini CLI or Qwen Code puts ahead of a partial `read_file` off the file text beneath it. Gemini (gemini-cli-core 0.62.0 tools/read-file.js) writes `\nIMPORTANT: The file content has been truncated.\nStatus: Showing lines X-Y of N total lines.\nAction: ...\n\n--- FILE CONTENT (truncated) ---\n`; Qwen (0.24.7) writes `Showing lines X-Y of N total lines.` (N may read `at least N`) then `\n\n---\n\n`, or `\n---\n` on its @-include path. Null when the text opens with neither. */
function splitRawReadHeader(respText: string): { header: string[]; body: string; shown: RawReadShown } | null {
  const lines = respText.split('\n')
  const opener = lines[0] === '' ? 1 : 0
  if (lines[opener] === GEMINI_TRUNCATION_OPENER) {
    const marker = lines.indexOf(GEMINI_CONTENT_MARKER, opener + 1)
    if (marker === -1 || marker > opener + 6) return null
    const status = lines.slice(opener + 1, marker).map((l) => GEMINI_STATUS_RE.exec(l)).find((m) => m !== null)
    if (status === undefined || status === null) return null
    const shown = { start: Number(status[1]), end: Number(status[2]), total: Number(status[3]), atLeast: false }
    return { header: lines.slice(0, marker + 1), body: lines.slice(marker + 1).join('\n'), shown }
  }
  const status = QWEN_STATUS_RE.exec(lines[0] ?? '')
  if (status === null) return null
  const shown = { start: Number(status[1]), end: Number(status[2]), total: Number(status[4]), atLeast: status[3] !== undefined }
  const width = lines[1] === '' && lines[2] === '---' && lines[3] === '' ? 4 : lines[1] === '---' ? 2 : 0
  if (width === 0) return null
  return { header: lines.slice(0, width), body: lines.slice(width).join('\n'), shown }
}

/** Whether a raw-text harness's header says it delivered less than was asked for: a different first line, an earlier last line than the request (or the file) runs to, a file length it only bounds from below, or a line cut short with `... [truncated]`. Both harnesses print the header on a ranged read that came back whole too, so its presence alone proves nothing. */
function rawReadCutShort(event: HookEvent, split: { body: string; shown: RawReadShown }): boolean {
  const { shown } = split
  if (shown.atLeast) return true
  const window = readRequestedSliceWindow(event)
  const reqStart = window.offset ?? 1
  const reqEnd = window.limit !== undefined ? Math.min(reqStart + window.limit - 1, shown.total) : shown.total
  if (shown.start !== reqStart || shown.end < reqEnd) return true
  return LINE_CUT_MARKER_RE.test(split.body)
}

/** True when the harness handed back only part of the read, so folding it would withhold lines the model never received. */
export function isTruncatedReadDelivery(event: HookEvent, respText: string): boolean {
  const harness = rawTextReadHarness(event)
  if (harness === 'gemini' || harness === 'qwen') {
    const split = splitRawReadHeader(respText)
    return split !== null && rawReadCutShort(event, split)
  }
  const resp = event.raw['tool_response'] as Record<string, unknown> | null
  const file = resp?.['file'] as Record<string, unknown> | null
  if (file?.['truncatedByTokenCap'] === true) return true
  return HARNESS_TRUNCATION_NOTICE_RE.test(respText)
}

/** Cap on bytes scanned while estimating an offset/limit slice. */
export const SLICE_ESTIMATE_SCAN_CAP_BYTES = 2 * 1024 * 1024

const NEAR_SINGLE_LINE_SCAN_THRESHOLD = 20

interface SliceScan {
  bytes: number
  trustworthy: boolean
  nearSingleLine: boolean
}

/** Scans the 1-indexed line window [offset, offset + limit) without reading the whole file into memory. */
function scanRequestedSlice(absPath: string, offset: number, limit: number): SliceScan | null {
  const windowEnd = offset + limit
  let fd: number
  try {
    fd = fs.openSync(hostPathOfIndexKey(absPath), 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    let lineNumber = 1
    let sliceBytes = 0
    let totalScanned = 0
    let afterCr = false
    for (;;) {
      if (totalScanned >= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
        const nearSingleLine = lineNumber < NEAR_SINGLE_LINE_SCAN_THRESHOLD
        return { bytes: sliceBytes, trustworthy: nearSingleLine, nearSingleLine }
      }
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null)
      if (bytesRead === 0) {
        return {
          bytes: sliceBytes,
          trustworthy: true,
          nearSingleLine: lineNumber < NEAR_SINGLE_LINE_SCAN_THRESHOLD && totalScanned > 2000,
        }
      }
      totalScanned += bytesRead
      for (let i = 0; i < bytesRead; i++) {
        if (lineNumber >= offset && lineNumber < windowEnd) sliceBytes++
        const byte = buf[i]
        // A lone CR ends a line, as the indexer counts it (source_text.ts); the LF of a CRLF pair ends nothing the CR did not.
        if (byte === 0x0a && afterCr) {
          afterCr = false
          continue
        }
        afterCr = byte === 0x0d
        if (byte === 0x0a || byte === 0x0d) {
          lineNumber++
          if (lineNumber >= windowEnd) return { bytes: sliceBytes, trustworthy: true, nearSingleLine: false }
        }
      }
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // best-effort
    }
  }
}

/** Outcome of trying to size a Read call's requested offset/limit window. */
export type RequestedSlice =
  | { readonly kind: 'bytes'; readonly bytes: number }
  | { readonly kind: 'unbounded' }
  | { readonly kind: 'nearSingleLine' }

/** Reads `offset`/`limit` off the Read tool call and estimates the size of just that slice. */
export function estimateRequestedSlice(event: HookEvent, absPath: string): RequestedSlice {
  const window = readRequestedSliceWindow(event)
  if (window.limit === undefined || window.limit <= 0) return { kind: 'unbounded' }
  const effectiveOffset = window.offset !== undefined && window.offset >= 1 ? window.offset : 1
  const scan = scanRequestedSlice(absPath, effectiveOffset, window.limit)
  if (scan === null) return { kind: 'unbounded' }
  if (scan.nearSingleLine) return { kind: 'nearSingleLine' }
  if (scan.trustworthy) return { kind: 'bytes', bytes: scan.bytes }
  return { kind: 'unbounded' }
}

/** Whether a sized offset/limit window is under `thresholdBytes`: a small slice a size gate lets through. Only a window the scan could bound counts, never an unbounded or single-line one. */
export function isSmallSlice(slice: RequestedSlice, thresholdBytes: number): boolean {
  return slice.kind === 'bytes' && slice.bytes < thresholdBytes
}

/** Whether a bounded offset/limit Read names only lines this session never served: no whole-file read behind it, and no recorded line range touching the window. Such a read hands over text the model has not seen, so a re-read note or count-based deny about it would be false. */
export function isUnseenWindow(window: RequestedSliceWindow, servedRanges: ReadonlyArray<readonly [number, number]>, fullReads: number): boolean {
  if (!window.isExplicitSlice || fullReads !== 0 || window.offset === undefined || window.limit === undefined) return false
  const start = window.offset
  const end = window.offset + window.limit - 1
  return !servedRanges.some(([s, e]) => s <= end && e >= start)
}

/** Phrases retry advice for a large-file deny based on offset/limit. */
export function describeSliceAdvice(slice: RequestedSlice, rawAbsPath: string): string {
  const absPath = displaySafePath(rawAbsPath)
  if (slice.kind === 'nearSingleLine') {
    return BYTE_RANGE_ADVICE(absPath)
  }
  if (slice.kind === 'bytes') {
    return (
      `The requested offset/limit range is still ~${toKB(slice.bytes)}KB — ` +
      'narrow the range further (a smaller limit) rather than reading the whole file.'
    )
  }
  return 'Use Read with offset/limit to sample specific sections.'
}

/** Compute a compact unified-style diff between two versions of a doc file. */
function buildLineDiffDetailed(oldContent: string, newContent: string, label: string): { readonly text: string; readonly truncated: boolean } {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let oldSuffix = oldLines.length
  let newSuffix = newLines.length
  while (oldSuffix > prefix && newSuffix > prefix && oldLines[oldSuffix - 1] === newLines[newSuffix - 1]) {
    oldSuffix--
    newSuffix--
  }

  if (prefix === oldLines.length && prefix === newLines.length) return { text: '', truncated: false }

  const changedOld = oldLines.slice(prefix, oldSuffix)
  const changedNew = newLines.slice(prefix, newSuffix)

  const MAX_LINES = 50
  const removedLines = changedOld.map(l => `-${l}`)
  const addedLines = changedNew.map(l => `+${l}`)
  const allChanges = [...removedLines, ...addedLines]

  const shownRemoved = Math.min(removedLines.length, MAX_LINES)
  const shownAdded = Math.max(0, Math.min(addedLines.length, MAX_LINES - shownRemoved))

  const out: string[] = [
    `--- ${label} (prev)`,
    `+++ ${label} (current)`,
    `@@ -${prefix + 1},${shownRemoved} +${prefix + 1},${shownAdded} @@`,
  ]

  const truncated = allChanges.length > MAX_LINES
  if (!truncated) {
    out.push(...allChanges)
  } else {
    out.push(...allChanges.slice(0, MAX_LINES))
    out.push(`... (${countNoun(allChanges.length - MAX_LINES, 'more changed line')})`)
  }

  return { text: out.join('\n'), truncated }
}

/** String-only view of buildLineDiffDetailed. */
export function buildLineDiff(oldContent: string, newContent: string, label: string): string {
  return buildLineDiffDetailed(oldContent, newContent, label).text
}

export type SnapshotDiffResult =
  | { readonly kind: 'unchanged'; readonly currentContent: string }
  | { readonly kind: 'diff'; readonly diff: string; readonly savedBytes: number; readonly currentContent: string }
  | { readonly kind: 'none' }

/** Compare prior snapshot to the file's current on-disk content. */
export function loadSnapshotDiff(sessionId: string, normalized: string, basename: string): SnapshotDiffResult {
  const oldSnap = snapshotLoad(sessionId, normalized)
  if (oldSnap === null) return { kind: 'none' }
  try {
    const onDisk = hostPathOfIndexKey(normalized)
    const sz = statSize(onDisk)
    if (sz === null || sz > 256 * 1024) return { kind: 'none' }
    const currentContent = fs.readFileSync(onDisk, 'utf8')
    const TRUNC_MARKER = '\n<snapshot truncated at '
    const oldRaw = oldSnap.toString('utf8')
    const truncIdx = oldRaw.indexOf(TRUNC_MARKER)
    if (truncIdx >= 0) return { kind: 'none' }
    const oldContent = oldRaw
    if (oldContent === currentContent) return { kind: 'unchanged', currentContent }
    const { text: diff, truncated } = buildLineDiffDetailed(oldContent, currentContent, basename)
    if (diff === '') return { kind: 'none' }
    if (truncated) return { kind: 'none' }
    const savedBytes = Math.max(0, currentContent.length - diff.length)
    return { kind: 'diff', diff, savedBytes, currentContent }
  } catch {
    return { kind: 'none' }
  }
}

/** Count text lines like `wc -l`. */
export function countTextLines(content: string): number {
  if (content.length === 0) return 0
  const parts = content.split(/\r\n|\r|\n/)
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

/** Line count capped by SLICE_ESTIMATE_SCAN_CAP_BYTES; Infinity when unreadable or too large. */
export function estimateTruncatedLineCount(normalized: string): number {
  try {
    const onDisk = hostPathOfIndexKey(normalized)
    const sz = statSize(onDisk)
    if (sz !== null && sz <= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
      return countTextLines(fs.readFileSync(onDisk, 'utf8'))
    }
  } catch {
    // best-effort
  }
  return Infinity
}

export function editAnywayHint(rawPath: string): string {
  const [quoted, b64, oldFile, newFile] = quotedArgs(displaySafePath(rawPath), '<base64>', '<oldfile>', '<newfile>')
  return (
    'To edit it anyway, use `token-goat replace ' + quoted + ' --old-b64 ' + b64 + ' --new-b64 ' + b64 + '` (preferred — no temp files needed) or `--old-from ' + oldFile + ' --new-from ' + newFile + '` for a snippet edit, or `token-goat write-file ' + quoted + ' --b64 ' + b64 + '` (or `--from ' + newFile + '`) to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.'
  )
}

export function truncatedReadDenyMessage(rawPath: string): string {
  const normalized = displaySafePath(rawPath)
  const reason = 'File was truncated on last read (>33K tokens).'
  const skeleton = 'token-goat skeleton ' + quotedArg(normalized)
  const target = hintTarget(rawPath, sliceForPath(rawPath))
  return target.real
    ? leadWithCommand(sliceCommand(normalized, target), 'for one part, or ' + fencedCommand(skeleton) + ' for structure', reason)
    : leadWithCommand(skeleton, 'for structure, or ' + fencedCommand('token-goat read ' + quotedArg(normalized + '::SymbolName')) + ' for one function', reason)
}

/** Slices window text directly from disk. */
export function readWindowFromDisk(event: HookEvent, normalized: string): string | null {
  const onDisk = hostPathOfIndexKey(normalized)
  const size = statSize(onDisk)
  if (size === null || size > SLICE_ESTIMATE_SCAN_CAP_BYTES) return null
  const text = decodeSource(fs.readFileSync(onDisk))
  const window = readRequestedSliceWindow(event)
  const start = window.offset !== undefined && window.offset >= 1 ? window.offset : 1
  const limit = window.limit
  if (start === 1 && (limit === undefined || limit <= 0)) return text
  const lines = text.split('\n')
  const from = start - 1
  return (limit === undefined || limit <= 0 ? lines.slice(from) : lines.slice(from, from + limit)).join('\n')
}

export const READ_NUMBERED_ROW_RE = /^\s*(\d+)[\t→](.*)$/

export interface ParsedReadResult {
  readonly header: string[]
  readonly rows: NumberedRow[]
  readonly trailer: string[]
}

/** The rows a Read delivered, each carrying the file line it is. Where the harness numbers the text itself ({@link harnessNumbersReadContent}) every line is the file's own and is numbered by position, however it reads: a file line shaped like a numbered row (a TSV record, a captured `cat -n` listing inside a string) is still file text, and parsing it as a rendering handed each rewrite a slice of the file under the listing's own numbers, so a fold withheld listing rows beneath a notice naming a function body it delivered whole. */
export function parseReadDelivery(event: HookEvent, respText: string): ParsedReadResult | null {
  const firstLine = readStartLine(event)
  const harness = rawTextReadHarness(event)
  if (harness === 'gemini' || harness === 'qwen') {
    const split = splitRawReadHeader(respText)
    if (split === null) return plainReadResult(respText, firstLine)
    const parsed = plainReadResult(split.body, firstLine)
    return parsed === null ? null : { ...parsed, header: split.header }
  }
  if (harness === 'grok') return wholeNumberedReadResult(respText, firstLine) ?? plainReadResult(respText, firstLine)
  return harnessNumbersReadContent(event) ? plainReadResult(respText, firstLine) : parseNumberedReadResult(respText, firstLine)
}

/** The delivery as numbered rows only when every line is one, numbered consecutively from `firstLine` (a trailing empty line aside); null otherwise. Decided for the whole delivery rather than per line, so a file line that merely looks numbered (`     2\tx` on line 2 of a raw delivery) stays file text. */
function wholeNumberedReadResult(respText: string, firstLine: number): ParsedReadResult | null {
  const lines = respText.split('\n')
  const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  if (body.length === 0) return null
  const rows: NumberedRow[] = []
  for (const [idx, line] of body.entries()) {
    const m = READ_NUMBERED_ROW_RE.exec(line)
    if (m === null || Number(m[1]) !== firstLine + idx) return null
    rows.push({ no: firstLine + idx, text: m[2] ?? '', raw: line })
  }
  return { header: [], rows, trailer: body.length < lines.length ? [''] : [] }
}

/** Every line of `respText` as a row of its own, numbered by position from `firstLine`. */
function plainReadResult(respText: string, firstLine: number): ParsedReadResult | null {
  if (respText === '') return null
  return { header: [], rows: respText.split('\n').map((text, idx) => ({ no: firstLine + idx, text, raw: text })), trailer: [] }
}

/** Split a Read result into the `cat -n` block it delivered and the harness text around it, falling back to position when no line is numbered. */
function parseNumberedReadResult(respText: string, firstLine: number): ParsedReadResult | null {
  const lines = respText.split('\n')
  const header: string[] = []
  const rows: NumberedRow[] = []
  const trailer: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = READ_NUMBERED_ROW_RE.exec(line)
    if (m === null || !Number.isSafeInteger(Number(m[1]))) {
      header.push(line)
      continue
    }
    rows.push({ no: Number(m[1]), text: m[2] ?? '', raw: line })
    i++
    break
  }
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = READ_NUMBERED_ROW_RE.exec(line)
    const prev = rows[rows.length - 1]
    if (m === null || prev === undefined || Number(m[1]) !== prev.no + 1) break
    rows.push({ no: prev.no + 1, text: m[2] ?? '', raw: line })
  }
  for (; i < lines.length; i++) trailer.push(lines[i] ?? '')
  if (rows.length > 0) return { header, rows, trailer }
  return plainReadResult(respText, firstLine)
}

/** Whether a file the whole-file re-read denies are refusing still holds what the session last read, and how that was decided. */
export interface RereadIdentity {
  readonly identity: 'identical' | 'changed' | 'unknown'
  readonly basis: 'snapshot' | 'stat' | 'none'
}

/** Decide whether `normalized` still holds what this session last read, for the measurement the whole-file re-read denies book. Those denies say "already read this session" from a read count alone, never from the content, so a deny on a file that changed since the read the model holds refuses the one read that would have been current. The snapshot postReadHandler keeps of the last read is the proof when there is one: byte equality with disk. A missing or truncated snapshot falls back to the size captured at the last read and the file's mtime against the last whole-file read: a size that moved, or a write after that read, is a change; neither is identical as far as a stat can tell. `prior` is the session entry as it stood before this read was recorded, so its size and times describe the last read the session recorded. That includes a read an earlier deny refused (recordActualRead books it all the same), so after one deny the stat fallback measures against that refusal, not the delivery the model holds; the snapshot, written only when a read is delivered, has no such blind spot. */
export function rereadIdentity(
  sessionId: string,
  normalized: string,
  prior: { readonly sizeBytes: number; readonly lastReadAt: number; readonly lastFullReadAt?: number } | undefined,
): RereadIdentity {
  const onDisk = hostPathOfIndexKey(normalized)
  let current: fs.Stats
  try {
    current = fs.statSync(onDisk)
  } catch {
    return { identity: 'unknown', basis: 'none' }
  }
  const snap = snapshotLoad(sessionId, normalized)
  if (snap !== null && !snap.includes('\n<snapshot truncated at ') && current.size <= 256 * 1024) {
    try {
      return { identity: snap.equals(fs.readFileSync(onDisk)) ? 'identical' : 'changed', basis: 'snapshot' }
    } catch {
      // Unreadable now: fall through to the stat comparison.
    }
  }
  if (prior === undefined || prior.sizeBytes <= 0) return { identity: 'unknown', basis: 'none' }
  const changed = current.size !== prior.sizeBytes || current.mtimeMs > (prior.lastFullReadAt ?? prior.lastReadAt)
  return { identity: changed ? 'changed' : 'identical', basis: 'stat' }
}
