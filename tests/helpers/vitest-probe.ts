/** The one place a test writes a generated test file for a nested vitest run to collect. vitest.config.ts includes `.vitest-probe/*.test.ts` for this, and the directory sits outside tests/ so no guard walking tests/ can list a probe and then find it gone. Several test files share the directory while running in separate workers, so cleanup removes only the caller's own file and never the directory: retry_visibility_reporter.test.ts once removed the whole directory in afterAll and took the env probe of test_process_inherits_no_token_goat_setting.test.ts with it, and its nested run then failed with "No test files found". Removing the directory even when it looks empty would still race a worker between its mkdir and its write, and the directory is gitignored, so it stays. Two runs in one checkout share it as well, which is why a probe's name carries the pid of the process that wrote it: with one fixed name per test, the afterAll of the same test in the other run removed the file this run's nested vitest was about to collect, failing it with "No test files found" when the removal beat the nested run's listing and "Cannot find module '/@id/...'" when it fell between the listing and the import. Two loops running the guard tier in one worktree failed that way 6 times in 21 pairs of runs, and an fs trace of the reproduction put the other run's rmSync inside that window in every failure. */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const PROBE_DIR = path.resolve('.vitest-probe')

/** Where {@link writeProbe} puts `name`: `.vitest-probe/<stem>.<pid>.<ext>`, so the name stays unique while its writer runs and keeps the extension vitest collects by. */
export function probePath(name: string): string {
  const [stem, ...ext] = name.split('.')
  return path.join(PROBE_DIR, [stem, process.pid, ...ext].join('.'))
}

/** Writes `lines` to {@link probePath}(name) and returns that absolute path. */
export function writeProbe(name: string, lines: readonly string[]): string {
  const file = probePath(name)
  fs.mkdirSync(PROBE_DIR, { recursive: true })
  removeOrphans()
  fs.writeFileSync(file, lines.join('\n'))
  return file
}

/** Removes one probe file, leaving the directory and every other worker's probe in place. */
export function removeProbe(file: string): void {
  fs.rmSync(file, { force: true })
}

// A probe outlives its writer only when that process was killed before its afterAll ran, and an unfiltered run collects every `.vitest-probe/*.test.ts` and fails on it, so each writer first clears the probes no running process owns.
function removeOrphans(): void {
  for (const entry of fs.readdirSync(PROBE_DIR)) {
    if (isRunning(Number(entry.split('.')[1]))) continue
    try {
      fs.rmSync(path.join(PROBE_DIR, entry), { force: true })
    } catch {
      // best-effort: the next writer tries again
    }
  }
}

function isRunning(pid: number): boolean {
  // pid 0 and negative pids address a process group, not one process.
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists, it just may not be signalled from here.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
