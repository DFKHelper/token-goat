import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runHintStatsCommand } from '../src/cli_hint_stats.js'
import { logHintEmission, markCategoryEffective, resetHintStats, resolvePendingHintsForEvent } from '../src/hint_stats.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'

function nonce(): string {
  return `chs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    fn()
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

describe('runHintStatsCommand — human output', () => {
  it('prints a header row and one row per known category, even with no data', () => {
    const output = captureStdout(() => runHintStatsCommand())
    expect(output).toContain('category')
    expect(output).toContain('emitted')
    expect(output).toContain('bash_redirect')
    expect(output).toContain('bash_recall')
    expect(output).toContain('read_reread_dedup')
    expect(output).toContain('read_structural_nav')
    expect(output).toContain('edit_reread_suggest')
  })

  it('reflects emission/acted-on/suppression state', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, 'id-1')
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output id-1'))

    const output = captureStdout(() => runHintStatsCommand())
    const line = output.split('\n').find((l) => l.startsWith('bash_recall'))
    expect(line).toBeDefined()
    expect(line).toContain('1')
    expect(line).toContain('100%')
  })
})

describe('runHintStatsCommand — --json', () => {
  it('emits a machine-readable array with one entry per category', () => {
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; emitted: number; efficacyPct: number | null; suppressed: boolean }>
    expect(parsed.length).toBe(5)
    for (const row of parsed) {
      expect(row.emitted).toBe(0)
      expect(row.efficacyPct).toBe(null)
      expect(row.suppressed).toBe(false)
    }
  })
})

describe('runHintStatsCommand — --reset', () => {
  it('clears tracked stats and prints a confirmation', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)

    const output = captureStdout(() => runHintStatsCommand({ reset: true }))
    expect(output).toContain('cleared')

    const after = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(after) as Array<{ emitted: number }>
    expect(parsed.every((row) => row.emitted === 0)).toBe(true)
  })
})

describe('runHintStatsCommand — manual marking', () => {
  it('--mark-effective records a vote and confirms it', () => {
    const output = captureStdout(() => runHintStatsCommand({ markEffective: 'read_reread_dedup' }))
    expect(output).toContain('effective')
    expect(output).toContain('read_reread_dedup')

    const after = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(after) as Array<{ category: string; manualEffective: number }>
    expect(parsed.find((row) => row.category === 'read_reread_dedup')?.manualEffective).toBe(1)
  })

  it('--mark-ineffective records a vote and confirms it', () => {
    const output = captureStdout(() => runHintStatsCommand({ markIneffective: 'edit_reread_suggest' }))
    expect(output).toContain('ineffective')

    const after = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(after) as Array<{ category: string; manualIneffective: number }>
    expect(parsed.find((row) => row.category === 'edit_reread_suggest')?.manualIneffective).toBe(1)
  })

  it('does not blend manual marks into the automatic efficacy percentage', () => {
    markCategoryEffective('bash_redirect')
    const output = captureStdout(() => runHintStatsCommand({ json: true }))
    const parsed = JSON.parse(output) as Array<{ category: string; emitted: number; efficacyPct: number | null }>
    const row = parsed.find((r) => r.category === 'bash_redirect')
    expect(row?.emitted).toBe(0)
    expect(row?.efficacyPct).toBe(null)
  })
})
