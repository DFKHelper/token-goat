/** Matching rules for token-goat's resident processes: a stray is recognised by its command line and its launcher script, never by a process name. Fixtures: the daemon argv is FORMAT-DERIVED from src/worker_lifecycle.ts::startDetachedWorker (`[daemonEntryScript(), '--worker-daemon']`) and the hook server's from src/hook_client.ts::startServer (`[launcher, 'hook-server', 'run', '--slot', n]`); the quoted Windows interpreter path is the shape src/cli_doctor_process.ts documents for a real Windows command line; the ps rows are FORMAT-DERIVED from procps `ps -o pid=,ppid=,args=` (right-aligned pid and ppid, then the command line, no header). The must-not-match command lines are HAND-DERIVED from each shape a process list can show that merely contains the launcher path and the flag (a grep, a `sh -c` wrapper, a script argument, a path with the launcher as its tail, a longer flag), computed from the matching rule and not from the matcher; the two /proc/PID/stat lines and the ps row for a zombie are CAPTURE, taken on WSL Ubuntu (procps-ng 4.0.4) from `sh -c 'sleep 0 & exec sleep 4'` (the unreaped `sleep 0`) and from `cat` reading its own stat. */

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parsePsProcessList } from '../src/cli_doctor_process.js'
import { normalizePath } from '../src/paths.js'
import { classifyPosixPsRun, commandLineOf, isResidentOfInstall, isTokenGoatResidentProcess, queryProcessCommandLine, residentKindOf, statIsZombie, terminateProcessTree, zombiesInPsRows } from '../src/resident_process.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'

const ENTRY = process.platform === 'win32' ? 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\token-goat\\dist\\token-goat.mjs' : '/usr/lib/node_modules/token-goat/dist/token-goat.mjs'
const NODE = process.platform === 'win32' ? '"C:\\Program Files\\nodejs\\node.exe"' : '/usr/bin/node'
const WORKER = `${NODE} ${process.platform === 'win32' ? `"${ENTRY}"` : ENTRY} --worker-daemon`
const HOOK_SERVER = `${NODE} ${ENTRY} hook-server run --slot 1`

describe('residentKindOf', () => {
  it('names the worker daemon and the hook server, and nothing else', () => {
    expect(residentKindOf(WORKER)).toBe('worker')
    expect(residentKindOf(HOOK_SERVER)).toBe('hook-server')
    expect(residentKindOf(`${NODE} ${ENTRY} worker status`)).toBeNull()
    expect(residentKindOf(`${NODE} server.js`)).toBeNull()
    expect(isTokenGoatResidentProcess(WORKER)).toBe(true)
    expect(isTokenGoatResidentProcess('')).toBe(false)
  })
})

