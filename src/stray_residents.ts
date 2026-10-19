/** Ends the token-goat resident processes of this install that no pid file or reachable hook server names any more, and every other worker and hook server running this launcher under any data directory. A 2.9.30 worker daemon never exits on idle, and a reclaimed pid-file slot never signalled the daemon it replaced, so those daemons piled up with nothing left that could stop them: `worker stop` and `upgrade` act only on the pid-file pid and on hook servers that answer. The match is by command line (see resident_process.ts), against the process table doctor already reads. */

import { readAllProcesses } from './cli_doctor_process.js'
import { displaySafeText } from './paths.js'
import { type CommandLineQuery, isResidentOfInstall, lineReaderAsQuery, PROCESS_QUERY_TIMEOUT_MS, queryProcessCommandLine, terminateProcessTree, zombiePids, type ResidentKind } from './resident_process.js'
import { daemonEntryScript, pidAlive } from './worker_lifecycle.js'

/** What `upgrade` (and `doctor --fix`, through performUpgrade) ends: both resident kinds, since both hold the replaced files open. */
export const UPGRADE_RESIDENT_KINDS: readonly ResidentKind[] = ['worker', 'hook-server']

export interface RetireOptions {
  /** Which resident processes to end. */
  readonly kinds: readonly ResidentKind[]
  /** Pids to leave alone: the daemon the pid file names, which the caller has just stopped on purpose. */
  readonly skip?: readonly number[]
  /** Total time the sequential kill calls may take before the rest are left alone; defaults to the one-call bound, resident_process.ts::PROCESS_QUERY_TIMEOUT_MS. */
  readonly deadlineMs?: number
  /** Reads one pid's command line, just before that pid is signalled; a pid whose line no longer matches is left alone. Defaults to the real query on Windows, where a kill list can run for seconds and the OS may reuse a pid meanwhile, and to none elsewhere, where a signal follows the second list at once. */
  readonly readCommandLine?: (pid: number) => string | null
  /** The same read as a three-way answer, which tells a pid that is gone from a query that failed (the failed one is reported as unconfirmed, never ended); takes precedence over `readCommandLine`, whose null always reads as gone. */
  readonly queryCommandLine?: (pid: number) => CommandLineQuery
}

export interface RetireReport {
  /** Pids that are gone. */
  readonly retired: readonly number[]
  /** Pids that matched and are still alive after every signal. */
  readonly survivors: readonly number[]
  /** Pids that matched but were not signalled because the total deadline had passed; they are survivors too. */
  readonly notTried?: readonly number[]
  /** Why the process list could not be read, when it could not; nothing was ended then. */
  readonly unreadable?: string
  /** Pids that may be residents of this install but whose command line the system hides (an elevated node process asked from a normal shell), or whose re-read just before its kill failed: never signalled, and counted neither as ended nor as absent. */
  readonly unconfirmed?: readonly number[]
}

/** How long a POSIX process may take to leave after SIGTERM before it is killed: the daemon's own SIGTERM drain is 5 s (worker.ts SIGTERM_DRAIN_TIMEOUT_MS), plus a margin. */
const TERM_GRACE_MS = 8_000

/** How long a process may take to disappear after SIGKILL. */
const KILL_GRACE_MS = 2_000

const POLL_MS = 50

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The pids of `pids` that are running: signal 0 succeeds for a zombie too, which has exited and only awaits its parent's wait(), so those do not count. */
function running(pids: readonly number[], cheapOnly: boolean): number[] {
  const up = pids.filter(pidAlive)
  const dead = new Set(zombiePids(up, cheapOnly))
  return up.filter((pid) => !dead.has(pid))
}

/** The pids of `pids` still alive once `graceMs` has passed. A pid that is not our child has no exit event to wait on, so this polls the OS; the bound only stops a wait on a process that will not die. */
async function stillAlive(pids: readonly number[], graceMs: number): Promise<number[]> {
  const end = Date.now() + graceMs
  let alive = running(pids, true)
  while (alive.length > 0 && Date.now() < end) {
    await pause(POLL_MS)
    alive = running(alive, true)
  }
  return running(alive, false)
}

/** A node process whose list row carries no command line: Windows reports that for a process the caller may not inspect (cli_doctor_process.ts::readWindowsProcesses maps a missing CommandLine to ''), and a daemon of this install is a node process. Other rows with no command line (System, Registry) are no candidates. */
function hidesItsCommandLine(p: { name: string; commandLine: string }): boolean {
  return p.commandLine.trim() === '' && /^node(?:\.exe)?$/i.test(p.name)
}

interface MatchingPids {
  readonly pids: number[]
  /** Candidates this process cannot judge: see {@link RetireReport.unconfirmed}. */
  readonly hidden: number[]
}

/** The pids of this install's resident processes of `opts.kinds` that are running now, other than this process and `opts.skip`, and apart from them the node processes whose command line is hidden; the reason instead when the process list cannot be read. */
function matchingPids(opts: RetireOptions): MatchingPids | string {
  const table = readAllProcesses()
  if (!Array.isArray(table)) return (table as { reason: string }).reason
  const entry = daemonEntryScript()
  const skip = new Set([process.pid, ...(opts.skip ?? [])])
  // Deliberately every token-goat resident that runs THIS launcher, whatever its TOKEN_GOAT_HOME: an upgrade replaces the files all of them run from, and on Windows they hold native modules open and block the replacement; they restart on demand.
  const others = table.filter((p) => !skip.has(p.processId))
  return { pids: others.filter((p) => isResidentOfInstall(p.commandLine, entry, opts.kinds)).map((p) => p.processId), hidden: others.filter(hidesItsCommandLine).map((p) => p.processId) }
}

