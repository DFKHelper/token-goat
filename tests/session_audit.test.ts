/**
 * Coverage for `token-goat session-audit` (src/session_audit.ts): corpus-wide token attribution
 * over Claude Code JSONL transcripts. The fixture below is hand-written JSONL literals and every
 * expected number is derived by hand from those literals, independently of the implementation:
 * usage totals are the arithmetic sums of the usage objects written into the fixture, byte counts
 * are counted off the literal strings, and est-token values are chars/3+1 computed on paper
 * (12 bytes -> 5, 16 -> 6, 35 -> 12, 3 -> 2, 5 -> 2).
 *
 * The load-bearing case is usage deduplication: Claude Code writes one JSONL line per streamed
 * content block, and every line of one API response repeats the same message.id and usage
 * (confirmed empirically: 24,610 assistant lines, 13,263 unique ids in one real transcript).
 * The fixture carries two lines sharing msg_A: summed per line the input total would be 1,200;
 * counted per response it is 600. The distinct-id control (msg_A + msg_B => apiCalls 2) guards
 * the over-fix direction: dedup keyed on anything coarser than message.id would collapse them.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { auditSessionCorpus, formatSessionAudit, listCorpusTranscripts } from '../src/session_audit.js'
import { runBatched, stopBatchCli } from './helpers/batch-cli.js'

const L1 = '{"type":"assistant","message":{"id":"msg_A","role":"assistant","usage":{"input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":300,"output_tokens":40},"content":[{"type":"text","text":"Hello world!"}]}}'
const L2 = '{"type":"assistant","message":{"id":"msg_A","role":"assistant","usage":{"input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":300,"output_tokens":40},"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}]}}'
const L3 = '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"line1\\n--- 7 lines omitted ---\\nline9"}]}}'
const L4 = '{"type":"assistant","isSidechain":true,"message":{"id":"msg_B","role":"assistant","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5},"content":[{"type":"thinking","thinking":"abc"}]}}'
const L5 = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do the thing"}]}}'
const L6 = '{"type":"user","isMeta":true,"message":{"role":"user","content":"meta!"}}'
const L7 = '{"type":"attachment","attachment":{"type":"x"}}'
const L8 = '{"type":"file-history-snapshot","messageId":"m","snapshot":{}}'
const L9 = 'this line is not json'
const L10 = '{"type":"system","subtype":"hook"}'
const ALL_LINES = [L1, L2, L3, L4, L5, L6, L7, L8, L9, L10]

// A subagent transcript nested at depth 4 (<project>/<session>/subagents/*.jsonl), the layout modern Claude Code uses for sidechains. On one real corpus these deep files carried 65% of all API calls, so a walk that stops at depth 2 renders a 43%-of-billing pass as a corpus-wide result.
const D1 = '{"type":"assistant","isSidechain":true,"message":{"id":"msg_S","role":"assistant","usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":3,"output_tokens":2},"content":[]}}'

let corpusDir = ''

beforeAll(() => {
  corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-audit-'))
  const projectDir = path.join(corpusDir, 'C--Projects-example')
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'session-1.jsonl'), ALL_LINES.join('\n') + '\n')
  const subagentsDir = path.join(projectDir, 'aaaa-session-uuid', 'subagents')
  fs.mkdirSync(subagentsDir, { recursive: true })
  fs.writeFileSync(path.join(subagentsDir, 'agent-1.jsonl'), D1 + '\n')
  fs.mkdirSync(path.join(corpusDir, 'bad.jsonl'))
})

afterAll(() => {
  stopBatchCli()
  fs.rmSync(corpusDir, { recursive: true, force: true })
})

describe('listCorpusTranscripts', () => {
  it('finds transcripts at every depth, including <session>/subagents ones, and treats a directory named *.jsonl as a candidate', () => {
    const files = listCorpusTranscripts(corpusDir)
    expect(files).toEqual([path.join(corpusDir, 'C--Projects-example', 'session-1.jsonl'), path.join(corpusDir, 'C--Projects-example', 'aaaa-session-uuid', 'subagents', 'agent-1.jsonl'), path.join(corpusDir, 'bad.jsonl')].sort())
  })
})

describe('auditSessionCorpus', () => {
  it('reports the full audit with usage deduplicated per API response, never per JSONL line', async () => {
    const s = await auditSessionCorpus({ dir: corpusDir })
    expect(s.filesScanned).toBe(2)
    expect(s.filesFailed).toBe(1)
    expect(s.lines).toBe(11)
    expect(s.parseFailedLines).toBe(1)
    expect(s.totalBytes).toBe(ALL_LINES.concat([D1]).reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8'), 0))
    expect(s.measured).toEqual({ apiCalls: 3, inputTokens: 117, cacheCreationTokens: 200, cacheReadTokens: 303, outputTokens: 47 })
    expect(s.measuredSidechain).toEqual({ apiCalls: 2, inputTokens: 17, cacheCreationTokens: 0, cacheReadTokens: 3, outputTokens: 7 })
    expect(s.tools).toEqual([{ name: 'Bash', calls: 1, resultBytes: 35, resultEstTokens: 12 }])
    expect(s.omissionMarkers).toEqual({ fires: 1, linesOmitted: 7 })
    expect(s.estimated.assistantText).toEqual({ count: 1, bytes: 12, estTokens: 5 })
    expect(s.estimated.assistantThinking).toEqual({ count: 1, bytes: 3, estTokens: 2 })
    expect(s.estimated.toolUseInputs).toEqual({ count: 1, bytes: 16, estTokens: 6 })
    expect(s.estimated.toolResults).toEqual({ count: 1, bytes: 35, estTokens: 12 })
    expect(s.estimated.userTurns).toEqual({ count: 1, bytes: 12, estTokens: 5 })
    expect(s.estimated.harnessMeta).toEqual({ count: 1, bytes: 5, estTokens: 2 })
    expect(s.estimated.attachments.count).toBe(1)
    expect(s.estimated.attachments.bytes).toBe(Buffer.byteLength(L7, 'utf8'))
    expect(s.estimated.system.count).toBe(1)
    expect(s.estimated.system.bytes).toBe(Buffer.byteLength(L10, 'utf8'))
    expect(s.estimated.otherLocal.count).toBe(2)
    expect(s.estimated.otherLocal.bytes).toBe(Buffer.byteLength(L8, 'utf8') + Buffer.byteLength(L9, 'utf8'))
    expect(Object.keys(s.lineTypes).sort()).toEqual(['assistant', 'attachment', 'file-history-snapshot', 'system', 'user'])
    expect(s.lineTypes['assistant']!.lines).toBe(4)
    expect(s.lineTypes['user']!.lines).toBe(3)
    // agent-1.jsonl is the only lane file: one usage (7+0+3 = 10 prefix tokens, 1 call), no user turn (brief 0). Billed-equiv on paper: round(10 x 1.25) = 13. The main-file Bash tool_result must NOT enter the Read-interception census.
    expect(s.sidechainLanes).toEqual({ laneFiles: 1, lanesWithUsage: 1, meanFirstCallPrefixTokens: 10, medianFirstCallPrefixTokens: 10, p90FirstCallPrefixTokens: 10, meanCallsPerLane: 1, meanBriefBytes: 0, prefixBilledEquivTokens: 13 })
    expect(s.readInterception).toEqual({ readResults: 0, divertedByMarker: 0, divertedBytes: 0, fullServesOver10k: 0, fullServeBytesOver10k: 0 })
    const zero = { apiCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    expect(s.positionDeciles).toEqual([
      { decile: 1, apiCalls: 2, inputTokens: 610, cacheReadTokens: 303, outputTokens: 42 },
      { decile: 2, ...zero },
      { decile: 3, ...zero },
      { decile: 4, ...zero },
      { decile: 5, ...zero },
      { decile: 6, apiCalls: 1, inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 },
      { decile: 7, ...zero },
      { decile: 8, ...zero },
      { decile: 9, ...zero },
      { decile: 10, ...zero },
    ])
  })

  it('rejects a missing corpus root rather than reporting an empty result as complete', async () => {
    await expect(auditSessionCorpus({ dir: path.join(corpusDir, 'does-not-exist') })).rejects.toThrow(/session corpus directory not found/)
  })

  it('rejects a corpus root containing no transcripts rather than rendering a zero report', async () => {
    const empty = path.join(corpusDir, 'empty-root')
    fs.mkdirSync(empty, { recursive: true })
    await expect(auditSessionCorpus({ dir: empty })).rejects.toThrow(/no \.jsonl session transcripts found/)
  })
})

describe('formatSessionAudit', () => {
  it('renders aggregate counts only, with measured and estimated ledgers in separate sections', async () => {
    const s = await auditSessionCorpus({ dir: corpusDir })
    const text = formatSessionAudit(s)
    expect(text).toContain('Files: 2 scanned, 1 unreadable')
    expect(text).toContain('API calls: 3 (sidechain: 2)')
    expect(text).toContain('Output tokens:      47')
    expect(text).toContain('Input, uncached:    117')
    expect(text).toContain('Input, cache-write: 200')
    expect(text).toContain('Input, cache-read:  303')
    expect(text).toContain('fires: 1, lines discarded: 7')
    expect(text).toContain('NOT billed units')
    expect(text).not.toContain('Hello world!')
    expect(text).not.toContain('do the thing')
    expect(text).not.toContain('C--Projects-example')
  })
})

describe('session-audit via the built bundle', () => {
  it('reports the same measured ledger through real CLI dispatch with --json', async () => {
    const res = await runBatched(['session-audit', '--dir', corpusDir, '--json'])
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { measured: unknown; filesScanned: number; filesFailed: number; tools: unknown }
    expect(parsed.measured).toEqual({ apiCalls: 3, inputTokens: 117, cacheCreationTokens: 200, cacheReadTokens: 303, outputTokens: 47 })
    expect(parsed.filesScanned).toBe(2)
    expect(parsed.filesFailed).toBe(1)
    expect(parsed.tools).toEqual([{ name: 'Bash', calls: 1, resultBytes: 35, resultEstTokens: 12 }])
  })

  it('fails with a clear error on a missing corpus root', async () => {
    const res = await runBatched(['session-audit', '--dir', path.join(corpusDir, 'nope')])
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('session corpus directory not found')
  })
})

/**
 * Attachment-kind census fixture, derived by hand from the literals below, independently of the
 * implementation. Call sequence (main lane): A1 at call 0, C1, A2 at call 1, C2, compact boundary
 * (flushes A1: 5 tok x 2 calls = 10, A2: 4 tok x 1 = 4), A3 at call 2 (identical to A1), H2 at
 * call 2, C3, end of file (flushes A3: 5 x 1 = 5, H2: 1 x 1 = 1). Sidechain lane: SA at side call
 * 0, S1, end of file (flushes SA: 2 tok x 1 side call = 2). The sidechain attachment is the lane
 * control: merged into the main call sequence it would sit at main call 0 and flush at the main
 * boundary as 2 tok x 2 calls = 4, not 2. Visible bytes
 * deep-sum every string in the visible fields, so A2's block discriminator value "text" counts (6
 * content + 4 = 10). Est-tokens are bytes/3+1 on paper: 12 -> 5, 10 -> 4, 3 -> 2, 2 -> 1. Billed
 * equivalents on paper: round(1.25 x est + 0.1 x reread) = 14, 5, 3, 1.
 */
