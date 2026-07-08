import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
    expect(slides[0]?.bodyChars).toBeGreaterThan(0)
    expect(slides[1]).toMatchObject({ slide: 2, title: 'Revenue Growth', hasNotes: false })
    expect(slides[2]).toMatchObject({ slide: 3, title: 'Empty slide', bodyChars: 0, hasNotes: false })
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
