import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
// Importing relay registers every hook module (including hooks_agent_spawn) for its side effects, so runHook dispatches through the real production registry -- same pattern as tests/hooks_agent_spawn.test.ts.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { wasHintShown } from '../src/session.js'
import { loadSessionState } from '../src/session_store.js'
import { buildUnrestrictedSpawnAdvisory } from '../src/hooks_agent_spawn.js'
import { clearModuleCaches } from '../src/reset.js'

/**
 * The unrestricted-spawn advisory must never fire under Copilot CLI. Two independent reasons,
 * both recorded in src/bridges/copilot_cli.ts from the shipping 1.0.80 bundle: post_tool_use
 * additionalContext is dropped on Copilot's JS path (so the advisory would be emitted into a
 * void while still burning the once-per-session hint budget and recording a session_hint stat
 * for text nobody received), and the advisory's content is Claude Code's Task schema -- Copilot's
 * own task tool carries no subagent_type argument, so the absent-field trigger would misclassify
 * every Copilot task spawn as an untyped general-purpose spawn even if the channel delivered.
 *
 * This lives in its own file rather than tests/hooks_agent_spawn.test.ts because getHarnessName()
 * memoizes on first dispatch: the sibling file's earlier tests would pin the ambient harness for
 * the whole worker module registry before a copilot override could take effect.
 */

const RESTRICTED_DEF = '---\nname: lean-coder\ndescription: scoped coder\ntools: Read, Grep, Bash\nmodel: inherit\n---\n\nBody.\n'
const EXPECTED_ADVISORY = '[token-goat] This spawn ran as general-purpose (the default when subagent_type is omitted), which is unrestricted: its lane starts by paying for every tool and MCP schema on the machine. Tools-restricted agent definitions exist here: lean-coder. A future spawn that fits one of them can pass that name as subagent_type to start with a much smaller prefix. Advisory only: this spawn has already run, and this notice saved nothing.'

// The scanner's default root is ~/.claude/agents; the suite-wide setup sandboxes HOME/USERPROFILE, so this writes into the isolated home, never the developer's real roster.
function writeRoster(): void {
  const dir = path.join(os.homedir(), '.claude', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'lean-coder.md'), RESTRICTED_DEF)
}

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
  fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true })
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

  it('control: the same spawn under a non-copilot harness still produces the exact advisory (an over-broad gate must go red here)', () => {
    // clearModuleCaches() resets the memoized harness (and, with it, the hook registry -- which is why this control calls the exported builder directly instead of dispatching).
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
    clearModuleCaches()
    writeRoster()
    expect(buildUnrestrictedSpawnAdvisory({ prompt: 'p', description: 'd' })).toBe(EXPECTED_ADVISORY)
  })
})
