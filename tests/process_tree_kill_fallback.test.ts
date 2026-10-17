// A caller of spawnOwned that is not git waits on the child's exit, so a tree kill that reached nothing must still end the root. Provenance: HAND-DERIVED for the rule (after a failed tree kill the child still ends, whoever started it). The tree helper (taskkill on Windows, ps on POSIX) is made to fail by answering for it in the spawnSync seam process_tree.ts already calls, and process.kill is stood in for during the one synchronous kill so a POSIX tree walk reaches nothing either; the child is real, and what ends it is the handle fallback, Node's own child.kill, which does not go through process.kill. Events only: the test waits for the child's exit event, and a red run is a child that stays alive, which fails the signalled-handle check at once and otherwise the per-test timeout. The child ends on its own when its directory is deleted, so a test that dies midway cannot leave it running past the cleanup.
import type * as ChildProcessModule from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const failing = vi.hoisted(() => ({ on: false }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const answering = ((file: string, ...rest: unknown[]) => {
    const helper = file.toLowerCase().endsWith('taskkill.exe') || file === 'ps'
    if (!failing.on || !helper) return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
    return { status: null, signal: null, output: [], pid: 0, stdout: '', stderr: '', error: new Error('forced: the helper could not run') }
  }) as typeof real.spawnSync
  return { ...real, spawnSync: answering }
})

const { spawnOwned } = await import('../src/process_tree.js')

const IDLE_SCRIPT = `
const fs = require('node:fs')
const dir = process.argv[1]
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`

let dir: string | undefined
const children: Array<{ exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: NodeJS.Signals) => boolean }> = []

afterEach(() => {
  failing.on = false
  vi.restoreAllMocks()
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

describe('spawnOwned ends the root when the tree kill fails', () => {
  it('a caller that only waits on the exit event is not left waiting', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tree-fallback-'))
    const script = path.join(dir, 'idle.cjs')
    fs.writeFileSync(script, IDLE_SCRIPT)
    const owned = spawnOwned(process.execPath, [script, dir], { stdio: 'ignore', windowsHide: true })
    children.push(owned.child)
    const exited = new Promise<NodeJS.Signals | null>((resolve) => owned.child.once('exit', (_code, signal) => resolve(signal)))
    // The failed tree kill is reported on stderr by design; keep it out of the run's output.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    failing.on = true
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    owned.kill()
    vi.restoreAllMocks()
    failing.on = false
    expect(owned.child.killed, 'the handle was never signalled after the tree kill failed').toBe(true)
    expect(await exited, 'the child ended, but not by the handle kill').toBe('SIGKILL')
  })
})
