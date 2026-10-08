// The bench table, the stats report and the rich stats renderer each print a name read from somewhere else: a bench case id is a file name in a corpus directory, and a stats command or kind is a ledger string. A format character in any of them used to reach the terminal as written.

// HAND-DERIVED: the names are invented to hold U+202E (bidi override, a format character) and a `[tg]` message marker; the expected spellings are displaySafeText's `‮` and `&#91;tg]` escapes worked out from that rule, not read off the implementation's output.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runBenchCommand } from '../src/cli_bench.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import { renderStats as richRenderStats } from '../src/render/stats_renderer.js'
import type { StatsData } from '../src/render/types.js'

const RLO = String.fromCharCode(0x202e)
const FORMAT_CHARS = /\p{Cf}/u

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bench table', () => {
  it('escapes a format character in a case id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-names-'))
    tempDirs.push(dir)
    const id = `case${RLO}x`
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ provenance: 'HAND-DERIVED', command: 'git log', mustKeep: ['x'] }), 'utf8')
    fs.writeFileSync(path.join(dir, `${id}.txt`), 'x\n', 'utf8')
    const { text } = runBenchCommand({ corpus: dir })
    expect(text).not.toMatch(FORMAT_CHARS)
    expect(text).toContain('case\\u202ex')
  })
})

function statsWith(kind: string, command: string): StatsData {
  return {
    period_start: new Date(0),
    period_end: new Date(86_400_000),
    totals: { events: 3, bytes: 1000, tokens: 250, sparklines: null },
    by_kind: [{ kind, bytes: 1000, tokens: 250, events: 3, bytes_mode_only: false }],
    by_day: [],
    by_project: [],
    by_command: [{ command, events: 3, bytes: 1000, tokens: 250 }],
  }
}

describe('rich stats renderer', () => {
  it('escapes a format character in a kind and a command, in the table and in the insight lines', () => {
    const out = stripAnsiEscapes(richRenderStats(statsWith(`kind${RLO}k`, `cmd${RLO}c`)))
    expect(out).not.toMatch(FORMAT_CHARS)
    expect(out).toContain('kind\\u202ek')
    expect(out).toContain('cmd\\u202ec')
  })
})
