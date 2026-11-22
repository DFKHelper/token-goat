/** The README claimed the suite ran on "Node.js 20 and 22" while package.json required >=22 and every CI job pinned 22, so a reviewer building a support matrix from the README got a version nothing was ever tested on. Three places state this and none of them checked each other. */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'
import { OWNER_VAR, POSIX_SH, reapOwned } from '../helpers/shell_argv.js'
import { pinnedPopulation } from './population.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowDir = path.join(repoRoot, '.github', 'workflows')

const engines = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } })
  .engines?.node
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')

/** Every `node-version:` a workflow pins, as a number, so a string mismatch cannot hide a real one. */
function workflowNodeVersions(): { where: string; version: number }[] {
  const found: { where: string; version: number }[] = []
  for (const file of pinnedPopulation({
    what: '.github/workflows/*.yml files',
    items: fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')),
    floor: 3,
    mustInclude: ['ci.yml', 'publish.yml'],
  })) {
    const lines = fs.readFileSync(path.join(workflowDir, file), 'utf8').split('\n')
    lines.forEach((text, index) => {
      const match = /node-version:\s*'?"?(\d+)/.exec(text)
      if (match?.[1]) found.push({ where: `${file}:${index + 1}`, version: Number(match[1]) })
    })
  }
  return found
}

