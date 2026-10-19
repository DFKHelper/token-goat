/** Recognising, reading and ending token-goat's own resident background processes (the worker daemon and the hook servers) by command line. A process counts only when its command line both names a resident entry (`--worker-daemon`, `hook-server run`) and names this install's launcher script, never on its name alone: a node process that is not ours must never be signalled. Imports only Node built-ins and the Windows helpers, so worker_lifecycle.ts can use it on a hook's eager path. */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

import { powerShellTextQueryArgs, windowsPowerShellPath } from './windows_powershell.js'
import { windowsSystem32Exe } from './windows_system32.js'

export type ResidentKind = 'worker' | 'hook-server'

/** How long a one-process query or a taskkill may run. */
export const PROCESS_QUERY_TIMEOUT_MS = 15_000

/** Which resident token-goat process a command line starts, or null when it starts neither. */
export function residentKindOf(cmd: string): ResidentKind | null {
  if (/--worker-daemon(?![\w-])/.test(cmd)) return 'worker'
  if (/\bhook-server\s+run(?![\w-])/.test(cmd)) return 'hook-server'
  return null
}

/** Determines whether a process command line belongs to one of token-goat's resident background processes (such as the detached indexer worker daemon or the detached hook server). */
export function isTokenGoatResidentProcess(cmd: string): boolean {
  return residentKindOf(cmd) !== null
}

function foldForMatch(text: string): string {
  const slashed = text.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

const NODE_EXECUTABLE = /^(?:node|nodejs)(?:\.exe)?$/i

/** What follows the executable in `cmd` when that executable is a node binary, else null. The executable is a quoted string, this process's own node path (which may hold spaces, and `ps` does not quote), or the first whitespace-free token; its last path segment must be node, so `sh -c ... node` is not node. */
function afterNodeExecutable(cmd: string): string | null {
  const text = cmd.trimStart()
  let exe: string
  let rest: string
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, 1)
    if (close < 0) return null
    exe = text.slice(1, close)
    rest = text.slice(close + 1)
  } else if (foldForMatch(text).startsWith(foldForMatch(process.execPath)) && /^\s/.test(text.slice(process.execPath.length))) {
    exe = process.execPath
    rest = text.slice(process.execPath.length)
  } else {
    const token = /^\S+/.exec(text)
    if (token === null) return null
    exe = token[0]
    rest = text.slice(exe.length)
  }
  if (rest !== '' && !/^\s/.test(rest)) return null
  return NODE_EXECUTABLE.test(exe.split(/[\\/]/).pop() ?? '') ? rest : null
}

/** True when `cmd` is exactly `node <entryScript> <kind token>` [more arguments]: argv[0] a node binary, argv[1] equal to the launcher of this install (slashes normalised, case ignored on Windows), and the next argument exactly `--worker-daemon` or `hook-server run`. A line that merely contains these words, as `grep -- --worker-daemon <launcher>` or `sh -c "... <launcher> --worker-daemon"` does, is not a resident process, and neither is one run from another install, so two installs sharing a machine never retire each other's processes. */
export function isResidentOfInstall(cmd: string, entryScript: string, kinds: readonly ResidentKind[]): boolean {
  const rest = afterNodeExecutable(cmd)
  if (rest === null) return false
  const args = foldForMatch(rest.trimStart())
  const script = foldForMatch(entryScript)
  const quote = args[0] === '"' || args[0] === "'" ? args[0] : ''
  if (!args.startsWith(script, quote.length)) return false
  let tail = args.slice(quote.length + script.length)
  if (quote !== '') {
    if (tail[0] !== quote) return false
    tail = tail.slice(1)
  }
  if (!/^\s/.test(tail)) return false
  const kind = /^\s+(?:(--worker-daemon)|(hook-server\s+run))(?=\s|$)/.exec(tail)
  if (kind === null) return false
  return kinds.includes(kind[1] === undefined ? 'hook-server' : 'worker')
}

/** What asking the system for one process's command line found: the line (empty when the process exists but the system would not show it), that no such process exists, or that the question itself failed. A reader that folds the last two into one null is the bug class that let a failed query pass as a dead process. */
export type CommandLineQuery = { readonly status: 'found'; readonly commandLine: string } | { readonly status: 'gone' } | { readonly status: 'failed' }

const WINDOWS_GONE_MARK = 'gone'
const WINDOWS_FOUND_MARK = 'found:'

