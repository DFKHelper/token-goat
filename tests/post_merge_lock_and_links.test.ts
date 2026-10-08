// scripts/post-merge.mjs runs `npm install` when a pull or rebase changed package-lock.json. On npm 11.6.2 that install rewrites the lock without its `libc` arrays, so every such pull left the tree dirty, and in a worktree whose node_modules is a link to the main checkout it changed the install every checkout shares. The script must hand back the lock bytes it started with, and must not install through an outside link. These tests run the real script in a throwaway repository with a fake npm first on PATH.
//
// Provenance: the fake npm's rewrite is FORMAT-DERIVED from the defect report (npm 11.6.2 dropped each package's `"libc": [...]` block and nothing else, 31 blocks / 93 lines in the lock it was seen on); the lock below is HAND-DERIVED from npm's own package-lock layout and was not captured from a real npm run. The expected outcomes (bytes equal to the committed lock, no install call) are HAND-DERIVED from the requirement.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { gitRepoWithCommit } from './helpers/git-repo.js'
import { tempDir } from './helpers/temp-config.js'

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'post-merge.mjs')

const LOCK = {
  name: 'stub',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'stub' },
    'node_modules/@x/native-linux-x64-gnu': { version: '1.0.0', cpu: ['x64'], libc: ['glibc'], os: ['linux'], optional: true },
    'node_modules/@x/native-linux-x64-musl': { version: '1.0.0', cpu: ['x64'], libc: ['musl'], os: ['linux'], optional: true },
  },
}
const COMMITTED_LOCK = `${JSON.stringify(LOCK, null, 2)}\n`

const NL = String.fromCharCode(10)
const FAKE_NPM = [
  "import fs from 'node:fs'",
  "import { execFileSync } from 'node:child_process'",
  'const args = process.argv.slice(2)',
  "if (args[0] === 'install') {",
  "  fs.appendFileSync(process.env.TG_FAKE_NPM_LOG, 'install' + String.fromCharCode(10))",
  "  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))",
  '  for (const pkg of Object.values(lock.packages)) delete pkg.libc',
  "  fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + String.fromCharCode(10))",
  "} else if (args[0] === 'run' && args[1] === 'build') {",
  "  execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' })",
  '}',
  '',
].join(NL)

const STUB_BUILD = ["import fs from 'node:fs'", "fs.mkdirSync('dist', { recursive: true })", "fs.writeFileSync('dist/token-goat.mjs', '')", ''].join(NL)

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

/** A repository whose last commit added package-lock.json, with ORIG_HEAD on the commit before it, which is what a pull leaves behind. */
function checkoutWhereLockChanged(): string {
  const root = gitRepoWithCommit()
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'post-merge.mjs'))
  fs.writeFileSync(path.join(root, 'build.mjs'), STUB_BUILD)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stub', private: true, scripts: { build: 'node build.mjs' } }))
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'base'])
  const base = git(root, ['rev-parse', 'HEAD']).trim()
  fs.writeFileSync(path.join(root, 'package-lock.json'), COMMITTED_LOCK)
  git(root, ['add', 'package-lock.json'])
  git(root, ['commit', '-m', 'lock'])
  git(root, ['update-ref', 'ORIG_HEAD', base])
  return root
}

/** Runs the real script with a fake npm ahead of the real one on PATH; returns what the script printed and how many times the fake saw `install`. */
function runPostMerge(root: string): { status: number | null; stdout: string; stderr: string; installs: number } {
  const bin = tempDir()
  const entry = path.join(bin, 'fake-npm.mjs')
  fs.writeFileSync(entry, FAKE_NPM)
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'npm.cmd'), `@"${process.execPath}" "${entry}" %*\r\n`)
  else fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 })
  const log = path.join(tempDir(), 'npm.log')
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const env = { ...process.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`, TG_FAKE_NPM_LOG: log }
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'post-merge.mjs')], { cwd: root, encoding: 'utf8', env })
  const installs = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(NL).filter(Boolean).length : 0
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, installs }
}

describe('post-merge after a pull that changed package-lock.json', () => {
  it('hands back the committed lock bytes the install rewrote, and says so', { timeout: 120_000 }, () => {
    const root = checkoutWhereLockChanged()
    const ran = runPostMerge(root)
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.installs, 'the install ran').toBe(1)
    expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe(COMMITTED_LOCK)
    expect(git(root, ['status', '--porcelain', '--', 'package-lock.json'])).toBe('')
    expect(ran.stdout).toContain('npm install rewrote package-lock.json; restored the bytes it had before the install.')
  })

  it('keeps an uncommitted edit to the lock rather than reverting it to the committed bytes', { timeout: 120_000 }, () => {
    const root = checkoutWhereLockChanged()
    const edited = COMMITTED_LOCK.replace('"name": "stub"', '"name": "stub-edited"')
    fs.writeFileSync(path.join(root, 'package-lock.json'), edited)
    const ran = runPostMerge(root)
    expect(ran.status, ran.stderr).toBe(0)
    expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe(edited)
  })

  it('skips the install when node_modules links to a directory outside the checkout, and names it', { timeout: 120_000 }, () => {
    const root = checkoutWhereLockChanged()
    const shared = tempDir()
    fs.symlinkSync(shared, path.join(root, 'node_modules'), 'junction')
    const ran = runPostMerge(root)
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.installs, 'no install through the link').toBe(0)
    expect(ran.stdout).toContain('Skipping npm install')
    expect(ran.stdout).toContain(fs.realpathSync(shared))
    expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe(COMMITTED_LOCK)
  })

  it('still installs when node_modules is a link that stays inside the checkout', { timeout: 120_000 }, () => {
    const root = checkoutWhereLockChanged()
    const inside = path.join(root, 'real_modules')
    fs.mkdirSync(inside)
    fs.symlinkSync(inside, path.join(root, 'node_modules'), 'junction')
    const ran = runPostMerge(root)
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.installs).toBe(1)
  })
})
