// Provenance: HAND-DERIVED unless a case says otherwise. Each expected value is computed from git's documented behavior, not read off runGit or runGitAsync: the blob id of `x\n` is `printf 'x\n' | git hash-object --stdin`, a cat-file --batch-check line is `<oid> <type> <size>` or `<oid> missing` (git-cat-file, "BATCH OUTPUT"), `-c` on the command line overrides repository config (git-config, "FILES"), and exit 128 is git's `fatal:` status. The driver and alias forms are FORMAT-DERIVED from git-config (`diff.<driver>.command`, `alias.<name>=!cmd`) and gitattributes (`diff=<driver>`). Every case runs the same args through runGit and runGitAsync and compares, then also pins an absolute value, because two runners that agree on a wrong answer would pass a comparison alone. Events only: no clock, no sleep.
import { mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runGitAsync } from '../src/git_async.js'
import { gitExecutable, runGit } from '../src/util.js'

/** Connects to the test's server, announces its pid, then blocks. It ends when that socket closes or cannot open, so a holder that outlives a failed test dies as soon as the test tears its server down. */
const HOLDER = [
  "const net = require('node:net')",
  "const s = net.connect(Number(process.env.TG_HOLD_PORT), '127.0.0.1', () => s.write(String(process.pid)))",
  "s.on('error', () => process.exit(0))",
  "s.on('close', () => process.exit(0))",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

/** Starts a holder that is no longer a descendant of anyone when it matters, then exits: the holder keeps the inherited stdout pipe, and its parent is gone, so a kill that walks the tree from git cannot reach it. */
const ORPHANER = [
  "const { spawn } = require('node:child_process')",
  '// owner: the parity test that wrote this script ... dies when its server socket closes, which ends the holder it starts',
  "spawn(process.execPath, [process.env.TG_HOLDER], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref()",
].join('\n')

/** Reports its pid and working directory to the test's server, then writes 201 MiB, one more than the 200 MiB cap. It ends when that socket closes or cannot open, never on its own: a process that exits resets its connection, and Windows then drops what the server had not yet read, which is the report. */
const FLOOD_ONCE = [
  "const net = require('node:net')",
  'const chunk = Buffer.alloc(1 << 20, 97)',
  'let left = 201',
  "process.stdout.on('error', () => undefined)",
  'function pump() {',
  '  while (left > 0) {',
  '    left--',
  '    if (!process.stdout.write(chunk)) {',
  "      process.stdout.once('drain', pump)",
  '      return',
  '    }',
  '  }',
  '}',
  "const s = net.connect(Number(process.env.TG_HOLD_PORT), '127.0.0.1', () => s.write(JSON.stringify({ pid: process.pid, cwd: process.cwd() }), () => pump()))",
  "s.on('error', () => process.exit(0))",
  "s.on('close', () => process.exit(0))",
].join('\n')

/** Writes the file named by TG_MARKER, the proof that a diff driver ran. */
const DRIVER = ["require('node:fs').writeFileSync(process.env.TG_MARKER, 'ran')"].join('\n')

const BLOB_X = '587be6b4c3f93f93c489c0111bba5596147a26cb'
const savedEnv: Record<string, string | undefined> = {}
let dir = ''
let repo = ''
let server: net.Server
let sockets: net.Socket[] = []
let socketsClosed: Promise<void>[] = []
let announcements = 0
let reports: string[] = []
let waiters: Array<{ count: number; resolve: () => void }> = []
let controller: AbortController
let pending: Promise<unknown>[] = []

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}

