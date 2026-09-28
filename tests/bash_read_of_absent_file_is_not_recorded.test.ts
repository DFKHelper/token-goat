// A read-shaped Bash command whose file is not there shows the model nothing, yet the Bash hooks put it on the session's record as read: the post hook took the command's shape for proof and recorded `cat x.ts | head -n 40` as lines 1..40 read, and the pre hook records a `sed`/`awk` range before the command runs. Once the file appears by some route other than the Edit and Write tools, which clear its record (a checkout, a build, a copy), a later read of those lines is told they were already served. Claude Code sends a non-zero Bash exit to PostToolUseFailure, never to PostToolUse (CAPTURE on 2.1.281, recorded in src/hooks_tool_failure.ts), and its PostToolUse carries no exit code, so the shapes that reach the post hook there with the file absent are pipelines, whose status is their last command's (HAND-DERIVED from bash's pipeline semantics: `cat absent | head -n 40` exits 0 because head does); the Bash tool_response `{ stdout, stderr, interrupted, isImage, noOutputExpected }` is the CAPTURE shape tests/hooks_real_harness_payload_shape.test.ts records from real harness traffic, and the stderr line is coreutils cat's own message. pi forwards every tool result, failed ones included, as `tool_response: { output }` with no status field (FORMAT-DERIVED from the tool_result handler in src/bridges/pi.ts), so there each bare read shape arrives failed. Commands and layout are HAND-DERIVED from each tool's documented syntax (coreutils head -n / tail -n / cat, PowerShell Get-Content -TotalCount / -Tail and Select-Object -First, `wsl bash -c "cat /mnt/<drive>/..."`, sed -n 'A,Bp').

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
import { getFileLineRanges, wasFileReadThisSession, wasFileTruncatedThisSession } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

const LINES = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i} * 2`)
const BODY = LINES.join('\n')
const ALREADY_READ = /already read lines/i

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-absent-read-')))
  dirs.push(root)
  return root
}

function newSession(): string {
  return `s-absent-read-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, handle and save per hook call, as relay.ts runs it, so a record has to survive the store's merge rather than only this process's memory. */
async function asHook<T>(sid: string, handle: () => T | Promise<T>): Promise<T> {
  loadSessionState(sid)
  try {
    return await handle()
  } finally {
    saveSessionState(sid)
  }
}

function bashEvent(sid: string, cwd: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', response: Record<string, unknown> = {}): HookEvent {
  const raw: Record<string, unknown> = { cwd, tool_name: 'Bash', tool_input: { command } }
  if (eventName === 'post_tool_use') raw['tool_response'] = response
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
}

/** Claude Code's PostToolUse envelope for a call that exited 0. */
function claudeCode(stdout: string, stderr = ''): Record<string, unknown> {
  return { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false }
}

/** pi's envelope, which a failed call reaches too. */
function pi(output: string): Record<string, unknown> {
  return { output }
}

async function runBash(sid: string, cwd: string, command: string, response: Record<string, unknown>): Promise<void> {
  await asHook(sid, () => preBashHandler(bashEvent(sid, cwd, command, 'pre_tool_use')))
  await asHook(sid, () => postBashHandler(bashEvent(sid, cwd, command, 'post_tool_use', response)))
}

function readEvent(sid: string, cwd: string, filePath: string): HookEvent {
  return { eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: filePath }, sessionId: sid, agentId: undefined, raw: { cwd } }
}

/** A whole Read of a new file, delivered in the Read envelope tests/code_fold.test.ts's rangedEvent documents from real Read results. */
async function readWhole(sid: string, cwd: string, name: string): Promise<void> {
  const filePath = normalizePath(path.join(cwd, name))
  fs.writeFileSync(filePath, BODY)
  await asHook(sid, () => preReadHandler(readEvent(sid, cwd, filePath)))
  const tool_response = { type: 'text', file: { filePath, content: BODY, numLines: LINES.length, startLine: 1, totalLines: LINES.length } }
  await asHook(sid, () => postReadHandler({ eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath }, sessionId: sid, agentId: undefined, raw: { cwd, tool_response } }))
}

function text(out: HookOutput): string {
  if (out.hookType === 'deny') return out.message
  if (out.hookType === 'context') return out.context
  return ''
}

