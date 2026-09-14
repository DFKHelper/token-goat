/** Shared ZIP+XML core for OOXML formats (.pptx, .docx are both a ZIP container of XML parts). pptx_extract.ts and docx_extract.ts both build on this rather than each reimplementing zip-reading and text-run collection. Uses `createLazyModuleLoader` (see lazy_module.ts) for the optional-dependency imports: cached lazy load, graceful "not installed" error on first real use. */

import * as fs from 'node:fs'

import { DocumentRefusedError, MAX_DOCUMENT_WORK_MILLIS } from './document_refusal.js'
import { createLazyModuleLoader } from './lazy_module.js'
import { pushAll } from './util.js'
import { parseXml } from './xml_parser.js'
import { MAX_ZIP_INPUT_BYTES, MAX_ZIP_OUTPUT_BYTES, unzipBounded, ZipInputTooLargeError, ZipOutputTooLargeError, type ZipStreamModule } from './zip_bounds.js'

// Every per-call bound on the pptx/xlsx path (MAX_ZIP_INPUT_BYTES, MAX_ZIP_OUTPUT_BYTES, MAX_XLSX_SCAN_CELLS) is a bound on ONE call, and a document can choose how many times a bounded operation runs: extractEmbeddableDocumentText used to call pptxSlideText/headSheet once per slide/sheet, each of which re-reads and re-inflates the WHOLE archive from scratch (pptxOutline plus an N-slide loop cost N+1 full archive reads for an N-slide deck; a slide/sheet count is exactly the kind of thing an attacker or just a large real document controls). pptxAllSlidesText and allSheetsHeadText fix the re-read by loading the archive once and reusing the parsed entries, but a document can still be wide enough that even O(1)-per-slide work adds up -- there is otherwise no wall clock anywhere on this path, unlike pdf_extract.ts's MAX_PDF_WORK_MILLIS. This mirrors that: one clock per document, checked before each slide/sheet iteration, so a crafted or just very large deck/workbook costs a bounded stall instead of a worker that never returns.
export const MAX_OOXML_WORK_MILLIS = MAX_DOCUMENT_WORK_MILLIS

/** Thrown when iterating a document's slides/sheets passes {@link MAX_OOXML_WORK_MILLIS}. A DocumentRefusedError, not a plain one, so the indexer does not re-open and re-time-out on this file on every drain -- but a transient one, because what the clock measured is this machine under this load and not the bytes: the same deck can pass the clock once the disk is quiet, so the refusal is recorded against the bound that produced it rather than as a settled verdict. */
export class OoxmlTookTooLongError extends DocumentRefusedError {
  constructor(message: string) {
    super(message, 'OoxmlTookTooLongError', true)
  }
}

/** The instant past which a bulk slide/sheet walk over one document must stop. One per document, not per slide/sheet -- opened once by the caller that starts the walk, the same way pdf_extract.ts's pdfWorkDeadline is opened once per PDF. */
export function ooxmlWorkDeadline(): number {
  return Date.now() + MAX_OOXML_WORK_MILLIS
}

/** Checked before processing each slide/sheet in a bulk walk; throws {@link OoxmlTookTooLongError} once `deadline` has passed. */
export function assertOoxmlWithinDeadline(deadline: number, hint: string): void {
  if (Date.now() > deadline) {
    throw new OoxmlTookTooLongError(`reading this document's slides/sheets passed the ${MAX_OOXML_WORK_MILLIS}ms limit. ${hint}`)
  }
}

type FflateModule = ZipStreamModule

const loadFflate = createLazyModuleLoader(
  async () => (await import('fflate')) as unknown as FflateModule,
  'office-file reading disabled (fflate unavailable)',
)

/** Reads a .pptx/.docx/.xlsx file and returns its ZIP entries as path -> decompressed bytes. */
/** Which of the two answers a failed open deserves. Only a genuinely absent file is "not found": mapping every errno to that message told someone hitting a permission error to go looking for a file that was sitting right where they left it. Kept as a function because the alternative is untestable: node:fs is a frozen namespace, so the non-ENOENT branch cannot be reached by mocking, and no real probe produces the same errno on every platform (a path leading through a regular file is ENOTDIR on Linux and ENOENT on Windows; chmod does not deny the owner on Windows at all). */
export function accessFailureMessage(err: unknown, filePath: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return `File not found: ${filePath}`
  return `could not read ${filePath} (${code ?? 'unknown error'})`
}

