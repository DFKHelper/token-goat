/**
 * Universal large-file interception for non-code, non-markdown file types.
 *
 * Dispatches based on file extension and content length to provide
 * targeted hints for PDFs, HTML, plain text, office binaries, CSV/TSV,
 * and a generic catch-all for unrecognized large files.
 */

import { parse } from 'csv-parse/sync'
import { findHtmlHeadingMatches } from '../languages/common.js'

export interface FileTypeResult {
  shouldBlock: boolean
  message: string
}

/** Size thresholds (bytes) — configurable via config but these are defaults. */
export const FILE_TYPE_THRESHOLDS = {
  pdf: 0,              // always intercept (any size)
  html: 50_000,
  txt: 20_000,
  csv: 10_000,
  tsv: 10_000,
  transcript: 10_000,
  office: 0,           // always block (.docx etc)
  generic: 100_000,    // catch-all for unrecognized large files
} as const

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
}

/** Advice for a file whose content shape (e.g. one long minified/base64 line) makes any
 *  line-based offset/limit window meaningless — point at raw byte sampling instead. */
export function BYTE_RANGE_ADVICE(filePath: string): string {
  return (
    `This file is mostly one long line (e.g. base64 or minified content) — offset/limit ` +
    `line-windowing won't shrink a read here. Sample raw bytes instead, e.g.: ` +
    `dd if="${filePath}" bs=1 skip=<N> count=<M> status=none`
  )
}

/** PDF handler — always blocks regardless of size. */
export function handlePdf(filePath: string, contentLength: number): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `PDF file (${formatBytes(contentLength)}) — Read cannot return PDF content; this is not retryable with different Read parameters.`,
      `Extract text instead: token-goat pdf-extract "${filePath}"`,
    ].join('\n'),
  }
}

/** HTML handler — blocks when file exceeds threshold. */
export function handleHtml(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  if ((contentLengthHint ?? content.length) < FILE_TYPE_THRESHOLDS.html) return { shouldBlock: false, message: '' }

  const title = content.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
  // Route through the shared findHtmlHeadingMatches helper (same one html.ts/liquid.ts/
  // section_reader.ts use) rather than a hand-rolled regex, so a heading-shaped tag sitting
  // inside a <!-- comment -->, <script> body, or CDATA section is masked out first instead of
  // being reported as a live heading.
  const headings = findHtmlHeadingMatches(content)
    .slice(0, 20)
    .map(({ level, heading }) => {
      if (!heading) return ''
      return `${'  '.repeat(level - 1)}h${level}: ${heading}`
    })
    .filter(Boolean)

  const isMinified = !content.includes('\n') || (content.length > 50_000 && content.split('\n').length < 10)

  if (isMinified) {
    return {
      shouldBlock: true,
      message: `HTML file appears minified (${formatBytes(content.length)}). Consider fetching the source or converting with: pandoc "${filePath}" -t plain`,
    }
  }

  return {
    shouldBlock: true,
    message: [
      `Large HTML file (${formatBytes(content.length)})${title ? `: "${title}"` : ''}.`,
      headings.length > 0 ? `Headings:\n${headings.join('\n')}` : '',
      `Use token-goat section to extract a section by heading, or convert to text: pandoc "${filePath}" -t plain`,
    ].filter(Boolean).join('\n'),
  }
}

