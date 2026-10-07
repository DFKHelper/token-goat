// The Bash hooks name the file a note is about in their own sentence, and they spliced the path in raw: a file whose name holds a backtick opened an inline-code span in the prose that paired with the fence of the command beside it, so the rest of the line read as code and the command as prose. The sentence now names the path through fileSubject, which quotes it the way the suggested command does and says "this file" when no quote mark can hold it outside a code span.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

// HAND-DERIVED: a module whose `foo` the surgical read names; the backtick file name is the case under test, and every shell accepts it in single quotes.
const LINES = Array.from({ length: 80 }, (_, i) => (i === 0 ? 'export function foo(): number { return 1 }' : `export const value${i} = ${i} * 2`))
const READ_NOTE = 'was already fully read via the Read tool'
const DOWNLOAD_NOTE = 'was already downloaded earlier this session.'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prose-name-')))
  dirs.push(root)
  return root
}

function newSession(): string {
  return `s-prose-name-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, handle and save per hook call, as relay.ts runs it. */
async function asHook<T>(sid: string, handle: () => T | Promise<T>): Promise<T> {
  loadSessionState(sid)
  try {
    return await handle()
  } finally {
    saveSessionState(sid)
  }
}

// CAPTURE: the envelope and the Bash tool_response keys { stdout, stderr, interrupted, isImage, noOutputExpected } are Claude Code's, recorded off real traffic in tests/hooks_real_harness_payload_shape.test.ts.
function bashEvent(sid: string, cwd: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', stdout = ''): HookEvent {
  const raw: Record<string, unknown> = { cwd, tool_name: 'Bash', tool_input: { command } }
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
}

// CAPTURE: a ranged Read's tool_response { type: 'text', file: { filePath, content, numLines, startLine, totalLines } }, the envelope tests/code_fold.test.ts's `rangedEvent` documents from 798 ranged Read results in real Claude Code transcripts.
async function partialRead(sid: string, filePath: string): Promise<void> {
  const window = LINES.slice(49, 64)
  await asHook(sid, () => preReadHandler({ eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset: 50, limit: 15 }, sessionId: sid, agentId: undefined, raw: {} }))
  await asHook(sid, () => postReadHandler({ eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset: 50, limit: 15 }, sessionId: sid, agentId: undefined, raw: { tool_response: { type: 'text', file: { filePath, content: window.join('\n'), numLines: window.length, startLine: 50, totalLines: LINES.length } } } }))
}

function text(out: HookOutput): string {
  if (out.hookType === 'deny') return out.message
  if (out.hookType === 'context') return out.context
  return ''
}

/** The text outside every backtick span: what reads as prose. */
function prose(s: string): string {
  return s.replace(/`[^`\n]*`/g, '')
}

describe('a Bash hook names a file in its own sentence the way its commands quote it', () => {
  it('a token-goat read of a file already read through the Read tool names a plain path quoted', async () => {
    clearModuleCaches()
    const root = tempRoot()
    const file = `${root}/plain.ts`
    fs.writeFileSync(file, LINES.join('\n'))
    const sid = newSession()
    await partialRead(sid, file)
    const hint = text(await asHook(sid, () => preBashHandler(bashEvent(sid, root, 'token-goat read plain.ts::foo', 'pre_tool_use'))))
    expect(hint).toContain(`"${file}" ${READ_NOTE}`)
  })

  it('and calls a path holding a backtick "this file", keeping it out of the prose', async () => {
    clearModuleCaches()
    const root = tempRoot()
    const file = `${root}/a\`b.ts`
    fs.writeFileSync(file, LINES.join('\n'))
    const sid = newSession()
    await partialRead(sid, file)
    const hint = text(await asHook(sid, () => preBashHandler(bashEvent(sid, root, "token-goat read 'a`b.ts::foo'", 'pre_tool_use'))))
    expect(hint).toContain(`This file ${READ_NOTE}`)
    expect(prose(hint)).not.toContain('a`b.ts')
    expect(hint).not.toContain(`${root}/a`)
  })

  it('a repeated curl download names a path holding a backtick "this file"', async () => {
    clearModuleCaches()
    const root = tempRoot()
    fs.writeFileSync(`${root}/d\`l.json`, JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` })) }))
    const command = "curl -sS -o 'd`l.json' https://example.invalid/data.json"
    const sid = newSession()
    await asHook(sid, () => postBashHandler(bashEvent(sid, root, command, 'post_tool_use')))
    const again = text(await asHook(sid, () => preBashHandler(bashEvent(sid, root, command, 'pre_tool_use'))))
    expect(again).toContain(`This file ${DOWNLOAD_NOTE}`)
  })
})
