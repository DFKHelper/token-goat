// The plain-text stats report prints each by-command row's name. summarize() builds those names from token-goat's own command table today, so a ledger row cannot make one hostile; the report still owes the escape because it prints whatever string the summary hands it.

// HAND-DERIVED: the command name is invented to hold U+202E (bidi override, a format character); the expected spelling is displaySafeText's `‮` escape worked out from that rule. The summary is the real summarize() output with one by_command name replaced, because no ledger row can produce a hostile name.
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as StatsModule from '../src/stats.js'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<typeof StatsModule>()
  return {
    ...original,
    summarize: (...args: Parameters<typeof original.summarize>) => ({
      ...original.summarize(...args),
      total_events: 3,
      by_command: [{ command: `cmd${String.fromCharCode(0x202e)}c`, events: 3, bytes_saved: 1000, tokens_saved: 250 }],
    }),
  }
})

import { renderStats } from '../src/stats_report.js'

const FORMAT_CHARS = /\p{Cf}/u

afterEach(() => {
  vi.restoreAllMocks()
})

describe('plain stats report', () => {
  it('escapes a format character in a by-command name', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const isTty = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    try {
      renderStats({ windowDays: 30 })
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true })
    }
    const out = lines.join('\n')
    expect(out).toContain('## By Command')
    expect(out).not.toMatch(FORMAT_CHARS)
    expect(out).toContain('cmd\\u202ec')
  })
})
