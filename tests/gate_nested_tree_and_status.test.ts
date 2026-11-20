// The gate reports the shell's own status when the shell exited before the deadline, and a nested owner stays findable. Provenance: HAND-DERIVED. Statuses are the ones the fixture shell exits with; liveness is read back from the OS; the environ rows use a made-up /proc/<pid>/environ image (proc(5): NUL-separated NAME=value entries).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/bash_runner.js'
import { runGate } from '../src/cli_diagnostics.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'

// Prints one line when it is up, holds stderr (inherited) so the gate's pipe stays open, and ends when its directory goes or after a hard cap.
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

// The deadline only has to outlast the fixture's node start; rows that expect an early exit wait for it to fire because the sleeper holds the pipe.
const DEADLINE_SECONDS = 5

let dir: string | undefined

const slash = (p: string): string => p.replace(/\\/g, '/')

function recordedPid(): number | undefined {
  const file = dir === undefined ? undefined : path.join(dir, 'sleeper.pid')
  return file !== undefined && fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : undefined
}

/** Starts the sleeper with stdout on a private pipe and waits (a blocking read, no spin) for its first line. */
function startSleeper(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-status-'))
  const script = path.join(dir, 'sleeper.cjs')
  fs.writeFileSync(script, SLEEPER_SCRIPT)
  return `exec 3< <('${slash(process.execPath)}' '${slash(script)}' '${slash(dir)}' </dev/null); read -r -u 3 _up`
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

const platformCanEnd = process.platform !== 'darwin'
const quiet = (): void => {}
const gateRun = (command: string): Promise<number> =>
  run(command, { filterName: 'passthrough', timeout: DEADLINE_SECONDS, endTreeAfterExit: true, writeStdout: quiet, writeStderr: quiet })

describe('the status of a shell that exited before the deadline', () => {
  it.skipIf(!platformCanEnd)('exit 0 with a child holding the pipe is a pass and the child is gone', async () => {
    const code = await runGate(`${startSleeper()}; exit 0`, { timeout: DEADLINE_SECONDS })
    const pid = recordedPid()
    expect(code, 'a shell that exited 0 before the deadline is a pass').toBe(0)
    expect(pid, 'the sleeper recorded its pid').toBeTypeOf('number')
    expect(processAlive(pid as number), 'the child holding the pipe is ended').toBe(false)
  })

  it.skipIf(!platformCanEnd)('a non-zero early exit returns that status, not 124', async () => {
    const code = await gateRun(`${startSleeper()}; exit 3`)
    expect(code, 'the shell exited 3 before the deadline').toBe(3)
    expect(processAlive(recordedPid() as number), 'the child holding the pipe is ended').toBe(false)
  })

  it.skipIf(!platformCanEnd)('a shell still running at the deadline returns 124', async () => {
    const code = await gateRun(`${startSleeper()}; read -r -u 3 _never`)
    expect(code, 'the shell was still waiting when the deadline fired').toBe(124)
    expect(processAlive(recordedPid() as number), 'the tree is ended at the deadline').toBe(false)
  })
})
