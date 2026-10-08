/** `refresh-dependabot-lock.mjs --audit-commit` end to end in a sandbox git repo, through its default registry lookup: the script is run for real and `npm view` is a stub npm-cli.js answering from a table, so no network is touched and the shipping lookup path (not an injected one) is what runs. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** FORMAT-DERIVED from `npm view lefthook@2.1.15 dist.integrity time --json` as captured in tests/lock_audit.test.ts: a flat object with the `dist.integrity` key and a `time` map keyed by version. */
const STUB_NPM = `
const fs = require('node:fs')
const table = JSON.parse(fs.readFileSync(process.env.STUB_REGISTRY, 'utf8'))
const spec = process.argv[3]
const cut = spec.lastIndexOf('@')
const name = spec.slice(0, cut)
const version = spec.slice(cut + 1)
fs.appendFileSync(process.env.STUB_LOG, spec + '\\n')
const hit = table[spec]
if (process.argv[2] !== 'view' || !hit) { process.stderr.write('npm error code E404\\n'); process.exit(1) }
process.stdout.write(JSON.stringify({ 'dist.integrity': hit.integrity, time: { [version]: hit.publishedAt } }))
`

let sandbox: string
let home: string

function git(args: string[]): string {
  const result = spawnSync('git', ['-c', `core.hooksPath=${path.join(home, 'no-hooks')}`, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: sandbox, env: gitEnv(), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

function commitLock(lock: unknown, message: string, date: string): string {
  fs.writeFileSync(path.join(sandbox, 'package-lock.json'), JSON.stringify(lock))
  git(['add', '.'])
  const env = { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
  const result = spawnSync('git', ['-c', `core.hooksPath=${path.join(home, 'no-hooks')}`, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], { cwd: sandbox, env: { ...gitEnv(), ...env }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return git(['rev-parse', 'HEAD']).trim()
}

/** The key is filtered out in every case before the stub's is set: with a plain spread the script was observed running the real npm-cli.js (and asking the real registry) under this runner on Windows, and the assertions on the stub's call log are what show the stub ran. */
function stubEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(gitEnv()).filter(([key]) => key.toLowerCase() !== 'npm_execpath'))
  return { ...env, npm_execpath: path.join(sandbox, 'stub', 'npm-cli.js'), STUB_REGISTRY: path.join(sandbox, 'registry.json'), STUB_LOG: path.join(sandbox, 'npm-calls.log') }
}

function audit(revision: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'refresh-dependabot-lock.mjs'), ...revision], { cwd: sandbox, encoding: 'utf8', env: stubEnv() })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const entry = (version: string, integrity: string, extra: Record<string, unknown> = {}) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz`, integrity, ...extra })
const lockOf = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages: { '': { name: 'sandbox', version: '1.0.0' }, ...packages } })

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-audit-commit-'))
  home = path.join(sandbox, 'home')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, 'gitconfig'), '')
  fs.mkdirSync(path.join(sandbox, 'scripts'))
  for (const name of ['refresh-dependabot-lock.mjs', 'dependabot-body.mjs', 'lock-consistency.mjs', 'lock-audit.mjs']) fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(sandbox, 'scripts', name))
  fs.mkdirSync(path.join(sandbox, 'node_modules', 'js-yaml'), { recursive: true })
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'js-yaml', 'package.json'), JSON.stringify({ name: 'js-yaml', type: 'module', main: 'index.js' }))
  fs.writeFileSync(path.join(sandbox, 'node_modules', 'js-yaml', 'index.js'), "export function load() { return { updates: [{ 'package-ecosystem': 'npm', cooldown: { 'default-days': 7 } }] } }\n")
  fs.mkdirSync(path.join(sandbox, '.github'))
  fs.writeFileSync(path.join(sandbox, '.github', 'dependabot.yml'), 'unused: the stub js-yaml answers\n')
  fs.mkdirSync(path.join(sandbox, 'stub'))
  fs.writeFileSync(path.join(sandbox, 'stub', 'npm-cli.js'), STUB_NPM)
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox', version: '1.0.0' }))
  fs.writeFileSync(path.join(sandbox, '.gitignore'), 'node_modules\nhome\nstub\nregistry.json\nnpm-calls.log\n')
  git(['init', '-q', '-b', 'main'])
})

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** A base lock with one package, then a commit on 2026-10-07 bumping it to 1.1.0. */
function bump(registry: Record<string, { integrity: string; publishedAt: string }>, newLock = lockOf({ 'node_modules/a': entry('1.1.0', 'sha512-new') })): string {
  fs.writeFileSync(path.join(sandbox, 'registry.json'), JSON.stringify(registry))
  commitLock(lockOf({ 'node_modules/a': entry('1.0.0', 'sha512-old') }), 'base', '2026-09-01T00:00:00Z')
  return commitLock(newLock, 'chore(deps): bump a', '2026-10-07T00:00:00Z')
}

describe('refresh-dependabot-lock --audit-commit', () => {
  it('passes a bump published before the cooldown with the integrity the registry serves, asking npm view once', () => {
    const sha = bump({ 'a@1.1.0': { integrity: 'sha512-new', publishedAt: '2026-09-20T00:00:00.000Z' } })
    const r = audit(['--audit-commit', sha])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('1 change(s) to package-lock.json, cooldown 7 days')
    expect(r.stdout).toContain('changed  node_modules/a 1.0.0 -> 1.1.0 (integrity changed)')
    expect(r.stdout).toContain('no violations')
    expect(fs.readFileSync(path.join(sandbox, 'npm-calls.log'), 'utf8')).toBe('a@1.1.0\n')
  })

  it('exits 1 naming a release published inside the cooldown', () => {
    const sha = bump({ 'a@1.1.0': { integrity: 'sha512-new', publishedAt: '2026-10-05T00:00:00.000Z' } })
    const r = audit(['--audit-commit', sha])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/cooldown: a@1\.1\.0 was published 2026-10-05/)
  })

  it('exits 1 naming an integrity the registry does not serve', () => {
    const sha = bump({ 'a@1.1.0': { integrity: 'sha512-other', publishedAt: '2026-09-20T00:00:00.000Z' } })
    const r = audit(['--audit-commit', sha])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('integrity: a@1.1.0 has integrity sha512-new in the lock but the registry serves sha512-other')
  })

  it('exits 1 when npm view fails for a package, rather than passing it unchecked', () => {
    const sha = bump({})
    const r = audit(['--audit-commit', sha])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lookup: a@1.1.0 could not be checked against the registry')
    expect(fs.readFileSync(path.join(sandbox, 'npm-calls.log'), 'utf8')).toBe('a@1.1.0\n')
  })

  it('exits 1 for a lock that disagrees with itself even when every registry answer is fine', () => {
    const stale = lockOf({ 'node_modules/p': entry('2.0.0', 'sha512-p', { optionalDependencies: { c: '1.0.0' } }), 'node_modules/c': entry('2.0.0', 'sha512-c') })
    const sha = bump({ 'p@2.0.0': { integrity: 'sha512-p', publishedAt: '2026-09-20T00:00:00.000Z' }, 'c@2.0.0': { integrity: 'sha512-c', publishedAt: '2026-09-20T00:00:00.000Z' } }, stale)
    const r = audit(['--audit-commit', sha])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('inconsistent: node_modules/p declares optionalDependencies c@1.0.0')
  })

  it('refuses a missing revision and an option-shaped one without running anything', () => {
    bump({})
    expect(audit(['--audit-commit']).stderr).toContain('--audit-commit needs a commit')
    expect(audit(['--audit-commit', '--help']).status).toBe(1)
    const unknown = audit(['--audit-commit', 'no-such-ref'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('cannot read package-lock.json at no-such-ref')
    expect(fs.existsSync(path.join(sandbox, 'npm-calls.log'))).toBe(false)
  })
})
