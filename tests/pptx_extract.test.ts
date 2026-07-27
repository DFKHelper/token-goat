import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { pptxNotesText, pptxOutline, pptxSlideText, pptxTextGrep } from '../src/pptx_extract.js'
import { buildPptxFixture } from './helpers/ooxml_fixtures.js'

let dir: string
let file: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-'))
  file = path.join(dir, 'sample.pptx')
  const bytes = buildPptxFixture([
    { title: 'Quarterly Review', body: ['Q3 2026 Results'], notes: 'Remember to mention the new hires.' },
    { title: 'Revenue Growth', body: ['Revenue grew 20% year over year', 'Driven by enterprise sales'] },
    { title: 'Empty slide' },
  ])
  fs.writeFileSync(file, bytes)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pptxOutline', () => {
  it('lists one entry per slide with title, body size, and notes flag', async () => {
    const slides = await pptxOutline(file)
    expect(slides).toHaveLength(3)
    expect(slides[0]).toMatchObject({ slide: 1, title: 'Quarterly Review', hasNotes: true })
    // 'Q3 2026 Results' is 15 chars; +1 for the trailing newline the body-join adds.
    expect(slides[0]?.bodyChars).toBe(16)
    expect(slides[1]).toMatchObject({ slide: 2, title: 'Revenue Growth', hasNotes: false })
    expect(slides[2]).toMatchObject({ slide: 3, title: 'Empty slide', bodyChars: 0, hasNotes: false })
  })

  it('reports hasNotes: false for a notesSlideN.xml part with no actual notes text', async () => {
    // PowerPoint auto-creates a notesSlideN.xml part for every slide on save, whether or not
    // the user typed anything into the notes pane -- hasNotes must reflect actual content,
    // not mere presence of the ZIP part.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-emptynotes-'))
    const file2 = path.join(dir2, 'sample.pptx')
    fs.writeFileSync(file2, buildPptxFixture([{ title: 'Slide with an empty notes placeholder', notes: '' }]))
    const slides = await pptxOutline(file2)
    expect(slides[0]).toMatchObject({ hasNotes: false })
    fs.rmSync(dir2, { recursive: true, force: true })
  })
})

describe('pptxSlideText', () => {
  it('returns the slide title and body text', async () => {
    const text = await pptxSlideText(file, 2, false)
    expect(text).toContain('Revenue Growth')
    expect(text).toContain('Revenue grew 20% year over year')
  })

  it('includes speaker notes without a duplicated heading when --notes is set', async () => {
    const text = await pptxSlideText(file, 1, true)
    expect(text).toContain('Speaker notes')
    expect(text).toContain('Remember to mention the new hires.')
    expect(text.match(/Slide 1 notes/g) ?? []).toHaveLength(0)
  })

  it('throws for an out-of-range slide number', async () => {
    await expect(pptxSlideText(file, 99, false)).rejects.toThrow(/out of range/)
  })
})

describe('pptxNotesText', () => {
  it('returns notes for one slide', async () => {
    const text = await pptxNotesText(file, 1)
    expect(text).toContain('Remember to mention the new hires.')
  })

  it('returns empty string for a slide with no notes', async () => {
    const text = await pptxNotesText(file, 2)
    expect(text).toBe('')
  })

  it('returns all slides with notes when no slide number is given', async () => {
    const text = await pptxNotesText(file)
    expect(text).toContain('Slide 1 notes')
    expect(text).not.toContain('Slide 2 notes')
  })
})

describe('notes are resolved via the slide relationship, not the slideN.xml filename number', () => {
  // Simulates duplicating slide 2 (which has notes) in PowerPoint: the duplicate becomes
  // physical slide 3, but PowerPoint allocates a fresh, non-matching notesSlide part (7)
  // for it rather than reusing/renaming to notesSlide3.xml -- the notesSlide numbering
  // counter is independent of slide numbering.
  it('follows the notesSlide relationship target instead of guessing notesSlideN.xml', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-notesmismatch-'))
    const file3 = path.join(dir3, 'sample.pptx')
    fs.writeFileSync(
      file3,
      buildPptxFixture(
        [
          { title: 'Intro' },
          { title: 'Original', notes: 'Original notes.' },
          { title: 'Duplicate of Original', notes: 'Duplicate notes.' },
        ],
        undefined,
        { 3: 7 },
      ),
    )
    const text = await pptxNotesText(file3, 3)
    expect(text).toContain('Duplicate notes.')
    const outline = await pptxOutline(file3)
    expect(outline[2]).toMatchObject({ slide: 3, hasNotes: true })
    fs.rmSync(dir3, { recursive: true, force: true })
  })
})

