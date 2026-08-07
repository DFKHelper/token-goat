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

// The browse form. `recall` exists so an agent that doesn't know which cache type holds a result
// can ask once instead of running bash-history, web-history, and mcp-history in turn -- but that
// only worked once you already had a search term. With no query the command used to be a hard
// commander error ("missing required argument"), so the one case where you most need the index --
// you have no term because the ids scrolled out of context -- was the case it refused to serve.
describe('runRecallCommand with no query (browse)', () => {
  it('lists entries newest-first across all three cache types', () => {
    // The suite shares one db, so these must out-rank every entry other tests already stored: stamp
    // them in the future rather than at a fixed epoch, and take exactly the top three.
    const n = nonce()
    const base = Date.now() + 1_000_000
    indexRecallEntry('bash', `b-${n}`, `bash label ${n}`, 'bash body', base + 1)
    indexRecallEntry('web', `w-${n}`, `web label ${n}`, 'web body', base + 2)
    indexRecallEntry('mcp', `m-${n}`, `mcp label ${n}`, 'mcp body', base + 3)

    const parsed = JSON.parse(captureStdout(() => runRecallCommand(undefined, { limit: 3, json: true }))) as Array<{ id: string; cacheType: string }>
    expect(parsed.map((p) => p.id)).toEqual([`m-${n}`, `w-${n}`, `b-${n}`])
    expect(parsed.map((p) => p.cacheType)).toEqual(['mcp', 'web', 'bash'])
  })

  it('still emits the per-type recall command for each listed entry', () => {
    const n = nonce()
    indexRecallEntry('web', `w-${n}`, `web label ${n}`, 'web body', Date.now())

    const output = captureStdout(() => runRecallCommand(undefined, { limit: 5 }))
    expect(output).toContain(`token-goat web-output w-${n}`)
  })

  // A search that matches nothing and a browse of an empty cache are different answers: the first
  // means "refine your query", the second means "there is nothing here to find". Collapsing them
  // sends the caller off to refine a query against a store that holds nothing.
  // limit 0 is how this forces the zero-row branch: the suite shares one db, so every cache type
  // already holds entries from other tests and a genuinely empty index cannot be arranged here.
  it('reports a zero-result browse as an empty cache, not as a failed match', () => {
    const output = captureStdout(() => runRecallCommand(undefined, { type: 'bash', limit: 0 }))
    expect(output).toContain('No cache entries yet.')
    expect(output).not.toContain('No cache entries match')
  })

  it('treats a whitespace-only query as browse, not as a search that can never match', () => {
    const n = nonce()
    indexRecallEntry('bash', `b-${n}`, `bash label ${n}`, 'bash body', Date.now())

    const output = captureStdout(() => runRecallCommand('   ', { limit: 5 }))
    expect(output).toContain(`b-${n}`)
    expect(output).not.toContain('No cache entries match')
  })

  it('honours --type when browsing', () => {
    const n = nonce()
    indexRecallEntry('bash', `b-${n}`, `bash label ${n}`, 'bash body', 1000)
    indexRecallEntry('web', `w-${n}`, `web label ${n}`, 'web body', 2000)

    const parsed = JSON.parse(captureStdout(() => runRecallCommand(undefined, { type: 'bash', limit: 10, json: true }))) as Array<{ id: string; cacheType: string }>
    expect(parsed.every((p) => p.cacheType === 'bash')).toBe(true)
    expect(parsed.some((p) => p.id === `b-${n}`)).toBe(true)
  })

  // Guard: browse must not become a synonym for search. A caller who passes a real term still gets
  // filtered results, so a regression that routed everything through the listing path would fail here.
  it('does not turn a real query into a listing', () => {
    // The search term has to live in label/content -- entry_id is not part of the indexed text --
    // so give only the bash entry a discriminating token.
    const n = nonce()
    indexRecallEntry('bash', `b-${n}`, `bash label ${n}`, `onlybash${n} body`, Date.now())
    indexRecallEntry('web', `w-${n}`, `web label ${n}`, 'web body', Date.now())

    const parsed = JSON.parse(captureStdout(() => runRecallCommand(`onlybash${n}`, { limit: 10, json: true }))) as Array<{ id: string }>
    expect(parsed.some((p) => p.id === `b-${n}`)).toBe(true)
    expect(parsed.some((p) => p.id === `w-${n}`)).toBe(false)
  })
})
