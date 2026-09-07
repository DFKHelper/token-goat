/**
 * The shell read door's `windowed` argument to foldDelivery (hooks_bash.ts `foldShellReadBodies`).
 *
 * foldShellReadBodies called foldDelivery with three arguments, so `windowed` took its default of false for every shell read, while the Read door computed it from offset/limit. The shell door therefore folded comment and prose blocks sitting at the edge of a slice, whose recall notice points at a ranged Read of exactly the span it replaced: following that pointer re-enters the planner on rows that are entirely one comment run and folds them again, handing back the two kept lines where n were promised.
 *
 * Fixture provenance: HAND-DERIVED, with the block position CAPTURED from the real file at run time. The delivered output is computed by slicing the target file, independently of the code under test, which is the same convention tests/bash_body_fold.test.ts uses. The command spellings (`sed -n 'A,Bp' FILE`, `head -n N FILE`) are ordinary shell idioms a person types, not shapes read off this repo's own matchers. The block's line numbers are discovered by scanning the file rather than written down, so a comment edited elsewhere cannot silently move the window off the block and leave these assertions passing against nothing; each locator throws instead.
 *
 * The notice wording asserted here is CAPTURE: `... 25 more comment lines (3-27) folded -- Read "tests/bash_body_fold.test.ts" with offset=3, limit=25` was observed in real token-goat output during this work, and matches commentFoldNotice.
 *
 * Two things this file deliberately does not cover, recorded so their absence reads as a decision rather than an oversight. First, only the end-side half of the edge rule is exercised. A comment fold keeps COMMENT_FOLD_KEEP_LINES rows before folding, so its startIdx is never zero and `startIdx > 0` cannot fire for it; that half is live only for prose folds, which are one row wide. Second, no case here fails when `windowed` is forced true rather than false, so the file catches the regression that actually shipped and not its mirror image. A prose start-edge case was written for both gaps and then removed: whether an interior prose row folds depends on the exact window rather than only on the row, so the candidate chosen did not fold on the asserted window under either value of `windowed`, and the test passed for a reason unrelated to the rule it named.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { COMMENT_FOLD_MIN_BLOCK } from '../src/fold_delivery.js'
import { postBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A comment run found in a real file: 1-based inclusive bounds plus the file's own line count. */
interface Block { rel: string; lines: string[]; total: number; start: number; end: number }

function isCommentLine(l: string): boolean {
  const s = l.trim()
  return s.startsWith('*') || s.startsWith('/*') || s.startsWith('//')
}

/** The longest comment run in `rel`, requiring `before` lines above it and `after` below, so a caller can build a window that holds it strictly inside. Throws rather than returning a run that cannot carry the case, since a silently-unsuitable block turns every assertion below into a test of nothing. Candidate windows containing a backtick are skipped: in a language whose block comments open with a slash-star, a backtick is ambiguous between prose punctuation and a template literal opening, and a reader tracking template state across the delivered rows may legitimately treat the run as interrupted. That ambiguity is a property of the input, so a window carrying it cannot isolate the edge rule these tests are about. The first block chosen here was 50 lines of JSDoc documenting JSON wire shapes in markdown code spans, which did not fold at all and made the negative assertions vacuous. */
function longestBlock(rel: string, before: number, after: number): Block {
  const lines = readFileSync(path.join(REPO, rel), 'utf-8').split('\n')
  let best: { start: number; end: number } | null = null
  let run = 0
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && isCommentLine(lines[i] ?? '')) { run++; continue }
    if (run >= COMMENT_FOLD_MIN_BLOCK + 2) {
      const start = i - run + 1
      const end = i
      const ok = start > before && lines.length - end >= after && !lines.slice(start - before - 1, end + after).some((l) => l.includes('`'))
      if (ok && (best === null || end - start > best.end - best.start)) best = { start, end }
    }
    run = 0
  }
  if (best === null) throw new Error(`no backtick-free comment run of ${COMMENT_FOLD_MIN_BLOCK + 2}+ lines in ${rel} with ${before} lines above and ${after} below; fixture assumption broken`)
  return { rel, lines, total: lines.length, start: best.start, end: best.end }
}

/** A comment run that begins on line 1, for the `head` cases where the block necessarily touches the first delivered row. */
function leadingBlock(rel: string): Block {
  const lines = readFileSync(path.join(REPO, rel), 'utf-8').split('\n')
  let run = 0
  while (run < lines.length && isCommentLine(lines[run] ?? '')) run++
  if (run < COMMENT_FOLD_MIN_BLOCK + 2) throw new Error(`${rel} does not open with a ${COMMENT_FOLD_MIN_BLOCK + 2}+ line comment run; fixture assumption broken`)
  return { rel, lines, total: lines.length, start: 1, end: run }
}

/** What `sed -n 'lo,hip' file` prints, computed from the range rather than from the code under test. */
function slice(b: Block, lo: number, hi: number): string {
  return b.lines.slice(lo - 1, hi).join('\n')
}

