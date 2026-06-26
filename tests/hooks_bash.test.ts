import { describe, it, expect, beforeEach } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash.js'
import { getBashOutputId } from '../src/session.js'
import { getBashOutputByCommandHash } from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'

function makePostBashEvent(command: string, output: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    raw: {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: output,
    },
  }
}

describe('postBashHandler', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('passes through when command is missing', async () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: {},
      sessionId: 'test-session',
      raw: { tool_response: 'some output' },
    }
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('passes through for non-monitoring non-build commands', async () => {
    const event = makePostBashEvent('echo hello', 'hello\n'.repeat(200))
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
    // No output cached for echo
    expect(getBashOutputId('anything')).toBeNull()
  })

  it('passes through when output is below the size threshold', async () => {
    const event = makePostBashEvent('pytest tests/', 'short')
    const result = await postBashHandler(event)
    expect(result.hookType).toBe('pass')
  })

  it('stores monitoring command output and records the session mapping', async () => {
    const largeOutput = 'PASSED test_foo\nFAILED test_bar\n'.repeat(50)
    const event = makePostBashEvent('pytest tests/', largeOutput)
    await postBashHandler(event)

    // The session mapping should have been written
    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('pytest tests/').slice(0, 16)
    const id = getBashOutputId(simpleHash)
    expect(id).not.toBeNull()

    // The cache entry should be findable
    const entry = getBashOutputByCommandHash(id!)
    expect(entry).not.toBeNull()
    expect(entry!.command).toBe('pytest tests/')
    expect(entry!.output).toBe(largeOutput)
  })

  it('stores build command output and records the session mapping', async () => {
    const largeOutput = 'Compiling token_goat v1.0.0\nFinished release\n'.repeat(40)
    const event = makePostBashEvent('cargo build', largeOutput)
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('cargo build').slice(0, 16)
    const id = getBashOutputId(simpleHash)
    expect(id).not.toBeNull()
  })

  it('stores codex AI review output', async () => {
    const largeOutput = 'Reviewing code...\nSuggestion: extract method\nConclusion: LGTM\n'.repeat(30)
    const event = makePostBashEvent('codex review prompt.md', largeOutput)
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('codex review prompt.md').slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })

  it('stores glm.sh AI inference output', async () => {
    const largeOutput = 'Analyzing codebase...\nVerdict: found 3 issues\n'.repeat(30)
    const event = makePostBashEvent('~/.claude/bin/glm.sh /tmp/prompt.txt', largeOutput)
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('~/.claude/bin/glm.sh /tmp/prompt.txt').slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })

  it('handles tool_response as object with output field', async () => {
    const largeOutput = 'PASSED\nFAILED\n'.repeat(50)
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'pytest tests/' },
      sessionId: 'test-session',
      raw: {
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/' },
        tool_response: { output: largeOutput },
      },
    }
    await postBashHandler(event)

    const { fingerprintContent } = await import('../src/fingerprint.js')
    const simpleHash = fingerprintContent('pytest tests/').slice(0, 16)
    expect(getBashOutputId(simpleHash)).not.toBeNull()
  })

  it('never throws — swallows errors silently', async () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Bash',
      toolInput: { command: 'pytest tests/' },
      sessionId: 'test-session',
      raw: { tool_response: null as unknown as string },
    }
    await expect(postBashHandler(event)).resolves.toMatchObject({ hookType: 'pass' })
  })
})
