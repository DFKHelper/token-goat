/** CLI command registration for file formats: PDF, Office, Structured Data, SQLite, Media, and Text utilities. */

import type { Command } from 'commander'
import { loadConfig } from './config.js'
import { displaySafeJson } from './paths.js'
import { recordStat } from './stats.js'
import { cappedSourceBytesSaved } from './util.js'
import { visionTokensSavedByText } from './image_shrink.js'
import { runImageMeta, runImageText, runConfigGet, runSqliteTables, runSqliteSchema, runSqliteQuery } from './read_commands.js'
import { isSupportedOcrLang, SUPPORTED_OCR_LANG_CODES } from './ocr_languages.js'
import { fenceUntrustedOcrText } from './injection_scan.js'
import { scanAndRecord, injectionFencingEnabled } from './untrusted_fence.js'
import { out, CliError } from './cli.js'
import { runExit } from './cli_dispatch.js'
import { cmdFetchImage } from './config_commands.js'
import { cmdScreenshot } from './cli_diagnostics.js'
import {
  cmdDocxOutline,
  cmdDocxTables,
  cmdDocxText,
  cmdPdfExtract,
  cmdPdfLocate,
  cmdPdfMeta,
  cmdPdfOutline,
  cmdPptxNotes,
  cmdPptxOutline,
  cmdPptxSlide,
  cmdPptxText,
  cmdSharepointResolve,
  cmdTranscript,
  cmdTranscriptOutline,
  cmdVideoChapters,
  cmdXlsxColumns,
  cmdXlsxHead,
  cmdXlsxQuery,
  cmdXlsxRange,
  cmdXlsxSheets,
  fileSizeOrZero,
} from './cli_office.js'
import {
  cmdCsvProfile,
  cmdCsvQuery,
  cmdHtmlLint,
  cmdHtmlOutline,
  cmdHtmlQuery,
  cmdJsonOutline,
  cmdJsonQuery,
  cmdOpenApiOp,
  cmdOpenApiOutline,
  cmdXmlOutline,
  cmdXmlQuery,
  cmdYamlOutline,
  cmdYamlQuery,
  cmdZipList,
  cmdZipRead,
} from './cli_structured.js'
import { cmdInsertSection, cmdReplace, cmdWriteFile } from './cli_file_ops.js'

export type GuardFn = (fn: (...a: never[]) => void | Promise<void>) => (...args: unknown[]) => Promise<void>

export function fenceOcrText(text: string): string {
  if (!injectionFencingEnabled()) return text
  scanAndRecord(text)
  return fenceUntrustedOcrText(text)
}

export async function cmdImageMeta(file: string, opts: { json?: boolean } = {}) {
  const meta = await runImageMeta(file)
  if (!meta.decodable) {
    const msg = 'image-meta unavailable (not a format token-goat can read)'
    const text = opts.json === true
      ? displaySafeJson({ bytes: meta.bytes, decodable: false, error: msg })
      : `Size: ${meta.bytes} bytes\n${msg}`
    out(text)
    return
  }
  // Three outcomes, not two. A header probe reads webp and tiff, which the re-encoder has no decoder for, so folding that case into "no benefit" told the reader a 3000x3000 webp was already optimal.
  const shrinkLine = meta.wouldShrink && meta.shrunkBytes !== null
    ? `Shrink: would save ${meta.bytes - meta.shrunkBytes} bytes (${meta.bytes} -> ${meta.shrunkBytes})`
    : !meta.shrinkable
      ? `Shrink: not attempted (token-goat re-encodes png, jpeg, bmp and gif; this is ${meta.format ?? 'an unknown format'})`
      : 'Shrink: no benefit (already small/optimal)'
  const lines = [
    `Dimensions: ${meta.width}x${meta.height}`,
    `Format: ${meta.format ?? '(unknown)'}`,
    `Size: ${meta.bytes} bytes`,
    shrinkLine,
  ]
  const text = opts.json === true ? displaySafeJson(meta) : lines.join('\n')
  out(text)
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('image_meta', bytesSaved, visionTokensSavedByText(meta.width, meta.height, Buffer.byteLength(text, 'utf8'), loadConfig().image_shrink.vision_tier))
}