function postEvent(command: string, output: string, sessionId: string) {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode: 0 } },
  })
}

async function deliver(command: string, output: string, sessionId: string): Promise<string> {
  const out = await postBashHandler(postEvent(command, output, sessionId))
  return out.hookType === 'rewriteOutput' ? out.updatedOutput : output
}

const COMMENT_FOLD_MARK = /\.{3} \d+ more comment lines \(\d+-\d+\) folded/

/** The notice this specific block produces when it folds, so a positive assertion cannot be satisfied by some unrelated block elsewhere in the same delivery. Both the arithmetic and the wording are CAPTURE: with COMMENT_FOLD_KEEP_LINES kept, the block at 129-176 of src/bridges/copilot_cli.ts emitted `... 46 more comment lines (131-176) folded` and the block at 1-54 of src/xml_parser.ts emitted `... 52 more comment lines (3-54) folded`, both observed in real handler output during this work. Forcing `windowed` true for every shell read left a bare "did anything fold" check passing, because another block in the same file folded instead; only naming the range caught that. */
function noticeFor(b: Block): RegExp {
  return new RegExp(`\\.{3} ${b.end - b.start - 1} more comment lines \\(${b.start + 2}-${b.end}\\) folded`)
}

const SAVED: Record<string, string | undefined> = {}
const KEYS = ['TOKEN_GOAT_FOLD_CODE_BODIES', 'TOKEN_GOAT_FOLD_COMMENT_BLOCKS']
for (const k of KEYS) SAVED[k] = process.env[k]

afterAll(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k] as string
  }
})

describe('foldShellReadBodies: a slice does not fold a comment block at its edge', () => {
  beforeEach(() => {
    // Body folds are off so every assertion below is about the comment planner alone; leaving them on would let a body fold satisfy a "something was folded" check that the comment fold no longer does. Comment folding is pinned on rather than relied on as a default, so a change to that default cannot quietly empty this file.
    process.env['TOKEN_GOAT_FOLD_CODE_BODIES'] = '0'
    process.env['TOKEN_GOAT_FOLD_COMMENT_BLOCKS'] = '1'
    clearModuleCaches()
  })

  it('folds a comment block sitting strictly inside a sed window, which is the capability the edge rule leaves intact', async () => {
    const b = longestBlock('src/bridges/copilot_cli.ts', 4, 8)
    const lo = b.start - 4
    const hi = b.end + 8
    const cmd = `sed -n '${lo},${hi}p' ${b.rel}`
    const body = await deliver(cmd, slice(b, lo, hi), 'interior')

    expect(body).toMatch(noticeFor(b))
    // Must-not-drop: a "did it fold" assertion alone is satisfied by collapsing the block whole, which is the outcome the kept-lines rule exists to prevent.
    expect(body).toContain(b.lines[b.start - 1] as string)
  })

  it('leaves a comment block alone when the sed window ends inside it, so following the recall pointer returns the lines it promised', async () => {
    const b = longestBlock('src/bridges/copilot_cli.ts', 4, 8)
    const lo = b.start - 4
    // Cut the window off inside the run, leaving enough comment rows to still clear the planner's minimum: without the edge rule this folds, and its pointer would re-fold.
    const hi = b.start + COMMENT_FOLD_MIN_BLOCK + 1
    if (hi >= b.end) throw new Error('block too short to truncate inside; fixture assumption broken')
    const cmd = `sed -n '${lo},${hi}p' ${b.rel}`
    const delivered = slice(b, lo, hi)
    const body = await deliver(cmd, delivered, 'edge')

    expect(body).not.toMatch(COMMENT_FOLD_MARK)
    expect(body).toBe(delivered)
  })

  it('still folds a leading comment block when head returned fewer lines than it asked for, because that is the whole file and not a window', async () => {
    const b = leadingBlock('src/xml_parser.ts')
    // Asking past the end is what makes this provably unwindowed: the reply is short of the request, so nothing was truncated.
    const cmd = `head -n ${b.total + 50} ${b.rel}`
    const body = await deliver(cmd, b.lines.join('\n'), 'wholehead')

    expect(body).toMatch(noticeFor(b))
    expect(body).toContain(b.lines[0] as string)
  })

  it('leaves a leading comment block alone when head truncated the file, since the tail it cut off is exactly what the recall would re-fold', async () => {
    const b = leadingBlock('src/xml_parser.ts')
    const n = COMMENT_FOLD_MIN_BLOCK + 6
    if (n >= b.end) throw new Error('leading block too short to truncate inside; fixture assumption broken')
    const cmd = `head -n ${n} ${b.rel}`
    const delivered = b.lines.slice(0, n).join('\n')
    const body = await deliver(cmd, delivered, 'truncated')

    expect(body).not.toMatch(COMMENT_FOLD_MARK)
    expect(body).toBe(delivered)
  })

})
