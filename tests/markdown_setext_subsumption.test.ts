import { describe, it, expect } from 'vitest'
import { findMarkdownHeaders } from '../src/section_reader.js'
import { extractMarkdownSymbols } from '../src/parser_structured.js'
import { extractMarkdownHeadings } from '../src/hints/markdown_hints.js'
import { runSectionMulti } from '../src/read_section.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('Markdown Setext Headings and Subsumption Deduplication', () => {
  const sampleDoc = [
    'Main Architecture Title',
    '=======================',
    '',
    'Introductory text here.',
    '',
    'Data Flow Section',
    '-----------------',
    '',
    'Details about the data flow pipelines.',
    '',
    '### Nested Sub-Flow',
    '',
    'Even deeper sub-flow explanation.',
    '',
    'Deployment Overview',
    '-------------------',
    '',
    'All deployment instructions.',
  ].join('\n')

  it('detects Setext H1 (===) and H2 (---) in findMarkdownHeaders', () => {
    const headers = findMarkdownHeaders(sampleDoc.split('\n'))
    expect(headers).toHaveLength(4)
    expect(headers[0]).toMatchObject({
      heading: 'Main Architecture Title',
      level: 1,
      index: 0,
    })
    expect(headers[1]).toMatchObject({
      heading: 'Data Flow Section',
      level: 2,
      index: 5,
    })
    expect(headers[2]).toMatchObject({
      heading: 'Nested Sub-Flow',
      level: 3,
      index: 10,
    })
    expect(headers[3]).toMatchObject({
      heading: 'Deployment Overview',
      level: 2,
      index: 14,
    })
  })

  it('extracts Setext headings as symbols in extractMarkdownSymbols', () => {
    const symbols = extractMarkdownSymbols(sampleDoc, 'test.md')
    expect(symbols.length).toBeGreaterThanOrEqual(4)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('Main Architecture Title')
    expect(names).toContain('Data Flow Section')
    expect(names).toContain('Nested Sub-Flow')
    expect(names).toContain('Deployment Overview')
  })

  it('extracts Setext headings in markdown_hints extractMarkdownHeadings', () => {
    const headings = extractMarkdownHeadings(sampleDoc)
    expect(headings).toHaveLength(4)
    expect(headings[0]?.text).toBe('Main Architecture Title')
    expect(headings[0]?.level).toBe(1)
    expect(headings[1]?.text).toBe('Data Flow Section')
    expect(headings[1]?.level).toBe(2)
  })

  it('deduplicates subsumed child sections when requesting both parent and child in runSectionMulti', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-setext-test-'))
    const docPath = path.join(tmpDir, 'arch.md')
    fs.writeFileSync(docPath, sampleDoc, 'utf8')

    try {
      // Query both the parent H1 ("Main Architecture Title") and nested H2 ("Data Flow Section")
      const result = runSectionMulti(docPath, docPath, ['Main Architecture Title', 'Data Flow Section'], { spec: 'Main Architecture Title', json: false })
      expect(result.code).toBe(0)
      expect(result.text).toContain('# Main Architecture Title')
      expect(result.text).toContain('# Data Flow Section')
      expect(result.text).toContain('(already included in section \'Main Architecture Title\', lines 6-13)')

      // In JSON mode
      const jsonResult = runSectionMulti(docPath, docPath, ['Main Architecture Title', 'Data Flow Section'], { spec: 'Main Architecture Title', json: true })
      expect(jsonResult.code).toBe(0)
      const parsed = JSON.parse(jsonResult.text)
      expect(parsed).toHaveProperty('Main Architecture Title')
      expect(parsed).toHaveProperty('Data Flow Section')
      expect(parsed['Data Flow Section']).toMatchObject({
        subsumedBy: 'Main Architecture Title',
      })
      expect(parsed['Data Flow Section'].notice).toBe('(already included in section \'Main Architecture Title\', lines 6-13)')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
