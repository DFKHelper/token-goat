/** Matching rules for token-goat's resident processes: a stray is recognised by its command line and its launcher script, never by a process name. Fixtures: the daemon argv is FORMAT-DERIVED from src/worker_lifecycle.ts::startDetachedWorker (`[daemonEntryScript(), '--worker-daemon']`) and the hook server's from src/hook_client.ts::startServer (`[launcher, 'hook-server', 'run', '--slot', n]`); the quoted Windows interpreter path is the shape src/cli_doctor_process.ts documents for a real Windows command line; the ps rows are FORMAT-DERIVED from procps `ps -o pid=,ppid=,args=` (right-aligned pid and ppid, then the command line, no header). The must-not-match command lines are HAND-DERIVED from each shape a process list can show that merely contains the launcher path and the flag (a grep, a `sh -c` wrapper, a script argument, a path with the launcher as its tail, a longer flag), computed from the matching rule and not from the matcher; the two /proc/PID/stat lines and the ps row for a zombie are CAPTURE, taken on WSL Ubuntu (procps-ng 4.0.4) from `sh -c 'sleep 0 & exec sleep 4'` (the unreaped `sleep 0`) and from `cat` reading its own stat. */

import { describe, expect, it } from 'vitest'

import { parsePsProcessList } from '../src/cli_doctor_process.js'
import { normalizePath } from '../src/paths.js'
import { isResidentOfInstall, isTokenGoatResidentProcess, readProcessCommandLine, residentKindOf, statIsZombie, terminateProcessTree, zombiesInPsRows } from '../src/resident_process.js'

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

describe('readProcessCommandLine', () => {
  it('reads the command line of a live process, and null for one that does not exist', () => {
    const own = readProcessCommandLine(process.pid)
    expect(own, 'the command line of this test process').not.toBeNull()
    expect((own ?? '').toLowerCase()).toContain('node')
    expect(readProcessCommandLine(0)).toBeNull()
    expect(readProcessCommandLine(-5)).toBeNull()
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
