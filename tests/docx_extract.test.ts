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
})
