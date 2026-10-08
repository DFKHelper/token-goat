/** `deps:refresh` restoring the `libc` npm 11.6.2 strips from a lock, and `--verify` refusing a lock that lacks it, run end to end on the real script in a sandbox. `npm` is a stub npm-cli.js: `update` replaces the lock with the stripped file a real npm wrote (FORMAT-DERIVED from the b479903b reproduction, where npm 11.6.2 rewrote the lock with every `libc` line gone), and `view` answers from a table shaped like `npm view <pkg>@<ver> dist.integrity time libc --json` (CAPTURE in tests/lock_audit.test.ts's parseNpmView case and in the project memory note), so no network is touched and the shipping lookup path is the one that runs. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STUB_NPM = `
const fs = require('node:fs')
const table = JSON.parse(fs.readFileSync(process.env.STUB_REGISTRY, 'utf8'))
fs.appendFileSync(process.env.STUB_LOG, process.argv.slice(2, 4).join(' ') + '\\n')
if (process.argv[2] === 'update') {
  fs.copyFileSync(process.env.STUB_UPDATED_LOCK, process.env.STUB_LOCK)
  process.exit(0)
}
const spec = process.argv[3]
const version = spec.slice(spec.lastIndexOf('@') + 1)
const hit = table[spec]
if (process.argv[2] !== 'view' || !hit) { process.stderr.write('npm error code E404\\n'); process.exit(1) }
const out = { 'dist.integrity': 'sha512-x', time: { [version]: '2026-09-01T00:00:00.000Z' } }
if (hit.libc) out.libc = hit.libc
process.stdout.write(JSON.stringify(out))
`

const entry = (version: string, extra: Record<string, unknown> = {}) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity: 'sha512-x', cpu: ['x64'], dev: true, license: 'MIT', optional: true, os: ['linux'], ...extra })
const lockOf = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages: { '': { name: 'sandbox', version: '1.0.0' }, ...packages } })

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refresh-libc-'))
  fs.mkdirSync(path.join(sandbox, 'scripts'))
  for (const name of ['refresh-dependabot-lock.mjs', 'dependabot-body.mjs', 'lock-consistency.mjs', 'lock-audit.mjs', 'lock-libc.mjs']) fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(sandbox, 'scripts', name))
  fs.mkdirSync(path.join(sandbox, 'node_modules', 'js-yaml'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'js-yaml', 'package.json'), JSON.stringify({ name: 'js-yaml', type: 'module', main: 'index.js' }))
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'js-yaml', 'index.js'), "export function load() { return { updates: [{ 'package-ecosystem': 'npm', cooldown: { 'default-days': 7 } }] } }\n")
  fs.mkdirSync(path.join(sandbox, 'node_modules', 'vitest'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'vitest', 'vitest.mjs'), 'process.exit(0)\n')
  fs.mkdirSync(path.join(sandbox, '.github'))
  fs.writeFileSync(path.join(sandbox, '.github', 'dependabot.yml'), 'unused: the stub js-yaml answers\n')
  fs.mkdirSync(path.join(sandbox, 'stub'))
  fs.writeFileSync(path.join(sandbox, 'stub', 'npm-cli.js'), STUB_NPM)
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox', version: '1.0.0' }))
})

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** Windows env names are case-insensitive and vitest spells this one NPM_EXECPATH, so the key is removed in every case before the stub's is set. */
function stubEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_execpath'))
  return { ...env, npm_execpath: path.join(sandbox, 'stub', 'npm-cli.js'), STUB_REGISTRY: path.join(sandbox, 'registry.json'), STUB_LOG: path.join(sandbox, 'npm-calls.log'), STUB_LOCK: path.join(sandbox, 'package-lock.json'), STUB_UPDATED_LOCK: path.join(sandbox, 'updated.json') }
}

function script(args: string[], registry: Record<string, { libc?: string[] }>): { status: number | null; stdout: string; stderr: string } {
  fs.writeFileSync(path.join(sandbox, 'registry.json'), JSON.stringify(registry))
  const r = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'refresh-dependabot-lock.mjs'), ...args], { cwd: sandbox, encoding: 'utf8', env: stubEnv() })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const readLock = () => JSON.parse(fs.readFileSync(path.join(sandbox, 'package-lock.json'), 'utf8')) as { packages: Record<string, Record<string, unknown>> }
