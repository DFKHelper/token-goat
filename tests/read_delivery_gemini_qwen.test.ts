// Gemini CLI and Qwen Code hand the Read post-hook the file's own text as `llmContent`, unnumbered, with a status header ahead of it whenever the read is partial. The hook parsed that text as a Claude `cat -n` rendering, so a file line shaped like a numbered row (`     2\tlooks numbered`) was taken for the numbering and the header for harness chatter, a read that stopped at the 2000-line cap was booked as a whole-file read, and Qwen's 0-based `offset` was booked one line early. Fixtures: CAPTURE. The payloads are the AfterTool stdin gemini-cli-core 0.62.0 and the PostToolUse request qwen-code 0.24.7 build for `read_file`, recorded by running each package's own ReadFileTool against small.txt and big.txt below (small, ranged `start_line: 2, end_line: 3` / `offset: 1, limit: 2`, and a whole read of the 2100-line file). The user path is replaced with a temp directory; the Qwen request carries no session id or cwd, so one is added, as the hook runner does. The Grok case is HAND-DERIVED: no Grok read_file result could be captured (its CLI needs an interactive login), so it only pins that a numbered delivery is stripped and a raw one is not.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { normalizePayload } from '../src/hooks_cli.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { isTruncatedReadDelivery, parseReadDelivery, readRequestedSliceWindow, readStartLine } from '../src/hooks_read_slice.js'
import { normalizePath } from '../src/paths.js'
import { buildEvent } from '../src/relay.js'
import { clearModuleCaches } from '../src/reset.js'
import { wasFileReadThisSession, wasFileTruncatedThisSession } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS } from '../src/hooks_common.js'

const SMALL = 'alpha\n     2\tlooks numbered\nfunction f() {\n  return 1\n}\n'
const BIG = Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
const BIG_SHOWN = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n')

const GEMINI_RANGED =
  "\nIMPORTANT: The file content has been truncated.\nStatus: Showing lines 2-3 of 6 total lines.\nAction: To read more of the file, you can use the 'start_line' and 'end_line' parameters in a subsequent 'read_file' call. For example, to read the next section of the file, use start_line: 4.\n\n--- FILE CONTENT (truncated) ---\n     2\tlooks numbered\nfunction f() {"
const GEMINI_BIG =
  "\nIMPORTANT: The file content has been truncated.\nStatus: Showing lines 1-2000 of 2101 total lines.\nAction: To read more of the file, you can use the 'start_line' and 'end_line' parameters in a subsequent 'read_file' call. For example, to read the next section of the file, use start_line: 2001.\n\n--- FILE CONTENT (truncated) ---\n" +
  BIG_SHOWN
const QWEN_RANGED = 'Showing lines 2-3 of 6 total lines.\n\n---\n\n     2\tlooks numbered\nfunction f() {'
const QWEN_BIG = 'Showing lines 1-2000 of 2101 total lines.\n\n---\n\n' + BIG_SHOWN

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function workspace(): string {
  const ws = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-be18-')))
  dirs.push(ws)
  fs.writeFileSync(path.join(ws, 'small.txt'), SMALL)
  fs.writeFileSync(path.join(ws, 'big.txt'), BIG)
  return ws
}

type Case = 'small' | 'ranged' | 'big'

function geminiPayload(ws: string, sid: string, which: Case): Record<string, unknown> {
  const tool_input = which === 'small' ? { file_path: 'small.txt' } : which === 'ranged' ? { file_path: 'small.txt', start_line: 2, end_line: 3 } : { file_path: 'big.txt' }
  const llmContent = which === 'small' ? SMALL : which === 'ranged' ? GEMINI_RANGED : GEMINI_BIG
  const returnDisplay = which === 'small' ? '' : which === 'ranged' ? 'Read lines 2-3 of 6 from small.txt' : 'Read lines 1-2000 of 2101 from big.txt'
  return { session_id: sid, transcript_path: '', cwd: ws, hook_event_name: 'AfterTool', timestamp: '2026-09-30T14:10:56.968Z', tool_name: 'read_file', tool_input, tool_response: { llmContent, returnDisplay } }
}

function qwenPayload(ws: string, sid: string, which: Case): Record<string, unknown> {
  const file = `${ws}/${which === 'big' ? 'big' : 'small'}.txt`
  const tool_input = which === 'ranged' ? { file_path: file, offset: 1, limit: 2 } : { file_path: file }
  const llmContent = which === 'small' ? SMALL : which === 'ranged' ? QWEN_RANGED : QWEN_BIG
  const returnDisplay = which === 'small' ? '' : which === 'ranged' ? 'Read lines 2-3 of 6 from small.txt' : 'Read lines 1-2000 of 2101 from big.txt'
  return { session_id: sid, cwd: ws, permission_mode: 'default', tool_name: 'read_file', tool_input, tool_response: { llmContent, returnDisplay }, tool_use_id: 'tu-1', tool_call_id: 'call-1', duration_ms: 5 }
}

