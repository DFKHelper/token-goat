import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { directShellRun, PARALLEL_HELPER } from '../src/hook_selftest.js'
import { killAllIfCommandLine } from './helpers/kill_if_command_line.js'

// Provenance: HAND-DERIVED. The holder stands in for the resident hook server a hook shim starts inside a self-test job: on Windows that server inherits the job's pipe handles and keeps them for its whole life (measured: a clean `install --vscode -p` ran 90 s and more in 7 of 12 runs, the job's powershell exited after 4 s and its 'close' never came). The holder is given the job's stdout explicitly so the same hold happens on every platform.
const HOLDER = `
const fs = require('node:fs')
const release = process.argv[1]
fs.writeFileSync(process.argv[2], String(process.pid))
setInterval(() => { if (fs.existsSync(release)) process.exit(0) }, 50)
setTimeout(() => process.exit(0), Number(process.argv[3])).unref()
`

const JOB = `
const { spawn } = require('node:child_process')
// owner: the test below, which releases it through the release file and kills its tree in afterEach; dies when that file exists or after the cap in argv[3]
const holder = spawn(process.execPath, ['-e', ${JSON.stringify(HOLDER)}, process.argv[1], process.argv[2], process.argv[3]], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
holder.unref()
const wait = setInterval(() => { if (require('node:fs').existsSync(process.argv[2])) { clearInterval(wait); process.stdout.write('job-done') } }, 20)
`

const dirs: string[] = []
const holders: number[] = []
const helpers: ChildProcess[] = []
const watchers: NodeJS.Timeout[] = []

/** A recorded holder pid is ended only while its command line, read right now, carries this test's scratch directory name. */
const isOurHolder = (commandLine: string): boolean => commandLine.includes('tg-pipe-holder-')

afterEach(() => {
  for (const w of watchers.splice(0)) clearInterval(w)
  for (const h of helpers.splice(0)) h.kill('SIGKILL')
  killAllIfCommandLine(holders.splice(0), isOurHolder, { tree: true })
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function scratch(): { release: string; pidFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pipe-holder-'))
  dirs.push(dir)
  const pidFile = path.join(dir, 'holder.pid')
  // The holder's pid is recorded the moment it is written, so a row that fails or times out before its own assertions still kills it.
  const watcher = setInterval(() => {
    if (!fs.existsSync(pidFile)) return
    clearInterval(watcher)
    holders.push(Number(fs.readFileSync(pidFile, 'utf8')))
  }, 20)
  watchers.push(watcher)
  return { release: path.join(dir, 'release'), pidFile }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Result = { status: number | null; stdout: string; stderr: string }

async function runHelper(prelude: string, jobArgs: string[]): Promise<{ results: Result[]; holderPid: number }> {
  const pidFile = jobArgs[1]!
  const jobs = [{ program: process.execPath, args: ['-e', JOB, ...jobArgs], verbatim: false, input: '' }]
  const helper = spawn(process.execPath, ['-e', prelude + PARALLEL_HELPER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  helpers.push(helper)
  let out = ''
  helper.stdout.on('data', (d: Buffer) => (out += String(d)))
  // The job's own timeout is the only thing that could end a held job without the fix; it is far longer than a drained exit takes.
  helper.stdin.on('error', () => undefined)
  helper.stdin.end(JSON.stringify({ jobs, concurrency: 1, timeout: 20000, cwd: os.tmpdir() }))
  // The helper's answer, not its exit: with the pipe held the helper cannot exit either, so waiting for its exit would be a hang and not an assertion.
  await new Promise<void>((resolve) => {
    helper.stdout.on('data', () => {
      try {
        JSON.parse(out)
        resolve()
      } catch {
        // a partial body: more is coming
      }
    })
  })
  return { results: JSON.parse(out) as Result[], holderPid: Number(fs.readFileSync(pidFile, 'utf8')) }
}

describe('the self-test helper settles a job when it exits, not when its pipes close', () => {
  it('returns a job whose output pipe a surviving process still holds', async () => {
    const { release, pidFile } = scratch()
    const { results, holderPid } = await runHelper('', [release, pidFile, '120000'])
    expect(results[0]?.stderr, 'the job was ended by its timeout: the helper waited for the pipe a surviving process holds').not.toMatch(/timed out/)
    expect(results[0]?.status, 'the job exited 0; its result must say so').toBe(0)
    expect(alive(holderPid), 'the holder must still be alive when the helper returned, or the row proved nothing').toBe(true)
    fs.writeFileSync(release, '')
  })
})

describe('the direct fallback returns when the shell exits, not when its pipes close', () => {
  it('returns a shell whose output a surviving process still holds', () => {
    const { release, pidFile } = scratch()
    // The holder's own cap is short: with pipes the call waits for it and the row fails by the assertions below instead of hanging.
    const run = directShellRun({ program: process.execPath, args: ['-e', JOB, release, pidFile, '12000'], verbatim: false }, '', 20000)
    expect(run.stderr, 'the run was ended by its timeout').not.toMatch(/ETIMEDOUT|timed out/)
    expect(run.status).toBe(0)
    expect(run.stdout, 'the job output must come back').toBe('job-done')
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'the call returned only after the holder had gone: it waited on the pipe').toBe(true)
    fs.writeFileSync(release, '')
  })
})
