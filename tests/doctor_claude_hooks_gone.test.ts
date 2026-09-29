import { describe, expect, it } from 'vitest'
import Database from '../src/sqlite_driver.js'
import { GLOBAL_SCHEMA_SQL } from '../src/stats.js'
import { CLAUDE_HOOKS_UNINSTALLED_KIND, claudeHookActivity } from '../src/hook_latency.js'
import { checkClaudeHooksGone } from '../src/cli_doctor_platforms.js'

/** Doctor's "Claude Code hooks" row: hooks that ran recently and are no longer wired. PROVENANCE: the scenario is CAPTURE-shaped from the maintainer's own global.db, read read-only on 2026-09-28: `harness = 'claudecode'` rows with `kind LIKE 'hook:%'` numbered 84,312 over three days and stopped at 16:42:33Z when `~/.claude` disappeared, and `doctor` then printed no Claude Code row. The harness value 'claudecode' is the one src/bridges_status.ts and src/cli_doctor_native.ts use. Counts and timestamps below are HAND-DERIVED. */

const NOW = 1_790_000_000

function db(rows: Array<{ ts: number; kind: string; harness: string }>): InstanceType<typeof Database> {
  const d = new Database(':memory:')
  d.exec(GLOBAL_SCHEMA_SQL)
  const ins = d.prepare('INSERT INTO stats (ts, kind, harness) VALUES (?, ?, ?)')
  for (const r of rows) ins.run(r.ts, r.kind, r.harness)
  return d
}

describe('claudeHookActivity', () => {
  it('counts Claude Code hook rows only, inside the retention window, and finds the newest uninstall', () => {
    const d = db([
      { ts: NOW - 100, kind: 'hook:pre_tool_use', harness: 'claudecode' },
      { ts: NOW - 50, kind: 'hook:post_tool_use', harness: 'claudecode' },
      { ts: NOW - 10, kind: 'hook:pre_tool_use', harness: 'codex' },
      { ts: NOW - 5, kind: 'read_replacement', harness: 'claudecode' },
      { ts: NOW - 30 * 86400, kind: 'hook:pre_tool_use', harness: 'claudecode' },
      { ts: NOW - 20, kind: CLAUDE_HOOKS_UNINSTALLED_KIND, harness: '' },
    ])
    expect(claudeHookActivity(d, undefined, NOW)).toEqual({ count: 2, lastTs: NOW - 50, uninstalledTs: NOW - 20 })
  })
})

describe('checkClaudeHooksGone', () => {
  const lost = { count: 84312, lastTs: NOW - 3600, uninstalledTs: null }

  it('warns when hooks ran recently and none is wired, naming the fix', () => {
    const r = checkClaudeHooksGone(false, lost)
    expect(r?.status).toBe('warn')
    expect(r?.message).toContain('84312')
    expect(r?.message).toContain('token-goat install')
  })

  it('is quiet when the hooks are wired', () => {
    expect(checkClaudeHooksGone(true, lost)).toBeNull()
  })

  it('is quiet on a machine where Claude Code never ran a token-goat hook', () => {
    expect(checkClaudeHooksGone(false, { count: 0, lastTs: null, uninstalledTs: null })).toBeNull()
    expect(checkClaudeHooksGone(false, null)).toBeNull()
  })

  it('is quiet after a recorded uninstall, and warns again if hooks ran after it', () => {
    expect(checkClaudeHooksGone(false, { ...lost, uninstalledTs: NOW - 60 })).toBeNull()
    expect(checkClaudeHooksGone(false, { ...lost, uninstalledTs: NOW - 7200 })?.status).toBe('warn')
  })
})
