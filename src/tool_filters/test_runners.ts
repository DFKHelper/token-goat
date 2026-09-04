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
  // File-level pass header carries a duration: `✓ src/x.test.ts (12ms)`. The ` > ` exclusion is
  // not decoration: a verbose per-test line whose test NAME happens to end in something shaped
  // like a duration (`... to the documented min (100ms) 1ms`) is otherwise claimed here, and gets
  // counted as a passing FILE. Both branches drop the line, so nothing is lost -- but the reported
  // count is wrong, and wrong in a way that depends on which reporter produced the run.
  passFileRe: /^\s*✓(?!.*\s>\s)\s+\S.*\([\d.]+\s*[a-zA-Z]\w*\)/,
  failFileRe: /^\s*(?:×|FAIL|✗|✘)\s+\S/,
  // Real vitest right-aligns its summary labels, so every one of these arrives indented:
  // `      Tests  140 passed (140)`. Anchoring at `^` matched none of them. They survived only
  // by falling through to the keep-verbatim branch, which is not the same rule -- a summary line
  // reached while a fail block is open was swallowed into that block instead of ending it.
  summaryRe: /^\s*(Test Files|Tests|Modules|Duration|Start at)[\s:]+\d/,
  // Two shapes, because the reporter decides which one a passing test prints. The default
  // reporter indents a per-test tick under its file header (`  ✓ should pass`). `--reporter=
  // verbose` prints one line per test at a single leading space, carrying the full
  // `file > describe > name` path instead: ` ✓ tests/x.test.ts > safeJoin > joins normally 28ms`.
  // Those lines match no rule at all today, so a verbose run compresses by nothing. The ` > `
  // is what separates them from a file-level header, which passFileRe claims first and which
  // never contains one.
  testTickRe: /^\s{2,}✓\s|^\s*✓\s.*\s>\s/,
  outputHdrRe: /^\s*stdout\s*\|/,
  outputNoun: 'stdout',
  passFileNoun: 'passing file',
})

/** Batch A registry slice, appended to TOOL_FILTERS in dispatch order. */
export const TEST_RUNNER_FILTERS: readonly ToolFilter[] = [jestFilter, vitestFilter]
