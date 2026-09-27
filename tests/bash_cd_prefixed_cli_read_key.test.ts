// A `token-goat read|section` run through Bash behind a `cd DIR &&` prefix names a file in DIR, but both hooks resolved its path against the event's cwd: the post hook put `cd sub && token-goat read x.ts::foo` on record as a query of ./x.ts, so a later query of ./x.ts, a different file, was told it had already been run while a repeat naming sub/x.ts was not, and the pre hook checked the Read-tool ledger for ./x.ts instead of the file the command reads. Both call sites now resolve against the directory the cd lands in.

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

// HAND-DERIVED: a module whose `foo` the surgical read names, written to both x.ts files so only the directory tells them apart.
const LINES = Array.from({ length: 80 }, (_, i) => (i === 0 ? 'export function foo(): number { return 1 }' : `export const value${i} = ${i} * 2`))
const BODY = LINES.join('\n')
const REPEAT_NOTE = 'You already ran this exact `token-goat read` query'
const READ_NOTE = 'was already fully read via the Read tool'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A root holding x.ts and a `sub` directory holding its own x.ts: the file a cd-prefixed read names and the same-named file in the hook's cwd. */
function layout(): { root: string; sub: string } {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cd-cli-read-')))
  dirs.push(root)
  const sub = normalizePath(path.join(root, 'sub'))
  fs.mkdirSync(sub)
  for (const dir of [root, sub]) fs.writeFileSync(path.join(dir, 'x.ts'), BODY)
  return { root, sub }
}

function newSession(): string {
  return `s-cd-cli-read-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, handle and save per hook call, as relay.ts runs it, so what the post hook records has to survive the store's merge before the pre hook reads it. */
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
  expect((await asHook(sid, () => preReadHandler({ eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset: 50, limit: 15 }, sessionId: sid, agentId: undefined, raw: {} }))).hookType).not.toBe('deny')
  await asHook(sid, () => postReadHandler({ eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset: 50, limit: 15 }, sessionId: sid, agentId: undefined, raw: { tool_response: { type: 'text', file: { filePath, content: window.join('\n'), numLines: window.length, startLine: 50, totalLines: LINES.length } } } }))
}

function text(result: HookOutput): string {
  return result.hookType === 'context' ? result.context : ''
}

async function pre(sid: string, cwd: string, command: string): Promise<string> {
  return text(await asHook(sid, () => preBashHandler(bashEvent(sid, cwd, command, 'pre_tool_use'))))
}

describe('a cd-prefixed token-goat surgical read is keyed on the file the cd landed on', () => {
  it('post then pre: a repeat naming the same file is flagged, the same spelling from the hook cwd is not', async () => {
    clearModuleCaches()
    const { root } = layout()
    const sid = newSession()
    await asHook(sid, () => postBashHandler(bashEvent(sid, root, 'cd sub && token-goat read x.ts::foo', 'post_tool_use', LINES[0])))

    // ./x.ts is a different file from the sub/x.ts the recorded query read.
    expect(await pre(sid, root, 'token-goat read x.ts::foo')).not.toContain(REPEAT_NOTE)
    // Positive control: the same file under another spelling is the repeat, so a fix that stopped recording cd-prefixed queries fails here.
    expect(await pre(sid, root, 'token-goat read sub/x.ts::foo')).toContain(REPEAT_NOTE)
  })

  it('pre: the Read-tool cross-check looks at the file the cd landed on', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const readRoot = newSession()
    await partialRead(readRoot, normalizePath(path.join(root, 'x.ts')))
    expect(await pre(readRoot, root, 'cd sub && token-goat read x.ts::foo')).not.toContain(READ_NOTE)

    // Positive control: a Read of the file the command names is still reported.
    const readSub = newSession()
    const subFile = normalizePath(path.join(sub, 'x.ts'))
    await partialRead(readSub, subFile)
    const hint = await pre(readSub, root, 'cd sub && token-goat read x.ts::foo')
    expect(hint).toContain(READ_NOTE)
    expect(hint).toContain(subFile)
  })
})
