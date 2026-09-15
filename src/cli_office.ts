import * as fs from 'node:fs'

import { _applyFiltersAndPrint, CliError, out, requireNonNegativeInt, requirePositiveInt } from './cli.js'
import { formatCsvTable, parseWhereSpecs } from './csv_query.js'
import { docxOutline, docxTables, docxText, formatDocxTables } from './docx_extract.js'
import { fenceUntrustedContent, UNTRUSTED_FILE_TAG } from './injection_scan.js'
import { displaySafeJson, displaySafePath, displaySafeText } from './paths.js'
import { pptxNotesText, pptxOutline, pptxSlideText, pptxTextGrep } from './pptx_extract.js'
import {
  guardJsonRows,
  runPdfExtractText,
  runPdfLocate,
  runPdfMeta,
  runPdfOutline,
} from './read_commands.js'
import { redactSecrets } from './secret_redact.js'
import { parseShareUrl, resolveLocalPath } from './sharepoint_resolve.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import {
  buildTranscriptOutline,
  formatCues,
  formatTimestamp,
  parseSliceOptions,
  readTranscript,
  sliceTranscript,
} from './transcript_extract.js'
import { fenceUntrusted, scanAndRecord } from './untrusted_fence.js'
import { cappedSourceBytesSaved, countNoun, redactUrlQuery } from './util.js'
import { extractVideoChapters } from './video_chapters.js'
import {
  formatXlsxColumns,
  formatXlsxRange,
  headSheet as xlsxHeadSheet,
  listSheets as xlsxListSheets,
  querySheet as xlsxQuerySheet,
  rangeSheet as xlsxRangeSheet,
  xlsxColumns,
} from './xlsx_extract.js'

export function fenceFileText(text: string): string {
  return fenceUntrusted(redactSecrets(text).text, UNTRUSTED_FILE_TAG)
}

export function fenceFileFieldIfMatched(text: string): string {
  const redacted = redactSecrets(text).text
  const matches = scanAndRecord(redacted)
  if (matches.length === 0) return displaySafeText(redacted)
  return fenceUntrustedContent(redacted, matches, UNTRUSTED_FILE_TAG)
}

export function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

export function recordDocStat(kind: string, file: string, emitted: string): void {
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(emitted, 'utf8'))
  recordStat(kind, bytesSaved, savedTokensFromBytes(bytesSaved))
}

export function recordXlsxStat(kind: string, file: string, emitted: string): void {
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(emitted, 'utf8'))
  recordStat(kind, bytesSaved, savedTokensFromBytes(bytesSaved))
}

export async function cmdPdfExtract(
  file: string,
  opts: { pages?: string; head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; layout?: boolean },
): Promise<void> {
  const text = redactSecrets(await runPdfExtractText(file, opts.pages, opts.layout === true)).text
  const printed = _applyFiltersAndPrint(text, opts, true, UNTRUSTED_FILE_TAG)
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(printed, 'utf8'))
  recordStat('pdf_extract', bytesSaved, savedTokensFromBytes(bytesSaved))
}

export async function cmdPdfLocate(
  file: string,
  pattern: string,
  opts: { ignoreCase?: boolean; maxMatches?: string; context?: string; pages?: string; json?: boolean },
): Promise<void> {
  const locateOpts: { ignoreCase?: boolean; maxMatches?: number; context?: number; pages?: string } = {
    ignoreCase: opts.ignoreCase === true,
  }
  if (opts.maxMatches !== undefined) locateOpts.maxMatches = requirePositiveInt('--max-matches', opts.maxMatches)
  if (opts.context !== undefined) locateOpts.context = requirePositiveInt('--context', opts.context)
  if (opts.pages !== undefined) locateOpts.pages = opts.pages
  const { matches, truncated } = await runPdfLocate(file, pattern, locateOpts)

  const pages = matches.map((m) => m.page)
  let printed: string
  if (opts.json === true) {
    const fencedMatches = matches.map((m) => ({ ...m, snippet: fenceFileFieldIfMatched(m.snippet) }))
    printed = displaySafeJson({ file, pattern, matchCount: fencedMatches.length, truncated, pages, matches: fencedMatches })
    out(printed)
  } else if (matches.length === 0) {
    printed = '(no matches)'
    out(printed)
  } else {
    const lines = matches.map((m) => `p${m.page}: ${m.snippet}`)
    const summary = truncated
      ? `at least ${countNoun(matches.length, 'match', 'matches')} across at least ${countNoun(pages.length, 'page')}; scan stopped at --max-matches, raise it for more`
      : `${countNoun(matches.length, 'match', 'matches')} across ${countNoun(pages.length, 'page')}`
    printed = fenceFileText(`${lines.join('\n')}\n\n${summary}`)
    out(printed)
  }
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(printed, 'utf8'))
  recordStat('pdf_locate', bytesSaved, savedTokensFromBytes(bytesSaved))
}

