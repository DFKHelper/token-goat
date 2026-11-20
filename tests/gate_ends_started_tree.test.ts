// The gate ends a background child its shell left behind; other callers of run keep today's behaviour. Provenance: HAND-DERIVED. The sleeper writes its own pid and liveness is read back from the OS.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/bash_runner.js'
import { runGate } from '../src/cli_diagnostics.js'
import { resolveWindowsBash } from '../src/shell.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'

// Ends itself when its directory is deleted or after a hard cap, so a test that dies midway cannot leave it running.
const SLEEPER_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
fs.writeFileSync(path.join(dir, 'sleeper.tmp'), String(process.pid))
fs.renameSync(path.join(dir, 'sleeper.tmp'), path.join(dir, 'sleeper.pid'))
console.log('up')
setTimeout(() => process.exit(0), 60000)
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`

let dir: string | undefined

const slash = (p: string): string => p.replace(/\\/g, '/')

function recordedPid(): number | undefined {
  const file = dir === undefined ? undefined : path.join(dir, 'sleeper.pid')
  return file !== undefined && fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : undefined
}

/** Starts the sleeper with stdin and stderr discarded and stdout on a private pipe, then blocks on a read of its first line and exits 0. */
function backgroundCommand(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-tree-'))
  const script = path.join(dir, 'sleeper.cjs')
  fs.writeFileSync(script, SLEEPER_SCRIPT)
  const start = `'${slash(process.execPath)}' '${slash(script)}' '${slash(dir)}' </dev/null 2>/dev/null`
  return `exec 3< <(${start}); read -r -u 3 _up`
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

// The command is bash syntax; with no bash.exe on Windows the product falls back to cmd, which differs.
const noWindowsBash = process.platform === 'win32' && resolveWindowsBash() === null

describe('a command that leaves a background child behind', () => {
  const endsName = 'gate passes and the child is gone (not on macOS or Windows without bash.exe)'
  it.skipIf(!platformCanEnd || noWindowsBash)(endsName, async () => {
    const code = await runGate(backgroundCommand())
    const pid = recordedPid()
    expect(code, 'the verdict stays a pass').toBe(0)
    expect(pid, 'the sleeper recorded its pid').toBeTypeOf('number')
    expect(processAlive(pid as number), 'the background child is not alive after the gate returns').toBe(false)
  })

  const plainName = 'a run without the option leaves the child alone (not on Windows without bash.exe)'
  it.skipIf(noWindowsBash)(plainName, async () => {
    const quiet = (): void => {}
    const io = { filterName: 'passthrough', writeStdout: quiet, writeStderr: quiet }
    const code = await run(backgroundCommand(), io)
    const pid = recordedPid()
    expect(code).toBe(0)
    expect(processAlive(pid as number), 'the plain run does not own the tree').toBe(true)
  })
})
