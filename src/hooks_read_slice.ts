/** Line windowing, slice estimation, line diffing, and truncated-read detection. Extracted from hooks_read.ts to isolate window parsing, disk window reading, and diff generation. */

import * as fs from 'node:fs'

import type { HookEvent } from './hook_registry.js'
import { displaySafePath } from './paths.js'
import { leadWithCommand } from './hint_suggestion_guard.js'
import { hintTarget, sliceCommand, sliceForPath } from './hint_target.js'
import { decodeSource, statSize, toKB } from './util.js'
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

/** Normalizes multi-harness line window parameters across Claude Code (`offset`/`limit`), Copilot CLI (`view_range: [start, end]`), and other tools (`lines`, `range`, `start_line`/`end_line`). */
export function readRequestedSliceWindow(event: HookEvent): RequestedSliceWindow {
  const rawOffset = readIntToolInput(event, 'offset')
  const rawLimit = readIntToolInput(event, 'limit')

  if (rawOffset !== undefined || rawLimit !== undefined) {
    return {
      offset: rawOffset !== undefined && rawOffset >= 1 ? Math.floor(rawOffset) : 1,
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

/** The 1-based file line the delivered body starts at, from `tool_response.file.startLine`. */
export function readStartLine(event: HookEvent): number {
  const resp = event.raw['tool_response'] as Record<string, unknown> | null
  const file = resp?.['file'] as Record<string, unknown> | null
  const start = file?.['startLine']
  return typeof start === 'number' && Number.isSafeInteger(start) && start >= 1 ? start : 1
}

const HARNESS_TRUNCATION_NOTICE_RE = /^[ \t]*\[Truncated: PARTIAL view/m

/** True when the harness handed back only part of the read, so folding it would withhold lines the model never received. */
export function isTruncatedReadDelivery(event: HookEvent, respText: string): boolean {
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
    fd = fs.openSync(absPath, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    let lineNumber = 1
    let sliceBytes = 0
    let totalScanned = 0
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
        if (buf[i] === 0x0a) {
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
    out.push(`... (${allChanges.length - MAX_LINES} more changed lines)`)
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
    const sz = statSize(normalized)
    if (sz === null || sz > 256 * 1024) return { kind: 'none' }
    const currentContent = fs.readFileSync(normalized, 'utf8')
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
    const sz = statSize(normalized)
    if (sz !== null && sz <= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
      return countTextLines(fs.readFileSync(normalized, 'utf8'))
    }
  } catch {
    // best-effort
  }
  return Infinity
}

export function editAnywayHint(rawPath: string): string {
  const normalized = displaySafePath(rawPath)
  return (
    'To edit it anyway, use `token-goat replace "' + normalized + '" --old-b64 <base64> --new-b64 <base64>` (preferred — no temp files needed) or `--old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --b64 <base64>` (or `--from <newfile>`) to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.'
  )
}

export function truncatedReadDenyMessage(rawPath: string): string {
  const normalized = displaySafePath(rawPath)
  const reason = 'File was truncated on last read (>33K tokens).'
  const skeleton = 'token-goat skeleton "' + normalized + '"'
  const target = hintTarget(rawPath, sliceForPath(rawPath))
  return target.real
    ? leadWithCommand(sliceCommand(normalized, target), 'for one part, or `' + skeleton + '` for structure', reason)
    : leadWithCommand(skeleton, 'for structure, or `token-goat read "' + normalized + '::SymbolName"` for one function', reason)
}

/** Slices window text directly from disk. */
export function readWindowFromDisk(event: HookEvent, normalized: string): string | null {
  const size = statSize(normalized)
  if (size === null || size > SLICE_ESTIMATE_SCAN_CAP_BYTES) return null
  const text = decodeSource(fs.readFileSync(normalized))
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

/** Split a Read result into the `cat -n` block it delivered and the harness text around it. */
export function parseNumberedReadResult(respText: string, firstLine = 1): ParsedReadResult | null {
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
  if (respText === '') return null
  const plain = lines.map((text, idx) => ({ no: firstLine + idx, text, raw: text }))
  return { header: [], rows: plain, trailer: [] }
}
