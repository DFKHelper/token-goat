import { describe, it, expect, beforeEach } from 'vitest'
import {
  fg,
  bg,
  vlen,
  padL,
  padR,
  stripAnsi,
  fmtBytes,
  lerpRgb,
  C,
  RESET,
} from '../src/render/ansi.js'
import { renderList, renderPanel, renderTable } from '../src/render/common.js'
import { renderStats, setStatsMessages } from '../src/render/stats_renderer.js'
import type { StatsData, TotalStats } from '../src/render/types.js'

describe('ANSI formatting', () => {
  it('fg creates foreground color escape sequence', () => {
    const result = fg(255, 128, 64)
    expect(result).toContain('\x1b[38;2;')
    expect(result).toContain('255;128;64')
  })

  it('bg creates background color escape sequence', () => {
    const result = bg(100, 200, 50)
    expect(result).toContain('\x1b[48;2;')
    expect(result).toContain('100;200;50')
  })

  it('vlen calculates visible length ignoring ANSI codes', () => {
    const ansiString = `${fg(255, 0, 0)}hello${RESET}`
    expect(vlen(ansiString)).toBe(5)
  })

  it('vlen returns correct length for plain text', () => {
    expect(vlen('hello')).toBe(5)
  })

  it('padL left-pads to target width', () => {
    const result = padL('hi', 10)
    expect(vlen(result)).toBe(10)
    expect(result.endsWith('hi')).toBe(true)
  })

  it('padR right-pads to target width', () => {
    const result = padR('hi', 10)
    expect(vlen(result)).toBe(10)
    expect(result.startsWith('hi')).toBe(true)
  })

  it('padL handles ANSI-coded strings correctly', () => {
    const colored = `${fg(255, 0, 0)}hi${RESET}`
    const result = padL(colored, 10)
    expect(vlen(result)).toBe(10)
  })

  it('stripAnsi removes all escape sequences', () => {
    const ansiString = `${fg(255, 0, 0)}hello${RESET} world`
    expect(stripAnsi(ansiString)).toBe('hello world')
  })

  it('stripAnsi handles plain text', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })

  it('stripAnsi strips a terminated OSC 8 hyperlink down to just the visible link text', () => {
    const hyperlink = '\x1b]8;;http://example.com\x07visible text\x1b]8;;\x07'
    expect(stripAnsi(hyperlink)).toBe('visible text')
  })

  it('stripAnsi drops a truncated/unterminated OSC sequence at end of input without leaking raw escape bytes or eating preceding real content (regression)', () => {
    const truncated = 'before text\x1b]8;;http://example.com/never-closed'
    const result = stripAnsi(truncated)
    expect(result).toBe('before text')
    expect(result).not.toContain('\x1b')
  })

  it('stripAnsi drops a truncated/unterminated PM sequence (ESC ^) without leaking a raw escape byte or eating preceding real content (regression: ^ was missing from the bare-escape fallback range)', () => {
    const truncated = 'before text\x1b^some pm payload with no terminator'
    const result = stripAnsi(truncated)
    expect(result.startsWith('before text')).toBe(true)
    expect(result).not.toContain('\x1b')
  })

  it('stripAnsi drops a bare CSI introducer with no final byte at end of input (regression: [ was missing from the bare-escape fallback range)', () => {
    const truncated = 'before text\x1b['
    const result = stripAnsi(truncated)
    expect(result).toBe('before text')
    expect(result).not.toContain('\x1b')
  })

  it('lerpRgb interpolates colors', () => {
    const result = lerpRgb([0, 0, 0], [255, 255, 255], 0.5)
    expect(result[0]).toBe(128)
    expect(result[1]).toBe(128)
    expect(result[2]).toBe(128)
  })

  it('lerpRgb handles t=0', () => {
    const result = lerpRgb([100, 200, 50], [255, 100, 200], 0)
    expect(result).toEqual([100, 200, 50])
  })

  it('lerpRgb handles t=1', () => {
    const result = lerpRgb([100, 200, 50], [255, 100, 200], 1)
    expect(result).toEqual([255, 100, 200])
  })

  it('fmtBytes formats bytes correctly', () => {
    expect(fmtBytes(512)).toContain('B')
    expect(fmtBytes(1024)).toContain('KB')
    expect(fmtBytes(1024 * 1024)).toContain('MB')
    expect(fmtBytes(1024 * 1024 * 1024)).toContain('GB')
  })

  it('fmtBytes handles zero', () => {
    const result = fmtBytes(0)
    expect(result).toContain('0')
    expect(result).toContain('B')
  })

  it('fmtBytes handles negative values', () => {
    const result = fmtBytes(-1024)
    expect(result).toContain('-')
    expect(result).toContain('KB')
  })

  it('Color palette C is defined', () => {
    expect(C.TEXT_PRIMARY).toBeDefined()
    expect(C.GREEN5).toBeDefined()
    expect(Array.isArray(C.BLUE)).toBe(true)
    expect(C.BLUE.length).toBe(3)
  })
})

