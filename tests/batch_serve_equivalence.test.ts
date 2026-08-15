/**
 * The guard that makes `--batch-serve` safe to rely on.
 *
 * Serving many invocations from one process is only sound while a served invocation is
 * indistinguishable from a spawned one. The risk is state: the server restores cwd, restores the
 * environment, resets `process.exitCode` and calls `clearModuleCaches()` between requests, but a
 * module-level cache that no reset covers would let one request colour the next, and a test
 * suite that ran only the batched path would never find out. Worse, it could go the other way --
 * a batched run passing where the real CLI is broken -- which is exactly the injected-seam trap
 * the bundle tests exist to prevent, wearing a new costume.
 *
 * So every command below runs both ways and the two results are compared byte for byte, including
 * exit status and stderr. Failures here mean the command is not safe to batch, not that the
 * assertion needs relaxing.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runBatched, runSpawned, stopBatchCli } from './helpers/batch-cli.js'
import { tempDir } from './helpers/temp-config.js'

afterAll(stopBatchCli)

function fixture(): string {
  const dir = tempDir()
  fs.writeFileSync(
    path.join(dir, 'sample.ts'),
    'export function batchedSym(): number {\n' +
      '  // TODO: a todo for the todo command\n' +
      '  return 1\n' +
      '}\n' +
      'export interface BatchedType { x: number }\n',
  )
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Heading One\n\nbody text\n\n## Heading Two\n\nmore\n')
  return dir
}

// Deliberately spans shapes rather than commands that happen to be cheap: a plain read, a
// filesystem walk, structured output, a help path, an error path, and a nonzero exit.
const CASES: Array<{ label: string; args: string[] }> = [
  { label: 'version', args: ['--version'] },
  { label: 'help', args: ['--help'] },
  // Subcommand help, at both depths. This used to kill the batch server outright: commander only
  // copies the exit-override callback into a subcommand when that subcommand is created, so every
  // subcommand fell through to a real process.exit(). Top-level `--help` above never caught it.
  { label: 'subcommand help', args: ['symbol', '--help'] },
  { label: 'nested subcommand help', args: ['worker', 'start', '--help'] },
  { label: 'outline', args: ['outline', 'sample.ts'] },
  { label: 'skeleton', args: ['skeleton', 'sample.ts'] },
  { label: 'section', args: ['section', 'notes.md::Heading One'] },
  { label: 'todo', args: ['todo', '.'] },
  { label: 'symbol miss', args: ['symbol', 'noSuchSymbolAnywhere'] },
  { label: 'read miss', args: ['read', 'nope.ts::whatever'] },
  { label: 'unknown command', args: ['definitelyNotACommand'] },
  { label: 'config get', args: ['config', 'get', 'bash_compress.enabled'] },
]

describe('batch-serve is indistinguishable from spawning the bundle', () => {
  const dir = fixture()

  for (const { label, args } of CASES) {
    it(`${label}: batched output matches spawned output exactly`, async () => {
      const batched = await runBatched(args, { cwd: dir })
      const spawned = runSpawned(args, { cwd: dir })

      expect(batched.stdout, `${label}: stdout differs between batched and spawned`).toBe(spawned.stdout)
      expect(batched.stderr, `${label}: stderr differs between batched and spawned`).toBe(spawned.stderr)
      expect(batched.status, `${label}: exit status differs between batched and spawned`).toBe(spawned.status)
    })
  }

  it('a request does not inherit the working directory of the one before it', async () => {
    const other = tempDir()
    fs.writeFileSync(path.join(other, 'only-here.ts'), 'export function onlyHereSym(): number {\n  return 1\n}\n')

    await runBatched(['outline', 'sample.ts'], { cwd: dir })
    const second = await runBatched(['outline', 'only-here.ts'], { cwd: other })

    expect(second.status).toBe(0)
    expect(second.stdout).toContain('onlyHereSym')
  })

  it('a request does not inherit the environment of the one before it', async () => {
    // NO_COLOR is read per invocation, so a leak shows up as the second request staying stripped.
    const withNoColor = { ...process.env, NO_COLOR: '1' }
    await runBatched(['--help'], { cwd: dir, env: withNoColor })

    const after = await runBatched(['--help'], { cwd: dir })
    const spawnedClean = runSpawned(['--help'], { cwd: dir })
    expect(after.stdout).toBe(spawnedClean.stdout)
  })

  it('a nonzero exit does not carry over into the next request', async () => {
    const failed = await runBatched(['definitelyNotACommand'], { cwd: dir })
    expect(failed.status).not.toBe(0)

    const ok = await runBatched(['--version'], { cwd: dir })
    expect(ok.status, 'a clean command reported the previous failure as its own status').toBe(0)
  })
})