/** What one `ps -ww -o args= -p PID` run left behind: its exit status (null when it was killed or never started), trimmed stdout and raw stderr. */
export type PsRun = { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/** Whether the kernel itself reports no process `pid`: `process.kill(pid, 0)` sends no signal and throws ESRCH only when there is no such process, while EPERM means the process exists and is not ours (Node's process.kill documents signal 0 as the existence test; kill(2) names ESRCH and EPERM). Any other throw, as a pid Node refuses, is not evidence of absence. */
export function processAbsentInKernel(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Reads one POSIX `ps -p` run. Exit 0 is the command line. Exit 1 with nothing on stdout or stderr is the pid not existing, which Linux procps and the macOS ps (adv_cmds-237 ps.c: nkept == 0 reaches exit(1) after printheader, which prints nothing when every column header is empty) both do. macOS also exits 1 for a pid above its 99999 ceiling, but with "ps: process id too large: N" on stderr (adv_cmds-237 ps.c addelem_pid, then exit(1) on optfatal), which a bare stderr test reads as a failed query; there only the kernel's ESRCH, asked through `absentInKernel`, counts as proof of absence. Every other outcome stays failed, so a query that told us nothing is never taken for a dead process. */
export function classifyPosixPsRun(run: PsRun, platform: NodeJS.Platform, absentInKernel: () => boolean): CommandLineQuery {
  if (run.status === 0) return { status: 'found', commandLine: run.stdout }
  if (run.status !== 1 || run.stdout !== '') return { status: 'failed' }
  if (run.stderr.trim() === '') return { status: 'gone' }
  return platform === 'darwin' && absentInKernel() ? { status: 'gone' } : { status: 'failed' }
}

/** Looks up the command line of process `pid`, telling a process that does not exist from a query that did not work. Windows: the CIM row is absent for a gone process and an error stops the script (non-zero exit). POSIX: `ps -p` exits 1 with no output and no error text for a pid that does not exist, and anything else non-zero, or a spawn error, is a failure; macOS also exits 1 but names a pid above its 99999 ceiling on stderr, which {@link classifyPosixPsRun} settles by asking the kernel. */
export function queryProcessCommandLine(pid: number): CommandLineQuery {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'gone' }
  const win = process.platform === 'win32'
  const file = win ? windowsPowerShellPath() : 'ps'
  // The script's 'gone' and 'found:' are spelled out to match WINDOWS_GONE_MARK and WINDOWS_FOUND_MARK above, since the pid is the only value this template may interpolate (the hand-quoted-value guard). Windows PowerShell 5.1 writes a pipe in the console's OEM code page (437 here), where a launcher path with an accented or non-Latin character comes back as 0x82 or '?' and never matches the install's entry script; UTF-8 without a BOM is what the decode below reads.
  const script = `$ErrorActionPreference = 'Stop'; $id = ${pid}; $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if ($null -eq $p) { 'gone' } else { 'found:' + $p.CommandLine }`
  const args = win ? powerShellTextQueryArgs(script) : ['-ww', '-o', 'args=', '-p', String(pid)]
  const res = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: PROCESS_QUERY_TIMEOUT_MS })
  if (res.error !== undefined) return { status: 'failed' }
  const out = res.stdout.trim()
  if (win) {
    if (res.status !== 0) return { status: 'failed' }
    if (out === WINDOWS_GONE_MARK) return { status: 'gone' }
    return out.startsWith(WINDOWS_FOUND_MARK) ? { status: 'found', commandLine: out.slice(WINDOWS_FOUND_MARK.length).trim() } : { status: 'failed' }
  }
  return classifyPosixPsRun({ status: res.status, stdout: out, stderr: res.stderr }, process.platform, () => processAbsentInKernel(pid))
}

/** Stands a reader that folds gone and failed into one null in for {@link queryProcessCommandLine}: null reads as gone, so a caller handed such a reader (a test seam) never sees a failure. */
export function lineReaderAsQuery(read: (pid: number) => string | null): (pid: number) => CommandLineQuery {
  return (pid) => {
    const line = read(pid)
    return line === null ? { status: 'gone' } : { status: 'found', commandLine: line }
  }
}

/** The command line of process `pid`, or null when it cannot be read (gone, not ours, or the query failed); a caller that must tell those apart uses {@link queryProcessCommandLine}. */
export function readProcessCommandLine(pid: number): string | null {
  const found = queryProcessCommandLine(pid)
  return found.status === 'found' && found.commandLine !== '' ? found.commandLine : null
}

/** Whether /proc lists processes here, which makes {@link zombiePids} a file read instead of a `ps` run. */
const HAS_PROCFS = process.platform === 'linux'

/** True when the text of /proc/PID/stat shows state Z: the state letter follows the last `)`, because the command name before it may itself hold parentheses and spaces. */
export function statIsZombie(stat: string): boolean {
  const close = stat.lastIndexOf(')')
  return close >= 0 && stat.slice(close + 2, close + 3) === 'Z'
}

/** The zombie pids in the rows `ps -o pid=,stat=` prints: a state starting with Z. */
export function zombiesInPsRows(stdout: string): number[] {
  return stdout.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\S+)/.exec(line)
    return row !== null && row[2]?.startsWith('Z') === true ? [Number(row[1])] : []
  })
}

/** The pids among `pids` that are zombies: exited but not yet reaped by their parent, which `kill(pid, 0)` still reports as alive. Reads /proc on Linux; elsewhere on POSIX runs one `ps` unless `cheapOnly`, which answers none there. Always none on Windows, which has no zombies. */
export function zombiePids(pids: readonly number[], cheapOnly: boolean): number[] {
  if (process.platform === 'win32' || pids.length === 0) return []
  if (HAS_PROCFS) {
    return pids.filter((pid) => {
      try {
        return statIsZombie(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
      } catch {
        return false
      }
    })
  }
  if (cheapOnly) return []
  const res = spawnSync('ps', ['-o', 'pid=,stat=', '-p', pids.join(',')], { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS })
  return res.error !== undefined || typeof res.stdout !== 'string' ? [] : zombiesInPsRows(res.stdout)
}

/** Ends process `pid` and its children. Windows: `taskkill /T /F`, which is always forceful. POSIX: the signal to the process group the detached daemon leads, else to the pid alone; SIGTERM unless `force`. True when the OS accepted the request, not when the process is already gone. */
export function terminateProcessTree(pid: number, force: boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return false
  if (process.platform === 'win32') {
    const res = spawnSync(windowsSystem32Exe('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: PROCESS_QUERY_TIMEOUT_MS })
    return res.error === undefined && res.status === 0
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    // Not a group leader (or the group is gone): signal the pid itself.
  }
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}
