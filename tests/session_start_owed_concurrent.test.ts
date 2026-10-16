import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CallStreakModule from '../src/call_streak.js'
import type * as SessionStartModule from '../src/hooks_session_start.js'
import type * as RelayModule from '../src/relay.js'
import type * as RegistryModule from '../src/hook_registry.js'
import { COPILOT_SESSION_START_HELPERS } from '../src/bridges/copilot_session_start.js'
import { MAX_PENDING_CONTEXT_BYTES } from '../src/pending_context.js'

// Provenance: HAND-DERIVED. Two hook processes are modelled as two module graphs (vi.resetModules between imports) that share only the session store on disk, which is all two real hook processes share; the interleaving between them is forced by a handler that waits on a promise, never by timing. The shim reset is the real function the generated Copilot shim embeds, evaluated from COPILOT_SESSION_START_HELPERS.

const REMINDER_PHRASE = 'must outlive a compaction'

const stub = vi.hoisted(() => ({ startText: null as string | null, streakThrowsOnce: false }))

vi.mock('../src/hooks_session_start.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionStartModule>()
  return {
    ...actual,
    // STUBBED: the real text is the reminder plus project notes and a capsule, which only exceeds the 4096-byte queue cap in a project with many notes; the oversize test sets the text directly, and every other test leaves it null and gets the real one.
    sessionStartOutput: (...args: Parameters<typeof actual.sessionStartOutput>): ReturnType<typeof actual.sessionStartOutput> => (stub.startText === null ? actual.sessionStartOutput(...args) : Promise.resolve({ hookType: 'context', context: stub.startText })),
  }
})

vi.mock('../src/call_streak.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CallStreakModule>()
  return {
    ...actual,
    // STUBBED: no real input makes this step throw after the handlers ran, so the one throw the requeue test needs is injected here, once.
    applyCallStreak: (...args: Parameters<typeof actual.applyCallStreak>): ReturnType<typeof actual.applyCallStreak> => {
      if (stub.streakThrowsOnce) {
        stub.streakThrowsOnce = false
        throw new Error('simulated failure after the handlers ran')
      }
      return actual.applyCallStreak(...args)
    },
  }
})

type Relay = typeof RelayModule
type Registry = typeof RegistryModule

interface HookProcess {
  relay: Relay
  registry: Registry
}

let sid: string
let savedHarness: string | undefined

/** A fresh module graph: its own hook registry, relay queue and caches, as in a newly spawned hook process. */
async function startProcess(): Promise<HookProcess> {
  vi.resetModules()
  const relay = await import('../src/relay.js')
  const registry = await import('../src/hook_registry.js')
  return { relay, registry }
}

function toolCall(proc: HookProcess): Promise<string> {
  return proc.relay.relayInProcess('post_tool_use', { session_id: sid, tool_name: 'TgOwedProbe', tool_input: {}, tool_response: { output: 'raw' } })
}

function occurrences(text: string): number {
  return text.split(REMINDER_PHRASE).length - 1
}

/** The reset the generated Copilot shim runs before it spawns the helper, evaluated from the embedded source. */
function shimReset(sessionId: string): void {
  const run = new Function('require', COPILOT_SESSION_START_HELPERS + '\nreturn resetSessionStartOwedFiles')(createRequire(import.meta.url)) as (payload: unknown) => void
  run({ session_id: sessionId })
}

/** Park the next tool call of `proc` right after the owed-start handler has run and before the relay serializes and commits its output. */
function parkAfterOwedHandler(proc: HookProcess): { reached: Promise<void>; release: () => void } {
  let reach!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => { reach = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  proc.registry.registerHook('post_tool_use', async () => {
    reach()
    await released
    return { hookType: 'pass' }
  }, { advisory: true })
  return { reached, release }
}

beforeEach(() => {
  sid = `owed-concurrent-${randomUUID()}`
  savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
  stub.startText = null
  stub.streakThrowsOnce = false
})

afterEach(() => {
  if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
})

describe('two first tool calls racing after a missed session start', () => {
  it('delivers the owed reminder once when the claim loser runs between the winner producing the text and committing it', async () => {
    shimReset(sid)
    const winner = await startProcess()
    const gate = parkAfterOwedHandler(winner)
    const winning = toolCall(winner)
    await gate.reached
    const loser = await startProcess()
    const losing = await toolCall(loser)
    gate.release()
    const won = await winning
    expect(occurrences(won) + occurrences(losing), `winner: ${won} --- loser: ${losing}`).toBe(1)
    expect(occurrences(won), won).toBe(1)
  })

  it('keeps the owed reminder for the next call when the winner output lost to another handler', async () => {
    shimReset(sid)
    const winner = await startProcess()
    winner.registry.registerHook('post_tool_use', () => ({ hookType: 'context', context: 'SOME OTHER HANDLER CONTEXT' }))
    const winning = await toolCall(winner)
    expect(occurrences(winning), winning).toBe(0)
    const next = await toolCall(await startProcess())
    expect(occurrences(next), next).toBe(1)
    const after = await toolCall(await startProcess())
    expect(occurrences(after), after).toBe(0)
  })

  it('delivers an owed reminder longer than the queue cap once, not again on the next call', async () => {
    shimReset(sid)
    stub.startText = [`${REMINDER_PHRASE} -- opening line`, ...Array.from({ length: 200 }, (_, i) => `project note ${i}: ${'x'.repeat(40)}`)].join('\n')
    expect(stub.startText.length).toBeGreaterThan(MAX_PENDING_CONTEXT_BYTES)
    const first = await toolCall(await startProcess())
    expect(occurrences(first), first).toBe(1)
    const second = await toolCall(await startProcess())
    expect(occurrences(second), second).toBe(0)
  })

  it('keeps the owed reminder for the next call when a step after the handlers threw', async () => {
    shimReset(sid)
    stub.streakThrowsOnce = true
    const failed = await toolCall(await startProcess())
    expect(occurrences(failed), failed).toBe(0)
    const next = await toolCall(await startProcess())
    expect(occurrences(next), next).toBe(1)
    const after = await toolCall(await startProcess())
    expect(occurrences(after), after).toBe(0)
  })
})
