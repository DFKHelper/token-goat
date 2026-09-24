import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditSessionCorpus } from '../src/session_audit.js'
import { formatToolErrorCensus } from '../src/tool_error_census.js'

// CAPTURE: tool_use and tool_result lines from a Claude Code 2.1.281 session on 2026-09-24 (Haiku 4.5; a missing-file Read, `ls nonexistent_dir`, two Greps and a Glob), cut down to the fields the audit reads: type, message id/model/content, toolDenialKind.
const RUN_LINES = [
  '{"type":"assistant","message":{"id":"msg_011CfMoLktJccQT67wnDbVp8","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01AaJzK9t4i43Zc2R7jHfoou","name":"Grep","input":{"pattern":"alpha","path":"src"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01AaJzK9t4i43Zc2R7jHfoou","content":"Found 1 file\\nsrc\\\\a.ts"}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMoM3c8rTK1TbGWLwBqe","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01NYni2yPDTAPBLNBAKFNU8E","name":"Grep","input":{"pattern":"delta","path":"src"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01NYni2yPDTAPBLNBAKFNU8E","content":"No files found"}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMoMETzQqS86ADMbq43v","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01T1Ji8eYdfFtedbaFmdqcCV","name":"Read","input":{"file_path":"src/missing.ts"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01T1Ji8eYdfFtedbaFmdqcCV","is_error":true,"content":"File does not exist. Note: your current working directory is C:\\\\Users\\\\zelys\\\\AppData\\\\Local\\\\Temp\\\\tg_capture\\\\proj."}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMoMLmkAomFbHi2vmJU6","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01GHfnYcArveWGa5mdHps8M2","name":"Bash","input":{"command":"ls nonexistent_dir","description":"List contents of nonexistent directory"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01GHfnYcArveWGa5mdHps8M2","is_error":true,"content":"Exit code 2\\nls: cannot access \'nonexistent_dir\': No such file or directory"}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMoMkJcKCzaG7HkdEJVM","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01KZ3u9jbZqsu4yTjKByJ5Ah","name":"Glob","input":{"pattern":"src/*.py"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01KZ3u9jbZqsu4yTjKByJ5Ah","content":"No files found"}]}}',
]

// CAPTURE: the same capture's second session, where a PreToolUse hook denied Glob twice (the transcript carries toolDenialKind) and Read failed twice on one missing file, cut down the same way.
const DENY_LINES = [
  '{"type":"assistant","message":{"id":"msg_011CfMq4STKC3PEaL4AWvf4N","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01S41oHKRcZqTRs2itUcqZnh","name":"Glob","input":{"pattern":"src/*.ts"}}]}}',
  '{"type":"user","toolDenialKind":"permission-rule","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01S41oHKRcZqTRs2itUcqZnh","is_error":true,"content":"PreToolUse:Glob hook error: [tg] test deny"}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMq4deGNEtG6FUacuBmG","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01111WLet8hzioWHLRXaT4nG","name":"Glob","input":{"pattern":"src/*.ts"}}]}}',
  '{"type":"user","toolDenialKind":"permission-rule","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01111WLet8hzioWHLRXaT4nG","is_error":true,"content":"PreToolUse:Glob hook error: [tg] test deny"}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMq4k9CMj6PSVuYXCjDt","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_015wzBY5MqGDjmgDKzV2kJP1","name":"Read","input":{"file_path":"src/missing2.ts"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_015wzBY5MqGDjmgDKzV2kJP1","is_error":true,"content":"File does not exist. Note: your current working directory is C:\\\\Users\\\\zelys\\\\AppData\\\\Local\\\\Temp\\\\tg_capture\\\\proj."}]}}',
  '{"type":"assistant","message":{"id":"msg_011CfMq4qWe9reDhky8NgpyA","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01Nf5dVm1FUJaYmousnAxfTb","name":"Read","input":{"file_path":"src/missing2.ts"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01Nf5dVm1FUJaYmousnAxfTb","is_error":true,"content":"File does not exist. Note: your current working directory is C:\\\\Users\\\\zelys\\\\AppData\\\\Local\\\\Temp\\\\tg_capture\\\\proj."}]}}',
]

// CAPTURE: an unclassified failure from the 2026-09-24 corpus census (tool, model and text as recorded); the message and tool_use ids are HAND-DERIVED placeholders because the census kept neither.
const OTHER_MODEL_LINES = [
  '{"type":"assistant","message":{"id":"msg_census_no_tab","model":"claude-opus-5","content":[{"type":"tool_use","id":"toolu_census_no_tab","name":"mcp__claude-in-chrome__browser_batch","input":{}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_census_no_tab","is_error":true,"content":"No tab available"}]}}',
]

const DAY_MS = 24 * 60 * 60 * 1000

let corpusDir: string