/** Resolves once `count` holders have announced themselves to the server. */
function announced(count: number): Promise<void> {
  if (announcements >= count) return Promise.resolve()
  return new Promise((resolve) => waiters.push({ count, resolve }))
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'tg-rungit-parity-')))
  repo = path.join(dir, 'repo')
  mkdirSync(repo)
  writeFileSync(path.join(dir, 'holder.cjs'), HOLDER)
  writeFileSync(path.join(dir, 'orphaner.cjs'), ORPHANER)
  writeFileSync(path.join(dir, 'flood.cjs'), FLOOD_ONCE)
  writeFileSync(path.join(dir, 'driver.cjs'), DRIVER)
  // The user's own git config must not reach either runner: a global diff.external or core.fsmonitor would change what is being compared.
  writeFileSync(path.join(dir, 'empty.gitconfig'), '')
  setEnv('GIT_CONFIG_GLOBAL', path.join(dir, 'empty.gitconfig'))
  setEnv('GIT_CONFIG_NOSYSTEM', '1')
  setEnv('TG_HOLDER', path.join(dir, 'holder.cjs'))
  setEnv('TG_ORPHANER', path.join(dir, 'orphaner.cjs'))
  setEnv('TG_FLOOD', path.join(dir, 'flood.cjs'))
  setEnv('TG_DRIVER', path.join(dir, 'driver.cjs'))
  controller = new AbortController()
  announcements = 0
  reports = []
  waiters = []
  server = net.createServer((socket) => {
    sockets.push(socket)
    socketsClosed.push(new Promise((resolve) => socket.once('close', () => resolve())))
    // Windows reports a killed peer as a reset before the close.
    socket.on('error', () => undefined)
    socket.once('data', (data) => {
      reports.push(String(data))
      announcements++
      for (const w of waiters.filter((x) => announcements >= x.count)) w.resolve()
      waiters = waiters.filter((x) => announcements < x.count)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  setEnv('TG_HOLD_PORT', String((server.address() as net.AddressInfo).port))
  const init = runGit(['init', '--quiet'], { cwd: repo })
  expect(init.exitCode, init.stderr).toBe(0)
  expect(runGit(['config', 'core.autocrlf', 'false'], { cwd: repo }).exitCode).toBe(0)
})

afterEach(async () => {
  // Order matters: a call whose pipe a survivor still holds settles only after that survivor dies, and a survivor dies when its socket closes. So end the call through its handle, close the sockets and wait for each peer to answer, then wait for the calls.
  controller.abort()
  for (const socket of sockets) socket.end()
  await Promise.allSettled(socketsClosed)
  await Promise.allSettled(pending)
  for (const socket of sockets) socket.destroy()
  sockets = []
  socketsClosed = []
  pending = []
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
    delete savedEnv[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

type Run = Awaited<ReturnType<typeof runGitAsync>>

/** The same call through both runners, the async one tracked so a failed test still has it ended. */
async function both(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ sync: Run; async: Run }> {
  const sync = runGit(args, opts)
  const run = runGitAsync(args, { ...opts, signal: controller.signal })
  pending.push(run)
  return { sync, async: await run }
}

describe('runGit and runGitAsync agree', () => {
  it('on a success: stdout, empty stderr, exit 0, no timedOut key', async () => {
    const { sync, async } = await both(['rev-parse', '--is-inside-work-tree'], { cwd: repo })
    expect(sync, 'runGit result').toStrictEqual({ stdout: 'true\n', stderr: '', exitCode: 0 })
    expect(async, 'runGitAsync result, key for key').toStrictEqual(sync)
  })

  it('on a non-zero exit (unknown ref): git status 128, the fatal text, exit not -1', async () => {
    const { sync, async } = await both(['rev-parse', '--verify', 'refs/heads/no-such-ref-here'], { cwd: repo })
    expect(sync.exitCode, 'runGit exit is git\'s own fatal status').toBe(128)
    expect(sync.stderr, 'runGit stderr carries git\'s message').toMatch(/^fatal: /)
    expect(sync.stdout).toBe('')
    expect(async, 'runGitAsync result, key for key').toStrictEqual(sync)
  })

  it('on a working directory that is gone: exit -1, empty stdout, no timedOut, a spawn ENOENT message', async () => {
    const { sync, async } = await both(['--version'], { cwd: path.join(dir, 'no', 'such', 'dir') })
    expect(sync.exitCode, 'runGit exit').toBe(-1)
    expect(sync.stderr, 'runGit message names ENOENT').toMatch(/ENOENT/)
    expect(Object.keys(async).sort(), 'runGitAsync has the same keys').toStrictEqual(Object.keys(sync).sort())
    expect(async.exitCode).toBe(-1)
    expect(async.stdout).toBe('')
    expect(async.stderr, 'runGitAsync message names ENOENT').toMatch(/ENOENT/)
    expect(async.stderr.replace('spawn ', 'spawnSync '), 'the message differs only by the spawn call\'s name').toBe(sync.stderr)
  })

  it('on a git that is not on PATH: exit -1 with ENOENT, no timedOut, and the remembered executable dropped', async () => {
    const empty = path.join(dir, 'empty-bin')
    mkdirSync(empty)
    setEnv('PATH', empty)
    // The memory of git's location is keyed on PATH, so it is primed under the PATH in force, the call is made, and a lookup afterwards that has to ask again (one more call to find) shows the call dropped it.
    const lookupsAfter = async (call: () => unknown): Promise<number> => {
      let looks = 0
      const find = (): null => {
        looks++
        return null
      }
      gitExecutable('win32', find)
      const primed = looks
      await call()
      gitExecutable('win32', find)
      return looks - primed
    }
    let sync!: Run
    let async!: Run
    const syncLooks = await lookupsAfter(() => {
      sync = runGit(['--version'])
    })
    const asyncLooks = await lookupsAfter(async () => {
      const run = runGitAsync(['--version'], { signal: controller.signal })
      pending.push(run)
      async = await run
    })
    expect(sync.exitCode, 'runGit exit').toBe(-1)
    expect(sync.stderr, 'runGit message').toMatch(/ENOENT/)
    expect(Object.keys(async).sort(), 'runGitAsync has the same keys').toStrictEqual(Object.keys(sync).sort())
    expect(async.exitCode).toBe(-1)
    expect(async.stderr, 'runGitAsync message').toMatch(/ENOENT/)
    expect(syncLooks, 'runGit dropped the remembered executable on ENOENT').toBe(1)
    expect(asyncLooks, 'runGitAsync dropped the remembered executable on ENOENT').toBe(1)
  })

  it('on stdin input: cat-file --batch-check answers one line per id it was fed', async () => {
    expect(runGit(['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x\n' }).stdout.trim(), 'the blob is stored').toBe(BLOB_X)
    const missing = 'f'.repeat(40)
    const { sync, async } = await both(['cat-file', '--batch-check'], { cwd: repo, input: `${BLOB_X}\n${missing}\n` })
    expect(sync, 'runGit result').toStrictEqual({ stdout: `${BLOB_X} blob 2\n${missing} missing\n`, stderr: '', exitCode: 0 })
    expect(async, 'runGitAsync result, key for key').toStrictEqual(sync)
  })

  it('on input larger than a pipe buffer: every byte reaches git', async () => {
    // One megabyte exceeds the pipe buffer on every platform, so a write that is not drained or ended hangs the call; hash-object reads to the end of input.
    const input = 'y'.repeat(1 << 20)
    const { sync, async } = await both(['hash-object', '--stdin'], { cwd: repo, input })
    expect(sync.exitCode, sync.stderr).toBe(0)
    expect(sync.stdout.trim(), 'a sha1 of the whole input').toMatch(/^[0-9a-f]{40}$/)
    expect(async, 'runGitAsync result, key for key').toStrictEqual(sync)
  })

  it('on input that git exits without reading: runGitAsync returns git\'s own result, not a broken-pipe error', async () => {
    // DIVERGENCE, runGit side not asserted: on Windows (git 2.53, 3 of 3 runs) runGit returns exit -1 with stderr `spawnSync git EOF` for a 1 MiB input that git never reads, where git itself exited 0. Whether spawnSync reports the write failure depends on the platform, so only the async side is pinned: a stdin error must not replace a result git produced.
    const run = runGitAsync(['rev-parse', '--is-inside-work-tree'], { cwd: repo, input: 'z'.repeat(1 << 20), signal: controller.signal })
    pending.push(run)
    expect(await run, 'runGitAsync result').toStrictEqual({ stdout: 'true\n', stderr: '', exitCode: 0 })
  })

  it('on a maxBuffer overflow: exit -1, no timedOut, ENOBUFS in stderr, nothing in stdout', async () => {
    // runGit takes no buffer option and runGitAsync takes none either, so the smallest input that overflows is 201 MiB. The async side of this shape is asserted by run_git_async_reaps_tree.test.ts (the 200 MiB flood), with these same four expectations; streaming it again here would double the cost. No cwd: spawnSync kills git when the buffer overflows but cannot wait for the shell and node that git started, and a process that is still ending holds its working directory, so one started inside `dir` makes the removal of `dir` in afterEach fail with EPERM.
    const sync = runGit(['-c', 'alias.flood=!node "$TG_FLOOD"', 'flood'])
    expect(sync.exitCode, 'runGit exit').toBe(-1)
    expect(sync.timedOut, 'an overflow is not a timeout').toBeUndefined()
    expect(sync.stderr, 'runGit message').toMatch(/ENOBUFS/)
    expect(sync.stdout, 'nothing partial is returned').toBe('')
    await announced(1)
    const flood = JSON.parse(reports[0] as string) as { cwd: string }
    const rel = path.relative(dir, flood.cwd)
    expect(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)), `the flood ran in ${flood.cwd}, inside the directory afterEach removes`).toBe(false)
  })

  it('on a diff: the repository\'s external diff driver never runs, and the built-in diff is returned', async () => {
    // A driver that would write a marker file. `--ext-diff` after the injected `--no-ext-diff` wins, which is the control that the driver is live in this repository.
    writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=marker\n')
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    expect(runGit(['config', 'diff.marker.command', 'node "$TG_DRIVER"'], { cwd: repo }).exitCode).toBe(0)
    expect(runGit(['add', '.gitattributes', 'a.txt'], { cwd: repo }).exitCode).toBe(0)
    writeFileSync(path.join(repo, 'a.txt'), 'two\n')
    const marker = path.join(dir, 'marker')
    setEnv('TG_MARKER', marker)
    const control = runGit(['diff', '--ext-diff'], { cwd: repo })
    expect(control.exitCode, control.stderr).toBe(0)
    expect(existsSync(marker), 'control: the driver does run when asked to').toBe(true)
    rmSync(marker)
    const { sync, async } = await both(['diff'], { cwd: repo })
    expect(existsSync(marker), 'neither runner ran the driver').toBe(false)
    expect(sync.stdout, 'runGit returns the built-in unified diff').toContain('-one\n+two\n')
    expect(async, 'runGitAsync result, key for key').toStrictEqual(sync)
  })

  it('on fsmonitor: a repository setting is overridden to empty by both', async () => {
    expect(runGit(['config', 'core.fsmonitor', 'repo-hook'], { cwd: repo }).exitCode).toBe(0)
    const { sync, async } = await both(['config', '--get', 'core.fsmonitor'], { cwd: repo })
    expect(sync, 'runGit sees the command-line empty value, not the repository\'s').toStrictEqual({ stdout: '\n', stderr: '', exitCode: 0 })
    expect(async, 'runGitAsync result, key for key').toStrictEqual(sync)
  })
})

describe('runGitAsync settles on git\'s exit, not only on its pipes closing', () => {
  it('abort settles although a process that git did not wait for still holds stdout', async () => {
    // The alias starts a holder that outlives its parent and keeps the stdout pipe, then holds itself so git keeps running. Killing git's tree cannot reach the first holder, so only the exit event can settle the call. Red is the settle never arriving, which the test timeout ends; the afterEach then ends both holders through their sockets.
    const run = runGitAsync(['-c', 'alias.hold=!node "$TG_ORPHANER"; node "$TG_HOLDER"', 'hold'], { signal: controller.signal })
    pending.push(run)
    await announced(2)
    controller.abort()
    const result = await run
    expect(result.exitCode, 'an aborted call is exit -1').toBe(-1)
    expect(result.timedOut, 'an abort is not a timeout').toBeUndefined()
    expect(result.stderr).toBe('git was aborted')
  })
})