export async function readOoxmlZip(filePath: string, kind: '.docx' | '.pptx' | '.xlsx'): Promise<Record<string, Uint8Array>> {
  const fflate = await loadFflate()
  if (!fflate) throw new Error('fflate is not installed; run `npm install fflate` to enable this command')
  // Every failure below used to escape as the raw Node or fflate error. A missing file surfaced
  // as Node's ENOENT, which names the path it resolved rather than the one the caller typed, so
  // asking for a file by its bare name printed the reader's whole home directory back at them. A
  // directory surfaced as EISDIR, and a non-OOXML file surfaced as fflate's "invalid zip data",
  // which does not even say which file failed. The sibling xlsx reader already guards exactly
  // this (see loadWorkbook in xlsx_extract.ts, which stops jszip's internals and a docs URL
  // reaching the user); the same treatment never reached here. Both readers now answer in the
  // same two shapes, and every path in the message is the one the caller passed. One funnel, so
  // this covers docx-outline, docx-text, pptx-outline, pptx-slide, pptx-notes and pptx-text.
  // Not read off filePath: the caller knows which format it asked for, and the extension does
  // not. `docx-outline report.txt` used to answer "not a valid .txt file", naming a format
  // nobody asked about and that this reader cannot read either way.
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    throw new Error(accessFailureMessage(err, filePath), { cause: err })
  }
  if (!stat.isFile()) throw new Error(`not a valid ${kind} file: ${filePath}`)
  // ZipInputTooLargeError rather than a plain Error: a size cap is a verdict on these bytes and will hold on every future pass, so the indexer has to be able to tell it from a bad moment and stop re-reading the file. A plain Error here read as transient, and this is the reader the .docx/.pptx/.xlsx indexing path actually goes through -- the class was only ever raised from the zip-list/zip-read commands, which the indexer never calls.
  if (stat.size > MAX_ZIP_INPUT_BYTES) throw new ZipInputTooLargeError(filePath, stat.size, MAX_ZIP_INPUT_BYTES)
  let data: Buffer
  try {
    data = fs.readFileSync(filePath)
  } catch (err) {
    // The file can vanish between the stat above and this read. Classified the same way, so the
    // same situation does not get two different shapes depending on which call happened to see it.
    throw new Error(accessFailureMessage(err, filePath), { cause: err })
  }
  try {
    return unzipBounded(fflate, new Uint8Array(data), { limitBytes: MAX_ZIP_OUTPUT_BYTES, shouldExtract: () => true })
  } catch (err) {
    // A ZipOutputTooLargeError already names the limit and how far over it the archive got --
    // that message is more useful than "not a valid file", which would send the reader looking
    // for a corrupt file instead of an oversized one.
    if (err instanceof ZipOutputTooLargeError) throw err
    throw new Error(`not a valid ${kind} file: ${filePath}`, { cause: err })
  }
}

/** The largest ONE XML part inside a document may be. {@link MAX_ZIP_OUTPUT_BYTES} bounds what an archive inflates to in total, at 500 MB, and says nothing about how that total is divided: a document is free to spend all of it on a single `word/document.xml`, and every reader here then decodes that part into a string and hands it to a parser that builds an object tree over it. Measured, the tree costs about 7x the XML in heap, so a part the existing caps permit is several gigabytes of nodes. A 298 KB .docx killed a 512 MB-heap process outright, and a 1.19 MB one reached 3.34 GB resident and 24 s on the default heap -- through `extractEmbeddableDocumentText`, which the indexer runs over every document in a repository nobody has read yet. 32 MB is six times the largest XML part in a corpus of 83 real documents from this machine (5.29 MB, a spreadsheet's worksheet; median 0.10 MB, p90 0.44 MB) and holds the parse tree near 230 MB at the measured ratio. */
export const MAX_OOXML_PART_BYTES = 32 * 1024 * 1024

/** Thrown when one XML part passes {@link MAX_OOXML_PART_BYTES}. A DocumentRefusedError for the same reason the zip size caps are: a part's size is a property of the file and the verdict is the same on every future pass, so the indexer must not keep re-opening it. */
export class OoxmlPartTooLargeError extends DocumentRefusedError {
  constructor(entryPath: string, bytes: number) {
    super(`${entryPath} is ${bytes} bytes, past the ${MAX_OOXML_PART_BYTES}-byte limit for one part of an office file. Split the document, or extract from a smaller copy.`, 'OoxmlPartTooLargeError')
  }
}

