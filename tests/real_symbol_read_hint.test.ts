import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { realSymbolReadHint } from '../src/hooks_read.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-real-symbol-hint-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

describe('realSymbolReadHint', () => {
  // Regression: a deny/hint message used to print the literal `::Symbol`/`::SymbolName` placeholder even when the file had real indexed symbols, which sent an agent trying to `read` a symbol literally named "Symbol" in circles.
  it('names a real indexed symbol instead of the bare ::Symbol placeholder', () => {
    const file = write('dashboard.js', 'function updateChart1() {}\nfunction renderDailyBaselineBar() {}\n')
    indexFileSync(file)
    const hint = realSymbolReadHint(file, 'dashboard.js')
    expect(hint).not.toContain('::Symbol"')
    expect(hint).not.toContain('::SymbolName"')
    expect(hint).toContain('updateChart1')
  })

  it('prefers a symbol overlapping the requested line range over an earlier one in the file', () => {
    const file = write('multi.ts', 'export function first() {\n  return 1\n}\n\nexport function second() {\n  return 2\n}\n')
    indexFileSync(file)
    const hint = realSymbolReadHint(file, 'multi.ts', { start: 5, end: 7 })
    expect(hint).toContain('second')
    expect(hint).not.toContain('first')
  })

  it('falls back to a line-range read when the file has no indexed symbols', () => {
    const file = write('data.txt', 'just some plain text, no symbols here\n')
    indexFileSync(file)
    const hint = realSymbolReadHint(file, 'data.txt', { start: 1, end: 1 })
    expect(hint).not.toContain('::')
    expect(hint).toContain('data.txt@1-1')
  })

  it('falls back to outline when the file has no indexed symbols and no range was requested', () => {
    const file = write('data2.txt', 'just some plain text, no symbols here\n')
    indexFileSync(file)
    const hint = realSymbolReadHint(file, 'data2.txt')
    expect(hint).not.toContain('::')
    expect(hint).toContain('outline "data2.txt"')
  })
})