export async function cmdImageText(file: string, opts: { json?: boolean; lang?: string } = {}) {
  if (opts.lang) {
    const tokens = opts.lang.split(/[+,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    const invalid = tokens.filter((t) => !isSupportedOcrLang(t))
    if (invalid.length > 0) {
      throw new CliError(`unsupported OCR language(s) '${invalid.join(', ')}'; must be from: ${SUPPORTED_OCR_LANG_CODES.join(', ')}`)
    }
  }
  const result = await runImageText(file, opts.lang)
  if (!result.ocrAvailable) {
    const msg = 'image-text unavailable (install tesseract.js to use this feature)'
    const text = opts.json === true ? displaySafeJson({ ocrAvailable: false, error: msg }) : msg
    out(text)
    return
  }
  let text: string
  if (opts.json === true) {
    text = displaySafeJson(
      result.text === null ? result : { ...result, text: fenceOcrText(result.text) },
    )
  } else {
    const lines = [`Confidence: ${Math.round(result.confidence)}%`, `Characters: ${result.chars}`]
    text = result.textHeavy && result.text !== null
      ? `${lines.join('\n')}\n\n${fenceOcrText(result.text)}`
      : `${lines.join('\n')}\n(below usefulness threshold; text likely noise, not shown)`
  }
  out(text)
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('image_text', bytesSaved, visionTokensSavedByText(null, null, Buffer.byteLength(text, 'utf8'), loadConfig().image_shrink.vision_tier))
}

export function cmdSqliteTables(file: string, opts: { json?: boolean }) {
  process.exitCode = runSqliteTables({ file, ...opts })
}

export function cmdSqliteSchema(file: string, opts: { json?: boolean }) {
  process.exitCode = runSqliteSchema({ file, ...opts })
}

export function cmdSqliteQuery(file: string, sql: string, opts: { head?: string; json?: boolean }) {
  process.exitCode = runSqliteQuery({ file, sql, ...opts })
}

export function registerFormatCommands(program: Command, guard: GuardFn): void {
  program
    .command('config-get <file> <key>')
    .description('read one value from a config file (TOML/JSON/YAML/INI)')
    .action((file: string, key: string) => runExit(() => runConfigGet({ file, key })))

  program
    .command('fetch-image <url>')
    .description('fetch a remote image URL to a local shrunk file')
    .option('--out <path>', 'destination path for the shrunk image (default: temp file)')
    .option('-j, --json', 'output as JSON')
    .action((url: string, opts: { out?: string; json?: boolean }) =>
      guard(() => cmdFetchImage({ url, ...(opts.out !== undefined ? { out: opts.out } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('pdf-extract <file>')
    .description('extract plain text from a PDF (optionally --pages N or N-M) instead of a raw Read')
    .option('--pages <spec>', 'page range to extract, e.g. 1-5 or 3 (default: all pages)')
    .option('--layout', 'heuristic column-aware reading-order reconstruction from text-item coordinates (imperfect on rotated/overlapping text)')
    .option('--head <n>', 'show only the first N lines')
    .option('--tail <n>', 'show only the last N lines')
    .option('--grep <pattern>', 'filter to lines matching this regex')
    .option('--section <heading>', 'extract one markdown section by heading')
    .option('--max-matches <n>', 'cap the number of --grep matches shown')
    .action(guard(cmdPdfExtract))

  program
    .command('pdf-locate <file> <pattern>')
    .description(
      'find which pages of a PDF match a regex, with a snippet per match, so you can pdf-extract only those pages instead of the whole document',
    )
    .option('-i, --ignore-case', 'case-insensitive matching')
    .option('--max-matches <n>', 'stop after this many page matches (default: 50)')
    .option('--context <n>', 'snippet length in characters around each match (default: 80)')
    .option('--pages <spec>', 'page range to scan, e.g. 1-5 or 3 (default: all pages)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPdfLocate))

  program
    .command('pdf-outline <file>')
    .description('list a PDF\'s bookmark/outline tree with page numbers instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPdfOutline))

  program
    .command('pdf-meta <file>')
    .description('page count, title/author, and whether a PDF has an extractable text layer')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPdfMeta))

  program
    .command('image-meta <file>')
    .description('dimensions, byte size, format, and what a shrink would cost -- image metadata only, never runs OCR')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdImageMeta))

  program
    .command('image-text <file>')
    .description('OCR text for an image instead of a raw Read, honest about low-confidence results')
    .option('--lang <lang>', 'OCR language code (e.g. eng, fra, spa)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdImageText))

  program
    .command('sharepoint-resolve <shareUrl>')
    .description('best-effort resolve a SharePoint/OneDrive sharing URL to a local synced file path (no network call)')
    .action(guard(cmdSharepointResolve))

  program
    .command('video-chapters <file>')
    .description('list a video\'s embedded chapter markers and subtitle streams via ffprobe, instead of downloading/transcoding it')
    .action(guard(cmdVideoChapters))

  program
    .command('xlsx-sheets <file>')
    .description('list sheet names + used range/dimensions in an Excel workbook instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdXlsxSheets))

  program
    .command('xlsx-head <file>')
    .description('preview the header + first N rows of one sheet instead of a raw Read')
    .option('--sheet <name>', 'sheet name (default: first sheet, see xlsx-sheets)')
    .option('--rows <n>', 'number of data rows to show (default 20)')
    .option('--columns <a,b,c>', 'comma-separated column names or letters to project (default: all)')
    .action(guard(cmdXlsxHead))

  program
    .command('xlsx-columns <file>')
    .description('column names, letters, fill rates, and sample values instead of a raw Read')
    .option('--sheet <name>', 'sheet name (default: first sheet, see xlsx-sheets)')
    .option('--head <n>', 'max rows to sample for fill rates and distinct values (default: 100)')
    .option('--json', 'emit column summaries as JSON')
    .action(guard(cmdXlsxColumns))

  program
    .command('xlsx-range <file>')
    .description('extract one cell range (e.g. A1:D50) from a sheet instead of a raw Read')
    .option('--sheet <name>', 'sheet name (default: first sheet, see xlsx-sheets)')
    .requiredOption('--range <a1-notation>', 'cell range, e.g. A1:D50')
    .option('--formulas', 'show formulas instead of computed values where present')
    .action(guard(cmdXlsxRange))

  program
    .command('xlsx-query <file>')
    .description('project columns / filter rows from one sheet instead of a raw Read')
    .option('--sheet <name>', 'sheet name (default: first sheet, see xlsx-sheets)')
    .option('--columns <a,b,c>', 'comma-separated columns to project (default: all)')
    .option(
      '--where <spec>',
      'filter, repeatable (ANDed): col=value, col!=value, col>value, col<value, col~=regex',
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option('--head <n>', 'max rows to show')
    .option('--json', 'emit rows as a JSON array of objects instead of a table')
    .action(guard(cmdXlsxQuery))

  program
    .command('pptx-outline <file>')
    .description('per-slide title + body size + notes flag instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPptxOutline))

  program
    .command('pptx-slide <file>')
    .description('full text of one slide instead of a raw Read')
    .requiredOption('--slide <n>', 'slide number (see pptx-outline)')
    .option('--notes', 'include this slide\'s speaker notes')
    .action(guard(cmdPptxSlide))

  program
    .command('pptx-notes <file>')
    .description('speaker notes for one slide, or all slides, instead of a raw Read')
    .option('--slide <n>', 'slide number (default: all slides)')
    .action(guard(cmdPptxNotes))

  program
    .command('pptx-text <file>')
    .description('find slides whose text matches a pattern instead of a raw Read')
    .requiredOption('--grep <pattern>', 'regex to search slide text for')
    .action(guard(cmdPptxText))

  program
    .command('docx-outline <file>')
    .description('heading tree of a Word document instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdDocxOutline))

  program
    .command('docx-tables <file>')
    .description('extract tables from a Word document instead of a raw Read')
    .option('--table <n>', 'show only the Nth table (1-based index)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdDocxTables))

  program
    .command('docx-text <file>')
    .description('full body text of a Word document instead of a raw Read')
    .option('--head <n>', 'show only the first N lines')
    .option('--tail <n>', 'show only the last N lines')
    .option('--grep <pattern>', 'filter to lines matching this regex')
    .option('--section <heading>', 'extract one markdown section by heading')
    .option('--max-matches <n>', 'cap the number of --grep matches shown')
    .action(guard(cmdDocxText))

  program
    .command('transcript-outline <file>')
    .description('speaker list, duration, and time-bucketed markers for a WebVTT/SRT transcript instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdTranscriptOutline))

  program
    .command('transcript <file>')
    .description('slice a WebVTT/SRT transcript by speaker/time range/pattern instead of a raw Read')
    .option('--speaker <name>', 'only cues from this speaker')
    .option('--from <hh:mm:ss>', 'only cues starting at or after this time')
    .option('--to <hh:mm:ss>', 'only cues starting at or before this time')
    .option('--grep <pattern>', 'only cues whose text matches this regex')
    .action(guard(cmdTranscript))

  program
    .command('csv-query <file>')
    .description('project columns / filter rows from a CSV instead of a raw Read')
    .option('--columns <cols>', 'comma-separated column names to include (default: all)')
    .option(
      '--where <spec>',
      'filter, repeatable (ANDed): col=value, col!=value, col>value, col<value, col~=regex',
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option('--head <n>', 'limit to the first N matching rows')
    .option('--json', 'emit rows as a JSON array of objects instead of CSV')
    .option('--delimiter <char>', 'field delimiter (default: ,)')
    .option('--no-header', 'treat the first row as data, not a header (columns become col1, col2, ...)')
    .action(guard(cmdCsvQuery))

  program
    .command('csv-profile <file>')
    .description('per-column type/null/distinct/range summary of a CSV instead of a raw Read')
    .option('--delimiter <char>', 'field delimiter (default: ,)')
    .option('--no-header', 'treat the first row as data, not a header (columns become col1, col2, ...)')
    .action(guard(cmdCsvProfile))

  program
    .command('json-outline <file>')
    .description('structural summary of a JSON document (array shape / object key types) instead of a raw Read')
    .option('--json', 'emit the outline as JSON instead of text')
    .option('--filter <text>', 'list only the top-level keys containing TEXT (case-insensitive), with a count of how many matched')
    .action(guard(cmdJsonOutline))

  program
    .command('json-query <file> <path>')
    .description(
      "extract one value or a projected/filtered subset from a JSON document by dot-path instead of a raw Read\n\n" +
        "path grammar: dot-separated keys with optional bracket segments -- [n] index, [*] wildcard " +
        '(projects every element/value), [field=value] filter (keeps array elements whose field ' +
        "stringifies to value), [\"key\"] for a key holding a dot or space. Examples: data.items[3].name, items[*].id, items[status=active], [\"a.b\"].c",
    )
    .option('--head <n>', 'limit a projected/filtered result to the first N items')
    .option('--json', 'emit the result as JSON instead of text')
    .action(guard(cmdJsonQuery))

  program
    .command('yaml-outline <file>')
    .description('structural summary of a YAML document (array shape / object key types) instead of a raw Read -- multi-document streams (---separated) outline as an array of documents')
    .option('--json', 'emit the outline as JSON instead of text')
    .option('--filter <text>', 'list only the top-level keys containing TEXT (case-insensitive), with a count of how many matched')
    .action(guard(cmdYamlOutline))

  program
    .command('yaml-query <file> <path>')
    .description(
      "extract one value or a projected/filtered subset from a YAML document by dot-path instead of a raw Read (same grammar as json-query)\n\n" +
        "path grammar: dot-separated keys with optional bracket segments -- [n] index, [*] wildcard " +
        '(projects every element/value), [field=value] filter (keeps array elements whose field ' +
        "stringifies to value), [\"key\"] for a key holding a dot or space. Examples: spec.containers[0].image, items[*].name, items[kind=Service]",
    )
    .option('--head <n>', 'limit a projected/filtered result to the first N items')
    .option('--json', 'emit the result as JSON instead of text')
    .action(guard(cmdYamlQuery))

  program
    .command('xml-outline <file>')
    .description('structural summary of an XML document (element hierarchy / attribute names / child counts) instead of a raw Read')
    .option('--json', 'emit the outline as JSON instead of text')
    .option('--max-depth <n>', 'max depth of element hierarchy to show')
    .option('--depth <n>', 'alias for --max-depth')
    .action(guard(cmdXmlOutline))

  program
    .command('xml-query <file> [path]')
    .description(
      "extract elements or attributes from an XML document by tag path or XPath expression instead of a raw Read\n\n" +
        "path grammar: slash- or dot-separated tag names with optional bracket segments and attribute selectors -- " +
        "[n] index, [*] wildcard, [@attr] or [@attr=value] filter, and trailing @attr to extract attribute value. " +
        "Bracket clauses stack and apply left to right, so an index after a filter counts within the filtered set. " +
        "A clause may also be a comparison, contains() or starts-with() on an attribute or text(), joined with and/or; a clause outside that set, such as not(), matches nothing rather than being ignored, so you get an empty result instead of the unfiltered list. " +
        "Examples: root.child, catalog/book[@id=101]/title, catalog/book[@genre=Fantasy][0], /feed/entry[*]/@href, //DTS:Executable[@DTS:ExecutableType='...']",
    )
    .option('--head <n>', 'limit a matching result list to the first N items')
    .option('--xpath <expression>', 'query using an XPath expression')
    .option('--with-lines', 'show exact source line numbers for matched nodes')
    .option('--decode-embedded-xml', 'decode and format embedded entity-encoded XML/AML in text and attributes')
    .option('--json', 'emit the result as JSON instead of text')
    .action(guard(cmdXmlQuery))

  program
    .command('html-outline <file>')
    .description('structural summary of an HTML document (title, doctype, landmarks, headings, tables, forms, scripts, styles) instead of a raw Read')
    .option('--json', 'emit the outline as JSON instead of text')
    .action(guard(cmdHtmlOutline))

  program
    .command('html-query <file> <selector>')
    .description(
      'extract elements, text, or attributes from an HTML document by CSS selector instead of a raw Read\n\n' +
        'selector grammar: tags, #id, .class, [attr=val], child (>), descendant (space), comma-separated union, or trailing @attr. ' +
        'Examples: #main, .inquiry-row, table > tbody > tr, a[href^="https"], div@id',
    )
    .option('--head <n>', 'limit a matching result list to the first N items')
    .option('--json', 'emit the result as JSON instead of text')
    .option('--text', 'extract only the inner text of matching elements')
    .option('--attr <name>', 'extract the value of the specified attribute')
    .action(guard(cmdHtmlQuery))

  program
    .command('html-lint <file>')
    .description('validate HTML structure (unclosed tags, stray closing tags, unescaped angle brackets, duplicate IDs, tag balance)')
    .option('--json', 'emit the lint report as JSON instead of text')
    .option('--strict', 'treat warnings as errors (exit code 1)')
    .action(guard(cmdHtmlLint))

  program
    .command('openapi-outline <file>')
    .description('per-operation listing (method, path, operationId, summary, tags) of an OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML) instead of a raw Read')
    .option('--json', 'emit the operation list as JSON instead of text')
    .action(guard(cmdOpenApiOutline))

  program
    .command('openapi-op <file> <operation>')
    .description(
      'full detail (parameters, request body schema, response schemas, description) for exactly one OpenAPI operation instead of a raw Read\n\n' +
        "operation may be an operationId (exact match) or a \"METHOD path\" spec, e.g. \"GET /users/{id}\"",
    )
    .option('--json', 'emit the operation detail as JSON instead of text')
    .action(guard(cmdOpenApiOp))

  program
    .command('zip-list <archive>')
    .description(
      'entry paths and sizes inside a zip-format archive (.zip/.jar/.whl/.vsix/.nupkg are all zip containers under the hood) ' +
        'instead of a raw Read or an unzip -l shell-out',
    )
    .option('--json', 'emit the entry list as JSON instead of text')
    .action(guard(cmdZipList))

  program
    .command('zip-read <archive> <entry>')
    .description(
      "extract and print exactly one entry's text content from a zip-format archive by its in-archive path instead of extracting the whole archive to disk",
    )
    .option('--json', 'emit the entry content as JSON instead of text')
    .action(guard(cmdZipRead))

  program
    .command('sqlite-tables <file>')
    .description('compact inventory of tables and views with row counts and column counts instead of a raw Read')
    .option('--json', 'emit the table inventory as JSON instead of text')
    .action(guard(cmdSqliteTables))

  program
    .command('sqlite-schema <file>')
    .description('tables/views, columns, indexes, foreign keys, and row counts of a SQLite database instead of a raw Read')
    .option('--json', 'emit the schema as JSON instead of text')
    .action(guard(cmdSqliteSchema))

  program
    .command('sqlite-query <file> <sql>')
    .description('run a read-only SELECT against a SQLite database instead of a raw Read or shelling out to sqlite3 -- rejects any non-SELECT statement')
    .option('--head <n>', 'limit to the first N returned rows')
    .option('--json', 'emit rows as a JSON array of objects instead of a table')
    .action(guard(cmdSqliteQuery))

  program
    .command('screenshot <url> <destPath>')
    .description('capture a local headless-browser screenshot, shrunk the same way local image reads are')
    .option('--executable-path <path>', 'Chrome/Chromium executable to launch (overrides config/auto-detect)')
    .option('--width <n>', 'viewport width in pixels (default: 1280)')
    .option('--height <n>', 'viewport height in pixels (default: 800)')
    .option('--full-page', 'capture the full scrollable page instead of just the viewport')
    .action(guard(cmdScreenshot))

  program
    .command('write-file <dest>')
    .description('write exact bytes to a file — handles backticks, quotes, $vars, CRLF without escaping\n\nModes: --b64 PAYLOAD (base64), --from SOURCE (copy file), or piped stdin')
    .option('--from <source>', 'copy bytes from this source file instead of stdin/base64')
    .option('--b64 <payload>', 'decode base64 payload and write to dest')
    .action(guard(cmdWriteFile))

  program
    .command('replace <file>')
    .description('replace one string in a file; supply old/new text via --old-from/--new-from or --old-b64/--new-b64, and use --all to replace every occurrence')
    .option('--old-from <source>', 'read the old text from this source file')
    .option('--new-from <source>', 'read the new text from this source file')
    .option('--old-b64 <payload>', 'base64 payload for the old text')
    .option('--new-b64 <payload>', 'base64 payload for the new text')
    .option('--all', 'replace every occurrence instead of requiring a unique match')
    .option(
      '--normalize-newlines',
      'convert the old/new text\'s line endings (CRLF/LF) to match the target file\'s dominant line ending before matching, instead of requiring a byte-exact line-ending match',
    )
    .action(guard(cmdReplace))

  program
    .command('insert-section <file>')
    .description(
      'insert content immediately after a matched section (spec resolved the same way as `section`: exact heading, or an unambiguous prefix), avoiding a stale byte-exact anchor for append-to-a-running-log edits',
    )
    .requiredOption('--after <heading>', 'heading text (or unambiguous prefix) to insert after')
    .option('--content-from <source>', 'read the content to insert from this source file')
    .option('--content-b64 <payload>', 'base64 payload for the content to insert')
    .action(guard(cmdInsertSection))
}
