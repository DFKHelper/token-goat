// Regression: section --grep with --max-lines reported lineStart..lineStart+maxLines-1 in its header, a contiguous range that has nothing to do with the scattered matching lines grep selected. The header must describe the span the lines were drawn from.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runSection } from '../src/read_section.js'

// Provenance: HAND-DERIVED the section "Big" starts on line 1 and ends on line 12; the only matches for "needle" are lines 8 and 10, counted by hand from the array below.
const DOC = ['# Big', 'a', 'b', 'c', 'd', 'e', 'f', 'needle one', 'g', 'needle two', 'h', 'i'].join('\n') + '\n'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sec-grep-'))
  file = path.join(dir, 'doc.md')
  fs.writeFileSync(file, DOC)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('section --grep with --max-lines', () => {
  it('keeps the header range at the span the matches were drawn from, not the first max-lines lines', () => {
    const r = runSection({ spec: `${file}::Big`, grep: 'needle', maxLines: 2 })
    expect(r.code).toBe(0)
    const header = r.text.split('\n')[0]!
    expect(header).toContain(`${file}:1-12`)
    expect(header).not.toContain(`${file}:1-2`)
    expect(r.text).toContain('needle one')
    expect(r.text).not.toContain('needle two')
    expect(r.text).toContain('not shown')
  })

  it('still narrows the range to the printed lines when --max-lines applies without --grep', () => {
    const r = runSection({ spec: `${file}::Big`, maxLines: 3 })
    expect(r.text.split('\n')[0]!).toContain(`${file}:1-3`)
  })

  it('reports the same range in --json', () => {
    const r = runSection({ spec: `${file}::Big`, grep: 'needle', maxLines: 2, json: true })
    const parsed = JSON.parse(r.text) as { lineStart: number; lineEnd: number }
    expect(parsed.lineStart).toBe(1)
    expect(parsed.lineEnd).toBe(12)
  })
})
