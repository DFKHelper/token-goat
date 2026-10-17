/** Resident token-goat processes that no pid file names (the strays 2.9.30 left behind) must be ended by the paths that replace or restart the worker, on the shipped bundle: `upgrade` ends every worker daemon of this install under every data home (and none that runs another launcher), and a claim that takes over a lease-less pid-file slot ends the daemon it replaces. Every daemon starts through `worker start`, the production launcher, in an isolated data home; nothing injects a callback. The bundle under test is a private copy of dist/, so its launcher path is its own and a `worker stop` or `upgrade` in another test file cannot end these daemons, nor these tests' ones theirs. The copy carries a package.json named token-goat, the shape of a published install, so `upgrade` does not take it for a development checkout. npm is replaced by a script that answers `view` and fails `install`, through the npm_execpath hook cli_upgrade.ts::npmInvocation already honours, so nothing is ever installed. The `npm view` lookup has a 2.5 s budget a loaded machine can miss, after which cli_upgrade.ts asks the registry over HTTP, so NPM_CONFIG_REGISTRY names a local server that also answers 99.0.0 and both paths reach the install step (its `{"version":"99.0.0"}` body is FORMAT-DERIVED from cli_upgrade.ts::fetchViaHttp, which reads `version`). Poll interval 600000 keeps a daemon from polling again, which pins a stray to staying a stray. Fixture provenance: the fake npm answers are HAND-DERIVED from the arguments cli_upgrade.ts passes (`view token-goat version`, `install -g token-goat@latest`). */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readAllProcesses } from '../src/cli_doctor_process.js'
import { isResidentOfInstall, readProcessCommandLine } from '../src/resident_process.js'
import { ROOT, tgIsolatedEnv } from './helpers/bundle.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'

/** Mirrors constants.ts's defaultDataDir() platform join; see worker_daemon_e2e.test.ts for why it cannot be imported. */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  return path.join(base, 'token-goat')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Polls `check` until it holds. The bound is a hang backstop for a process that never changes state; nothing asserts on how long a wait took. */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const FAKE_NPM = [
  "const args = process.argv.slice(2)",
  "if (args[0] === 'view') { process.stdout.write('99.0.0\\n'); process.exit(0) }",
  'process.exit(1)',
  '',
].join('\n')

/** A process that runs `script` as a long-lived node and holds a flag-bearing argv, so only the launcher path tells it from a daemon. */
const IDLE_SCRIPT = 'setInterval(() => {}, 1000)\n'

let work: string
let launcher: string
let launcher2: string
let dataBase: string
let dataBaseB: string
let dataBaseC: string
let env: NodeJS.ProcessEnv
let envB: NodeJS.ProcessEnv
let envC: NodeJS.ProcessEnv
const started: number[] = []
const children: ChildProcess[] = []
let registry: http.Server | null = null