/**
 * Sidechain-lane and Read-interception fixture, expected values derived by hand from the
 * literals. Lane 1: first usage 100+900+0 = 1000 prefix tokens, 2 distinct calls, brief
 * "please do X" = 11 bytes; billed-equiv on paper: round(1000 x (1.25 + 0.1 x 1)) = 1350.
 * Lane 2 carries no usage at all: it must count in laneFiles but stay OUT of every mean
 * (counting it as prefix 0 would drag meanFirstCallPrefixTokens to 500). Reads, main file:
 * R1 is a 52-byte divert message (counted); R2 is a 12,000-byte full serve (counted, and its
 * trailing marker-like text must not divert it because it is over the size cap); R3 is a
 * 5-byte ordinary result (neither); R4 is a 3,000-byte body mentioning a token-goat command
 * (neither: over the divert cap, under the full-serve floor).
 */
describe('sidechain lane and read interception census', () => {
  const DIVERT_TEXT = 'a.md was already read this session. Use the cache.'
  const R_USE = (id: string): string => `{"type":"assistant","message":{"id":"msg_ru_${id}","role":"assistant","content":[{"type":"tool_use","id":"${id}","name":"Read","input":{"file_path":"a.md"}}]}}`
  const R1 = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r1","content":"${DIVERT_TEXT}"}]}}`
  const BIG = 'A'.repeat(11950) + ' Use `token-goat section "a.md::H"' + 'B'.repeat(16)
  const R2 = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r2","content":"${BIG.replace(/"/g, '\\"')}"}]}}`
  const R3 = '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r3","content":"hello"}]}}'
  const MID = 'C'.repeat(2960) + ' Use `token-goat read "a.ts::fn"'
  const R4 = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r4","content":"${MID.replace(/"/g, '\\"')}"}]}}`
  const LANE1 = [
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"please do X"}]}}',
    '{"type":"assistant","isSidechain":true,"message":{"id":"msg_L1a","role":"assistant","usage":{"input_tokens":100,"cache_creation_input_tokens":900,"cache_read_input_tokens":0,"output_tokens":1},"content":[]}}',
    '{"type":"assistant","isSidechain":true,"message":{"id":"msg_L1b","role":"assistant","usage":{"input_tokens":5,"cache_creation_input_tokens":20,"cache_read_input_tokens":1000,"output_tokens":1},"content":[]}}',
  ]
  const LANE2 = ['{"type":"attachment","attachment":{"type":"task_status"}}']
  let laneDir = ''

  beforeAll(() => {
    laneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-lanes-'))
    const projectDir = path.join(laneDir, 'C--Projects-lanes')
    const subagentsDir = path.join(projectDir, 'sess-uuid', 'subagents')
    fs.mkdirSync(subagentsDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'main.jsonl'), [R_USE('r1'), R1, R_USE('r2'), R2, R_USE('r3'), R3, R_USE('r4'), R4].join('\n') + '\n')
    fs.writeFileSync(path.join(subagentsDir, 'agent-lane1.jsonl'), LANE1.join('\n') + '\n')
    fs.writeFileSync(path.join(subagentsDir, 'agent-lane2.jsonl'), LANE2.join('\n') + '\n')
  })

  afterAll(() => {
    fs.rmSync(laneDir, { recursive: true, force: true })
  })

  it('rolls up lane spawn prefixes over lanes with usage only, and classifies Read results into divert, full-serve, and neither', async () => {
    const s = await auditSessionCorpus({ dir: laneDir })
    expect(s.sidechainLanes).toEqual({ laneFiles: 2, lanesWithUsage: 1, meanFirstCallPrefixTokens: 1000, medianFirstCallPrefixTokens: 1000, p90FirstCallPrefixTokens: 1000, meanCallsPerLane: 2, meanBriefBytes: 11, prefixBilledEquivTokens: 1350 })
    expect(s.readInterception).toEqual({ readResults: 4, divertedByMarker: 1, divertedBytes: Buffer.byteLength(DIVERT_TEXT, 'utf8'), fullServesOver10k: 1, fullServeBytesOver10k: Buffer.byteLength(BIG, 'utf8') })
  })

  it('renders both new sections and reports the same rollups through real CLI dispatch with --json', async () => {
    const s = await auditSessionCorpus({ dir: laneDir })
    const text = formatSessionAudit(s)
    expect(text).toContain('Lane files: 2 (1 with usage)')
    expect(text).toContain('First-call prefix tokens: mean 1,000, median 1,000, p90 1,000')
    expect(text).toContain('Prefix billed-equiv tokens: 1,350 (write x 1.25, then x 0.1 per later call in the lane)')
    expect(text).toContain('Read results: 4; diverted by marker: 1 (50 bytes); full serves >=10 KiB: 1 (12,000 bytes)')
    const res = await runBatched(['session-audit', '--dir', laneDir, '--json'])
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { sidechainLanes: unknown; readInterception: unknown }
    expect(parsed.sidechainLanes).toEqual(s.sidechainLanes)
    expect(parsed.readInterception).toEqual(s.readInterception)
  })
})

