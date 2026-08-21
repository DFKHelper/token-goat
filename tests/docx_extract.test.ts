import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { docxOutline, docxText } from '../src/docx_extract.js'
import { buildDocxFixture } from './helpers/ooxml_fixtures.js'

let dir: string
let file: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx-'))
  file = path.join(dir, 'sample.docx')
  const bytes = buildDocxFixture([
    { text: 'Project Plan', headingLevel: 1 },
    { text: 'This document outlines the plan for the widget launch.' },
    { text: 'Timeline', headingLevel: 2 },
    { text: 'Phase 1 starts in Q1.' },
    { text: 'Budget', headingLevel: 2 },
    { text: 'The budget is $50,000.' },
  ])
  fs.writeFileSync(file, bytes)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('docxOutline', () => {
  it('returns only heading paragraphs with their level', async () => {
    const headings = await docxOutline(file)
    expect(headings).toEqual([
      { level: 1, text: 'Project Plan' },
      { level: 2, text: 'Timeline' },
      { level: 2, text: 'Budget' },
    ])
  })

  it('returns an empty array for a document with no headings', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docx-noh-'))
    const file2 = path.join(dir2, 'plain.docx')
    fs.writeFileSync(file2, buildDocxFixture([{ text: 'Just a plain paragraph.' }]))
    expect(await docxOutline(file2)).toEqual([])
    fs.rmSync(dir2, { recursive: true, force: true })
  })
})

describe('docxText', () => {
  it('returns all paragraph text, including headings, joined by blank lines', async () => {
    const text = await docxText(file)
    expect(text).toContain('Project Plan')
    expect(text).toContain('This document outlines the plan for the widget launch.')
    expect(text).toContain('The budget is $50,000.')
    expect(text.split('\n\n')).toHaveLength(6)
  })

  // A paragraph whose whole text is digits was being handed back as a number: an order number
  // reading `007` printed as `7`, a version reading `1.50` as `1.5`. Mixed text was untouched,
  // so the corruption only hit the short standalone values most likely to be an identifier.
  it('returns a numeric-looking paragraph as the text it was written as', async () => {
    const f = path.join(dir, 'numeric.docx')
    fs.writeFileSync(
      f,
      buildDocxFixture([{ text: 'Order 007' }, { text: '007' }, { text: '1.50' }, { text: '0x1A' }, { text: '1e5' }]),
    )
    expect(await docxText(f)).toBe('Order 007\n\n007\n\n1.50\n\n0x1A\n\n1e5')
  })
})
