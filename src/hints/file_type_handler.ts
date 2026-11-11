/** Universal large-file interception for non-code, non-markdown file types. Dispatches based on file extension and content length to provide targeted hints for PDFs, HTML, plain text, office binaries, CSV/TSV, and a generic catch-all for unrecognized large files. */

import { findHtmlHeadingMatches } from '../languages/common.js'
import { fenceUntrustedFileContent } from '../injection_scan.js'
import { loadConfig } from '../config.js'
import { redactSecrets } from '../secret_redact.js'
import { canQuoteArg, fencedCommand, quotedArg, quotedArgs, xmlQueryExamples, xmlXPathQueryCommand } from '../hint_suggestion_guard.js'
import { displaySafePath } from '../paths.js'

export interface FileTypeResult {
  shouldBlock: boolean
  message: string
}

/** A symbol spanning more lines than this (or more than half its file) is too big to recommend for a whole-body `read "file::Symbol"`: the model would get back nearly the whole file under a symbol-shaped name. Hint text should point at a `grep -C --symbol` slice or `scope file:line` instead. */
export const LARGE_SYMBOL_LINE_THRESHOLD = 200

/** The line window the large-text deny names as the first runnable Read, and the window a repeated deny delivers. */
export const TXT_WINDOW_LINES = 200

/** Size thresholds (bytes) — configurable via config but these are defaults. */
export const FILE_TYPE_THRESHOLDS = {
  pdf: 0,              // always intercept (any size)
  html: 50_000,
  txt: 20_000,
  log: 10_000,
  svg: 8_000,
  xml: 20_000,
  dtsx: 20_000,
  ampkg: 20_000,
  xaml: 20_000,
  csv: 10_000,
  tsv: 10_000,
  json: 20_000,
  yaml: 20_000,
  jsonl: 20_000,
  transcript: 10_000,
  office: 0,           // always block (.docx etc)
  sqlite: 0,           // always block (.db, .sqlite, etc)
  parquet: 0,          // always block (.parquet)
  generic: 100_000,    // catch-all for unrecognized large files
} as const

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n < 1_099_511_627_776) return `${(n / 1_073_741_824).toFixed(1)} GB`
  return `${(n / 1_099_511_627_776).toFixed(1)} TB`
}

// The caller (hooks_read.ts) skips reading files above SLICE_ESTIMATE_SCAN_CAP_BYTES and passes an empty `content` with the real size as `contentLengthHint` instead -- so an empty `content` alongside a nonzero effective length means "too large to scan", not "genuinely empty file". Content-derived stats (line/row counts, headings, minified-detection) would otherwise silently report false zeros in that case instead of the honest "not scanned" this helper produces.
function previewUnavailable(content: string, effectiveLength: number): boolean {
  return content.length === 0 && effectiveLength > 0
}

/** Advice for a file whose content shape (e.g. one long minified/base64 line) makes any line-based offset/limit window meaningless — point at raw byte sampling instead. */
export function BYTE_RANGE_ADVICE(filePath: string): string {
  return (
    `This file is mostly one long line (e.g. base64 or minified content) — offset/limit ` +
    `line-windowing won't shrink a read here. Sample raw bytes instead, e.g.: ` +
    `dd if=${quotedArg(filePath)} bs=1 skip=<N> count=<M> status=none`
  )
}

/** What the host's Read tool accepts, as far as the hook can cite it. `pages` is Claude Code's Read parameter for PDFs ("1-5", at most 20 pages per request, required above 10 pages); a host not known to take it keeps the text that says Read cannot return a PDF. */
export interface FileTypeHost {
  readTakesPages?: boolean
}

/** The page range the PDF deny names for a host whose Read takes `pages`. */
export const PDF_PAGES_EXAMPLE = '1-5'

/** Claude Code's Read takes at most this many PDF pages per request. */
export const PDF_PAGES_MAX = 20

