// The gate reports the shell's own status when the shell exited before the deadline, and a nested owner stays findable. Provenance: HAND-DERIVED. Statuses are the ones the fixture shell exits with; liveness is read back from the OS; the environ rows use a made-up /proc/<pid>/environ image (proc(5): NUL-separated NAME=value entries).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/bash_runner.js'
import { runGate } from '../src/cli_diagnostics.js'
import { environCarriesToken, killTokenCarriers, type TokenCarrierLookup } from '../src/process_tree.js'
import { BUNDLE } from './helpers/bundle.js'
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

// The nested row waits for node to start twice (outer gate, inner sleeper) before its deadline kills them.
const NESTED_DEADLINE_SECONDS = 12

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
  const start = `'${slash(process.execPath)}' '${slash(script)}' '${slash(dir)}' </dev/null`
  return `mkfifo '${slash(dir)}/up'; ${start} > '${slash(dir)}/up' & exec 3< '${slash(dir)}/up'; read -r _up <&3`
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
const gateRun = (command: string, timeout = DEADLINE_SECONDS): Promise<number> =>
  run(command, {
    filterName: 'passthrough',
    timeout,
    endTreeAfterExit: true,
    writeStdout: quiet,
    writeStderr: quiet,
  })

describe('the status of a shell that exited before the deadline', () => {
  it.skipIf(!platformCanEnd)('exit 0 with a child holding the pipe is a pass, child gone', async () => {
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
    const code = await gateRun(`${startSleeper()}; read -r _never <&3`)
    expect(code, 'the shell was still waiting when the deadline fired').toBe(124)
    expect(processAlive(recordedPid() as number), 'the tree is ended at the deadline').toBe(false)
  })
})

describe('a gate nested inside a gate', () => {
  it.skipIf(!platformCanEnd)('ends the inner gate sleeper when the outer deadline fires', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-nested-'))
    const script = path.join(dir, 'sleeper.cjs')
    fs.writeFileSync(script, SLEEPER_SCRIPT)
    const inner = `'${slash(process.execPath)}' '${slash(script)}' '${slash(dir)}'`
    const outer = `'${slash(process.execPath)}' '${slash(BUNDLE)}' gate -- ${inner}`
    const code = await gateRun(outer, NESTED_DEADLINE_SECONDS)
    const pid = recordedPid()
    expect(code, 'the outer shell was still running at its deadline').toBe(124)
    expect(pid, 'the inner gate started the sleeper').toBeTypeOf('number')
    expect(processAlive(pid as number), 'ending the outer tree ends the inner gate and its sleeper').toBe(false)
  })
})

const TOKEN = '11111111-2222-3333-4444-555555555555'
const entry = (value: string): Buffer => Buffer.from(`PATH=/bin\0TOKEN_GOAT_OWNED_BY=${value}\0HOME=/h\0`)

describe('an owner token is found whether the run is the outer owner or nested inside one', () => {
  it('a chain of tokens carries the outer owner', () => {
    expect(environCarriesToken(entry(TOKEN), TOKEN), 'a single token').toBe(true)
    expect(environCarriesToken(entry(`${TOKEN},inner-token`), TOKEN), 'outer ahead of inner').toBe(true)
    expect(environCarriesToken(entry(`outer-token,${TOKEN}`), TOKEN), 'inner after outer').toBe(true)
  })

  it('a near miss does not match', () => {
    expect(environCarriesToken(entry(`${TOKEN}0`), TOKEN), 'a longer token with the same prefix').toBe(false)
    expect(environCarriesToken(entry(TOKEN.slice(1)), TOKEN), 'a shorter token').toBe(false)
    expect(environCarriesToken(Buffer.from(`OTHER=${TOKEN}\0`), TOKEN), 'another name').toBe(false)
  })
})

describe('a pid that no longer proves to be ours receives no signal', () => {
  type Stub = { lookup: TokenCarrierLookup; sent: string[] }
  function lookup(carries: (pid: number) => boolean | undefined): Stub {
    const sent: string[] = []
    return {
      sent,
      lookup: {
        list: (_token, already) => [101, 102].filter((pid) => !already.has(pid)),
        carries: (pid) => carries(pid),
        signal: (pid, signal) => {
          sent.push(`${pid} ${signal}`)
          return undefined
        },
      },
    }
  }

  it('signals pids that still carry the token, stop first and kill after', () => {
    const { lookup: l, sent } = lookup(() => true)
    killTokenCarriers(TOKEN, l)
    expect(sent).toEqual(['101 SIGSTOP', '102 SIGSTOP', '101 SIGKILL', '102 SIGKILL'])
  })

  it('a pid whose token changed between the listing and the signal is not signalled', () => {
    const reads = new Map<number, number>()
    const { lookup: l, sent } = lookup((pid) => {
      const n = (reads.get(pid) ?? 0) + 1
      reads.set(pid, n)
      return pid === 102 ? n <= 1 : true
    })
    killTokenCarriers(TOKEN, l)
    expect(sent, '102 carried the token for the stop and another at the kill').toEqual(
      ['101 SIGSTOP', '102 SIGSTOP', '101 SIGKILL'],
    )
  })

  it('a pid whose environment cannot be read is not signalled', () => {
    const { lookup: l, sent } = lookup((pid) => (pid === 101 ? undefined : true))
    killTokenCarriers(TOKEN, l)
    expect(sent).toEqual(['102 SIGSTOP', '102 SIGKILL'])
  })
})
