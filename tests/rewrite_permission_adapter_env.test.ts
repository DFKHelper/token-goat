/** Codex and Copilot CLI through the resident hook server's adapters (src/hook_adapters.ts runAdapter under src/batch_serve.ts swapEnv): the Claude Code gate in src/rewrite_permission.ts must change nothing for them when the request's environment carries a claude terminal's variables, and the next request, which brings none, must not inherit the harness the last one set. The payload shapes are FORMAT-DERIVED as in tests/rewrite_permission_hosts_e2e.test.ts (Codex: developers.openai.com/codex/hooks.md; Copilot CLI: schemas/copilot_cli.hooks.json PreToolUseHookInput). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { swapEnv } from '../src/batch_serve.js'
import { runAdapter } from '../src/hook_adapters.js'
import { relayInProcess } from '../src/relay.js'
import { clearPerRequestCaches } from '../src/reset.js'
import { resetPermissionSourceCache } from '../src/rewrite_permission.js'

let box: string
let codexHome: string
const savedCodexHome = process.env['CODEX_HOME']

const INHERITED_CLAUDE_ENV = { TERM_PROGRAM: 'claude-code', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '2147483646', CLAUDE_CODE_SESSION_ID: 'inherited-from-a-claude-terminal' }
const CLAUDE_KEYS = ['TERM_PROGRAM', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_VERSION', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'TOKEN_GOAT_BASH_COMPRESS', 'TOKEN_GOAT_HARNESS_OVERRIDE']

beforeAll(() => {
  box = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adapter-env-')))
  codexHome = path.join(box, 'codex')
  fs.mkdirSync(path.join(codexHome, 'rules'), { recursive: true })
  process.env['CODEX_HOME'] = codexHome
})

afterAll(() => {
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = savedCodexHome
  fs.rmSync(box, { recursive: true, force: true })
})

/** The environment of a request: the server's own, without any variable that names a harness, plus `extra`. */
function requestEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  for (const key of CLAUDE_KEYS) delete env[key]
  return { ...env, ...extra }
}

async function serve(harness: 'codex' | 'copilot_cli', event: string, payload: unknown, extra: Record<string, string>): Promise<string> {
  const restore = swapEnv(requestEnv(extra))
  try {
    clearPerRequestCaches()
    resetPermissionSourceCache()
    const result = await runAdapter(harness, { event, input: JSON.stringify(payload) }, { early: () => 0, relay: (tgEvent, canonical, harnessWaitMs) => relayInProcess(tgEvent, canonical, harnessWaitMs) })
    expect(result.exit).toBe(0)
    return result.stdout
  } finally {
    restore()
    clearPerRequestCaches()
  }
}

const root = (): string => path.parse(box).root
const codexPayload = (command: string): Record<string, unknown> => ({ session_id: `adapter-codex-${command}`, transcript_path: null, cwd: root(), model: 'gpt-5.5', turn_id: 'turn-1', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command } })
const copilotPayload = (command: string): Record<string, unknown> => ({ sessionId: `adapter-copilot-${command}`, timestamp: '2026-08-23T00:00:00.000Z', workingDirectory: root(), cwd: root(), toolName: 'bash', toolArgs: JSON.stringify({ command, description: 'Run it' }) })

describe('the resident server adapters, with a claude terminal\'s environment in the request', () => {
  it('Codex answers the same bytes with or without it, and a later request without it is not left on the Claude branch', async () => {
    const clean = await serve('codex', 'pre_tool_use', codexPayload('go vet ./...'), {})
    // The Codex branch answers allow for a build command no Codex rule names; the Claude branch, which this server's default would fall to, answers a rewrite with no decision.
    expect(JSON.parse(clean).hookSpecificOutput.permissionDecision).toBe('allow')
    expect(JSON.parse(clean).hookSpecificOutput.updatedInput.command).toContain('token-goat compress')
    expect(await serve('codex', 'pre_tool_use', codexPayload('go vet ./...'), INHERITED_CLAUDE_ENV)).toBe(clean)
    expect(await serve('codex', 'pre_tool_use', codexPayload('go vet ./...'), {})).toBe(clean)
  })

  it('Copilot CLI leaves a shell command alone with or without it, and is not wrapped', async () => {
    const clean = await serve('copilot_cli', 'preToolUse', copilotPayload('go build ./...'), {})
    const inherited = await serve('copilot_cli', 'preToolUse', copilotPayload('go build ./...'), INHERITED_CLAUDE_ENV)
    expect(inherited).toBe(clean)
    expect(clean).toBe('{}')
    expect(await serve('copilot_cli', 'preToolUse', copilotPayload('go build ./...'), {})).toBe(clean)
  })
})