export async function cmdPdfOutline(file: string, opts: { json?: boolean }): Promise<void> {
  const entries = await runPdfOutline(file)
  if (entries.length === 0) {
    if (opts.json === true) {
      out(displaySafeJson([]))
    } else {
      out('no bookmarks in this PDF; try pdf-extract')
    }
    return
  }
  const text =
    opts.json === true
      ? displaySafeJson(entries.map((e) => ({ ...e, title: fenceFileFieldIfMatched(e.title) })))
      : fenceFileText(entries.map((e) => `${'  '.repeat(e.level)}${e.title}${e.page !== null ? `  (p.${e.page})` : ''}`).join('\n'))
  out(text)
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('pdf_outline', bytesSaved, savedTokensFromBytes(bytesSaved))
}

export async function cmdPdfMeta(file: string, opts: { json?: boolean } = {}): Promise<void> {
  const meta = await runPdfMeta(file)
  const safeField = (v: string | null): string | null => (v === null ? null : fenceFileFieldIfMatched(v))
  const lines = [
    `Pages: ${meta.pageCount}`,
    `Title: ${safeField(meta.title) ?? '(none)'}`,
    `Author: ${safeField(meta.author) ?? '(none)'}`,
    `Text layer: ${meta.hasTextLayer ? 'yes' : 'no (likely scanned/image-only; pdf-extract will return little or no text)'}`,
  ]
  const text = opts.json === true
    ? displaySafeJson({ pageCount: meta.pageCount, title: safeField(meta.title), author: safeField(meta.author), hasTextLayer: meta.hasTextLayer })
    : lines.join('\n')
  out(text)
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('pdf_meta', bytesSaved, savedTokensFromBytes(bytesSaved))
}

export function formatVideoTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function cmdVideoChapters(file: string): void {
  const { chapters, subtitleStreams } = extractVideoChapters(file)
  const lines: string[] = []
  if (chapters.length === 0) {
    lines.push('(no chapter markers found)')
  } else {
    for (const c of chapters) {
      const title = displaySafeText(c.title ?? `Chapter ${c.index}`)
      lines.push(`${formatVideoTimestamp(c.startSeconds)} - ${formatVideoTimestamp(c.endSeconds)}  ${title}`)
    }
  }
  if (subtitleStreams.length > 0) {
    lines.push('')
    lines.push('Subtitle/caption streams:')
    for (const s of subtitleStreams) {
      const parts = [s.codec ?? 'unknown codec', s.language ?? 'unknown language', s.title ?? null].filter((p) => p !== null).map((p) => displaySafeText(p))
      lines.push(`  stream #${s.index}: ${parts.join(', ')}`)
    }
    lines.push('(extract a subtitle stream to .vtt/.srt with ffmpeg, then use transcript/transcript-outline on it)')
  }
  const text = lines.join('\n')
  out(text)
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('video_chapters', bytesSaved, savedTokensFromBytes(bytesSaved))
}

export function cmdSharepointResolve(url: string): void {
  const parsed = parseShareUrl(url)
  const result = resolveLocalPath(parsed)
  if (result.resolvedPath !== null) {
    out(result.resolvedPath)
    return
  }
  const lines = [
    `could not resolve a local synced copy for: ${displaySafeText(redactUrlQuery(url))}`,
    `tried:`,
    ...result.triedPaths.map((p) => `  ${displaySafePath(p)}`),
    result.triedPaths.length === 0
      ? '  (no OneDrive sync root found -- OneDrive may not be installed/signed in on this machine)'
      : '',
  ].filter((l) => l !== '')
  out(lines.join('\n'))
}

export async function cmdXlsxSheets(file: string, opts: { json?: boolean } = {}): Promise<void> {
  const sheets = await xlsxListSheets(file)
  const text = opts.json === true ? displaySafeJson(sheets.map((s) => ({ name: fenceFileFieldIfMatched(s.name), ref: s.ref, rows: s.rows, cols: s.cols }))) : fenceFileText(sheets.map((s) => `${s.name}  ${s.ref}  (${s.rows} rows x ${s.cols} cols)`).join('\n'))
  out(text)
  recordXlsxStat('xlsx_sheets', file, text)
}

