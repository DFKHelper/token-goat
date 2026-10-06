import { describe, it, expect } from 'vitest'
import { renderStats } from '../src/render/stats_renderer.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import type { StatsData } from '../src/render/types.js'

describe('stats compliance insight', () => {
  it('flags low surgical compliance when hints are high and surgical commands are low', () => {
    const mockStats: StatsData = {
      period_start: new Date(0),
      period_end: new Date(86_400_000),
      totals: { events: 140, bytes: 1000, tokens: 250, sparklines: null },
      by_kind: [
        { kind: 'session_hint', bytes: 0, tokens: 0, events: 137, bytes_mode_only: false },
        { kind: 'outline', bytes: 1000, tokens: 250, events: 3, bytes_mode_only: false },
      ],
      by_day: [],
      by_project: [],
      by_command: [
        { command: 'outline', events: 3, bytes: 1000, tokens: 250 },
      ],
    }

    const output = stripAnsiEscapes(renderStats(mockStats))
    expect(output).toContain('Low surgical compliance:')
    expect(output).toContain('3 command(s) vs 137 advisory hints')
    expect(output).toContain('Run `token-goat doctor --fix` to inject the instruction gate.')
  })

  it('does not flag low compliance when compliance is high', () => {
    const mockStats: StatsData = {
      period_start: new Date(0),
      period_end: new Date(86_400_000),
      totals: { events: 50, bytes: 10000, tokens: 2500, sparklines: null },
      by_kind: [
        { kind: 'session_hint', bytes: 0, tokens: 0, events: 10, bytes_mode_only: false },
        { kind: 'outline', bytes: 5000, tokens: 1250, events: 20, bytes_mode_only: false },
        { kind: 'read', bytes: 5000, tokens: 1250, events: 20, bytes_mode_only: false },
      ],
      by_day: [],
      by_project: [],
      by_command: [
        { command: 'outline', events: 20, bytes: 5000, tokens: 1250 },
        { command: 'read', events: 20, bytes: 5000, tokens: 1250 },
      ],
    }

    const output = stripAnsiEscapes(renderStats(mockStats))
    expect(output).not.toContain('Low surgical compliance:')
  })
})