function postEvent(harness: 'gemini' | 'qwen', ws: string, sid: string, which: Case): HookEvent {
  const payload = harness === 'gemini' ? geminiPayload(ws, sid, which) : qwenPayload(ws, sid, which)
  return buildEvent('post_tool_use', normalizePayload(payload, harness))
}

function delivered(event: HookEvent): string {
  return extractToolResponseField(event.raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
}

function newSession(): string {
  return `s-be18-${process.pid}-${Math.random().toString(36).slice(2)}`
}

describe.each(['gemini', 'qwen'] as const)('%s read_file delivery', (harness) => {
  it('a whole small read is the file text, line 2 included as written, and not truncated', () => {
    const ws = workspace()
    const event = postEvent(harness, ws, newSession(), 'small')
    const text = delivered(event)
    expect(text).toBe(SMALL)
    const parsed = parseReadDelivery(event, text)
    expect(parsed?.header).toEqual([])
    expect(parsed?.rows.map((r) => [r.no, r.text])).toEqual([
      [1, 'alpha'],
      [2, '     2\tlooks numbered'],
      [3, 'function f() {'],
      [4, '  return 1'],
      [5, '}'],
      [6, ''],
    ])
    expect(readStartLine(event)).toBe(1)
    expect(isTruncatedReadDelivery(event, text)).toBe(false)
  })

  it('a ranged read starts on the line asked for, keeps its status header, and is not truncated', () => {
    const ws = workspace()
    const event = postEvent(harness, ws, newSession(), 'ranged')
    const text = delivered(event)
    expect(readRequestedSliceWindow(event)).toEqual({ offset: 2, limit: 2, isExplicitSlice: true })
    expect(readStartLine(event)).toBe(2)
    const parsed = parseReadDelivery(event, text)
    expect(parsed?.rows.map((r) => [r.no, r.text])).toEqual([
      [2, '     2\tlooks numbered'],
      [3, 'function f() {'],
    ])
    expect([...(parsed?.header ?? []), ...(parsed?.rows ?? []).map((r) => r.raw), ...(parsed?.trailer ?? [])].join('\n')).toBe(text)
    expect(parsed?.header.some((l) => l.includes('Showing lines 2-3 of 6 total lines.'))).toBe(true)
    expect(isTruncatedReadDelivery(event, text)).toBe(false)
  })

  it('a whole read cut at the 2000-line cap is truncated, its rows numbered from 1', () => {
    const ws = workspace()
    const event = postEvent(harness, ws, newSession(), 'big')
    const text = delivered(event)
    expect(isTruncatedReadDelivery(event, text)).toBe(true)
    const parsed = parseReadDelivery(event, text)
    expect(parsed?.rows.length).toBe(2000)
    expect(parsed?.rows[0]).toMatchObject({ no: 1, text: 'line 1' })
    expect(parsed?.rows[1999]).toMatchObject({ no: 2000, text: 'line 2000' })
  })

  it('the post hook books the capped read as truncated and the whole or ranged read of the small file as not', () => {
    clearModuleCaches()
    const ws = workspace()
    const sid = newSession()
    for (const which of ['big', 'ranged', 'small'] as const) {
      // Absolute, so the session key does not depend on how a relative path is resolved; the relative form is the path-resolution fix's to cover.
      const event = postEvent(harness, ws, sid, which)
      const withAbs = buildEvent('post_tool_use', { ...event.raw, tool_input: { ...event.toolInput, file_path: `${ws}/${which === 'big' ? 'big' : 'small'}.txt` } })
      loadSessionState(sid)
      try {
        postReadHandler(withAbs)
      } finally {
        saveSessionState(sid)
      }
    }
    loadSessionState(sid)
    expect(wasFileTruncatedThisSession(`${ws}/big.txt`)).toBe(true)
    expect(wasFileTruncatedThisSession(`${ws}/small.txt`)).toBe(false)
  })
})

describe('gemini read_file with a path relative to the workspace (CAPTURE)', () => {
  it('the pre and post hooks book the read under the absolute path, the key every other read of the file uses', () => {
    // The payloads are the captured AfterTool stdin as Gemini CLI sends it: tool_input.file_path is "small.txt" / "big.txt" and cwd is the workspace. Keyed as given, the session recorded the bare file name, so a later absolute read of the same file met no prior read and the cut-short big read was never booked as truncated.
    clearModuleCaches()
    const ws = workspace()
    const sid = newSession()
    // The pre hook is what records a read; its BeforeTool stdin is the captured payload before the tool ran, so it carries no tool_response.
    const { tool_response: _unused, ...before } = geminiPayload(ws, sid, 'small')
    const preEvent = buildEvent('pre_tool_use', normalizePayload({ ...before, hook_event_name: 'BeforeTool' }, 'gemini'))
    for (const run of [() => postReadHandler(postEvent('gemini', ws, sid, 'big')), () => preReadHandler(preEvent)]) {
      loadSessionState(sid)
      try {
        run()
      } finally {
        saveSessionState(sid)
      }
    }
    loadSessionState(sid)
    expect(wasFileTruncatedThisSession(`${ws}/big.txt`)).toBe(true)
    expect(wasFileReadThisSession(`${ws}/small.txt`)).toBe(true)
    expect(wasFileReadThisSession('small.txt')).toBe(false)
  })
})

describe('qwen and gemini truncation headers', () => {
  it('a Qwen `at least N` total, a later start, or a line cut with `... [truncated]` marks the read truncated', () => {
    const ws = workspace()
    const sid = newSession()
    const variants: [string, boolean][] = [
      ['Showing lines 2-3 of at least 6 total lines.\n\n---\n\n     2\tlooks numbered\nfunction f() {', true],
      ['Showing lines 3-3 of 6 total lines.\n\n---\n\nfunction f() {', true],
      ['Showing lines 2-2 of 6 total lines.\n\n---\n\n     2\tlooks numbered', true],
      ['Showing lines 2-3 of 6 total lines.\n\n---\n\n     2\tlooks... [truncated]\nfunction f() {', true],
      ['Showing lines 2-3 of 6 total lines.\n---\n     2\tlooks numbered\nfunction f() {', false],
    ]
    for (const [llmContent, truncated] of variants) {
      const payload = { ...qwenPayload(ws, sid, 'ranged'), tool_response: { llmContent, returnDisplay: '' } }
      const event = buildEvent('post_tool_use', normalizePayload(payload, 'qwen'))
      expect(isTruncatedReadDelivery(event, llmContent), llmContent).toBe(truncated)
    }
  })

  it('the body is numbered from the line the header names, and Qwen\'s two-line `---` header parses too (HAND-DERIVED)', () => {
    const ws = workspace()
    const sid = newSession()
    const llmContent = 'Showing lines 5-6 of 6 total lines.\n---\n}\n'
    const payload = { ...qwenPayload(ws, sid, 'small'), tool_response: { llmContent, returnDisplay: '' } }
    const event = buildEvent('post_tool_use', normalizePayload(payload, 'qwen'))
    expect(readStartLine(event)).toBe(5)
    const parsed = parseReadDelivery(event, llmContent)
    expect(parsed?.header).toEqual(['Showing lines 5-6 of 6 total lines.', '---'])
    expect(parsed?.rows.map((r) => [r.no, r.text])).toEqual([
      [5, '}'],
      [6, ''],
    ])
  })

  it('a Gemini ranged read that runs to the end of the file is whole, one that stops short is not', () => {
    const ws = workspace()
    const sid = newSession()
    const header = (a: number, b: number) => `\nIMPORTANT: The file content has been truncated.\nStatus: Showing lines ${a}-${b} of 6 total lines.\nAction: x\n\n--- FILE CONTENT (truncated) ---\n`
    const whole = { ...geminiPayload(ws, sid, 'ranged'), tool_input: { file_path: 'small.txt', start_line: 4 }, tool_response: { llmContent: header(4, 6) + '  return 1\n}\n', returnDisplay: '' } }
    const short = { ...geminiPayload(ws, sid, 'ranged'), tool_input: { file_path: 'small.txt', start_line: 4 }, tool_response: { llmContent: header(4, 5) + '  return 1\n}', returnDisplay: '' } }
    for (const [payload, truncated] of [[whole, false], [short, true]] as const) {
      const event = buildEvent('post_tool_use', normalizePayload(payload, 'gemini'))
      expect(isTruncatedReadDelivery(event, delivered(event))).toBe(truncated)
    }
  })
})

describe('grok read_file delivery (HAND-DERIVED)', () => {
  function grokEvent(content: string, toolInput: Record<string, unknown> = { target_file: 'small.txt' }): HookEvent {
    const ws = workspace()
    return buildEvent('post_tool_use', normalizePayload({ sessionId: newSession(), cwd: ws, hookEventName: 'PostToolUse', toolName: 'read_file', toolInput, toolResult: { FileContent: content } }, 'grok'))
  }

  it('a delivery numbered on every line from the first is stripped to the file text', () => {
    const event = grokEvent('     1\talpha\n     2\t     2\tlooks numbered\n     3\tfunction f() {\n')
    const parsed = parseReadDelivery(event, delivered(event))
    expect(parsed?.rows.map((r) => [r.no, r.text])).toEqual([
      [1, 'alpha'],
      [2, '     2\tlooks numbered'],
      [3, 'function f() {'],
    ])
  })

  it('numbering that skips a line is file text, not a rendering', () => {
    const event = grokEvent('     1\talpha\n     5\tbeta\n')
    const parsed = parseReadDelivery(event, delivered(event))
    expect(parsed?.rows.map((r) => [r.no, r.text])).toEqual([
      [1, '     1\talpha'],
      [2, '     5\tbeta'],
      [3, ''],
    ])
  })

  it('a raw delivery keeps a line that only looks numbered as file text', () => {
    const event = grokEvent(SMALL)
    const parsed = parseReadDelivery(event, delivered(event))
    expect(parsed?.header).toEqual([])
    expect(parsed?.rows[1]).toMatchObject({ no: 2, text: '     2\tlooks numbered' })
    expect(parsed?.rows[0]).toMatchObject({ no: 1, text: 'alpha' })
  })
})