/** The largest total XML one document may have decoded out of it across every part its reader touches. {@link MAX_OOXML_PART_BYTES} bounds ONE part and {@link MAX_ZIP_OUTPUT_BYTES} bounds the whole archive's inflate, and neither bounds what a reader retains as parse trees AT ONCE, which is the quantity that actually decides whether the heap survives: a document chooses how many parts it declares, and every one of them a reader decodes and parses is held until the read returns. Measured, through readXlsxWorkbook: a 66,438-byte .xlsx whose workbook declares 500 `<sheet>` elements whose relationships all name one 797 KB worksheet part cost 15,150 ms and 1,511 MB resident against 64 ms and 100 MB for the same part declared once, and a 99,012-byte one declaring 5,000 killed the process outright (`Ineffective mark-compacts near heap limit`, reproduced at --max-old-space-size=1024). Deduplicating repeated parts answers that file but not its honest twin: 500 DISTINCT 797 KB worksheets, 31 MB on disk and 398 MB inflated, passes every existing cap and still cost 17,191 ms and 1,899 MB. Across 86 real Office documents on this machine the parts a reader decodes and retains at once (`xl/worksheets/*`, `ppt/slides/*`, `ppt/notesSlides/*`, `word/document.xml`, `xl/sharedStrings.xml`) came to p50 0.035 MB, p90 0.362 MB, max 5.33 MB, over at most 40 such parts in one document. 64 MB is twelve times the largest real document and holds the heap near 455 MB at this repo's measured ~7.1x parse-tree-to-XML ratio. */
export const MAX_OOXML_DOCUMENT_PART_BYTES = 64 * 1024 * 1024

/** Thrown when one document's decoded parts come to more than {@link MAX_OOXML_DOCUMENT_PART_BYTES}. Not transient, for the same reason {@link OoxmlPartTooLargeError} is not: how much XML a document declares is a property of its bytes and the sum is the same on every future pass, so the indexer records it as settled instead of re-inflating the archive on every worker drain forever. */
export class OoxmlDocumentTooLargeError extends DocumentRefusedError {
  constructor(entryPath: string, spentBytes: number, partBytes: number) {
    super(`decoding ${entryPath} (${partBytes} bytes, after ${spentBytes} already decoded) would take this office file past the ${MAX_OOXML_DOCUMENT_PART_BYTES}-byte limit on the XML one document may have decoded at once. Split the document, or extract from a smaller copy.`, 'OoxmlDocumentTooLargeError')
  }
}

/** What one document has spent of {@link MAX_OOXML_DOCUMENT_PART_BYTES} so far. A mutable object threaded through every {@link decodeZipEntry} call of one read rather than a counter each reader keeps, because decodeZipEntry is already the sole decode funnel for all three formats and a bound checked anywhere else is a bound a fourth reader can be written without. */
export interface OoxmlPartBudget {
  spent: number
}

/** Opened ONCE per document read, by whichever function opens that document's archive -- the same one-per-document shape as {@link ooxmlWorkDeadline}. One per part would bound nothing, since the whole defect is a document declaring many parts. */
export function ooxmlPartBudget(): OoxmlPartBudget {
  return { spent: 0 }
}

/** Decodes one ZIP entry as UTF-8 text, or null if the entry doesn't exist. Refuses one past {@link MAX_OOXML_PART_BYTES} rather than returning null: an oversized part is not an absent one, and every caller here reads null as "this document does not have that part" and carries on. Checked on the bytes rather than after decoding, because the decoded UTF-16 string is itself up to twice the part and is the first of the two allocations worth not making. `budget` is required rather than defaulted, because a parameter a caller may omit is one the shipping path omits while every test supplies it, leaving a green suite over a dead bound -- the injected-seam trap this repo has shipped before. */
export function decodeZipEntry(entries: Record<string, Uint8Array>, entryPath: string, budget: OoxmlPartBudget): string | null {
  const bytes = entries[entryPath]
  if (bytes === undefined) return null
  if (bytes.length > MAX_OOXML_PART_BYTES) throw new OoxmlPartTooLargeError(entryPath, bytes.length)
  if (budget.spent + bytes.length > MAX_OOXML_DOCUMENT_PART_BYTES) throw new OoxmlDocumentTooLargeError(entryPath, budget.spent, bytes.length)
  budget.spent += bytes.length
  return new TextDecoder('utf-8').decode(bytes)
}