export async function cmdXlsxHead(file: string, opts: { sheet?: string; rows?: string; columns?: string }): Promise<void> {
  const rows = opts.rows !== undefined ? requireNonNegativeInt('--rows', opts.rows) : 20
  const columns = opts.columns
    ? opts.columns.split(',').map((c) => c.trim()).filter(Boolean)
    : undefined
  const text = fenceFileText(await xlsxHeadSheet(file, opts.sheet, rows, columns))
  out(text)
  recordXlsxStat('xlsx_head', file, text)
}

export async function cmdXlsxColumns(file: string, opts: { sheet?: string; head?: string; json?: boolean } = {}): Promise<void> {
  const maxRows = opts.head !== undefined ? requireNonNegativeInt('--head', opts.head) : 100
  const result = await xlsxColumns(file, opts.sheet, maxRows)
  if (opts.json === true) {
    const text = displaySafeJson({
      ...result,
      sheetName: fenceFileFieldIfMatched(result.sheetName),
      columns: result.columns.map((c) => ({ ...c, name: fenceFileFieldIfMatched(c.name), sampleValues: c.sampleValues.map(fenceFileFieldIfMatched) })),
    })
    out(text)
    recordXlsxStat('xlsx_columns', file, text)
  } else {
    const text = fenceFileText(formatXlsxColumns(result))
    out(text)
    recordXlsxStat('xlsx_columns', file, text)
  }
}

export async function cmdXlsxRange(file: string, opts: { sheet?: string; range: string; formulas?: boolean }): Promise<void> {
  const result = await xlsxRangeSheet(file, opts.sheet, opts.range, opts.formulas === true)
  const text = fenceFileText(formatXlsxRange(result))
  out(text)
  recordXlsxStat('xlsx_range', file, text)
}

export async function cmdXlsxQuery(file: string, opts: { sheet?: string; columns?: string; where?: string[]; head?: string; json?: boolean }): Promise<void> {
  const columns = opts.columns
    ? opts.columns
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined
  const wheres = parseWhereSpecs(opts.where)
  const result = await xlsxQuerySheet(file, opts.sheet, {
    ...(columns !== undefined ? { columns } : {}),
    ...(wheres !== undefined ? { wheres } : {}),
    ...(opts.head !== undefined ? { head: requireNonNegativeInt('--head', opts.head) } : {}),
  })
  if (opts.json === true) {
    const rowsJson = result.rows.map((r) => Object.fromEntries(result.header.map((h, i) => [h, fenceFileFieldIfMatched(r[i] ?? '')])))
    const headTruncated = result.rows.length < result.totalRows
    const capped = guardJsonRows(rowsJson)
    const text = displaySafeJson(
      {
        items: capped.items,
        truncated: capped.truncated || headTruncated,
        totalCount: result.totalRows,
        ...(result.totalRows === 0 && result.preFilterRows > 0 ? { filteredFromRows: result.preFilterRows } : {}),
      },
      0,
    )
    out(text)
    recordXlsxStat('xlsx_query', file, text)
  } else {
    const text = fenceFileText(formatCsvTable(result, (opts.where ?? []).map((w) => `--where ${w}`)))
    out(text)
    recordXlsxStat('xlsx_query', file, text)
  }
}

export async function cmdPptxOutline(file: string, opts: { json?: boolean }): Promise<void> {
  const slides = await pptxOutline(file)
  const text =
    opts.json === true
      ? displaySafeJson(slides.map((s) => ({ ...s, title: fenceFileFieldIfMatched(s.title) })))
      : fenceFileText(
          slides
            .map((s) => `${s.slide}. ${s.title || '(untitled)'}  [${s.bodyChars} body chars${s.hasNotes ? ', has notes' : ''}]`)
            .join('\n'),
        )
  out(text)
  recordDocStat('pptx_outline', file, text)
}

export async function cmdPptxSlide(file: string, opts: { slide: string; notes?: boolean }): Promise<void> {
  const n = requireNonNegativeInt('--slide', opts.slide)
  const text = fenceFileText(await pptxSlideText(file, n, opts.notes === true))
  out(text)
  recordDocStat('pptx_slide', file, text)
}

export async function cmdPptxNotes(file: string, opts: { slide?: string }): Promise<void> {
  const n = opts.slide !== undefined ? requireNonNegativeInt('--slide', opts.slide) : undefined
  const text = await pptxNotesText(file, n)
  const printed = text.length > 0 ? fenceFileText(text) : 'no speaker notes found'
  out(printed)
  recordDocStat('pptx_notes', file, printed)
}

