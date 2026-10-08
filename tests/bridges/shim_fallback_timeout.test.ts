/** Each harness shim runs the real hook itself when it cannot reach the hook server or load it in process, and that spawn has a cap past which the shim answers an empty fail-open response. The cap was 3000 ms everywhere, which a loaded machine's cold start crosses, so a deny was silently dropped; it is now one table in shim_common.ts, sized per harness from the hook timeout the harness applies. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { GROK_HOOK_SCRIPT } from '../../src/bridges/grok.js'
import { KIMI_HOOK_SCRIPT } from '../../src/bridges/kimi.js'
import { OPENCLAW_PLUGIN_SCRIPT } from '../../src/bridges/openclaw.js'
import { OPENCODE_PLUGIN_SCRIPT } from '../../src/bridges/opencode.js'
import { PI_EXTENSION_SCRIPT } from '../../src/bridges/pi.js'
import { SHIM_FALLBACK_TIMEOUT_MS } from '../../src/bridges/shim_common.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// HAND-DERIVED: the old cap was 3000 ms, so an entry that works for 4.5 s before answering is over it by construction, on any machine speed, and well under every harness cap below; the spin is a busy loop so the time passes whatever the scheduler does.
const SLOW_ENTRY = "const until = Date.now() + 4500\nwhile (Date.now() < until);\nprocess.stdout.write(JSON.stringify({ decision: 'block', reason: 'slow but decided' }))\n"

function runShim(script: string, args: string[]): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-cap-'))
  tempDirs.push(dir)
  const scriptPath = join(dir, 'shim.cjs')
  const entryPath = join(dir, 'slow-entry.js')
  writeFileSync(scriptPath, script, 'utf8')
  writeFileSync(entryPath, SLOW_ENTRY, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, args[0] as string, entryPath], {
    cwd: dir,
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.txt') }, session_id: 'cap-test' }),
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: res.status, stdout: res.stdout ?? '' }
}

describe('shim fallback spawn cap', () => {
  it('lets a hook that outlasts the old 3 s cap finish and relays its deny (Claude Code)', () => {
    const res = runShim(CLAUDECODE_HOOK_SCRIPT, ['pre_tool_use'])
    expect(JSON.parse(res.stdout)).toEqual({ decision: 'block', reason: 'slow but decided' })
  }, 60_000)

  it('lets a hook that outlasts the old 3 s cap finish and relays its deny (Codex)', () => {
    const res = runShim(CODEX_HOOK_SCRIPT, ['pre_tool_use'])
    expect(JSON.parse(res.stdout)).toEqual({ decision: 'block', reason: 'slow but decided' })
  }, 60_000)

  it('lets a hook that outlasts the old 3 s cap finish and relays its deny (Kimi)', () => {
    const res = runShim(KIMI_HOOK_SCRIPT, ['pre_tool_use'])
    const out = JSON.parse(res.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe('slow but decided')
  }, 60_000)

  // FORMAT-DERIVED: each harness's hook timeout is cited beside SHIM_FALLBACK_TIMEOUT_MS; Claude Code's is 30 s for UserPromptSubmit and Kimi's 30 s, Copilot's 60 s as written by token-goat, Grok's 5 s default, OpenClaw's 15 s for before_tool_call (openclaw/openclaw src/plugins/hooks.ts); pi and opencode apply none, so any finite cap is under it.
  it('declares each shim cap from the one table, under the smallest timeout its harness applies', () => {
    const none = Number.POSITIVE_INFINITY
    const scripts: Array<{ name: keyof typeof SHIM_FALLBACK_TIMEOUT_MS; label: string; script: string; harnessTimeoutMs: number }> = [
      { name: 'claudecode', label: 'claudecode', script: CLAUDECODE_HOOK_SCRIPT, harnessTimeoutMs: 30_000 },
      { name: 'codex', label: 'codex', script: CODEX_HOOK_SCRIPT, harnessTimeoutMs: 600_000 },
      { name: 'copilot', label: 'copilot', script: COPILOT_CLI_HOOK_SCRIPT, harnessTimeoutMs: 60_000 },
      { name: 'grok', label: 'grok', script: GROK_HOOK_SCRIPT, harnessTimeoutMs: 5_000 },
      { name: 'kimi', label: 'kimi', script: KIMI_HOOK_SCRIPT, harnessTimeoutMs: 30_000 },
      { name: 'pi', label: 'pi', script: PI_EXTENSION_SCRIPT, harnessTimeoutMs: none },
      { name: 'relay', label: 'opencode', script: OPENCODE_PLUGIN_SCRIPT, harnessTimeoutMs: none },
      { name: 'relay', label: 'openclaw', script: OPENCLAW_PLUGIN_SCRIPT, harnessTimeoutMs: 15_000 },
    ]
    for (const { name, label, script, harnessTimeoutMs } of scripts) {
      const cap = SHIM_FALLBACK_TIMEOUT_MS[name]
      expect(script, label).toContain(`const SHIM_FALLBACK_TIMEOUT_MS = ${cap}\n`)
      expect(script.match(/timeout: \d+/g), `${label} spawn sites read the named cap, not a number`).toBeNull()
      expect((script.match(/timeout: SHIM_FALLBACK_TIMEOUT_MS/g) ?? []).length, `${label} spawns through the named cap`).toBeGreaterThanOrEqual(2)
      expect(cap, label).toBeLessThan(harnessTimeoutMs)
    }
    expect(SHIM_FALLBACK_TIMEOUT_MS.claudecode).toBeGreaterThan(3000)
    expect(SHIM_FALLBACK_TIMEOUT_MS.relay).toBeGreaterThan(3000)
    expect(SHIM_FALLBACK_TIMEOUT_MS.pi).toBeGreaterThan(3000)
  })
})