/** PDF handler — always blocks regardless of size. */
export function handlePdf(filePath: string, contentLength: number, host: FileTypeHost = {}): FileTypeResult {
  const [quoted, range] = quotedArgs(filePath, '<range>')
  const verdict = host.readTakesPages === true
    ? `PDF file (${formatBytes(contentLength)}) — Read returns PDF pages only through its pages parameter: retry Read with pages ${quotedArg(PDF_PAGES_EXAMPLE)} (at most ${PDF_PAGES_MAX} pages per request).`
    : `PDF file (${formatBytes(contentLength)}) — Read cannot return PDF content; this is not retryable with different Read parameters.`
  return {
    shouldBlock: true,
    message: [
      verdict,
      `Inspect first: token-goat pdf-meta ${quoted} and token-goat pdf-outline ${quoted}`,
      `Then extract relevant pages: token-goat pdf-extract ${quoted} --pages ${range}`,
    ].join('\n'),
  }
}

/** HTML handler — blocks when file exceeds threshold. */
export function handleHtml(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.html) return { shouldBlock: false, message: '' }

  const quotedPath = quotedArg(displaySafePath(filePath))
  const htmlQueryHints =
    `Use ${fencedCommand(`token-goat html-outline ${quotedPath}`)} for structure, or extract inline JavaScript ` +
    `with ${fencedCommand(`token-goat html-query ${quotedPath} script --content`)}, or CSS with ` +
    `${fencedCommand(`token-goat html-query ${quotedPath} style --content`)}`

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: `Large HTML file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap). ${htmlQueryHints}, or use token-goat section to extract a section by heading, or convert to text: pandoc ${quotedPath} -t plain`,
    }
  }

  const title = content.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
  // Route through the shared findHtmlHeadingMatches helper (same one html.ts/liquid.ts/ section_reader.ts use) rather than a hand-rolled regex, so a heading-shaped tag sitting inside a <!-- comment -->, <script> body, or CDATA section is masked out first instead of being reported as a live heading.
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
      message: `HTML file appears minified (${formatBytes(length)}). ${htmlQueryHints}. Consider fetching the source or converting with: pandoc ${quotedPath} -t plain`,
    }
  }

  return {
    shouldBlock: true,
    message: [
      // Title and headings are verbatim file bytes spliced into a message the harness attributes to token-goat, so they are fenced as untrusted data.
      `Large HTML file (${formatBytes(length)}).`,
      title || headings.length > 0
        ? fenceUntrustedFileContent(
            [title ? `Title: ${title}` : '', headings.length > 0 ? `Headings:\n${headings.join('\n')}` : '']
              .filter(Boolean)
              .join('\n'),
          )
        : '',
      `${htmlQueryHints}, or use token-goat section to extract a section by heading, or convert to text: pandoc ${quotedPath} -t plain`,
    ].filter(Boolean).join('\n'),
  }
}

/** Bytes read from the head of a text file too large to scan, to size the window a deny names: the window is capped by the deny threshold's half (10,000 bytes at most), so the first lines that fill it always sit inside this head. */
export const TEXT_PREFIX_PROBE_BYTES = 256 * 1024

/** Start offset of every line in `buf`, splitting on CRLF, LF and a lone CR as the slice scan and the indexer count lines. A terminator at the very end opens no further (empty) line. */
export function textLineStarts(buf: Buffer): number[] {
  const starts: number[] = []
  if (buf.length === 0) return starts
  starts.push(0)
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]
    if (byte === 0x0d && buf[i + 1] === 0x0a) i++
    else if (byte !== 0x0a && byte !== 0x0d) continue
    if (i + 1 < buf.length) starts.push(i + 1)
  }
  return starts
}

/** Byte bounds of line `index` (0-based) of a `textLineStarts` index: `end` is where its text stops, `next` where the following line starts (the end of `buf` for the last line). */
export function textLineBounds(buf: Buffer, starts: readonly number[], index: number): { start: number; end: number; next: number } {
  const start = starts[index] ?? 0
  const next = index + 1 < starts.length ? (starts[index + 1] ?? buf.length) : buf.length
  let end = next
  if (end > start && buf[end - 1] === 0x0a) {
    end--
    if (end > start && buf[end - 1] === 0x0d) end--
  } else if (end > start && buf[end - 1] === 0x0d) {
    end--
  }
  return { start, end, next }
}

/** A private-key header still in the redacted text: its block was never closed in the bytes held, so the lines after it may be key material. */
const UNMATCHED_KEY_HEADER_RE = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/

