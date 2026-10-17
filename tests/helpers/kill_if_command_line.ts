import { readProcessCommandLine, terminateProcessTree } from '../../src/resident_process.js'

/** The command line of a token-goat worker daemon: `node <launcher> --worker-daemon`, the flag as its own argument. Looser than isResidentOfInstall on purpose, so a daemon whose launcher is spelled another way (realpath, 8.3 name) is still found; no vitest worker or test child carries the flag. */
export const isWorkerDaemonCommandLine = (commandLine: string): boolean => /(?:^|\s)--worker-daemon(?:\s|["']|$)/.test(commandLine)

/** The command line of a token-goat hook server: `node <launcher> hook-server run`. */
export const isHookServerCommandLine = (commandLine: string): boolean => /(?:^|\s)hook-server\s+run(?:\s|["']|$)/.test(commandLine)

/** How killIfCommandLine signals and reads. `readCommandLine` defaults to the real query and exists so a test can stand in for a failed one. */
export interface KillOptions {
  signal?: NodeJS.Signals
  tree?: boolean
  readCommandLine?: (pid: number) => string | null
}

/** Ends `pid` only while its command line, read right now, satisfies `isOurs`; returns whether it signalled. SIGKILL by default, or `signal`; with `tree` the whole tree goes (taskkill /T /F on Windows, the process group elsewhere). A recorded pid is a claim, not proof: the OS hands a freed number to the next process it starts, and on Windows a kill is TerminateProcess(handle, 1), so an unchecked kill of a pid that has already exited ends whatever holds the number now (a freshly forked vitest worker reports "Worker exited unexpectedly with exit code 1"). A process that is gone has no command line and is left alone. A null read also means the query failed (a spawn error, a nonzero exit, a timeout, empty output), so when the pid still answers a signal-0 probe this throws instead of leaving a live process behind: a false failure is loud, an orphan is silent. For a child this test spawned itself, call kill() on its ChildProcess handle instead: that signals the process the handle holds, never a number. */
export function killIfCommandLine(pid: number, isOurs: (commandLine: string) => boolean, opts: KillOptions = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  const commandLine = (opts.readCommandLine ?? readProcessCommandLine)(pid)
  if (commandLine === null) {
    if (isGone(pid)) return false
    throw new Error(`pid ${pid}: its command line could not be read and the process is still alive, so it cannot be told from ours and was left running`)
  }
  if (!isOurs(commandLine)) return false
  // A window remains between the read above and the signal below: the process can exit and its number be reused in it; only a ChildProcess handle closes that.
  if (opts.tree === true) return terminateProcessTree(pid, opts.signal !== 'SIGTERM')
  try {
    process.kill(pid, opts.signal ?? 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/** killIfCommandLine for each pid: every pid is tried even when one throws, then the first failure is rethrown, so a cleanup loop neither skips the rest nor hides the one it could not decide. Returns how many it signalled. */
export function killAllIfCommandLine(pids: Iterable<number>, isOurs: (commandLine: string) => boolean, opts: KillOptions = {}): number {
  let signalled = 0
  let failure: unknown
  for (const pid of pids) {
    try {
      if (killIfCommandLine(pid, isOurs, opts)) signalled++
    } catch (err) {
      failure ??= err
    }
  }
  if (failure !== undefined) throw failure
  return signalled
}

/** True only when the OS says no such process; EPERM and anything else mean it is alive or undecidable. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
