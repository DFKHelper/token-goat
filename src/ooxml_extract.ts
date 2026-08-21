/**
 * Shared ZIP+XML core for OOXML formats (.pptx, .docx are both a ZIP container of XML parts).
 * pptx_extract.ts and docx_extract.ts both build on this rather than each reimplementing
 * zip-reading and text-run collection. Uses `createLazyModuleLoader` (see lazy_module.ts) for
 * the optional-dependency imports: cached lazy load, graceful "not installed" error on first
 * real use.
 */

import * as fs from 'node:fs'

import { createLazyModuleLoader } from './lazy_module.js'

interface FflateModule {
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>
}

interface XmlParserCtor {
  new (opts?: Record<string, unknown>): { parse: (xml: string) => unknown }
}

interface FastXmlParserModule {
  XMLParser: XmlParserCtor
}

const loadFflate = createLazyModuleLoader(
  async () => (await import('fflate')) as unknown as FflateModule,
  'office-file reading disabled (fflate unavailable)',
)

const loadXmlParser = createLazyModuleLoader(
  async () => (await import('fast-xml-parser')) as unknown as FastXmlParserModule,
  'office-file reading disabled (fast-xml-parser unavailable)',
)

// DEFLATE's worst-case compression ratio is ~1032:1, so capping the compressed input
// bounds unzipSync's eager, unstreamed decompression to a worst case of tens of GB
// instead of fully unbounded -- a sanity cap against a malformed/crafted file, not a
// hardened defense (a genuine zip bomb near this ratio would still be large; full
// protection needs streaming decompression with an abort threshold, out of scope here).
const MAX_OOXML_INPUT_BYTES = 50 * 1024 * 1024

/** Reads a .pptx/.docx/.xlsx file and returns its ZIP entries as path -> decompressed bytes. */
/**
 * Which of the two answers a failed open deserves. Only a genuinely absent file is "not found":
 * mapping every errno to that message told someone hitting a permission error to go looking for a
 * file that was sitting right where they left it. Kept as a function because the alternative is
 * untestable: node:fs is a frozen namespace, so the non-ENOENT branch cannot be reached by mocking,
 * and no real probe produces the same errno on every platform (a path leading through a regular
 * file is ENOTDIR on Linux and ENOENT on Windows; chmod does not deny the owner on Windows at all).
 */
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
  if (stat.size > MAX_OOXML_INPUT_BYTES) {
    throw new Error(`${filePath} is ${Math.round(stat.size / (1024 * 1024))}MB, over the ${MAX_OOXML_INPUT_BYTES / (1024 * 1024)}MB limit for OOXML files`)
  }
  let data: Buffer
  try {
    data = fs.readFileSync(filePath)
  } catch (err) {
    // The file can vanish between the stat above and this read. Classified the same way, so the
    // same situation does not get two different shapes depending on which call happened to see it.
    throw new Error(accessFailureMessage(err, filePath), { cause: err })
  }
  try {
    return fflate.unzipSync(new Uint8Array(data))
  } catch (err) {
    throw new Error(`not a valid ${kind} file: ${filePath}`, { cause: err })
  }
}

/** Decodes one ZIP entry as UTF-8 text, or null if the entry doesn't exist. */
export function decodeZipEntry(entries: Record<string, Uint8Array>, entryPath: string): string | null {
  const bytes = entries[entryPath]
  if (bytes === undefined) return null
  return new TextDecoder('utf-8').decode(bytes)
}

/** Parses one XML part's text into a plain object tree via fast-xml-parser. */
export async function parseOoxmlPart(xmlText: string): Promise<unknown> {
  const fxp = await loadXmlParser()
  if (!fxp) throw new Error('fast-xml-parser is not installed; run `npm install fast-xml-parser` to enable this command')
  // trimValues defaults to true in fast-xml-parser, which collapses a whitespace-only
  // <w:t xml:space="preserve"> </w:t> run (Word's own way of holding just the space between
  // two <w:r> runs split at a formatting boundary) down to an empty string with no #text key
  // at all -- silently gluing the words on either side together. Disable it so inter-run
  // spaces survive; callers already trim() at the paragraph/title level where it matters.
  const parser = new fxp.XMLParser({ ignoreAttributes: false, preserveOrder: false, trimValues: false })
  return parser.parse(xmlText)
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

/**
 * Collects every text-run value under `tag` (e.g. `a:t` for pptx, `w:t` for docx) anywhere in
 * the parsed XML tree, in document order. Handles both a single run (`{tag: "text"}`) and
 * repeated sibling runs (`{tag: ["a", "b"]}`, how fast-xml-parser folds consecutive same-name
 * elements) since OOXML text is split across many short runs by most editors/exporters.
 */
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

/**
 * Collects every element named `tag` anywhere in the parsed XML tree, in document order,
 * without descending further into a match's own subtree search for the same tag (OOXML
 * paragraph/run elements never nest inside themselves, so this is safe and avoids the
 * complexity of a full generic tree-diff).
 */
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
          if (Array.isArray(val)) out.push(...val)
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
