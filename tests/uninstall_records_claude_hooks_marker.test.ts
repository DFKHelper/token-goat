/** `token-goat uninstall` must leave the marker doctor's "Claude Code hooks" check reads, or a deliberate removal is reported as lost hooks. The check itself is unit-tested in tests/doctor_claude_hooks_gone.test.ts against a hand-built database; this drives the real CLI path (install, then uninstall, through cli.ts's run) into this file's isolated global.db. PROVENANCE: HAND-DERIVED -- the only input is the CLI invocation; the marker kind is the exported constant, and the hook row is seeded with the 'claudecode' harness value src/bridges_status.ts uses. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { getGlobalDb } from '../src/stats.js'
import { claudeHookActivity } from '../src/hook_latency.js'
import { checkClaudeHooksGone } from '../src/cli_doctor_platforms.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let project = ''
let originalCwd = ''
let spies: WriteSpy[] = []

beforeEach(() => {
  originalCwd = process.cwd()
  project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-marker-')))
  process.chdir(project)
  spies = [spyOnWrite(process.stdout, []), spyOnWrite(process.stderr, [])]
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  process.chdir(originalCwd)
  fs.rmSync(project, { recursive: true, force: true })
})

async function cli(argv: string[]): Promise<void> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    expect(process.exitCode ?? 0).toBe(0)
  } finally {
    process.exitCode = prev
  }
}

it('uninstall records the marker, so doctor does not report the removed hooks as lost', async () => {
  await cli(['install', '--project'])
  // A Claude Code hook that ran while the hooks were wired: without the marker, this row alone makes doctor warn.
  getGlobalDb().prepare('INSERT INTO stats (ts, kind, harness) VALUES (?, ?, ?)').run(Math.floor(Date.now() / 1000) - 60, 'hook:pre_tool_use', 'claudecode')
  expect(checkClaudeHooksGone(false, claudeHookActivity())?.status).toBe('warn')
  await cli(['uninstall', '--project'])
  const activity = claudeHookActivity()
  expect(activity?.uninstalledTs).not.toBeNull()
  expect(checkClaudeHooksGone(false, activity)).toBeNull()
})
