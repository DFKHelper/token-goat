// The gate ends a background child its shell left behind; other callers of run keep today's behaviour.
// Provenance: HAND-DERIVED. The sleeper writes its own pid and liveness is read back from the OS.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/bash_runner.js'
import { runGate } from '../src/cli_diagnostics.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'

// Ends itself when its directory is deleted, so a test that dies midway cannot leave it running.
const SLEEPER_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
fs.writeFileSync(path.join(dir, 'sleeper.tmp'), String(process.pid))
fs.renameSync(path.join(dir, 'sleeper.tmp'), path.join(dir, 'sleeper.pid'))
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`

let dir: string | undefined

const slash = (p: string): string => p.replace(/\\/g, '/')

function recordedPid(): number | undefined {
  const file = dir === undefined ? undefined : path.join(dir, 'sleeper.pid')
  return file !== undefined && fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : undefined
}

/** Backgrounds the sleeper with all three streams redirected, waits for its pid file, then exits 0. */
function backgroundCommand(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-tree-'))
  const script = path.join(dir, 'sleeper.cjs')
  fs.writeFileSync(script, SLEEPER_SCRIPT)
  const d = slash(dir)
  const start = `'${slash(process.execPath)}' '${slash(script)}' '${d}' </dev/null >/dev/null 2>&1 &`
  return `${start} while [ ! -f '${d}/sleeper.pid' ]; do :; done`
}

afterEach(() => {
  const pid = recordedPid()
  try {
    if (pid !== undefined) killIfCommandLine(pid, (cmd) => cmd.includes('sleeper.cjs'), { tree: true })
  } finally {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    dir = undefined
  }
})

// limit: macOS has no token carrier or group end; revisit-when: the owned spawn gets a process group.
const platformCanEnd = process.platform !== 'darwin'

describe('a command that leaves a background child behind', () => {
  it.skipIf(!platformCanEnd)('gate passes and the child is gone (not on macOS: no tree end)', async () => {
    const code = await runGate(backgroundCommand())
    const pid = recordedPid()
    expect(code, 'the verdict stays a pass').toBe(0)
    expect(pid, 'the sleeper recorded its pid').toBeTypeOf('number')
    expect(processAlive(pid as number), 'the background child is not alive after the gate returns').toBe(false)
  })

  it('a run without the option leaves the child alone, as before', async () => {
    const quiet = (): void => {}
    const io = { filterName: 'passthrough', writeStdout: quiet, writeStderr: quiet }
    const code = await run(backgroundCommand(), io)
    const pid = recordedPid()
    expect(code).toBe(0)
    expect(processAlive(pid as number), 'the plain run does not own the tree').toBe(true)
  })
})
