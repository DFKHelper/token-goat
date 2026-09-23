import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { runSection } from '../src/read_section.js'

describe('runSection with maxLines / head', () => {
  let tempDir: string
  let testFile: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-maxlines-'))
    testFile = path.join(tempDir, 'CHANGELOG.md')
    const lines = [
      '# Changelog',
      'Intro line',
      '',
      ...Array.from({ length: 50 }, (_, i) => `Entry ${i + 1}: change detail line`),
    ]
    fs.writeFileSync(testFile, lines.join('\n'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('slices section content to maxLines and adds truncation notice in text mode', () => {
    const res = runSection({
      spec: `${testFile}::Changelog`,
      maxLines: 5,
    })
    expect(res.code).toBe(0)
    expect(res.text).toContain('Intro line')
    expect(res.text).toContain('Entry 2: change detail line')
    expect(res.text).not.toContain('Entry 10: change detail line')
    expect(res.text).toContain('more line')
    expect(res.text).toContain('pass a larger --max-lines')
  })

  it('includes truncation metadata in JSON mode', () => {
    const res = runSection({
      spec: `${testFile}::Changelog`,
      maxLines: 5,
      json: true,
    })
    expect(res.code).toBe(0)
    const parsed = JSON.parse(res.text) as {
      heading: string
      content: string
      truncated: boolean
      totalLines: number
      shownLines: number
    }
    expect(parsed.heading).toBe('Changelog')
    expect(parsed.truncated).toBe(true)
    expect(parsed.shownLines).toBe(5)
    expect(parsed.totalLines).toBeGreaterThan(50)
  })

  it('returns full section when maxLines is larger than section line count', () => {
    const res = runSection({
      spec: `${testFile}::Changelog`,
      maxLines: 200,
    })
    expect(res.code).toBe(0)
    expect(res.text).toContain('Entry 50: change detail line')
    expect(res.text).not.toContain('more line')
  })
})
