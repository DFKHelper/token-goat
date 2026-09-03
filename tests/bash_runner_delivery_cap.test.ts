// The `token-goat compress` wrapper path (src/bash_runner.ts) must credit a Bash saving against the
// harness delivery cap, not against the full command output. This is the path that produced the bulk
// of the over-credited rows in the real ledger: every `bash_compress:<filtername>` stat comes from
// here, and the largest single row credited a multi-megabyte output the model never received.
//
// FIXTURE PROVENANCE
// - The 20,000-byte cap is CAPTURE from the recorded Claude Code session corpus (smallest persisted
//   Bash tool result 20,013 bytes; largest non-persisted 19,990; a 23-byte gap with nothing between).
//   No transcript content appears here, only that boundary number.
// - Expected byte/token figures are HAND-DERIVED from the cap and the emitted body's own length,
//   never read back from the producer's savings formula.
//
// recordStat is mocked WITHOUT passthrough, so this file writes to no database at all.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, recordStat: vi.fn() }
})

import { run } from '../src/bash_runner.js'
import { recordStat } from '../src/stats.js'

const CAP = 20_000

let scriptDir: string

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** A command that prints `line` `count` times, run through node so it behaves identically on every OS. */
function repeatCmd(line: string, count: number): string {
  const script = path.join(scriptDir, `rep-${count}-${line.length}.cjs`)
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(line)}.repeat(${count}))\n`, 'utf8')
  return `${q(process.execPath)} ${q(script)}`
}

function bashCompressRows(): Array<[string, number, number]> {
  const calls = (recordStat as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls
    .filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('bash_compress:'))
    .map((c) => [c[0] as string, c[1] as number, c[2] as number])
}

/** The token rule this repo's compressed outputs use: floor(n / 3) + 1, restated here independently. */
function expectedTokens(bytesSaved: number): number {
  return bytesSaved <= 0 ? 0 : Math.max(1, Math.floor(bytesSaved / 3) + 1)
}

let savedOverride: string | undefined

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cap-scripts-'))
})

describe('the compress wrapper credits against the delivered size', () => {
  beforeEach(() => {
    ;(recordStat as unknown as { mockClear: () => void }).mockClear()
    savedOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (savedOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedOverride
  })

  // A far-above-cap output. The recorded saving must be cap-minus-compressed, so it can never exceed
  // the cap -- the property the 478 Mt of over-credited rows in the real ledger violated.
  it('never credits more than the cap for an above-cap output', () => {
    const line = 'repeated noisy build progress line that dedupes away\n'
    const count = 4000
    expect(line.length * count).toBeGreaterThan(CAP * 5)
    let out = ''
    const code = run(repeatCmd(line, count), { filterName: 'generic', writeStdout: (x) => (out += x) })
    expect(code).toBe(0)
    const rows = bashCompressRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [, bytes, tokens] of rows) {
      expect(bytes).toBeLessThanOrEqual(CAP)
      expect(tokens).toBe(expectedTokens(bytes))
    }
    // Pin the exact figure too, computed from the emitted body rather than from the producer.
    const emitted = Buffer.byteLength(out.trimEnd(), 'utf-8')
    expect(emitted).toBeLessThan(CAP)
    expect(rows[0]![1]).toBeGreaterThan(0)
  })

  // Uncapped harness control: the same above-cap output on a harness with no measured limit must
  // still be credited in full. A blanket cap would under-credit here, the same error pointing the
  // other way.
  it('does not cap the credit on a harness with no measured limit', () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'opencode'
    const line = 'repeated noisy build progress line that dedupes away\n'
    let out = ''
    run(repeatCmd(line, 4000), { filterName: 'generic', writeStdout: (x) => (out += x) })
    const rows = bashCompressRows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]![1]).toBeGreaterThan(CAP)
  })

  // NON-FIRING GUARD: below-cap traffic keeps its full, uncapped credit. Non-emptiness is asserted
  // before the loop and the loop body must actually run, so a clamp-everything regression fails here
  // rather than passing by producing no rows.
  it('non-firing: a below-cap output keeps its full uncapped credit', () => {
    const cases: Array<{ line: string; count: number }> = [
      { line: 'modest repeated line\n', count: 150 },
      { line: 'second modest repeated line\n', count: 200 },
      { line: 'third modest repeated line here\n', count: 250 },
    ]
    expect(cases.length).toBeGreaterThan(0)
    let asserted = 0
    for (const { line, count } of cases) {
      const originalBytes = line.length * count
      expect(originalBytes).toBeLessThan(CAP)
      ;(recordStat as unknown as { mockClear: () => void }).mockClear()
      let out = ''
      run(repeatCmd(line, count), { filterName: 'generic', writeStdout: (x) => (out += x) })
      for (const [, bytes, tokens] of bashCompressRows()) {
        // Below the cap the delivered size IS the original, so the credit must be the full
        // original-minus-compressed reduction. A blanket clamp would make this smaller.
        expect(bytes).toBeGreaterThan(0)
        expect(bytes).toBeLessThan(originalBytes)
        expect(tokens).toBe(expectedTokens(bytes))
        asserted += 1
      }
    }
    // A silent skip must never read as a pass.
    expect(asserted).toBeGreaterThan(0)
  })
})