/** The whole text redacted once with its line breaks kept, as bytes plus their line index, so a caller cuts lines from text in which a secret spanning the cut is already gone. Null (show no lines) when redaction throws or returns a non-string, leaves a private-key header unmatched, or changes the line count from `lineCount`. */
export function redactedLineView(text: string, lineCount: number): { buf: Buffer; starts: number[] } | null {
  try {
    const redacted = redactSecrets(text, loadConfig(), { keepLineCount: true }).text
    if (typeof redacted !== 'string' || UNMATCHED_KEY_HEADER_RE.test(redacted)) return null
    const buf = Buffer.from(redacted, 'utf8')
    const starts = textLineStarts(buf)
    return starts.length === lineCount ? { buf, starts } : null
  } catch {
    return null
  }
}

/** How many leading lines the deny names as its first runnable window: up to TXT_WINDOW_LINES, fewer when the file's lines are long enough that those lines alone would reach the deny threshold again (the named Read would be refused by the very gate that named it). Lines are sized in bytes with their real terminators, from the scanned content or, for a file too large to scan, from `head` (its first TEXT_PREFIX_PROBE_BYTES); with neither the line length is unknown and the window is one line. */
export function txtWindowLines(content: string, length: number, threshold: number, head?: Buffer): number {
  const buf = previewUnavailable(content, length) ? head : Buffer.from(content, 'utf8')
  if (buf === undefined || buf.length === 0) return 1
  const starts = textLineStarts(buf)
  const usable = buf.length < length && starts.length > 1 ? starts.length - 1 : starts.length
  const budget = Math.floor(threshold / 2)
  let bytes = 0
  let lines = 0
  for (let i = 0; i < usable; i++) {
    const { start, next } = textLineBounds(buf, starts, i)
    bytes += next - start
    if (lines >= TXT_WINDOW_LINES || (lines > 0 && bytes > budget)) break
    lines++
  }
  return Math.max(1, lines)
}

/** Plain text / log handler — blocks when file exceeds threshold. */
export function handleTxt(filePath: string, content: string, contentLengthHint?: number, head?: Buffer): FileTypeResult {
  const length = contentLengthHint ?? content.length
  // Match /logs/ or \logs\ so Windows-native backslash-separated absolute paths (this tool's primary deployment target) get the same log-specific recall hint as POSIX paths.
  const isLog = /\.(log|out|err|trace)$/i.test(filePath) || /[\\/]logs[\\/]/.test(filePath)
  const threshold = isLog ? FILE_TYPE_THRESHOLDS.log : FILE_TYPE_THRESHOLDS.txt
  if (length < threshold) return { shouldBlock: false, message: '' }

  // `bash-output <id>` errors for a file read directly off disk (never went through the bash-output cache, so there is no id) -- `--file "<path>"` is the working form, matching hooks_read.ts's sessionArtifactRecall for the same on-disk-but-uncached situation.
  const [quotedLog, errorPattern] = quotedArgs(filePath, 'error|ERROR')
  const windowLines = txtWindowLines(content, length, threshold, head)
  const firstWindow = `Read with offset 1 and limit ${windowLines}, or \`token-goat read ${quotedArg(`${filePath}@1-${windowLines}`)}\``
  const recall = isLog
    ? `Log file — use ${firstWindow}, or: token-goat bash-output --file ${quotedLog} --tail 100 --grep ${errorPattern}`
    : `Use ${firstWindow} for the first ${windowLines} lines, then raise offset for the next window.`

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: `Large text file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).\n${recall}`,
    }
  }

  // Content-sniff: if the content looks like HTML despite the .txt/.log extension, delegate to handleHtml -- but only take its result when it actually decides to block. handleHtml re-gates independently on the higher html threshold, so a file that's already past handleTxt's own (lower) threshold but below handleHtml's would otherwise lose its hint entirely and read through silently. Fall back to the standard plain-text preview below in that case.
  const contentSniff = content.slice(0, 1000)
  if (/^\s*<!DOCTYPE\s+html|^\s*<html[\s>]/i.test(contentSniff)) {
    const htmlResult = handleHtml(filePath, content, contentLengthHint)
    if (htmlResult.shouldBlock) return htmlResult
  }
  // Lines split on CRLF, LF and a lone CR like the slice scan and the indexer, and a trailing terminator opens no empty last line, so the reported total is the real line count and the last-5 preview is not a blank line.
  const buf = Buffer.from(content, 'utf8')
  const starts = textLineStarts(buf)
  const lineCount = starts.length
  // The whole content is redacted before the first and last lines are cut from it, so a key whose BEGIN and END fall on either side of the cut is still seen whole; with no safe redacted view the line preview is left out and the rest of the message stays.
  const view = redactedLineView(content, lineCount)
  const shownLine = (index: number): string => {
    if (view === null) return ''
    const { start, end } = textLineBounds(view.buf, view.starts, index)
    return view.buf.subarray(start, end).toString('utf8')
  }
  const preview = view === null
    ? `... (${lineCount.toLocaleString()} lines total; line preview withheld) ...`
    : [
        '--- first 5 lines ---',
        ...Array.from({ length: Math.min(5, lineCount) }, (_, i) => shownLine(i)),
        `... (${lineCount.toLocaleString()} lines total) ...`,
        '--- last 5 lines ---',
        ...Array.from({ length: Math.min(5, lineCount) }, (_, i) => shownLine(Math.max(0, lineCount - 5) + i)),
      ].join('\n')

  return {
    shouldBlock: true,
    // The preview is verbatim file bytes, so it is fenced as untrusted data.
    message: `Large text file (${formatBytes(length)}, ${lineCount.toLocaleString()} lines).\n${fenceUntrustedFileContent(preview)}\n\n${recall}`,
  }
}