describe('attachment kind census', () => {
  const A1 = '{"type":"attachment","attachment":{"type":"skill_listing","content":"0123456789AB","skillCount":1}}'
  const C1 = '{"type":"assistant","message":{"id":"msg_C","role":"assistant","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1},"content":[]}}'
  const A2 = '{"type":"attachment","attachment":{"type":"task_reminder","content":[{"type":"text","text":"abcdef"}]}}'
  const SA = '{"type":"attachment","isSidechain":true,"attachment":{"type":"file","content":{"text":"xyz"}}}'
  const H1 = '{"type":"attachment","attachment":{"type":"hook_success","hookEvent":"PreToolUse","hookName":"PreToolUse:Read","command":"node token-goat hook pre-read","content":"","stdout":"0123456789","stderr":"","exitCode":0}}'
  const C2 = '{"type":"assistant","message":{"id":"msg_D","role":"assistant","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1},"content":[]}}'
  const B = '{"type":"system","subtype":"compact_boundary"}'
  const A3 = A1
  const H2 = '{"type":"attachment","attachment":{"type":"hook_success","hookEvent":"PreToolUse","hookName":"PreToolUse:Bash","command":"powershell foo","content":"xy","stdout":"xy","stderr":"","exitCode":0}}'
  const C3 = '{"type":"assistant","message":{"id":"msg_E","role":"assistant","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1},"content":[]}}'
  const S1 = '{"type":"assistant","isSidechain":true,"message":{"id":"msg_F","role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1},"content":[]}}'
  const CENSUS_LINES = [A1, SA, C1, A2, H1, C2, B, A3, H2, C3, S1]
  const EXPECTED_KINDS = [
    { kind: 'skill_listing', injections: 2, lineBytes: 2 * Buffer.byteLength(A1, 'utf8'), visibleBytes: 24, estTokens: 10, rereadTokens: 15, billedEquivTokens: 14, repeatedIdentical: 1, repeatedChanged: 0 },
    { kind: 'task_reminder', injections: 1, lineBytes: Buffer.byteLength(A2, 'utf8'), visibleBytes: 10, estTokens: 4, rereadTokens: 4, billedEquivTokens: 5, repeatedIdentical: 0, repeatedChanged: 0 },
    { kind: 'file', injections: 1, lineBytes: Buffer.byteLength(SA, 'utf8'), visibleBytes: 3, estTokens: 2, rereadTokens: 2, billedEquivTokens: 3, repeatedIdentical: 0, repeatedChanged: 0 },
    { kind: 'hook_success', injections: 2, lineBytes: Buffer.byteLength(H1, 'utf8') + Buffer.byteLength(H2, 'utf8'), visibleBytes: 2, estTokens: 1, rereadTokens: 1, billedEquivTokens: 1, repeatedIdentical: 0, repeatedChanged: 1 },
  ]
  const EXPECTED_HOOKS = [
    { origin: 'other', event: 'PreToolUse', fires: 1, stdoutBytes: 2, contextBytes: 2 },
    { origin: 'token-goat', event: 'PreToolUse', fires: 1, stdoutBytes: 10, contextBytes: 0 },
  ]
  let censusDir = ''

  beforeAll(() => {
    censusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-census-'))
    const projectDir = path.join(censusDir, 'C--Projects-census')
    fs.mkdirSync(projectDir)
    fs.writeFileSync(path.join(projectDir, 'session-2.jsonl'), CENSUS_LINES.join('\n') + '\n')
  })

  afterAll(() => {
    fs.rmSync(censusDir, { recursive: true, force: true })
  })

  it('rolls up per-kind visible bytes, compaction-capped reread cost per lane, and repeat detection', async () => {
    const s = await auditSessionCorpus({ dir: censusDir })
    expect(s.attachmentKinds).toEqual(EXPECTED_KINDS)
    expect(s.hookOutputs).toEqual(EXPECTED_HOOKS)
  })

  it('renders both census sections and reports the same rollups through real CLI dispatch with --json', async () => {
    const s = await auditSessionCorpus({ dir: censusDir })
    const text = formatSessionAudit(s)
    expect(text).toContain('## Attachment kinds by modeled billed cost (model-visible fields only; NOT billed units)')
    expect(text).toContain('## Hook stdout channel (hook_success attachments; context-bytes is the model-visible share)')
    const res = await runBatched(['session-audit', '--dir', censusDir, '--json'])
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as { attachmentKinds: unknown; hookOutputs: unknown }
    expect(parsed.attachmentKinds).toEqual(EXPECTED_KINDS)
    expect(parsed.hookOutputs).toEqual(EXPECTED_HOOKS)
  })
})
