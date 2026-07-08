import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectTextRuns, parseOoxmlPart, readOoxmlZip } from '../src/ooxml_extract.js'
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
