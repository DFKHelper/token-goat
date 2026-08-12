/**
 * Regression: `--cwd` was only applied inside the `guard` action wrapper
 * (`process.chdir` at src/cli.ts, formerly inside `guard`'s closure), but the
 * surgical-read commands (`symbol`, `read`, `scope`, ...) call
 * `runExit`/`runExitText` directly and never go through `guard` -- so `--cwd`
 * silently no-oped for every one of them. Reproduced live: `token-goat --cwd
 * <root> scope "src/paths.ts:90"` returned "No symbols enclosing line 90" from
 * outside the project, identical to omitting `--cwd` entirely, while running
 * from inside the project resolved correctly.
 *
 * The fix moves the chdir into a Commander `preAction` hook on the root
 * program, which fires before every command's action handler regardless of
 * whether that handler is wrapped in `guard`.
 *
 * These tests drive `scope` (a non-`guard`-wrapped command) specifically --
 * a test that only covers a `guard`-wrapped command (e.g. `install`)
 * reproduces the exact blind spot that let this ship.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { run } from '../src/cli.js'
import { normalizePath } from '../src/paths.js'
import { indexFileSync } from '../src/parser.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let target: string
let elsewhere: string
let originalCwd: string
let stderr: string[]
let stdout: string[]
let stderrSpy: WriteSpy
let stdoutSpy: WriteSpy

beforeEach(() => {
  originalCwd = process.cwd()
  target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cwd-target-')))
  elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cwd-elsewhere-')))
  stderr = []
  stdout = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
  stdoutSpy = spyOnWrite(process.stdout, stdout)
})

afterEach(() => {
  stderrSpy.mockRestore()
  stdoutSpy.mockRestore()
  process.chdir(originalCwd)
  closeAllDbs()
  fs.rmSync(target, { recursive: true, force: true })
  fs.rmSync(elsewhere, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<number | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('--cwd applies before dispatch for every command, not only guard-wrapped ones', () => {
  it('changes process.cwd() before a directly-dispatched (non-guard) command runs', async () => {
    process.chdir(elsewhere)
    const code = await runCli(['--cwd', target, 'scope', 'foo.ts:1'])
    // foo.ts does not exist under `target`, so scope legitimately fails --
    // the point of this assertion is that the chdir itself took effect.
    expect(code).toBe(1)
    expect(fs.realpathSync(process.cwd())).toBe(target)
  })

  // The chdir must land before anything resolves the project root or loads config, not merely before the action body: a hook that fired after config resolution would still pass the two tests above (process.cwd() is correct by then) while silently serving the WRONG project's .token-goat.toml.
  it('applies before project config resolution, so --cwd selects the target project\'s .token-goat.toml', async () => {
    fs.writeFileSync(path.join(target, '.token-goat.toml'), '[compact_assist]\nmax_manifest_tokens = 111\n')
    fs.writeFileSync(path.join(elsewhere, '.token-goat.toml'), '[compact_assist]\nmax_manifest_tokens = 999\n')

    process.chdir(elsewhere)
    const withoutCwd = await runCli(['config', 'get', 'compact_assist.max_manifest_tokens'])
    expect(withoutCwd, stderr.join('')).toBe(0)
    expect(stdout.join('')).toContain('999')

    stdout.length = 0
    const withCwd = await runCli(['--cwd', target, 'config', 'get', 'compact_assist.max_manifest_tokens'])
    expect(withCwd, stderr.join('')).toBe(0)
    expect(stdout.join('')).toContain('111')
    expect(stdout.join('')).not.toContain('999')
  })

  it('resolves a real symbol via `scope` from outside the project when --cwd points at it', async () => {
    fs.writeFileSync(
      path.join(target, 'foo.ts'),
      'export function hello(): string {\n  return "hi"\n}\n',
    )
    indexFileSync(normalizePath(path.join(target, 'foo.ts')), globalDbPath())

    process.chdir(elsewhere)
    const code = await runCli(['--cwd', target, 'scope', 'foo.ts:2'])
    expect(code, stderr.join('')).toBe(0)
    expect(stdout.join('')).toContain('hello')
  })
})
