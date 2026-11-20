// Fixture provenance: HAND-DERIVED; the registered commands are built here and run in the host's shell.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as NodeChildProcess from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Every spawnSync still runs for real; the mock only records which program each one started.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof NodeChildProcess>()
  const passthrough = (...args: Parameters<typeof original.spawnSync>) => original.spawnSync(...args)
  return { ...original, spawnSync: vi.fn(passthrough) }
})

import { buildGuardedCommand } from '../src/hook_guard.js'
import { resolveWindowsBash } from '../src/shell.js'
import { terminateProcessTree } from '../src/resident_process.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import {
  PARALLEL_HELPER,
  realShellRunner,
  selftestRegisteredCommands,
  setHookSelftestRunnerForTesting,
} from '../src/hook_selftest.js'

const HAS_SH = realShellRunner('sh', ': probe', '') !== null
let dir: string
let script: string

function command(event: string): string {
  return buildGuardedCommand({
    shell: 'sh',
    native: [process.execPath.split(path.sep).join('/'), script.split(path.sep).join('/'), event],
    safe: '{}',
    marker: path.join(dir, `marker-${event}`).split(path.sep).join('/'),
  })
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-par-'))
  script = path.join(dir, 'hook.cjs')
  // Answers a JSON object for every event but `garbled`, which prints text no host accepts.
  fs.writeFileSync(script, "process.stdout.write(process.argv[2] === 'garbled' ? 'not json' : '{}')\n")
})

afterAll(() => {
  setHookSelftestRunnerForTesting(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.runIf(HAS_SH)('the self-test runs several registered commands at once in the real shell', () => {
  it('passes every command that answers and names only the one that does not', () => {
    setHookSelftestRunnerForTesting(undefined)
    const out = selftestRegisteredCommands([command('preToolUse'), command('garbled'), command('postToolUse')])
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toContain('garbled')
    // Guard version 4 serves only a blank or object answer, so the text falls through to the safe answer.
    expect(out.failures[0]).toContain('nothing could run')
    expect(out.tested).toBe(3)
    expect(out.skipped).toEqual([])
  })

  it('passes when every command answers', () => {
    setHookSelftestRunnerForTesting(undefined)
    const events = ['preToolUse', 'postToolUse', 'sessionStart']
    const out = selftestRegisteredCommands(events.map(command))
    expect(out.failures).toEqual([])
    expect(out.tested).toBe(3)
  })
})

const LIST_PS = "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + ' ' + $_.CommandLine }"

/** Pid and command line of every process; throws on an empty listing, which is unknown, not gone. */
function processCommandLines(): Array<{ pid: number; line: string }> {
  const listed = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        LIST_PS],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listed.status !== 0 || listed.stdout.trim() === '') {
    throw new Error(`process listing unknown: ${String(listed.stderr)}`)
  }
  return listed.stdout.split(/\r?\n/).flatMap((l) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l)
    return m === null ? [] : [{ pid: Number(m[1]), line: m[2]! }]
  })
}

const posix = (p: string): string => p.split(path.sep).join('/')

/** Resolves once `file` exists, on the directory's change events; rejects when the helper ends first. */
function fileAppears(file: string, helperEnded: Promise<HelperExit>): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) settle(resolve)
    })
    const settle = (finish: () => void): void => {
      watcher.close()
      finish()
    }
    watcher.on('error', (e) => settle(() => reject(e)))
    if (fs.existsSync(file)) settle(resolve)
    void helperEnded.then((h) => {
      settle(() => reject(new Error(`helper ended (code ${String(h.code)}) before ${file}: ${h.stderr}`)))
    })
  })
}

type HelperJob = { program: string; args: string[]; verbatim: boolean; input: string }

/** A shell job that forks a grandchild carrying `token` in its command line, notes that, then waits. */
function forkingJob(token: string, ready: string): HelperJob {
  // A shell, as in production (a Node parent's own job object would end its children on Windows).
  const shell = process.platform === 'win32' ? resolveWindowsBash()! : '/bin/sh'
  const node = posix(process.execPath)
  const forked = `'${node}' -e 'setInterval(() => {}, 1000)' ${token} & : > '${posix(ready)}'; wait`
  return { program: shell, args: ['-c', forked], verbatim: false, input: '' }
}

