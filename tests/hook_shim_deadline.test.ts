import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { GROK_HOOK_SCRIPT } from '../src/bridges/grok.js'
import { KIMI_HOOK_SCRIPT } from '../src/bridges/kimi.js'
import { hookDeadlineAt, readDenial } from '../src/read_deny.js'
import { loadPermissionSnapshotOrThrow } from '../src/rewrite_permission.js'

// Provenance: HAND-DERIVED. The stub server below never answers, the shim's budget is a value passed in by
// rewriting its own declaration (the same seam tests/install_grok.test.ts uses), and no row reads a clock.

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shim-deadline-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A dist dir whose resident client never answers and keeps the loop alive, as a wedged server socket does. */
function stalledDist(): string {
  const entry = path.join(dir, 'token-goat.mjs')
  // The spawn route: an entry that prints nothing and exits 1, so only the safe answer remains.
  fs.writeFileSync(entry, 'process.exit(1)\n')
  fs.writeFileSync(
    path.join(dir, 'token-goat-hook-client.cjs'),
    "exports.relayViaServer = () => new Promise(() => { setInterval(() => {}, 1000) })\n",
  )
  return entry
}

type Run = { status: number | null; stdout: string; stderr: string }

// Reports on fd 3, when the shim exits, every setTimeout delay it armed during the run.
const ARMED_AT_EXIT = `const fs = require('node:fs')
const armed = []
const realSetTimeout = global.setTimeout
global.setTimeout = function (fn, ms, ...rest) {
  armed.push(ms)
  return realSetTimeout.call(this, fn, ms, ...rest)
}
process.on('exit', () => { fs.writeSync(3, JSON.stringify(armed)) })
`

function runShim(script: string, event: string, entry: string): Run & { armed: number[] } {
  const shim = path.join(dir, 'shim.cjs')
  const report = path.join(dir, 'armed-at-exit.cjs')
  fs.writeFileSync(shim, script)
  fs.writeFileSync(report, ARMED_AT_EXIT)
  const run = spawnSync(process.execPath, ['--require', report, shim, event, entry], {
    input: '{}',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  })
  const reported = String(run.output[3] ?? '')
  const armed = reported === '' ? [] : (JSON.parse(reported) as number[])
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, armed }
}

/** The shim armed a timer, and none longer than its budget: a longer wait would outlast the deadline. */
function expectArmedWithin(armed: number[], ms: number): void {
  expect(armed.length, 'the shim armed no timer, so nothing bounds its wait').toBeGreaterThan(0)
  const detail = JSON.stringify(armed)
  expect(Math.max(...armed), `a wait was armed past the ${ms} ms budget: ${detail}`).toBeLessThanOrEqual(ms)
}

function withBudget(script: string, ms: number): string {
  const declaration = /const SHIM_FALLBACK_TIMEOUT_MS = [0-9_]+/
  const widened = script.replace(declaration, `const SHIM_FALLBACK_TIMEOUT_MS = ${ms}`)
  if (widened === script) throw new Error('the shim no longer declares its budget where this test rewrites it')
  return widened
}

describe('the shim answers inside its budget when the resident server never replies', () => {
  it('grok: a pre_tool_use call is allowed, exit 0, nothing on stderr', () => {
    const { armed, ...run } = runShim(withBudget(GROK_HOOK_SCRIPT, 400), 'pre_tool_use', stalledDist())
    expect(run).toEqual({ status: 0, stdout: '{"decision":"allow"}', stderr: '' })
    expectArmedWithin(armed, 400)
  })

  // Kimi reads empty stdout as "allow"; the other two answer an empty object.
  it.each([
    ['claudecode', CLAUDECODE_HOOK_SCRIPT, '{}'],
    ['codex', CODEX_HOOK_SCRIPT, '{}'],
    ['kimi', KIMI_HOOK_SCRIPT, ''],
  ])('%s: a stalled server falls through to the safe answer', (_name, script, safe) => {
    const { armed, ...run } = runShim(withBudget(script, 400), 'post_tool_use', stalledDist())
    expect(run).toEqual({ status: 0, stdout: safe, stderr: '' })
    expectArmedWithin(armed, 400)
  })
})

describe('the Copilot shim answers inside its budget when the resident server never replies', () => {
  it('a preToolUse call falls through to the empty answer, exit 0, nothing on stderr', () => {
    const { armed, ...run } = runShim(withBudget(COPILOT_CLI_HOOK_SCRIPT, 400), 'preToolUse', stalledDist())
    expect(run).toEqual({ status: 0, stdout: '{}', stderr: '' })
    expectArmedWithin(armed, 400)
  })
})

