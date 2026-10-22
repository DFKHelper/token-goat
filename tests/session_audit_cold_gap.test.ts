/** Cold-cache re-write accounting in `session-audit` (src/cold_gap.ts wired through src/session_audit.ts). */
// FORMAT-DERIVED: the usage field names (`cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`) and the top-level ISO `timestamp` are the names found on real Claude Code transcript assistant lines, read off a live transcript on 2026-10-22 (key names only, no content); the 5-minute and 1-hour TTLs come from Anthropic's prompt-caching documentation (cache duration section). HAND-DERIVED: every timestamp, token count, tool name and expected billed figure below is invented and computed by hand from input + 1.25 x cache-write + 0.1 x cache-read; none is copied from a real session.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bashCommandClass, coldGapToolLabel } from '../src/cold_gap.js'
import { auditSessionCorpus, type SessionAuditSummary } from '../src/session_audit.js'
import { formatSessionAudit } from '../src/session_audit_report.js'

const BASE_MS = Date.UTC(2026, 9, 1, 10, 0, 0)
const at = (min: number, sec = 0): string => new Date(BASE_MS + (min * 60 + sec) * 1000).toISOString()

type Tier = '5m' | '1h'

function usage(input: number, cc: number, cr: number, tier: Tier): Record<string, unknown> {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cc,
    cache_read_input_tokens: cr,
    output_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: tier === '5m' ? cc : 0, ephemeral_1h_input_tokens: tier === '1h' ? cc : 0 },
  }
}

interface Req {
  id: string
  /** Timestamp of each assistant line of the request (a streamed request has one line per content block). */
  lines: string[]
  usage: Record<string, unknown>
  /** Tool the request issues on its last line, or none for a text-only request. */
  tool?: { name: string; input: Record<string, unknown> }
  sidechain?: boolean
}

