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

  // HAND-DERIVED: a 400-line function body computed independently of the threshold this test pins, to confirm an oversized symbol is never named for a whole-body read.
  it('points at a grep -C slice instead of naming an oversized symbol for a whole-body read', () => {
    const body = Array.from({ length: 400 }, (_, i) => `  step${i + 1}()`).join('\n')
    const file = write('big.js', `function bigFn() {\n${body}\n}\n`)
    indexFileSync(file)
    const hint = realSymbolReadHint(file, 'big.js')
    expect(hint).not.toContain('::bigFn"')
    expect(hint).toContain('token-goat grep "<pattern>" big.js -C 15 --symbol')
    expect(hint).toContain('token-goat scope big.js:')
  })

  // Regression (cap-before-predicate): the overlap test above held only while the file fit inside the single `limit: 500` window the candidates were drawn from. Symbols come back ordered by starting line, so past the five-hundredth one the window held nothing but the top of the file, no candidate overlapped a range down there, and the fallback named the file's very first symbol for a read a few thousand lines away -- pointing somewhere else entirely, which is worse than the generic placeholder it replaced. 76 of the 13,900 files in this machine's index hold more than 500 symbols. HAND-DERIVED: 600 functions is one page past the retired window, computed from that window's own value rather than from this fix's output.
  it('names the symbol covering a range that sits past the first page of a large file', () => {
    const total = 600
    const target = 550
    const lines = Array.from({ length: total }, (_, i) => `function fn${i + 1}() {}`)
    const file = write('wide.js', lines.join('\n') + '\n')
    indexFileSync(file)

    const hint = realSymbolReadHint(file, 'wide.js', { start: target, end: target })

    expect(hint).toContain(`fn${target}`)
    expect(hint).not.toContain('::fn1"')
  })
})
