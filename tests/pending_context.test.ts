import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PENDING_CONTEXT_BYTES,
  drainPendingContext,
  queuePendingContext,
} from '../src/pending_context.js'

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