// Reports, on fd 3, every setTimeout delay armed by the time the shim starts waiting for the end of stdin.
const ARMED_REPORT = `const fs = require('node:fs')
const armed = []
const realSetTimeout = global.setTimeout
global.setTimeout = function (fn, ms, ...rest) {
  armed.push(ms)
  return realSetTimeout.call(this, fn, ms, ...rest)
}
const realOn = process.stdin.on
process.stdin.on = function (name, ...rest) {
  if (name === 'end') fs.writeSync(3, JSON.stringify(armed))
  return realOn.call(this, name, ...rest)
}
`

/**
 * Starts a shim whose stdin is never written or closed. `armed`: the timer delays set before the shim waited
 * on stdin (empty if it ended first); `ended`: its result, or a rejection on abort.
 */
function startShimWithOpenStdin(script: string, event: string, signal: AbortSignal) {
  const shim = path.join(dir, 'shim.cjs')
  const report = path.join(dir, 'armed-report.cjs')
  fs.writeFileSync(shim, script)
  fs.writeFileSync(report, ARMED_REPORT)
  const child = spawn(process.execPath, ['--require', report, shim, event, stalledDist()], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  openChildren.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const closed = new Promise<Run>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  const reported = new Promise<number[]>((resolve) => {
    child.stdio[3]!.once('data', (chunk: Buffer) => { resolve(JSON.parse(chunk.toString('utf8')) as number[]) })
  })
  // The framework's own per-test bound aborts `signal`: no clock of this test's is involved.
  const unbounded = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('the shim never ended while its stdin stayed open: its stdin read is unbounded'))
    }, { once: true })
  })
  const armed = Promise.race([reported, closed.then((): number[] => [])])
  return { child, armed, ended: Promise.race([closed, unbounded]) }
}

const openChildren: ChildProcess[] = []

afterEach(() => {
  for (const child of openChildren.splice(0)) child.kill('SIGKILL')
})

describe('the shim answers inside its budget when the host never closes stdin', () => {
  it.for([
    ['claudecode', CLAUDECODE_HOOK_SCRIPT, '{}'],
    ['codex', CODEX_HOOK_SCRIPT, '{}'],
    ['grok', GROK_HOOK_SCRIPT, '{"decision":"allow"}'],
    ['kimi', KIMI_HOOK_SCRIPT, ''],
  ])('%s: the safe answer, exit 0, nothing on stderr', async ([, script, safe], { signal }) => {
    const { child, armed, ended } = startShimWithOpenStdin(withBudget(script, 400), 'pre_tool_use', signal)
    const delays = await armed
    const bounded = delays.some((ms) => ms <= 400)
    expect(bounded, `its stdin read is unbounded: timers armed ${JSON.stringify(delays)}`).toBe(true)
    const run = await ended
    expect(child.stdin.writableEnded, 'the shim ended on its own bound, not on a closed stdin').toBe(false)
    expect(run).toEqual({ status: 0, stdout: safe, stderr: '' })
  })
})

describe('the Read pre-hook permission snapshot gives up at the deadline', () => {
  const ENV = 'TOKEN_GOAT_HOOK_DEADLINE_AT'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[ENV]
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  })

  it('throws once the deadline has passed, and not while it has not', () => {
    expect(() => loadPermissionSnapshotOrThrow(dir, dir, { deadlineAt: 1 })).toThrow(/not read in time/)
    expect(() => loadPermissionSnapshotOrThrow(dir, dir, { deadlineAt: Number.MAX_SAFE_INTEGER })).not.toThrow()
  })

  it('reads the deadline only from a plain integer', () => {
    expect(hookDeadlineAt({ [ENV]: '1700000000000' })).toBe(1_700_000_000_000)
    expect(hookDeadlineAt({ [ENV]: '12abc' })).toBeUndefined()
    expect(hookDeadlineAt({})).toBeUndefined()
  })

  it('a hook past its deadline leaves the read alone, and keeps no failure for the next call', () => {
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'x')
    const ctx = { cwd: dir, projectDir: dir, home: dir, enabled: true }
    process.env[ENV] = '1'
    const late = readDenial(file, ctx)
    expect(late).not.toBeNull()
    delete process.env[ENV]
    expect(readDenial(file, ctx)).toBeNull()
  })
})
