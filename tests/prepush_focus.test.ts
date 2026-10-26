/** The pre-push focus decision (.lefthook-scripts/prepush-focus.sh calling scripts/prepush-select.mjs) in a sandbox repo with real git: the pushed range selects the files, and an empty or unseeable range falls back to the full leg. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWindowsBash } from '../src/shell.js'
import { CAN_JUNCTION } from './helpers/can-symlink.js'

const REPO = process.cwd().replace(/\\/g, '/')
const posix = (p: string): string => p.replace(/\\/g, '/')
// Git Bash on Windows, never the WSL launcher that a bare bash resolves to there; null skips the suite where no bash exists
const BASH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/bash'
let dir = ''
let realDir = ''
afterEach(() => {
  // The real directory goes first, so removing the link can never reach into it
  if (realDir) rmSync(realDir, { recursive: true, force: true })
  if (dir) {
    try {
      unlinkSync(dir)
    } catch {
      try {
        rmdirSync(dir)
      } catch {
        // already gone
      }
    }
  }
  dir = ''
  realDir = ''
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

/** seed: files committed with the first commit; truncatedStore: the failure record is cut off mid-way after it is written; newBranch: the remote has no such branch; originMain: origin/main exists and points at the first commit */
type DecideOpts = { seed?: Record<string, string>; truncatedStore?: boolean; newBranch?: boolean; originMain?: boolean }

/** A sandbox repo with one recorded failing test, then the given files changed in a second commit. Returns the decision note and the focus list. */
// The caller's environment without the PREPUSH_ and TG_PREPUSH_ knobs (PREPUSH_FULL, the budgets, the elapsed seconds), so only what a test sets reaches the script.
const inheritedEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:TG_)?PREPUSH_/.test(k)))

function decide(change: Record<string, string>, env: Record<string, string> = {}, opts: DecideOpts = {}): { note: string; focus: string[]; deferred: string } {
  // The sandbox is reached through a symlink, as every macOS temp directory is (/var points into /private): a script that mistakes a symlinked path for a different file does nothing here
  realDir = mkdtempSync(path.join(tmpdir(), 'tg-focus-'))
  dir = `${realDir}-link`
  symlinkSync(realDir, dir, 'junction')
  const root = path.join(dir, 'repo')
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  for (const f of ['prepush-failed.mjs', 'test-durations.mjs', 'prepush-budget.mjs', 'prepush-graph.mjs', 'prepush-readers.mjs', 'prepush-select.mjs', 'is-main-module.mjs']) copyFileSync(path.join(REPO, 'scripts', f), path.join(root, 'scripts', f))
  write(root, 'src/a.ts', 'export const a = 1\n')
  write(root, 'tests/a.test.ts', "import { a } from '../src/a'\n")
  write(root, 'tests/near.test.ts', "import { a } from '../src/a'\n")
  write(root, 'tests/far.test.ts', "import './helpers/via'\n")
  write(root, 'tests/helpers/via.ts', "import { a } from '../../src/a'\n")
  write(root, 'tests/guards/tree.test.ts', 'export {}\n')
  write(root, 'tests/other.test.ts', 'export {}\n')
  write(root, 'tests/command_matrix_e2e.1.test.ts', 'export {}\n')
  for (const [rel, text] of Object.entries(opts.seed ?? {})) write(root, rel, text)
  git(dir, 'init', '-q', 'repo')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  const base = git(root, 'rev-parse', 'HEAD')
  const log = path.join(dir, 'tests.log')
  writeFileSync(log, ' FAIL  tests/a.test.ts > a > fails\n Test Files  1 failed | 4 passed (5)\n')
  const store = path.join(dir, 'store.json')
  execFileSync(process.execPath, [path.join(root, 'scripts/prepush-failed.mjs'), 'record', store, 'win', base, log])
  if (opts.truncatedStore) writeFileSync(store, readFileSync(store, 'utf8').slice(0, 20))
  if (opts.originMain) git(root, 'update-ref', 'refs/remotes/origin/main', base)
  for (const [rel, text] of Object.entries(change)) write(root, rel, text)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'two')
  const head = git(root, 'rev-parse', 'HEAD')
  const script = [
    `ROOT_DIR='${posix(root)}'`,
    `LOG_DIR='${posix(dir)}'`,
    `HEAD_SHA='${head}'`,
    `PUSH_STDIN="refs/heads/feat ${head} refs/heads/feat ${opts.newBranch ? '0'.repeat(40) : base}"$'\\n'`,
    `source '${posix(path.join(REPO, '.lefthook-scripts/prepush-focus.sh'))}'`,
    `FAILED_STORE='${posix(store)}'`,
    'focus_decide win',
    'echo "NOTE=$FOCUS_NOTE"',
    'echo "FILE=$FOCUS_FILE"',
    'echo "DEFERRED_BEGIN"',
    'echo "$FOCUS_DEFERRED"',
  ].join('\n')
  const out = execFileSync(BASH ?? 'bash', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...inheritedEnv(), ...env, PATH: `${path.dirname(BASH ?? '')}${path.delimiter}${process.env['PATH'] ?? ''}` } })
  const note = /^NOTE=(.*)$/m.exec(out)?.[1] ?? ''
  const file = /^FILE=(.*)$/m.exec(out)?.[1]?.trim() ?? ''
  const deferred = out.slice(out.indexOf('DEFERRED_BEGIN') + 'DEFERRED_BEGIN'.length).trim()
  return { note, focus: file ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [], deferred }
}

