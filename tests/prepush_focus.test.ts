/** The pre-push focus decision (.lefthook-scripts/prepush-focus.sh calling scripts/prepush-select.mjs) in a sandbox repo with real git: the pushed range selects the files, and an empty or unseeable range falls back to the full leg. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeadlineReporter, optionsFromEnv } from '../scripts/prepush-deadline-reporter.mjs'
import { DEADLINE_REASON, cutReport, isRealError, legVerdict, moduleOutcome, parseOut, splitPlan, summarize } from '../scripts/prepush-deadline.mjs'
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

  it('prints the files a tiny budget cut, and still runs the guards and the matrix', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' }, { PREPUSH_BUDGET_S: '1' })
    expect(r.focus).toEqual(['tests/command_matrix_e2e.1.test.ts', 'tests/guards/tree.test.ts'])
    expect(r.deferred).toMatch(/^deferred to CI: 3 files \(~\d+ s\)\n {2}tests\/a\.test\.ts\n {2}tests\/near\.test\.ts\n {2}tests\/far\.test\.ts$/)
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

// ---- the wall-clock deadline of the fill files (scripts/prepush-deadline*.mjs, run-test.sh) ----

const DEADLINE_AT = 1_800_000_000_000
type FakeModule = { moduleId: string; state: () => string; children: { allTests: () => { result: () => { state: string; note?: string } }[] } }
const fakeModule = (file: string, state: string, tests: { state: string; note?: string }[]): FakeModule => ({ moduleId: `/root/${file}`, state: () => state, children: { allTests: () => tests.map((t) => ({ result: () => t })) } })
const ABORT_NOTE = 'The test run was aborted by the user.'

describe('prepush deadline: what one file amounts to', () => {
  it.each([
    ['all tests passed', 'passed', [{ state: 'passed' }], 'done'],
    ['a test the file skipped itself', 'passed', [{ state: 'passed' }, { state: 'skipped' }, { state: 'skipped', note: 'not on this platform' }], 'done'],
    ['a failed test', 'failed', [{ state: 'passed' }, { state: 'failed' }], 'failed'],
    ['a collection failure with no tests', 'failed', [], 'failed'],
    ['a file that never started', 'pending', [], 'unfinished'],
    ['a test the cancel left pending', 'passed', [{ state: 'passed' }, { state: 'pending' }], 'unfinished'],
    ['a test skipped by the abort', 'passed', [{ state: 'passed' }, { state: 'skipped', note: ABORT_NOTE }], 'unfinished'],
    ['a failed test beside one the abort cut', 'failed', [{ state: 'failed' }, { state: 'skipped', note: ABORT_NOTE }], 'failed'],
    ['a failed test in a module vitest still calls passed, beside a pending one', 'passed', [{ state: 'failed' }, { state: 'pending' }], 'failed'],
    ['a failed collection beside tests the abort cut', 'failed', [{ state: 'skipped', note: ABORT_NOTE }], 'failed'],
  ] as const)('%s is %s', (_name, moduleState, tests, expected) => {
    expect(moduleOutcome(moduleState, [...tests])).toBe(expected)
  })

  it('a module with no tests is done in a run nobody cancelled and unfinished in a cancelled one, and a failure still wins', () => {
    expect(moduleOutcome('skipped', [])).toBe('done')
    expect(moduleOutcome('skipped', [], true)).toBe('unfinished')
    expect(moduleOutcome('failed', [], true)).toBe('failed')
    expect(moduleOutcome('passed', [{ state: 'passed' }], true)).toBe('done')
  })

  it('the cancel noise is not a real error in a cancelled run, and the same text in a run nobody cancelled is', () => {
    expect(isRealError(new Error('Closing rpc while "onTaskUpdate" was pending'), true)).toBe(false)
    expect(isRealError({ name: 'TestRunAbortError', message: ABORT_NOTE }, true)).toBe(false)
    expect(isRealError(new Error('Closing rpc while "onTaskUpdate" was pending'))).toBe(true)
    expect(isRealError(new Error('rpc is closed'), false)).toBe(true)
    expect(isRealError(new Error('boom'), true)).toBe(true)
    expect(isRealError('plain string', true)).toBe(true)
  })
})

describe('prepush deadline: the verdict of a cut leg', () => {
  const out = (lines: string[]): ReturnType<typeof parseOut> => parseOut(lines.join('\n') + '\n')
  it('a cut run whose completed files all passed is green', () => {
    expect(legVerdict(out(['done\ta', 'unfinished\tb', 'errors\t0', `cancelled\t${DEADLINE_REASON}`, 'end']))).toBe('green')
  })
  it('a failed completed file makes it red, and so does a real unhandled error', () => {
    expect(legVerdict(out(['failed\ta', 'unfinished\tb', 'errors\t0', 'cancelled\tx', 'end']))).toBe('red')
    expect(legVerdict(out(['done\ta', 'errors\t1', 'cancelled\tx', 'end']))).toBe('red')
  })
  it('a run the deadline did not cut, or that never wrote its end, is left to the vitest exit status', () => {
    expect(legVerdict(out(['failed\ta', 'errors\t0', 'end']))).toBe('plain')
    expect(legVerdict(out(['done\ta', 'cancelled\tx']))).toBe('plain')
    expect(legVerdict(out([]))).toBe('plain')
  })
  it('summarize lists unfinished files, counts a selected file vitest never listed as unfinished, and says nothing of them when nothing was cut', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-deadline-sum-'))
    try {
      const cutOut = path.join(dir, 'cut.out')
      writeFileSync(cutOut, ['done\ttests/a.test.ts', 'unfinished\ttests/b.test.ts', 'errors\t0', 'cancelled\tx', 'end'].join('\n'))
      expect(summarize(cutOut, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'])).toBe('STATUS\tgreen\nUNFINISHED\ttests/b.test.ts\nUNFINISHED\ttests/c.test.ts\n')
      const plainOut = path.join(dir, 'plain.out')
      writeFileSync(plainOut, ['done\ttests/a.test.ts', 'errors\t0', 'end'].join('\n'))
      expect(summarize(plainOut, ['tests/a.test.ts', 'tests/c.test.ts'])).toBe('STATUS\tplain\n')
      expect(summarize(path.join(dir, 'missing.out'), ['tests/a.test.ts'])).toBe('STATUS\tplain\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prepush deadline: splitting the focus list by the plan', () => {
  it('the fill keeps plan order and only files still in the focus list, the floor is every other focus file', () => {
    expect(splitPlan('g1\ng2\nf2\nf1\n', `${DEADLINE_AT}\nf1\ngone\nf2\n`)).toEqual({ deadlineAtMs: DEADLINE_AT, floor: ['g1', 'g2'], fill: ['f1', 'f2'] })
  })
  it('a deadline that is not whole milliseconds is 0, which cuts all of the fill', () => {
    expect(splitPlan('f1\n', 'soon\nf1\n').deadlineAtMs).toBe(0)
  })
  it('the cut report names the reason and every file', () => {
    expect(cutReport(['a', 'b'])).toBe('deferred to CI: 2 files (wall-clock deadline reached (host load))\n  a\n  b')
  })
})

describe('prepush deadline: the reporter', () => {
  function setup(over: { now: number; outFile?: string | null }) {
    const timers: { fn: () => void; ms: number }[] = []
    const cleared: unknown[] = []
    const cancels: string[] = []
    const r = new DeadlineReporter({
      deadlineAt: DEADLINE_AT,
      outFile: over.outFile === undefined ? null : over.outFile,
      now: () => over.now,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: (t) => void cleared.push(t),
    })
    r.onInit({ config: { root: '/root' }, cancelCurrentRun: (reason: string) => (cancels.push(reason), Promise.resolve()) })
    return { r, timers, cleared, cancels }
  }

  it('nothing is armed before the first file is queued, so a cancel from onInit (which vitest discards) is never sent', () => {
    const s = setup({ now: DEADLINE_AT + 1, outFile: 'x' })
    expect(s.cancels).toEqual([])
    expect(s.timers).toEqual([])
  })

  it('past the deadline at the first queued file, the run is cancelled at once with the deadline reason, once', () => {
    const s = setup({ now: DEADLINE_AT + 5, outFile: 'x' })
    s.r.onTestModuleQueued()
    s.r.onTestModuleQueued()
    expect(s.cancels).toEqual([DEADLINE_REASON])
    expect(s.timers).toEqual([])
  })

  it('before the deadline it sets one timer for the time left, and the timer cancels the run', () => {
    const s = setup({ now: DEADLINE_AT - 2500, outFile: 'x' })
    s.r.onTestModuleQueued()
    s.r.onTestModuleQueued()
    expect(s.timers.map((t) => t.ms)).toEqual([2500])
    expect(s.cancels).toEqual([])
    s.timers[0]?.fn()
    expect(s.cancels).toEqual([DEADLINE_REASON])
  })

  it('a run that ends before the deadline clears the timer and never cancels', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-deadline-rep-'))
    try {
      const s = setup({ now: DEADLINE_AT - 2500, outFile: path.join(dir, 'o.out') })
      s.r.onTestModuleQueued()
      s.r.onTestRunEnd([], [])
      expect(s.cleared).toEqual([1])
      expect(s.cancels).toEqual([])
      expect(readFileSync(path.join(dir, 'o.out'), 'utf8')).toBe('errors\t0\nend\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a file the cancel cut short that already failed a test is recorded failed, so the leg is red', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-deadline-rep-'))
    try {
      const outFile = path.join(dir, 'o.out')
      const s = setup({ now: DEADLINE_AT + 1, outFile })
      s.r.onTestModuleQueued()
      s.r.onTestRunEnd([fakeModule('tests/a.test.ts', 'passed', [{ state: 'failed' }, { state: 'skipped', note: ABORT_NOTE }]), fakeModule('tests/b.test.ts', 'skipped', [])] as never, [])
      const text = readFileSync(outFile, 'utf8')
      expect(text).toContain('failed\ttests/a.test.ts\n')
      expect(text).toContain('unfinished\ttests/b.test.ts\n')
      expect(legVerdict(parseOut(text))).toBe('red')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('without the deadline env it is inert', () => {
    expect(optionsFromEnv({})).toEqual({ deadlineAt: null, outFile: null })
    expect(optionsFromEnv({ TG_PREPUSH_DEADLINE_AT: 'x', TG_PREPUSH_DEADLINE_OUT: '' })).toEqual({ deadlineAt: null, outFile: null })
    expect(optionsFromEnv({ TG_PREPUSH_DEADLINE_AT: '12', TG_PREPUSH_DEADLINE_OUT: 'o' })).toEqual({ deadlineAt: 12, outFile: 'o' })
  })

  it('the out file lists every module by outcome with root-relative paths, drops cancel noise from the error count, and ends', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-deadline-rep-'))
    try {
      const outFile = path.join(dir, 'o.out')
      const s = setup({ now: DEADLINE_AT + 1, outFile })
      s.r.onTestModuleQueued()
      s.r.onTestRunEnd(
        [fakeModule('tests/a.test.ts', 'passed', [{ state: 'passed' }]), fakeModule('tests/b.test.ts', 'pending', []), fakeModule('tests/c.test.ts', 'failed', [{ state: 'failed' }])] as never,
        [new Error('Closing rpc while "x" was pending'), new Error('real')],
      )
      expect(readFileSync(outFile, 'utf8')).toBe(`done\ttests/a.test.ts\nunfinished\ttests/b.test.ts\nfailed\ttests/c.test.ts\nerrors\t1\ncancelled\t${DEADLINE_REASON}\nend\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prepush deadline: a real vitest run cut by a deadline already past', () => {
  it('every selected file is done or unfinished, none is lost, and the run is green with the reason in the report', () => {
    // Fixture provenance: DERIVED-FROM-A-REAL-RUN. Vitest 5.0.4 with cancelCurrentRun on the first queued file (experiment of 2026-10-26): a file already dispatched may finish, the others stay pending, the exit code is 1.
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-deadline-real-'))
    try {
      writeFileSync(path.join(dir, 'vitest.config.mjs'), "export default { test: { include: ['*.test.mjs'], globals: true, pool: 'forks', maxWorkers: 1, minWorkers: 1, fileParallelism: false } }\n")
      const files = ['a1', 'a2', 'a3', 'a4'].map((n) => `${n}.test.mjs`)
      for (const f of files) writeFileSync(path.join(dir, f), "test('ok', () => { expect(1).toBe(1) })\n")
      const outFile = path.join(dir, 'deadline.out')
      writeFileSync(outFile, '')
      const r = spawnSync(process.execPath, [`${REPO}/node_modules/vitest/vitest.mjs`, 'run', '--reporter=default', `--reporter=${REPO}/scripts/prepush-deadline-reporter.mjs`, ...files], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...inheritedEnv(), TG_PREPUSH_DEADLINE_AT: '1', TG_PREPUSH_DEADLINE_OUT: posix(outFile) },
      })
      const parsed = parseOut(readFileSync(outFile, 'utf8'))
      expect(parsed.ended, r.stdout + r.stderr).toBe(true)
      expect(parsed.cancelled).toBe(true)
      expect(parsed.failed).toEqual([])
      expect([...parsed.done, ...parsed.unfinished].sort()).toEqual(files)
      expect(parsed.unfinished.length).toBeGreaterThan(0)
      const lines = summarize(outFile, files).split('\n')
      expect(lines[0]).toBe('STATUS\tgreen')
      expect(lines.filter((l) => l.startsWith('UNFINISHED\t')).map((l) => l.slice(11)).sort()).toEqual([...parsed.unfinished].sort())
      expect(cutReport(parsed.unfinished)).toContain(DEADLINE_REASON)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The pre-push focused run with a plan, over a shim vitest that records each call (its argv and whether the reporter env came with it) and plays a deadline cut when told to.
const PLAN_SHIM = `import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.SHIM_LOG, JSON.stringify({ args, armed: Boolean(process.env.TG_PREPUSH_DEADLINE_OUT) }) + '\\n')
const files = args.filter((a) => a.startsWith('tests/'))
const cut = (process.env.SHIM_CUT ?? '').split(',').filter(Boolean)
const out = process.env.TG_PREPUSH_DEADLINE_OUT
if (out && cut.length > 0) {
  const lines = files.map((f) => (cut.includes(f) ? 'unfinished' : f.includes('FAILME') ? 'failed' : 'done') + '\\t' + f)
  writeFileSync(out, [...lines, 'errors\\t0', 'cancelled\\tx', 'end'].join('\\n') + '\\n')
  process.exit(Number(process.env.SHIM_RC ?? 1))
}
process.exit(files.some((a) => a.includes('FAILME')) ? 1 : 0)
`

interface PlanRun {
  status: number | null
  calls: { args: string[]; armed: boolean }[]
  stdout: string
  focusAfter: string[]
  cutReport: string
}

function runPlanned(o: { floor: string[]; fill: string[]; deadlineMs: number; cut?: string[]; plan?: boolean; rc?: number }): PlanRun {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-planrun-'))
  try {
    const root = path.join(dir, 'repo')
    mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true })
    mkdirSync(path.join(root, 'scripts'))
    writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), PLAN_SHIM)
    for (const f of ['prepush-deadline.mjs', 'is-main-module.mjs']) copyFileSync(path.join(REPO, 'scripts', f), path.join(root, 'scripts', f))
    execFileSync('git', ['init', '-q', root])
    const focus = path.join(dir, 'focus.txt')
    const plan = path.join(dir, 'plan.txt')
    const log = path.join(dir, 'calls.log')
    const cutFile = path.join(dir, 'cut-report.txt')
    writeFileSync(focus, [...o.floor, ...o.fill].join('\n') + '\n')
    writeFileSync(plan, `${o.deadlineMs}\n${o.fill.join('\n')}\n`)
    writeFileSync(log, '')
    const r = spawnSync(BASH ?? 'bash', [`${REPO}/.lefthook-scripts/run-test.sh`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...inheritedEnv(),
        TG_PREPUSH_FOCUS: posix(focus),
        ...(o.plan === false ? {} : { TG_PREPUSH_PLAN: posix(plan) }),
        TG_PREPUSH_CUT_REPORT: posix(cutFile),
        SHIM_LOG: log,
        SHIM_CUT: (o.cut ?? []).join(','),
        SHIM_RC: String(o.rc ?? 1),
        PATH: `${path.dirname(BASH ?? '')}${path.delimiter}${process.env['PATH'] ?? ''}`,
      },
    })
    let cutReportText = ''
    try {
      cutReportText = readFileSync(cutFile, 'utf8')
    } catch {
      // no cut report was written: nothing was deferred
    }
    return {
      status: r.status,
      calls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; armed: boolean }),
      stdout: r.stdout + r.stderr,
      focusAfter: readFileSync(focus, 'utf8').split('\n').filter(Boolean),
      cutReport: cutReportText,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FLOOR = ['tests/guards/g1.test.ts', 'tests/guards/g2.test.ts']
const FILL = ['tests/f1.test.ts', 'tests/f2.test.ts', 'tests/f3.test.ts']
const FUTURE = Date.now() + 3_600_000
const REPORTER_ARGS = ['--reporter=default', '--reporter=./scripts/prepush-deadline-reporter.mjs']

describe.skipIf(BASH === null)('pre-push focused run under a deadline', () => {
  it('runs the floor in its own plain call first and the fill after it under the deadline reporter', () => {
    const r = runPlanned({ floor: FLOOR, fill: FILL, deadlineMs: FUTURE })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([
      { args: ['run', ...FLOOR], armed: false },
      { args: ['run', ...REPORTER_ARGS, ...FILL], armed: true },
    ])
    expect(r.stdout).not.toContain('deferred to CI')
    expect(r.focusAfter).toEqual([...FLOOR, ...FILL])
  })

  it('a deadline already past runs every floor file, starts no fill file, defers the fill with the reason, and the leg is green', () => {
    const r = runPlanned({ floor: FLOOR, fill: FILL, deadlineMs: 1 })
    expect(r.calls).toEqual([{ args: ['run', ...FLOOR], armed: false }])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('deferred to CI: 3 files (wall-clock deadline reached (host load))')
    for (const f of FILL) expect(r.stdout).toContain(`  ${f}`)
    expect(r.cutReport).toContain('deferred to CI: 3 files (wall-clock deadline reached (host load))')
    expect(r.focusAfter).toEqual(FLOOR)
  })

  it('a cut during the fill defers exactly the unfinished files, is green while the completed files passed, and keeps only finished files in the focus list', () => {
    const r = runPlanned({ floor: FLOOR, fill: FILL, deadlineMs: FUTURE, cut: ['tests/f2.test.ts', 'tests/f3.test.ts'] })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('deferred to CI: 2 files (wall-clock deadline reached (host load))')
    expect(r.stdout).toContain('  tests/f2.test.ts')
    expect(r.stdout).toContain('  tests/f3.test.ts')
    expect(r.stdout).not.toContain('  tests/f1.test.ts')
    expect(r.focusAfter).toEqual([...FLOOR, 'tests/f1.test.ts'])
  })

  it('a completed fill file that failed is red even though the run was cut', () => {
    const r = runPlanned({ floor: FLOOR, fill: ['tests/FAILME.test.ts', 'tests/f2.test.ts'], deadlineMs: FUTURE, cut: ['tests/f2.test.ts'] })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('  tests/f2.test.ts')
  })

  it.each([2, 137, 139])('a cut run that exits %i (a crash or a signal, not the 1 of a cancel) is red even when every file outcome is clean', (rc) => {
    const r = runPlanned({ floor: FLOOR, fill: FILL, deadlineMs: FUTURE, cut: ['tests/f3.test.ts'], rc })
    expect(r.status).toBe(1)
  })

  it('a failed floor file is red whatever the fill does', () => {
    const r = runPlanned({ floor: ['tests/guards/FAILME.test.ts'], fill: FILL, deadlineMs: FUTURE })
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(2)
  })

  it('an empty floor goes on to the fill and does not fall back to the whole suite', () => {
    const r = runPlanned({ floor: [], fill: FILL, deadlineMs: FUTURE })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([{ args: ['run', ...REPORTER_ARGS, ...FILL], armed: true }])
  })

  it('with no plan the list runs as one plain call, with no reporter and no deferral', () => {
    const r = runPlanned({ floor: FLOOR, fill: FILL, deadlineMs: 1, plan: false })
    expect(r.calls).toEqual([{ args: ['run', ...FLOOR, ...FILL], armed: false }])
    expect(r.stdout).not.toContain('deferred to CI')
  })
})
