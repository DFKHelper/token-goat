// A failed tree kill is reported on stderr, except when the failure is the root already being gone, which is not one. The tree helper (taskkill on Windows, ps on POSIX) is forced to answer by standing in for it in the spawnSync seam the module already calls; every other spawnSync goes to the real one. Provenance: HAND-DERIVED for the rule (a failed kill is reported once; a vanished root is silent). FORMAT-DERIVED for the status: 128 is taskkill's "process not found" exit, from Microsoft's taskkill documentation (learn.microsoft.com, windows-commands/taskkill) and the Windows error ERROR_WAIT_NO_CHILDREN (128). The status cases are Windows-only because they are taskkill's codes; the stand-in there is a live child, so the only thing that differs from a vanished root is the status the helper reports.
import type * as ChildProcessModule from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

/** `status` is what the tree helper answers while set: null is a helper that could not run, a number is its exit status. */
const forced = vi.hoisted(() => ({ status: undefined as number | null | undefined }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const answering = ((file: string, ...rest: unknown[]) => {
    const helper = file.toLowerCase().endsWith('taskkill.exe') || file === 'ps'
    if (forced.status === undefined || !helper) return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
    return { status: forced.status, signal: null, output: [], pid: 0, stdout: '', stderr: '', ...(forced.status === null ? { error: new Error('forced: the helper could not run') } : {}) }
  }) as typeof real.spawnSync
  return { ...real, spawnSync: answering }
})

const { spawnOwned } = await import('../src/process_tree.js')

// The child ends on its own when its directory is deleted, so a test that dies midway cannot leave it running past the cleanup.
const IDLE_SCRIPT = `
const fs = require('node:fs')
const dir = process.argv[1]
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`

let dir: string | undefined
const children: Array<{ exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: NodeJS.Signals) => boolean }> = []

afterEach(() => {
  forced.status = undefined
  vi.restoreAllMocks()
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

/** Ends a live child while the tree helper answers `status`, and returns the failure lines that reached stderr and whether the child's own handle was signalled. */
function killWith(status: number | null): { written: string[]; handleSignalled: boolean } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tree-notice-'))
  const script = path.join(dir, 'idle.cjs')
  fs.writeFileSync(script, IDLE_SCRIPT)
  const owned = spawnOwned(process.execPath, [script, dir], { stdio: 'ignore', windowsHide: true })
  children.push(owned.child)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  forced.status = status
  owned.kill()
  const written = stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('could not end'))
  vi.restoreAllMocks()
  return { written, handleSignalled: owned.child.killed }
}

describe('a failed tree kill is reported once', () => {
  it('a helper that could not run is named on stderr', () => {
    expect(killWith(null).written).toHaveLength(1)
  })
})

describe.skipIf(process.platform !== 'win32')('taskkill statuses', () => {
  it('status 128 (process not found) prints nothing', () => {
    expect(killWith(128).written, 'a vanished root was reported as a failed kill').toEqual([])
  })

  it('status 128 still ends a root that is alive, through its handle', () => {
    // The stand-in helper answers 128 without ending anything, so the root is live and only the handle can end it.
    expect(killWith(128).handleSignalled, 'a 128 answer left a live root running').toBe(true)
  })

  it('any other non-zero status is still reported', () => {
    const { written } = killWith(1)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('status 1')
  })
})
