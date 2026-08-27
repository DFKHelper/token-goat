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

let corpusDir = ''

beforeAll(() => {
  corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-audit-'))
  const projectDir = path.join(corpusDir, 'C--Projects-example')
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'session-1.jsonl'), ALL_LINES.join('\n') + '\n')
  fs.mkdirSync(path.join(corpusDir, 'bad.jsonl'))
})

afterAll(() => {
  stopBatchCli()
  fs.rmSync(corpusDir, { recursive: true, force: true })
})

describe('listCorpusTranscripts', () => {
  it('finds project-dir transcripts and treats a directory named *.jsonl as a candidate', () => {
    const files = listCorpusTranscripts(corpusDir)
    expect(files).toEqual([path.join(corpusDir, 'C--Projects-example', 'session-1.jsonl'), path.join(corpusDir, 'bad.jsonl')].sort())
  })
})

describe('auditSessionCorpus', () => {
  it('reports the full audit with usage deduplicated per API response, never per JSONL line', async () => {
    const s = await auditSessionCorpus({ dir: corpusDir })
    expect(s.filesScanned).toBe(1)
    expect(s.filesFailed).toBe(1)
    expect(s.lines).toBe(10)
    expect(s.parseFailedLines).toBe(1)
    expect(s.totalBytes).toBe(ALL_LINES.reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8'), 0))
    expect(s.measured).toEqual({ apiCalls: 2, inputTokens: 110, cacheCreationTokens: 200, cacheReadTokens: 300, outputTokens: 45 })
    expect(s.measuredSidechain).toEqual({ apiCalls: 1, inputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 5 })
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
    expect(s.lineTypes['assistant']!.lines).toBe(3)
    expect(s.lineTypes['user']!.lines).toBe(3)
    const zero = { apiCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    expect(s.positionDeciles).toEqual([
      { decile: 1, apiCalls: 1, inputTokens: 600, cacheReadTokens: 300, outputTokens: 40 },
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
    expect(text).toContain('Files: 1 scanned, 1 unreadable')
    expect(text).toContain('API calls: 2 (sidechain: 1)')
    expect(text).toContain('Output tokens:      45')
    expect(text).toContain('Input, uncached:    110')
    expect(text).toContain('Input, cache-write: 200')
    expect(text).toContain('Input, cache-read:  300')
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
    expect(parsed.measured).toEqual({ apiCalls: 2, inputTokens: 110, cacheCreationTokens: 200, cacheReadTokens: 300, outputTokens: 45 })
    expect(parsed.filesScanned).toBe(1)
    expect(parsed.filesFailed).toBe(1)
    expect(parsed.tools).toEqual([{ name: 'Bash', calls: 1, resultBytes: 35, resultEstTokens: 12 }])
  })

  it('fails with a clear error on a missing corpus root', async () => {
    const res = await runBatched(['session-audit', '--dir', path.join(corpusDir, 'nope')])
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('session corpus directory not found')
  })
})
