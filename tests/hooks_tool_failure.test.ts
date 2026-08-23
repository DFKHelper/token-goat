import { describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import {
  extractFailureText,
  failureSignature,
  MAX_TRACKED_FAILURES,
  postToolUseFailureHandler,
} from '../src/hooks_tool_failure.js'

function failureEvent(sessionId: string, toolName: string, error: string): HookEvent {
  return {
    eventName: 'post_tool_use_failure',
    toolName,
    toolInput: {},
    sessionId,
    agentId: undefined,
    raw: { session_id: sessionId, tool_name: toolName, error },
  }
}

let counter = 0
function uniqueSession(): string {
  counter += 1
  return `tool-failure-test-${process.pid}-${counter}`
}

describe('failureSignature', () => {
  it('matches across whitespace differences in the same error', () => {
    expect(failureSignature('Read', 'no such   file\n')).toBe(failureSignature('Read', 'no such file'))
  })

  it('distinguishes the same error from different tools', () => {
    expect(failureSignature('Read', 'boom')).not.toBe(failureSignature('Bash', 'boom'))
  })

  it('keeps distinct errors distinct within the truncation window', () => {
    expect(failureSignature('Read', 'file a missing')).not.toBe(failureSignature('Read', 'file b missing'))
  })
})

describe('extractFailureText', () => {
  it('reads the plain error field', () => {
    expect(extractFailureText({ error: 'boom' })).toBe('boom')
  })

  it('falls back to a nested tool_response error', () => {
    expect(extractFailureText({ tool_response: { error: 'nested boom' } })).toBe('nested boom')
  })

  it('returns empty when no failure text is present', () => {
    expect(extractFailureText({ tool_name: 'Read' })).toBe('')
  })

  it('ignores a whitespace-only error rather than keying on it', () => {
    expect(extractFailureText({ error: '   ' })).toBe('')
  })
})

describe('postToolUseFailureHandler', () => {
  it('stays silent on the first occurrence of a failure', () => {
    const out = postToolUseFailureHandler(failureEvent(uniqueSession(), 'Read', 'ENOENT: no such file'))
    expect(out.hookType).toBe('pass')
  })

  it('advises on an exact repeat, naming the tool', () => {
    const session = uniqueSession()
    expect(postToolUseFailureHandler(failureEvent(session, 'Read', 'ENOENT: no such file')).hookType).toBe('pass')
    const second = postToolUseFailureHandler(failureEvent(session, 'Read', 'ENOENT: no such file'))
    expect(second.hookType).toBe('context')
    expect(second.hookType === 'context' && second.context).toContain('Read')
    expect(second.hookType === 'context' && second.context).toContain('token-goat')
  })

  it('advises at most once per signature, however many times it repeats', () => {
    const session = uniqueSession()
    const kinds = [1, 2, 3, 4].map(
      () => postToolUseFailureHandler(failureEvent(session, 'Bash', 'command not found: frobnicate')).hookType,
    )
    expect(kinds).toEqual(['pass', 'context', 'pass', 'pass'])
  })

  it('does not treat a different error from the same tool as a repeat', () => {
    const session = uniqueSession()
    expect(postToolUseFailureHandler(failureEvent(session, 'Read', 'file a missing')).hookType).toBe('pass')
    expect(postToolUseFailureHandler(failureEvent(session, 'Read', 'file b missing')).hookType).toBe('pass')
  })

  it('does not treat the same error from a different tool as a repeat', () => {
    const session = uniqueSession()
    expect(postToolUseFailureHandler(failureEvent(session, 'Read', 'permission denied')).hookType).toBe('pass')
    expect(postToolUseFailureHandler(failureEvent(session, 'Bash', 'permission denied')).hookType).toBe('pass')
  })

  it('keeps sessions independent, so one session cannot advise on another session first failure', () => {
    const a = uniqueSession()
    const b = uniqueSession()
    expect(postToolUseFailureHandler(failureEvent(a, 'Read', 'same error')).hookType).toBe('pass')
    expect(postToolUseFailureHandler(failureEvent(b, 'Read', 'same error')).hookType).toBe('pass')
  })

  it('passes when the event carries no failure text to key on', () => {
    const session = uniqueSession()
    const bare: HookEvent = {
      eventName: 'post_tool_use_failure',
      toolName: 'Read',
      toolInput: {},
      sessionId: session,
      agentId: undefined,
      raw: { session_id: session, tool_name: 'Read' },
    }
    expect(postToolUseFailureHandler(bare).hookType).toBe('pass')
    expect(postToolUseFailureHandler(bare).hookType).toBe('pass')
  })

  it('evicts the oldest signature once the ledger is full, so the file stays bounded', () => {
    const session = uniqueSession()
    postToolUseFailureHandler(failureEvent(session, 'Read', 'oldest failure'))
    for (let i = 0; i < MAX_TRACKED_FAILURES; i += 1) {
      postToolUseFailureHandler(failureEvent(session, 'Read', `filler failure ${i}`))
    }
    // The oldest entry has been evicted, so its next occurrence reads as a first occurrence again.
    expect(postToolUseFailureHandler(failureEvent(session, 'Read', 'oldest failure')).hookType).toBe('pass')
  })
})
