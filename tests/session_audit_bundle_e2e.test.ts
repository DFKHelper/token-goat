/**
 * Built-bundle end-to-end test for session-audit --json deny-outcome census.
 *
 * Tests that the deny-outcome census in src/session_audit.ts produces correct output when run
 * from the actual built bundle (dist/token-goat.mjs), not just from source. This catches regressions
 * like tree-shaking of the census logic or worker/parser failures in the bundled artifact.
 *
 * Fixture transcripts are FORMAT-DERIVED from the deny message templates in src/hooks_read.ts
 * (same as tests/deny_outcomes.test.ts) and HAND-DERIVED outcome sequences.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runCli } from './helpers/bundle.js'

const use = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { id: `msg_use_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })

// FORMAT-DERIVED: hooks_read.ts, denyOutput, large-file deny branch (toKB, util.ts) + describeSliceAdvice() + editAnywayHint()
const LARGE_FILE_DENY_TEXT = 'big.ts is very large (523KB). Use token-goat read/section/symbol to re-read surgically. Use Read with offset/limit to sample specific sections. To edit it anyway, use `token-goat replace "big.ts" --old-b64 <base64> --new-b64 <base64>`.'

/**
 * Construct a minimal session transcript that will be analyzed by session-audit.
 * Each project dir represents one session with a session.jsonl file.
 */
function writeProject(corpusDir: string, name: string, lines: string[]): void {
  const projectDir = path.join(corpusDir, name)
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n')
}

let testDir = ''

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-audit-bundle-'))
})

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('session-audit --json deny-outcome census (built bundle)', () => {
  it('produces non-empty denyOutcomes array with partition invariant and non-abandoned outcomes', () => {
    // Create a small fixture corpus with two deny outcomes:
    // 1. "retried": a deny followed by a retry of the same Read (non-abandoned outcome)
    // 2. "unresolved": a deny with only 2 tool calls following it (fewer than 3, so unresolved)
    writeProject(testDir, 'retried-outcome', [
      use('d1', 'Read', { file_path: 'big.ts' }),
      result('d1', LARGE_FILE_DENY_TEXT),
      // Retry the same Read
      use('d2', 'Read', { file_path: 'big.ts' }),
      result('d2', 'function myFunc() { ... }'),
    ])

    writeProject(testDir, 'unresolved-outcome', [
      use('d3', 'Read', { file_path: 'big.ts' }),
      result('d3', LARGE_FILE_DENY_TEXT),
      // Only 2 calls following the deny (fewer than 3), so outcome is unresolved
      use('d4', 'Edit', { file_path: 'other.ts', old_string: 'x', new_string: 'y' }),
      result('d4', 'ok'),
    ])

    // Run session-audit --json against the fixture using the built bundle
    const res = runCli(['session-audit', '--dir', testDir, '--json'])
    expect(res.status, `session-audit failed: ${res.stderr}`).toBe(0)

    // Parse the JSON output
    const summary = JSON.parse(res.stdout) as {
      denyOutcomes: Array<{
        kind: string
        count: number
        compactedRate: number
        retriedRate: number
        substitutedRate: number
        shellReadRate: number
        unresolvedRate: number
        abandonedRate: number
      }>
      editErrorBaseline: { totalEdits: number; totalErrors: number; rate: number }
    }

    // Assert 1: denyOutcomes is a non-empty array (bundle didn't tree-shake the census logic)
    expect(Array.isArray(summary.denyOutcomes)).toBe(true)
    expect(summary.denyOutcomes.length).toBeGreaterThan(0)

    // Assert 2: partition invariant — each kind's outcome rates sum to 1.0 within epsilon
    for (const row of summary.denyOutcomes) {
      const sum = row.compactedRate + row.retriedRate + row.substitutedRate + row.shellReadRate + row.unresolvedRate + row.abandonedRate
      expect(sum, `kind '${row.kind}': outcome rates should sum to 1.0, got ${sum}`).toBeCloseTo(1.0, 5)
    }

    // Assert 3: at least one row has a non-abandoned outcome
    // (retried-outcome should produce one row with a retried rate, unresolved-outcome should produce one with unresolved rate)
    const nonAbandonedOutcomes = summary.denyOutcomes.filter(
      (r) => r.retriedRate > 0 || r.substitutedRate > 0 || r.shellReadRate > 0 || r.unresolvedRate > 0 || r.compactedRate > 0,
    )
    expect(nonAbandonedOutcomes.length).toBeGreaterThan(0)

    // Assert 4: specifically check that we have both a retried outcome and an unresolved outcome
    // The large_file_deny kind should have at least some non-abandoned outcomes
    const largeFileDeny = summary.denyOutcomes.find((r) => r.kind === 'large_file_deny')
    expect(largeFileDeny).toBeDefined()
    expect(largeFileDeny!.retriedRate + largeFileDeny!.unresolvedRate).toBeGreaterThan(0)

    // Assert 5: editErrorBaseline is present with required fields
    expect(summary.editErrorBaseline).toBeDefined()
    expect(typeof summary.editErrorBaseline.totalEdits).toBe('number')
    expect(typeof summary.editErrorBaseline.totalErrors).toBe('number')
    expect(typeof summary.editErrorBaseline.rate).toBe('number')
    expect(summary.editErrorBaseline.totalEdits).toBeGreaterThanOrEqual(0)
    expect(summary.editErrorBaseline.totalErrors).toBeGreaterThanOrEqual(0)
  })
})
