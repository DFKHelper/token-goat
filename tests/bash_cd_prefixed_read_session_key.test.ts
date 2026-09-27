// A read-shaped Bash command behind a `cd DIR &&` prefix shows the model a file in DIR, and the post-Bash hook records that read in the session cache so later reads can be deduplicated against it. The record was keyed on the hook's own cwd, not the directory the cd left the shell in, so `cd sub && head -n 40 x.ts` put lines 1..40 on record against ./x.ts: a later Read of ./x.ts was refused as lines already read although the model had only seen sub/x.ts, and the file it had seen never gained the record. A `curl -o` download behind the same prefix was recorded at the same wrong path, so a later download of that URL was refused as already saved to a file holding something else. Layout and commands are HAND-DERIVED: two same-named files one directory apart, and the head/cat/tail/Get-Content spellings the post hook records, each taken from its tool's own documented syntax (coreutils head -n / tail -n / cat, PowerShell Get-Content -TotalCount / -Tail and Select-Object -First, curl -o). The Bash tool_response `{ stdout, stderr, interrupted, isImage, noOutputExpected }` is the CAPTURE shape tests/hooks_real_harness_payload_shape.test.ts records from real harness traffic, and the ranged Read envelope is the CAPTURE shape tests/code_fold.test.ts's rangedEvent documents from 798 real ranged Read results.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { getCurlDownloadPath, getFileLineRanges, wasFileFullyReadThisSession, wasFileReadThisSession, wasFileTruncatedThisSession } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'

const LINES = Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i} * 2`)
const BODY = LINES.join('\n')

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A root holding x.ts and y.ts, and a `sub` directory holding its own x.ts and y.ts: the file a cd-prefixed command shows and the same-named file in the hook's cwd that the old key named instead. */
function layout(): { root: string; sub: string } {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cd-read-key-')))
  dirs.push(root)
  const sub = normalizePath(path.join(root, 'sub'))
  fs.mkdirSync(sub)
  for (const dir of [root, sub]) for (const name of ['x.ts', 'y.ts']) fs.writeFileSync(path.join(dir, name), BODY)
  return { root, sub }
}

function newSession(): string {
  return `s-cd-read-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, handle and save per hook call, as relay.ts runs it, so what the post hook records has to survive the store's merge rather than only this process's memory. */
async function asHook<T>(sid: string, handle: () => T | Promise<T>): Promise<T> {
  loadSessionState(sid)
  try {
    return await handle()
  } finally {
    saveSessionState(sid)
  }
}

function bashEvent(sid: string, cwd: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', stdout = '', toolUseId?: string, response: Record<string, unknown> = {}): HookEvent {
  const raw: Record<string, unknown> = { cwd, tool_name: 'Bash', tool_input: { command }, ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}) }
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...response }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
}

function readEvent(sid: string, filePath: string, offset: number, limit: number): HookEvent {
  return { eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset, limit }, sessionId: sid, agentId: undefined, raw: {} }
}

function rangedPostEvent(sid: string, filePath: string, offset: number, limit: number): HookEvent {
  const window = LINES.slice(offset - 1, offset - 1 + limit)
  return { eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath, offset, limit }, sessionId: sid, agentId: undefined, raw: { tool_response: { type: 'text', file: { filePath, content: window.join('\n'), numLines: window.length, startLine: offset, totalLines: LINES.length } } } }
}

async function partialRead(sid: string, filePath: string): Promise<void> {
  expect((await asHook(sid, () => preReadHandler(readEvent(sid, filePath, 50, 15)))).hookType).not.toBe('deny')
  await asHook(sid, () => postReadHandler(rangedPostEvent(sid, filePath, 50, 15)))
}

async function runBash(sid: string, cwd: string, command: string, stdout: string): Promise<void> {
  await asHook(sid, () => preBashHandler(bashEvent(sid, cwd, command, 'pre_tool_use')))
  await asHook(sid, () => postBashHandler(bashEvent(sid, cwd, command, 'post_tool_use', stdout)))
}

/** One call on Claude Code's main thread, where a `cd` runs in the harness's own shell and moves it: both hooks carry the call's tool_use_id, the pre hook reports the directory the call started in, and the post hook the one the cd left the shell in. CAPTURE: under Claude Code 2.1.281, a main-thread `cd sub && pwd` run from the project reported the project to the pre hook and `sub` to the post hook, under one tool_use_id. runBash above is the subagent shape, whose shell starts every call where the session did, so both of its hooks report that directory. */
async function runMainThreadBash(sid: string, start: string, landed: string, command: string, stdout: string, response: Record<string, unknown> = {}): Promise<void> {
  const toolUseId = `toolu_${Math.random().toString(36).slice(2)}`
  await asHook(sid, () => preBashHandler(bashEvent(sid, start, command, 'pre_tool_use', '', toolUseId)))
  await asHook(sid, () => postBashHandler(bashEvent(sid, landed, command, 'post_tool_use', stdout, toolUseId, response)))
}

