/**
 * Body-fold coverage.
 *
 * Fixture provenance: every numbered-read fixture below is HAND-DERIVED -- the `N\tline` rendering is written from the shape READ_NUMBERED_ROW_RE accepts, and the line contents are synthetic source written for this test. That is the right tier for logic (does the planner cut where it should) and explicitly NOT evidence about the wire format Claude Code emits; the e2e block below covers the shipping path by indexing a real file and driving the real handler, which is what this repo's "critical path" rule requires of anything touching the indexer or a hook.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { planBodyFolds, type FoldSpan } from '../src/code_fold.js'
import { postReadHandler } from '../src/hooks_read.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/util.js'
import { getFileServedOutputs } from '../src/session.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import type { HookEvent } from '../src/hook_registry.js'

/** Rows as parseNumberedReadResult produces them: 1-based line numbers, in order. */
function rowsFor(count: number, from = 1): Array<{ no: number }> {
  return Array.from({ length: count }, (_, i) => ({ no: from + i }))
}

function span(name: string, lineStart: number, lineEnd: number, kind = 'function'): FoldSpan {
  return { name, kind, lineStart, lineEnd }
}

describe('planBodyFolds', () => {
  it('folds the tail of a long function and keeps the declaration plus keep-1 body lines', () => {
    const folds = planBodyFolds(rowsFor(60), [span('big', 1, 40)], 10, 25)
    expect(folds).toHaveLength(1)
    expect(folds[0]?.firstLine).toBe(11)
    expect(folds[0]?.lastLine).toBe(40)
    expect(folds[0]?.name).toBe('big')
  })

  it('leaves a span shorter than minSpan alone, where the notice would cost more than it removes', () => {
    expect(planBodyFolds(rowsFor(60), [span('small', 1, 20)], 10, 25)).toEqual([])
  })

  it('never folds a class or interface, whose span encloses the member signatures this preserves', () => {
    // The whole point is to keep structure. A class span covers every method inside it, so folding it would swallow exactly the signatures a reader needs to navigate the type.
    for (const kind of ['class', 'interface', 'type', 'struct', 'enum']) {
      expect(planBodyFolds(rowsFor(80), [span('Big', 1, 60, kind)], 10, 25)).toEqual([])
    }
  })

  it('folds an outer function once rather than folding a nested helper inside it a second time', () => {
    // Two notices for overlapping ranges would claim the same removed bytes twice in the ledger, and the inner notice would point at lines the outer fold already took away.
    const folds = planBodyFolds(rowsFor(120), [span('outer', 1, 100), span('inner', 30, 70)], 10, 25)
    expect(folds).toHaveLength(1)
    expect(folds[0]?.name).toBe('outer')
  })

  it('folds two sibling functions independently', () => {
    const folds = planBodyFolds(rowsFor(120), [span('a', 1, 40), span('b', 50, 100)], 10, 25)
    expect(folds.map((f) => f.name)).toEqual(['a', 'b'])
    expect(folds[0]?.firstLine).toBe(11)
    expect(folds[1]?.firstLine).toBe(60)
  })

  it('clips a span that runs past the rows actually delivered', () => {
    // A span may extend beyond a windowed read. Folding to span.lineEnd regardless would emit a notice claiming lines the read never contained.
    const folds = planBodyFolds(rowsFor(30), [span('big', 1, 100)], 10, 25)
    expect(folds).toHaveLength(1)
    expect(folds[0]?.lastLine).toBe(30)
  })

  it('declines when the delivered rows skip a line inside the span', () => {
    // Folding across a gap would remove rows the span never covered. Rows 1-20 then 41-60: the span's range is present on both sides of a hole, and the run is not contiguous.
    const rows = [...rowsFor(20, 1), ...rowsFor(20, 41)]
    expect(planBodyFolds(rows, [span('big', 1, 60)], 10, 25)).toEqual([])
  })

  it('returns nothing for empty input rather than throwing', () => {
    expect(planBodyFolds([], [span('a', 1, 40)], 10, 25)).toEqual([])
    expect(planBodyFolds(rowsFor(60), [], 10, 25)).toEqual([])
    expect(planBodyFolds(rowsFor(60), [span('a', 1, 40)], 0, 25)).toEqual([])
  })
})

