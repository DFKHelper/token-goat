// Batch A — test-runner filters. Each is a thin config over the shared Node test-runner family (see families.ts); the loop lives there once. Faithful port of the Python `JestFilter` / `VitestFilter`.
//
// Jest's binary set also covers Mocha / Ava / Tap — their reporters share Jest's PASS/FAIL header + summary shape, so one config serves all four.

import type { ToolFilter } from './base.js'
import { makeNodeTestRunnerFilter } from './families.js'

/**
 * Jest (and Mocha / Ava / Tap): collapse `PASS file` headers and per-test ✓
 * ticks to counts, keep `FAIL` blocks verbatim, keep the `Test Suites:` /
 * `Tests:` summary, collapse `console.*` blocks, and drop the `--verbose`
 * duplicate `Failures:` section.
 */
export const jestFilter: ToolFilter = makeNodeTestRunnerFilter({
  name: 'jest',
  binaries: ['jest', 'mocha', 'ava', 'tap'],
  // File-level PASS header: `PASS  src/foo.test.js`, or a bare `✓ file` at col 0.
  passFileRe: /^(?:\s*PASS\s+\S|[✓√]\s+\S)/,
  failFileRe: /^\s*(?:FAIL|✗|×|✘)\s+\S/,
  summaryRe: /^(Test Suites|Tests|Snapshots|Time|Ran all test suites):/,
  // Per-test tick: any ✓/√ line not already claimed as a file header above.
  testTickRe: /^\s*[✓√]/,
  outputHdrRe: /^\s*console\.(log|error|warn|info|debug)\s/,
  outputNoun: 'console output',
  passFileNoun: 'PASS file',
  failuresSection: true,
})

/**
 * Vitest: collapse file-level `✓ file (Xms)` pass headers and indented per-test
 * ✓ ticks to counts, keep `×` / `FAIL` blocks verbatim, keep the `Test Files` /
 * `Tests` / `Duration` summary, and collapse `stdout |` output blocks.
 */
export const vitestFilter: ToolFilter = makeNodeTestRunnerFilter({
  name: 'vitest',
  binaries: ['vitest'],
  // File-level pass header carries a duration: `✓ src/x.test.ts (12ms)`.
  passFileRe: /^\s*✓\s+\S.*\([\d.]+\s*\w+\)/,
  failFileRe: /^\s*(?:×|FAIL|✗|✘)\s+\S/,
  summaryRe: /^(Test Files|Tests|Modules|Duration|Start at)[\s:]+\d/,
  // Per-test tick is indented ≥2 spaces: `  ✓ should pass`.
  testTickRe: /^\s{2,}✓\s/,
  outputHdrRe: /^\s*stdout\s*\|/,
  outputNoun: 'stdout',
  passFileNoun: 'passing file',
})

/** Batch A registry slice, appended to TOOL_FILTERS in dispatch order. */
export const TEST_RUNNER_FILTERS: readonly ToolFilter[] = [jestFilter, vitestFilter]