function transcript(reqs: Req[]): string {
  const out: string[] = []
  reqs.forEach((r) => {
    r.lines.forEach((ts, j) => {
      const last = j === r.lines.length - 1
      const content = last && r.tool !== undefined ? [{ type: 'tool_use', id: `tu_${r.id}`, name: r.tool.name, input: r.tool.input }] : [{ type: 'text', text: 'ok' }]
      out.push(JSON.stringify({ type: 'assistant', timestamp: ts, ...(r.sidechain === true ? { isSidechain: true } : {}), message: { id: r.id, role: 'assistant', usage: r.usage, content } }))
    })
    if (r.tool !== undefined) out.push(JSON.stringify({ type: 'user', timestamp: r.lines[r.lines.length - 1], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${r.id}`, content: 'done' }] } }))
  })
  return out.join('\n') + '\n'
}

const SECRET = 'SECRETMARK_do_not_print'

// Warm: the request after a 5m-tier gap measured from the LAST line of the previous request is under 5 minutes (first line to next is 5:20, last line to next is 4:20), so a large cache write is still not a cold re-write.
const WARM = transcript([
  { id: 'w1', lines: [at(0), at(1)], usage: usage(10, 5000, 0, '5m'), tool: { name: 'Bash', input: { command: `vitest run ${SECRET}` } } },
  { id: 'w2', lines: [at(5, 20)], usage: usage(10, 20000, 0, '5m') },
])

// 1h tier: a 30 minute gap is warm; a 61.5 minute gap after an Agent call is cold.
const ONE_HOUR = transcript([
  { id: 'h1', lines: [at(0)], usage: usage(10, 5000, 0, '1h') },
  { id: 'h2', lines: [at(30)], usage: usage(10, 20000, 0, '1h'), tool: { name: 'Agent', input: { prompt: SECRET } } },
  { id: 'h3', lines: [at(91, 30)], usage: usage(10, 20000, 0, '1h') },
])

// No tool call before the gap: the previous request ended with text only.
const NO_TOOL = transcript([
  { id: 'n1', lines: [at(0)], usage: usage(10, 5000, 0, '5m') },
  { id: 'n2', lines: [at(10)], usage: usage(10, 30000, 0, '5m') },
])

// Subagent: a 10 minute gap after a test-runner Bash call re-writes (counted, Bash:test); a 10 minute gap whose request still reads almost everything from cache is not; a 20 minute gap after a request with no tool call re-writes under (none).
const LANE = transcript([
  { id: 's1', lines: [at(0), at(0, 10)], usage: usage(10, 5000, 0, '5m'), sidechain: true, tool: { name: 'Bash', input: { command: `vitest run src ${SECRET}` } } },
  { id: 's2', lines: [at(10)], usage: usage(10, 30000, 1000, '5m'), sidechain: true, tool: { name: 'Read', input: { file_path: SECRET } } },
  { id: 's3', lines: [at(20)], usage: usage(10, 8000, 200000, '5m'), sidechain: true },
  { id: 's4', lines: [at(40)], usage: usage(10, 25000, 0, '5m'), sidechain: true },
  { id: 's5', lines: [at(41)], usage: usage(10, 500, 25000, '5m'), sidechain: true },
])

let dir = ''
let summary: SessionAuditSummary

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cold-gap-'))
  const project = path.join(dir, 'proj')
  fs.mkdirSync(path.join(project, 'sess-uuid', 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(project, 'main-warm.jsonl'), WARM)
  fs.writeFileSync(path.join(project, 'main-1h.jsonl'), ONE_HOUR)
  fs.writeFileSync(path.join(project, 'main-none.jsonl'), NO_TOOL)
  fs.writeFileSync(path.join(project, 'sess-uuid', 'subagents', 'agent-cold.jsonl'), LANE)
  summary = await auditSessionCorpus({ dir })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('cold gap accounting', () => {
  it('does not count a request under the 5m TTL, measured from the last line of the previous request', () => {
    expect(summary.coldGap.sessions.find((s) => s.session === 'main-warm')).toBeUndefined()
  })

  it('does not count a 30 minute gap in a 1h-tier session, and counts a 61.5 minute one under the tool awaited', () => {
    const row = summary.coldGap.sessions.find((s) => s.session === 'main-1h')
    expect(row).toMatchObject({ kind: 'main', requests: 3, coldRewrites: 1, coldBilledEquivTokens: 25010 })
    expect(summary.coldGap.main.byTool.find((t) => t.tool === 'Agent')).toMatchObject({ coldRewrites: 1, billedEquivTokens: 25010 })
  })

  it('counts a gap with no preceding tool call under the explicit (none) bucket', () => {
    const row = summary.coldGap.sessions.find((s) => s.session === 'main-none')
    expect(row).toMatchObject({ kind: 'main', coldRewrites: 1, coldBilledEquivTokens: 37510 })
    expect(summary.coldGap.main.byTool.find((t) => t.tool === '(none)')).toMatchObject({ coldRewrites: 1, billedEquivTokens: 37510 })
  })

  it('counts a cold re-write after a 5m-tier gap under the awaited tool and Bash command class, and skips a cache-read-dominated request', () => {
    const lane = summary.coldGap.subagent
    expect(lane).toMatchObject({ sessions: 1, requests: 5, coldRewrites: 2, coldBilledEquivTokens: 68870, billedEquivTokens: 108275, coldRewriteBilledEquivTokens: 63250 })
    expect(lane.coldBilledShare).toBeCloseTo(68870 / 108275, 10)
    expect(lane.byTool.map((t) => [t.tool, t.coldRewrites, t.billedEquivTokens])).toEqual([['Bash:test', 1, 37610], ['(none)', 1, 31260]])
    expect(lane.byTool[0]!.billedShare).toBeCloseTo(37610 / 108275, 10)
  })

  it('keeps main sessions and subagents apart', () => {
    const main = summary.coldGap.main
    expect(main).toMatchObject({ sessions: 3, requests: 7, coldRewrites: 2, coldBilledEquivTokens: 62520, billedEquivTokens: 131320 })
    expect(main.byTool.map((t) => t.tool)).toEqual(['(none)', 'Agent'])
    expect(summary.coldGap.sessions.map((s) => s.session)).toEqual(['agent-cold', 'main-none', 'main-1h'])
    expect(summary.coldGap.sessions[0]).toMatchObject({ kind: 'subagent', coldRewrites: 2 })
  })

  it('classes a Bash command by its first word only', () => {
    const rows: Array<[string, string]> = [['vitest', 'test'], ['tsc', 'build'], ['git', 'git'], ['npm', 'runner'], ['sleep', 'wait'], ['until', 'shell-loop'], ['for', 'shell-loop'], ['bash', 'shell-wrapper'], ['rm', 'file-ops'], ['curl', 'network'], ['grep', 'search-read'], ['zzz', 'other'], ['', 'other']]
    for (const [head, cls] of rows) expect(bashCommandClass(head)).toBe(cls)
    expect(coldGapToolLabel('Bash', 'vitest')).toBe('Bash:test')
    expect(coldGapToolLabel('Bash', undefined)).toBe('Bash:other')
    expect(coldGapToolLabel('Read', 'vitest')).toBe('Read')
  })

  it('renders a text section and never carries command or prompt text', () => {
    const text = formatSessionAudit(summary)
    expect(text).toContain('## Cold cache re-writes')
    expect(text).toContain('Bash:test')
    expect(text).toContain('Subagents: 1 transcripts, 5 requests, cold re-writes 2')
    expect(text).not.toContain(SECRET)
    expect(JSON.stringify(summary)).not.toContain(SECRET)
  })
})