describe('Common rendering', () => {
  it('renderList formats items with bullet points', () => {
    const result = renderList(['item 1', 'item 2', 'item 3'])
    expect(result).toContain('item 1')
    expect(result).toContain('item 2')
    expect(result).toContain('•')
    expect(stripAnsi(result).split('\n')).toHaveLength(3)
  })

  it('renderList uses custom bullet', () => {
    const result = renderList(['a', 'b'], undefined, '—')
    expect(result).toContain('—')
    expect(result).not.toContain('•')
  })

  it('renderList handles empty list', () => {
    const result = renderList([])
    expect(result).toBe('')
  })

  it('renderTable formats headers and rows', () => {
    const result = renderTable(['Name', 'Value'], [['foo', '100'], ['bar', '200']])
    expect(result).toContain('Name')
    expect(result).toContain('Value')
    expect(result).toContain('foo')
    expect(result).toContain('100')
  })

  it('renderTable handles empty rows', () => {
    const result = renderTable(['Col1', 'Col2'], [])
    expect(result).toContain('Col1')
    expect(result).toContain('Col2')
  })

  it('renderPanel creates a bordered panel', () => {
    const result = renderPanel('Hello World')
    expect(result).toContain('Hello World')
    expect(stripAnsi(result)).toContain('╭')
    expect(stripAnsi(result)).toContain('╰')
  })

  it('renderPanel includes title when provided', () => {
    const result = renderPanel('Content', 'Title')
    expect(result).toContain('Content')
    expect(result).toContain('Title')
  })

  it('renderPanel handles multiline content', () => {
    const result = renderPanel('Line 1\nLine 2\nLine 3')
    const lines = stripAnsi(result).split('\n')
    expect(lines.length).toBeGreaterThan(3)
  })
})

