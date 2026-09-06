/**
 * Body-fold coverage.
 *
 * Fixture provenance: every numbered-read fixture below is HAND-DERIVED -- the `N\tline` rendering is written from the shape READ_NUMBERED_ROW_RE accepts, and the line contents are synthetic source written for this test. That is the right tier for logic (does the planner cut where it should) and explicitly NOT evidence about the wire format Claude Code emits; the e2e block below covers the shipping path by indexing a real file and driving the real handler, which is what this repo's "critical path" rule requires of anything touching the indexer or a hook.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { planBodyFolds, planCommentFolds, mergeFolds, commentSyntaxFor, foldDetail, MAX_FOLD_DETAIL, type FoldSpan } from '../src/code_fold.js'
import { postReadHandler } from '../src/hooks_read.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/util.js'
import { getFileServedOutputs } from '../src/session.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { dirtyQueuePath } from '../src/hooks_index.js'
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

  it('declines an offset the delivered rows do not confirm, rather than folding against invented line numbers', () => {
    // A bare string `tool_response` carries no `file.startLine`, so there is no evidence of where the window began and the rows below get numbered from 1. Folding against those numbers would let `planBodyFolds` match a span by coincidence and withhold lines the reader never saw. Declining is the only safe answer; the captured-envelope block below covers the case where the harness does confirm the offset and the fold is allowed to run.
    const { file, body } = makeIndexedSource()
    for (const input of [{ offset: 10, limit: 5 }, { offset: 10 }]) {
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

  it('writes the folded file and symbol into the stat row, so the cost side is recoverable from the ledger', () => {
    // The gap this closes. `read:body_fold` recorded how many bytes it saved and nothing about what it removed, so how often a reader has to come back for a folded span could not be computed however long the feature ran -- and that unmeasurable cost is the reason the flag stays off by default. Asserted end to end rather than on foldDetail alone: the value was being dropped by emitRewrite, which called recordStat with three arguments, so a unit test of the formatter would have passed against the broken shipping path.
    const { file, body } = makeIndexedSource()
    const db = getDb(globalDbPath())
    const countOf = (): number =>
      (db.prepare("SELECT count(*) c FROM stats WHERE kind='read:body_fold'").get() as { c: number }).c
    const before = countOf()

    expect(JSON.stringify(postReadHandler(postEvent(file, body)))).toContain('folded')
    expect(countOf()).toBe(before + 1)

    const row = db
      .prepare("SELECT detail FROM stats WHERE kind='read:body_fold' ORDER BY id DESC LIMIT 1")
      .get() as { detail: string | null }
    expect(row.detail).toBeTruthy()
    // The shape a recovery read would use, so a later `read "file::symbol"` joins back to the fold that provoked it.
    expect(row.detail).toContain('::')
    expect(row.detail).toContain('longFunction')
    expect(row.detail).toContain(normalizePath(file))
  })

  /** What the dirty queue gained while `run` executed, so an unrelated concurrent append cannot be mistaken for this read's. */
  function queueDelta(run: () => void): string {
    const read = (): string => {
      try {
        return fs.readFileSync(dirtyQueuePath(), 'utf8')
      } catch {
        return ''
      }
    }
    const before = read()
    run()
    return read().slice(before.length)
  }

  it('queues a parser-stale file for reindex, so the next read of it can fold bodies', () => {
    const { file, body } = makeIndexedSource()
    // Content is untouched, only the extraction logic moved on. This is the case files.sha alone cannot see and the one that left 22 of 54 foldable reads unfolded in the transcript measurement.
    getDb(globalDbPath())
      .prepare('UPDATE files SET parser_sha = ? WHERE path = ?')
      .run('stale-parser-fingerprint', normalizePath(file))
    const delta = queueDelta(() => {
      // Without usable spans there is nothing here to fold, so this read passes through whole. That pass-through IS the miss the enqueue exists to repair, and it is why the queue entry has to be written on the way past rather than after a successful fold.
      expect(JSON.stringify(postReadHandler(postEvent(file, body)))).toBe('{"hookType":"pass"}')
    })
    expect(delta).toContain(path.basename(file))
  })

  it('does not queue a file whose index is already fresh — the calibration for the test above', () => {
    // Without this, the assertion above would pass just as well if the hook enqueued on every single read, which would append to the dirty queue on the hottest path in the tool.
    const { file, body } = makeIndexedSource()
    const delta = queueDelta(() => {
      expect(JSON.stringify(postReadHandler(postEvent(file, body)))).toContain('folded')
    })
    expect(delta).not.toContain(path.basename(file))
  })

  it('names the file relative to the project root in the fold notice, not by absolute path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fold-proj-'))
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    const nested = path.join(root, 'src', 'deeply', 'nested')
    fs.mkdirSync(nested, { recursive: true })
    const file = path.join(nested, 'folded.ts')
    const { body } = makeIndexedSource()
    fs.writeFileSync(file, body)
    tmpFiles.push(file)
    indexFileSync(normalizePath(file))
    const base = postEvent(file, body)
    const event: HookEvent = { ...base, raw: { ...(base.raw as Record<string, unknown>), cwd: root } }
    const text = JSON.stringify(postReadHandler(event))

    expect(text).toContain('folded')
    expect(text).toContain('src/deeply/nested/folded.ts::longFunction')
    // The absolute form is what the notice used to repeat once per fold, and on Windows it is most of the notice.
    expect(text).not.toContain(normalizePath(root))
  })
})