function killLeftovers(token: string): void {
  for (const p of processCommandLines().filter((q) => q.line.includes(token))) {
    killIfCommandLine(p.pid, (line) => line.includes(token), { tree: true })
  }
}

type Result = { status: number | null; stdout: string; stderr: string }
type HelperExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Starts the helper on `jobs` with an IPC channel; `done` resolves with its exit and output once it closes. */
function startHelper(jobs: HelperJob[]): { child: ChildProcess; done: Promise<HelperExit>; stop: () => void } {
  // owner: this test; the helper ends on its abort message or SIGTERM, and killLeftovers in the row's finally
  const child = spawn(process.execPath, ['-e', PARALLEL_HELPER], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  // The results are the helper's last output; its IPC channel would otherwise keep it alive.
  child.stdout!.on('data', (d: string) => {
    stdout += d
    if (child.connected) child.disconnect()
  })
  child.stderr!.on('data', (d: string) => { stderr += d })
  // Not the child's own 'close', which an open IPC channel can leave unfired after the streams have ended.
  const closed = (stream: NodeJS.ReadableStream): Promise<void> =>
    new Promise((resolve) => stream.on('close', () => resolve()))
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('exit', (code, signal) => resolve([code, signal]))
  })
  const done = Promise.all([exited, closed(child.stdout!), closed(child.stderr!)]).then(
    ([[code, signal]]): HelperExit => ({ code, signal, stdout, stderr }),
  )
  child.stdin!.on('error', () => undefined)
  child.stdin!.end(JSON.stringify({ jobs, concurrency: 1, timeout: 6000, cwd: os.tmpdir() }))
  // The handle holds the pid while the helper has neither exited nor been signalled, so its tree can be ended.
  const stop = (): void => {
    const live = child.exitCode === null && child.signalCode === null
    if (live && child.pid !== undefined) terminateProcessTree(child.pid, true)
  }
  return { child, done, stop }
}

describe.runIf(HAS_SH)('the parallel helper ends a running job together with everything it started', () => {
  it('leaves no process with the owner token once the owner aborts a job with a grandchild', async () => {
    const token = `tg-owner-${randomBytes(8).toString('hex')}`
    const ready = path.join(dir, `ready-${token}`)
    let stop = (): void => undefined
    try {
      // No queued job starts after an abort, so the scan runs after the exit: a leftover outlives the helper.
      const started = startHelper([forkingJob(token, ready)])
      const { child, done } = started
      stop = started.stop
      await fileAppears(ready, done)
      child.send('abort')
      const helper = await done
      expect(helper.code, `helper stderr: ${helper.stderr}`).toBe(0)
      const results = JSON.parse(helper.stdout) as Result[]
      expect(results[0]!.stderr).toContain('aborted')
      const listing = processCommandLines()
      expect(listing.length > 0, 'the listing was empty: unknown, not gone').toBe(true)
      const hits = listing.filter((q) => q.line.includes(token)).map((q) => q.line)
      expect(hits, 'processes still carrying the owner token after the helper ended').toEqual([])
    } finally {
      stop()
      killLeftovers(token)
    }
  })

  it.runIf(process.platform !== 'win32')('ends every job tree when the owner sends SIGTERM', async () => {
    const token = `tg-owner-${randomBytes(8).toString('hex')}`
    const ready = path.join(dir, `ready-${token}`)
    let stop = (): void => undefined
    try {
      const started = startHelper([forkingJob(token, ready)])
      const { child, done } = started
      stop = started.stop
      await fileAppears(ready, done)
      child.kill('SIGTERM')
      const helper = await done
      expect(helper.code, `helper signal ${String(helper.signal)}: the SIGTERM handler did not run`).toBe(143)
      expect(
        processCommandLines().filter((q) => q.line.includes(token)).map((q) => q.line),
        'processes still carrying the owner token after the helper ended',
      ).toEqual([])
    } finally {
      stop()
      killLeftovers(token)
    }
  })
})

/** `exited`: the shell exited but a descendant holds its streams (no 'close'); `closed`: it also closed. */
type ChildState = 'running' | 'exited' | 'closed'
type StubRun = { calls: string[]; spawns: number; body: string }