describe('body fold on the real Read hook path', () => {
  const tmpFiles: string[] = []
  const prevFlag = process.env['TOKEN_GOAT_FOLD_CODE_BODIES']

  /** A source file with one function long enough to fold and structure that must survive. */
  function makeIndexedSource(): { file: string; body: string } {
    const lines = [
      "import { thing } from './thing.js'",
      '',
      'export const TOP_LEVEL_CONSTANT = 42',
      '',
      '// A design-rationale comment outside any symbol. Comments are 44.8% of source bytes in this',
      '// repo and carry the reasoning, so a fold must never touch them.',
      '',
      'export function longFunction(n: number): number {',
    ]
    for (let i = 0; i < 60; i++) lines.push(`  const localVariable${i} = n + ${i} // body line ${i}`)
    lines.push('  return n', '}', '', 'export const TRAILING_CONSTANT = 7', '')
    const body = lines.join('\n')
    const file = path.join(os.tmpdir(), `tg-fold-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(file, body)
    tmpFiles.push(file)
    indexFileSync(normalizePath(file))
    return { file, body }
  }

  /** The `cat -n` rendering the Read tool delivers, which is what the hook parses. */
  function numbered(body: string): string {
    return body
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n')
  }

  function postEvent(file: string, body: string, extraInput: Record<string, unknown> = {}): HookEvent {
    return {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: file, ...extraInput },
      sessionId: `fold-${Math.random().toString(36).slice(2)}`,
      agentId: undefined,
      raw: { tool_response: numbered(body) },
    }
  }

  beforeEach(() => {
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '1'
  })

  afterEach(() => {
    if (prevFlag === undefined) delete process.env['TOKEN_GOAT_FOLD_CODE_BODIES']
    else process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = prevFlag
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* best effort */
      }
    }
  })

  it('folds a long body while keeping imports, constants, comments and the signature verbatim', () => {
    const { file, body } = makeIndexedSource()
    const out = postReadHandler(postEvent(file, body))
    const text = JSON.stringify(out)

    expect(text).toContain('folded')
    expect(text).toContain('longFunction')
    // Everything outside the body survives. These are the lines a skeleton would also drop, and dropping them is the difference between a fold and a deny wearing a preview.
    expect(text).toContain('TOP_LEVEL_CONSTANT')
    expect(text).toContain('TRAILING_CONSTANT')
    expect(text).toContain('design-rationale comment')
    expect(text).toContain('export function longFunction')
    // The interior is gone.
    expect(text).not.toContain('localVariable59')
  })

  it('does not fold when the flag is off — the calibration for every assertion above', () => {
    // Without this, every negative case in this block would still pass if folding stopped firing entirely, proving nothing. An uncalibrated null is the failure mode this repo keeps hitting.
    const { file, body } = makeIndexedSource()
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '0'
    const text = JSON.stringify(postReadHandler(postEvent(file, body)))
    expect(text).not.toContain('folded')
  })

  it('does not fold a ranged read, which is surgical already', () => {
    const { file, body } = makeIndexedSource()
    for (const input of [{ offset: 10, limit: 5 }, { limit: 5 }, { offset: 10 }]) {
      const text = JSON.stringify(postReadHandler(postEvent(file, body, input)))
      expect(text).not.toContain('folded')
    }
  })

  it('does not fold a file whose index is stale, where a span would cut at the wrong line', () => {
    const { file, body } = makeIndexedSource()
    // Change the file on disk without reindexing: the spans now describe a different file.
    fs.writeFileSync(file, '// prepended line, every span is now off by one\n' + body)
    const changed = fs.readFileSync(file, 'utf-8')
    const text = JSON.stringify(postReadHandler(postEvent(file, changed)))
    expect(text).not.toContain('folded')
  })

  it('records the FOLDED text as served, not the file on disk', () => {
    // The trap this fix exists for. recordReadAsServedOutput took its copy from readWindowFromDisk, so after a fold the store would claim the folded lines had been delivered -- and the served-run elision would then cut exactly the lines a re-read came back for, from a model that never saw them once. Storing disk content is correct only while delivered text equals disk, which a rewrite is precisely the case that breaks.
    const { file, body } = makeIndexedSource()
    const out = postReadHandler(postEvent(file, body))
    expect(JSON.stringify(out)).toContain('folded')

    const ids = getFileServedOutputs(normalizePath(file))
    expect(ids.length).toBeGreaterThan(0)
    const stored = getBashOutput(ids[ids.length - 1] ?? '')
    expect(stored).not.toBeNull()
    // The signature was delivered and must be recorded; the folded interior was not and must not.
    expect(stored?.output ?? '').toContain('export function longFunction')
    expect(stored?.output ?? '').not.toContain('localVariable59')
  })
})

/**
 * The shape Claude Code actually delivers.
 *
 * Fixture provenance: CAPTURE. The envelope and the un-numbered `file.content` below were read off
 * real `toolUseResult` records in a Claude Code session transcript on 2026-09-05 -- 104 of 104 Read
 * results carried the file's own text, none carried a `cat -n` rendering. The block above this one
 * numbers its fixture and says in a comment that numbering is "what the hook parses"; that claim was
 * written from READ_NUMBERED_ROW_RE rather than from the harness, and it was wrong. Because every
 * fold and elision test agreed with it, both post-read rewrites were dead code on this harness --
 * the fold booked 0 events across a full session while the rest of the read hook ran normally.
 */
describe('body fold against the captured Claude Code Read envelope', () => {
  const tmpFiles: string[] = []
  const prevFlag = process.env['TOKEN_GOAT_FOLD_CODE_BODIES']

  function makeIndexedSource(): { file: string; body: string } {
    const lines = [
      "import { thing } from './thing.js'",
      '',
      'export const TOP_LEVEL_CONSTANT = 42',
      '',
      'export function longFunction(n: number): number {',
    ]
    for (let i = 0; i < 60; i++) lines.push(`  const localVariable${i} = n + ${i} // body line ${i}`)
    lines.push('  return n', '}', '', 'export const TRAILING_CONSTANT = 7', '')
    const body = lines.join('\n')
    const file = path.join(os.tmpdir(), `tg-fold-cap-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(file, body)
    tmpFiles.push(file)
    indexFileSync(normalizePath(file))
    return { file, body }
  }

  /** The captured envelope: `file.content` is the file's own text, not a numbered rendering. */
  function capturedEvent(file: string, body: string): HookEvent {
    const lineCount = body.split('\n').length
    return {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: file },
      sessionId: `fold-cap-${Math.random().toString(36).slice(2)}`,
      agentId: undefined,
      raw: {
        tool_response: {
          type: 'text',
          file: { filePath: file, content: body, numLines: lineCount, startLine: 1, totalLines: lineCount },
        },
      },
    }
  }

  beforeEach(() => {
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '1'
  })

  afterEach(() => {
    if (prevFlag === undefined) delete process.env['TOKEN_GOAT_FOLD_CODE_BODIES']
    else process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = prevFlag
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* best effort */
      }
    }
  })

  it('folds a body delivered as raw file content, which is every real Read', () => {
    const { file, body } = makeIndexedSource()
    const out = postReadHandler(capturedEvent(file, body))
    const text = JSON.stringify(out)

    expect(text).toContain('folded')
    expect(text).toContain('longFunction')
    // Structure outside the body still survives, same contract as the numbered path.
    expect(text).toContain('TOP_LEVEL_CONSTANT')
    expect(text).toContain('TRAILING_CONSTANT')
    expect(text).not.toContain('localVariable59')
  })

  it('writes back un-numbered content, because that is the field it came from', () => {
    const { file, body } = makeIndexedSource()
    const out = postReadHandler(capturedEvent(file, body))
    const updated = (out as { updatedOutput?: string }).updatedOutput ?? ''
    expect(updated).not.toBe('')
    // A numbered rendering here would be numbered a second time on display. The signature must come back exactly as it sits in the file.
    expect(updated).toContain('export function longFunction(n: number): number {')
    expect(updated.split('\n').some(l => /^\s*\d+\t/.test(l))).toBe(false)
  })

  it('still folds when the harness sends no startLine at all', () => {
    const { file, body } = makeIndexedSource()
    const event = capturedEvent(file, body)
    const resp = (event.raw as Record<string, unknown>)['tool_response'] as Record<string, unknown>
    delete (resp['file'] as Record<string, unknown>)['startLine']
    expect(JSON.stringify(postReadHandler(event))).toContain('folded')
  })
})