beforeEach(() => {
  corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-session-tool-errors-'))
  const projectDir = path.join(corpusDir, 'proj')
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'run.jsonl'), RUN_LINES.join('\n') + '\n')
  fs.writeFileSync(path.join(projectDir, 'other.jsonl'), OTHER_MODEL_LINES.join('\n') + '\n')
  const denyFile = path.join(projectDir, 'deny.jsonl')
  fs.writeFileSync(denyFile, DENY_LINES.join('\n') + '\n')
  const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS)
  fs.utimesSync(denyFile, tenDaysAgo, tenDaysAgo)
})

afterEach(() => {
  fs.rmSync(corpusDir, { recursive: true, force: true })
})

describe('session-audit tool-error census', () => {
  it('counts calls and errors per tool and per model, naming expected failures by reason', async () => {
    const { toolErrors } = await auditSessionCorpus({ dir: corpusDir })
    // HAND-DERIVED from the fixture lines above: Read 3 calls all missing files; Glob 3 calls, 2 hook denies; Bash 1 failing ls; Grep 2 clean; the MCP call 1 unclassified.
    expect(toolErrors.byTool.map((r) => [r.name, r.calls, r.errors, r.unknown, r.expected])).toEqual([
      ['Read', 3, 3, 0, { path_not_found: 3 }],
      ['Glob', 3, 2, 0, { tg_deny: 2 }],
      ['Bash', 1, 1, 0, { path_not_found: 1 }],
      ['mcp__claude-in-chrome__browser_batch', 1, 1, 1, {}],
      ['Grep', 2, 0, 0, {}],
    ])
    expect(toolErrors.byModel.map((r) => [r.name, r.calls, r.errors, r.unknown, r.expected])).toEqual([
      ['claude-haiku-4-5-20251001', 9, 6, 0, { path_not_found: 4, tg_deny: 2 }],
      ['claude-opus-5', 1, 1, 1, {}],
    ])
    expect(toolErrors.unknownPrefixes).toEqual([{ tool: 'mcp__claude-in-chrome__browser_batch', prefix: 'No tab available', count: 1 }])
  })

  it('--window-days keeps only transcripts modified inside the window', async () => {
    const all = await auditSessionCorpus({ dir: corpusDir, windowDays: 0 })
    const recent = await auditSessionCorpus({ dir: corpusDir, windowDays: 7 })
    expect(all.filesScanned).toBe(3)
    expect(recent.filesScanned).toBe(2)
    expect(recent.windowDays).toBe(7)
    // The deny session is ten days old, so its two Glob denies and two Read failures drop out.
    expect(recent.toolErrors.byTool.find((r) => r.name === 'Glob')).toMatchObject({ calls: 1, errors: 0 })
    expect(recent.toolErrors.byTool.find((r) => r.name === 'Read')).toMatchObject({ calls: 1, errors: 1 })
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS)
    for (const name of ['run.jsonl', 'other.jsonl']) fs.utimesSync(path.join(corpusDir, 'proj', name), tenDaysAgo, tenDaysAgo)
    await expect(auditSessionCorpus({ dir: corpusDir, windowDays: 7 })).rejects.toThrow(/modified in the last 7 days/)
  })

  it('renders a compact report that is byte-identical across runs and carries no runtime or corpus path', async () => {
    const first = await auditSessionCorpus({ dir: corpusDir })
    const second = await auditSessionCorpus({ dir: corpusDir })
    const text = formatToolErrorCensus(first.toolErrors, first)
    expect(formatToolErrorCensus(second.toolErrors, second)).toBe(text)
    expect(text).not.toContain(corpusDir)
    expect(text.split('\n')[0]).toBe('# Tool errors (3 transcripts, all time)')
    expect(text).toMatch(/^Read +3 +3 +100\.0% +0 {2}path_not_found 3$/m)
    expect(text).toMatch(/^Glob +3 +2 +66\.7% +0 {2}tg_deny 2$/m)
    expect(text).toMatch(/^claude-haiku-4-5-20251001 +9 +6 +66\.7% +0 {2}path_not_found 4, tg_deny 2$/m)
    // A row with no expected reason ends at its unknown count, with no trailing blanks.
    expect(text).toMatch(/^mcp__claude-in-chrome__browser_batch +1 +1 +100\.0% +1$/m)
    // That name is longer than the column once was: every row's calls figure still ends under the header's.
    const byTool = text.split('## By tool\n')[1]!.split('\n\n')[0]!.split('\n').filter((l) => !l.startsWith('('))
    const callsEnd = (line: string): number => /^\S+ +\S+/.exec(line)![0].length
    expect(new Set(byTool.map(callsEnd))).toEqual(new Set([callsEnd(byTool[0]!)]))
    expect(text).toContain('(1 more ran without an error)')
    expect(text).toMatch(/^ +1 {2}mcp__claude-in-chrome__browser_batch No tab available$/m)
  })
})
