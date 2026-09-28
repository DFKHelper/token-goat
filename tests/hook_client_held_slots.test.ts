/** A caller finds a free resident server while the others are held in synchronous work. src/hook_client.ts::callServer used to ask the slots one after another, giving each the 150 ms handshake allowance inside a 300 ms budget: with slots 0 and 1 each held in synchronous work (a server in synchronous work cannot read a hello, so the handshake times out), the budget was gone before slot 2 was asked, and the caller ran the hook or command cold (about 120 ms more for a hook, a whole cold CLI start for a command) while slot 2 sat idle. Measured on Windows with six `semantic` commands and six hooks fired together: 13 of 36 hooks fell back, each after 325 to 400 ms of finding, and the logged attempts show slot 0 then slot 1 timing out with slot 2 never asked. Nothing caught it because every multi-slot test held its slots in async work, where a server answers the hello with an explicit busy at once and the next slot is asked straight away. This drives the real path: callServer in this process against three real server processes from tests/fixtures/held_cli_server.ts, two of them blocked synchronously. Fixture provenance: HAND-DERIVED. The markdown file is written below and its expected section text read off it; the 150 ms and 300 ms are HANDSHAKE_TIMEOUT_MS and FIND_BUDGET_MS in src/hook_client.ts. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { callServer, serverStatuses } from '../src/hook_client.js'
import { envSnapshot, type ServerReply } from '../src/hook_ipc.js'
import { tsxProcessArgs } from './helpers/tsx_process.js'

const SERVER = path.join(process.cwd(), 'tests', 'fixtures', 'held_cli_server.ts')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let dir: string
let log: string
let release: string
let notes: string
let children: ChildProcess[] = []

function events(): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

async function until(what: string, done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; server events: ${events().join(',')}`)
    await sleep(20)
  }
}

function cli(argv: string[]): Promise<ServerReply | 'lost' | undefined> {
  return callServer({ kind: 'cli', argv, env: envSnapshot(), cwd: dir }, { autostart: false })
}

/** Hold `count` slots in synchronous work, one call per slot, each asked only once the previous one is held. */
async function hold(count: number): Promise<Array<Promise<ServerReply | 'lost' | undefined>>> {
  const held: Array<Promise<ServerReply | 'lost' | undefined>> = []
  for (let i = 1; i <= count; i++) {
    held.push(cli(['hold']))
    await until(`${i} held slot(s)`, () => events().filter((e) => e.startsWith('hold')).length === i)
  }
  return held
}

beforeEach(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-held-')))
  log = path.join(dir, 'server.log')
  release = path.join(dir, 'release')
  notes = path.join(dir, 'notes.md')
  fs.writeFileSync(notes, '# Title\n\nintro\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n')
  vi.stubEnv('TOKEN_GOAT_HOOK_SERVER', '1')
  children = [0, 1, 2].map((slot) => spawn(process.execPath, tsxProcessArgs(SERVER, String(slot), log, release), { cwd: process.cwd(), env: { ...process.env, TOKEN_GOAT_HOOK_SERVER: '1' }, stdio: 'ignore', windowsHide: true }))
  let statuses = 0
  const deadline = Date.now() + 60_000
  while (statuses < 3 && Date.now() < deadline) {
    statuses = (await serverStatuses()).length
    if (statuses < 3) await sleep(100)
  }
  expect(statuses, 'all three servers answered a status request').toBe(3)
}, 90_000)

afterEach(async () => {
  fs.writeFileSync(release, '')
  vi.unstubAllEnvs()
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      return exited
    }),
  )
  children = []
  fs.rmSync(dir, { recursive: true, force: true })
}, 30_000)

describe('callServer with slots held in synchronous work', () => {
  it('is served by the free third slot while the first two are held', async () => {
    const held = await hold(2)
    expect(events()).toEqual(['hold 0', 'hold 1'])
    const reply = await cli(['section', `${notes}::Alpha`])
    expect(reply, 'the free slot answered rather than the caller falling back').not.toBeUndefined()
    expect(reply !== 'lost' && reply?.ok === true && 'stdout' in reply ? reply.stdout : '').toContain('alpha body')
    expect(events()).toEqual(['hold 0', 'hold 1', 'run 2'])
    fs.writeFileSync(release, '')
    await Promise.all(held)
  }, 60_000)

  it('falls back within a bounded wait when every slot is held, and no held slot runs the request afterwards', async () => {
    const held = await hold(3)
    const started = Date.now()
    const reply = await cli(['section', `${notes}::Alpha`])
    const waited = Date.now() - started
    expect(reply).toBeUndefined()
    // Slot 2 is asked at most two hedge intervals in, and then gets its 150 ms handshake allowance; the rest is slack for a loaded CI runner.
    expect(waited).toBeLessThan(1500)
    fs.writeFileSync(release, '')
    await Promise.all(held)
    await sleep(500)
    expect(events()).toEqual(['hold 0', 'hold 1', 'hold 2'])
  }, 60_000)
})