describe('Node support claims', () => {
  const required = Number(/(\d+)/.exec(engines ?? '')?.[1] ?? -1)
  /** The whole floor, not just its major: `>=22.16.0` -> `22.16.0`. */
  const floor = /(\d+(?:\.\d+)*)/.exec(engines ?? '')?.[1] ?? ''
  // How a human writes that floor, which is how the README writes it: trailing zero segments are dropped, so `22.0.0` reads as "22" and `22.16.0` as "22.16". Comparing only the major would have let the README keep saying "Node.js 22" after the node:sqlite driver raised the real floor to 22.16, which is the drift this line exists to catch.
  const label = floor.replace(/(?:\.0)+$/, '')
  const pinned = workflowNodeVersions()
  // The WSL pre-push run keeps its own Node settings, separate from the workflows: the least login-shell Node it accepts, and the release it downloads when none is new enough.
  const wslScript = fs.readFileSync(path.join(repoRoot, '.lefthook-scripts', 'wsl-test.sh'), 'utf8')
  const wslMin = /^NODE_MIN="(\d+(?:\.\d+)*)"/m.exec(wslScript)?.[1] ?? ''
  const wslPin = /^NODE_VERSION="(\d+(?:\.\d+)*)"/m.exec(wslScript)?.[1] ?? ''

  /** The shipped `version_at_least` from wsl-test.sh, the function the WSL leg uses to accept a login-shell Node. */
  function shippedVersionAtLeast(): string {
    const body = /^version_at_least\(\) \{\n[\s\S]*?\n\}$/m.exec(wslScript)?.[0]
    if (body === undefined) throw new Error('wsl-test.sh no longer defines version_at_least')
    return body
  }

  /** Whether Node version `have` is at or above `want`, judged by running the shipped function under `sh`. Reaps by owner token only when the run fails, as shRunAll does. */
  function shippedAtLeast(sh: string, have: string, want: string): boolean {
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const script = `${shippedVersionAtLeast()}\nversion_at_least "$1" "$2"`
    const res = spawnSync(sh, ['-c', script, 'version_at_least', have, want], {
      encoding: 'utf8',
      env: { ...process.env, [OWNER_VAR]: token },
      windowsHide: true,
      timeout: 30_000,
    })
    if (res.error || res.signal || (res.status !== 0 && res.status !== 1)) {
      const reap = reapOwned(sh, token)
      throw new Error(`version_at_least ${have} ${want} gave no answer: status ${String(res.status)}, signal ${String(res.signal)}${reap ? `, reap: ${reap}` : ''}, stderr: ${res.stderr}`)
    }
    return res.status === 0
  }

  it('finds the declarations at all, so an empty sweep cannot pass as a clean one', () => {
    expect(required).toBeGreaterThan(0)
    expect(pinned.length).toBeGreaterThan(0)
    expect(label.length).toBeGreaterThan(0)
    // The trim only ever removes zeroes, so the label cannot quietly become a weaker claim than the floor it is derived from: `22.16.0` may shorten to `22.16`, never to `22`.
    const dropped = floor.split('.').slice(label.split('.').length)
    expect(
      dropped.every((part) => Number(part) === 0),
      `the README label "${label}" drops a non-zero part of the engines floor "${floor}"`,
    ).toBe(true)
  })

  it('states the engines floor in the README requirements line', () => {
    expect(readme).toContain(`Node.js ${label} or later`)
  })

  it('never runs CI on a version the package says it does not support', () => {
    const tooOld = pinned.filter((p) => p.version < required).map((p) => `${p.where} pins ${p.version}`)

    expect(tooOld, 'these run below the engines floor').toEqual([])
  })

  it('accepts a login-shell Node only from the engines floor', () => {
    expect(wslMin, 'wsl-test.sh has no NODE_MIN login-shell minimum to check').not.toBe('')
    expect(wslMin, `wsl-test.sh accepts a login-shell Node from ${wslMin}, not the engines floor ${floor}`).toBe(floor)
  })

  // Skipped without a POSIX shell (bash) on this host; CI requires bash and fails instead.
  it.skipIf(POSIX_SH === null)('compares Node versions by number in the shipped wsl-test.sh function, not as text', () => {
    const sh: string = POSIX_SH ?? ''
    expect(wslPin, 'wsl-test.sh has no NODE_VERSION pin to check').not.toBe('')
    // HAND-DERIVED: expected results follow numeric semver order, not version_at_least.
    const cases: [string, boolean][] = [
      ['22.9.0', false],
      ['22', false],
      ['22.16', true],
      ['22.16.0', true],
      ['22.23.3', true],
      ['23.0.0', true],
    ]
    for (const [version, expected] of cases) {
      expect(shippedAtLeast(sh, version, floor), `shipped version_at_least: ${version} against ${floor}`).toBe(expected)
    }
    expect(shippedAtLeast(sh, wslPin, floor), `wsl-test.sh pins Node ${wslPin}, below the engines floor ${floor}`).toBe(true)
  })

  // A shell that cannot start is a spawn error: the same throw as a timeout or a signal, with no wait.
  it('throws no answer when the shell cannot start, rather than judging a version', () => {
    const missing = path.join(os.tmpdir(), `no-sh-${randomBytes(8).toString('hex')}`, 'sh')
    expect(() => shippedAtLeast(missing, '22.16.0', floor)).toThrow('gave no answer: status null, signal null')
  })

  it('does not advertise a tested version that no workflow actually runs', () => {
    const ran = new Set(pinned.map((p) => p.version))
    const advertised = [...readme.matchAll(/(?:runs?|tested) on Node\.js (\d+)/g)].map((m) => Number(m[1]))

    for (const version of advertised) expect(ran, `README says the suite runs on Node ${version}`).toContain(version)
  })
})

