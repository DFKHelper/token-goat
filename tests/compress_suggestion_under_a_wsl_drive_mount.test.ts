// The large-output hint suggests `token-goat compress -c "cd '<dir>' && <cmd>"` for a cd-prefixed pipeline, naming the directory the prefix resolved to, and withholds the suggestion when that directory is not there. The resolved directory is an index key, and shellMountToWindowsPath used to fold a WSL mount such as /mnt/c/... into the drive-letter key c:/... on every platform (Windows-only since BE-21), which POSIX resolves as a relative path, so under a drive mount the suggestion was withheld for a directory that is there. CAPTURE on WSL (node 24.14.0, linux, 2026-09-27): the built bundle's post hook, handed `cd <project>/sub && cargo build 2>&1 | tail -n 400` with 5,589 bytes of output, suggested `cd '/var/tmp/.../sub' && ...` for a project under /var/tmp and gave only the recall pointer for the same project under /mnt/c/Projects/.... A runner cannot create a real /mnt/<letter> without root (see tests/mcp_server_normalization_asymmetry.test.ts), so this file maps one mount onto a temp directory through node:fs's statSync alone, the call the check makes, and on Windows, which opens a drive-letter key as it stands, maps the letter there too; the /mnt/<drive> layout is FORMAT-DERIVED from WSL's default automount root, and the output is HAND-DERIVED, the rustc error line bash_cd_prefixed_output_cache_key.test.ts repeats past the hint's 4 KB floor.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

const MOUNT = '/mnt/q/'
const PROJECT = '/mnt/q/proj'
/** Where this host opens the project behind its keys: the mount on Linux, and on Windows the drive letter, which it opens as it stands. */
const HOST_PROJECT = process.platform === 'win32' ? 'q:/proj' : PROJECT

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

const BIG = Array.from({ length: 100 }, (_, i) => `error[E0425]: cannot find value \`limit${i}\` in this scope`).join('\n')
const PIPED = 'cargo build 2>&1 | tail -n 400'

beforeEach(() => {
  mounted.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wsl-hint-'))
  fs.mkdirSync(path.join(mounted.root, 'proj'))
})

afterEach(() => {
  if (mounted.root !== null) fs.rmSync(mounted.root, { recursive: true, force: true })
  mounted.root = null
})

/** One load, handle and save, as relay.ts runs a hook call, with a fresh session so the once-per-session hint can fire. */
async function post(command: string): Promise<HookOutput> {
  const sid = `s-wsl-hint-${process.pid}-${Math.random().toString(36).slice(2)}`
  const raw: Record<string, unknown> = { cwd: PROJECT, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: BIG, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
  const event: HookEvent = { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
  loadSessionState(sid)
  try {
    return await postBashHandler(event)
  } finally {
    saveSessionState(sid)
  }
}

function suggestion(out: HookOutput): string | null {
  const text = out.hookType === 'context' ? out.context : ''
  expect(text).toMatch(/`token-goat bash-output [0-9a-f]+`/)
  return /`(token-goat compress -c "[^"]*")`/.exec(text)?.[1] ?? null
}

describe('the compress suggestion for a cd under a WSL drive mount names the directory where the shell finds it', () => {
  it('the directory keys as the drive letter on Windows and as the mount itself elsewhere', () => {
    expect(resolveIndexPath('sub', PROJECT)).toBe(`${HOST_PROJECT}/sub`)
  })

  it('a directory that is there under the mount is suggested where the host opens it', async () => {
    clearModuleCaches()
    fs.mkdirSync(path.join(mounted.root as string, 'proj', 'sub'))
    expect(suggestion(await post(`cd sub && ${PIPED}`))).toBe(`token-goat compress -c "cd '${HOST_PROJECT}/sub' && ${PIPED}"`)
  })

  it('a directory that is not there under the mount either gets the recall pointer and no suggestion', async () => {
    clearModuleCaches()
    expect(suggestion(await post(`cd sub && ${PIPED}`))).toBeNull()
  })
})
