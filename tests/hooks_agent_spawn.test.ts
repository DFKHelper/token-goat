import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_agent_spawn) for its
// side-effects, so runHook dispatches through the real production registry.
// buildEvent maps a Claude Code payload onto a HookEvent exactly as relay() does.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { recordBashOutput, MAX_OUTSTANDING_AGENT_SPAWNS, getOutstandingAgentSpawns, importSessionState } from '../src/session.js'
import { storeBashOutput, getBashOutput } from '../src/bash_output_cache.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'

// Lets one test force buildProjectMap()'s formatted output to be huge, so the briefing's
// over-budget truncation path (see the "keeps the surgical-read reminder ... when the briefing
// as a whole exceeds budget" test below) is actually exercised -- this real repo's own compact
// project map is far too small to trip BRIEFING_TARGET_TOKENS on its own.
let _hugeProjectMapOverride = false
vi.mock('../src/baseline.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    formatProjectMap: (...args: unknown[]) => {
      if (_hugeProjectMapOverride) {
        // Sized so map+reminder alone fits BRIEFING_TARGET_TOKENS but map+cache-ids+reminder
        // does not -- exercises the "drop cache-ids first, keep the reminder" path specifically,
        // not the further last-resort tail-trim fallback for a still-oversized map alone.
        return 'huge-project-map-line '.repeat(26)
      }
      return (original['formatProjectMap'] as (...a: unknown[]) => string)(...args)
    },
  }
})

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

// Clears session.ts's in-memory state without touching the hook registry (clearModuleCaches()
// from reset.ts would also wipe hook_registry.ts's registered handlers, which are only ever
// registered once at module-import time via top-level registerHook() calls in hooks_agent_spawn.ts
// -- clearing them mid-file would silently unregister every hook for the rest of this test file,
// since nothing re-imports/re-registers afterward).
function resetSessionState(): void {
  importSessionState({
    files: [],
    hintsShown: [],
    webFetches: [],
    bashOutputs: [],
    curlDownloads: [],
    outstandingAgentSpawns: [],
  })
}

beforeEach(() => {
  resetSessionState()
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-agent-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `agent-${path.basename(tmpHome)}`
})