describe('pptxTextGrep', () => {
  it('finds slides whose text matches the pattern', async () => {
    const matches = await pptxTextGrep(file, 'enterprise')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.slide).toBe(2)
  })

  it('returns no matches for a pattern not present', async () => {
    const matches = await pptxTextGrep(file, 'nonexistent-pattern-xyz')
    expect(matches).toHaveLength(0)
  })
})

describe('pptxSlideText with a table shape', () => {
  // PowerPoint tables (`p:graphicFrame` > `a:tbl` > `a:tr` > `a:tc`) don't use `p:sp` at all --
  // a real, common slide shape (comparison tables, data grids) that pptxOutline's bodyChars
  // (whole-tree collectTextRuns) and pptxTextGrep (same) both already account for, but
  // pptxSlideText builds its blocks from slideShapes()'s p:sp-only collection, silently
  // dropping every table's cell text from the one command whose whole job is showing a
  // slide's actual text.
  let tableDir: string
  let tableFile: string

  beforeAll(() => {
    tableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-table-'))
    tableFile = path.join(tableDir, 'table.pptx')
    const slideXml = `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>` +
      `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Budget</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
      `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Q3 Total</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `<a:tr><a:tc><a:txBody><a:p><a:r><a:t>EMEA</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>412000</a:t></a:r></a:p></a:txBody></a:tc></a:tr>` +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
      `</p:spTree></p:cSld></p:sld>`
    fs.writeFileSync(tableFile, zipSync({ 'ppt/slides/slide1.xml': strToU8(slideXml) }))
  })

  afterAll(() => {
    fs.rmSync(tableDir, { recursive: true, force: true })
  })

  it('includes table cell text in the slide text output', async () => {
    const text = await pptxSlideText(tableFile, 1, false)
    expect(text).toContain('Budget')
    expect(text).toContain('EMEA')
    expect(text).toContain('412000')
  })

  it('is found by pptxTextGrep (whole-tree scan already sees table text)', async () => {
    const matches = await pptxTextGrep(tableFile, 'EMEA')
    expect(matches).toHaveLength(1)
  })
})

describe('slide numbering follows presentation display order, not slideN.xml filenames', () => {
  let reorderedDir: string
  let reorderedFile: string

  beforeAll(() => {
    reorderedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-reorder-'))
    reorderedFile = path.join(reorderedDir, 'reordered.pptx')
    // Physical files are created in this order: slide1.xml=Intro, slide2.xml=Middle,
    // slide3.xml=Conclusion. The deck's actual display order (as PowerPoint's "Move Slide"
    // would produce, without renaming any part) puts physical slide 3 first and slide 1 last.
    const bytes = buildPptxFixture(
      [{ title: 'Intro' }, { title: 'Middle' }, { title: 'Conclusion' }],
      [3, 2, 1],
    )
    fs.writeFileSync(reorderedFile, bytes)
  })

  afterAll(() => {
    fs.rmSync(reorderedDir, { recursive: true, force: true })
  })

  it('pptxOutline lists slides in display order', async () => {
    const slides = await pptxOutline(reorderedFile)
    expect(slides.map((s) => s.title)).toEqual(['Conclusion', 'Middle', 'Intro'])
    expect(slides.map((s) => s.slide)).toEqual([1, 2, 3])
  })

  it('pptxSlideText returns the displayed slide, not the same-numbered physical file', async () => {
    const text = await pptxSlideText(reorderedFile, 1, false)
    expect(text).toContain('Conclusion')
  })

  it('pptxTextGrep reports the display-order slide number', async () => {
    const matches = await pptxTextGrep(reorderedFile, 'Intro')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.slide).toBe(3)
  })
})