describe('Stats rendering', () => {
  let minimalStats: StatsData

  beforeEach(() => {
    const totals: TotalStats = {
      events: 100,
      bytes: 50000,
      tokens: 5000,
      events_delta: 10,
      bytes_delta: 5,
      tokens_delta: 8,
      sparklines: {
        events: [0.2, 0.4, 0.6, 0.8],
        bytes: [0.1, 0.3, 0.5, 0.9],
        tokens: [0.15, 0.35, 0.55, 0.85],
      },
    }

    minimalStats = {
      period_start: new Date('2024-01-01'),
      period_end: new Date('2024-01-31'),
      totals,
      by_kind: [
        { kind: 'Read', bytes: 30000, tokens: 3000, events: 60 },
        { kind: 'image_shrink', bytes: 15000, tokens: 1500, events: 30, bytes_mode_only: true },
      ],
      by_day: [
        { date: '2024-01-31', bytes: 10000, tokens: 1000, events: 20 },
        { date: '2024-01-30', bytes: 8000, tokens: 800, events: 18 },
      ],
      by_project: [
        { project: 'ProjectA', hash: 'abc123', path: '/path/to/a', bytes: 40000, tokens: 4000, events: 80 },
      ],
      by_source: [
        { source: 'read', bytes: 30000, tokens: 3000, events: 60 },
        { source: 'image', bytes: 15000, tokens: 1500, events: 30 },
      ],
      by_command: [{ command: 'read', bytes: 30000, tokens: 3000, events: 60 }],
      version: '1.0.0',
      window_label: 'last 30 days',
    }
  })

  it('renderStats produces a non-empty string', () => {
    const result = renderStats(minimalStats)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('renderStats includes header with version', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('token-goat')
    expect(result).toContain('1.0.0')
    expect(result).toContain('last 30 days')
  })

  it('renderStats includes KPI section with event count', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('events')
    expect(result).toContain('100')
  })

  it('renderStats includes by-kind section', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('By kind')
    expect(result).toContain('Read')
    expect(result).toContain('image_shrink')
  })

  it('renderStats includes by-source section', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('By source')
    expect(result).toContain('read')
    expect(result).toContain('image')
  })

  it('renderStats includes by-command section', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('By command')
  })

  it('renderStats includes by-day section', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('By day')
    expect(result).toContain('2024-01-31')
  })

  it('renderStats includes by-project section', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('By project')
    expect(result).toContain('ProjectA')
    expect(result).toContain('abc123')
  })

  it('renderStats includes insights section', () => {
    const result = renderStats(minimalStats)
    expect(result).toContain('Insights')
  })

  it('renderStats with { short: true } includes the header and KPI section', () => {
    const result = renderStats(minimalStats, { short: true })
    expect(result).toContain('token-goat')
    expect(result).toContain('1.0.0')
    expect(result).toContain('last 30 days')
    expect(result).toContain('events')
    expect(result).toContain('100')
  })

  it('renderStats with { short: true } omits the by-* and insights sections', () => {
    const result = renderStats(minimalStats, { short: true })
    expect(result).not.toContain('By kind')
    expect(result).not.toContain('By source')
    expect(result).not.toContain('By command')
    expect(result).not.toContain('By day')
    expect(result).not.toContain('By project')
    expect(result).not.toContain('Insights')
  })

  it('renderStats with { short: true } includes a hint pointing at --full', () => {
    const result = renderStats(minimalStats, { short: true })
    expect(result).toContain("Run 'token-goat stats --full'")
  })

  it('renderStats handles empty by_kind gracefully', () => {
    const stats = { ...minimalStats, by_kind: [] }
    const result = renderStats(stats)
    expect(result).not.toContain('By kind')
  })

  it('renderStats handles empty by_day gracefully', () => {
    const stats = { ...minimalStats, by_day: [] }
    const result = renderStats(stats)
    expect(result).not.toContain('By day')
  })

  it('renderStats handles empty by_project gracefully', () => {
    const stats = { ...minimalStats, by_project: [] }
    const result = renderStats(stats)
    expect(result).not.toContain('By project')
  })

  it('renderStats handles missing by_source gracefully', () => {
    const stats = { ...minimalStats }
    delete stats.by_source
    const result = renderStats(stats)
    expect(result).not.toContain('By source')
  })

  it('renderStats handles missing by_command gracefully', () => {
    const stats = { ...minimalStats }
    delete stats.by_command
    const result = renderStats(stats)
    expect(result).not.toContain('By command')
  })

  it('renderStats flags hints fired with zero direct command invocations', () => {
    const stats = {
      ...minimalStats,
      by_command: [],
      by_source: [{ source: 'hint', bytes: 9200000, tokens: 2423072, events: 723 }],
    }
    const result = renderStats(stats)
    expect(result).toContain('0 direct commands')
    expect(result).toContain('723')
    expect(result).toContain('hint(s) fired but not acted on')
  })

  it('renderStats stays silent about hints when direct commands were used', () => {
    const stats = {
      ...minimalStats,
      by_source: [
        { source: 'hint', bytes: 9200000, tokens: 2423072, events: 723 },
        { source: 'read', bytes: 30000, tokens: 3000, events: 60 },
      ],
    }
    const result = renderStats(stats)
    expect(result).not.toContain('hint(s) fired but not acted on')
  })

  it('renderStats does not flag hints when by_source has no hint entries at all', () => {
    const stats = { ...minimalStats, by_command: [] }
    const result = renderStats(stats)
    expect(result).not.toContain('hint(s) fired but not acted on')
  })

  it('renderStats handles zero deltas', () => {
    const stats = { ...minimalStats }
    stats.totals.events_delta = null
    stats.totals.bytes_delta = 0
    stats.totals.tokens_delta = undefined
    const result = renderStats(stats)
    expect(result).toContain('events')
  })

  it('renderStats handles large numbers with proper formatting', () => {
    const stats = { ...minimalStats }
    stats.totals.bytes = 1_000_000_000
    stats.totals.tokens = 1_000_000
    const result = renderStats(stats)
    expect(result).toContain('GB')
    expect(result).toContain('Mt')
  })

  it('renderStats handles negative bytes (overhead)', () => {
    const stats = { ...minimalStats }
    stats.by_kind = [
      { kind: 'session_hint', bytes: 5000, tokens: 500, events: 10 },
      { kind: 'session_hint_overhead', bytes: -1000, tokens: -100, events: 5 },
    ]
    const result = renderStats(stats)
    expect(result).toContain('session_hint')
  })

  it('renderStats handles bytes_mode_only kinds', () => {
    const stats = { ...minimalStats }
    stats.by_kind = [
      { kind: 'image_shrink', bytes: 5000, tokens: 500, events: 10, bytes_mode_only: true },
    ]
    const result = renderStats(stats)
    expect(result).toContain('image_shrink')
  })

  it('renderStats includes sparklines when provided', () => {
    const result = renderStats(minimalStats)
    expect(result.includes('▁') || result.includes('▂') || result.includes('█')).toBe(true)
  })

  it('renderStats handles missing sparklines', () => {
    const stats = { ...minimalStats }
    stats.totals.sparklines = null
    const result = renderStats(stats)
    expect(result).toContain('token-goat')
  })

  it('renderStats output is not empty for complete stats', () => {
    const result = renderStats(minimalStats)
    const lines = result.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(20)
  })

  it('renderStats handles missing version', () => {
    const stats = { ...minimalStats, version: undefined }
    const result = renderStats(stats)
    expect(result).toContain('token-goat')
  })

  it('renderStats handles missing window_label', () => {
    const stats = { ...minimalStats, window_label: undefined }
    const result = renderStats(stats)
    expect(result).toContain('token-goat')
  })

  it('setStatsMessages customizes insight messages', () => {
    setStatsMessages({
      bytesModeOnlyNote: 'custom note',
      sessionHintSplitNote: 'custom split',
      insights: {
        biggestSaver: 'Top saver: ',
        mostActive: 'Most busy: ',
        tokenLeader: 'Token hero: ',
      },
    })

    const stats = { ...minimalStats }
    const result = renderStats(stats)
    expect(result.includes('custom note') || result.includes('custom split')).toBe(true)

    // Reset to default
    setStatsMessages({
      bytesModeOnlyNote: 'tracks bytes, not vision tokens',
      sessionHintSplitNote:
        'session_hint shows realized savings; session_hint_overhead shows injected hint cost',
      insights: {
        biggestSaver: 'Biggest saver  ',
        mostActive: 'Most active    ',
        tokenLeader: 'Token leader   ',
      },
    })
  })

  it('renderStats with multiple kinds grouped correctly', () => {
    const stats = { ...minimalStats }
    stats.by_kind = [
      { kind: 'read_replacement', bytes: 10000, tokens: 1000, events: 20 },
      { kind: 'image_shrink', bytes: 5000, tokens: 0, events: 10, bytes_mode_only: true },
      { kind: 'session_hint', bytes: 3000, tokens: 300, events: 15 },
      { kind: 'bash_compress:pytest', bytes: 2000, tokens: 200, events: 5 },
    ]
    const result = renderStats(stats)
    expect(result).toContain('Read savings')
    expect(result).toContain('Images')
    expect(result).toContain('Hints')
    expect(result).toContain('Bash')
  })

  it('renderStats handles project with path stripping', () => {
    const stats = { ...minimalStats }
    stats.by_project = [
      {
        project: 'TestProject',
        hash: 'def456',
        path: 'C:\\Users\\test\\Projects\\myapp',
        bytes: 25000,
        tokens: 2500,
        events: 50,
      },
    ]
    const result = renderStats(stats)
    expect(result).toContain('TestProject')
    expect(result).toContain('def456')
  })

  it('renderStats "By kind" table does not silently drop kinds unmapped to any _KIND_GROUPS bucket', () => {
    const stats = { ...minimalStats }
    // 'mystery_new_kind' is not a member of any group in _KIND_GROUPS, so _kindGroupLabel()
    // falls back to 'Other' for it. It is also responsible for the majority of bytes/tokens,
    // so Insights will name it as the biggest saver -- the By-kind table must not contradict
    // that by omitting it entirely.
    stats.by_kind = [
      { kind: 'mystery_new_kind', bytes: 40000, tokens: 4000, events: 50 },
      { kind: 'read_replacement', bytes: 10000, tokens: 1000, events: 20 },
    ]
    const result = renderStats(stats)
    const byKindBlock = result.split('By kind')[1]?.split('By source')[0] ?? ''
    expect(byKindBlock).toContain('mystery_new_kind')
    expect(byKindBlock).toContain('Other')
    // Insights should still name it as the biggest saver -- both sections must agree.
    const insightsBlock = result.split('Insights')[1] ?? ''
    expect(insightsBlock).toContain('mystery_new_kind')
  })

  it('renderByProjectSection percentages use the grand total, not the sum of displayed rows', () => {
    const stats = { ...minimalStats }
    // Grand total across the whole period is far larger than what these 3 displayed
    // (top-N filtered) projects sum to -- each is truly worth 10% of the grand total,
    // but naively summing just the displayed rows would make each look like 33.3%.
    stats.totals = { ...stats.totals, bytes: 100000, tokens: 10000 }
    stats.by_project = [
      { project: 'ProjectA', hash: 'aaa111', path: '/a', bytes: 10000, tokens: 1000, events: 10 },
      { project: 'ProjectB', hash: 'bbb222', path: '/b', bytes: 10000, tokens: 1000, events: 10 },
      { project: 'ProjectC', hash: 'ccc333', path: '/c', bytes: 10000, tokens: 1000, events: 10 },
    ]
    const result = renderStats(stats)
    const byProjectBlock = result.split('By project')[1]?.split('Insights')[0] ?? ''
    expect(byProjectBlock).toContain('10.0%')
    expect(byProjectBlock).not.toContain('33.3%')
  })
})

