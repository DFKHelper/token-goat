import { run } from '../../src/cli.js'

/** Runs the CLI in-process (`run(['node', 'token-goat', ...argv])`) and returns the exit code it set, restoring process.exitCode afterwards so one call's failure code cannot leak into the vitest process or the next call. */
export async function runCliExitCode(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}
