/** A piped CLI command answered by the resident server runs exactly once, however long it takes. The client (src/hook_client.ts) used to give a dispatched CLI request 120 s and then report it lost, and src/main.ts runs a lost command itself. The server cannot abandon a command it has started, so a slow command then ran twice, the second run beside the first on the same index: a 342.8 s `symbol` miss on a large project was 120 s of waiting and then the whole command again. Nothing caught it because every test of the warm CLI ran a command that answers in milliseconds, and none could wait 120 s. This drives the real path: src/main.ts in this process (the client, and the local fallback it owns) against a real server process from tests/fixtures/slow_cli_server.ts, which runs the real CLI behind a gate that holds the command past the timeout. Only this process's `setTimeout` is faked, to reach the 120 s mark without waiting for it; the socket, handshake, MAC and reply are real. The local fallback's `run` is replaced by a counter, so a second execution is counted rather than performed. Fixture provenance: HAND-DERIVED. The markdown file is written below, and its expected section text is read off it; 120,000 ms is RESPONSE_TIMEOUT_MS in src/hook_client.ts. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { serverStatuses } from '../src/hook_client.js'
import { tsxProcessArgs } from './helpers/tsx_process.js'

const local = vi.hoisted(() => ({ runs: 0 }))
vi.mock('../src/cli.js', () => ({
  run: async (): Promise<void> => {
    local.runs++
  },
}))

const SERVER = path.join(process.cwd(), 'tests', 'fixtures', 'slow_cli_server.ts')
/** RESPONSE_TIMEOUT_MS in src/hook_client.ts, past which a dispatched request used to be reported lost. */
const RESPONSE_TIMEOUT_MS = 120_000

const realSetTimeout = globalThis.setTimeout
const sleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms))

let dir: string
let log: string
let release: string
let notes: string
let child: ChildProcess | undefined
let argvBefore: string[]
let writeBefore: typeof process.stdout.write
let stdout: string

function events(): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

async function until(what: string, done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; server events: ${events().join(',')}; local runs: ${local.runs}`)
    await sleep(20)
  }
}

/** Run src/main.ts in this process as `token-goat section <notes>::Alpha` with its output going to a pipe, and wait for the server to start the command. */
async function startCommand(): Promise<void> {
  process.argv = [process.execPath, 'token-goat', 'section', `${notes}::Alpha`]
  vi.resetModules()
  await import('../src/main.js')
  await until('the server to start the command', () => events().includes('start'))
}

beforeEach(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cli-wait-')))
  log = path.join(dir, 'server.log')
  release = path.join(dir, 'release')
  notes = path.join(dir, 'notes.md')
  fs.writeFileSync(notes, '# Title\n\nintro\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n')
  vi.stubEnv('TOKEN_GOAT_HOOK_SERVER', '1')
  child = spawn(process.execPath, tsxProcessArgs(SERVER, log, release), { cwd: process.cwd(), env: { ...process.env, TOKEN_GOAT_HOOK_SERVER: '1' }, stdio: 'ignore', windowsHide: true })
  let statuses = 0
  const deadline = Date.now() + 60_000
  while (statuses === 0 && child.exitCode === null && Date.now() < deadline) {
    statuses = (await serverStatuses()).length
    if (statuses === 0) await sleep(100)
  }
  expect(statuses, 'the server answered a status request').toBe(1)
  argvBefore = process.argv
  writeBefore = process.stdout.write.bind(process.stdout)
  stdout = ''
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}, 90_000)

afterEach(async () => {
  vi.useRealTimers()
  process.stdout.write = writeBefore
  process.argv = argvBefore
  process.exitCode = undefined
  local.runs = 0
  vi.unstubAllEnvs()
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child.kill()
    await exited
  }
  child = undefined
  fs.rmSync(dir, { recursive: true, force: true })
}, 30_000)

describe('warm CLI command slower than the response timeout', () => {
  it('runs once, on the server, and prints its answer', async () => {
    await startCommand()
    vi.advanceTimersByTime(RESPONSE_TIMEOUT_MS + 1)
    // Room for a client that gave up to start its own run before the server's finishes.
    await sleep(300)
    fs.writeFileSync(release, '')
    await until('the command to finish and print', () => events().includes('done') && (stdout.includes('alpha body') || local.runs > 0))
    await sleep(300)
    expect({ server: events().filter((e) => e === 'done').length, local: local.runs }).toEqual({ server: 1, local: 0 })
    expect(stdout).toContain('alpha body')
    expect(stdout).not.toContain('beta body')
    expect(process.exitCode).toBe(0)
  }, 90_000)

  it('still runs the command locally when the server dies in the middle of it', async () => {
    await startCommand()
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child?.kill()
    await exited
    await until('the local fallback', () => local.runs > 0, 30_000)
    await sleep(300)
    expect({ server: events().filter((e) => e === 'done').length, local: local.runs }).toEqual({ server: 0, local: 1 })
    expect(stdout).not.toContain('alpha body')
  }, 90_000)
})
