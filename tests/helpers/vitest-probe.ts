/** The one place a test writes a generated test file for a nested vitest run to collect. vitest.config.ts includes `.vitest-probe/*.test.ts` for this, and the directory sits outside tests/ so no guard walking tests/ can list a probe and then find it gone. Several test files share the directory while running in separate workers, so cleanup removes only the caller's own file and never the directory: retry_visibility_reporter.test.ts once removed the whole directory in afterAll and took the env probe of test_process_inherits_no_token_goat_setting.test.ts with it, and its nested run then failed with "No test files found". Removing the directory even when it looks empty would still race a worker between its mkdir and its write, and the directory is gitignored, so it stays. */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const PROBE_DIR = path.resolve('.vitest-probe')

/** Writes `lines` to `.vitest-probe/<name>` and returns the file's absolute path. */
export function writeProbe(name: string, lines: readonly string[]): string {
  const file = path.join(PROBE_DIR, name)
  fs.mkdirSync(PROBE_DIR, { recursive: true })
  fs.writeFileSync(file, lines.join('\n'))
  return file
}

/** Removes one probe file, leaving the directory and every other worker's probe in place. */
export function removeProbe(file: string): void {
  fs.rmSync(file, { force: true })
}
