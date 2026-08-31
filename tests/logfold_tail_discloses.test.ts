/**
 * `logfold --tail N` disclosure guard.
 *
 * Named by the `logfold` exemption in tests/guards/truncation_invariant_holds.test.ts: that guard
 * drives every row-limited command through one oracle -- "the disclosed total equals the pre-cap
 * count of the emitted rows" -- and logfold is the one command where that quantity does not exist.
 * Its cap is on INPUT LINES while its payload is FOLDED ROWS, and folding is lossy by design
 * (fourteen lines identical after number-normalization collapse to a single `(x14)` row), so the
 * two counts are in different units. Reporting one as the other's total would state a ratio that
 * is untrue of either -- the shape of accounting bug this whole guard family exists to catch.
 *
 * So logfold discloses in its own units, and this file is where that is checked.
 *
 * Provenance: CAPTURE. Every expectation below was read off the built bundle
 * (`node dist/token-goat.mjs logfold app.log --tail 2 --json`) run against the fixture this file
 * writes, not off cmdLogfold's source. The `inputLines: 14` expectation in particular caught a
 * real off-by-one: splitLines leaves a trailing empty element for a file ending in a newline, and
 * the first version of this code reported 15 for a 14-line file -- a total the reader can never
 * reach with any --tail value, which is exactly what trimToBudget's own comment warns about.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { cmdLogfold } from '../src/text_commands.js'
import { captureStdout } from './helpers/capture-stdout.js'

let dir = ''
let log = ''
/** 14 lines, trailing newline. Normalization masks the digits, so all 14 fold to one row. */
const LINE_COUNT = 14

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logfold-'))
  log = path.join(dir, 'app.log')
  fs.writeFileSync(log, Array.from({ length: LINE_COUNT }, (_, i) => `line ${i + 1} of the log`).join('\n') + '\n')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run cmdLogfold, capturing both channels; stderr is where the text-mode notice lands. */
function run(opts: Parameters<typeof cmdLogfold>[1]): { out: string; err: string } {
  let err = ''
  const origErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    if (typeof chunk === 'string') err += chunk
    return true
  }) as typeof process.stderr.write
  try {
    const out = captureStdout(() => {
      cmdLogfold(log, opts)
    })
    return { out, err }
  } finally {
    process.stderr.write = origErr
  }
}

function json(opts: Parameters<typeof cmdLogfold>[1]): Record<string, unknown> {
  return JSON.parse(run({ ...opts, json: true }).out) as Record<string, unknown>
}

describe('logfold --tail discloses the lines it dropped', () => {
  it('counts input lines, not the folded rows they collapse into', () => {
    const d = json({ tail: '2' })

    // The distinction this file exists for. If these two were ever equal the units would have
    // been conflated, and the assertion below would stop meaning anything.
    expect((d.lines as unknown[]).length, 'the fixture must fold, or the two units are not distinguishable here').toBeLessThan(
      LINE_COUNT,
    )
    expect(d.inputLines, 'inputLines must count the log’s lines, not the rows they folded into').toBe(LINE_COUNT)
    expect(d.shownLines).toBe(2)
    expect(d.truncated).toBe(true)
  })

  it('does not count the empty element a trailing newline leaves behind', () => {
    // The off-by-one this file's provenance note records. A 14-line file reports 14, not 15.
    expect(json({ tail: '2' }).inputLines).toBe(LINE_COUNT)

    const noNewline = path.join(dir, 'nonl.log')
    fs.writeFileSync(noNewline, 'a\nb\nc')
    const out = captureStdout(() => {
      cmdLogfold(noNewline, { tail: '2', json: true })
    })
    expect((JSON.parse(out) as Record<string, unknown>).inputLines, 'a file with no trailing newline must count the same way').toBe(3)
  })

  it('says nothing when the tail keeps every line', () => {
    // The negative half. A notice printed unconditionally, or a hard-coded `truncated: true`,
    // passes the case above on its own.
    for (const tail of [String(LINE_COUNT), '999']) {
      const d = json({ tail })
      expect(d.truncated, `--tail ${tail} keeps all ${LINE_COUNT} lines and must not report a cut`).toBe(false)
      expect(d.shownLines).toBe(LINE_COUNT)
      expect(run({ tail }).err, `--tail ${tail} keeps every line and must print no notice`).toBe('')
    }

    // No --tail at all is the same case by a different route.
    expect(json({}).truncated).toBe(false)
  })

  it('prints the count on stderr in text mode, where there is no payload to carry it', () => {
    const { err } = run({ tail: '2' })
    expect(err.trim()).toBe(`Showing last 2 of ${LINE_COUNT} lines (raise --tail to see more).`)
  })

  it('reports the boundary exactly: one line short of the whole file is still a cut', () => {
    const d = json({ tail: String(LINE_COUNT - 1) })
    expect(d.truncated).toBe(true)
    expect(d.shownLines).toBe(LINE_COUNT - 1)
    expect(d.inputLines).toBe(LINE_COUNT)
  })
})