afterEach(() => {
  resetSessionState()
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/**
 * Run a hook event the way relay.ts's relayInProcess does for a real Claude Code call: load the
 * named session's persisted state, dispatch through the real registered handlers, then persist
 * whatever the handlers mutated. hooks_agent_spawn's pre/post handlers fire as separate
 * `token-goat hook` processes in production, so exercising the duplicate-brief feature through
 * this load/dispatch/save cycle (rather than bare back-to-back runHook calls sharing one
 * process's module state) is what actually proves the cross-process tracking works.
 *
 * Resets in-memory session state to empty before loading, so that switching `sid` between calls
 * faithfully simulates a brand-new `token-goat hook` process (which always starts with empty
 * module state before loadSessionState populates it from that session's own file) rather than
 * leaking a previous call's in-process module state into a session that has no on-disk file yet.
 */
async function callAgentHook(
  eventName: 'pre_tool_use' | 'post_tool_use',
  toolInput: Record<string, unknown>,
  sid: string,
  toolResponse?: unknown,
) {
  resetSessionState()
  loadSessionState(sid)
  const payload: Record<string, unknown> = { tool_name: 'Agent', tool_input: toolInput, session_id: sid }
  if (toolResponse !== undefined) payload['tool_response'] = toolResponse
  const result = await runHook(buildEvent(eventName, payload))
  saveSessionState(sid)
  return result
}

describe('Agent spawn briefing hook (real runHook dispatch)', () => {
  it('appends a briefing to an Agent tool prompt', async () => {
    const prompt = 'Build a feature that does X.'
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt, description: 'Test agent' },
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      const updatedPrompt = result.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain(prompt) // Original prompt still there
      expect(updatedPrompt).toContain('## Session briefing') // Briefing was appended
      // Pin the imperative gate wording (not the old advisory "prefer surgical reads" phrasing).
      expect(updatedPrompt).toContain('Before your first read of any file')
      expect(updatedPrompt).toContain('instead of a full-file read or wide grep')
      expect(updatedPrompt).toContain('is a violation, not an oversight')
    }
  })

  it('passes through non-Agent tool calls unchanged', async () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('passes through Agent calls with missing prompt unchanged', async () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { description: 'Test agent' }, // no prompt field
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('passes through Agent calls with empty prompt unchanged', async () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt: '   ' }, // whitespace only
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('includes cached bash output ids in the briefing when available', async () => {
    // Store a bash output in this session
    const outputId = await storeBashOutput('echo test', 'test output', 0)
    // Record it in the session state
    recordBashOutput('hash1', outputId)

    const prompt = 'Check the previous build output.'
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt },
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      const updatedPrompt = result.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain('token-goat bash-output') // Cached output hint
    }
  })

  it('does not corrupt tool input fields other than prompt', async () => {
    const toolInput = {
      prompt: 'Investigate the issue.',
      description: 'Debug agent',
      subagent_type: 'researcher',
      model: 'claude-opus',
    }
    const payload = {
      tool_name: 'Agent',
      tool_input: toolInput,
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      // Verify other fields are preserved
      expect(result.updatedInput['description']).toBe('Debug agent')
      expect(result.updatedInput['subagent_type']).toBe('researcher')
      expect(result.updatedInput['model']).toBe('claude-opus')
      // Prompt is modified but still present
      const updatedPrompt = result.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain('Investigate the issue.')
    }
  })

  it('handles Agent calls without throwing, even when briefing fails', async () => {
    // This test ensures that the hook never throws, even if internal
    // briefing construction fails. The handler catches all errors internally.
    const prompt = 'Proceed despite any errors.'
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt },
      session_id: sessionId,
    }

    // The hook either passes (if briefing failed) or rewrites (if briefing succeeded).
    // Both are acceptable outcomes — the important thing is no exception is thrown.
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType === 'pass' || result.hookType === 'rewriteInput').toBe(true)
  })

  // Regression: buildSubagentBriefing's over-budget truncation used to slice the assembled
  // string from the end regardless of section order, contradicting its own "keep map + reminder,
  // sacrifice cache ids if needed" comment -- since the reminder was appended LAST (after the
  // cache-ids section), a tail-slice cut the reminder first, not the cache ids. The cache-ids
  // block must now be dropped first, and the surgical-read reminder must survive whenever the
  // map + reminder alone still fit the budget.
  it('keeps the surgical-read reminder (and drops the cache-ids block first) when the briefing as a whole exceeds budget', async () => {
    _hugeProjectMapOverride = true
    try {
      const outputId = await storeBashOutput('echo test', 'test output', 0)
      recordBashOutput('hash1', outputId)

      const prompt = 'Investigate the large refactor.'
      const payload = {
        tool_name: 'Agent',
        tool_input: { prompt },
        session_id: sessionId,
      }
      const result = await runHook(buildEvent('pre_tool_use', payload))
      expect(result.hookType).toBe('rewriteInput')
      if (result.hookType === 'rewriteInput') {
        const updatedPrompt = result.updatedInput['prompt'] as string
        expect(typeof updatedPrompt).toBe('string')
        expect(updatedPrompt).toContain(prompt)
        // The load-bearing gate reminder must survive even though the briefing overall had to be
        // trimmed to fit budget.
        expect(updatedPrompt).toContain('Before your first read of any file')
        // The nice-to-have cache-ids hint is the sacrificial section, so it's the one dropped.
        expect(updatedPrompt).not.toContain('Cached outputs this session')
      }
    } finally {
      _hugeProjectMapOverride = false
    }
  })
})

