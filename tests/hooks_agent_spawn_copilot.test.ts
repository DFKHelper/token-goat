import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// Importing relay registers every hook module (including hooks_agent_spawn) for its side effects, so runHook dispatches through the real production registry -- same pattern as tests/hooks_agent_spawn.test.ts.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { wasHintShown } from '../src/session.js'
import { loadSessionState } from '../src/session_store.js'
import { buildUnrestrictedSpawnAdvisory } from '../src/hooks_agent_spawn.js'
import { clearModuleCaches } from '../src/reset.js'
import { rmInSandbox } from './helpers/sandbox-rm.js'

/** The unrestricted-spawn advisory must never fire under Copilot CLI. The advisory's content is Claude Code's Task schema, and Copilot's own task tool carries agent_type rather than subagent_type (CAPTURE: toolArgs {description, prompt, agent_type, name} in tests/fixtures/copilot_cli_1_0_88/C4a-004-preToolUse-task.json), so the absent-field trigger would misclassify every Copilot task spawn as an untyped general-purpose spawn. The channel is not the reason: post_tool_use additionalContext reaches the model on Copilot 1.0.88 (tg-captures C1a). This lives in its own file rather than tests/hooks_agent_spawn.test.ts because getHarnessName() memoizes on first dispatch: the sibling file's earlier tests would pin the ambient harness for the whole worker module registry before a copilot override could take effect. */

const RESTRICTED_DEF = '---\nname: lean-coder\ndescription: scoped coder\ntools: Read, Grep, Bash\nmodel: inherit\n---\n\nBody.\n'
const EXPECTED_ADVISORY = '[token-goat] This spawn ran as general-purpose (the default when subagent_type is omitted), which is unrestricted: its lane starts by paying for every tool and MCP schema on the machine. Tools-restricted agent definitions exist here: lean-coder. A future spawn that fits one of them can pass that name as subagent_type to start with a much smaller prefix. Advisory only: this spawn has already run, and this notice saved nothing.'

// The scanner's default root is ~/.claude/agents; the suite-wide setup sandboxes HOME/USERPROFILE, so this writes into the isolated home, never the developer's real roster.
function writeRoster(): void {
  const dir = path.join(os.homedir(), '.claude', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'lean-coder.md'), RESTRICTED_DEF)
}

// The scan also reads the project's own .claude/agents, so sandboxing HOME alone leaves this repo's three shipped definitions in the roster and the pinned advisory text above names four agents instead of one. Every test here runs from an empty directory so the roster is entirely the test's.
let prevTestCwd = ''
let cwdSandbox = ''
beforeEach(() => {
  prevTestCwd = process.cwd()
  cwdSandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cwd-copilot-')))
  process.chdir(cwdSandbox)
})
afterEach(() => {
  process.chdir(prevTestCwd)
  // Best-effort: a still-exiting child process whose cwd is this sandbox makes Windows refuse the removal, which has nothing to do with the assertion under test. It lives inside the run's temp root and goes away with it.
  try {
    fs.rmSync(cwdSandbox, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let prevOverride: string | undefined

beforeAll(() => {
  prevOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
})

afterAll(() => {
  // process.env is shared across the files a vitest worker runs, so a leaked override would silently re-harness every later file on this worker.
  if (prevOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevOverride
})

afterEach(() => {
  rmInSandbox(path.join(os.homedir(), '.claude'))
})

describe('unrestricted-spawn advisory under Copilot CLI', () => {
  it('stays silent and burns neither the hint budget nor a session_hint event when the harness is copilot_cli (real runHook dispatch)', async () => {
    writeRoster()
    const sid = `copilot-advisory-${Math.random().toString(36).slice(2)}`
    loadSessionState(sid)
    const payload = { tool_name: 'Agent', tool_input: { prompt: 'p', description: 'd' }, session_id: sid }
    const result = await runHook(buildEvent('post_tool_use', payload))
    // Exactly pass: not the advisory context, and not a context with empty text.
    expect(result.hookType).toBe('pass')
    // The once-per-session flag must not be burned either -- a suppressed emission that still consumed the budget would record a hint nobody received (the accounting-honesty class).
    expect(wasHintShown('agent-spawn-restrict-hint')).toBe(false)
  })

  it('never fires the opt-in scoped-spawn deny under Copilot CLI, whose task tool has no subagent_type to omit (real runHook dispatch)', async () => {
    writeRoster()
    const prev = process.env['TOKEN_GOAT_AGENT_SCOPED_SPAWN_DENY']
    process.env['TOKEN_GOAT_AGENT_SCOPED_SPAWN_DENY'] = '1'
    try {
      const sid = `copilot-scoped-deny-${Math.random().toString(36).slice(2)}`
      loadSessionState(sid)
      // CAPTURE: key set of Copilot's task toolArgs, tests/fixtures/copilot_cli_1_0_88/C4a-004-preToolUse-task.json.
      const payload = { tool_name: 'task', tool_input: { description: 'd', prompt: 'p', agent_type: 'explore', name: 'n' }, session_id: sid }
      const result = await runHook(buildEvent('pre_tool_use', payload))
      expect(result.hookType).not.toBe('deny')
      expect(wasHintShown('agent-scoped-spawn-deny')).toBe(false)
    } finally {
      if (prev === undefined) delete process.env['TOKEN_GOAT_AGENT_SCOPED_SPAWN_DENY']
      else process.env['TOKEN_GOAT_AGENT_SCOPED_SPAWN_DENY'] = prev
    }
  })

  it('control: the same spawn under a non-copilot harness still produces the exact advisory (an over-broad gate must go red here)', () => {
    // clearModuleCaches() resets the memoized harness (and, with it, the hook registry -- which is why this control calls the exported builder directly instead of dispatching).
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
    clearModuleCaches()
    writeRoster()
    expect(buildUnrestrictedSpawnAdvisory({ prompt: 'p', description: 'd' })).toBe(EXPECTED_ADVISORY)
  })
})
