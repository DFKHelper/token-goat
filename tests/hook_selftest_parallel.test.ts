// Fixture provenance: HAND-DERIVED; the registered commands are built here and run in the host's shell.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import { resolveWindowsBash } from '../src/shell.js'
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
    marker: path.join(dir, 'marker').split(path.sep).join('/'),
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
    expect(out.failures[0]).toContain('not a valid answer')
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

describe.runIf(HAS_SH)('the parallel helper ends a timed-out job together with everything it started', () => {
  it('leaves no process carrying the owner token once a job that forked a grandchild timed out', () => {
    const token = `tg-owner-${randomBytes(8).toString('hex')}`
    const halves = [token.slice(0, 12), token.slice(12)]
    const ready = path.join(dir, `ready-${token}`)
    // A shell, as in production (a Node parent's own job object would end its children on Windows), forks a
    // grandchild that carries the token in its command line, records that it did, then waits on it.
    const shell = process.platform === 'win32' ? resolveWindowsBash()! : '/bin/sh'
    const posix = (p: string): string => p.split(path.sep).join('/')
    const node = posix(process.execPath)
    const forked = `'${node}' -e 'setInterval(() => {}, 1000)' ${token} & : > '${posix(ready)}'; wait`
    // The second job lists every command line and reports those holding the token (given in two halves).
    const scan = [
      "const { spawnSync } = require('node:child_process')",
      'const token = process.argv[1] + process.argv[2]',
      "const r = process.platform === 'win32'",
      "  ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', " +
        JSON.stringify(LIST_PS) +
        "], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })",
      "  : spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 1 << 26 })",
      "const all = r.status === 0 ? r.stdout.split(/\\r?\\n/).filter((l) => l.trim() !== '') : []",
      'const hits = all.filter((l) => l.includes(token))',
      'process.stdout.write(JSON.stringify({ status: r.status, lines: all.length, hits }))',
    ].join('\n')
    try {
      const helper = spawnSync(process.execPath, ['-e', PARALLEL_HELPER], {
        input: JSON.stringify({
          jobs: [
            { program: shell, args: ['-c', forked], verbatim: false, input: '' },
            // Runs while the helper is still alive, so a leftover grandchild cannot die with the helper.
            { program: process.execPath, args: ['-e', scan, ...halves], verbatim: false, input: '' },
          ],
          concurrency: 1,
          timeout: 6000,
          cwd: os.tmpdir(),
        }),
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      })
      expect(helper.status, `helper stderr: ${helper.stderr}`).toBe(0)
      type Result = { status: number | null; stdout: string; stderr: string }
      const results = JSON.parse(helper.stdout) as Result[]
      expect(results[0]!.stderr).toContain('timed out')
      expect(fs.existsSync(ready), 'the fixture job never forked its grandchild before the timeout').toBe(true)
      expect(results[1]!.status, `scan job: ${results[1]!.stderr}`).toBe(0)
      const seen = JSON.parse(results[1]!.stdout) as { status: number | null; lines: number; hits: string[] }
      expect(seen.status === 0 && seen.lines > 0, 'the listing was empty: unknown, not gone').toBe(true)
      expect(seen.hits, 'processes still carrying the owner token while the helper ran').toEqual([])
    } finally {
      for (const p of processCommandLines().filter((q) => q.line.includes(token))) {
        killIfCommandLine(p.pid, (line) => line.includes(token), { tree: true })
      }
    }
  })
})
