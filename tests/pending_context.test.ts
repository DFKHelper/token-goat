import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PENDING_CONTEXT_BYTES,
  commitPendingContext,
  peekPendingContext,
  queuePendingContext,
} from '../src/pending_context.js'

/** Peek plus the commit a successful delivery makes, which is what the queue's storage contract is about. The half these tests are not exercising -- a peek whose text never reaches the output -- is covered separately below, at the relay level where that decision is actually made. */
function drainPendingContext(sessionId: string): string | null {
  const text = peekPendingContext(sessionId)
  commitPendingContext(sessionId, text)
  return text
}

describe('pending context', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    home = mkdtempSync(join(tmpdir(), 'tg-pending-'))
    process.env['TOKEN_GOAT_HOME'] = home
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('round-trips queued text', () => {
    queuePendingContext('s1', 'your task list is large')
    expect(drainPendingContext('s1')).toBe('your task list is large')
  })

  it('delivers exactly once, so every later tool call in the turn is a no-op', () => {
    // The drain runs on EVERY tool call. Without the delete, one hint would repeat for the rest of
    // the session -- turning a one-shot nudge into a per-tool-call tax, the opposite of the point.
    queuePendingContext('s1', 'hint text')

    expect(drainPendingContext('s1')).toBe('hint text')
    expect(drainPendingContext('s1')).toBeNull()
    expect(drainPendingContext('s1')).toBeNull()
  })

  it('keeps both hints when one prompt produces two', () => {
    queuePendingContext('s1', 'first hint')
    queuePendingContext('s1', 'second hint')

    expect(drainPendingContext('s1')).toBe('first hint\nsecond hint')
  })

  it('keeps sessions separate', () => {
    queuePendingContext('s1', 'for one')
    queuePendingContext('s2', 'for two')

    expect(drainPendingContext('s2')).toBe('for two')
    expect(drainPendingContext('s1')).toBe('for one')
  })

  it('caps the queue and keeps the newest text, not the oldest', () => {
    // The newest hint describes the session as it is now; an old one may already be stale.
    queuePendingContext('s1', 'A'.repeat(MAX_PENDING_CONTEXT_BYTES))
    queuePendingContext('s1', 'NEWEST')

    const drained = drainPendingContext('s1')
    expect(drained).not.toBeNull()
    expect(drained?.length).toBeLessThanOrEqual(MAX_PENDING_CONTEXT_BYTES)
    expect(drained?.endsWith('NEWEST')).toBe(true)
  })

  it('ignores empty text and an unusable session id', () => {
    queuePendingContext('s1', '   ')
    expect(drainPendingContext('s1')).toBeNull()

    expect(() => queuePendingContext('', 'text')).not.toThrow()
    expect(drainPendingContext('')).toBeNull()
  })

  it('never writes outside the sessions directory, whatever the session id looks like', () => {
    // The id arrives in hook JSON and lands in a filename. The stem sanitizer neutralizes
    // traversal by rewriting rather than rejecting, so asserting "returns null" would pin the
    // wrong thing -- the property that matters is where the bytes land, not what the call returns.
    for (const id of ['../../escape', '..\\..\\escape', 'a/b/c', 'a\0b', '.'.repeat(40)]) {
      expect(() => queuePendingContext(id, 'text')).not.toThrow()
      expect(() => drainPendingContext(id)).not.toThrow()
    }

    const strays: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (!full.startsWith(join(home, 'sessions'))) strays.push(full)
      }
    }
    walk(home)

    expect(strays).toEqual([])
  })
})

/**
 * The half the storage tests above cannot see: whether a peeked hint is cleared when it was never
 * emitted.
 *
 * pendingContextHandler is registered advisory, and runHook returns the first non-advisory non-pass
 * result it meets, discarding the advisory one it was holding. While the queue was consumed at read
 * time, that combination deleted a queued compaction manifest on any tool call where another
 * handler also had something to return -- postBashHandler's compression and delta branches are the
 * everyday case -- and it was gone for the rest of the session with nothing failing.
 *
 * Fixture provenance: HAND-DERIVED. The rewriteOutput shape is the HookOutput variant declared in
 * src/types.ts; the probe handler stands in for any non-advisory post_tool_use handler, since what
 * decides the outcome is runHook's advisory rule and not which handler won.
 */
describe('deferred hint delivery, through the real relay', () => {
  let home: string
  let prevHome: string | undefined
  let prevHarness: string | undefined

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    prevHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    home = mkdtempSync(join(tmpdir(), 'tg-pending-relay-'))
    process.env['TOKEN_GOAT_HOME'] = home
    // The queue only has a reader on a harness that drops what pre-compact returns.
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    if (prevHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = prevHarness
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps the hint queued when another handler returns the output for that call', async () => {
    const { registerHook } = await import('../src/hook_registry.js')
    const { relayInProcess } = await import('../src/relay.js')
    registerHook('post_tool_use', () => ({ hookType: 'rewriteOutput', updatedOutput: 'compressed' }), {
      toolName: 'TgPendingRewriteProbe',
    })
    queuePendingContext('relay-lost', 'MANIFEST-MARKER-ONE')

    await relayInProcess('post_tool_use', {
      session_id: 'relay-lost',
      tool_name: 'TgPendingRewriteProbe',
      tool_input: {},
      tool_response: { output: 'raw' },
    })

    expect(peekPendingContext('relay-lost')).toBe('MANIFEST-MARKER-ONE')
  })

  it('clears the hint once it is in the output, so it stays one-shot', async () => {
    const { relayInProcess } = await import('../src/relay.js')
    queuePendingContext('relay-delivered', 'MANIFEST-MARKER-TWO')

    const emitted = await relayInProcess('post_tool_use', {
      session_id: 'relay-delivered',
      tool_name: 'TgPendingPassProbe',
      tool_input: {},
      tool_response: { output: 'raw' },
    })

    expect(emitted).toContain('MANIFEST-MARKER-TWO')
    expect(peekPendingContext('relay-delivered')).toBeNull()
  })

  it("leaves a parent's queued manifest alone when a subagent sharing its session id makes a tool call (regression: the queue was keyed on the bare session id, so the first child tool call read the parent's compaction manifest, relay then cleared it as delivered, and the parent -- the one that compacted -- received nothing)", async () => {
    const { relayInProcess } = await import('../src/relay.js')
    // HAND-DERIVED: the composite key is sessionStateKey's own documented shape, applied here rather than read back from the queue.
    queuePendingContext('parent-session', 'RECOVERY-FOR-PARENT')

    const toChild = await relayInProcess('post_tool_use', {
      session_id: 'parent-session',
      agent_id: 'child-agent',
      tool_name: 'TgPendingPassProbe',
      tool_input: {},
      tool_response: { output: 'raw' },
    })
    expect(toChild).not.toContain('RECOVERY-FOR-PARENT')
    expect(peekPendingContext('parent-session')).toBe('RECOVERY-FOR-PARENT')

    // Still reaches the session that queued it, on its own next tool call.
    const toParent = await relayInProcess('post_tool_use', {
      session_id: 'parent-session',
      tool_name: 'TgPendingPassProbe',
      tool_input: {},
      tool_response: { output: 'raw' },
    })
    expect(toParent).toContain('RECOVERY-FOR-PARENT')
    expect(peekPendingContext('parent-session')).toBeNull()
  })
})