describe('Edge cases', () => {
  it('handles stats with zero totals', () => {
    const stats: StatsData = {
      period_start: new Date('2024-01-01'),
      period_end: new Date('2024-01-02'),
      totals: { events: 0, bytes: 0, tokens: 0 },
      by_kind: [],
      by_day: [],
      by_project: [],
    }
    const result = renderStats(stats)
    expect(result).toContain('token-goat')
  })

  it('handles very long project names', () => {
    const longName = 'very-long-project-name-that-exceeds-normal-display-width'
    const stats: StatsData = {
      period_start: new Date('2024-01-01'),
      period_end: new Date('2024-01-02'),
      totals: { events: 10, bytes: 1000, tokens: 100 },
      by_kind: [],
      by_day: [],
      by_project: [
        {
          project: longName,
          hash: 'hash',
          path: '/path',
          bytes: 1000,
          tokens: 100,
          events: 10,
        },
      ],
    }
    const result = renderStats(stats)
    expect(result).toContain('…')
  })

  it('stripAnsi handles multiple escape sequences', () => {
    const colored = `${fg(255, 0, 0)}red${RESET}${fg(0, 255, 0)}green${RESET}${fg(0, 0, 255)}blue${RESET}`
    expect(stripAnsi(colored)).toBe('redgreenblue')
  })

  it('padL and padR preserve ANSI codes', () => {
    const colored = `${fg(255, 0, 0)}text${RESET}`
    const padded = padL(colored, 20)
    expect(vlen(padded)).toBe(20)
    expect(padded).toContain('\x1b[')
  })
})
