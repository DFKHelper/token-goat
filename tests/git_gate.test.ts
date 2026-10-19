// Provenance: CAPTURE. The behaviours asserted here (a git blocked reading a config include served by a named pipe or a FIFO, released by the serving end closing, answering normally afterwards, and holding() turning false once the blocked git is killed) were first observed by running git directly on this machine's Windows git and on WSL Ubuntu git; each case then runs the real git through the helper and checks its own answer.
/** tests/helpers/git_gate.ts blocks a real git on a gate until the test releases it. The hung-git tests rely on it holding a git for as long as the test wants and on releasing it exactly when told, so those properties are checked against a real git here. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { killProcessTree } from '../src/process_tree.js'
import { openGitGate, type GitGate } from './helpers/git_gate.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { processAlive } from './helpers/process_alive.js'

interface Run {
  readonly child: ChildProcess
  readonly settled: Promise<{ code: number | null; stdout: string }>
  readonly hasExited: () => boolean
}

const gates: GitGate[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
  for (const gate of gates.splice(0)) await gate.dispose()
})

async function gate(passFirst?: number): Promise<GitGate> {
  const g = await openGitGate(passFirst === undefined ? {} : { passFirst })
  gates.push(g)
  return g
}

function revParse(cwd: string, env: Readonly<Record<string, string>>): Run {
  const child = spawn('git', ['rev-parse', '--show-toplevel'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  let stdout = ''
  let exited = false
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
  })
  const settled = new Promise<{ code: number | null; stdout: string }>((resolve) => {
    child.once('close', (code) => {
      exited = true
      resolve({ code, stdout })
    })
  })
  return { child, settled, hasExited: () => exited }
}

const execFileAsync = promisify(execFile)

/** The pids of everything below *root* in the process table, read through PowerShell on Windows and ps elsewhere; a table that cannot be read fails the row, because an empty list would pass the check that nothing of the tree survives. */
async function descendantsOf(root: number): Promise<number[]> {
  const listing = process.platform === 'win32'
    ? await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { windowsHide: true })
    : await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='])
  const children = new Map<number, number[]>()
  for (const line of listing.stdout.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    children.set(ppid as number, [...(children.get(ppid as number) ?? []), pid as number])
  }
  expect(children.size, 'the process table listed no process').toBeGreaterThan(0)
  const found: number[] = []
  for (const queue = [root]; queue.length > 0;) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/** Resolves once no pid of *pids* names a running process after the tree of *child* was killed. A SIGKILL is delivered, not completed, when the call returns: on Linux a process it was sent to is still running for a moment, more of it under load, so a check made at once names a process that is already dying. The child is waited on through its 'exit' event, which also reaps it; any other member is read until it is gone, and *named* is told which ones are still running, so a member that never leaves is named by the failure of the row that waits. */