/** Ends every running resident process of this install matching `opts.kinds` except this one, with its children. Windows: `taskkill /T /F`. POSIX: SIGTERM, then SIGKILL for whatever is still alive after the grace, chosen from a fresh process list so a pid the OS reused in the meantime is never killed. */
export async function retireStrayResidents(opts: RetireOptions): Promise<RetireReport> {
  const listed = matchingPids(opts)
  if (typeof listed === 'string') return { retired: [], survivors: [], unreadable: listed }
  if (listed.pids.length === 0) return { retired: [], survivors: [], unconfirmed: listed.hidden }
  // The first list can be seconds old when the table is large or the machine slow, and the OS may have reused a listed pid since: signal only the pids a second list, taken right before, still shows as ours.
  const confirmed = matchingPids(opts)
  if (typeof confirmed === 'string') return { retired: [], survivors: [], unreadable: confirmed }
  const found = listed.pids.filter((pid) => confirmed.pids.includes(pid))
  // Only a pid hidden in the later list stays unconfirmed: one the first list could not judge and the second can is a process that changed. A recheck below that comes back hidden or fails adds its pid here.
  const unconfirmed = [...confirmed.hidden]
  // Each Windows kill is a taskkill of up to the per-call bound, and the list reached hundreds of daemons in the field: past one such bound in total the rest are reported, not waited on.
  const deadline = Date.now() + (opts.deadlineMs ?? PROCESS_QUERY_TIMEOUT_MS)
  // The second list can be seconds old by the time a later pid's turn comes: a pid the OS reused since is not ours, so its own command line is read again right before its kill.
  const recheck = opts.queryCommandLine ?? (opts.readCommandLine !== undefined ? lineReaderAsQuery(opts.readCommandLine) : process.platform === 'win32' ? queryProcessCommandLine : null)
  const entry = daemonEntryScript()
  const signalled: number[] = []
  const notTried: number[] = []
  for (const pid of found) {
    if (Date.now() >= deadline) {
      notTried.push(pid)
      continue
    }
    if (recheck !== null) {
      const latest = recheck(pid)
      // A failed query and an empty line (the system hiding it) are no evidence, not a stranger: the pid is neither signalled nor dropped from the report. Only a pid that is gone, or whose line is another program's (the reuse this re-read exists for), is skipped silently.
      if (latest.status === 'gone') continue
      if (latest.status === 'failed' || latest.commandLine.trim() === '') {
        unconfirmed.push(pid)
        continue
      }
      if (!isResidentOfInstall(latest.commandLine, entry, opts.kinds)) continue
    }
    terminateProcessTree(pid, process.platform === 'win32')
    signalled.push(pid)
  }
  let remaining = await stillAlive(signalled, process.platform === 'win32' ? KILL_GRACE_MS : TERM_GRACE_MS)
  if (remaining.length > 0 && process.platform !== 'win32') {
    const again = matchingPids(opts)
    const mine = typeof again === 'string' ? [] : remaining.filter((pid) => again.pids.includes(pid))
    for (const pid of mine) terminateProcessTree(pid, true)
    remaining = await stillAlive(remaining, KILL_GRACE_MS)
  }
  return { retired: signalled.filter((pid) => !remaining.includes(pid)), survivors: [...remaining, ...notTried], notTried, unconfirmed }
}

/** One line saying what {@link retireStrayResidents} did, or null when it found nothing to say. */
export function describeRetirement(report: RetireReport): string | null {
  const parts: string[] = []
  if (report.unreadable !== undefined) parts.push(`Could not read the process list (${displaySafeText(report.unreadable)}), so other token-goat background processes were not looked for.`)
  if (report.retired.length > 0) parts.push(`Ended ${report.retired.length} other token-goat background process${report.retired.length === 1 ? '' : 'es'} of this install, whatever their data directory (pid ${report.retired.join(', ')}).`)
  const skipped = report.notTried ?? []
  const failed = report.survivors.filter((pid) => !skipped.includes(pid))
  if (failed.length > 0) parts.push(`Could not end pid ${failed.join(', ')}; end ${failed.length === 1 ? 'it' : 'them'} yourself before upgrading.`)
  if (skipped.length > 0) parts.push(`Stopped ending processes at the time limit; pid ${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} left running, end ${skipped.length === 1 ? 'it' : 'them'} yourself before upgrading.`)
  const hidden = report.unconfirmed ?? []
  if (hidden.length > 0) parts.push(`Could not tell whether pid ${hidden.join(', ')} ${hidden.length === 1 ? 'is a' : 'are'} token-goat background process${hidden.length === 1 ? '' : 'es'}: the system hides its command line (an elevated process) or reading it failed, so ${hidden.length === 1 ? 'it was' : 'they were'} not ended; end ${hidden.length === 1 ? 'it' : 'them'} yourself before upgrading if ${hidden.length === 1 ? 'it is' : 'they are'} one.`)
  return parts.length === 0 ? null : parts.join(' ')
}
