// Every stat and read a hook makes of an index key goes through paths.ts::hostPathOfIndexKey, because a drive-letter key names nothing on WSL: shellMountToWindowsPath used to fold a mount such as /mnt/c/x into the key c:/x on every platform, and POSIX resolves c:/x as a relative path, so each check below failed toward doing nothing for a file under a drive mount. The fold is Windows-only since BE-21, so on Linux a drive-letter key now comes only from a path typed as `C:\x` or from a key an earlier version recorded; the mount paths below key at the mount there, and the VS Code case types the drive letter. CAPTURE on WSL (node 24.14.0, linux, 2026-09-27): the loop 71 review's isolated dogfood of the built bundle had the Read hook refuse a 79 KB log under /var/tmp and pass the same file under /mnt/c with no word, and loop 72's rerun of that probe against the fixed bundle refused both. A runner cannot create /mnt/<letter>, so one mount is mapped onto a temp directory through node:fs, and on Windows, which opens a key as it stands, the drive letter is mapped there too; the file contents and names are HAND-DERIVED, the document is this repository's own CLAUDE.arch.md.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { VSCODE_TOOL_NAME_KEY } from '../src/hooks_cli.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { getSessionFileEntry } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'
import { preToolPathDeclined } from '../src/vscode_path_gate.js'

const MOUNT = '/mnt/q/'
const PROJECT = '/mnt/q/proj'
/** Where this host opens the project behind its keys: the mount on Linux, and on Windows the drive letter, which it opens as it stands. */
const HOST_PROJECT = process.platform === 'win32' ? 'q:/proj' : PROJECT