/** SVG handler — blocks when file exceeds threshold (8 KB) to prevent coordinate flooding. */
export function handleSvg(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.svg) return { shouldBlock: false, message: '' }
  const groupQuery = xmlXPathQueryCommand(filePath, '//g[@id]')

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: [
        `Large SVG file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).`,
        `Inspect structure: token-goat xml-outline ${quotedArg(filePath)}`,
        `Query layers/elements with XPath: ${groupQuery}`,
      ].join('\n'),
    }
  }

  const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch ? titleMatch[1]?.trim() : ''

  const groupIds: string[] = []
  const idRegex = /<g[^>]*\bid=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = idRegex.exec(content)) !== null && groupIds.length < 10) {
    if (match[1]) groupIds.push(match[1])
  }

  const preview = [
    title ? `Title: ${title}` : '',
    groupIds.length > 0 ? `Layer/Group IDs: ${groupIds.join(', ')}` : '',
  ].filter(Boolean).join('\n')

  const [labelPattern, labelGlob] = quotedArgs('<text>', filePath)
  return {
    shouldBlock: true,
    message: [
      `Large SVG/diagram file (${formatBytes(length)}) — raw coordinate paths flood context.`,
      preview ? fenceUntrustedFileContent(preview) : '',
      `Inspect structure: token-goat xml-outline ${quotedArg(filePath)}`,
      `Query elements with XPath: ${groupQuery}`,
      `Search text labels: token-goat grep ${labelPattern} --glob ${labelGlob}`,
    ].filter(Boolean).join('\n'),
  }
}

/** XML handler — blocks when file exceeds threshold (20 KB). Supports XML, DTSX (SSIS), AMPKG (workflow packages), XAML. */
export function handleXml(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'xml'
  const threshold = ext === 'dtsx' || ext === 'ampkg' || ext === 'xaml' ? FILE_TYPE_THRESHOLDS[ext] : FILE_TYPE_THRESHOLDS.xml
  if (length < threshold) return { shouldBlock: false, message: '' }

  const queries = xmlQueryExamples(filePath)
  const typeLabel = ext === 'dtsx' ? 'SSIS package XML (.dtsx)' : ext === 'ampkg' ? 'workflow package XML (.ampkg)' : ext === 'xaml' ? 'XAML (.xaml)' : 'XML'

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: [
        `Large ${typeLabel} file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).`,
        `Inspect structure: ${queries.outline}`,
        `Query nodes: ${queries.path} (dot path) or ${queries.xpath} (XPath)`,
      ].join('\n'),
    }
  }

  return {
    shouldBlock: true,
    message: [
      `Large ${typeLabel} file (${formatBytes(length)}).`,
      `Inspect hierarchy: ${queries.outline}`,
      `Query specific elements: ${queries.path} (dot path) or ${queries.xpath} (XPath)`,
    ].join('\n'),
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
      `Extract content first: pandoc ${quotedArg(displaySafePath(filePath))} -t plain -o ${quotedArg(displaySafePath(filePath + '.txt'))}`,
      `Then read the extracted .txt file.`,
    ].join('\n'),
  }
}

