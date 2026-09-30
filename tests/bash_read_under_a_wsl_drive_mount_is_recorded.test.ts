// The Bash hooks record a read-shaped command's file only when stat finds a regular file there, and they stat its index key. On WSL a project on a Windows drive sits under a mount such as /mnt/c/..., which shellMountToWindowsPath used to fold into the drive-letter key c:/... on every platform, and POSIX resolves that key as a relative path, so no Bash read under a drive mount went on record. The fold is now Windows-only (BE-21), so on Linux the key is the mount path itself; this file pins that either spelling of the key finds the file. CAPTURE on WSL (node 24.14.0, linux, 2026-09-27): the built bundle's pre hook told a repeat `head -n 40 x.ts`, and a repeat `sed -n '1,40p' x.ts`, "You already read lines 1-40" in a project under /var/tmp and nothing in the same project under /mnt/c/Projects/..., while a build with the stat check stripped told both. A runner cannot create a real /mnt/<letter> without root (see tests/mcp_server_normalization_asymmetry.test.ts), so this file maps one mount onto a temp directory through node:fs's statSync alone, the call the check makes, and on Windows, which opens a drive-letter key as it stands, maps the letter there too; the /mnt/<drive> layout is FORMAT-DERIVED from WSL's default automount root, and the commands and their output are HAND-DERIVED from coreutils and sed syntax.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { getFileLineRanges } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

const MOUNT = '/mnt/q/'
const PROJECT = '/mnt/q/proj'

const mounted = vi.hoisted(() => ({ root: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const onHost = (s: string): string | null => {
    if (mounted.root === null) return null
    if (s.startsWith(MOUNT)) return path.join(mounted.root, s.slice(MOUNT.length))
    if (process.platform === 'win32' && /^q:[\\/]/i.test(s)) return path.join(mounted.root, s.slice(3))
    return null
  }
  const statSync = ((p: fs.PathLike, ...rest: unknown[]) => (actual.statSync as (...args: unknown[]) => unknown)(onHost(String(p)) ?? p, ...rest)) as typeof actual.statSync
  return { ...actual, statSync, default: { ...actual, statSync } }
})

const LINES = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i} * 2`)
const ALREADY_READ = /already read lines/i

beforeEach(() => {
  mounted.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wsl-mount-'))
  fs.mkdirSync(path.join(mounted.root, 'proj'))
})

afterEach(() => {
  if (mounted.root !== null) fs.rmSync(mounted.root, { recursive: true, force: true })
  mounted.root = null
})

/** One load, handle and save per hook call, as relay.ts runs it. */
async function asHook<T>(sid: string, handle: () => T | Promise<T>): Promise<T> {
  loadSessionState(sid)
  try {
    return await handle()
  } finally {
    saveSessionState(sid)
  }
}

function bashEvent(sid: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', response: Record<string, unknown> = {}): HookEvent {
  const raw: Record<string, unknown> = { cwd: PROJECT, tool_name: 'Bash', tool_input: { command } }
  if (eventName === 'post_tool_use') raw['tool_response'] = response
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
}

function text(out: HookOutput): string {
  if (out.hookType === 'deny') return out.message
  if (out.hookType === 'context') return out.context
  return ''
}

describe('a Bash read under a WSL drive mount goes on record when its file is there', () => {
  it('the mount keys as the drive letter on Windows and as the mount itself elsewhere', () => {
    expect(resolveIndexPath('x.ts', PROJECT)).toBe(process.platform === 'win32' ? 'q:/proj/x.ts' : '/mnt/q/proj/x.ts')
  })

  // `cat x.ts | head -n 40` is recorded by the post hook, and reaches Claude Code's PostToolUse even with x.ts absent, since head's status is the pipeline's; `sed -n '1,40p' x.ts` is recorded by the pre hook before it runs.
  it.each([
    ['cat x.ts | head -n 40'],
    ["sed -n '1,40p' x.ts"],
  ] as const)('%s', async (command) => {
    clearModuleCaches()
    const file = resolveIndexPath('x.ts', PROJECT)
    const present = `s-wsl-mount-${process.pid}-${Math.random().toString(36).slice(2)}`
    fs.writeFileSync(path.join(mounted.root as string, 'proj', 'x.ts'), LINES.join('\n'))
    await asHook(present, () => preBashHandler(bashEvent(present, command, 'pre_tool_use')))
    await asHook(present, () => postBashHandler(bashEvent(present, command, 'post_tool_use', { stdout: LINES.slice(0, 40).join('\n'), stderr: '', interrupted: false, isImage: false, noOutputExpected: false })))
    loadSessionState(present)
    expect(getFileLineRanges(file)).toEqual([[1, 40]])
    const later = await asHook(present, () => preBashHandler(bashEvent(present, 'head -n 40 x.ts', 'pre_tool_use')))
    expect(text(later)).toMatch(ALREADY_READ)

    // With the file gone from the mount as well, the second spelling finds nothing either and the read stays off the record.
    fs.rmSync(path.join(mounted.root as string, 'proj', 'x.ts'))
    const absent = `s-wsl-mount-${process.pid}-${Math.random().toString(36).slice(2)}`
    await asHook(absent, () => preBashHandler(bashEvent(absent, command, 'pre_tool_use')))
    await asHook(absent, () => postBashHandler(bashEvent(absent, command, 'post_tool_use', { stdout: '', stderr: 'cat: x.ts: No such file or directory', interrupted: false, isImage: false, noOutputExpected: false })))
    loadSessionState(absent)
    expect(getFileLineRanges(file)).toEqual([])
  })
})
