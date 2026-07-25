import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  collectElements,
  collectTextRuns,
  decodeZipEntry,
  parseOoxmlPart,
  readOoxmlZip,
  sortNumberedParts,
} from '../src/ooxml_extract.js'
import { buildPptxFixture } from './helpers/ooxml_fixtures.js'

describe('readOoxmlZip', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ooxml-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads a normal-sized zip', async () => {
    const file = path.join(dir, 'small.pptx')
    fs.writeFileSync(file, buildPptxFixture([{ title: 'Hello' }]))
    const entries = await readOoxmlZip(file)
    expect(Object.keys(entries)).toContain('ppt/slides/slide1.xml')
  })

  it('rejects a file over the compressed-size cap before ever unzipping it', async () => {
    const file = path.join(dir, 'huge.pptx')
    // Sparse file: fs.statSync only reads metadata, and the size guard must reject
    // before fflate.unzipSync ever reads/decompresses content (which would throw a
    // different, less useful error on invalid zip data).
    const fd = fs.openSync(file, 'w')
    fs.ftruncateSync(fd, 51 * 1024 * 1024)
    fs.closeSync(fd)
    await expect(readOoxmlZip(file)).rejects.toThrow(/over the 50MB limit/)
  })
})

describe('parseOoxmlPart / collectTextRuns', () => {
  it('preserves a whitespace-only run split at a formatting boundary instead of collapsing it away', async () => {
    // Word commonly splits a sentence across multiple <w:r> runs at a bold/italic/hyperlink
    // boundary, using a standalone xml:space="preserve" run to hold just the inter-word space.
    // fast-xml-parser's trimValues defaults to true, which would trim that run's text down to
    // an empty string with no #text key at all, silently gluing "Hello" and "world" together.
    const xml =
      '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>'
    const parsed = await parseOoxmlPart(xml)
    expect(collectTextRuns(parsed, 'w:t').join('')).toBe('Hello world')
  })
})

describe('collectElements', () => {
  // Regression: the docstring promises collectElements does not descend further into a
  // match's own subtree once it has collected that match (mirroring collectTextRuns' `else
  // if`), but the code used a bare `if` for the recursive walk call, so it unconditionally
  // re-descended into every matched node's own children too -- collecting a same-named tag
  // nested inside itself a second time as a spurious extra "match".
  it('collects only the outer match of a tag nested inside itself, not both', async () => {
    const xml = '<root><w:p id="outer"><w:p id="inner"/></w:p></root>'
    const parsed = await parseOoxmlPart(xml)
    const matches = collectElements(parsed, 'w:p')
    expect(matches).toHaveLength(1)
    expect((matches[0] as Record<string, unknown>)['@_id']).toBe('outer')
  })

  it('still collects sibling matches at different nesting depths (control: not over-pruned)', async () => {
    const xml = '<root><w:p id="a"/><wrap><w:p id="b"/></wrap></root>'
    const parsed = await parseOoxmlPart(xml)
    const matches = collectElements(parsed, 'w:p')
    expect(matches).toHaveLength(2)
    const ids = matches.map((m) => (m as Record<string, unknown>)['@_id'])
    expect(ids).toEqual(['a', 'b'])
  })
})

// Zero direct coverage before this: only exercised transitively through pptx_extract.ts /
// docx_extract.ts's higher-level tests, which never pinned decodeZipEntry's own null-vs-decoded
// contract in isolation.
describe('decodeZipEntry', () => {
  it('decodes an existing entry as UTF-8 text', () => {
    const entries = { 'ppt/slides/slide1.xml': new TextEncoder().encode('<hello/>') }
    expect(decodeZipEntry(entries, 'ppt/slides/slide1.xml')).toBe('<hello/>')
  })

  it('returns null for a path not present in the entries map', () => {
    const entries = { 'ppt/slides/slide1.xml': new TextEncoder().encode('<hello/>') }
    expect(decodeZipEntry(entries, 'ppt/slides/slide2.xml')).toBeNull()
  })

  it('decodes multi-byte UTF-8 content correctly', () => {
    const entries = { 'word/document.xml': new TextEncoder().encode('café 日本') }
    expect(decodeZipEntry(entries, 'word/document.xml')).toBe('café 日本')
  })

  it('decodes an empty entry as an empty string, distinct from a missing entry', () => {
    const entries = { 'ppt/slides/slide1.xml': new Uint8Array() }
    expect(decodeZipEntry(entries, 'ppt/slides/slide1.xml')).toBe('')
  })
})

// Zero direct coverage before this: pptx_extract.ts uses it to order ppt/slides/slideN.xml,
// but none of its own tests pin the sort-key extraction or the no-match fallback in isolation.
describe('sortNumberedParts', () => {
  it('sorts numbered parts numerically, not lexicographically', () => {
    const paths = ['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']
    expect(sortNumberedParts(paths, /slide(\d+)\.xml$/)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide10.xml',
    ])
  })

  it('sorts a path with no pattern match to the end (falls back to MAX_SAFE_INTEGER)', () => {
    const paths = ['ppt/slides/slide2.xml', 'ppt/slides/_rels/slide2.xml.rels', 'ppt/slides/slide1.xml']
    expect(sortNumberedParts(paths, /slide(\d+)\.xml$/)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/_rels/slide2.xml.rels',
    ])
  })

  it('returns an empty array unchanged', () => {
    expect(sortNumberedParts([], /slide(\d+)\.xml$/)).toEqual([])
  })
})
