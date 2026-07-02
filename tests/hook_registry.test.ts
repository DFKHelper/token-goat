import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  registerHook,
  runHook,
  serializeOutput,
  type HookEvent,
} from '../src/hook_registry.js'
import { clearModuleCaches } from '../src/reset.js'
import { HOOK_EVENTS, type HookOutput } from '../src/types.js'

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: { file_path: '/x.ts' },
    sessionId: 's1',
    raw: {},
    ...overrides,
  }
}

describe('hook registry', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  describe('registration and invocation', () => {
    it('invokes a registered handler for its event', async () => {
      const handler = vi.fn((): HookOutput => ({ hookType: 'pass' }))
      registerHook('pre_tool_use', handler)
      await runHook(makeEvent())
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('returns pass when no handler is registered', async () => {
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'pass' })
    })

    it('does not invoke handlers registered for a different event', async () => {
      const handler = vi.fn((): HookOutput => ({ hookType: 'deny', message: 'x' }))
      registerHook('post_tool_use', handler)
      const result = await runHook(makeEvent({ eventName: 'pre_tool_use' }))
      expect(handler).not.toHaveBeenCalled()
      expect(result).toEqual({ hookType: 'pass' })
    })

    it('supports async handlers', async () => {
      registerHook('pre_tool_use', async () => ({ hookType: 'context', context: 'hi' }))
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'context', context: 'hi' })
    })

    it('skips a handler whose toolName filter does not match', async () => {
      const handler = vi.fn((): HookOutput => ({ hookType: 'deny', message: 'x' }))
      registerHook('pre_tool_use', handler, { toolName: 'Bash' })
      const result = await runHook(makeEvent({ toolName: 'Read' }))
      expect(handler).not.toHaveBeenCalled()
      expect(result).toEqual({ hookType: 'pass' })
    })

    it('fires a handler whose toolName filter matches', async () => {
      registerHook('pre_tool_use', () => ({ hookType: 'deny', message: 'blocked' }), {
        toolName: 'Read',
      })
      const result = await runHook(makeEvent({ toolName: 'Read' }))
      expect(result).toEqual({ hookType: 'deny', message: 'blocked' })
    })
  })

  describe('short-circuit', () => {
    it('first non-pass result wins; later handlers do not run', async () => {
      const first = vi.fn((): HookOutput => ({ hookType: 'deny', message: 'stop' }))
      const second = vi.fn((): HookOutput => ({ hookType: 'context', context: 'never' }))
      registerHook('pre_tool_use', first)
      registerHook('pre_tool_use', second)
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'deny', message: 'stop' })
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
    })

    it('runs handlers in registration order, skipping passes until a non-pass', async () => {
      const calls: string[] = []
      registerHook('pre_tool_use', () => {
        calls.push('a')
        return { hookType: 'pass' }
      })
      registerHook('pre_tool_use', () => {
        calls.push('b')
        return { hookType: 'update', content: 'new' }
      })
      registerHook('pre_tool_use', () => {
        calls.push('c')
        return { hookType: 'pass' }
      })
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'update', content: 'new' })
      expect(calls).toEqual(['a', 'b'])
    })

    it('returns pass when every handler passes', async () => {
      registerHook('pre_tool_use', () => ({ hookType: 'pass' }))
      registerHook('pre_tool_use', () => ({ hookType: 'pass' }))
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'pass' })
    })
  })

  describe('reset', () => {
    it('clearModuleCaches drops all registered handlers', async () => {
      const handler = vi.fn((): HookOutput => ({ hookType: 'deny', message: 'x' }))
      registerHook('pre_tool_use', handler)
      clearModuleCaches()
      const result = await runHook(makeEvent())
      expect(handler).not.toHaveBeenCalled()
      expect(result).toEqual({ hookType: 'pass' })
    })
  })

  describe('serializeOutput', () => {
    it('serializes deny to a block decision', () => {
      expect(serializeOutput({ hookType: 'deny', message: 'nope' }, 'pre_tool_use')).toBe(
        JSON.stringify({ decision: 'block', reason: 'nope' }),
      )
    })

    it('serializes context to the documented hookSpecificOutput.additionalContext shape', () => {
      expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'pre_tool_use')).toBe(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hint' },
        }),
      )
    })

    it('threads the current event into hookEventName instead of hardcoding it', () => {
      expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'post_tool_use')).toBe(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hint' },
        }),
      )
    })

    it('serializes context for pre_compact via top-level systemMessage, not hookSpecificOutput (PreCompact is not a valid hookEventName there and fails the harness schema)', () => {
      expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'pre_compact')).toBe(
        JSON.stringify({ systemMessage: 'hint' }),
      )
    })

    // Full matrix over every HookEventName, cross-checked against
    // https://code.claude.com/docs/en/hooks (verified 2026-07-02): PreCompact and
    // Notification do not accept `additionalContext` inside `hookSpecificOutput` and
    // must use the top-level `systemMessage` field instead; every other event does
    // accept it there. This exists so a new event added to HOOK_EVENTS without an
    // entry in EVENTS_WITHOUT_ADDITIONAL_CONTEXT can't silently default to the wrong
    // shape the way pre_compact did (2026-07-02) -- every event is asserted, not just
    // the two or three a hand-picked example test happens to cover.
    it.each(HOOK_EVENTS)('serializes context for %s to the schema-correct shape', (eventName) => {
      const result = JSON.parse(serializeOutput({ hookType: 'context', context: 'hint' }, eventName)) as Record<string, unknown>
      if (eventName === 'pre_compact' || eventName === 'notification') {
        expect(result).toEqual({ systemMessage: 'hint' })
      } else {
        expect(result).toHaveProperty('hookSpecificOutput.additionalContext', 'hint')
        expect(result).not.toHaveProperty('systemMessage')
      }
    })

    it('serializes update with a nested content object', () => {
      expect(serializeOutput({ hookType: 'update', content: 'body' }, 'pre_tool_use')).toBe(
        JSON.stringify({ updatedInput: { content: 'body' } }),
      )
    })

    it('serializes pass to an empty object', () => {
      expect(serializeOutput({ hookType: 'pass' }, 'pre_tool_use')).toBe('{}')
    })
  })
})
