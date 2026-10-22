/** Cold-cache re-write accounting in `session-audit` (src/cold_gap.ts wired through src/session_audit.ts). */
// FORMAT-DERIVED: the usage field names (`cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`) and the top-level ISO `timestamp` are the names found on real Claude Code transcript assistant lines, read off a live transcript on 2026-10-22 (key names only, no content); the 5-minute and 1-hour TTLs come from Anthropic's prompt-caching documentation (cache duration section). HAND-DERIVED: every timestamp, token count, tool name and expected billed figure below is invented and computed by hand from input + 1.25 x cache-write + 0.1 x cache-read; none is copied from a real session.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bashCommandClass, bashCommandClassOf, coldGapToolLabel } from '../src/cold_gap.js'
import { auditSessionCorpus, commandHead, type SessionAuditSummary } from '../src/session_audit.js'
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
  /** Timestamp of each assistant line of the request (a streamed request has one line per content block); null omits the key. */
  lines: Array<string | null>
  usage: Record<string, unknown>
  /** Tool the request issues on its last line, or none for a text-only request. */
  tool?: { name: string; input: Record<string, unknown> }
  /** Further tool_use blocks on the same last line, after `tool`. */
  moreTools?: Array<{ name: string; input: Record<string, unknown> }>
  /** The tool_result carries is_error. */
  isError?: boolean
  sidechain?: boolean
}

