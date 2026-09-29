import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// Importing relay registers every hook module (including hooks_agent_spawn) for its side effects, so runHook dispatches through the real production registry.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { normalizePayload } from '../src/hooks_cli.js'
import { wasHintShown } from '../src/session.js'
import { loadSessionState } from '../src/session_store.js'
import { rmInSandbox } from './helpers/sandbox-rm.js'

/** VS Code's runSubagent reaches the Task handlers once hooks_cli.ts maps it, and two of their behaviors were written for Claude Code. The unrestricted-spawn advisory tells the model to pass a ~/.claude/agents name as `subagent_type`, a key runSubagent does not have (it takes `agentName`, a VS Code chat agent). And the spawn briefing's project map walked process.cwd(), which on VS Code with no folder open is the home directory, ahead of the approval prompt. PROVENANCE: FORMAT-DERIVED, VS Code 1.137.0. runSubagent's inputSchema {prompt, description, agentName, model} is RunSubagentTool.getToolData in resources/app/out/vs/workbench/workbench.desktop.main.js ("Optional name of a specific agent to invoke"); the name is `CoreRunSubagent="runSubagent"` in resources/app/extensions/copilot/dist/extension.js. The envelope is ChatHookService.executePreToolUseHook/executePostToolUseHook's in that extension.js. The no-folder case (no cwd key, hook started in the home directory) is the one cited on normalizePayload's vscode branch in src/hooks_cli.ts. Prompts, names and directories are HAND-DERIVED. This lives in its own file because getHarnessName() memoizes on first dispatch (see tests/hooks_agent_spawn_copilot.test.ts). */

const RESTRICTED_DEF = '---\nname: lean-coder\ndescription: scoped coder\ntools: Read, Grep, Bash\nmodel: inherit\n---\n\nBody.\n'

let prevOverride: string | undefined
let prevTestCwd = ''
let cwdSandbox = ''
let workspace = ''

beforeAll(() => {
  prevOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
})

afterAll(() => {
  if (prevOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevOverride
})

beforeEach(() => {
  prevTestCwd = process.cwd()
  cwdSandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cwd-vscode-')))
  process.chdir(cwdSandbox)
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-ws-')))
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1\n')
})

afterEach(() => {
  process.chdir(prevTestCwd)
  for (const dir of [cwdSandbox, workspace]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  rmInSandbox(path.join(os.homedir(), '.claude'))
})

function runSubagent(eventName: 'pre_tool_use' | 'post_tool_use', sid: string, cwd: string | undefined): ReturnType<typeof buildEvent> {
  const payload: Record<string, unknown> = {
    timestamp: '2026-09-28T00:00:00.000Z',
    hook_event_name: eventName === 'pre_tool_use' ? 'PreToolUse' : 'PostToolUse',
    session_id: sid,
    tool_name: 'runSubagent',
    tool_input: { prompt: 'Find where the parser starts', description: 'find parser', agentName: 'Explore' },
    tool_use_id: 'tu-s',
  }
  if (cwd !== undefined) payload['cwd'] = cwd
  if (eventName === 'post_tool_use') payload['tool_response'] = 'short answer'
  return buildEvent(eventName, normalizePayload(payload, 'vscode'))
}

describe('runSubagent on VS Code', () => {
  it('gets no unrestricted-spawn advisory, and burns no hint budget, even with a restricted roster present', async () => {
    const agentsDir = path.join(os.homedir(), '.claude', 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    fs.writeFileSync(path.join(agentsDir, 'lean-coder.md'), RESTRICTED_DEF)
    const sid = `vscode-advisory-${Math.random().toString(36).slice(2)}`
    loadSessionState(sid)
    const result = await runHook(runSubagent('post_tool_use', sid, workspace))
    expect(result.hookType).toBe('pass')
    expect(wasHintShown('agent-spawn-restrict-hint')).toBe(false)
  })

  it('maps the workspace folder the payload names, not the directory the hook was started in', async () => {
    const result = await runHook(runSubagent('pre_tool_use', `vscode-brief-${Math.random().toString(36).slice(2)}`, workspace))
    expect(result.hookType).toBe('rewriteInput')
    const prompt = (result as { updatedInput: Record<string, unknown> }).updatedInput['prompt'] as string
    expect(prompt).toContain(`# Project map: ${path.basename(workspace)}`)
    expect(prompt).not.toContain(`# Project map: ${path.basename(cwdSandbox)}`)
  })

  it('leaves the map out when no workspace folder is open, instead of walking the directory the hook started in', async () => {
    const result = await runHook(runSubagent('pre_tool_use', `vscode-nofolder-${Math.random().toString(36).slice(2)}`, undefined))
    expect(result.hookType).toBe('rewriteInput')
    const prompt = (result as { updatedInput: Record<string, unknown> }).updatedInput['prompt'] as string
    expect(prompt).not.toContain('# Project map:')
    // The rest of the briefing still goes out: only the walk is withheld.
    expect(prompt).toContain('## Session briefing')
  })
})