/** Runs the helper source under stub `require` and `process` values; resolves with its kills and spawns. */
function runHelperStub(
  platform: string,
  state: ChildState,
  opts: { jobs?: number; abort?: boolean } = {},
): Promise<StubRun> {
  const calls: string[] = []
  let spawns = 0
  const quiet = { setEncoding: (): void => undefined }
  const stdin = Object.assign(new EventEmitter(), quiet)
  const stubProc = Object.assign(new EventEmitter(), {
    platform,
    env: { SystemRoot: 'C:/Windows' },
    stdin,
    stdout: { write: (_body: string): boolean => true },
    kill: (pid: number, sig: string): void => { calls.push(`process.kill ${pid} ${sig}`) },
    exit: (): void => undefined,
  })
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: state === 'running' ? null : 0,
    signalCode: null,
    stdout: Object.assign(new EventEmitter(), quiet),
    stderr: Object.assign(new EventEmitter(), quiet),
    stdin: Object.assign(new EventEmitter(), { end: (): void => undefined }),
    kill: (): void => { calls.push('child.kill') },
  })
  return new Promise((resolve) => {
    const stubRequire = (name: string): unknown => {
      if (name === 'node:path') return path
      return {
        spawn: () => {
          spawns++
          return child
        },
        spawnSync: (program: string, args: string[]): void => { calls.push(`${program} ${args.join(' ')}`) },
      }
    }
    stubProc.stdout.write = (body: string): boolean => {
      resolve({ calls, spawns, body })
      return true
    }
    new Function('require', 'process', PARALLEL_HELPER)(stubRequire, stubProc)
    const job = { program: 'x', args: [], verbatim: false, input: '' }
    const jobs = Array.from({ length: opts.jobs ?? 1 }, () => job)
    const payload = { jobs, concurrency: 1, timeout: 1, cwd: '.' }
    stdin.emit('data', JSON.stringify(payload))
    stdin.emit('end')
    // Both run synchronously after the first job started, so the 1 ms timeout cannot fire before them.
    if (state === 'closed') child.emit('close', 0)
    if (opts.abort === true) stubProc.emit('message', 'abort')
  })
}

describe.runIf(HAS_SH)('a single real shell run goes through the helper that ends its tree', () => {
  it('starts one helper process and never the shell directly', () => {
    setHookSelftestRunnerForTesting(undefined)
    vi.mocked(spawnSync).mockClear()
    const run = realShellRunner('sh', 'printf ok', '')
    expect(run?.stdout).toBe('ok')
    const calls = vi.mocked(spawnSync).mock.calls
    const started = calls.map((c) => [String(c[0]), (c[1] as string[] | undefined) ?? []] as const)
    expect(started.map(([program]) => program)).toEqual([process.execPath])
    expect(started[0]![1]).toContain(PARALLEL_HELPER)
  })
})

describe('the parallel helper signals a child by whether it has closed', () => {
  it.each(['win32', 'linux'])('makes no kill call on %s after its child closed', async (platform) => {
    expect((await runHelperStub(platform, 'closed')).calls).toEqual([])
  })

  it('ends the process group on linux when the shell exited but its streams are still open', async () => {
    const { calls } = await runHelperStub('linux', 'exited')
    expect(calls, calls.join(' | ')).toContain('process.kill -4242 SIGKILL')
  })

  it('sends no taskkill and no child.kill on win32 when the shell exited with its streams open', async () => {
    const { calls } = await runHelperStub('win32', 'exited')
    expect(calls.filter((c) => /taskkill|child\.kill/.test(c)), calls.join(' | ')).toEqual([])
  })

  it.each([
    ['win32', /taskkill\.exe \/T \/F \/PID 4242/],
    ['linux', /process\.kill -4242 SIGKILL/],
  ])('still ends the tree on %s when the child is running', async (platform, want) => {
    const { calls } = await runHelperStub(platform, 'running')
    expect(calls.some((c) => want.test(c)), calls.join(' | ')).toBe(true)
  })
})

describe('the parallel helper stops its queue on an abort', () => {
  it('starts no queued job after the owner aborts and reports each as aborted', async () => {
    const { spawns, body } = await runHelperStub('linux', 'running', { jobs: 3, abort: true })
    expect(spawns, 'jobs started after the abort').toBe(1)
    const results = JSON.parse(body) as Array<{ status: number | null; stderr: string }>
    expect(results.map((r) => r.stderr)).toEqual(Array<string>(3).fill('aborted by the owner'))
  })
})
