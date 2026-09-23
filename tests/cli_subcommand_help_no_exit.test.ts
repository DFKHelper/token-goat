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

/** Runs `run(argv)` with `process.exit` stubbed, returning stdout, stderr, the exit code it set, and whether exit was attempted. */
async function runInProcess(args: string[]): Promise<{ stdout: string; stderr: string; code: number | undefined; exited: boolean }> {
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
  let stderr = ''
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as never)
  // Cleared first so the assertion reads what this call set rather than what an earlier one left behind: `run()` only ever assigns, so a stale 1 would otherwise look like this command's own failure.
  process.exitCode = undefined
  try {
    await run(['node', 'token-goat', ...args])
  } finally {
    errSpy.mockRestore()
    writeSpy.mockRestore()
    exitSpy.mockRestore()
  }
  const code = process.exitCode as number | undefined
  process.exitCode = undefined
  return { stdout, stderr, code, exited }
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
    expect(result.code).toBe(0)
  })

  // The top-level program was always covered by the original single exitOverride() call. Kept so a
  // refactor that moves the recursion cannot quietly drop the case it started from.
  it('does not call process.exit for the top-level program either', async () => {
    const result = await runInProcess(['--help'])
    expect(result.exited).toBe(false)
    expect(result.stdout).toContain('Usage:')
  })
})

/**
 * `help <command>` is the other spelling of the same request, and it was broken for every command in the CLI while the block above was green.
 *
 * The action re-enters `program.parse([cmd, '--help'])`, which under the override above reports itself by throwing once commander has written the help text. That throw reached the generic action wrapper, which cannot tell a success signal from a failure, so every `help <command>` printed correct help on stdout and then `token-goat: (outputHelp)` on stderr and exited 1 -- including the spelling the compact help's own closing tip tells callers to use.
 *
 * Why the block above did not catch it: it exercises `<command> --help` only, which is the path that works, and it reads stdout alone. The defect lived entirely in the exit code and stderr of the sibling spelling, so nothing it asserts could have moved. Hence both streams and the code are checked here, and an unknown name is checked too -- commander answers that by printing the whole top-level help, which is why asking about one command and receiving the list of all of them has to be an error rather than a quiet success.
 */
describe('help <command>', () => {
  it.each([['symbol'], ['scope'], ['worker'], ['install']])('succeeds silently for `help %s`', async (name) => {
    const result = await runInProcess(['help', name])
    expect(result.stdout, `\`help ${name}\` printed no usage`).toContain('Usage:')
    expect(result.stderr, `\`help ${name}\` wrote to stderr on a successful help request`).toBe('')
    expect(result.code, `\`help ${name}\` reported failure for a command that exists`).toBe(0)
  })

  it('reports an unknown name instead of printing the whole command list', async () => {
    const result = await runInProcess(['help', 'nosuchcommand'])
    expect(result.stderr, 'an unknown command name was not named back to the caller').toContain('nosuchcommand')
    expect(result.code).toBe(1)
    // The failure has to be legible as one: commander's own answer here is the top-level help, which reads like success.
    expect(result.stdout, 'the top-level command list was printed in place of an error').not.toContain('Surgical token-reduction')
  })

  it('still prints the compact summary for a bare `help`', async () => {
    const result = await runInProcess(['help'])
    expect(result.stdout).toContain('Usage:')
    expect(result.code).toBe(0)
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
