import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  registerHook,
  runHook,
  serializeOutput,
} from '../src/hook_registry.js'
import { clearModuleCaches } from '../src/reset.js'
import { HOOK_EVENTS, type HookOutput } from '../src/types.js'
import { makeHookEvent as makeEvent } from './helpers/hook-event.js'

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
        return { hookType: 'context', context: 'new' }
      })
      registerHook('pre_tool_use', () => {
        calls.push('c')
        return { hookType: 'pass' }
      })
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'context', context: 'new' })
      expect(calls).toEqual(['a', 'b'])
    })

    it('returns pass when every handler passes', async () => {
      registerHook('pre_tool_use', () => ({ hookType: 'pass' }))
      registerHook('pre_tool_use', () => ({ hookType: 'pass' }))
      const result = await runHook(makeEvent())
      expect(result).toEqual({ hookType: 'pass' })
    })

    it('continues after a handler throws so a later handler can respond', async () => {
      registerHook('pre_tool_use', () => {
        throw new Error('broken handler')
      })
      const later = vi.fn((): HookOutput => ({ hookType: 'context', context: 'still works' }))
      registerHook('pre_tool_use', later)

      const result = await runHook(makeEvent())

      expect(result).toEqual({ hookType: 'context', context: 'still works' })
      expect(later).toHaveBeenCalledTimes(1)
    })
  })

  describe('advisory handlers', () => {
    // Regression coverage for the pre_compact ordering hazard: hooks_index.ts registers
    // an always-pass, side-effect-only handler for pre_compact ahead of hooks_compact.ts's
    // manifest handler, purely because of import order in relay.ts. If that handler ever
    // started returning non-pass, the old first-non-pass-wins loop would short-circuit
    // and the real compaction manifest would never run. Marking it `advisory: true`
    // removes that dependency on import order entirely -- these tests simulate exactly
    // that "handler starts returning non-pass" future regression, in both possible
    // registration orders, and assert the authoritative handler's result still comes
    // through every time.
    it('an advisory handler turning non-pass does not suppress a later authoritative handler', async () => {
      const advisory = vi.fn((): HookOutput => ({ hookType: 'context', context: 'snapshot-side-effect' }))
      const authoritative = vi.fn((): HookOutput => ({ hookType: 'context', context: 'manifest' }))
      registerHook('pre_compact', advisory, { advisory: true })
      registerHook('pre_compact', authoritative)
      const result = await runHook(makeEvent({ eventName: 'pre_compact' }))
      expect(result).toEqual({ hookType: 'context', context: 'manifest' })
      expect(advisory).toHaveBeenCalledTimes(1)
      expect(authoritative).toHaveBeenCalledTimes(1)
    })

    it('order-independence: an authoritative handler registered before an advisory one still wins', async () => {
      const authoritative = vi.fn((): HookOutput => ({ hookType: 'context', context: 'manifest' }))
      const advisory = vi.fn((): HookOutput => ({ hookType: 'context', context: 'snapshot-side-effect' }))
      // Deliberately reversed from the real hooks_index/hooks_compact import order. A
      // non-advisory handler still short-circuits normally, so the advisory handler
      // registered after it correctly never runs here -- the point is that the
      // authoritative result is what comes through regardless of which order the two
      // were registered in, not that every handler always fires.
      registerHook('pre_compact', authoritative)
      registerHook('pre_compact', advisory, { advisory: true })
      const result = await runHook(makeEvent({ eventName: 'pre_compact' }))
      expect(result).toEqual({ hookType: 'context', context: 'manifest' })
      expect(authoritative).toHaveBeenCalledTimes(1)
      expect(advisory).not.toHaveBeenCalled()
    })

    it('falls back to the advisory result when no authoritative handler fires', async () => {
      registerHook('pre_compact', () => ({ hookType: 'context', context: 'snapshot-side-effect' }), {
        advisory: true,
      })
      const result = await runHook(makeEvent({ eventName: 'pre_compact' }))
      expect(result).toEqual({ hookType: 'context', context: 'snapshot-side-effect' })
    })

    it('a non-advisory handler after an advisory one still short-circuits any handler behind it', async () => {
      const advisory = vi.fn((): HookOutput => ({ hookType: 'pass' }))
      const authoritative = vi.fn((): HookOutput => ({ hookType: 'deny', message: 'stop' }))
      const never = vi.fn((): HookOutput => ({ hookType: 'context', context: 'never' }))
      registerHook('pre_compact', advisory, { advisory: true })
      registerHook('pre_compact', authoritative)
      registerHook('pre_compact', never)
      const result = await runHook(makeEvent({ eventName: 'pre_compact' }))
      expect(result).toEqual({ hookType: 'deny', message: 'stop' })
      expect(never).not.toHaveBeenCalled()
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
      expect(serializeOutput({ hookType: 'deny', message: 'nope' }, 'pre_tool_use', 'claudecode')).toBe(
        JSON.stringify({ decision: 'block', reason: 'nope' }),
      )
    })

    it('serializes context to the documented hookSpecificOutput.additionalContext shape', () => {
      expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'pre_tool_use', 'claudecode')).toBe(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hint' },
        }),
      )
    })

    it('threads the current event into hookEventName instead of hardcoding it', () => {
      expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'post_tool_use', 'claudecode')).toBe(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hint' },
        }),
      )
    })

    // On Claude Code a PreCompact hook's raw stdout is what reaches the summarizing model: the executor sets the hook result's `output` field to the process stdout verbatim, and the compaction path joins every succeeding hook's `output` into the summarizer's `customInstructions`. `systemMessage` is lifted onto a separate field that the compaction path never reads, so wrapping the manifest in JSON meant the summarizer received the literal characters `{"systemMessage":"..."}` -- or, more to the point, received our manifest as a quoted JSON blob rather than as instructions. Emitting the text bare is what actually delivers it.
    it('serializes context for pre_compact on Claude Code as raw text, because PreCompact stdout is fed to the summarizer verbatim', () => {
      expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'pre_compact', 'claudecode')).toBe('hint')
    })

    // The raw-stdout behavior above is Claude Code's and is undocumented. Every other harness keeps the JSON form: Copilot discards a preCompact response entirely, and the Codex shim JSON.parses our stdout, so bare text would degrade to `{}` there rather than being read as instructions.
    it('keeps the JSON systemMessage form for pre_compact on every harness that is not Claude Code', () => {
      for (const harness of ['codex', 'copilot_cli', 'gemini', 'opencode', 'generic'] as const) {
        expect(serializeOutput({ hookType: 'context', context: 'hint' }, 'pre_compact', harness)).toBe(
          JSON.stringify({ systemMessage: 'hint' }),
        )
      }
    })

    // Full matrix over every HookEventName, cross-checked against
    // https://code.claude.com/docs/en/hooks (verified 2026-07-02): PreCompact and
    // Notification do not accept `additionalContext` inside `hookSpecificOutput` and
    // must use the top-level `systemMessage` field instead; every other event does
    // accept it there. This exists so a new event added to HOOK_EVENTS without an
    // entry in EVENTS_WITHOUT_ADDITIONAL_CONTEXT can't silently default to the wrong
    // shape the way pre_compact did (2026-07-02) -- every event is asserted, not just
    // the two or three a hand-picked example test happens to cover.
    // Runs on 'codex' rather than 'claudecode' so pre_compact still emits JSON here: the raw-stdout carve-out is Claude Code's alone and is pinned by its own pair of tests above. Every other event is harness-independent, so this matrix's coverage is unchanged.
    it.each(HOOK_EVENTS)('serializes context for %s to the schema-correct shape', (eventName) => {
      const result = JSON.parse(serializeOutput({ hookType: 'context', context: 'hint' }, eventName, 'codex')) as Record<string, unknown>
      if (eventName === 'pre_compact' || eventName === 'notification') {
        expect(result).toEqual({ systemMessage: 'hint' })
      } else {
        expect(result).toHaveProperty('hookSpecificOutput.additionalContext', 'hint')
        expect(result).not.toHaveProperty('systemMessage')
      }
    })

    it('serializes pass to an empty object', () => {
      expect(serializeOutput({ hookType: 'pass' }, 'pre_tool_use', 'claudecode')).toBe('{}')
    })

    // Confirmed against https://code.claude.com/docs/en/hooks (verified 2026-07-12):
    // PostToolUse hooks rewrite a tool's result via hookSpecificOutput.updatedToolOutput
    // -- the same field name whether the tool is MCP or built-in (support for built-in
    // tools shipped in v2.1.121; MCP support predates it). This is a real, valid partial
    // verification that token-goat's serializer PRODUCES the documented wire shape; it
    // does not by itself confirm a live Claude Code session honors it on receipt.
    it('serializes rewriteOutput to the documented hookSpecificOutput.updatedToolOutput shape', () => {
      expect(
        serializeOutput({ hookType: 'rewriteOutput', updatedOutput: 'rewritten body' }, 'post_tool_use', 'claudecode'),
      ).toBe(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'rewritten body' },
        }),
      )
    })
  })
})