beforeEach(async () => {
  registry = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{"version":"99.0.0"}')
  })
  await new Promise<void>((resolve) => (registry as http.Server).listen(0, '127.0.0.1', resolve))
  const registryUrl = `http://127.0.0.1:${((registry as http.Server).address() as AddressInfo).port}/`
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
  work = fs.mkdtempSync(path.join(ROOT, '.tmp', 'tg-stray-'))
  fs.cpSync(path.join(ROOT, 'dist'), path.join(work, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"token-goat","version":"0.0.0"}\n')
  fs.cpSync(path.join(ROOT, 'dist'), path.join(work, 'dist2'), { recursive: true })
  launcher = path.join(work, 'dist', 'token-goat.mjs')
  launcher2 = path.join(work, 'dist2', 'token-goat.mjs')
  dataBase = path.join(work, 'home')
  dataBaseB = path.join(work, 'homeB')
  dataBaseC = path.join(work, 'homeC')
  for (const base of [dataBase, dataBaseB, dataBaseC]) fs.mkdirSync(path.join(base, 'AppData', 'Roaming'), { recursive: true })
  const npmCli = path.join(work, 'npm-cli.js')
  fs.writeFileSync(npmCli, FAKE_NPM)
  const isolated = (base: string): NodeJS.ProcessEnv => {
    const e = tgIsolatedEnv(base, { TG_WORKER_POLL_MS: '600000', npm_execpath: npmCli, NPM_CONFIG_REGISTRY: registryUrl, TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' })
    delete e['TOKEN_GOAT_NO_WORKER_SPAWN']
    return e
  }
  env = isolated(dataBase)
  envB = isolated(dataBaseB)
  envC = isolated(dataBaseC)
})

/** Only what this file started: every daemon pid, and every decoy, on every path. */
afterEach(async () => {
  if (registry !== null) {
    const server = registry
    registry = null
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  // Every path, a failed `worker start` included: a daemon it spawned is not in `started`, so sweep the process table for residents of the two private launchers, which no other process runs. Pids this file recorded are checked the same way, in case the table cannot be read.
  const table = readAllProcesses()
  // Both spellings of each launcher: a command line may carry the realpath (a symlinked temp dir, an 8.3 short name) where this file built the path from mkdtemp. Read before the directory is deleted.
  const spellings = [launcher, launcher2].flatMap((l) => {
    try {
      return [l, fs.realpathSync.native(l)]
    } catch {
      return [l]
    }
  })
  const mine = (cmd: string | null): boolean => cmd !== null && spellings.some((l) => isResidentOfInstall(cmd, l, ['worker', 'hook-server']))
  const doomed = new Set<number>(started.splice(0).filter((pid) => alive(pid) && mine(readProcessCommandLine(pid))))
  if (Array.isArray(table)) for (const p of table) if (mine(p.commandLine)) doomed.add(p.processId)
  for (const pid of doomed) {
    if (pid === process.pid) continue
    // The whole tree: taskkill /T /F on Windows, where process.kill ends the daemon alone; SIGKILL to the daemon's group elsewhere. The command line is read again right here, so a pid that exited since the table was read and was reused is left alone.
    killIfCommandLine(pid, mine, { tree: true })
  }
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch {
    // a daemon still unwinding holds a handle on Windows; the pid kill above is what matters
  }
})

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}, at: { launcher: string; env: NodeJS.ProcessEnv } = { launcher, env }): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [at.launcher, ...args], { cwd: work, env: { ...at.env, ...extraEnv }, encoding: 'utf8', timeout: 60000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Like run(), but the test's event loop stays free so the local registry can answer the bundle while it waits. */
function runAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { cwd: work, env, windowsHide: true })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function startWorker(extraEnv: NodeJS.ProcessEnv = {}, at?: { launcher: string; env: NodeJS.ProcessEnv }): number {
  const start = run(['worker', 'start'], extraEnv, at)
  expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
  const m = start.stdout.match(/pid (\d+)/)
  expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
  const pid = parseInt((m as RegExpMatchArray)[1]!, 10)
  started.push(pid)
  return pid
}

function heartbeatNames(pid: number, base: string = dataBase): boolean {
  try {
    return fs.readFileSync(path.join(effectiveDataDir(base), 'queue', 'drain-heartbeat'), 'utf8').trim() === String(pid)
  } catch {
    return false
  }
}

function pidFile(): string {
  return path.join(effectiveDataDir(dataBase), 'worker.pid')
}

