/** scripts/build-native.mjs `--target` accepts only the four release triples, each filed under the directory the installer computes for it, and refuses anything else before cargo starts, so a typo in the release workflow can never build a binary under a directory that disagrees with what it was compiled for. The successful path (a real build for this host) is exercised by tests/setup/build-bundle.ts and every test that runs the binary it produced; the cross builds run in .github/workflows/publish.yml. Provenance: HAND-DERIVED, each refused argument list written here and the expected message read off the script's contract, not captured from a run. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { NATIVE_TARGETS } from '../scripts/verify-native-dist.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-native.mjs')
// PATH names only an empty directory, so cargo cannot be found and no test here can start a build (which would write into the dist/native the global install runs from). Removing PATH is not enough: on Windows the spawn then falls back to the parent's search path and finds cargo anyway.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-build-native-args-'))
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: emptyDir }
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env })

afterAll(() => {
  fs.rmSync(emptyDir, { recursive: true, force: true })
})

describe('build-native.mjs argument handling', () => {
  it('refuses a triple that is not a release target, naming the ones that are', () => {
    const r = run('--target', 'aarch64-unknown-linux-gnu')
    expect(r.status).toBe(1)
    expect(r.stderr).toBe(`build-native: --target aarch64-unknown-linux-gnu is not a release target; expected one of ${NATIVE_TARGETS.map((t) => t.triple).join(', ')}\n`)
  })

  it.each([
    [['--target'], '"--target"'],
    [['--target', '--locked'], '"--target"'],
    [['--frob'], '"--frob"'],
    [['x86_64-pc-windows-msvc'], '"x86_64-pc-windows-msvc"'],
    [['--target', 'x86_64-pc-windows-msvc', '--target', 'aarch64-pc-windows-msvc'], '"--target"'],
  ])('refuses %j before starting cargo', (args, named) => {
    // cargo is out of reach, so a refusal that fell through to it would fail with "cargo could not be started" instead of the usage line.
    const r = run(...args)
    expect(r.status).toBe(1)
    expect(r.stderr).toBe(`build-native: unexpected argument ${named}; usage: node scripts/build-native.mjs [--target <triple>]\n`)
  })

  it('reaches cargo for every release triple', () => {
    // First prove cargo is out of reach, with the one invocation that is harmless if it is not: a build for this host rewrites nothing, because the script leaves an identical binary alone. Only then try the triples, any of which would otherwise build.
    const probe = run()
    expect(probe.stderr, 'cargo is still reachable, so this test would start real builds').toMatch(/^build-native: cargo could not be started /)
    for (const { triple } of NATIVE_TARGETS) {
      const r = run('--target', triple)
      expect(r.status, triple).toBe(1)
      expect(r.stderr, triple).toMatch(/^build-native: cargo could not be started /)
    }
  })
})