describe.skipIf(BASH === null || !CAN_JUNCTION)('prepush focus decision', () => {
  it('a src change runs the guards, the matrix and the tests that import the module', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' })
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/command_matrix_e2e.1.test.ts', 'tests/far.test.ts', 'tests/guards/tree.test.ts', 'tests/near.test.ts'])
    expect(r.note).toContain('1 failed before, 0 changed tests, 1 guard tests, 1 bundle matrix tests, 1 direct and 1 further importers, 0 text or bundle readers; deferred to CI: 0 files')
    expect(r.deferred).toBe('')
  })

  it('prints the files a tiny budget cut, and still runs the never-cut ones', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' }, { PREPUSH_BUDGET_S: '1' })
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/command_matrix_e2e.1.test.ts', 'tests/guards/tree.test.ts'])
    expect(r.deferred).toMatch(/^deferred to CI: 2 files \(~\d+ s\)\n {2}tests\/near\.test\.ts\n {2}tests\/far\.test\.ts$/)
  })

  it('a test-only change runs the test and every guard, no matrix', () => {
    const r = decide({ 'tests/other.test.ts': 'export const x = 1\n' })
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/guards/tree.test.ts', 'tests/other.test.ts'])
  })

  it('a document change runs the guards, the failed file and the test that reads the document, and never the full leg', () => {
    const seed = { 'tests/reads_changelog.test.ts': "import fs from 'node:fs'\nfs.readFileSync('CHANGELOG.md')\n", 'CHANGELOG.md': 'one\n' }
    const r = decide({ 'CHANGELOG.md': 'two\n' }, {}, { seed })
    expect(r.note).toContain('win leg focused')
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/guards/tree.test.ts', 'tests/reads_changelog.test.ts'])
  })

  it('a src change lists a whole-src reader and a bundle spawner: run with room, deferred without', () => {
    const seed = { 'tests/whole_src.test.ts': "import fs from 'node:fs'\nfs.readdirSync('src')\n", 'tests/spawner.test.ts': "import { bundleTg } from './helpers/bundle.js'\nbundleTg()\n", 'tests/helpers/bundle.ts': 'export const bundleTg = () => 1\n' }
    const roomy = decide({ 'src/a.ts': 'export const a = 2\n' }, {}, { seed })
    expect(roomy.focus).toEqual(expect.arrayContaining(['tests/whole_src.test.ts', 'tests/spawner.test.ts']))
    const tight = decide({ 'src/a.ts': 'export const a = 2\n' }, { PREPUSH_BUDGET_S: '1' }, { seed })
    expect(tight.focus).not.toContain('tests/whole_src.test.ts')
    expect(tight.deferred).toContain('  tests/whole_src.test.ts')
    expect(tight.deferred).toContain('  tests/spawner.test.ts')
  })

  it('a truncated failure record is a doubt: the guards and the matrix run and the rest is chosen within the budget', () => {
    const r = decide({ 'tests/other.test.ts': 'export const x = 1\n' }, {}, { truncatedStore: true })
    expect(r.note).toContain('win leg focused')
    expect(r.note).toContain('doubt (1): the last red win run named no failing test file')
    expect(r.focus).toContain('tests/other.test.ts')
  })

  it('a new branch is focused from its merge base with origin/main, and a doubt without one', () => {
    const withBase = decide({ 'tests/other.test.ts': 'export const x = 1\n' }, {}, { newBranch: true, originMain: true })
    expect(withBase.note).toContain('win leg focused')
    expect(withBase.focus).toContain('tests/other.test.ts')
    const without = decide({ 'tests/other.test.ts': 'export const x = 1\n' }, {}, { newBranch: true })
    expect(without.note).toContain('win leg focused')
    expect(without.note).toContain('doubt (1): new remote ref refs/heads/feat with no merge base on origin/main')
  })

  it('a path the import graph cannot see is a doubt, not the full leg', () => {
    const r = decide({ 'package.json': '{}\n' })
    expect(r.note).toContain('win leg focused')
    expect(r.note).toContain('doubt (1): package.json is not a src or tests module')
    expect(r.focus.length).toBeGreaterThan(0)
  })
})

describe.skipIf(BASH === null || !CAN_JUNCTION)('prepush focus note', () => {
  it('an empty range is a doubt that still runs the guards', () => {
    const r = decide({})
    expect(r.note).toContain('win leg focused')
    expect(r.note).toContain('doubt (1): the pushed range changes no file')
    expect(r.focus.length).toBeGreaterThan(0)
  })

  it('counts each changed path once and the failed file of the earlier run', () => {
    const note = decide({ 'tests/other.test.ts': 'export const x = 1\n' }).note
    expect(note).toContain('1 failed before, 1 changed tests, 1 guard tests')
  })
})