/** Plain text / log handler — blocks when file exceeds threshold. */
export function handleTxt(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  if ((contentLengthHint ?? content.length) < FILE_TYPE_THRESHOLDS.txt) return { shouldBlock: false, message: '' }


  // Content-sniff: if the content looks like HTML despite the .txt/.log extension, delegate to
  // handleHtml -- but only take its result when it actually decides to block. handleHtml re-gates
  // independently on the higher html threshold, so a file that's already past handleTxt's own
  // (lower) threshold but below handleHtml's would otherwise lose its hint entirely and read
  // through silently. Fall back to the standard plain-text preview below in that case.
  const contentSniff = content.slice(0, 1000)
  if (/^\s*<!DOCTYPE\s+html|^\s*<html[\s>]/i.test(contentSniff)) {
    const htmlResult = handleHtml(filePath, content, contentLengthHint)
    if (htmlResult.shouldBlock) return htmlResult
  }
  const lines = content.split('\n')
  // Match /logs/ or \logs\ so Windows-native backslash-separated absolute paths (this
  // tool's primary deployment target) get the same log-specific recall hint as POSIX paths.
  const isLog = /\.(log|out|err|trace)$/i.test(filePath) || /[\\/]logs[\\/]/.test(filePath)
  const preview = [
    '--- first 5 lines ---',
    ...lines.slice(0, 5),
    `... (${lines.length.toLocaleString()} lines total) ...`,
    '--- last 5 lines ---',
    ...lines.slice(-5),
  ].join('\n')

  const recall = isLog
    ? 'Log file — use Read with offset/limit params, or: token-goat bash-output <id> --tail 100 --grep "error|ERROR"'
    : 'Use Read with offset and limit params to sample specific line ranges.'

  return {
    shouldBlock: true,
    message: `Large text file (${formatBytes(content.length)}, ${lines.length.toLocaleString()} lines).\n${preview}\n\n${recall}`,
  }
}

/** Office binary handler — always blocks. Covers formats with no dedicated reader (odt/ods/ott/odp). */
export function handleOfficeBinary(filePath: string): FileTypeResult {
  const filename = filePath.split(/[\\/]/).pop() || '';
  const parts = filename.split('.');
  const lastPart = parts[parts.length - 1];
  const ext = (parts.length > 1 && lastPart) ? lastPart.toLowerCase() : 'bin';
  return {
    shouldBlock: true,
    message: [
      `Binary Office file (.${ext}) — cannot be read as text.`,
      `Extract content first: pandoc "${filePath}" -t plain > "${filePath}.txt"`,
      `Then read the extracted .txt file.`,
    ].join('\n'),
  }
}

/** Excel handler — always blocks, redirects to the xlsx-* command family. */
export function handleXlsx(filePath: string): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `Excel file — Read cannot return spreadsheet content; this is not retryable with different Read parameters.`,
      `List sheets: token-goat xlsx-sheets "${filePath}"`,
      `Then preview a sheet: token-goat xlsx-head "${filePath}" --sheet <name>, or filter rows: token-goat xlsx-query "${filePath}" --sheet <name> --where col=value`,
    ].join('\n'),
  }
}

/** PowerPoint handler — always blocks, redirects to the pptx-* command family. */
export function handlePptx(filePath: string): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `PowerPoint file — Read cannot return slide content; this is not retryable with different Read parameters.`,
      `List slides: token-goat pptx-outline "${filePath}"`,
      `Then read one slide: token-goat pptx-slide "${filePath}" --slide <n>`,
    ].join('\n'),
  }
}

/** Word handler — always blocks, redirects to the docx-* command family. */
export function handleDocx(filePath: string): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `Word file — Read cannot return document content; this is not retryable with different Read parameters.`,
      `See headings: token-goat docx-outline "${filePath}"`,
      `Read full text: token-goat docx-text "${filePath}"`,
    ].join('\n'),
  }
}

