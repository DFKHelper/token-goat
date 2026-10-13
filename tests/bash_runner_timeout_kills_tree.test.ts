/** The compress runner's timeout killed only the shell it spawned: `child.kill()` (and spawnSync's own `timeout` on the `--no-compress` path) terminates that one process, so the command the shell was running, and anything it had started, kept going after the runner reported exit 124. That held on Windows, where the shell is Git Bash, and on POSIX, where it is /bin/sh. Each test runs a shell whose foreground command is a node process that records its pid and then waits a minute, lets the timeout fire, and checks that the recorded process is gone. The compressed path runs in-process through `run` with nothing injected; the streamed path drives the built bundle's `compress --no-compress`. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const DATA_DIR_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-br-tree-data-'))
const _savedLocal = process.env['LOCALAPPDATA']
const _savedXdg = process.env['XDG_DATA_HOME']
process.env['LOCALAPPDATA'] = DATA_DIR_TMP
process.env['XDG_DATA_HOME'] = DATA_DIR_TMP
const { run, runRaw } = await import('../src/bash_runner.js')
if (_savedLocal === undefined) delete process.env['LOCALAPPDATA']
else process.env['LOCALAPPDATA'] = _savedLocal
if (_savedXdg === undefined) delete process.env['XDG_DATA_HOME']
else process.env['XDG_DATA_HOME'] = _savedXdg

let scriptDir: string
/** Seconds the runner waits before it kills the command: three times a measured warm run plus a second, never under 1.5, so the recorded process has started before the kill. */
let budget: number
const started: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A shell command whose foreground job is a node process that writes its pid to `pidFile` and then outlives any budget. The trailing `echo` keeps the shell from exec'ing node in its own place, so node is the shell's child, not the process the runner spawned. Node's output goes to /dev/null so a survivor cannot hold the runner's pipes open, which would turn a missed kill into a hung run instead of a failed assertion. */
function lingeringChild(pidFile: string): string {
  const js = path.join(scriptDir, `${path.basename(pidFile)}.js`)
  fs.writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetTimeout(() => {}, 60000)\n`)
  return `"${process.execPath}" "${js}" >/dev/null 2>&1; echo after`
}

/** The pid the lingering child recorded, once the runner has returned. */
function recordedPid(pidFile: string): number {
  expect(fs.existsSync(pidFile), 'the child never started; the budget is too small to test the kill').toBe(true)
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  started.push(pid)
  return pid
}

/** Resolves once `pid` has exited, or after 20s. A process the kill reached is gone within a moment; one it missed lives on for the child's full minute. */
async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 20_000
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

beforeAll(async () => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-br-tree-'))
  const noop = path.join(scriptDir, 'noop.js')
  fs.writeFileSync(noop, '')
  await runRaw(`"${process.execPath}" "${noop}"`)
  const t0 = Date.now()
  await runRaw(`"${process.execPath}" "${noop}"`)
  budget = Math.max(1.5, Math.round((3 * (Date.now() - t0) + 1000) / 100) / 10)
})

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      // already gone, which is the passing case
    }
  }
})

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true })
  fs.rmSync(DATA_DIR_TMP, { recursive: true, force: true })
})

describe('a compress timeout kills the whole process tree, not just the shell', () => {
  it('on the captured path', async () => {
    const pidFile = path.join(scriptDir, 'captured.pid')
    const code = await run(lingeringChild(pidFile), { filterName: 'generic', timeout: budget, writeStdout: () => {}, writeStderr: () => {} })
    expect(code).toBe(124)
    expect(await waitForExit(recordedPid(pidFile))).toBe(true)
  })

  it('on the streamed --no-compress path of the built bundle', async () => {
    const pidFile = path.join(scriptDir, 'streamed.pid')
    const res = spawnSync(process.execPath, [BUNDLE, 'compress', '--no-compress', '--timeout', String(budget), '--cmd', lingeringChild(pidFile)], {
      env: { ...process.env, LOCALAPPDATA: DATA_DIR_TMP, XDG_DATA_HOME: DATA_DIR_TMP },
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(res.status, res.stderr).toBe(124)
    expect(await waitForExit(recordedPid(pidFile))).toBe(true)
  })
})