/** Excel handler — always blocks, redirects to the xlsx-* command family. */
export function handleXlsx(filePath: string): FileTypeResult {
  const [quoted, sheet] = quotedArgs(filePath, '<name>')
  return {
    shouldBlock: true,
    message: [
      `Excel file — Read cannot return spreadsheet content; this is not retryable with different Read parameters.`,
      `List sheets: token-goat xlsx-sheets ${quoted}`,
      `Then preview a sheet: ${fencedCommand(`token-goat xlsx-head ${quoted} --sheet ${sheet}`)}, or filter rows: ${fencedCommand(`token-goat xlsx-query ${quoted} --sheet ${sheet} --where col=value`)}`,
    ].join('\n'),
  }
}

/** PowerPoint handler — always blocks, redirects to the pptx-* command family. */
export function handlePptx(filePath: string): FileTypeResult {
  const [quoted, slide] = quotedArgs(filePath, '<n>')
  return {
    shouldBlock: true,
    message: [
      `PowerPoint file — Read cannot return slide content; this is not retryable with different Read parameters.`,
      `List slides: token-goat pptx-outline ${quoted}`,
      `Then read one slide: token-goat pptx-slide ${quoted} --slide ${slide}`,
    ].join('\n'),
  }
}

/** Word handler — always blocks, redirects to the docx-* command family. */
export function handleDocx(filePath: string): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `Word file — Read cannot return document content; this is not retryable with different Read parameters.`,
      `See headings: token-goat docx-outline ${quotedArg(filePath)}`,
      `Extract tables: token-goat docx-tables ${quotedArg(filePath)}`,
      `Read full text: token-goat docx-text ${quotedArg(filePath)}`,
    ].join('\n'),
  }
}

/** The field count csv-parse (RFC 4180, quote and escape `"`, no trimming) reads in the first record of a header line holding no `\n`, where a lone `\r` ends a record; a quoted field may hold the delimiter ("Full Name, Preferred"). The naive `split(sep)` count where csv-parse throws: a quote inside an unquoted field, a closing quote not followed by the delimiter, an unclosed quote, or a later record of another width. Counted here so the hook never loads csv-parse (about 60 KB) for one header line; tests/csv_header_field_count.test.ts pins it against csv-parse. */
export function csvFieldCount(line: string, sep: string): number {
  const n = line.length
  let first = 0
  let fields = 1
  let atStart = true
  let i = 0
  while (i < n) {
    const c = line[i]!
    if (c === '"') {
      if (!atStart) return line.split(sep).length
      i++
      for (;;) {
        if (i >= n) return line.split(sep).length
        if (line[i] === '"') {
          if (line[i + 1] !== '"') break
          i++
        }
        i++
      }
      i++
      if (i < n && line[i] !== sep && line[i] !== '\r') return line.split(sep).length
      atStart = false
    } else if (c === '\r') {
      i++
      if (first === 0) first = fields
      else if (fields !== first) return line.split(sep).length
      if (i >= n) return first
      fields = 1
      atStart = true
    } else {
      atStart = c === sep
      if (atStart) fields++
      i++
    }
  }
  if (first !== 0 && fields !== first) return line.split(sep).length
  return first === 0 ? fields : first
}

