/** A shell command that failed still reaches the shell-write pass. PROVENANCE: the PostToolUseFailure payload is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks.md (PostToolUseFailure input, fetched 2026-10-22: top-level `error` "Exit code N\n<output>", `is_interrupt`, `tool_input.command`, no `tool_response`; PowerShell shares the Bash shape) and from tests/fixtures/claude_code_2_1_281/bash_failure.json (scrubbed Claude Code 2.1.281 capture, PROVENANCE.tsv); the command strings are HAND-DERIVED. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeHookEvent } from './helpers/hook-event.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { tempConfigPath } from './helpers/temp-config.js'

// dataDir() points at a per-file temp dir so the queue and the reconcile-request file the hook writes never touch a real one.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, dataDir: () => _testDataDir }
})

const _testConfigPath = tempConfigPath('tg-shell-failure-config-test.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-shell-failure-data-'))

// Side-effect import: registers every hook handler, as the shipping relay does.
import '../src/relay.js'
import type { HookEvent } from '../src/hook_registry.js'
import { runHook } from '../src/hook_registry.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { foldPath } from '../src/util.js'

function reconcileRequests(): string[] {
  try {
    return parseReconcileRequests(readFileSync(reconcileRequestPathFor(_testDataDir), 'utf8')).map((d) => foldPath(normalizePath(d)))
  } catch {
    return []
  }
}

/** The failure event Claude Code sends when a Bash or PowerShell call exits non-zero. */
function failureEvent(toolName: 'Bash' | 'PowerShell', command: string, cwd: string, error = 'Exit code 1\nboom'): HookEvent {
  const toolInput = { command, description: 'run' }
  return makeHookEvent({ eventName: 'post_tool_use_failure', toolName, toolInput, sessionId: 'shell-failure-session', raw: { hook_event_name: 'PostToolUseFailure', tool_name: toolName, tool_input: toolInput, tool_use_id: 'toolu_01SyntheticShellFailure', error, is_interrupt: false, duration_ms: 12, cwd } })
}

const dirs: string[] = []
function repo(): string {
  const dir = gitRepoWithCommit()
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  clearDirtyQueue()
  rmSync(reconcileRequestPathFor(_testDataDir), { force: true })
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a failed shell call reaches the shell-write pass', () => {
  it.each(['Bash', 'PowerShell'] as const)('queues the file a failed %s redirect wrote', async (tool) => {
    const dir = repo()
    await runHook(failureEvent(tool, 'echo hi > a.txt', dir))
    expect(getDirtyPaths().map(foldPath), 'dirty queue after a failed redirect').toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it.each(['Bash', 'PowerShell'] as const)('asks to reconcile after a failed %s script the hook cannot read', async (tool) => {
    const dir = repo()
    await runHook(failureEvent(tool, 'python gen.py', dir))
    expect(reconcileRequests(), 'reconcile requests after a failed script').toContain(foldPath(normalizePath(dir)))
  })

  it('asks for nothing after a failed read-only command', async () => {
    const dir = repo()
    await runHook(failureEvent('Bash', 'git status', dir))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths()).toEqual([])
  })

  it('still runs when the failure carries no exit-code line', async () => {
    const dir = repo()
    await runHook(failureEvent('Bash', 'python gen.py', dir, 'Failed to start the shell'))
    expect(reconcileRequests(), 'reconcile requests when the shell never started').toContain(foldPath(normalizePath(dir)))
  })
})