export async function cmdPptxText(file: string, opts: { grep: string }): Promise<void> {
  const matches = await pptxTextGrep(file, opts.grep)
  if (matches.length === 0) {
    out('no matches')
    return
  }
  const text = fenceFileText(matches.map((m) => `Slide ${m.slide}: ...${m.snippet}...`).join('\n'))
  out(text)
  recordDocStat('pptx_text', file, text)
}

export async function cmdDocxOutline(file: string, opts: { json?: boolean }): Promise<void> {
  const headings = await docxOutline(file)
  if (headings.length === 0) {
    if (opts.json === true) {
      out(displaySafeJson([]))
    } else {
      out('no headings found (try docx-text for full body text)')
    }
    return
  }
  const text =
    opts.json === true
      ? displaySafeJson(headings.map((h) => ({ ...h, text: fenceFileFieldIfMatched(h.text) })))
      : fenceFileText(headings.map((h) => `${'  '.repeat(h.level - 1)}${h.text}`).join('\n'))
  out(text)
  recordDocStat('docx_outline', file, text)
}

export async function cmdDocxTables(file: string, opts: { table?: string; json?: boolean }): Promise<void> {
  const tableIdx = opts.table !== undefined ? parseInt(opts.table, 10) : undefined
  if (tableIdx !== undefined && (Number.isNaN(tableIdx) || tableIdx < 1)) {
    throw new CliError(`--table must be a positive integer, got: ${opts.table}`)
  }
  const tables = await docxTables(file)
  if (tables.length === 0) {
    if (opts.json === true) {
      out(displaySafeJson([]))
    } else {
      out('no tables found in document')
    }
    return
  }

  const selected = tableIdx !== undefined
    ? tables.filter((t) => t.tableIndex === tableIdx)
    : tables

  if (selected.length === 0) {
    throw new CliError(`table ${tableIdx} not found (document has ${tables.length} table${tables.length === 1 ? '' : 's'})`)
  }

  if (opts.json === true) {
    const fenced = selected.map((t) => ({ ...t, rows: t.rows.map((r) => r.map(fenceFileFieldIfMatched)) }))
    const text = displaySafeJson(tableIdx !== undefined ? fenced[0] : fenced)
    out(text)
    recordDocStat('docx_tables', file, text)
    return
  }

  const text = fenceFileText(formatDocxTables(tables, tableIdx !== undefined ? { tableIndex: tableIdx } : undefined))
  out(text)
  recordDocStat('docx_tables', file, text)
}

export async function cmdDocxText(
  file: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string },
): Promise<void> {
  const text = redactSecrets(await docxText(file)).text
  const printed = _applyFiltersAndPrint(text, opts, true, UNTRUSTED_FILE_TAG)
  recordDocStat('docx_text', file, printed)
}

export function cmdTranscriptOutline(file: string, opts: { json?: boolean }): void {
  const cues = readTranscript(file)
  if (cues.length === 0) {
    if (opts.json === true) {
      out(displaySafeJson({ durationSeconds: 0, speakers: [], markers: [] }))
    } else {
      out('no cues found (not a valid .vtt/.srt file?)')
    }
    return
  }
  const outline = buildTranscriptOutline(cues)
  let text: string
  if (opts.json === true) {
    text = displaySafeJson(outline)
  } else {
    const lines = [`Duration: ${formatTimestamp(outline.durationSeconds)}  (${cues.length} cues)`]
    if (outline.speakers.length > 0) {
      lines.push('', 'Speakers:', ...outline.speakers.map((s) => `  ${displaySafeText(s.name)}  (${s.cueCount} cues)`))
    }
    lines.push('', 'Markers:', ...outline.markers.map((m) => `  [${m.timestamp}] ${displaySafeText(m.preview)}`))
    text = lines.join('\n')
  }
  out(text)
  recordDocStat('transcript_outline', file, text)
}

export function cmdTranscript(file: string, opts: { speaker?: string; from?: string; to?: string; grep?: string }): void {
  const cues = readTranscript(file)
  const sliceOpts = parseSliceOptions(opts)
  const sliced = sliceTranscript(cues, sliceOpts)
  if (sliced.length === 0) {
    out('no cues match')
    return
  }
  const text = fenceFileText(formatCues(sliced))
  out(text)
  recordDocStat('transcript', file, text)
}
