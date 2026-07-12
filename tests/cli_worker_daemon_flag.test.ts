// Regression (bug #245): `run()` used to intercept `--worker-daemon` via
// `argv.includes('--worker-daemon')`, which matches the literal string anywhere in argv, not
// just the specific invocation form `startDetachedWorker` actually spawns (always argv[2]:
// `spawn(node, [thisModule, '--worker-daemon'])`). Any ordinary command that merely carried that
// literal string as one of its own arguments -- e.g. `token-goat grep -- --worker-daemon` -- was
// silently hijacked into daemon mode instead of running the command the user asked for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerModule from '../src/worker.js'

const runDetachedWorkerDaemon = vi.fn()

vi.mock('../src/worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerModule>()
  return { ...actual, runDetachedWorkerDaemon }
})

const { run } = await import('../src/cli.js')

let stderrSpy: ReturnType<typeof vi.spyOn>

afterEach(() => {
  stderrSpy?.mockRestore()
  runDetachedWorkerDaemon.mockClear()
})

async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('run() — --worker-daemon flag sniffing', () => {
  it('does not enter daemon mode when --worker-daemon appears as a non-first argument of another command', async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await runCli(['grep', '--', '--worker-daemon'])
    expect(runDetachedWorkerDaemon).not.toHaveBeenCalled()
  })

  it('still enters daemon mode for the exact form startDetachedWorker spawns (argv[2])', async () => {
    await runCli(['--worker-daemon'])
    expect(runDetachedWorkerDaemon).toHaveBeenCalledTimes(1)
  })
})