describe('a cd-prefixed Bash read is recorded against the file the cd landed on', () => {
  it('head: a Read of the same-named file in the hook cwd is not refused, and the file that was shown is', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    const rootFile = normalizePath(path.join(root, 'x.ts'))
    const subFile = normalizePath(path.join(sub, 'x.ts'))
    // A partial Read of each puts both files on record as read, which is what arms the Read hook's range re-read deny.
    await partialRead(sid, rootFile)
    await partialRead(sid, subFile)

    await runBash(sid, root, 'cd sub && head -n 40 x.ts', LINES.slice(0, 40).join('\n'))

    const rootRead = await asHook(sid, () => preReadHandler(readEvent(sid, rootFile, 1, 40)))
    expect(rootRead.hookType === 'deny' ? rootRead.message : '').toBe('')
    // Positive control: lines 1..40 of sub/x.ts were shown, so a Read of exactly them is still the re-read the Read hook refuses, and a fix that answered the assertion above by forgetting the head read would fail here. Which record carries it is pinned per shape below.
    const subRead = await asHook(sid, () => preReadHandler(readEvent(sid, subFile, 1, 40)))
    expect(subRead.hookType).toBe('deny')
  })

  it.each([
    ['head', 'cd sub && head -n 40 x.ts', 'range'],
    ['head, subshell group', '( cd sub && head -n 40 x.ts )', 'range'],
    ['Get-Content -TotalCount', 'cd sub; Get-Content x.ts -TotalCount 40', 'range'],
    ['Get-Content | Select-Object -First', 'cd sub; Get-Content x.ts | Select-Object -First 40', 'range'],
    ['cat', 'cd sub && cat x.ts', 'full'],
    ['cat, two files', 'cd sub && cat x.ts y.ts', 'full'],
    ['tail', 'cd sub && tail -n 20 x.ts', 'truncated'],
    ['Get-Content -Tail', 'cd sub; Get-Content x.ts -Tail 20', 'truncated'],
  ] as const)('%s: the record lands on sub/, never on the cwd file of the same name', async (_shape, command, kind) => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    await runBash(sid, root, command, BODY)

    loadSessionState(sid)
    const names = command.includes('y.ts') ? ['x.ts', 'y.ts'] : ['x.ts']
    for (const name of names) {
      const shown = resolveIndexPath(name, sub)
      const other = resolveIndexPath(name, root)
      if (kind === 'range') expect(getFileLineRanges(shown)).toEqual([[1, 40]])
      if (kind === 'full') expect(wasFileFullyReadThisSession(shown)).toBe(true)
      if (kind === 'truncated') expect(wasFileTruncatedThisSession(shown)).toBe(true)
      expect(getFileLineRanges(other)).toEqual([])
      expect(wasFileReadThisSession(other)).toBe(false)
      expect(wasFileTruncatedThisSession(other)).toBe(false)
    }
  })

  it('curl -o: the download is recorded where it landed, not at the same-named file in the hook cwd', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    const url = 'https://example.com/data.json'
    // The download landed in sub/, and root/ holds an unrelated file of the same name, which is the only case where the old key recorded anything.
    for (const dir of [root, sub]) fs.writeFileSync(path.join(dir, 'data.json'), '{"a":1}')
    await runBash(sid, root, `cd sub && curl -o data.json ${url}`, '')

    loadSessionState(sid)
    expect(getCurlDownloadPath(url)).toBe(resolveIndexPath('data.json', sub))
  })
})

// The post hook resolves a cd prefix from the directory the call started in, which the pre hook holds for it under the call's id. Resolved from the post hook's own cwd instead, the main thread's cd applied twice and every record below named a file in sub/sub/.
describe('on the main thread, whose post hook reports the directory the cd moved the shell to', () => {
  it('head: the range lands on sub/x.ts', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    await runMainThreadBash(sid, root, sub, 'cd sub && head -n 40 x.ts', LINES.slice(0, 40).join('\n'))

    loadSessionState(sid)
    expect(getFileLineRanges(resolveIndexPath('x.ts', sub))).toEqual([[1, 40]])
  })

  it('a persisted sed read takes back the range the pre hook recorded for sub/x.ts', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const command = "cd sub && sed -n '1,40p' x.ts"
    const shown = resolveIndexPath('x.ts', sub)
    const head = LINES.slice(0, 40).join('\n')
    // Control: delivered whole, the range the pre hook recorded stays, so the empty list below is the persisted result's doing.
    const inline = newSession()
    await runMainThreadBash(inline, root, sub, command, head)
    loadSessionState(inline)
    expect(getFileLineRanges(shown)).toEqual([[1, 40]])

    // The persisted-result fields as tests/bash_persisted_output_is_not_served.test.ts sends them: where the harness wrote the whole output, and its size.
    const sid = newSession()
    const persisted = path.join(root, 'persisted.txt')
    fs.writeFileSync(persisted, BODY)
    await runMainThreadBash(sid, root, sub, command, head, { persistedOutputPath: persisted, persistedOutputSize: Buffer.byteLength(BODY, 'utf-8') })
    loadSessionState(sid)
    expect(getFileLineRanges(shown)).toEqual([])
  })

  it('curl -o: the download is recorded at sub/data.json', async () => {
    clearModuleCaches()
    const { root, sub } = layout()
    const sid = newSession()
    const url = 'https://example.com/data.json'
    fs.writeFileSync(path.join(sub, 'data.json'), '{"a":1}')
    await runMainThreadBash(sid, root, sub, `cd sub && curl -o data.json ${url}`, '')

    loadSessionState(sid)
    expect(getCurlDownloadPath(url)).toBe(resolveIndexPath('data.json', sub))
  })
})
