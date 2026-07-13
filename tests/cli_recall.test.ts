import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runRecallCommand } from '../src/cli_recall.js'
import { indexRecallEntry, resetRecallFtsCacheForTesting } from '../src/recall_index.js'
import { clearModuleCaches } from '../src/reset.js'

function nonce(): string {
  return `cr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

beforeEach(() => {
  clearModuleCaches()
  resetRecallFtsCacheForTesting()
})

afterEach(() => {
  clearModuleCaches()
  resetRecallFtsCacheForTesting()
})

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    fn()
    // Read the captured calls before mockRestore(), which also resets mock state
    // (clears mock.calls) as part of restoring the original implementation.
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

describe('runRecallCommand', () => {
  it('prints a "no entries match" message and exits cleanly on an empty-index / no-hit query', () => {
    const n = nonce()
    const output = captureStdout(() => runRecallCommand(`no-such-thing-${n}`))
    expect(output).toContain(`No cache entries match: no-such-thing-${n}`)
  })

  it('prints matching hits with their cache type, id, and the exact per-type recall command', () => {
    const n = nonce()
    indexRecallEntry('web', `w-${n}`, `https://example.com/${n}`, `https://example.com/${n}\nbody text`, Date.now())

    const output = captureStdout(() => runRecallCommand(n))
    expect(output).toContain(`w-${n}`)
    expect(output).toContain(`token-goat web-output w-${n}`)
    expect(output).toContain('[web')
  })

  it('--json emits a machine-readable array matching the hit shape', () => {
    const n = nonce()
    indexRecallEntry('bash', `b-${n}`, `npm test ${n}`, `npm test ${n}\nall good`, Date.now())

    const output = captureStdout(() => runRecallCommand(n, { json: true }))
    const parsed = JSON.parse(output) as Array<{ id: string; cacheType: string; label: string; snippet: string; storedAt: number }>
    expect(Array.isArray(parsed)).toBe(true)
    const hit = parsed.find((h) => h.id === `b-${n}`)
    expect(hit).toBeDefined()
    expect(hit?.cacheType).toBe('bash')
  })

  it('--type narrows the JSON output to the requested cache type', () => {
    const n = nonce()
    indexRecallEntry('bash', `bt-${n}`, `label ${n}`, `shared-${n} bash`, Date.now())
    indexRecallEntry('web', `wt-${n}`, `label ${n}`, `shared-${n} web`, Date.now())

    const output = captureStdout(() => runRecallCommand(`shared-${n}`, { type: 'web', json: true }))
    const parsed = JSON.parse(output) as Array<{ id: string; cacheType: string }>
    expect(parsed.length).toBe(1)
    expect(parsed[0]?.cacheType).toBe('web')
  })

  it('--limit caps the JSON output length', () => {
    const n = nonce()
    for (let i = 0; i < 5; i++) {
      indexRecallEntry('mcp', `m-${n}-${i}`, `label ${i}`, `limit-token-${n} entry ${i}`, Date.now() + i)
    }

    const output = captureStdout(() => runRecallCommand(`limit-token-${n}`, { limit: 2, json: true }))
    const parsed = JSON.parse(output) as unknown[]
    expect(parsed.length).toBe(2)
  })
})