function transcript(reqs: Req[]): string {
  const out: string[] = []
  reqs.forEach((r) => {
    r.lines.forEach((ts, j) => {
      const last = j === r.lines.length - 1
      const uses = r.tool === undefined ? [] : [r.tool, ...(r.moreTools ?? [])]
      const content = last && uses.length > 0 ? uses.map((u, k) => ({ type: 'tool_use', id: `tu_${r.id}_${k}`, name: u.name, input: u.input })) : [{ type: 'text', text: 'ok' }]
      out.push(JSON.stringify({ type: 'assistant', ...(ts === null ? {} : { timestamp: ts }), ...(r.sidechain === true ? { isSidechain: true } : {}), message: { id: r.id, role: 'assistant', usage: r.usage, content } }))
    })
    if (r.tool !== undefined) out.push(JSON.stringify({ type: 'user', timestamp: r.lines[r.lines.length - 1], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${r.id}_0`, content: 'done', ...(r.isError === true ? { is_error: true } : {}) }] } }))
  })
  return out.join('\n') + '\n'
}

const SECRET = 'SECRETMARK_do_not_print'

// Warm: the request after a 5m-tier gap measured from the LAST line of the previous request is under 5 minutes (first line to next is 5:20, last line to next is 4:20), so a large cache write is still not a cold re-write.
const WARM = transcript([
  { id: 'w1', lines: [at(0), at(1)], usage: usage(10, 5000, 0, '5m'), tool: { name: 'Bash', input: { command: `vitest run ${SECRET}` } } },
  { id: 'w2', lines: [at(5, 20)], usage: usage(10, 20000, 0, '5m') },
])

// 1h tier: a 30 minute gap is warm; a 61.5 minute gap (over 3600 s) after an Agent call is cold, and its cache write is priced at 2x base input (Anthropic prompt-caching docs, https://platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-10-22), so 10 + 2 x 20000 = 40010.
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

// Subagent: a 10 minute gap after a test-runner Bash call re-writes (counted, Bash:test); a 10 minute gap whose request writes only 8k on top of a 200k warm read (under half of the 31k the previous request had cached) is not; a 20 minute gap after a request with no tool call that writes 120k of the 208k the previous request had cached re-writes under (none).
const LANE = transcript([
  { id: 's1', lines: [at(0), at(0, 10)], usage: usage(10, 5000, 0, '5m'), sidechain: true, tool: { name: 'Bash', input: { command: `vitest run src ${SECRET}` } } },
  { id: 's2', lines: [at(10)], usage: usage(10, 30000, 1000, '5m'), sidechain: true, tool: { name: 'Read', input: { file_path: SECRET } } },
  { id: 's3', lines: [at(20)], usage: usage(10, 8000, 200000, '5m'), sidechain: true },
  { id: 's4', lines: [at(40)], usage: usage(10, 120000, 0, '5m'), sidechain: true },
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
    expect(row).toMatchObject({ kind: 'main', requests: 3, coldRewrites: 1, coldBilledEquivTokens: 40010, billedEquivTokens: 90030 })
    expect(summary.coldGap.main.byTool.find((t) => t.tool === 'Agent')).toMatchObject({ coldRewrites: 1, billedEquivTokens: 40010, rewriteBilledEquivTokens: 38000 })
  })

  it('counts a gap with no preceding tool call under the explicit (none) bucket', () => {
    const row = summary.coldGap.sessions.find((s) => s.session === 'main-none')
    expect(row).toMatchObject({ kind: 'main', coldRewrites: 1, coldBilledEquivTokens: 37510 })
    expect(summary.coldGap.main.byTool.find((t) => t.tool === '(none)')).toMatchObject({ coldRewrites: 1, billedEquivTokens: 37510 })
  })

  it('counts a cold re-write after a 5m-tier gap under the awaited tool and Bash command class, and skips a cache-read-dominated request', () => {
    const lane = summary.coldGap.subagent
    expect(lane).toMatchObject({ sessions: 1, requests: 5, coldRewrites: 2, coldBilledEquivTokens: 187620, billedEquivTokens: 227025, coldRewriteBilledEquivTokens: 172500 })
    expect(lane.coldBilledShare).toBeCloseTo(187620 / 227025, 10)
    expect(lane.byTool.map((t) => [t.tool, t.coldRewrites, t.billedEquivTokens])).toEqual([['(none)', 1, 150010], ['Bash:test', 1, 37610]])
    expect(lane.byTool[1]!.billedShare).toBeCloseTo(37610 / 227025, 10)
  })

  it('keeps main sessions and subagents apart', () => {
    const main = summary.coldGap.main
    expect(main).toMatchObject({ sessions: 3, requests: 7, coldRewrites: 2, coldBilledEquivTokens: 77520, billedEquivTokens: 165070, coldRewriteBilledEquivTokens: 72500 })
    expect(main.byTool.map((t) => t.tool)).toEqual(['Agent', '(none)'])
    expect(summary.coldGap.sessions.map((s) => s.session)).toEqual(['agent-cold', 'main-1h', 'main-none'])
    expect(summary.coldGap.sessions[0]).toMatchObject({ kind: 'subagent', coldRewrites: 2 })
  })

  it('classes a head by its first word only', () => {
    const rows: Array<[string, string]> = [['vitest', 'test'], ['tsc', 'build'], ['git', 'git'], ['npm', 'runner'], ['sleep', 'wait'], ['until', 'shell-loop'], ['for', 'shell-loop'], ['bash', 'shell-wrapper'], ['rm', 'file-ops'], ['curl', 'network'], ['grep', 'search-read'], ['zzz', 'other'], ['', 'other']]
    for (const [head, cls] of rows) expect(bashCommandClass(head)).toBe(cls)
    expect(coldGapToolLabel('Bash', 'vitest run', commandHead)).toBe('Bash:test')
    expect(coldGapToolLabel('Bash', undefined, commandHead)).toBe('Bash:other')
    expect(coldGapToolLabel('Read', 'vitest', commandHead)).toBe('Read')
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

// HAND-DERIVED: invented command strings in the shapes shell users type (env prefix, absolute path, quoted exe, bash -lc, env, chains, cd prefix, timeout, nohup, polling loop); the expected class of each is read off which program the line actually runs, independently of the classifier.
const RAW_COMMANDS: Array<[string, string]> = [
  ['FOO=1 vitest', 'test'],
  ['/usr/bin/sleep 5', 'wait'],
  ['  "C:/x/node.exe" a', 'runner'],
  ['bash -lc "sleep 600"', 'wait'],
  ['env X=1 vitest', 'test'],
  ['echo x; sleep 600', 'wait'],
  ['cd a && npm test', 'runner'],
  ['timeout 30 vitest run', 'test'],
  ['nohup sleep 9 &', 'wait'],
  ["sh -c 'ls && sleep 5'", 'wait'],
  ['until x; do sleep 1; done', 'shell-loop'],
  ['git status', 'git'],
  [`curl ${SECRET}`, 'network'],
]

describe('cold gap edge cases', () => {
  async function audit(files: Record<string, string>): Promise<SessionAuditSummary> {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cold-gap-edge-'))
    try {
      fs.mkdirSync(path.join(d, 'proj', 'sess-uuid', 'subagents'), { recursive: true })
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, 'proj', name), text)
      return await auditSessionCorpus({ dir: d })
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  }

  it('judges the gap against the tier the PREVIOUS request wrote: 5m then 1h after 30 minutes is cold, 1h then 5m is not', async () => {
    const s = await audit({
      'five-then-hour.jsonl': transcript([
        { id: 'a1', lines: [at(0)], usage: usage(10, 5000, 0, '5m'), tool: { name: 'Bash', input: { command: 'vitest' } } },
        { id: 'a2', lines: [at(30)], usage: usage(10, 20000, 0, '1h') },
      ]),
      'hour-then-five.jsonl': transcript([
        { id: 'b1', lines: [at(0)], usage: usage(10, 5000, 0, '1h') },
        { id: 'b2', lines: [at(30)], usage: usage(10, 20000, 0, '5m') },
      ]),
    })
    expect(s.coldGap.sessions.map((r) => [r.session, r.coldRewrites])).toEqual([['five-then-hour', 1]])
    expect(s.coldGap.main.byTool.map((t) => t.tool)).toEqual(['Bash:test'])
  })

  it('counts a re-write that still reads a warm shared prefix (15k read, 40k written, 27% read share) and skips a warm request with a small write after a long gap', async () => {
    const s = await audit({
      'shared-prefix.jsonl': transcript([
        { id: 'c1', lines: [at(0)], usage: usage(10, 55000, 0, '5m') },
        { id: 'c2', lines: [at(10)], usage: usage(10, 40000, 15000, '5m') },
      ]),
      'warm-small.jsonl': transcript([
        { id: 'd1', lines: [at(0)], usage: usage(10, 100000, 0, '5m') },
        { id: 'd2', lines: [at(20)], usage: usage(10, 3000, 100000, '5m') },
      ]),
    })
    expect(s.coldGap.sessions.map((r) => [r.session, r.coldRewrites])).toEqual([['shared-prefix', 1]])
    expect(s.coldGap.main).toMatchObject({ coldRewrites: 1, coldBilledEquivTokens: Math.round(10 + 1.25 * 40000 + 0.1 * 15000) })
  })

  it('never counts a negative gap (out-of-order timestamps), a missing timestamp or an unparsable one', async () => {
    const s = await audit({
      'out-of-order.jsonl': transcript([
        { id: 'e1', lines: [at(30)], usage: usage(10, 5000, 0, '5m') },
        { id: 'e2', lines: [at(0)], usage: usage(10, 20000, 0, '5m') },
      ]),
      'no-timestamp.jsonl': transcript([
        { id: 'f1', lines: [at(0)], usage: usage(10, 5000, 0, '5m') },
        { id: 'f2', lines: [null], usage: usage(10, 20000, 0, '5m') },
        { id: 'f3', lines: [at(60)], usage: usage(10, 20000, 0, '5m') },
      ]),
      'bad-timestamp.jsonl': transcript([
        { id: 'g1', lines: [at(0)], usage: usage(10, 5000, 0, '5m') },
        { id: 'g2', lines: ['not-a-date'], usage: usage(10, 20000, 0, '5m') },
        { id: 'g3', lines: [at(60)], usage: usage(10, 20000, 0, '5m') },
      ]),
    })
    expect(s.coldGap.main).toMatchObject({ sessions: 3, requests: 8, coldRewrites: 0 })
    expect(s.coldGap.sessions).toEqual([])
  })

  it('attributes a request with several tool_use blocks to the last one', async () => {
    const s = await audit({
      'multi.jsonl': transcript([
        { id: 'm1', lines: [at(0)], usage: usage(10, 5000, 0, '5m'), tool: { name: 'Read', input: { file_path: 'x' } }, moreTools: [{ name: 'Bash', input: { command: 'sleep 600' } }] },
        { id: 'm2', lines: [at(10)], usage: usage(10, 20000, 0, '5m') },
      ]),
    })
    expect(s.coldGap.main.byTool.map((t) => [t.tool, t.coldRewrites])).toEqual([['Bash:wait', 1]])
  })

  it('still attributes the gap to a tool whose tool_result is an error', async () => {
    const s = await audit({
      'err.jsonl': transcript([
        { id: 'x1', lines: [at(0)], usage: usage(10, 5000, 0, '5m'), tool: { name: 'Bash', input: { command: 'vitest run' } }, isError: true },
        { id: 'x2', lines: [at(10)], usage: usage(10, 20000, 0, '5m') },
      ]),
    })
    expect(s.coldGap.main.byTool.map((t) => [t.tool, t.coldRewrites])).toEqual([['Bash:test', 1]])
  })

  it('classes raw command strings through commandHead, looking through wrappers and chains', () => {
    for (const [raw, cls] of RAW_COMMANDS) expect(bashCommandClassOf(raw, commandHead), raw).toBe(cls)
    expect(bashCommandClassOf('timeout 5', commandHead)).toBe('wait')
    expect(bashCommandClassOf('', commandHead)).toBe('other')
  })

  it('labels each raw command by its class end to end and keeps the command text out of the report', async () => {
    const reqs: Req[] = RAW_COMMANDS.map(([raw], k) => ({ id: `r${k}`, lines: [at(10 * k)], usage: usage(10, 20000, 0, '5m'), sidechain: true, tool: { name: 'Bash', input: { command: raw } } }))
    reqs.push({ id: 'rend', lines: [at(10 * RAW_COMMANDS.length)], usage: usage(10, 20000, 0, '5m'), sidechain: true })
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cold-gap-raw-'))
    try {
      fs.mkdirSync(path.join(d, 'proj', 'sess-uuid', 'subagents'), { recursive: true })
      fs.writeFileSync(path.join(d, 'proj', 'sess-uuid', 'subagents', 'agent-raw.jsonl'), transcript(reqs))
      const sum = await auditSessionCorpus({ dir: d })
      const counts = Object.fromEntries(sum.coldGap.subagent.byTool.map((t) => [t.tool, t.coldRewrites]))
      expect(counts).toEqual({ 'Bash:test': 3, 'Bash:wait': 5, 'Bash:runner': 2, 'Bash:shell-loop': 1, 'Bash:git': 1, 'Bash:network': 1 })
      expect(JSON.stringify(sum.coldGap)).not.toContain(SECRET)
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
