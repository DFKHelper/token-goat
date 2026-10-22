/** Cold-cache re-write accounting in `session-audit` (src/cold_gap.ts wired through src/session_audit.ts). */
// CAPTURE: the usage field names (`cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`) and the top-level ISO `timestamp` are the key names read off real Claude Code transcript JSONL assistant `message.usage` records on 2026-10-22 (key names only, no content); FORMAT-DERIVED: the 5-minute and 1-hour TTLs come from Anthropic's prompt-caching documentation (cache duration section). HAND-DERIVED: every timestamp, token count, tool name and expected billed figure below is invented and computed by hand from input + 1.25 x cache-write + 0.1 x cache-read; none is copied from a real session.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { bashCommandClass, bashCommandClassOf, COLD_MIN_CACHE_WRITE_TOKENS, COLD_TTL_MS_1H, COLD_TTL_MS_5M, coldGapToolLabel, formatColdGap, isColdRewrite, newColdGapAccumulator, type ColdGapUsage } from '../src/cold_gap.js'
import { auditSessionCorpus, commandHead, type SessionAuditSummary } from '../src/session_audit.js'
import { formatSessionAudit } from '../src/session_audit_report.js'

// Test seam at the fs boundary only: createReadStream of the one named file yields its bytes and then errors, every other path reads for real.
const failingStream = vi.hoisted(() => ({ path: null as string | null, bytes: Buffer.alloc(0) }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const { Readable: Source } = await import('node:stream')
  const createReadStream = (p: Parameters<typeof actual.createReadStream>[0], ...rest: unknown[]): ReturnType<typeof actual.createReadStream> => {
    if (failingStream.path !== null && String(p).endsWith(failingStream.path)) {
      return Source.from((async function* () {
        yield failingStream.bytes
        // One macrotask boundary drains the microtasks that hand every delivered line to the audit loop (its only await is the line iteration), so the error cannot overtake the lines.
        await new Promise<void>((resolve) => setImmediate(resolve))
        throw new Error('simulated read failure')
      })()) as unknown as ReturnType<typeof actual.createReadStream>
    }
    return (actual.createReadStream as (...a: unknown[]) => ReturnType<typeof actual.createReadStream>)(p, ...rest)
  }
  return { ...actual, default: { ...actual, createReadStream }, createReadStream }
})

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
    // Only the class label survives of a Bash command: no other word of the planted commands (`vitest run src SECRET`) and no Agent prompt or Read path reaches the text section.
    const section = formatColdGap(summary.coldGap).join('\n')
    expect(section).not.toContain(SECRET)
    expect(section).not.toContain('SECRETMARK')
    expect(section).not.toMatch(/vitest/)
    expect(section).not.toMatch(/file_path|prompt/)
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

  // HAND-DERIVED: invented lines in the shapes that broke the splitter; each expected class is read off which programs the line runs (a redirection such as `2>&1` is part of its command, never a command of its own, so it adds no `other` segment).
  const SPLIT_CASES: Array<[string, string, string]> = [
    ['unterminated apostrophe does not swallow the rest', "echo don't; sleep 5", 'wait'],
    ['unterminated double quote does not swallow the rest', 'echo "oops; sleep 5', 'wait'],
    ['a closed quote still hides its separators', 'echo "a; sleep 5"', 'search-read'],
    ['single pipe splits', 'echo hi | sleep 5', 'wait'],
    ['background ampersand splits', 'echo hi & sleep 5', 'wait'],
    ['double pipe still splits', 'echo hi || sleep 5', 'wait'],
    ['double ampersand still splits', 'echo hi && sleep 5', 'wait'],
    ['stderr dup is not a split', 'echo hi 2>&1', 'search-read'],
    ['stdout dup is not a split', 'echo hi >&2', 'search-read'],
    ['ampersand-redirect is not a split', 'echo hi &> /dev/null', 'search-read'],
    ['ampersand-append is not a split', 'echo hi &>> log', 'search-read'],
    ['noclobber pipe is not a split', 'echo hi >| out', 'search-read'],
    ['redirect then pipe splits', 'echo hi 2>&1 | sleep 5', 'wait'],
  ]
  it.each(SPLIT_CASES)('splits segments: %s', (_name, raw, cls) => {
    expect(bashCommandClassOf(raw, commandHead), raw).toBe(cls)
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

// HAND-DERIVED: the 5-minute TTL (300000 ms) and 1-hour TTL (3600000 ms) are Anthropic's documented cache durations; every other number is chosen so the compared quantity sits exactly on, or one unit off, a threshold (1024 written tokens, half of the previous 40000-token prefix = 20000).
const use = (cacheWrite: number): ColdGapUsage => ({ input: 10, cacheWrite, cacheRead: 0, cacheWrite5m: cacheWrite, cacheWrite1h: 0 })

describe('isColdRewrite boundaries', () => {
  const FIVE_MIN = 300000
  const ONE_HOUR_MS = 3600000

  it.each([
    ['5-minute tier', FIVE_MIN],
    ['1-hour tier', ONE_HOUR_MS],
  ])('%s: a gap exactly equal to the TTL is not cold, one millisecond over is', (_tier, ttl) => {
    expect(isColdRewrite(ttl, ttl, use(20000), 20000), 'gap == TTL').toBe(false)
    expect(isColdRewrite(ttl + 1, ttl, use(20000), 20000), 'gap == TTL + 1 ms').toBe(true)
    expect(isColdRewrite(ttl - 1, ttl, use(20000), 20000), 'gap == TTL - 1 ms').toBe(false)
  })

  it('exposes the documented TTLs the accumulator uses', () => {
    expect(COLD_TTL_MS_5M).toBe(FIVE_MIN)
    expect(COLD_TTL_MS_1H).toBe(ONE_HOUR_MS)
  })

  it('needs at least 1024 written tokens: 1023 is not cold, 1024 is', () => {
    expect(COLD_MIN_CACHE_WRITE_TOKENS).toBe(1024)
    expect(isColdRewrite(FIVE_MIN + 1, FIVE_MIN, use(1023), 1000), 'write == 1023').toBe(false)
    expect(isColdRewrite(FIVE_MIN + 1, FIVE_MIN, use(1024), 1000), 'write == 1024').toBe(true)
    expect(isColdRewrite(FIVE_MIN + 1, FIVE_MIN, use(1025), 1000), 'write == 1025').toBe(true)
  })

  it('needs at least half of the previous prefix: exactly half is cold, one token under is not', () => {
    expect(isColdRewrite(FIVE_MIN + 1, FIVE_MIN, use(20000), 40000), 'write == 0.5 x prefix').toBe(true)
    expect(isColdRewrite(FIVE_MIN + 1, FIVE_MIN, use(19999), 40000), 'write == 0.5 x prefix - 1').toBe(false)
    expect(isColdRewrite(FIVE_MIN + 1, FIVE_MIN, use(20001), 40000), 'write == 0.5 x prefix + 1').toBe(true)
  })

  it('never counts a negative gap', () => {
    expect(isColdRewrite(-1, FIVE_MIN, use(20000), 20000)).toBe(false)
  })
})

describe('cold gap report privacy and display safety', () => {
  it('prints a transcript-derived tool name and session id with control characters and marker brackets escaped', () => {
    const hostile = 'Tool\n[tg] injected\u001b[31m'
    const text = formatColdGap({
      main: { sessions: 1, requests: 2, billedEquivTokens: 100, coldRewrites: 1, coldBilledEquivTokens: 50, coldRewriteBilledEquivTokens: 40, coldBilledShare: 0.5, byTool: [{ tool: hostile, coldRewrites: 1, billedEquivTokens: 50, rewriteBilledEquivTokens: 40, billedShare: 0.5 }] },
      subagent: { sessions: 0, requests: 0, billedEquivTokens: 0, coldRewrites: 0, coldBilledEquivTokens: 0, coldRewriteBilledEquivTokens: 0, coldBilledShare: 0, byTool: [] },
      sessions: [{ session: 'sess\n[tg] x', kind: 'main', requests: 2, coldRewrites: 1, billedEquivTokens: 100, coldBilledEquivTokens: 50, coldBilledShare: 0.5 }],
    }).join('\n')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('Tool\n')
    expect(text).not.toContain('sess\n')
    expect(text).not.toMatch(/^\[tg\]/m)
    expect(text).toContain('Tool\\n')
    expect(text).toContain('sess\\n')
  })
})

describe('cold gap checkpoint', () => {
  const weights = { cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 }
  const W = (cacheWrite: number): ColdGapUsage => ({ input: 10, cacheWrite, cacheRead: 100, cacheWrite5m: cacheWrite, cacheWrite1h: 0 })
  const MIN = 60000

  function addFile(acc: ReturnType<typeof newColdGapAccumulator>, session: string, kind: 'main' | 'subagent', tool: string): void {
    const f = acc.beginFile(session, kind)
    f.request(0, `${session}-1`, 0, W(5000))
    f.toolUse(0, `${session}-1`, tool)
    f.request(0, `${session}-2`, 10 * MIN, W(20000))
    f.end()
  }

  it('rolls a folded file back so totals, session rows and tool buckets equal what they were before it, and the accumulator keeps working', () => {
    const acc = newColdGapAccumulator()
    addFile(acc, 'first', 'main', 'Read')
    const before = JSON.stringify(acc.finish(weights))
    expect(JSON.parse(before).main.coldRewrites).toBe(1)
    const restore = acc.checkpoint()
    addFile(acc, 'second', 'main', 'Read')
    addFile(acc, 'third', 'subagent', 'Agent')
    const during = acc.finish(weights)
    expect(during.main.coldRewrites).toBe(2)
    expect(during.subagent.coldRewrites).toBe(1)
    expect(during.sessions.map((s) => s.session).sort()).toEqual(['first', 'second', 'third'])
    restore()
    const after = acc.finish(weights)
    expect(after.main.sessions, 'main sessions').toBe(1)
    expect(after.main.requests, 'main requests').toBe(2)
    expect(after.subagent.sessions, 'subagent sessions').toBe(0)
    expect(after.sessions.map((s) => s.session), 'session rows').toEqual(['first'])
    expect(after.main.byTool.map((t) => [t.tool, t.coldRewrites]), 'main tool buckets').toEqual([['Read', 1]])
    expect(after.subagent.byTool, 'subagent tool buckets').toEqual([])
    expect(JSON.stringify(after), 'whole census').toBe(before)
    addFile(acc, 'fourth', 'main', 'Read')
    expect(acc.finish(weights).main.coldRewrites, 'folds again after a rollback').toBe(2)
  })
})

// HAND-DERIVED: the splitter pairs an apostrophe with the next one even inside a later double-quoted string, so the `sleep` in this invented line is hidden and the line classes as search-read; pinned as the documented heuristic, not as the right answer.
describe('splitSegments quote pairing heuristic', () => {
  it('hides a separator between an apostrophe and a later quote, and still splits a plain one', () => {
    expect(bashCommandClassOf(`echo don't; sleep 5; echo "it's"`, commandHead)).toBe('search-read')
    expect(bashCommandClassOf(`echo don't; sleep 5`, commandHead)).toBe('wait')
  })
})

// HAND-DERIVED: invented two-request transcripts; the failing file is the same bytes as a good one on disk, with the read stream made to error after delivering them, which is what a disk or network-share read failure looks like to auditOneFile. This pins the contract (a failed file leaves the cold section as if it were never read); today it passes even without restoreColdGap because coldFile.end() folds only after a clean read, and the restore itself is pinned by the 'cold gap checkpoint' unit test above.
describe('cold gap rollback in the real corpus audit', () => {
  let corpus = ''
  let goodOnly = ''

  beforeAll(() => {
    corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cold-rollback-'))
    goodOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cold-rollback-good-'))
    fs.writeFileSync(path.join(corpus, 'a-good.jsonl'), NO_TOOL)
    fs.writeFileSync(path.join(goodOnly, 'a-good.jsonl'), NO_TOOL)
    fs.writeFileSync(path.join(corpus, 'b-bad.jsonl'), WARM)
  })

  afterAll(() => {
    fs.rmSync(corpus, { recursive: true, force: true })
    fs.rmSync(goodOnly, { recursive: true, force: true })
  })

  it('drops the cold re-writes a file folded before its read failed, leaving the section the good file alone produces', async () => {
    const reference = await auditSessionCorpus({ dir: goodOnly })
    expect(reference.coldGap.main.coldRewrites, 'good file alone has a cold re-write').toBe(1)
    // Two cold-relevant requests (a 10 minute gap, 30k written) are delivered, then the stream errors.
    failingStream.path = 'b-bad.jsonl'
    failingStream.bytes = Buffer.from(NO_TOOL.replace(/"n1"/g, '"bad1"').replace(/"n2"/g, '"bad2"'))
    try {
      const s = await auditSessionCorpus({ dir: corpus })
      expect(s.filesFailed, 'the bad file failed').toBe(1)
      expect(s.filesScanned, 'the good file scanned').toBe(1)
      expect(s.coldGap.main.coldRewrites, 'cold re-writes after rollback').toBe(1)
      expect(s.coldGap.sessions.map((r) => r.session), 'session rows after rollback').toEqual(['a-good'])
      expect(JSON.stringify(s.coldGap), 'whole cold section equals the good file alone').toBe(JSON.stringify(reference.coldGap))
    } finally {
      failingStream.path = null
    }
  })
})