async function untilGone(child: ChildProcess, pids: readonly number[], named: (running: readonly number[]) => void): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  for (let running = pids.filter(processAlive); running.length > 0; running = pids.filter(processAlive)) {
    named(running)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** The git's result, asserted to have come without the gate holding it: the git ends or the gate holds it, whichever comes first, so a gate that held a read it was to pass names that read, instead of leaving the row waiting on a git it holds. */
async function endedUnheld(run: Run, g: GitGate, what: string): Promise<{ code: number | null; stdout: string }> {
  const outcome = await Promise.race([run.settled.then((result) => ({ result })), g.reached.then((read) => ({ read }))])
  expect('read' in outcome ? `held at read ${outcome.read}` : 'ended', what).toBe('ended')
  return run.settled
}

describe('openGitGate', () => {
  it('holds a real git until released, then lets it answer as it would without the gate', async () => {
    const repo = gitRepoWithCommit()
    const g = await gate()
    const run = revParse(repo, g.env)
    await g.reached
    expect(run.hasExited(), 'git finished before the gate was released').toBe(false)
    g.release()
    const result = await run.settled
    expect(result.code).toBe(0)
    expect(path.resolve(result.stdout.trim())).toBe(path.resolve(repo))
  })

  it('lets a git that arrives after the release straight through', async () => {
    const repo = gitRepoWithCommit()
    const g = await gate()
    g.release()
    const result = await revParse(repo, g.env).settled
    expect(result.code).toBe(0)
  })

  it('disposes twice, and frees a git still blocked on it', async () => {
    const repo = gitRepoWithCommit()
    const g = await gate()
    const run = revParse(repo, g.env)
    await g.reached
    await g.dispose()
    await g.dispose()
    expect((await run.settled).code).toBe(0)
  })

  // CAPTURE: on Windows, with Git for Windows' cmd directory first on PATH, the git spawned is cmd/git.exe, which starts mingw64/bin/git.exe and waits for it; that second process holds the gate. Killing only the spawned one ended the wrapper ('exit' fired) and left the holder blocked with the inherited stdout open, so neither the child's 'close' nor the gate's connection close ever came. The row ends the whole tree, as src/process_tree.ts does for the product's gits, and waits for every process of the tree to leave before it waits on either close, naming the ones that do not. CAPTURE: on Linux under CPU load (24 busy shells on 8 CPUs, WSL Ubuntu, 12 of 15 runs) a check made as killProcessTree returned failed with `processes of the blocked git still ran after its tree was ended: expected [ 1738 ] to deeply equal []`, because a SIGKILLed process is still running until the kernel finishes ending it.
  it('reports a git as holding the gate while it is blocked, and not once it was killed or the gate released', async (ctx) => {
    let step = 'making the repository and the gate'
    ctx.onTestFailed(({ task }) => {
      const error = task.result?.errors?.[0]
      if (error !== undefined) error.message = `${error.message}\nlast step begun: ${step}`
    })
    const repo = gitRepoWithCommit()
    const g = await gate()
    step = 'asking a gate no git has reached'
    expect(g.holding(), 'a gate no git has reached reported a holder').toBe(false)
    const run = revParse(repo, g.env)
    step = 'waiting for the git to reach the gate'
    await g.reached
    expect(g.holding(), 'a git blocked on the gate was not reported holding').toBe(true)
    const root = run.child.pid
    expect(root, 'the git was not started').toBeDefined()
    step = 'reading the process table below the blocked git'
    const tree = [root as number, ...(await descendantsOf(root as number))]
    step = 'ending the tree of the blocked git'
    const ended = killProcessTree(run.child.pid)
    expect(ended.ok, `the tree of the blocked git was not ended: ${ended.note ?? 'no note'}`).toBe(true)
    step = 'waiting for the processes of the ended tree to leave'
    await untilGone(run.child, tree, (running) => { step = `waiting for pids ${running.join(', ')} of the ended tree to leave` })
    step = 'waiting for the killed git to close its output'
    await run.settled
    // Read until the gate stops reporting the killed git: on Windows the close of its pipe reaches this process as an event a turn or two after the git is gone.
    step = 'waiting for the gate to see the killed git leave'
    while (g.holding()) await new Promise<void>((resolve) => setImmediate(resolve))
    expect(g.holding(), 'a killed git was still reported holding').toBe(false)
  })

  // HAND-DERIVED: a FIFO reader (cat) sees exactly the bytes written to the FIFO, so empty output after many polls means the probe wrote none; the Windows gate is a named pipe cat cannot open.
  it.skipIf(process.platform === 'win32')('polls the holder without writing anything for the blocked reader to read', async () => {
    const g = await gate()
    const reader = spawn('cat', [g.env.GIT_CONFIG_VALUE_0 ?? ''], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(reader)
    let output = ''
    reader.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const ended = new Promise<void>((resolve) => reader.once('close', () => resolve()))
    await g.reached
    for (let polls = 0; polls < 200; polls++) expect(g.holding(), 'a blocked reader was not reported holding').toBe(true)
    g.release()
    await ended
    expect(output, 'polling the gate wrote bytes the reader received').toBe('')
  })

  it('reports no holder once the gate is released', async () => {
    const repo = gitRepoWithCommit()
    const g = await gate()
    const run = revParse(repo, g.env)
    await g.reached
    g.release()
    expect(g.holding(), 'a released gate reported a holder').toBe(false)
    expect((await run.settled).code).toBe(0)
  })

  it('counts the reads a git makes, and lets exactly that many through before holding the next git', async () => {
    const repo = gitRepoWithCommit()
    const counting = await gate(Number.MAX_SAFE_INTEGER)
    expect(counting.connections(), 'a gate nothing read reported reads').toBe(0)
    expect((await endedUnheld(revParse(repo, counting.env), counting, 'a gate that was to let every read through held the first git')).code).toBe(0)
    // A git may read its configuration more than once, so the count is of reads: whatever one rev-parse makes here, git's own business.
    const reads = counting.connections()
    expect(reads, 'a git that was let through left no read on the gate').toBeGreaterThan(0)
    expect((await endedUnheld(revParse(repo, counting.env), counting, 'a gate that was to let every read through held the second git')).code).toBe(0)
    expect(counting.connections(), 'the same git made a different number of reads the second time').toBe(reads * 2)
    expect(counting.holding(), 'a gate that let every read through held a git').toBe(false)

    const g = await gate(reads)
    const passed = await endedUnheld(revParse(repo, g.env), g, `the git whose ${reads} reads were to be passed was held`)
    expect(passed.code, 'the git whose reads were passed was not let through').toBe(0)
    expect(g.holding(), 'the git whose reads were passed was held').toBe(false)
    expect(g.connections(), 'the passed git did not make the measured reads').toBe(reads)
    const run = revParse(repo, g.env)
    expect(await g.reached, 'the gate held a read other than the first read after the ones it was to pass').toBe(reads + 1)
    expect(g.holding(), 'the git after the passed one was not held').toBe(true)
    expect(run.hasExited(), 'the held git finished before the release').toBe(false)
    g.release()
    expect((await run.settled).code).toBe(0)
  })
})