const mounted = vi.hoisted(() => ({ root: null as string | null, touched: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const onHost = (p: unknown): unknown => {
    if (mounted.root === null || typeof p !== 'string') return p
    if (p.startsWith(MOUNT)) return path.join(mounted.root, p.slice(MOUNT.length))
    if (process.platform === 'win32' && /^q:[\\/]/i.test(p)) return path.join(mounted.root, p.slice(3))
    return p
  }
  const wrap = <F>(fn: F): F => ((p: unknown, ...rest: unknown[]) => {
    const target = onHost(p)
    if (target !== p) mounted.touched.push(String(target))
    return (fn as (...args: unknown[]) => unknown)(target, ...rest)
  }) as F
  const overrides = {
    statSync: wrap(actual.statSync),
    lstatSync: wrap(actual.lstatSync),
    readFileSync: wrap(actual.readFileSync),
    openSync: wrap(actual.openSync),
    existsSync: wrap(actual.existsSync),
  }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i} * 2`).join('\n') + '\n'
const LOG = Array.from({ length: 1000 }, (_, i) => `2026-09-27T10:${String(i % 60).padStart(2, '0')}:00Z INFO worker drained queue batch ${i} in 12ms`).join('\n') + '\n'

beforeEach(() => {
  clearModuleCaches()
  mounted.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wsl-key-'))
  mounted.touched.length = 0
  fs.mkdirSync(path.join(mounted.root, 'proj'))
  fs.mkdirSync(path.join(mounted.root, 'outside'))
})

afterEach(() => {
  if (mounted.root !== null) fs.rmSync(mounted.root, { recursive: true, force: true })
  mounted.root = null
})

/** Writes `name` into the mapped project and returns its size. */
function place(name: string, body: string): number {
  fs.writeFileSync(path.join(mounted.root as string, 'proj', name), body)
  return Buffer.byteLength(body)
}

function newSession(): string {
  return `s-wsl-key-${process.pid}-${Math.random().toString(36).slice(2)}`
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

function readEvent(sid: string, eventName: 'pre_tool_use' | 'post_tool_use', filePath: string, extra: Record<string, unknown> = {}): HookEvent {
  const toolInput = { file_path: filePath }
  const raw: Record<string, unknown> = { cwd: PROJECT, tool_name: 'Read', tool_input: toolInput, ...extra }
  return { eventName, toolName: 'Read', toolInput, sessionId: sid, agentId: undefined, raw }
}

function bashEvent(sid: string, eventName: 'pre_tool_use' | 'post_tool_use', command: string, stdout = ''): HookEvent {
  const raw: Record<string, unknown> = { cwd: PROJECT, tool_name: 'Bash', tool_input: { command } }
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: undefined, raw }
}

function text(out: HookOutput): string {
  if (out.hookType === 'deny') return out.message
  if (out.hookType === 'context') return out.context
  if (out.hookType === 'rewriteOutput') return out.updatedOutput
  return ''
}

describe('a hook reading the file behind a drive-letter key opens it where the host keeps it', () => {
  it('the mount keys as the drive letter on Windows and as the mount itself elsewhere', () => {
    expect(resolveIndexPath('app.log', PROJECT)).toBe(`${HOST_PROJECT}/app.log`)
  })

  it('the Read hook refuses a 79 KB log by its file-type intercept', async () => {
    place('app.log', LOG)
    const sid = newSession()
    const out = await asHook(sid, () => preReadHandler(readEvent(sid, 'pre_tool_use', `${PROJECT}/app.log`)))
    expect(out.hookType).toBe('deny')
  })

  it('the Read hook refuses a file past the large-read limit by its size', async () => {
    const bytes = place('huge.ts', SOURCE.repeat(70))
    expect(bytes).toBeGreaterThan(512_000)
    const sid = newSession()
    const out = await asHook(sid, () => preReadHandler(readEvent(sid, 'pre_tool_use', `${PROJECT}/huge.ts`)))
    expect(out.hookType).toBe('deny')
    expect(text(out)).toMatch(/is very large \(\d+KB\)/)
  })

  it('the Read hooks record the read at its size and point a long source file at its skeleton', async () => {
    const bytes = place('x.ts', SOURCE)
    const sid = newSession()
    await asHook(sid, () => preReadHandler(readEvent(sid, 'pre_tool_use', `${PROJECT}/x.ts`)))
    const out = await asHook(sid, () => postReadHandler(readEvent(sid, 'post_tool_use', `${PROJECT}/x.ts`, { tool_response: { type: 'text', file: { filePath: `${PROJECT}/x.ts`, content: SOURCE, numLines: 300, startLine: 1, totalLines: 300 } } })))
    loadSessionState(sid)
    expect(getSessionFileEntry(`${HOST_PROJECT}/x.ts`)?.sizeBytes).toBe(bytes)
    expect(text(out)).toContain('is 300 lines')
  })

  it('the Bash pre hook names a sed range over the whole file as the whole file', async () => {
    place('x.ts', SOURCE)
    const sid = newSession()
    const out = await asHook(sid, () => preBashHandler(bashEvent(sid, 'pre_tool_use', "sed -n '1,300p' x.ts")))
    expect(text(out)).toContain('is the whole file (300 lines)')
  })

  it('the Bash post hook folds a whole-file cat of a long document to its heading tree', async () => {
    const doc = fs.readFileSync(path.join(REPO, 'CLAUDE.arch.md'), 'utf-8')
    place('big.md', doc)
    const sid = newSession()
    const out = await asHook(sid, () => postBashHandler(bashEvent(sid, 'post_tool_use', 'cat big.md', doc)))
    expect(out.hookType).toBe('rewriteOutput')
    expect(text(out)).toContain('Partial view: this ')
  })

  it('the Bash hooks recall a curl -o download from the path it was written to', async () => {
    place('out.json', JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` })) }))
    const command = 'curl -sS -o out.json https://example.invalid/data.json'
    const sid = newSession()
    await asHook(sid, () => postBashHandler(bashEvent(sid, 'post_tool_use', command)))
    const again = await asHook(sid, () => preBashHandler(bashEvent(sid, 'pre_tool_use', command)))
    expect(again.hookType).toBe('deny')
    expect(text(again)).toContain(`rg '<pattern>' "${HOST_PROJECT}/out.json"`)
    expect(text(again)).toContain('This file was already downloaded earlier this session.')
  })

  // Not a miss the fix repairs but one it could open: the gate asked about the typed `q:/outside/secret.log`, which POSIX resolves inside the workspace, while the handler now opens the mount, which is outside it. The gate may still look inside the workspace at the typed spelling, so only the mount's file counts.
  it('on VS Code, a drive-letter path whose mount is outside the workspace is declined before the mount is opened', async () => {
    const outside = path.join(mounted.root as string, 'outside', 'secret.log')
    fs.writeFileSync(outside, LOG)
    const sid = newSession()
    const event = readEvent(sid, 'pre_tool_use', 'q:/outside/secret.log', { _tg_harness: 'vscode', [VSCODE_TOOL_NAME_KEY]: 'read_file' })
    const out = await asHook(sid, () => preReadHandler(event))
    expect(mounted.touched).not.toContain(outside)
    expect(out).toEqual({ hookType: 'pass' })
    expect(preToolPathDeclined(event, 'q:/outside/secret.log')).toBe(true)
  })
})
