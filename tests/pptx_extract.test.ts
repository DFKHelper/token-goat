import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { pptxNotesText, pptxOutline, pptxSlideText, pptxTextGrep } from '../src/pptx_extract.js'
import { isDocumentRefusal } from '../src/doc_embed_extract.js'
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

describe('a repeated r:id resolving to the same slide part is deduplicated, not re-listed once per repeat', () => {
  // FORMAT-DERIVED: ECMA-376 addresses each <p:sldId> to a distinct slide part via its r:id; the
  // same resolved part naming a second <p:sldId> is not something an authoring tool produces --
  // it is the exact shape an adversarial deck uses to force N reparses of one part for O(1)
  // bytes on disk, since parseSlide has no cache and nothing else bounded the list length.
  let dupDir: string
  let dupFile: string

  beforeAll(() => {
    dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-dup-'))
    dupFile = path.join(dupDir, 'dup.pptx')
    // order=[1, 1, 2] emits three distinct <p:sldId>/r:id pairs, but the first two both resolve
    // (via presentation.xml.rels) to physical slide1.xml -- the same-target-twice shape.
    const bytes = buildPptxFixture(
      [{ title: 'Repeated' }, { title: 'Other' }],
      [1, 1, 2],
    )
    fs.writeFileSync(dupFile, bytes)
  })

  afterAll(() => {
    fs.rmSync(dupDir, { recursive: true, force: true })
  })

  it('pptxOutline lists each distinct slide part once, in first-appearance order', async () => {
    const slides = await pptxOutline(dupFile)
    expect(slides.map((s) => s.title)).toEqual(['Repeated', 'Other'])
    expect(slides.map((s) => s.slide)).toEqual([1, 2])
  })

  it('an ordinary deck whose display-order refs are already distinct is unaffected by the dedup', async () => {
    const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pptx-nodup-'))
    const okFile = path.join(okDir, 'ok.pptx')
    fs.writeFileSync(okFile, buildPptxFixture([{ title: 'First' }, { title: 'Second' }], [2, 1]))
    const slides = await pptxOutline(okFile)
    expect(slides.map((s) => s.title)).toEqual(['Second', 'First'])
    fs.rmSync(okDir, { recursive: true, force: true })
  })
})

// pptxOutline/pptxNotesText/pptxTextGrep each walk every slide with no wall clock at all, unlike
// pptxAllSlidesText/allSheetsHeadText which already take the deadline/assertOoxmlWithinDeadline
// pair from ooxml_extract.ts. Mirrors doc_embed_extract.test.ts's pptxAllSlidesText/
// allSheetsHeadText deadline coverage: force the deadline already-expired so the test doesn't
// depend on wall-clock timing to be slow enough to trip the real default.
describe('pptxOutline / pptxNotesText / pptxTextGrep refuse past their deadline as a DocumentRefusedError', () => {
  it('pptxOutline throws a document refusal once the deadline has passed, not a plain Error', async () => {
    const expiredDeadline = Date.now() - 1
    let caught: unknown
    try {
      await pptxOutline(file, expiredDeadline)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isDocumentRefusal(caught)).toBe(true)
  })

  it('pptxNotesText throws a document refusal once the deadline has passed, not a plain Error', async () => {
    const expiredDeadline = Date.now() - 1
    let caught: unknown
    try {
      await pptxNotesText(file, undefined, expiredDeadline)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isDocumentRefusal(caught)).toBe(true)
  })

  it('pptxTextGrep throws a document refusal once the deadline has passed, not a plain Error', async () => {
    const expiredDeadline = Date.now() - 1
    let caught: unknown
    try {
      await pptxTextGrep(file, 'Revenue', expiredDeadline)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isDocumentRefusal(caught)).toBe(true)
  })

  it('an ordinary call with no expired deadline still returns the full result', async () => {
    const slides = await pptxOutline(file)
    expect(slides).toHaveLength(3)
    const notes = await pptxNotesText(file)
    expect(notes).toContain('Slide 1 notes')
    const matches = await pptxTextGrep(file, 'enterprise')
    expect(matches).toHaveLength(1)
  })
})

describe('a word split across runs at a formatting boundary', () => {
  // Provenance: CAPTURE. `ppt/slides/slide1.xml` of a .pptx written by python-pptx 1.0.2, where the title reads "TokenGoat" with only the second half bold. PowerPoint stores that as two `<a:r>` runs in one `<a:p>`, which is how it stores every mid-word formatting change. Trimmed to the shapes the extractor reads; the run splitting is verbatim. Every cell and title `buildPptxFixture` writes is a single run, so no existing fixture can show a run boundary at all.
  const SPLIT_RUN_SLIDE =
    '<?xml version="1.0"?><p:sld><p:cSld><p:spTree>' +
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>' +
    '<a:p><a:r><a:t>Token</a:t></a:r><a:r><a:rPr b="1"/><a:t>Goat</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>' +
    '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>' +
    '<a:tc><a:txBody><a:p><a:r><a:t>Cell</a:t></a:r></a:p></a:txBody></a:tc>' +
    '<a:tc><a:txBody><a:p><a:r><a:t>Alpha</a:t></a:r></a:p><a:p><a:r><a:t>Beta</a:t></a:r></a:p></a:txBody></a:tc>' +
    '</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
    '</p:spTree></p:cSld></p:sld>'

  let splitFile: string
  beforeAll(() => {
    splitFile = path.join(dir, 'split-runs.pptx')
    fs.writeFileSync(splitFile, zipSync({ 'ppt/slides/slide1.xml': strToU8(SPLIT_RUN_SLIDE) }))
  })

  it('stays one word in the outline title', async () => {
    const slides = await pptxOutline(splitFile)
    expect(slides[0]?.title).toBe('TokenGoat')
  })

  it('is still findable by the word it actually is', async () => {
    expect(await pptxTextGrep(splitFile, 'TokenGoat')).toHaveLength(1)
  })

  it('keeps a table cell that holds two paragraphs separated', async () => {
    expect(await pptxSlideText(splitFile, 1, false)).toContain('Cell | Alpha Beta')
  })
})

describe('an explicit line break inside a slide paragraph', () => {
  // Provenance: HAND-DERIVED from ECMA-376 part 1 section 21.1.2.2.1 (`a:br`). Concatenating the runs on either side of a break turns two lines into one word; the parse folds same-name siblings, so the break's position within the paragraph is not recoverable and the space goes in per paragraph.
  it('separates the runs it sits between', async () => {
    const brFile = path.join(dir, 'line-break.pptx')
    const xml =
      '<?xml version="1.0"?><p:sld><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>' +
      '<a:p><a:r><a:t>Alpha</a:t></a:r><a:br/><a:r><a:t>Beta</a:t></a:r></a:p>' +
      '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    fs.writeFileSync(brFile, zipSync({ 'ppt/slides/slide1.xml': strToU8(xml) }))
    const slides = await pptxOutline(brFile)
    expect(slides[0]?.title).toBe('Alpha Beta')
  })
})
