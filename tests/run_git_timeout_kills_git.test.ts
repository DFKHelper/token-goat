// runGit's timeout killed only the process spawnSync started. On Windows that is Git for Windows' launcher (cmd/git.exe), which runs the real mingw64/bin/git.exe as a child, so the real git kept running in the caller's directory after runGit returned: compact.test.ts failed with EPERM removing its temp repo, and every timed-out hook git call left a stray git behind. The call below blocks inside git itself, waiting on a ref lock this test holds, so it outlives the timeout however fast the machine is.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sleepSync } from '../src/process_util.js'
import { runGit } from '../src/util.js'
import { awaitProcessExit } from './helpers/process_exit.js'

let repo: string
let traceDir: string
let marker: string

/** PIDs of live git processes whose command line contains `text`. Windows reads command lines through CIM, since tasklist cannot show them. */
function gitProcessesWith(text: string): string[] {
  if (process.platform === 'win32') {
    const powershell = path.join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const query = `Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { $_.CommandLine -like '*${text}*' } | ForEach-Object { $_.ProcessId }`
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.split('\n').filter((line) => line.includes(text)).map((line) => line.trim().split(/\s+/)[0] ?? '')
}

function removed(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function pollUntil(done: () => boolean, limitMs: number): boolean {
  const deadline = Date.now() + limitMs
  for (;;) {
    if (done()) return true
    if (Date.now() >= deadline) return false
    sleepSync(100)
  }
}

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-timeout-')))
  traceDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-timeout-trace-')))
  marker = `tg-timeout-${process.pid}-${Date.now()}`
  // The lock wait below is the files ref backend's; init.defaultRefFormat pins it on a git whose default is reftable and is ignored by one too old to know the key.
  expect(runGit(['-c', 'init.defaultRefFormat=files', 'init', '-q'], { cwd: repo }).exitCode).toBe(0)
  fs.mkdirSync(path.join(repo, '.git', 'refs', 'tg-test'))
  fs.writeFileSync(path.join(repo, '.git', 'refs', 'tg-test', `${marker}.lock`), '')
})

afterEach(() => {
  const left = gitProcessesWith(marker)
  const seen = Date.now()
  for (const pid of left) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true })
    else try { process.kill(Number(pid), 'SIGKILL') } catch { /* already exited */ }
  }
  // A killed git keeps its working directory in the repository and its GIT_TRACE file open until Windows has finished tearing it down.
  awaitProcessExit(new Map(left.map((pid) => [Number(pid), seen])))
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(traceDir, { recursive: true, force: true })
})

describe('runGit timeout', () => {
  it('kills git itself, so no git keeps running in the repository after the call returns', () => {
    // A blob rather than a commit: a commit can start a detached `git maintenance run --auto` that would hold the repository open on its own.
    const started = Date.now()
    const blob = runGit(['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x' })
    expect(blob.exitCode).toBe(0)
    // Three times a measured warm git run plus a second, so a loaded machine slow to start git still reaches the lock wait before the kill.
    const timeoutMs = Math.max(1500, (Date.now() - started) * 3 + 1000)

    const trace = path.join(traceDir, 'trace.txt')
    process.env['GIT_TRACE'] = trace
    let res: ReturnType<typeof runGit>
    try {
      res = runGit(['-c', 'core.filesRefLockTimeout=60000', 'update-ref', `refs/tg-test/${marker}`, blob.stdout.trim()], { cwd: repo, timeoutMs })
    } finally {
      delete process.env['GIT_TRACE']
    }

    expect(res.exitCode).toBe(-1)
    expect(res.stderr).toMatch(/ETIMEDOUT/)
    // Written by git when it dispatches the builtin, before the lock wait: proves the kill landed while git was blocked, not before it started.
    expect(fs.readFileSync(trace, 'utf8')).toContain(`update-ref refs/tg-test/${marker}`)
    expect(pollUntil(() => gitProcessesWith(marker).length === 0, 10_000), 'a git process outlived the timeout').toBe(true)
    expect(pollUntil(() => removed(repo), 10_000), 'the repository stayed in use after the timeout').toBe(true)
  })
})
