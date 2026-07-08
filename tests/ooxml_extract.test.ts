import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readOoxmlZip } from '../src/ooxml_extract.js'
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
