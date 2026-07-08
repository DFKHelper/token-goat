/**
 * Shared ZIP+XML core for OOXML formats (.pptx, .docx are both a ZIP container of XML parts).
 * pptx_extract.ts and docx_extract.ts both build on this rather than each reimplementing
 * zip-reading and text-run collection. Follows the loadPdfjs() optional-dependency template:
 * module-level cache typed T | null | undefined, try/catch import, graceful "not installed"
 * error on first real use.
 */

import * as fs from 'node:fs'

interface FflateModule {
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>
}

interface XmlParserCtor {
  new (opts?: Record<string, unknown>): { parse: (xml: string) => unknown }
}

interface FastXmlParserModule {
  XMLParser: XmlParserCtor
}

let _fflateCache: FflateModule | null | undefined
let _fxpCache: FastXmlParserModule | null | undefined

async function loadFflate(): Promise<FflateModule | null> {
  if (_fflateCache !== undefined) return _fflateCache
  try {
    _fflateCache = (await import('fflate')) as unknown as FflateModule
  } catch (err) {
    process.stderr.write(`token-goat: office-file reading disabled (fflate unavailable): ${String(err)}\n`)
    _fflateCache = null
  }
  return _fflateCache
}

async function loadXmlParser(): Promise<FastXmlParserModule | null> {
  if (_fxpCache !== undefined) return _fxpCache
  try {
    _fxpCache = (await import('fast-xml-parser')) as unknown as FastXmlParserModule
  } catch (err) {
    process.stderr.write(`token-goat: office-file reading disabled (fast-xml-parser unavailable): ${String(err)}\n`)
    _fxpCache = null
  }
  return _fxpCache
}

/** Reads a .pptx/.docx file and returns its ZIP entries as path -> decompressed bytes. */
export async function readOoxmlZip(filePath: string): Promise<Record<string, Uint8Array>> {
  const fflate = await loadFflate()
  if (!fflate) throw new Error('fflate is not installed; run `npm install fflate` to enable this command')
  const data = fs.readFileSync(filePath)
  return fflate.unzipSync(new Uint8Array(data))
}

/** Decodes one ZIP entry as UTF-8 text, or null if the entry doesn't exist. */
export function decodeZipEntry(entries: Record<string, Uint8Array>, path: string): string | null {
  const bytes = entries[path]
  if (bytes === undefined) return null
  return new TextDecoder('utf-8').decode(bytes)
}

/** Parses one XML part's text into a plain object tree via fast-xml-parser. */
export async function parseOoxmlPart(xmlText: string): Promise<unknown> {
  const fxp = await loadXmlParser()
  if (!fxp) throw new Error('fast-xml-parser is not installed; run `npm install fast-xml-parser` to enable this command')
  const parser = new fxp.XMLParser({ ignoreAttributes: false, preserveOrder: false })
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
        }
        if (val !== null && typeof val === 'object') walk(val)
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