describe('vec0 probe', () => {
  const probe = path.join(repoRoot, 'scripts', 'check-vec0.mjs')
  const tsxLoader = pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href

  it('opens through the production driver and creates a vec0 table in the real tree', () => {
    // One node process with no child of its own, so spawnSync's timeout kill reaches all of it.
    const run = spawnSync(process.execPath, ['--import', tsxLoader, probe], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    expect(run.status, `vec0 probe exited ${String(run.status)}: ${run.stderr}`).toBe(0)
    expect(run.stdout).toMatch(/^vec0 v\d/m)
  })

  /** Probe copy against a stub sqlite-vec: CJS entry loads a missing file; ESM entry loads cleanly. */
  function runWithMissingExtension(env: NodeJS.ProcessEnv) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec0-probe-'))
    try {
      fs.mkdirSync(path.join(dir, 'scripts'))
      fs.mkdirSync(path.join(dir, 'src'))
      const pkg = path.join(dir, 'node_modules', 'sqlite-vec')
      fs.mkdirSync(pkg, { recursive: true })
      fs.copyFileSync(probe, path.join(dir, 'scripts', 'check-vec0.mjs'))
      fs.copyFileSync(path.join(repoRoot, 'src', 'sqlite_driver.ts'), path.join(dir, 'src', 'sqlite_driver.ts'))
      // FORMAT-DERIVED: node_modules/sqlite-vec/package.json (main index.cjs; exports require, import).
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'sqlite-vec', type: 'module', main: 'index.cjs', exports: { '.': { require: './index.cjs', import: './index.mjs' } } }))
      const missing = JSON.stringify(path.join(dir, 'vec0-missing.so'))
      // FORMAT-DERIVED: node_modules/sqlite-vec/index.cjs:42-46 (load(db) calls db.loadExtension).
      fs.writeFileSync(path.join(pkg, 'index.cjs'), `exports.load = function load(db) { db.loadExtension(${missing}) }\n`)
      // FORMAT-DERIVED: node_modules/sqlite-vec/index.mjs:43-47 (export function load(db)).
      fs.writeFileSync(path.join(pkg, 'index.mjs'), `export function load() {}\n`)
      // One node process with no child of its own, so spawnSync's timeout kill reaches all of it.
      return spawnSync(process.execPath, ['--import', tsxLoader, path.join(dir, 'scripts', 'check-vec0.mjs')], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exits non-zero with its named message when sqlite-vec cannot be loaded', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.CI
    const run = runWithMissingExtension(env)
    expect(run.status, `vec0 probe exited 0 with the extension missing: ${run.stdout}`).not.toBe(0)
    expect(run.stderr).toContain('vec0 check failed: sqlite-vec did not load or could not create a vec0 table')
    expect(run.stderr).toContain('ERR_LOAD_SQLITE_EXTENSION')
    expect(run.stderr).toContain('sqlite_driver.ts')
    expect(run.stderr).toContain('TG_PREPUSH_WSL=0')
  })

  it('omits the TG_PREPUSH_WSL=0 hint when CI is set', () => {
    const run = runWithMissingExtension({ ...process.env, CI: 'true' })
    expect(run.status, `vec0 probe exited 0 with the extension missing: ${run.stdout}`).not.toBe(0)
    expect(run.stderr).toContain('vec0 check failed: sqlite-vec did not load or could not create a vec0 table')
    expect(run.stderr).not.toContain('TG_PREPUSH_WSL=0')
  })

  it('keeps the TG_PREPUSH_WSL=0 hint when CI is empty', () => {
    const run = runWithMissingExtension({ ...process.env, CI: '' })
    expect(run.status, `vec0 probe exited 0 with the extension missing: ${run.stdout}`).not.toBe(0)
    expect(run.stderr).toContain('TG_PREPUSH_WSL=0')
  })

  it('keeps the TG_PREPUSH_WSL=0 hint when CI is 0', () => {
    const run = runWithMissingExtension({ ...process.env, CI: '0' })
    expect(run.status, `vec0 probe exited 0 with the extension missing: ${run.stdout}`).not.toBe(0)
    expect(run.stderr).toContain('TG_PREPUSH_WSL=0')
  })

  it('keeps the TG_PREPUSH_WSL=0 hint when CI is false', () => {
    const run = runWithMissingExtension({ ...process.env, CI: 'false' })
    expect(run.status, `vec0 probe exited 0 with the extension missing: ${run.stdout}`).not.toBe(0)
    expect(run.stderr).toContain('TG_PREPUSH_WSL=0')
  })
})
