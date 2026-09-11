/**
 * VS Code's run_in_terminal command is never wrapped in `token-goat compress`.
 *
 * VS Code runs the command in whatever shell the user's terminal uses and its hook payload does not say which, so a quoting that is safe in one shell can end the wrapped string early in another. The rewrite used to be sent for any vscode command without an ASCII single quote. These drive the real registry, normalizer and serializer, and pin that the Claude Code and Copilot CLI rewrites are unchanged.
 *
 * PROVENANCE: FORMAT-DERIVED. The VS Code envelope and run_in_terminal input keys (command, explanation, goal, mode) are the ones cited in tests/vscode_hooks.test.ts from VS Code 1.136.0's ChatHookService and the workbench bundle's run_in_terminal schema. The Claude Code payload is Claude Code's PreToolUse shape (tool_name "Bash", tool_input.command), and the Copilot CLI one is what the shared shim forwards after mapping `bash` to `Bash` (src/bridges/copilot_cli.ts). Commands are HAND-DERIVED.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { normalizePayload } from '../src/hooks_cli.js'
import { buildEvent } from '../src/relay.js'
import { runHook, serializeOutput } from '../src/hook_registry.js'
import type { HarnessName } from '../src/bridges/types.js'

const savedOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-terminal-'))

afterEach(() => {
  if (savedOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedOverride
})

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

let session = 0

async function preToolUse(harness: 'vscode' | 'claude' | 'copilot_cli', command: string): Promise<Record<string, unknown>> {
  const wire: HarnessName = harness === 'claude' ? 'claudecode' : harness
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = wire
  const sessionId = `terminal-${harness}-${++session}`
  const payload =
    harness === 'vscode'
      ? { timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: 'run_in_terminal', tool_input: { command, explanation: 'build', goal: 'build', mode: 'sync' }, tool_use_id: 'tu-1' }
      : { hook_event_name: 'PreToolUse', session_id: sessionId, cwd: workspace, tool_name: 'Bash', tool_input: { command, description: 'build' } }
  const event = buildEvent('pre_tool_use', normalizePayload(payload, harness))
  return JSON.parse(serializeOutput(await runHook(event), 'pre_tool_use', wire, event)) as Record<string, unknown>
}

function updatedInput(out: Record<string, unknown>): Record<string, unknown> | undefined {
  return (out['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['updatedInput'] as Record<string, unknown> | undefined
}

const WRAPPED = /^token-goat compress -f \S+ --timeout \d+ -c 'npm run build'$/

describe('run_in_terminal on VS Code is never rewritten', () => {
  it('a compressible build command gets no updatedInput', async () => {
    expect(updatedInput(await preToolUse('vscode', 'npm run build'))).toBeUndefined()
  })

  it('a command with a right single quotation mark (U+2019) and a ";" inside double quotes gets no updatedInput', async () => {
    const command = 'npm run build -- --label "it’s; done"'
    expect(updatedInput(await preToolUse('vscode', command))).toBeUndefined()
  })
})

describe('the same command is still rewritten where the shell is known to be bash', () => {
  it('Claude Code wraps npm run build in token-goat compress', async () => {
    const input = updatedInput(await preToolUse('claude', 'npm run build'))
    expect(input?.['command']).toMatch(WRAPPED)
    expect(input?.['description']).toBe('build')
  })

  it('Copilot CLI wraps npm run build in token-goat compress', async () => {
    const input = updatedInput(await preToolUse('copilot_cli', 'npm run build'))
    expect(input?.['command']).toMatch(WRAPPED)
  })
})