/** CSV/TSV handler — blocks when file exceeds threshold. */
export function handleCsv(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  // Extension-aware: FILE_TYPE_THRESHOLDS.tsv is a distinct, independently configurable knob
  // from .csv's, so it must be selected the same way the delimiter below is.
  const threshold = filePath.toLowerCase().endsWith('.tsv') ? FILE_TYPE_THRESHOLDS.tsv : FILE_TYPE_THRESHOLDS.csv
  if ((contentLengthHint ?? content.length) < threshold) return { shouldBlock: false, message: '' }

  const lines = content.split('\n').filter(l => l.trim())
  const headers = lines[0] ?? ''
  const sampleRows = lines.slice(1, 4)
  // Case-insensitive: dispatchFileTypeHandler routes .csv/.tsv by a lowercased
  // extension but passes the original-case filePath through, so an uppercase
  // .TSV must still be recognized here or it silently gets the wrong separator.
  const sep = filePath.toLowerCase().endsWith('.tsv') ? '\t' : ','
  // A naive headers.split(sep) miscounts whenever a quoted field legitimately contains the
  // delimiter (e.g. "Full Name, Preferred") - reuse the project's RFC-4180-aware csv-parse
  // (already a dependency via csv_query.ts) to parse just the header line correctly, falling
  // back to the naive split only if the header itself is malformed enough to throw.
  let colCount: number
  try {
    colCount = (parse(headers, { delimiter: sep }) as string[][])[0]?.length ?? headers.split(sep).length
  } catch {
    colCount = headers.split(sep).length
  }

  return {
    shouldBlock: true,
    message: [
      `Large CSV file (${formatBytes(content.length)}, ~${lines.length.toLocaleString()} rows, ${colCount} columns).`,
      `Columns: ${headers}`,
      `Sample rows:\n${sampleRows.join('\n')}`,
      `Use token-goat csv-query "${filePath}" --columns a,b,c --where col=value --head N to query narrow slices.`,
    ].join('\n'),
  }
}

/** WebVTT/SRT transcript handler — blocks when file exceeds threshold. */
export function handleTranscript(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.transcript) return { shouldBlock: false, message: '' }

  const speakerMatches = [...content.matchAll(/^<v(?:\.\w+)?\s+([^>]+)>/gm)].map((m) => m[1]?.trim() ?? '')
  const speakers = [...new Set(speakerMatches)].slice(0, 10)
  const cueCount = (content.match(/-->/g) ?? []).length

  return {
    shouldBlock: true,
    message: [
      `Transcript file (${formatBytes(length)}, ~${cueCount} cues)${speakers.length > 0 ? `. Speakers: ${speakers.join(', ')}` : ''}.`,
      `See structure: token-goat transcript-outline "${filePath}"`,
      `Slice by speaker/time/pattern: token-goat transcript "${filePath}" --speaker "Name" --from 00:05:00 --to 00:10:00 --grep pattern`,
    ].join('\n'),
  }
}

/** Generic catch-all for unrecognized large files. */
export function handleGenericLarge(filePath: string, contentLength: number): FileTypeResult {
  if (contentLength < FILE_TYPE_THRESHOLDS.generic) return { shouldBlock: false, message: '' }
  return {
    shouldBlock: true,
    message: `Large file (${formatBytes(contentLength)}). Use Read with offset and limit parameters to read specific line ranges rather than loading the entire file.`,
  }
}

/**
 * Main dispatcher — call this from hooks_read.ts.
 *
 * Returns null for .md/.mdx/.markdown/.rst files (handled upstream by the
 * markdown handler). Returns a FileTypeResult for all other file types.
 *
 * @param filePath — absolute file path
 * @param content — file content as UTF-8 string (empty for binary files)
 * @param contentLengthHint — optional file size in bytes (used for binary files where content is not read)
 */
export function dispatchFileTypeHandler(
  filePath: string,
  content: string,
  contentLengthHint?: number,
): FileTypeResult | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

  // Markdown/RST handled upstream — return null so the caller skips this result
  if (['md', 'mdx', 'markdown', 'rst'].includes(ext)) return null

  const effectiveLength = contentLengthHint ?? content.length

  if (ext === 'pdf') return handlePdf(filePath, effectiveLength)
  if (['html', 'htm', 'xhtml'].includes(ext)) return handleHtml(filePath, content, effectiveLength)
  if (['txt', 'log', 'out', 'err', 'trace'].includes(ext)) return handleTxt(filePath, content, effectiveLength)
  if (ext === 'xlsx') return handleXlsx(filePath)
  if (ext === 'pptx') return handlePptx(filePath)
  if (ext === 'docx') return handleDocx(filePath)
  if (['odt', 'ods', 'ott', 'odp'].includes(ext)) return handleOfficeBinary(filePath)
  if (ext === 'csv' || ext === 'tsv') return handleCsv(filePath, content, effectiveLength)
  if (ext === 'vtt' || ext === 'srt') return handleTranscript(filePath, content, effectiveLength)


  // Generic catch-all
  return handleGenericLarge(filePath, effectiveLength)
}