describe('postAgentHandler — outlier-large subagent report caching (real runHook dispatch)', () => {
  const toolInput = { prompt: 'Investigate the issue.', description: 'Test agent' }

  function postPayload(toolResponse: unknown): Record<string, unknown> {
    return { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: toolResponse }
  }

  it('passes through an Agent report under the cache threshold untouched (regression: the average real report is ~2,220 chars, well under the 8000-char floor -- this must never fire on a typical report)', async () => {
    const smallReport = 'Found and fixed the bug.'.repeat(50) // well under 8000 chars
    const result = await runHook(buildEvent('post_tool_use', postPayload(smallReport)))
    expect(result.hookType).toBe('pass')
  })

  it('caches an outlier-large Agent report and appends a recall pointer without altering the original result (regression: a subagent report must never be truncated or hidden -- this handler only ever appends via contextOutput, never rewriteOutput)', async () => {
    const largeReport = 'Detailed finding line.\n'.repeat(400) // > 8000 chars
    const result = await runHook(buildEvent('post_tool_use', postPayload(largeReport)))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      const m = /token-goat mcp-output (mcp_[0-9a-f]{16})/.exec(result.context)
      expect(m).not.toBeNull()
      // The recalled id resolves to the exact original report -- lossless recall is the
      // whole point of the conservative design (never truncate what the parent sees now).
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe(largeReport)
    }
  })

  it('passes through when sessionId is missing, even for an outlier-large report', async () => {
    const largeReport = 'x'.repeat(9000)
    const payload = { tool_name: 'Agent', tool_input: toolInput, tool_response: largeReport }
    const result = await runHook(buildEvent('post_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('passes through when tool_response is missing or empty', async () => {
    const result = await runHook(buildEvent('post_tool_use', postPayload(undefined)))
    expect(result.hookType).toBe('pass')
  })

  it('passes through non-Agent tool calls unchanged, even with an oversized result', async () => {
    const largeReport = 'x'.repeat(9000)
    const payload = { tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: sessionId, tool_response: largeReport }
    const result = await runHook(buildEvent('post_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })
})

describe('Duplicate-subagent-brief detection (real cross-process load/dispatch/save cycle)', () => {
  it('fires an advisory warning when a near-duplicate prompt is spawned while the original is still outstanding', async () => {
    const original = 'Investigate the failing tests in the payment module and fix the root cause of the failures.'
    const near = 'Investigate the failing tests in the payment module and find the root cause of the failures.'

    const first = await callAgentHook('pre_tool_use', { prompt: original }, sessionId)
    expect(first.hookType).toBe('rewriteInput')

    const second = await callAgentHook('pre_tool_use', { prompt: near }, sessionId)
    expect(second.hookType).toBe('rewriteInput')
    if (second.hookType === 'rewriteInput') {
      const updatedPrompt = second.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain('already appears to be outstanding')
    }
  })

  it('does not fire the advisory for two genuinely different tasks that merely share some words', async () => {
    const first = 'Fix the login bug in auth.ts where the session token is not refreshed correctly.'
    const second = 'Write documentation for the new API rate limiter feature, including usage examples.'

    const firstResult = await callAgentHook('pre_tool_use', { prompt: first }, sessionId)
    expect(firstResult.hookType).toBe('rewriteInput')

    const secondResult = await callAgentHook('pre_tool_use', { prompt: second }, sessionId)
    expect(secondResult.hookType).toBe('rewriteInput')
    if (secondResult.hookType === 'rewriteInput') {
      const updatedPrompt = secondResult.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).not.toContain('already appears to be outstanding')
    }
  })

  it('does not fire once the original spawn has completed (post-hook cleared its outstanding entry)', async () => {
    const original = 'Refactor the billing service to use the new retry queue instead of polling.'

    const preResult = await callAgentHook('pre_tool_use', { prompt: original }, sessionId)
    expect(preResult.hookType).toBe('rewriteInput')
    const spawnedInput = preResult.hookType === 'rewriteInput' ? preResult.updatedInput : { prompt: original }

    // Complete the spawn via the real registered post-hook, using the actual (briefing-appended)
    // tool_input Claude Code would have sent, with a small (non-cacheable) report.
    const postResult = await callAgentHook('post_tool_use', spawnedInput, sessionId, 'Done. Small report.')
    expect(postResult.hookType).toBe('pass')

    // A near-duplicate prompt fired again after completion must not be flagged.
    const again = await callAgentHook('pre_tool_use', { prompt: original }, sessionId)
    expect(again.hookType).toBe('rewriteInput')
    if (again.hookType === 'rewriteInput') {
      const updatedPrompt = again.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).not.toContain('already appears to be outstanding')
    }
  })

  it('is session-scoped: the same prompt under a different sessionId does not cross-flag', async () => {
    const prompt = 'Audit the checkout flow for accessibility issues and report findings.'
    const otherSessionId = `agent-other-${sessionId}`

    const inFirstSession = await callAgentHook('pre_tool_use', { prompt }, sessionId)
    expect(inFirstSession.hookType).toBe('rewriteInput')

    const inOtherSession = await callAgentHook('pre_tool_use', { prompt }, otherSessionId)
    expect(inOtherSession.hookType).toBe('rewriteInput')
    if (inOtherSession.hookType === 'rewriteInput') {
      const updatedPrompt = inOtherSession.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).not.toContain('already appears to be outstanding')
    }
  })

  it('bounds the tracked outstanding-spawn set: spawning many distinct prompts in one session never exceeds the cap', async () => {
    const extra = 10
    for (let i = 0; i < MAX_OUTSTANDING_AGENT_SPAWNS + extra; i++) {
      const result = await callAgentHook('pre_tool_use', { prompt: `Distinct standalone task number ${i} about topic ${i}.` }, sessionId)
      expect(result.hookType).toBe('rewriteInput')
    }

    loadSessionState(sessionId)
    expect(getOutstandingAgentSpawns().length).toBeLessThanOrEqual(MAX_OUTSTANDING_AGENT_SPAWNS)
  })
})
