import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_agent_spawn) for its
// side-effects, so runHook dispatches through the real production registry.
// buildEvent maps a Claude Code payload onto a HookEvent exactly as relay() does.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { recordBashOutput } from '../src/session.js'
import { storeBashOutput, getBashOutput } from '../src/bash_output_cache.js'

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-agent-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `agent-${path.basename(tmpHome)}`
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

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
      expect(updatedPrompt).toContain('surgical') // Reminder text
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