const calls = () => (fs.existsSync(path.join(sandbox, 'npm-calls.log')) ? fs.readFileSync(path.join(sandbox, 'npm-calls.log'), 'utf8').trim().split('\n') : [])

describe('refresh-dependabot-lock restoring libc', () => {
  /** The lock before: p moves 1.0.0 to 1.1.0, q does not move, both Linux packages that carry libc. npm's rewrite drops it from both, and adds a new one, n. */
  function stage(updated: unknown): void {
    fs.writeFileSync(path.join(sandbox, 'package-lock.json'), `${JSON.stringify(lockOf({ 'node_modules/p': entry('1.0.0', { libc: ['glibc'] }), 'node_modules/q': entry('2.0.0', { libc: ['musl'] }) }), null, 2)}\n`)
    fs.writeFileSync(path.join(sandbox, 'updated.json'), `${JSON.stringify(updated, null, 2)}\n`)
  }

  it('puts libc back from the previous lock for an entry that did not move and from the registry for one that did', () => {
    stage(lockOf({ 'node_modules/p': entry('1.1.0'), 'node_modules/q': entry('2.0.0'), 'node_modules/n': entry('3.0.0') }))
    const r = script(['--packages=p'], { 'p@1.1.0': { libc: ['glibc'] }, 'n@3.0.0': { libc: ['musl'] } })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored libc on 3 platform package(s)')
    const lock = readLock()
    expect(lock.packages['node_modules/p'].libc).toEqual(['glibc'])
    expect(lock.packages['node_modules/q'].libc).toEqual(['musl'])
    expect(lock.packages['node_modules/n'].libc).toEqual(['musl'])
    expect(Object.keys(lock.packages['node_modules/q'])).toEqual(['version', 'resolved', 'integrity', 'cpu', 'dev', 'libc', 'license', 'optional', 'os'])
    // q came from the previous lock, so only p and n were asked about.
    expect(calls().filter((line) => line.startsWith('view')).sort()).toEqual(['view n@3.0.0', 'view p@1.1.0'])
    expect(fs.readFileSync(path.join(sandbox, 'package-lock.json'), 'utf8').endsWith('}\n')).toBe(true)
  })

  it('stops without a half-fixed lock claim when the registry cannot be asked about a moved entry', () => {
    stage(lockOf({ 'node_modules/p': entry('1.1.0'), 'node_modules/q': entry('2.0.0') }))
    const r = script(['--packages=p'], {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not restore libc on every platform package')
    expect(r.stderr).toContain('node_modules/p')
  })
})

describe('refresh-dependabot-lock --verify and libc', () => {
  const writeLock = (lock: unknown) => fs.writeFileSync(path.join(sandbox, 'package-lock.json'), JSON.stringify(lock))

  it('refuses a lock where a Linux platform package lacks the libc its registry manifest declares', () => {
    writeLock(lockOf({ 'node_modules/p': entry('1.0.0') }))
    const r = script(['--verify'], { 'p@1.0.0': { libc: ['glibc'] } })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('node_modules/p 1.0.0 has no libc in the lock, but the registry declares libc ["glibc"]')
    expect(calls()).toEqual(['view p@1.0.0'])
  })

  it('accepts a lock whose bare Linux package has no libc in its manifest either, and one that already carries it', () => {
    writeLock(lockOf({ 'node_modules/p': entry('1.0.0'), 'node_modules/q': entry('1.0.0', { libc: ['musl'] }) }))
    const r = script(['--verify'], { 'p@1.0.0': {} })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no platform package lacks its libc')
    expect(calls()).toEqual(['view p@1.0.0'])
  })

  it('refuses a lock it cannot ask the registry about, rather than passing it', () => {
    writeLock(lockOf({ 'node_modules/p': entry('1.0.0') }))
    const r = script(['--verify'], {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not be checked for libc')
  })
})