/** Parses one XML part's text into a plain object tree. Stays `async` although `parseXml` is synchronous: every caller already awaits it, and the two pptx call sites parse a part and its `.rels` sibling concurrently. Dropping the promise would be a signature change rippling through docx_extract, pptx_extract and xlsx_reader for no gain. The parser used to be `fast-xml-parser`, loaded lazily as an optional dependency. It is now `src/xml_parser.ts`, which produces the identical shape for the options that were passed; see that file's header for why, and tests/xml_parser.test.ts for the differential test that holds the two to the same output. The historical notes below are kept because they record why those options were chosen, and the local parser is built to the same two decisions: */
export async function parseOoxmlPart(xmlText: string): Promise<unknown> {
  // trimValues defaulted to true in fast-xml-parser, which collapses a whitespace-only
  // <w:t xml:space="preserve"> </w:t> run (Word's own way of holding just the space between
  // two <w:r> runs split at a formatting boundary) down to an empty string with no #text key
  // at all -- silently gluing the words on either side together. Disable it so inter-run
  // spaces survive; callers already trim() at the paragraph/title level where it matters.
  // parseTagValue defaults to true, which rewrites any element whose whole text looks numeric
  // into a JavaScript number before the extractors ever see it. Every OOXML part these commands
  // read holds document *text*, so that conversion is pure corruption: a spreadsheet cell or a
  // Word paragraph reading `007` came back as `7`, `01234` as `1234`, `1.50` as `1.5`, `+12` as
  // `12`, `1e5` as `100000` and `0x1A` as `26` -- zip codes, part numbers, invoice ids, SKUs and
  // version strings all silently altered, with no error and nothing to show the value had changed.
  // Numbers that really are numbers are unaffected: every numeric read in these extractors goes
  // through its own Number()/parseInt() on the string, and attributes were never coerced here
  // (parseAttributeValue stayed at its default of false).
  //
  // Both decisions are now properties of the parser rather than options passed to it: it never
  // trims and never coerces, so neither can be switched back on by accident.
  return parseXml(xmlText)
}

function pushTextValue(runs: string[], val: unknown): void {
  if (Array.isArray(val)) {
    for (const v of val) pushTextValue(runs, v)
  } else if (typeof val === 'string') {
    runs.push(val)
  } else if (typeof val === 'number' || typeof val === 'boolean') {
    runs.push(String(val))
  } else if (val !== null && typeof val === 'object' && '#text' in (val as Record<string, unknown>)) {
    runs.push(String((val as Record<string, unknown>)['#text']))
  }
}

/** Collects every text-run value under `tag` (e.g. `a:t` for pptx, `w:t` for docx) anywhere in the parsed XML tree, in document order. Handles both a single run (`{tag: "text"}`) and repeated sibling runs (`{tag: ["a", "b"]}`, how fast-xml-parser folds consecutive same-name elements) since OOXML text is split across many short runs by most editors/exporters. */
export function collectTextRuns(node: unknown, tag: string): string[] {
  const runs: string[] = []
  function walk(n: unknown): void {
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (n !== null && typeof n === 'object') {
      const obj = n as Record<string, unknown>
      for (const [key, val] of Object.entries(obj)) {
        if (key === tag) {
          pushTextValue(runs, val)
        } else if (val !== null && typeof val === 'object') {
          walk(val)
        }
      }
    }
  }
  walk(node)
  return runs
}

/** Collects every element named `tag` anywhere in the parsed XML tree, in document order, without descending further into a match's own subtree search for the same tag (OOXML paragraph/run elements never nest inside themselves, so this is safe and avoids the complexity of a full generic tree-diff). */
export function collectElements(node: unknown, tag: string): unknown[] {
  const out: unknown[] = []
  function walk(n: unknown): void {
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (n !== null && typeof n === 'object') {
      const obj = n as Record<string, unknown>
      for (const [key, val] of Object.entries(obj)) {
        if (key === tag) {
          if (Array.isArray(val)) pushAll(out, val)
          else out.push(val)
        } else if (val !== null && typeof val === 'object') {
          walk(val)
        }
      }
    }
  }
  walk(node)
  return out
}

/** Sorts ZIP entry paths matching a numbered-part pattern (e.g. `ppt/slides/slideN.xml`) by N. */
export function sortNumberedParts(paths: string[], pattern: RegExp): string[] {
  return paths
    .map((p) => {
      const m = pattern.exec(p)
      return { p, n: m?.[1] !== undefined ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER }
    })
    .sort((a, b) => a.n - b.n)
    .map((x) => x.p)
}
