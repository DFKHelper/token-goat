import { readProcessCommandLine } from '../../src/resident_process.js'

/** Ends `pid` with SIGKILL only while its command line, read right now, satisfies `isOurs`; returns whether it signalled. A recorded pid is a claim, not proof: the OS hands a freed number to the next process it starts, and on Windows SIGKILL is TerminateProcess(handle, 1), so an unchecked kill of a pid that has already exited ends whatever holds the number now (a freshly forked vitest worker reports "Worker exited unexpectedly with exit code 1"). A process that is gone has no command line and is left alone. For a child this test spawned itself, call kill() on its ChildProcess handle instead: that signals the process the handle holds, never a number. */
export function killIfCommandLine(pid: number, isOurs: (commandLine: string) => boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  const commandLine = readProcessCommandLine(pid)
  if (commandLine === null || !isOurs(commandLine)) return false
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