describe('a Bash read of a file that is not there is never put on record', () => {
  it('Claude Code, `cat x.ts | head -n 40`: once x.ts appears, a head of it is not told those lines were served', async () => {
    clearModuleCaches()
    const root = project()
    const sid = newSession()
    const file = resolveIndexPath('x.ts', root)
    await runBash(sid, root, 'cat x.ts | head -n 40', claudeCode('', 'cat: x.ts: No such file or directory'))
    loadSessionState(sid)
    expect(getFileLineRanges(file)).toEqual([])

    fs.writeFileSync(path.join(root, 'x.ts'), BODY)
    const later = await asHook(sid, () => preBashHandler(bashEvent(sid, root, 'head -n 40 x.ts', 'pre_tool_use')))
    expect(text(later)).not.toMatch(ALREADY_READ)
  })

  it('control: with x.ts there, the same pipeline is on record and the later head is told so', async () => {
    clearModuleCaches()
    const root = project()
    const sid = newSession()
    fs.writeFileSync(path.join(root, 'x.ts'), BODY)
    await runBash(sid, root, 'cat x.ts | head -n 40', claudeCode(LINES.slice(0, 40).join('\n')))
    loadSessionState(sid)
    expect(getFileLineRanges(resolveIndexPath('x.ts', root))).toEqual([[1, 40]])

    const later = await asHook(sid, () => preBashHandler(bashEvent(sid, root, 'head -n 40 x.ts', 'pre_tool_use')))
    expect(text(later)).toMatch(ALREADY_READ)
  })

  it('Claude Code, `cat x.ts | tail -n 20`: once x.ts appears, a Read of it is not refused as a truncated earlier read', async () => {
    clearModuleCaches()
    const root = project()
    const sid = newSession()
    const file = resolveIndexPath('x.ts', root)
    await runBash(sid, root, 'cat x.ts | tail -n 20', claudeCode('', 'cat: x.ts: No such file or directory'))
    loadSessionState(sid)
    expect(wasFileReadThisSession(file)).toBe(false)
    expect(wasFileTruncatedThisSession(file)).toBe(false)

    // Five Reads of other files take x.ts out of the window of recent reads the Read hook never refuses (`hints.protect_recent_reads`, 4 by default), as any working session does.
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) await readWhole(sid, root, name)
    fs.writeFileSync(path.join(root, 'x.ts'), BODY)
    const out = await asHook(sid, () => preReadHandler(readEvent(sid, root, file)))
    expect(out.hookType === 'deny' ? out.message : '').toBe('')
  })

  it.each([
    ['head', 'head -n 40 x.ts', 'range'],
    ['Get-Content -TotalCount', 'Get-Content x.ts -TotalCount 40', 'range'],
    ['Get-Content | Select-Object -First', 'Get-Content x.ts | Select-Object -First 40', 'range'],
    ['cat', 'cat x.ts', 'full'],
    ['Get-Content', 'Get-Content x.ts', 'full'],
    ['tail', 'tail -n 20 x.ts', 'truncated'],
    ['Get-Content -Tail', 'Get-Content x.ts -Tail 20', 'truncated'],
  ] as const)('pi, a failed %s: nothing is on record, and with the file there the same command is', async (_shape, command, kind) => {
    clearModuleCaches()
    const root = project()
    const file = resolveIndexPath('x.ts', root)
    const absent = newSession()
    await runBash(absent, root, command, pi('x.ts: No such file or directory'))
    loadSessionState(absent)
    expect(getFileLineRanges(file)).toEqual([])
    expect(wasFileReadThisSession(file)).toBe(false)

    fs.writeFileSync(path.join(root, 'x.ts'), BODY)
    const present = newSession()
    await runBash(present, root, command, pi(BODY))
    loadSessionState(present)
    if (kind === 'range') expect(getFileLineRanges(file)).toEqual([[1, 40]])
    if (kind === 'full') expect(wasFileReadThisSession(file)).toBe(true)
    if (kind === 'truncated') expect(wasFileTruncatedThisSession(file)).toBe(true)
  })

  it('pi, `cat x.ts y.ts` with only y.ts there: y.ts is on record and x.ts is not', async () => {
    clearModuleCaches()
    const root = project()
    const sid = newSession()
    fs.writeFileSync(path.join(root, 'y.ts'), BODY)
    await runBash(sid, root, 'cat x.ts y.ts', pi('cat: x.ts: No such file or directory\n' + BODY))
    loadSessionState(sid)
    expect(wasFileReadThisSession(resolveIndexPath('x.ts', root))).toBe(false)
    expect(wasFileReadThisSession(resolveIndexPath('y.ts', root))).toBe(true)
  })

  it('pi, a failed `wsl bash -c "cat /mnt/<drive>/..."`: nothing is on record for the drive path it names', async () => {
    clearModuleCaches()
    const root = project()
    const sid = newSession()
    await runBash(sid, root, 'wsl bash -c "cat /mnt/z/tg-absent-read/nope.ts"', pi('cat: /mnt/z/tg-absent-read/nope.ts: No such file or directory'))
    loadSessionState(sid)
    expect(wasFileReadThisSession(resolveIndexPath('Z:/tg-absent-read/nope.ts', root))).toBe(false)
  })

  it("a `sed -n '1,40p'` of an absent x.ts, which Claude Code reports to PostToolUseFailure alone, leaves no range for a later sed of x.ts to be told about", async () => {
    clearModuleCaches()
    const root = project()
    const sid = newSession()
    const command = "sed -n '1,40p' x.ts"
    // Only the pre hook runs: the failed call never reaches PostToolUse.
    await asHook(sid, () => preBashHandler(bashEvent(sid, root, command, 'pre_tool_use')))
    loadSessionState(sid)
    expect(getFileLineRanges(resolveIndexPath('x.ts', root))).toEqual([])

    fs.writeFileSync(path.join(root, 'x.ts'), BODY)
    const later = await asHook(sid, () => preBashHandler(bashEvent(sid, root, command, 'pre_tool_use')))
    expect(text(later)).not.toMatch(ALREADY_READ)
    // Control: that sed ran against a file that is there, so a third one overlaps it.
    const third = await asHook(sid, () => preBashHandler(bashEvent(sid, root, command, 'pre_tool_use')))
    expect(text(third)).toMatch(ALREADY_READ)
  })
})
