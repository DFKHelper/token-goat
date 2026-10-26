/** FORMAT-DERIVED from native/tg-hook/src/startup_entry.rs (budget_ms, DEFAULT_BUDGET_MS), native/tg-hook/src/startup_owner.rs (remaining) and src/bridges/copilot_session_start.ts (sessionStartBudgetMs); the stdin payload and the hook response shape are copied from tests/install_copilot_cli.test.ts. Covers the test-only SessionStart budget seam: the budget lives in one place per language, a clockless run reaches the handler and returns its context, and the smallest budget fails open without launching anything. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import {
  SESSION_START_TEST_BUDGET_ENV, SESSION_START_TEST_BUDGET_MAX_MS, SESSION_START_TEST_BUDGET_MIN_MS, SHIM_SESSION_START_TIMEOUT_MS,
} from '../../src/bridges/shim_common.js'
import { assertTreeDead, cleanupTrees, treeFixture } from '../helpers/copilot_session_start_tree.js'

// Cleanup is synchronous process-table work, so no fixed hook wall-clock bound applies: a loaded machine makes it slow, never wrong.
afterEach(cleanupTrees, 0)

const ENTRY_SOURCE = readFileSync(join(process.cwd(), 'native', 'tg-hook', 'src', 'startup_entry.rs'), 'utf8')
const OWNER_SOURCE = readFileSync(join(process.cwd(), 'native', 'tg-hook', 'src', 'startup_owner.rs'), 'utf8')
// Any spelling of the old or the new production budget.
const BUDGET_LITERAL = /\b(?:3000|3_000|10000|10_000)\b/g

function ownerConstant(name: string): number {
  const found = new RegExp(`const ${name}: u64 = ([0-9_]+);`).exec(ENTRY_SOURCE)
  expect(found, `${name} is no longer a plain u64 constant in startup_entry.rs`).not.toBeNull()
  return Number((found?.[1] ?? '').replaceAll('_', ''))
}

// The part of a Rust source that ships: everything before its unit-test module.
function shipped(source: string): string {
  const at = source.indexOf('#[cfg(test)]')
  return at === -1 ? source : source.slice(0, at)
}

it('keeps one SessionStart budget in each language, equal across them, and no copy of it anywhere else', () => {
  expect(ownerConstant('DEFAULT_BUDGET_MS')).toBe(SHIM_SESSION_START_TIMEOUT_MS)
  expect(ownerConstant('TEST_BUDGET_MIN_MS')).toBe(SESSION_START_TEST_BUDGET_MIN_MS)
  expect(ownerConstant('TEST_BUDGET_MAX_MS')).toBe(SESSION_START_TEST_BUDGET_MAX_MS)
  expect(ENTRY_SOURCE).toContain(`"${SESSION_START_TEST_BUDGET_ENV}"`)
  // A copy is what drifted before: the owner capped a deadline at a literal 3000 while the entry took its budget from a constant.
  expect(shipped(ENTRY_SOURCE).match(BUDGET_LITERAL), 'startup_entry.rs holds the budget in DEFAULT_BUDGET_MS and nowhere else').toHaveLength(1)
  expect(shipped(OWNER_SOURCE).match(BUDGET_LITERAL) ?? [], 'startup_owner.rs must take the budget from startup_entry::budget_ms()').toEqual([])
  expect(OWNER_SOURCE).toContain('crate::startup_entry::budget_ms()')
  // The generated shim embeds the shared value and no second literal of the old or the new budget.
  expect(COPILOT_CLI_HOOK_SCRIPT).toContain(`const SHIM_SESSION_START_TIMEOUT_MS = ${String(SHIM_SESSION_START_TIMEOUT_MS)}\n`)
  expect(COPILOT_CLI_HOOK_SCRIPT.match(BUDGET_LITERAL)).toHaveLength(1)
})

it('runs the handler and returns its context under the longest seam budget, whatever the load', () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'context-entry.cjs')
  const ran = join(fixture.root, 'handler.ran')
  const response = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SEAM CONTEXT' } }
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'x')\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))})\n`)
  const run = spawnSync(process.execPath, [fixture.shim, 'sessionStart', entry], {
    cwd: fixture.project,
    input: JSON.stringify({ sessionId: 's1', cwd: fixture.project }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: { ...fixture.env, [SESSION_START_TEST_BUDGET_ENV]: String(SESSION_START_TEST_BUDGET_MAX_MS) },
  })
  expect(run.stderr).toBe('')
  expect(existsSync(ran), 'the handler never ran').toBe(true)
  expect(JSON.parse(run.stdout)).toEqual({ additionalContext: 'SEAM CONTEXT' })
})

it('fails open with {} for want of cleanup time, launches nothing, and leaves no process behind', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'hang-entry.cjs')
  const launched = join(fixture.root, 'handler.launched')
  const pidFile = join(fixture.root, 'handler.pid')
  // If the budget check stopped working this handler would start, record its pid and hang; the fail-open path must still kill it, which assertTreeDead proves.
  writeFileSync(entry, `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nfs.writeFileSync(${JSON.stringify(launched)}, 'x')\nsetInterval(() => {}, 1000)\n`)
  const run = spawnSync(process.execPath, [fixture.shim, 'sessionStart', entry], {
    cwd: fixture.project,
    input: JSON.stringify({ sessionId: 's1', cwd: fixture.project }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: { ...fixture.env, [SESSION_START_TEST_BUDGET_ENV]: String(SESSION_START_TEST_BUDGET_MIN_MS) },
  })
  expect(run.status).toBe(0)
  expect(run.stdout).toBe('{}')
  await assertTreeDead(fixture)
  // The fixture shim starts its clock when it starts, so the time left once its input is in never exceeds the reserve; only an input that took the whole smallest budget to arrive ends the run another way.
  if (run.stderr.includes('input deadline exceeded')) {
    await ctx.annotate('branch: weak (the input did not arrive inside the smallest budget)')
    return
  }
  // Anchored so the shim's own guard is pinned: with that guard gone the native owner's guard fails open with the same words behind a "native startup owner failed:" prefix, which an unanchored match would accept.
  expect(run.stderr).toMatch(/^\[token-goat\] SessionStart failed open: insufficient time for process-tree cleanup$/m)
  expect(existsSync(launched), 'a handler child was launched with no budget left').toBe(false)
})
