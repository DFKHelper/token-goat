/**
 * Regression: `token-goat <subcommand> --help` called the real `process.exit()`.
 *
 * `run()` calls `program.exitOverride()` on the program only, and it does so *after*
 * `buildProgram()` has already registered every subcommand. Commander copies the exit callback
 * into a subcommand at the moment that subcommand is created (`copyInheritedSettings`, invoked
 * from `.command()`), so every subcommand had already inherited "no callback" and fell through to
 * commander's default, which is `process.exit()`.
 *
 * Why no test caught it: the existing coverage for help either spawned a fresh process -- where a
 * real exit is invisible, since the process was going to end anyway -- or exercised only top-level
 * `--help`, the one command that did get the override. Nothing asserted the thing `main.ts`'s
 * docblock actually promises: that this binary sets `process.exitCode` and returns rather than
 * exiting mid-flush. That promise only matters in a host process that outlives the command, which
 * is exactly the `--batch-serve` case where it was found: a subcommand `--help` killed the shared
 * server. So these assert it in-process, where a real exit is observable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyExitOverride, buildProgram, run } from '../src/cli.js'

/** Runs `run(argv)` with `process.exit` stubbed, returning stdout and whether exit was attempted. */
async function runInProcess(args: string[]): Promise<{ stdout: string; exited: boolean }> {
  let exited = false
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = true
    // Commander expects exit() never to return, and the code after it assumes so. Throwing keeps
    // that contract without killing the worker, and the flag above records that it was reached.
    throw new Error(`process.exit(${String(code)}) called`)
  }) as never)
  let stdout = ''
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as never)
  try {
    await run(['node', 'token-goat', ...args])
  } finally {
    writeSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { stdout, exited }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('subcommand --help', () => {
  // `worker` and `install` are nested-subcommand parents; `symbol` is a plain leaf command. All
  // three go through the same copyInheritedSettings path, so one passing is not evidence for the
  // others -- a fix that only reached depth 1 would still leave `worker start --help` exiting.
  it.each([['symbol'], ['worker'], ['worker', 'start'], ['install']])('does not call process.exit for `%s`', async (...args) => {
    const result = await runInProcess([...args, '--help'])
    expect(result.exited, `\`${args.join(' ')} --help\` called the real process.exit()`).toBe(false)
    expect(result.stdout).toContain('Usage:')
    expect(process.exitCode).toBe(0)
  })

  // The top-level program was always covered by the original single exitOverride() call. Kept so a
  // refactor that moves the recursion cannot quietly drop the case it started from.
  it('does not call process.exit for the top-level program either', async () => {
    const result = await runInProcess(['--help'])
    expect(result.exited).toBe(false)
    expect(result.stdout).toContain('Usage:')
  })
})

describe('applyExitOverride', () => {
  // Structural companion to the behavioral cases above: it reaches every command at every depth,
  // not just the ones the cases above happen to name.
  it('reaches every command in the tree, at every depth', () => {
    const program = buildProgram()
    applyExitOverride(program)
    const seen: string[] = []
    const walk = (cmd: typeof program): void => {
      // `_exitCallback` is commander-internal, and asserting on it is the only way to check a
      // command that no test invokes. The behavioral cases above are what pin the actual effect.
      expect((cmd as unknown as { _exitCallback?: unknown })._exitCallback, `${cmd.name()} has no exit callback`).toBeDefined()
      seen.push(cmd.name())
      for (const sub of cmd.commands) walk(sub)
    }
    walk(program)
    expect(seen.length).toBeGreaterThan(30)
  })
})