/** The delimiter a .csv header is counted and named with: the one of `,` tab `;` `|` it holds most often, ties to `,` (then tab, `;`, `|`). */
function csvDelimiter(header: string): string {
  let best = ','
  let bestCount = header.split(best).length - 1
  for (const candidate of ['\t', ';', '|']) {
    const count = header.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/** A header name the `--columns` value may carry: a letter, digit or `_` first, then letters, digits, `_`, `.` or `-`. An allowlist, so a space, quote, comma, carriage return or candidate delimiter (`;`, `|`, tab) keeps a name out, and so does prose: a space is out too, or `Ignore previous instructions` would pass. */
const SAFE_COLUMN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** limit: the joined `--columns` value, in characters, kept short enough for one printed command line. revisit-when: a real header needs more than 500 characters of --columns to be named. */
const MAX_COLUMNS_ARG_LENGTH = 500

/** The header's column names as one `--columns` value, or null when the command must read every column. The naive split has to agree with csvFieldCount on the width, and every name must match {@link SAFE_COLUMN_NAME}, so no name holds a delimiter csv-query sniffs and the comma split names the columns it would read. The joined value stays within {@link MAX_COLUMNS_ARG_LENGTH} and {@link canQuoteArg}. */
function csvHeaderColumns(headers: string, sep: string, colCount: number): string | null {
  const names = headers.replace(/^\uFEFF/, '').replace(/\r$/, '').split(sep)
  if (names.length !== colCount) return null
  if (names.some((n) => !SAFE_COLUMN_NAME.test(n))) return null
  const columns = names.join(',')
  if (columns.length > MAX_COLUMNS_ARG_LENGTH) return null
  return canQuoteArg(columns) ? columns : null
}

/** The `csv-query` command a CSV deny prints: runnable as written, with the header's columns when they can be named and no `--where`, which needs a real value the hook has no reason to pick. `--head 20` is the first slice the reader can widen. */
function csvQueryCommand(filePath: string, columns: string | null): string {
  if (columns === null) return `token-goat csv-query ${quotedArg(filePath)} --head 20`
  return `token-goat csv-query ${quotedArg(filePath)} --columns ${quotedArg(columns)} --head 20`
}

/** CSV/TSV handler — blocks when file exceeds threshold. */
export function handleCsv(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  // Extension-aware: FILE_TYPE_THRESHOLDS.tsv is a distinct, independently configurable knob from .csv's, so it must be selected the same way the delimiter below is.
  const threshold = filePath.toLowerCase().endsWith('.tsv') ? FILE_TYPE_THRESHOLDS.tsv : FILE_TYPE_THRESHOLDS.csv
  const length = contentLengthHint ?? content.length
  if (length < threshold) return { shouldBlock: false, message: '' }

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: [
        `Large CSV file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).`,
        `Use ${csvQueryCommand(filePath, null)} to query narrow slices.`,
      ].join('\n'),
    }
  }

  const lines = content.split('\n').filter(l => l.trim())
  const headers = lines[0] ?? ''
  const sampleRows = lines.slice(1, 4)
  // Case-insensitive: dispatchFileTypeHandler routes .csv/.tsv by a lowercased extension but passes the original-case filePath through, so an uppercase .TSV must still be recognized here or it silently gets the wrong separator.
  const tsv = filePath.toLowerCase().endsWith('.tsv')
  const sep = tsv ? '\t' : csvDelimiter(headers)
  const colCount = csvFieldCount(headers, sep)
  // Only a header split by the file's own separator (tab for .tsv, comma for .csv) is named in --columns.
  const columns = sep === (tsv ? '\t' : ',') ? csvHeaderColumns(headers, sep, colCount) : null

  return {
    shouldBlock: true,
    message: [
      `Large CSV file (${formatBytes(length)}, ~${lines.length.toLocaleString()} rows, ${colCount} ${colCount === 1 ? 'column' : 'columns'}).`,
      // Header row and sample rows are verbatim file bytes, so they are fenced as untrusted data.
      fenceUntrustedFileContent(`Columns: ${headers}\nSample rows:\n${sampleRows.join('\n')}`),
      `Use ${csvQueryCommand(filePath, columns)} to query narrow slices.`,
    ].join('\n'),
  }
}

/** WebVTT/SRT transcript handler — blocks when file exceeds threshold. */
export function handleTranscript(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.transcript) return { shouldBlock: false, message: '' }
  const [quoted, speaker] = quotedArgs(filePath, 'Name')

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: [
        `Transcript file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).`,
        `See structure: token-goat transcript-outline ${quotedArg(filePath)}`,
        `Slice by speaker/time/pattern: token-goat transcript ${quoted} --speaker ${speaker} --from 00:05:00 --to 00:10:00 --grep pattern`,
      ].join('\n'),
    }
  }

  const speakerMatches = [...content.matchAll(/^<v(?:\.\w+)?\s+([^>]+)>/gm)].map((m) => m[1]?.trim() ?? '')
  const speakers = [...new Set(speakerMatches)].slice(0, 10)
  const cueCount = (content.match(/-->/g) ?? []).length

  return {
    shouldBlock: true,
    message: [
      // Speaker names are verbatim file bytes, so they are fenced as untrusted data.
      `Transcript file (${formatBytes(length)}, ~${cueCount} cues).`,
      speakers.length > 0 ? fenceUntrustedFileContent(`Speakers: ${speakers.join(', ')}`) : '',
      `See structure: token-goat transcript-outline ${quotedArg(filePath)}`,
      `Slice by speaker/time/pattern: token-goat transcript ${quoted} --speaker ${speaker} --from 00:05:00 --to 00:10:00 --grep pattern`,
    ].filter(Boolean).join('\n'),
  }
}

