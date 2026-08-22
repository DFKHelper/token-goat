import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  accessFailureMessage,
  collectElements,
  collectTextRuns,
  decodeZipEntry,
  parseOoxmlPart,
  readOoxmlZip,
  sortNumberedParts,
} from '../src/ooxml_extract.js'
import { docxOutline } from '../src/docx_extract.js'
import { pptxOutline } from '../src/pptx_extract.js'
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
    const entries = await readOoxmlZip(file, '.docx')
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
    await expect(readOoxmlZip(file, '.docx')).rejects.toThrow(/over the 50MB limit/)
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

  // fast-xml-parser's parseTagValue defaults to true, which rewrites any element whose whole
  // text looks numeric into a JavaScript number. Every part these extractors read holds document
  // text, so that turned a cell or paragraph reading `007` into `7` and `1.50` into `1.5` --
  // silent corruption of zip codes, part numbers, invoice ids and version strings, with nothing
  // in the output to show the value had been altered. Each spelling below is a separate way the
  // coercion fires, so one surviving spelling still fails here.
  it.each([
    ['a leading zero', '007'],
    ['a zip code', '01234'],
    ['exponent notation', '1e5'],
    ['a leading plus', '+12'],
    ['a hex literal', '0x1A'],
    ['a trailing decimal zero', '1.50'],
    ['a negative zero', '-0'],
    ['a number wider than a float', '12345678901234567890'],
  ])('keeps %s as the text it was written as, not a number', async (_label, text) => {
    const parsed = await parseOoxmlPart(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    expect(collectTextRuns(parsed, 'w:t').join('')).toBe(text)
  })

  it('still reads an ordinary number-shaped value as its own text (control)', async () => {
    const parsed = await parseOoxmlPart('<w:p><w:r><w:t>42</w:t></w:r></w:p>')
    expect(collectTextRuns(parsed, 'w:t').join('')).toBe('42')
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

// Every one of these used to escape as the raw underlying error. The missing-file case is the
// one that mattered most: Node's ENOENT names the path it resolved, so asking for `nope.docx`
// printed the reader's entire home directory back at them, and it reached the CLI unmodified.
// The sibling xlsx reader already guarded exactly this shape; ooxml never did. Six commands
// share this funnel: docx-outline, docx-text, pptx-outline, pptx-slide, pptx-notes, pptx-text.
describe('readOoxmlZip failure messages', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ooxml-err-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports a missing file without leaking the absolute path it resolved', async () => {
    const missing = path.join(dir, 'nope.docx')

    const err = await readOoxmlZip(missing, '.docx').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err).not.toBeNull()
    expect(err?.message).toBe(`File not found: ${missing}`)
    expect(err?.message, 'the raw errno from Node must not reach the caller').not.toMatch(/ENOENT/)
    expect(err?.message).not.toMatch(/no such file or directory/)
  })

  it('names the file the caller passed, not one it resolved itself', async () => {
    // A bare relative name is the case that exposed it: statSync resolves against cwd and puts
    // the whole absolute path in the message, for a caller who never typed one.
    const err = await readOoxmlZip('nope-relative.docx', '.docx').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err?.message).toBe('File not found: nope-relative.docx')
    expect(err?.message).not.toContain(process.cwd())
  })

  it('reports a directory as an invalid file rather than as EISDIR', async () => {
    const asDir = path.join(dir, 'adir.docx')
    fs.mkdirSync(asDir, { recursive: true })

    const err = await readOoxmlZip(asDir, '.docx').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err?.message).toBe(`not a valid .docx file: ${asDir}`)
    expect(err?.message).not.toMatch(/EISDIR/)
  })

  it('names the file when the bytes are not a zip, instead of the bare fflate message', async () => {
    const bad = path.join(dir, 'bad.pptx')
    fs.writeFileSync(bad, 'this is not a zip at all')

    const err = await readOoxmlZip(bad, '.pptx').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err?.message).toBe(`not a valid .pptx file: ${bad}`)
    expect(err?.message, 'the original is kept for debugging, not shown').not.toMatch(/invalid zip data/)
    expect((err?.cause as Error | undefined)?.message).toMatch(/invalid zip data/)
  })

  // The format comes from the command, not from whatever the file happens to be called.
  // `docx-outline report.txt` used to answer "not a valid .txt file", naming a format the user
  // never asked for and that this reader could not have read either way.
  it('names the format the caller asked for, not the extension on the path', async () => {
    const bad = path.join(dir, 'report.txt')
    fs.writeFileSync(bad, 'plain text, not a zip')

    const viaDocx = await docxOutline(bad).then(
      () => null,
      (e: unknown) => e as Error,
    )
    const viaPptx = await pptxOutline(bad).then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(viaDocx?.message).toBe(`not a valid .docx file: ${bad}`)
    expect(viaPptx?.message).toBe(`not a valid .pptx file: ${bad}`)
    expect(viaDocx?.message, 'the path extension is not the format that was asked for').not.toContain('.txt file')
  })

})

// The branch behind these is unreachable from a test that goes through the filesystem: node:fs is
// a frozen namespace so statSync cannot be mocked, and no real probe gives the same errno on every
// platform. Asserted on the classifier directly rather than left uncovered.
describe('accessFailureMessage', () => {
  it('calls only a genuinely absent file missing', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })

    expect(accessFailureMessage(err, 'a.docx')).toBe('File not found: a.docx')
  })

  it('does not call a permission error a missing file, since the file is right there', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

    expect(accessFailureMessage(err, 'a.docx')).not.toContain('File not found')
    expect(accessFailureMessage(err, 'a.docx')).toBe('could not read a.docx (EACCES)')
  })

  it.each([['EISDIR'], ['ENOTDIR'], ['EPERM'], ['EMFILE']])('reports %s as itself', (code) => {
    const err = Object.assign(new Error(code), { code })

    expect(accessFailureMessage(err, 'a.docx')).toBe(`could not read a.docx (${code})`)
  })

  it('says something usable when the failure carries no errno at all', () => {
    expect(accessFailureMessage(new Error('boom'), 'a.docx')).toBe('could not read a.docx (unknown error)')
  })
})


// `collectElements` appended each matching array with `out.push(...val)`, a call with one
// argument per item, so it failed with "Maximum call stack size exceeded" above roughly 125,000
// elements. A long Word document reaches that: a 40 kB .docx of 400,000 paragraphs crashed
// `docx-text` with that raw engine message and no indication of what was wrong.
describe('collecting more elements than can be spread as call arguments', () => {
  it('collects every one instead of overflowing the call stack', () => {
    const HUGE = 200_000
    const node = { body: { 'w:p': Array.from({ length: HUGE }, (_, i) => ({ n: i })) } }

    const out = collectElements(node, 'w:p')

    expect(out).toHaveLength(HUGE)
    expect(out[HUGE - 1]).toEqual({ n: HUGE - 1 })
  })
})
