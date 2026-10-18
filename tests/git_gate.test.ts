// Provenance: CAPTURE. The behaviours asserted here (a git blocked reading a config include served by a named pipe or a FIFO, released by the serving end closing, answering normally afterwards, and holding() turning false once the blocked git is killed) were first observed by running git directly on this machine's Windows git and on WSL Ubuntu git; each case then runs the real git through the helper and checks its own answer.
/** tests/helpers/git_gate.ts blocks a real git on a gate until the test releases it. The hung-git tests rely on it holding a git for as long as the test wants and on releasing it exactly when told, so those properties are checked against a real git here. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openGitGate, type GitGate } from './helpers/git_gate.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'

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

async function gate(): Promise<GitGate> {
  const g = await openGitGate()
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

  it('reports a git as holding the gate while it is blocked, and not once it was killed or the gate released', async () => {
    const repo = gitRepoWithCommit()
    const g = await gate()
    expect(g.holding(), 'a gate no git has reached reported a holder').toBe(false)
    const run = revParse(repo, g.env)
    await g.reached
    expect(g.holding(), 'a git blocked on the gate was not reported holding').toBe(true)
    run.child.kill('SIGKILL')
    await run.settled
    // Read until the gate stops reporting the killed git: on Windows the close of its pipe reaches this process as an event a turn or two after the git is gone.
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
})