describe('isResidentOfInstall', () => {
  it('accepts a daemon started from this install and refuses one started from another', () => {
    expect(isResidentOfInstall(WORKER, ENTRY, ['worker'])).toBe(true)
    const other = WORKER.replace('token-goat', 'token-goat-other-install')
    expect(isResidentOfInstall(other, ENTRY, ['worker'])).toBe(false)
  })

  it('refuses a node process that carries the flag but runs another script', () => {
    expect(isResidentOfInstall(`${NODE} /tmp/decoy.js --worker-daemon`, ENTRY, ['worker', 'hook-server'])).toBe(false)
  })

  it('refuses a script whose name only starts with the launcher name', () => {
    expect(isResidentOfInstall(`${NODE} ${ENTRY}.bak --worker-daemon`, ENTRY, ['worker'])).toBe(false)
  })

  it('refuses every command line that only contains the launcher path and the flag', () => {
    const tailOfOtherPath = process.platform === 'win32' ? 'D:/x/' : '/mnt/backup'
    const lines = [
      `grep -- --worker-daemon ${ENTRY}`,
      `sh -c sleep 15 x ${ENTRY} --worker-daemon`,
      `/bin/sh -c ${NODE} ${ENTRY} --worker-daemon`,
      `${NODE} /home/u/tool.js ${ENTRY} --worker-daemon`,
      `${NODE} ${tailOfOtherPath}${ENTRY} --worker-daemon`,
      `${NODE} /var/lib/docker/overlay2/abc/merged${ENTRY} --worker-daemon`,
      `${NODE} ${ENTRY} --worker-daemon-other`,
      `${NODE} ${ENTRY} serve --worker-daemon`,
      `${NODE} ${ENTRY}x --worker-daemon`,
      `${NODE} ${ENTRY} hook-server run-other`,
      `${ENTRY} --worker-daemon`,
    ]
    for (const line of lines) expect(isResidentOfInstall(line, ENTRY, ['worker', 'hook-server']), line).toBe(false)
    expect(residentKindOf(`${NODE} ${ENTRY} --worker-daemon-other`)).toBeNull()
  })

  it('accepts the shapes the launchers really produce', () => {
    expect(isResidentOfInstall(`${process.execPath} ${ENTRY} --worker-daemon`, ENTRY, ['worker'])).toBe(true)
    expect(isResidentOfInstall(`${NODE} ${ENTRY} --worker-daemon --verbose`, ENTRY, ['worker'])).toBe(true)
    expect(isResidentOfInstall(`${NODE} "${ENTRY}" --worker-daemon`, ENTRY, ['worker'])).toBe(true)
    expect(isResidentOfInstall(`${NODE} ${ENTRY} hook-server run --slot 2`, ENTRY, ['hook-server'])).toBe(true)
    expect(isResidentOfInstall(`node ${ENTRY} --worker-daemon`, ENTRY, ['worker'])).toBe(true)
  })

  it('honours the kinds asked for', () => {
    expect(isResidentOfInstall(HOOK_SERVER, ENTRY, ['worker'])).toBe(false)
    expect(isResidentOfInstall(HOOK_SERVER, ENTRY, ['hook-server'])).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('reads a Windows command line whatever its slashes and case', () => {
    expect(isResidentOfInstall(normalizePath(WORKER).toLowerCase(), ENTRY, ['worker'])).toBe(true)
  })
})

describe('command-line query states', () => {
  // Provenance: HAND-DERIVED. The ps exit codes and stderr texts are the ones classifyPosixPsRun's doc comment names (procps and macOS adv_cmds-237 ps.c); the platform argument is passed explicitly, so every branch runs on every host.
  const noKernelAnswer = (): boolean => false
  it('classifies a POSIX ps run: exit 0 is found, an empty exit 1 is gone, and any other run is failed', () => {
    expect(classifyPosixPsRun({ status: 0, stdout: 'node x.js', stderr: '' }, 'linux', noKernelAnswer)).toEqual({ status: 'found', commandLine: 'node x.js' })
    expect(classifyPosixPsRun({ status: 1, stdout: '', stderr: '' }, 'linux', noKernelAnswer)).toEqual({ status: 'gone' })
    expect(classifyPosixPsRun({ status: 1, stdout: '', stderr: 'ps: process id too large: 99999999' }, 'darwin', noKernelAnswer)).toEqual({ status: 'failed' })
    expect(classifyPosixPsRun({ status: 1, stdout: '', stderr: 'ps: process id too large: 99999999' }, 'darwin', () => true)).toEqual({ status: 'gone' })
    expect(classifyPosixPsRun({ status: 2, stdout: '', stderr: 'ps: bad option' }, 'linux', noKernelAnswer)).toEqual({ status: 'failed' })
    expect(classifyPosixPsRun({ status: null, stdout: '', stderr: '' }, 'linux', noKernelAnswer)).toEqual({ status: 'failed' })
  })

  it('reads a process that exited and was reaped as gone, not failed', () => {
    const done = spawnSync(process.execPath, ['-e', '0'])
    expect(queryProcessCommandLine(done.pid ?? 0)).toEqual({ status: 'gone' })
  })

  it('folds only a found, non-empty line to a string, and every other state to null', () => {
    expect(commandLineOf({ status: 'found', commandLine: 'node x.js' })).toBe('node x.js')
    expect(commandLineOf({ status: 'found', commandLine: '' })).toBeNull()
    expect(commandLineOf({ status: 'gone' })).toBeNull()
    expect(commandLineOf({ status: 'failed' })).toBeNull()
  })
})

describe('kill decision per query state', () => {
  // Provenance: HAND-DERIVED. The failed state is stood in for by the readCommandLine seam returning null, the seam's documented meaning (the query failed); the gone state is a real exited child, and the live state a real sleeper. Each signal would reach a real process, so a missed kill is checked by the sleeper staying alive.
  it('leaves a gone process alone and returns false without probing', () => {
    const done = spawnSync(process.execPath, ['-e', '0'])
    expect(killIfCommandLine(done.pid ?? 0, () => true)).toBe(false)
  })

  it('throws, and leaves a live process unsignalled, when its query failed', async () => {
    const live = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true })
    const exited = once(live, 'exit')
    try {
      const pid = live.pid ?? 0
      expect(() => killIfCommandLine(pid, () => true, { readCommandLine: () => null })).toThrow(`pid ${pid}: its command line could not be read`)
      expect(live.signalCode).toBeNull()
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      live.kill()
      await exited
    }
  })

  it('returns false, signalling nothing, when its query failed on a process that has since exited', () => {
    const done = spawnSync(process.execPath, ['-e', '0'])
    expect(killIfCommandLine(done.pid ?? 0, () => true, { readCommandLine: () => null })).toBe(false)
  })
})