describe('foldDetail', () => {
  function bodyFold(name: string) {
    return { startIdx: 0, len: 5, name, kind: 'body' as const, firstLine: 1, lastLine: 5 }
  }

  it('joins the path to every folded symbol name', () => {
    expect(foldDetail('src/a.ts', [bodyFold('one'), bodyFold('two')])).toBe('src/a.ts::one,two')
  })

  it('names a comment fold by the line span its notice points at, having no symbol to name', () => {
    const comment = { startIdx: 9, len: 12, name: '', kind: 'comment' as const, firstLine: 10, lastLine: 21 }
    expect(foldDetail('src/a.ts', [comment])).toBe('src/a.ts::#10-21')
  })

  it('truncates to the cap and says how many were dropped, so one pathological file cannot bloat the row', () => {
    const many = Array.from({ length: 200 }, (_, i) => bodyFold(`symbolNumber${i}`))
    const out = foldDetail('src/a.ts', many)
    expect(out.length).toBeLessThanOrEqual(MAX_FOLD_DETAIL)
    expect(out).toMatch(/,\+\d+ more$/)
    expect(out.startsWith('src/a.ts::symbolNumber0,')).toBe(true)
  })

  it('keeps the path when it alone eats the budget, since the file is the part a join needs', () => {
    const longPath = `src/${'d'.repeat(MAX_FOLD_DETAIL)}/a.ts`
    expect(foldDetail(longPath, [bodyFold('one'), bodyFold('two')])).toBe(`${longPath}::+2 folds`)
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

  /** A real ranged Read: `content` holds only the window, `startLine` is the requested offset, and `totalLines` still describes the whole file. Fixture provenance: CAPTURE. This key set and the `startLine === offset` contract were read off 798 ranged Read results in Claude Code session transcripts on 2026-09-06 -- 566 carried a `file` object, of which 562 reported `startLine` exactly equal to the requested offset; the four that did not were negative offsets the harness clamps to line 1. The remaining 232 carried no `file` object at all (166 error strings, 66 with no result record), which is why the absence of `startLine` has to decline rather than default. */
  function rangedEvent(file: string, body: string, offset: number, limit: number): HookEvent {
    const all = body.split('\n')
    const window = all.slice(offset - 1, offset - 1 + limit)
    return {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: file, offset, limit },
      sessionId: `fold-rng-${Math.random().toString(36).slice(2)}`,
      agentId: undefined,
      raw: {
        tool_response: {
          type: 'text',
          file: { filePath: file, content: window.join('\n'), numLines: window.length, startLine: offset, totalLines: all.length },
        },
      },
    }
  }

  it('folds a window wide enough to hold the declaration, which is most of the ranged Read surface', () => {
    // `longFunction` is declared on line 5, so a window opening there shows the reader the signature the fold notice names. This is the case the old blanket offset/limit exemption was throwing away: measured across the same transcripts, 4,801 ranged reads of code files totalled 14.89 MB and 84% of them opened a window of 20 lines or more.
    const { file, body } = makeIndexedSource()
    const text = JSON.stringify(postReadHandler(rangedEvent(file, body, 5, 60)))
    expect(text).toContain('folded')
    expect(text).toContain('longFunction')
    expect(text).toContain('export function longFunction')
    expect(text).not.toContain('localVariable59')
  })

  it('leaves a window sitting inside the body untouched, because its declaration was never delivered', () => {
    // Lines 20-49 are all body. Folding here would replace every delivered row with a notice naming a symbol whose signature the reader never saw, so `planBodyFolds` declines on containment and the caller gets the exact window asked for. This is the property that makes lifting the exemption safe, so it is asserted line by line rather than on the absence of the word "folded".
    const { file, body } = makeIndexedSource()
    const out = postReadHandler(rangedEvent(file, body, 20, 30))
    const text = JSON.stringify(out)
    expect(text).not.toContain('folded')
    expect(JSON.stringify(out)).toBe('{"hookType":"pass"}')
  })

  it('declines when startLine contradicts the requested offset', () => {
    // The harness clamps a negative offset to line 1. Trusting the offset there would shift every row number and fold the wrong span; trusting `startLine` alone would silently answer a different question.
    const { file, body } = makeIndexedSource()
    const event = rangedEvent(file, body, 5, 60)
    ;(event.toolInput as Record<string, unknown>)['offset'] = 40
    expect(JSON.stringify(postReadHandler(event))).toBe('{"hookType":"pass"}')
  })

  it('declines a ranged read whose envelope carries no startLine, the 29% shape', () => {
    const { file, body } = makeIndexedSource()
    const event = rangedEvent(file, body, 5, 60)
    const resp = (event.raw as Record<string, unknown>)['tool_response'] as Record<string, unknown>
    delete (resp['file'] as Record<string, unknown>)['startLine']
    expect(JSON.stringify(postReadHandler(event))).toBe('{"hookType":"pass"}')
  })
})

/**
 * Comment folding.
 *
 * Fixture provenance: HAND-DERIVED. The rows below are synthetic source written for this test and
 * the expected spans are computed from the inputs by hand, independently of the planner. That is
 * the right tier for logic and explicitly NOT evidence about any wire format; the captured-envelope
 * block above is what covers the shape Claude Code actually delivers.
 *
 * The markdown case is the one that matters most. A run of `#` lines is a comment block in Python
 * and a run of headings in Markdown, so a content sniff would fold a document's entire heading
 * structure -- the one thing a reader navigates by. Keying on extension is what prevents that, and
 * the assertion below fails if anyone swaps it for a sniff.
 */
function crows(lines: string[], from = 1): Array<{ no: number; text: string }> {
  return lines.map((text, i) => ({ no: from + i, text }))
}

describe('commentSyntaxFor', () => {
  it('never returns a syntax for markdown, whose # runs are headings rather than comments', () => {
    expect(commentSyntaxFor('doc.md')).toBeNull()
    expect(commentSyntaxFor('README.markdown')).toBeNull()
  })

  it('returns nothing for an unknown or extensionless path, the safe direction', () => {
    expect(commentSyntaxFor('Makefile')).toBeNull()
    expect(commentSyntaxFor('notes.xyz')).toBeNull()
  })

  it('resolves the three families it supports', () => {
    expect(commentSyntaxFor('a.ts')?.line).toEqual(['//'])
    expect(commentSyntaxFor('a.ts')?.open).toBe('/*')
    expect(commentSyntaxFor('a.py')?.line).toEqual(['#'])
    expect(commentSyntaxFor('a.sql')?.line).toEqual(['--'])
  })
})

describe('planCommentFolds', () => {
  const ts = commentSyntaxFor('x.ts')

  it('keeps the summary rows of a long block and folds the rationale under them', () => {
    const lines = ['/**', ' * Summary line.', ...Array.from({ length: 12 }, (_, i) => ` * rationale ${i}`), ' */', 'code()']
    const folds = planCommentFolds(crows(lines), ts, 2, 12, new Set())
    expect(folds).toHaveLength(1)
    // Rows 1-2 (the opener and the summary) survive; the fold starts at row 3 and runs to the `*/`.
    expect(folds[0]?.firstLine).toBe(3)
    expect(folds[0]?.lastLine).toBe(15)
    expect(folds[0]?.kind).toBe('comment')
  })

  it('folds a long run of line comments', () => {
    const lines = [...Array.from({ length: 14 }, (_, i) => `// note ${i}`), 'code()']
    const folds = planCommentFolds(crows(lines), ts, 2, 12, new Set())
    expect(folds).toHaveLength(1)
    expect(folds[0]?.firstLine).toBe(3)
    expect(folds[0]?.lastLine).toBe(14)
  })

  it('leaves a block shorter than commentMinBlock alone', () => {
    const lines = [...Array.from({ length: 8 }, (_, i) => `// note ${i}`), 'code()']
    expect(planCommentFolds(crows(lines), ts, 2, 12, new Set())).toEqual([])
  })

  it('folds nothing when the extension has no known comment syntax', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `# heading ${i}`)
    expect(planCommentFolds(crows(lines), commentSyntaxFor('doc.md'), 2, 12, new Set())).toEqual([])
  })

  it('skips rows a body fold already claimed, which would otherwise bill the same lines twice', () => {
    const lines = [...Array.from({ length: 14 }, (_, i) => `// note ${i}`), 'code()']
    const claimed = new Set([5, 6, 7])
    expect(planCommentFolds(crows(lines), ts, 2, 12, claimed)).toEqual([])
  })

  it('refuses a run whose delivered line numbers are not contiguous', () => {
    const rows = [...crows(Array.from({ length: 7 }, (_, i) => `// a ${i}`), 1), ...crows(Array.from({ length: 7 }, (_, i) => `// b ${i}`), 100)]
    expect(planCommentFolds(rows, ts, 2, 12, new Set())).toEqual([])
  })

  it('does not treat a one-row /* ... */ as opening a block that swallows the code after it', () => {
    const lines = ['/* short */', 'code1()', 'code2()', ...Array.from({ length: 20 }, (_, i) => `real${i}()`)]
    expect(planCommentFolds(crows(lines), ts, 2, 12, new Set())).toEqual([])
  })
})

describe('mergeFolds', () => {
  it('drops a comment fold overlapping a body fold and keeps the body fold, which names a command', () => {
    const body = planBodyFolds(rowsFor(60), [span('big', 1, 40)], 10, 25)
    const overlapping = [{ startIdx: 12, len: 5, name: 'comment', kind: 'comment' as const, firstLine: 13, lastLine: 17 }]
    const merged = mergeFolds(body, overlapping)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.kind).toBe('body')
  })

  it('keeps both when they do not overlap, in position order', () => {
    const body = planBodyFolds(rowsFor(60), [span('big', 1, 20)], 5, 15)
    const later = [{ startIdx: 40, len: 5, name: 'comment', kind: 'comment' as const, firstLine: 41, lastLine: 45 }]
    const merged = mergeFolds(body, later)
    expect(merged).toHaveLength(2)
    expect(merged[0]!.startIdx).toBeLessThan(merged[1]!.startIdx)
  })
})