function startDecoy(script: string, extraArgs: string[]): ChildProcess {
  const child = spawn(process.execPath, [script, ...extraArgs], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

describe('stray resident processes on the built bundle', () => {
  it(
    'upgrade ends a worker daemon the pid file no longer names, and leaves an unrelated node process alone',
    async () => {
      const first = startWorker()
      await waitFor('the first daemon to write its heartbeat', 30000, () => heartbeatNames(first))
      // What a reclaimed slot left in 2.9.30: a live daemon and no pid file naming it.
      fs.rmSync(pidFile())
      const second = startWorker()
      expect(second).not.toBe(first)
      await waitFor('the second daemon to write its heartbeat', 30000, () => heartbeatNames(second))
      expect(fs.readFileSync(pidFile(), 'utf8').trim()).toBe(String(second))
      expect(alive(first), 'the first daemon must still be running before the upgrade').toBe(true)

      const idle = path.join(work, 'idle.js')
      fs.writeFileSync(idle, IDLE_SCRIPT)
      const unrelated = startDecoy(idle, [])
      // Carries the daemon flag but runs another script: only the launcher path tells it from a daemon.
      const flagged = startDecoy(idle, ['--worker-daemon'])
      expect(unrelated.pid).toBeDefined()
      expect(flagged.pid).toBeDefined()

      const upgrade = await runAsync(['upgrade'])
      expect(upgrade.stdout + upgrade.stderr, 'upgrade must reach the install step through the fake npm').toContain('npm install failed')
      // "Ended N": the note for an unreadable process list also says "other token-goat background processes", and must not pass for a retirement.
      expect(upgrade.stdout, `upgrade output: ${upgrade.stdout}${upgrade.stderr}`).toMatch(/Ended [0-9]+ other token-goat background process/)

      await waitFor('the tracked daemon to be gone', 30000, () => !alive(second))
      await waitFor('the stray daemon to be gone', 30000, () => !alive(first))
      expect(alive(unrelated.pid!), 'an unrelated node process must survive').toBe(true)
      expect(alive(flagged.pid!), 'a node process running another script must survive').toBe(true)
    },
    180000,
  )

  it(
    'upgrade ends this install workers under every data home and leaves a worker of another launcher alone',
    async () => {
      const inA = startWorker()
      const inB = startWorker({}, { launcher, env: envB })
      // The same bundle copied to another path, as a second install or a dist copy would be: not this launcher.
      const otherInstall = startWorker({}, { launcher: launcher2, env: envC })
      await waitFor('the home A daemon to write its heartbeat', 30000, () => heartbeatNames(inA))
      await waitFor('the home B daemon to write its heartbeat', 30000, () => heartbeatNames(inB, dataBaseB))
      await waitFor('the other launcher daemon to write its heartbeat', 30000, () => heartbeatNames(otherInstall, dataBaseC))

      const upgrade = await runAsync(['upgrade'])
      expect(upgrade.stdout + upgrade.stderr, 'upgrade must reach the install step through the fake npm').toContain('npm install failed')
      expect(upgrade.stdout, `upgrade output: ${upgrade.stdout}${upgrade.stderr}`).toMatch(new RegExp(`Ended [0-9]+ other token-goat background process.*pid[^)]*\\b${inB}\\b`))

      await waitFor('the home A daemon to be gone', 30000, () => !alive(inA))
      await waitFor('the home B daemon to be gone', 30000, () => !alive(inB))
      expect(alive(otherInstall), 'a worker that runs another launcher must survive').toBe(true)
    },
    180000,
  )

  it(
    'a claim over a lease-less pid-file slot ends the daemon it replaces',
    async () => {
      // No lease, for good: a directory stands where the heartbeat file goes, so the daemon's rename onto it fails whenever its first cycle runs and nothing it writes can restore a lease. A planted file naming another pid was overwritten when that first cycle ended after the plant (a slow start), and the claim was refused as already running.
      fs.mkdirSync(path.join(effectiveDataDir(dataBase), 'queue', 'drain-heartbeat'), { recursive: true })
      const old = startWorker()
      // The pid file is older than the startup grace.
      const aged = new Date(Date.now() - 10 * 60_000)
      fs.utimesSync(pidFile(), aged, aged)

      // A short poll: the replacement ends the old daemon at its first loop pass that sees its own pid in the file, and the parent writes that pid just after spawning it, so the first pass can come before the claim; the next pass must not be 10 minutes away.
      const replacement = startWorker({ TG_WORKER_POLL_MS: '200' })
      expect(replacement).not.toBe(old)
      await waitFor('the replaced daemon to be gone', 30000, () => !alive(old))
      expect(alive(replacement), 'the new daemon must be running').toBe(true)
      expect(fs.readFileSync(pidFile(), 'utf8').trim()).toBe(String(replacement))
    },
    120000,
  )
})