/** SQLite handler — always blocks regardless of size, redirects to sqlite-* commands. */
export function handleSqlite(filePath: string): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `SQLite database — Read cannot return binary database content; this is not retryable with different Read parameters.`,
      `See tables: token-goat sqlite-tables ${quotedArg(filePath)}`,
      `See schema: token-goat sqlite-schema ${quotedArg(filePath)}`,
      `Query data: token-goat sqlite-query ${quotedArgs(filePath, 'SELECT ... FROM ... LIMIT 20').join(' ')}`,
    ].join('\n'),
  }
}

/** `p` as it can sit inside the SQL string of the DuckDB hint, which is a single-quoted SQL literal inside a double-quoted shell argument: only a path holding no quote of either kind, no `$`, backtick or backslash, and no character displaySafePath would escape is written there, and any other is `<file>`, which the reader fills in. A drive-letter path is checked with its backslashes turned to forward slashes first, the spelling DuckDB opens on Windows too, since Claude Code hands Read a Windows path as `C:\\u2026` and that would otherwise never be named. */
function sqlLiteralPath(p: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(p) ? p.replaceAll('\\', '/') : p
  return displaySafePath(path) === path && !/['"$`\\\u2018-\u201E]/.test(path) ? path : '<file>'
}

/** Parquet handler — always blocks regardless of size. */
export function handleParquet(filePath: string): FileTypeResult {
  return {
    shouldBlock: true,
    message: [
      `Parquet file — Read cannot return binary columnar content; this is not retryable with different Read parameters.`,
      `Query with DuckDB: duckdb -c "SELECT * FROM read_parquet('${sqlLiteralPath(filePath)}') LIMIT 10"`,
    ].join('\n'),
  }
}

/** JSON handler — blocks when file exceeds threshold. */
export function handleJson(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.json) return { shouldBlock: false, message: '' }
  const [quoted, query] = quotedArgs(filePath, '<path>')

  const isSpill = /(?:^|[/\\])content\.json$/i.test(filePath) || /[/\\](?:tmp|temp)[/\\]/i.test(filePath)
  const spillHeader = isSpill
    ? `This file appears to be an oversized tool output spill (${formatBytes(length)}). Do not read it whole with Read/read_file.`
    : `Large JSON file (${formatBytes(length)}).`

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: [
        isSpill
          ? `This file appears to be an oversized tool output spill (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).`
          : `Large JSON file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap).`,
        `See structure: token-goat json-outline ${quotedArg(filePath)}`,
        `Query subtree: token-goat json-query ${quoted} ${query}`,
        isSpill ? `Slice spill: token-goat mcp-output --file ${quoted} --json-query ${query}` : '',
      ].filter(Boolean).join('\n'),
    }
  }

  let summary = ''
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
      summary = `JSON array (${parsed.length} items)`
      if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const itemKeys = Object.keys(parsed[0]).slice(0, 10)
        summary += `, item keys: ${itemKeys.join(', ')}${Object.keys(parsed[0]).length > 10 ? '...' : ''}`
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed).slice(0, 15)
      summary = `Top-level keys (${Object.keys(parsed).length}): ${keys.join(', ')}${Object.keys(parsed).length > 15 ? '...' : ''}`
    }
  } catch {
    // Malformed JSON or unparseable
  }

  return {
    shouldBlock: true,
    message: [
      spillHeader,
      summary ? fenceUntrustedFileContent(summary) : '',
      `See structure: token-goat json-outline ${quotedArg(filePath)}`,
      `Query subtree: token-goat json-query ${quoted} ${query}`,
      isSpill ? `Slice spill: token-goat mcp-output --file ${quoted} --json-query ${query}` : '',
    ].filter(Boolean).join('\n'),
  }
}

