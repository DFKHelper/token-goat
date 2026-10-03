/** A transcript line that is valid JSON but not the object the readers expect (`null`, a number, an array, a `message` that is null or a string, a `usage` that is null) is skipped like any other malformed line, and a file that does fail partway leaves nothing in the audit. PROVENANCE: the well-formed lines are CAPTURE, read at run time from tests/fixtures/transcript_usage_capture.jsonl (real Claude Code 2.1.270 assistant lines, row in tests/fixtures/PROVENANCE.tsv) plus one user tool_result line copied from the CAPTURE in tests/session_audit_tool_errors.test.ts (Claude Code 2.1.281, 2026-09-24). The hostile lines are HAND-DERIVED mutations of those: each replaces one field of a captured line with a value of another JSON type, which is what a hand-edited or truncated transcript can hold. Expected counts are computed from the number of captured lines, not from a reader. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCopilotWasteReport } from '../src/copilot_waste.js'
import { buildSessionOutline } from '../src/session_read.js'
import { auditSessionCorpus, checkpointAudit, type SessionAuditSummary } from '../src/session_audit.js'
import { newToolErrorAccumulator } from '../src/tool_error_census.js'
import { parseTranscript } from '../src/waste.js'

const CAPTURED = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'transcript_usage_capture.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0)
// CAPTURE: Claude Code 2.1.281 user line, copied from tests/session_audit_tool_errors.test.ts RUN_LINES.
const USER_LINE = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01AaJzK9t4i43Zc2R7jHfoou","content":"Found 1 file\\nsrc\\\\a.ts"}]}}'

const HOSTILE_LINES = [
  'null',
  '42',
  '"text"',
  '[1,2]',
  'true',
  '{"type":"assistant","message":null}',
  '{"type":"assistant","message":"text"}',
  '{"type":"assistant","message":[1]}',
  '{"type":"assistant","message":{"id":"msg_x","usage":null,"content":[{"type":"text","text":"a"}]}}',
  '{"type":"assistant","message":{"id":"msg_y","usage":"nope","content":{"a":1}}}',
  '{"type":"assistant","message":{"id":"msg_z","usage":[1],"content":[null,1,"s",{"type":"tool_use","id":"toolu_1","name":"Bash","input":null}]}}',
  '{"type":"user","message":null}',
  '{"type":"user","message":"hello"}',
  '{"type":"user","message":{"content":[null,{"type":"tool_result","tool_use_id":7,"content":null}]}}',
  '{"type":"attachment","attachment":null}',
  '{"type":"attachment","attachment":"text"}',
  '{"type":"system","subtype":null}',
]

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hostile-lines-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeLines(name: string, lines: string[]): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, `${lines.join('\n')}\n`)
  return p
}

describe('session-audit on lines that are JSON but not an object', () => {
  it('counts a null line as malformed and still scans the file around it', async () => {
    const dirOfFile = path.join(dir, 'junk')
    fs.mkdirSync(dirOfFile)
    writeLines('junk/x.jsonl', [CAPTURED[0]!, 'null', CAPTURED[1]!])
    const s = await auditSessionCorpus({ dir: dirOfFile })
    expect(s.filesScanned).toBe(1)
    expect(s.filesFailed).toBe(0)
    expect(s.lines).toBe(3)
    expect(s.parseFailedLines).toBe(1)
    expect(s.measured.apiCalls).toBe(2)
  })

  it.each(HOSTILE_LINES)('does not fail the file on %s', async (hostile) => {
    const dirOfFile = path.join(dir, 'junk')
    fs.mkdirSync(dirOfFile)
    writeLines('junk/x.jsonl', [CAPTURED[0]!, USER_LINE, hostile, CAPTURED[2]!])
    const s = await auditSessionCorpus({ dir: dirOfFile })
    expect(s.filesFailed).toBe(0)
    expect(s.filesScanned).toBe(1)
    expect(s.lines).toBe(4)
    expect(s.measured.apiCalls).toBeGreaterThanOrEqual(2)
  })
})

describe('checkpointAudit', () => {
  it('rolls the summary, maps, arrays and tool-error census back to the moment it was taken', async () => {
    const dirOfFile = path.join(dir, 'ok')
    fs.mkdirSync(dirOfFile)
    writeLines('ok/x.jsonl', [CAPTURED[0]!, USER_LINE])
    const summary: SessionAuditSummary = await auditSessionCorpus({ dir: dirOfFile })
    const before = JSON.stringify(summary)
    const toolMap = new Map<string, { calls: number }>([['Bash', { calls: 1 }]])
    const rows: number[] = [1]
    const acc = newToolErrorAccumulator()
    acc.countCall('Bash', 'm')
    const censusBefore = JSON.stringify(acc.finish())
    const restore = checkpointAudit(summary, [toolMap], [rows], acc)
    summary.lines += 10
    summary.measured.apiCalls += 5
    summary.lineTypes['assistant']!.lines += 3
    toolMap.get('Bash')!.calls += 4
    toolMap.set('Read', { calls: 1 })
    rows.push(2, 3)
    acc.countCall('Bash', 'm')
    acc.countError('Bash', 'm', 'Exit code 2\nls: cannot access', {})
    restore()
    expect(JSON.stringify(summary)).toBe(before)
    expect([...toolMap.entries()]).toEqual([['Bash', { calls: 1 }]])
    expect(rows).toEqual([1])
    expect(JSON.stringify(acc.finish())).toBe(censusBefore)
  })
})

describe('other transcript readers on a null line', () => {
  it('waste parseTranscript, session-outline and the Copilot events reader skip it', async () => {
    const claude = writeLines('claude.jsonl', [CAPTURED[0]!, 'null', USER_LINE])
    expect(parseTranscript(claude).calls).toEqual([])
    expect((await buildSessionOutline(claude)).map((t) => t.lineNumber)).toEqual([1, 3])
    // FORMAT-DERIVED: a Copilot events.jsonl line is {type, id, timestamp, data}, see tests/copilot_waste.test.ts ev().
    const copilot = writeLines('events.jsonl', ['null', '{"type":"user.message","id":"e","timestamp":1,"data":{"transformedContent":"<current_datetime>t</current_datetime>"}}'])
    expect(buildCopilotWasteReport(copilot).turns).toBe(1)
  })
})
