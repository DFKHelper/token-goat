/**
 * Universal large-file interception for non-code, non-markdown file types.
 *
 * Dispatches based on file extension and content length to provide
 * targeted hints for PDFs, HTML, plain text, office binaries, CSV/TSV,
 * and a generic catch-all for unrecognized large files.
 */

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
  const headings = [...content.matchAll(/<h([1-6])[^>]*>([^<]+)<\/h\1>/gi)]
    .slice(0, 20)
    .map(m => {
      const level = m[1]
      const text = m[2]
      if (!level || !text) return ''
      return `${'  '.repeat(Number(level) - 1)}h${level}: ${text.trim()}`
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

  const lines = content.split('\n')
  const isLog = /\.(log|out|err|trace)$/i.test(filePath) || filePath.includes('/logs/')
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

/** Office binary handler — always blocks. */
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

/** CSV/TSV handler — blocks when file exceeds threshold. */
export function handleCsv(filePath: string, content: string, contentLengthHint?: number): FileTypeResult {
  if ((contentLengthHint ?? content.length) < FILE_TYPE_THRESHOLDS.csv) return { shouldBlock: false, message: '' }

  const lines = content.split('\n').filter(l => l.trim())
  const headers = lines[0] ?? ''
  const sampleRows = lines.slice(1, 4)
  const sep = filePath.endsWith('.tsv') ? '\t' : ','
  const colCount = headers.split(sep).length

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
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'ott', 'odp'].includes(ext)) return handleOfficeBinary(filePath)
  if (ext === 'csv' || ext === 'tsv') return handleCsv(filePath, content, effectiveLength)

  // Generic catch-all
  return handleGenericLarge(filePath, effectiveLength)
}