describe('queryProcessCommandLine', () => {
  // Provenance: HAND-DERIVED. This process is alive and its pid is known to the system; 2147483646 is above any pid either platform assigns, so no process holds it.
  it('tells a live process from one that does not exist, instead of folding both into null', () => {
    const own = queryProcessCommandLine(process.pid)
    expect(own.status).toBe('found')
    expect(own.status === 'found' ? own.commandLine.toLowerCase() : '').toContain('node')
    expect(queryProcessCommandLine(2147483646)).toEqual({ status: 'gone' })
    expect(queryProcessCommandLine(0)).toEqual({ status: 'gone' })
  })

  // Provenance: CAPTURE of the failure, HAND-DERIVED launcher. The code points are U+00E9 and U+4E2D, which OEM code page 437 cannot hold (é is 0x82 there, 中 has no byte and becomes 0x3F); the unfixed query on Windows PowerShell 5.1.26100 (powershell.exe, console code page 437) returned the bytes 82 3f for them and a line that did not contain the launcher, and the same script with a UTF-8 OutputEncoding returned c3 a9 e4 b8 ad (run 2026-10-18 as: powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $id = <pid of a node launcher under that path>; $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); 'found:' + $p.CommandLine", with and without the prefix [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; then the stdout bytes after the launcher directory's name prefix were hexed). The child ends when its stdin closes, and its temp dir is removed after it exits.
  it.skipIf(process.platform !== 'win32')('returns a launcher path with characters outside the OEM code page whole', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-oem-${String.fromCodePoint(0xe9, 0x4e2d)}-`))
    const launcher = path.join(dir, 'launcher.js')
    fs.writeFileSync(launcher, 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume()\n')
    const child = spawn(process.execPath, [launcher, '--worker-daemon'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.stdin.on('error', () => undefined)
    try {
      const answer = queryProcessCommandLine(child.pid ?? 0)
      expect(answer.status).toBe('found')
      expect(answer.status === 'found' ? answer.commandLine : '').toContain(launcher)
    } finally {
      const exited = once(child, 'exit')
      child.stdin.end()
      child.kill()
      await exited
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('terminateProcessTree', () => {
  it('signals nothing for pid 0, pid 1, this process or its parent', () => {
    for (const pid of [0, 1, -1, process.pid, process.ppid]) expect(terminateProcessTree(pid, true), String(pid)).toBe(false)
  })
})

describe('zombie detection', () => {
  it('reads the state letter after the last parenthesis of a /proc stat line', () => {
    const zombie = '772 (sleep) Z 768 497 497 34816 497 4227084 107 0 0 0 0 0 0 0 20 0 1 0 16132 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
    const running = '804 (cat) R 497 497 497 34816 497 4194304 79 0 0 0 0 0 0 0 20 0 1 0 16232 3362816 432 18446744073709551615 98649814609920'
    expect(statIsZombie(zombie)).toBe(true)
    expect(statIsZombie(running)).toBe(false)
    expect(statIsZombie('900 (a) Z b) S 1 1')).toBe(false)
    expect(statIsZombie('')).toBe(false)
  })

  it('reads zombies out of ps rows', () => {
    expect(zombiesInPsRows('    772 Z+\n    773 S\n  9001 Ss+\n')).toEqual([772])
    expect(zombiesInPsRows('')).toEqual([])
  })
})

describe('parsePsProcessList', () => {
  it('reads pid, parent pid and the whole command line of each row', () => {
    const rows = parsePsProcessList(['    1     0 /sbin/init splash', '12345   987 node /opt/token-goat/dist/token-goat.mjs --worker-daemon', '', 'garbage line'].join('\n'))
    expect(rows).toEqual([
      { processId: 1, parentProcessId: 0, name: 'init', commandLine: '/sbin/init splash' },
      { processId: 12345, parentProcessId: 987, name: 'node', commandLine: 'node /opt/token-goat/dist/token-goat.mjs --worker-daemon' },
    ])
  })
})
