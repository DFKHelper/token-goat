/** Which hooks load the Claude Code hidden-rule check (src/rewrite_permission.ts loadingHiddenRuleCheck): only a Claude Code or VS Code call outside auto mode, absent mode included; never Codex or Copilot CLI; and a check that fails to load never stops the handler. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loaded = vi.hoisted(() => ({ count: 0 }))

// The module is replaced by one that counts its imports and then fails them, so the count shows who asked and the failure shows the handler still runs.
vi.mock('../src/claude_hidden_rules.js', () => {
  loaded.count += 1
  throw new Error('forced import failure')
})

import { loadingHiddenRuleCheck, primeHiddenRulesAhead, resetPermissionSourceCache } from '../src/rewrite_permission.js'

const HARNESS = 'TOKEN_GOAT_HARNESS_OVERRIDE'
let saved: string | undefined

beforeEach(() => {
  loaded.count = 0
  saved = process.env[HARNESS]
  resetPermissionSourceCache()
})

afterEach(() => {
  if (saved === undefined) delete process.env[HARNESS]
  else process.env[HARNESS] = saved
})

/** Runs a wrapped handler for `harness` and returns whether the handler ran. */
async function ran(harness: string, raw: Record<string, unknown>): Promise<boolean> {
  process.env[HARNESS] = harness
  let called = false
  await loadingHiddenRuleCheck(() => {
    called = true
    return 'out'
  })({ raw })
  return called
}

// FORMAT-DERIVED: a Codex PreToolUse payload carries permission_mode "default" (tests/fixtures/harness_hook_payloads.ts codexBase, from https://developers.openai.com/codex/hooks.md), which is what once made every Codex hook load a module only Claude Code's rules need. A Copilot CLI payload carries no permission field at all (schemas/copilot_cli.hooks.json).
describe('loadingHiddenRuleCheck', () => {
  it('a Codex hook with permission_mode "default" loads nothing and runs its handler', async () => {
    expect(await ran('codex', { permission_mode: 'default' })).toBe(true)
    expect(loaded.count).toBe(0)
  })

  it('a Copilot CLI hook, with or without a mode, loads nothing and runs its handler', async () => {
    expect(await ran('copilot_cli', {})).toBe(true)
    expect(await ran('copilot_cli', { permission_mode: 'default' })).toBe(true)
    expect(loaded.count).toBe(0)
  })

  it('a Claude Code or VS Code hook outside auto mode loads the check, absent mode included, and runs its handler even when the load fails', async () => {
    expect(await ran('claudecode', { permission_mode: 'bypassPermissions' })).toBe(true)
    expect(loaded.count).toBe(1)
    expect(await ran('claudecode', {})).toBe(true)
    expect(loaded.count).toBe(2)
    expect(await ran('vscode', { permission_mode: 'default' })).toBe(true)
    expect(loaded.count).toBe(3)
  })

  it('a Claude Code hook in auto mode loads nothing', async () => {
    expect(await ran('claudecode', { permission_mode: 'auto' })).toBe(true)
    expect(loaded.count).toBe(0)
  })

  it('the resident server\'s read-ahead is not started for a Codex hook either', async () => {
    primeHiddenRulesAhead()
    expect(await ran('codex', { permission_mode: 'default' })).toBe(true)
    expect(loaded.count).toBe(0)
  })
})
