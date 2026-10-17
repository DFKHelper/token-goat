import { readProcessCommandLine, terminateProcessTree } from '../../src/resident_process.js'

/** The command line of a token-goat worker daemon: `node <launcher> --worker-daemon`, the flag as its own argument. Looser than isResidentOfInstall on purpose, so a daemon whose launcher is spelled another way (realpath, 8.3 name) is still found; no vitest worker or test child carries the flag. */
export const isWorkerDaemonCommandLine = (commandLine: string): boolean => /(?:^|\s)--worker-daemon(?:\s|["']|$)/.test(commandLine)

/** The command line of a token-goat hook server: `node <launcher> hook-server run`. */
export const isHookServerCommandLine = (commandLine: string): boolean => /(?:^|\s)hook-server\s+run(?:\s|["']|$)/.test(commandLine)

/** Ends `pid` only while its command line, read right now, satisfies `isOurs`; returns whether it signalled. SIGKILL by default, or `signal`; with `tree` the whole tree goes (taskkill /T /F on Windows, the process group elsewhere). A recorded pid is a claim, not proof: the OS hands a freed number to the next process it starts, and on Windows a kill is TerminateProcess(handle, 1), so an unchecked kill of a pid that has already exited ends whatever holds the number now (a freshly forked vitest worker reports "Worker exited unexpectedly with exit code 1"). A process that is gone has no command line and is left alone. For a child this test spawned itself, call kill() on its ChildProcess handle instead: that signals the process the handle holds, never a number. */
export function killIfCommandLine(pid: number, isOurs: (commandLine: string) => boolean, opts: { signal?: NodeJS.Signals; tree?: boolean } = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  const commandLine = readProcessCommandLine(pid)
  if (commandLine === null || !isOurs(commandLine)) return false
  if (opts.tree === true) return terminateProcessTree(pid, opts.signal !== 'SIGTERM')
  try {
    process.kill(pid, opts.signal ?? 'SIGKILL')
    return true
  } catch {
    return false
  }
}