/** YAML handler — blocks when file exceeds threshold. */
export function handleYaml(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.yaml) return { shouldBlock: false, message: '' }

  return {
    shouldBlock: true,
    message: [
      `Large YAML file (${formatBytes(length)}).`,
      `See structure: token-goat yaml-outline ${quotedArg(filePath)}`,
      `Query subtree: token-goat yaml-query ${quotedArgs(filePath, '<path>').join(' ')}`,
    ].join('\n'),
  }
}

/** JSON Lines (JSONL) handler — blocks when file exceeds threshold. */
export function handleJsonl(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  const length = contentLengthHint ?? content.length
  if (length < FILE_TYPE_THRESHOLDS.jsonl) return { shouldBlock: false, message: '' }

  if (previewUnavailable(content, length)) {
    return {
      shouldBlock: true,
      message: `Large JSON Lines file (${formatBytes(length)}) — too large to preview (exceeds the in-hook scan cap). Slice records with Read using offset and limit (each line is a single JSON record).`,
    }
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0)
  let schema = ''
  if (lines.length > 0) {
    try {
      const firstObj = JSON.parse(lines[0]!)
      if (typeof firstObj === 'object' && firstObj !== null && !Array.isArray(firstObj)) {
        const keys = Object.keys(firstObj).slice(0, 15)
        schema = `Record keys: ${keys.join(', ')}${Object.keys(firstObj).length > 15 ? '...' : ''}`
      }
    } catch {
      // not strict JSON on first line
    }
  }

  return {
    shouldBlock: true,
    message: [
      `Large JSON Lines file (${formatBytes(length)}, ~${lines.length} records).`,
      schema ? fenceUntrustedFileContent(schema) : '',
      `Slice records with Read using offset and limit (each line is a single JSON record), e.g. offset=1, limit=5.`,
    ].filter(Boolean).join('\n'),
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

/** Main dispatcher — call this from hooks_read.ts. Returns null for .md/.mdx/.markdown/.rst files (handled upstream by the markdown handler). Returns a FileTypeResult for all other file types. @param filePath — absolute file path @param content — file content as UTF-8 string (empty for binary files) @param contentLengthHint — optional file size in bytes (used for binary files where content is not read) */
export function dispatchFileTypeHandler(
  filePath: string,
  content: string,
  contentLengthHint?: number,
  host: FileTypeHost = {},
  head?: Buffer,
): FileTypeResult | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

  // Markdown/RST handled upstream — return null so the caller skips this result
  if (['md', 'mdx', 'markdown', 'rst'].includes(ext)) return null

  const effectiveLength = contentLengthHint ?? content.length

  if (ext === 'pdf') return handlePdf(filePath, effectiveLength, host)
  if (ext === 'svg') return handleSvg(filePath, content, effectiveLength)
  if (['xml', 'dtsx', 'ampkg', 'xaml'].includes(ext)) return handleXml(filePath, content, effectiveLength)
  if (['html', 'htm', 'xhtml'].includes(ext)) return handleHtml(filePath, content, effectiveLength)
  if (['txt', 'log', 'out', 'err', 'trace'].includes(ext)) return handleTxt(filePath, content, effectiveLength, head)
  if (ext === 'xlsx') return handleXlsx(filePath)
  if (ext === 'pptx') return handlePptx(filePath)
  if (ext === 'docx') return handleDocx(filePath)
  if (['odt', 'ods', 'ott', 'odp'].includes(ext)) return handleOfficeBinary(filePath)
  if (['sqlite', 'db', 'sqlite3', 'db3'].includes(ext)) return handleSqlite(filePath)
  if (ext === 'parquet') return handleParquet(filePath)
  if (ext === 'csv' || ext === 'tsv') return handleCsv(filePath, content, effectiveLength)
  if (ext === 'vtt' || ext === 'srt') return handleTranscript(filePath, content, effectiveLength)
  if (ext === 'json') return handleJson(filePath, content, effectiveLength)
  if (['yaml', 'yml'].includes(ext)) return handleYaml(filePath, content, effectiveLength)
  if (ext === 'jsonl') return handleJsonl(filePath, content, effectiveLength)

  // Generic catch-all
  return handleGenericLarge(filePath, effectiveLength)
}
