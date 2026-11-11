/** The pre-push focus decision (.lefthook-scripts/prepush-focus.sh calling scripts/prepush-select.mjs) in a sandbox repo with real git: the pushed range selects the files, and an empty or unseeable range falls back to the full leg. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { DeadlineReporter, optionsFromEnv } from '../scripts/prepush-deadline-reporter.mjs'
import { DEADLINE_REASON, cutReport, isRealError, legVerdict, moduleOutcome, parseOut, splitPlan, summarize } from '../scripts/prepush-deadline.mjs'
import { queryProcessCommandLine } from '../src/resident_process.js'
import { resolveWindowsBash } from '../src/shell.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { CAN_JUNCTION } from './helpers/can-symlink.js'
import { reaperRecordPid } from './helpers/reaper_record.js'

const REPO = process.cwd().replace(/\\/g, '/')
const posix = (p: string): string => p.replace(/\\/g, '/')
// Git Bash on Windows, never the WSL launcher that a bare bash resolves to there; null skips the suite where no bash exists
const BASH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/bash'
// The pre-push command of lefthook.yml, read from the file: the hook is started as `sh <wrapper> <script> {1}`, and the wrapper picks the bash (5.1 or later) that runs the script.
const HOOK_WRAPPER = ((): string => {
  const m = /^ {6}run: sh (\.lefthook-scripts\/run-with-bash-5\.sh) \.lefthook-scripts\/run-all-checks\.sh \{1\}$/m.exec(readFileSync(path.join(REPO, 'lefthook.yml'), 'utf8'))
  if (m === null) throw new Error('the pre-push command of lefthook.yml no longer runs run-all-checks.sh through run-with-bash-5.sh')
  return path.join(REPO, m[1] ?? '')
})()
// The sh the hook's `sh` is: the one beside Git Bash on Windows, /bin/sh elsewhere.
const SH = process.platform === 'win32' && BASH !== null ? path.join(path.dirname(BASH), 'sh.exe') : '/bin/sh'
// Whether the hook's wrapper finds a bash 5.1 or later on this host (the wrapper refuses on an older one on purpose, so a row that drives the hook through it cannot run there). Windows names Git Bash directly.
const HOOK_BASH_FOUND = ((): boolean => {
  if (process.platform === 'win32' || BASH === null) return true
  return spawnSync(SH, [HOOK_WRAPPER, '/dev/null'], { encoding: 'utf8', env: { ...process.env, TG_PREPUSH_BASH: '' } }).status === 0
})()
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

// The focus script sources the cap, whose cleanup process writes its record into the failure store's directory (the sandbox) and lives on for a moment after the script exits; teardown must wait for that process by its pid, or it creates a file under the directory being removed.
const REAP_GRACE_S = ((): number => {
  const n = Number(/^REAP_GRACE_S=(\d+)$/m.exec(readFileSync(path.join(REPO, '.lefthook-scripts/prepush-cap.sh'), 'utf8'))?.[1])
  if (!Number.isInteger(n)) throw new Error('REAP_GRACE_S=<seconds> was not found in prepush-cap.sh')
  return n
})()
const CLEANUP_WAIT_S = REAP_GRACE_S + 10
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const cleanupRunning = (pid: number): boolean => {
  if (!pidAlive(pid)) return false
  const q = queryProcessCommandLine(pid)
  return q.status === 'failed' || (q.status !== 'gone' && /prepush-reaper/.test(q.commandLine))
}
/** Waits for the cleanup process the script started to exit, and fails by name when it does not; the record names its Windows pid. */
function awaitCleanupGone(sandbox: string): void {
  const record = path.join(sandbox, 'reaper-last.txt')
  const named = existsSync(record) ? reaperRecordPid(readFileSync(record, 'utf8')) : null
  expect(named, 'the cleanup process left no record naming its pid').not.toBeNull()
  const pid = Number(named)
  const until = Date.now() + CLEANUP_WAIT_S * 1000
  // The wait polls the pid with a signal-0 probe, which starts no process; the command-line query is a PowerShell CIM call of 1 to 2 s on an idle host and many times that on a loaded one, so it is made only once the wait ends (cleanupRunning below), never per poll.
  while (pidAlive(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  if (cleanupRunning(pid)) killIfCommandLine(pid, (c) => /prepush-reaper/.test(c), { tree: true })
  expect(cleanupRunning(pid), `the cleanup process ${pid} was still running when the row ended, so it would write into the sandbox being removed`).toBe(false)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** The commit HEAD names, read from the loose ref git just wrote for a fresh commit, so it costs no git process; falls back to rev-parse when the ref is not a loose file. */
function looseHead(root: string): string {
  const ref = /^ref: (.+)$/m.exec(readFileSync(path.join(root, '.git/HEAD'), 'utf8'))?.[1]?.trim()
  const loose = ref === undefined ? '' : path.join(root, '.git', ref)
  const sha = loose !== '' && existsSync(loose) ? readFileSync(loose, 'utf8').trim() : ''
  return /^[0-9a-f]{40}$/.test(sha) ? sha : git(root, 'rev-parse', 'HEAD')
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

/** seed: files committed with the first commit; truncatedStore: the failure record is cut off mid-way after it is written; newBranch: the remote has no such branch; originMain: origin/main exists and points at the first commit */
type DecideOpts = { seed?: Record<string, string>; truncatedStore?: boolean; newBranch?: boolean; originMain?: boolean; xtrace?: boolean; viaWrapper?: boolean }

const templates = new Map<string, { dir: string; base: string }>()
// The second commit of a sandbox, by seed and changed files: rows that push the same change share one, so git add and git commit run once for them instead of once per row.
const pushed = new Map<string, { dir: string; base: string; head: string }>()
afterAll(() => {
  for (const t of [...templates.values(), ...pushed.values()]) rmSync(t.dir, { recursive: true, force: true })
  templates.clear()
  pushed.clear()
})
/** A directory holding a sandbox repo with its first commit and the recorded failing test, built once per seed; the second commit and the pushed range are each row's own. */
function firstCommitTemplate(seed: Record<string, string>): { dir: string; base: string } {
  const key = JSON.stringify(seed)
  const have = templates.get(key)
  if (have) return have
  const tpl = mkdtempSync(path.join(tmpdir(), 'tg-focus-tpl-'))
  try {
    return buildFirstCommit(tpl, key, seed)
  } catch (e) {
    // A build that failed part-way is not in the map, so the afterAll below would never remove its directory.
    rmSync(tpl, { recursive: true, force: true })
    throw e
  }
}
function buildFirstCommit(tpl: string, key: string, seed: Record<string, string>): { dir: string; base: string } {
  const root = path.join(tpl, 'repo')
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
  for (const [rel, text] of Object.entries(seed)) write(root, rel, text)
  git(tpl, 'init', '-q', 'repo')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  const base = looseHead(root)
  const log = path.join(tpl, 'tests.log')
  writeFileSync(log, ' FAIL  tests/a.test.ts > a > fails\n Test Files  1 failed | 4 passed (5)\n')
  execFileSync(process.execPath, [path.join(root, 'scripts/prepush-failed.mjs'), 'record', path.join(tpl, 'store.json'), 'win', base, log])
  const made = { dir: tpl, base }
  templates.set(key, made)
  return made
}

/** The first-commit template with the given files changed in a second commit, built once per seed and change; the pushed range base..head is the same for every row that uses it. */
function pushedTemplate(seed: Record<string, string>, change: Record<string, string>): { dir: string; base: string; head: string } {
  const key = JSON.stringify([seed, change])
  const have = pushed.get(key)
  if (have) return have
  const first = firstCommitTemplate(seed)
  const tpl = mkdtempSync(path.join(tmpdir(), 'tg-focus-two-'))
  try {
    cpSync(first.dir, tpl, { recursive: true })
    const root = path.join(tpl, 'repo')
    for (const [rel, text] of Object.entries(change)) write(root, rel, text)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '--allow-empty', '-m', 'two')
    const made = { dir: tpl, base: first.base, head: looseHead(root) }
    pushed.set(key, made)
    return made
  } catch (e) {
    // A build that failed part-way is not in the map, so the afterAll above would never remove its directory.
    rmSync(tpl, { recursive: true, force: true })
    throw e
  }
}

// The bash the hook's wrapper picks, found once by running the wrapper itself on a script that prints it; rows other than the wrapper's own start that bash directly, which spares each of them the wrapper's sh and its version-check bash. Windows names it from BASH, since the wrapper there prints an MSYS path node cannot start.
let hookBashPath: string | null = null
function hookBash(): string {
  if (hookBashPath !== null) return hookBashPath
  if (process.platform === 'win32') {
    hookBashPath = BASH ?? ''
    return hookBashPath
  }
  const probeDir = mkdtempSync(path.join(tmpdir(), 'tg-focus-bash-'))
  try {
    const probe = path.join(probeDir, 'which-bash.sh')
    writeFileSync(probe, 'printf %s "$BASH"\n')
    hookBashPath = execFileSync(SH, [HOOK_WRAPPER, probe], { encoding: 'utf8' }).trim()
    return hookBashPath
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

// The caller's environment without the PREPUSH_ and TG_PREPUSH_ knobs (PREPUSH_FULL, the budgets, the elapsed seconds), so only what a test sets reaches the script.
const inheritedEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:TG_)?PREPUSH_/.test(k)))

type Decision = { note: string; focus: string[]; deferred: string; trace: string }
const decisions = new Map<string, Decision>()
/** The decision of one real script run, shared by rows that ask for exactly the same one: the same inputs give the same output, and each row still asserts on its own part of it. */
function decide(change: Record<string, string>, env: Record<string, string> = {}, opts: DecideOpts = {}): Decision {
  const key = JSON.stringify([change, env, opts])
  const have = decisions.get(key)
  if (have) return have
  const made = runDecision(change, env, opts)
  decisions.set(key, made)
  return made
}

/** A sandbox repo with one recorded failing test, then the given files changed in a second commit. Returns the decision note and the focus list. */
function runDecision(change: Record<string, string>, env: Record<string, string>, opts: DecideOpts): Decision {
  // The sandbox is reached through a symlink, as every macOS temp directory is (/var points into /private): a script that mistakes a symlinked path for a different file does nothing here
  realDir = mkdtempSync(path.join(tmpdir(), 'tg-focus-'))
  dir = `${realDir}-link`
  symlinkSync(realDir, dir, 'junction')
  const root = path.join(dir, 'repo')
  // The first commit and the recorded failure are the same for every row with the same seed, so they are built once per seed and copied: each spawn costs a fraction of a second on a loaded host, and a row paid for them again every time. The second commit is built once per seed and change too (pushedTemplate), so a row starts no git process of its own before the script runs
  const template = pushedTemplate(opts.seed ?? {}, change)
  cpSync(template.dir, realDir, { recursive: true })
  const base = template.base
  const store = path.join(dir, 'store.json')
  if (opts.truncatedStore) writeFileSync(store, readFileSync(store, 'utf8').slice(0, 20))
  if (opts.originMain) write(root, '.git/refs/remotes/origin/main', `${base}\n`)
  const head = template.head
  // PREPUSH_FAILED_STORE names the store the row sets below anyway, so the sourced script does not fork a git rev-parse for a default path that is then overwritten (each fork costs seconds on a loaded host)
  const script = [
    `ROOT_DIR='${posix(root)}'`,
    `LOG_DIR='${posix(dir)}'`,
    `HEAD_SHA='${head}'`,
    `PUSH_STDIN="refs/heads/feat ${head} refs/heads/feat ${opts.newBranch ? '0'.repeat(40) : base}"$'\\n'`,
    `source '${posix(path.join(REPO, '.lefthook-scripts/prepush-focus.sh'))}'`,
    `FAILED_STORE='${posix(store)}'`,
    // xtrace goes to its own file (BASH_XTRACEFD), each line led by its script and line, so a test can name every command focus_decide ran itself
    ...(opts.xtrace ? [`exec 7>'${posix(path.join(dir, 'xtrace.txt'))}'`, 'BASH_XTRACEFD=7', `PS4='+@\${BASH_SOURCE##*/}:\${LINENO}: '`, 'set -x'] : []),
    'focus_decide win',
    ...(opts.xtrace ? ['set +x'] : []),
    'echo "NOTE=$FOCUS_NOTE"',
    'echo "FILE=$FOCUS_FILE"',
    'echo "DEFERRED_BEGIN"',
    'echo "$FOCUS_DEFERRED"',
  ].join('\n')
  const scriptFile = path.join(dir, 'focus-run.sh')
  writeFileSync(scriptFile, `${script}\n`)
  const [starter, starterArgs] = opts.viaWrapper ? [SH, [posix(HOOK_WRAPPER), posix(scriptFile)]] : [hookBash(), [posix(scriptFile)]]
  const out = execFileSync(starter, starterArgs, { cwd: root, encoding: 'utf8', env: { ...inheritedEnv(), PREPUSH_FAILED_STORE: posix(store), ...env, PATH: `${path.dirname(BASH ?? '')}${path.delimiter}${process.env['PATH'] ?? ''}` } })
  awaitCleanupGone(dir)
  const note = /^NOTE=(.*)$/m.exec(out)?.[1] ?? ''
  const file = /^FILE=(.*)$/m.exec(out)?.[1]?.trim() ?? ''
  const deferred = out.slice(out.indexOf('DEFERRED_BEGIN') + 'DEFERRED_BEGIN'.length).trim()
  const tracePath = path.join(dir, 'xtrace.txt')
  return { note, focus: file ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [], deferred, trace: opts.xtrace && existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '' }
}

describe.skipIf(BASH === null || !CAN_JUNCTION)('prepush focus wrapper', () => {
  // The wrapper is the only thing that prints this refusal: a script started any other way (bash -c, bash <file>) ignores TG_PREPUSH_BASH and runs.
  it('is started through run-with-bash-5.sh, as lefthook.yml starts the hook', () => {
    let failure: { status?: number; stderr?: unknown } | undefined
    try {
      decide({ 'src/a.ts': 'export const a = 2\n' }, { TG_PREPUSH_BASH: '/no/such/bash' }, { viaWrapper: true })
    } catch (e) {
      failure = e as { status?: number; stderr?: unknown }
    }
    expect(failure, 'the decision ran although the wrapper was told to use a bash that does not exist, so it did not go through run-with-bash-5.sh').toBeDefined()
    expect(failure?.status).toBe(2)
    expect(String(failure?.stderr)).toContain('TG_PREPUSH_BASH must name Bash 5.1 or later')
  })

  // Only where the host has no bash 5.1 or later: the decision rows are skipped there, and this row pins that the hook refuses rather than running on the old bash.
  it.skipIf(HOOK_BASH_FOUND)('refuses on a host whose bash is older than 5.1 and TG_PREPUSH_BASH is unset', () => {
    const r = spawnSync(SH, [HOOK_WRAPPER, '/dev/null'], { encoding: 'utf8', env: { ...process.env, TG_PREPUSH_BASH: '' } })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Bash 5.1 or later is required')
  })
})

describe.skipIf(BASH === null || !CAN_JUNCTION || !HOOK_BASH_FOUND)('prepush focus decision', () => {
  // One decision per row: each runs the real script, and two in one row doubled the row's cost. The sandboxes are built lazily, by the first row that needs each, never together in one hook: a hook has one 60 s deadline for all of them, and each build is several process starts.
  const changelogSeed = { 'tests/reads_changelog.test.ts': "import fs from 'node:fs'\nfs.readFileSync('CHANGELOG.md')\n", 'CHANGELOG.md': 'one\n' }
  const wholeSrcSeed = { 'tests/whole_src.test.ts': "import fs from 'node:fs'\nfs.readdirSync('src')\n", 'tests/spawner.test.ts': "import { bundleTg } from './helpers/bundle.js'\nbundleTg()\n", 'tests/helpers/bundle.ts': 'export const bundleTg = () => 1\n' }

  it('a src change runs the guards, the matrix and the tests that import the module', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' })
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/command_matrix_e2e.1.test.ts', 'tests/far.test.ts', 'tests/guards/tree.test.ts', 'tests/near.test.ts'])
    expect(r.note).toContain('1 failed before, 0 changed tests, 1 guard tests, 1 bundle matrix tests, 1 direct and 1 further importers, 0 text or bundle readers; deferred to CI: 0 files')
    expect(r.deferred).toBe('')
  })

  it('prints the files a tiny budget cut, and still runs the guards and the matrix', () => {
    const r = decide({ 'src/a.ts': 'export const a = 2\n' }, { PREPUSH_BUDGET_S: '1' }, { xtrace: true })
    expect(r.focus).toEqual(['tests/command_matrix_e2e.1.test.ts', 'tests/guards/tree.test.ts'])
    expect(r.deferred).toMatch(/^deferred to CI: 3 files \(~\d+ s\)\n {2}tests\/a\.test\.ts\n {2}tests\/near\.test\.ts\n {2}tests\/far\.test\.ts$/)
    // The script reads its own selection and deferred files with builtins: a cat is a process start, seconds on a loaded Windows host, on every push. The trace must show the script ran (a line from it) so an empty trace cannot pass.
    const own = r.trace.split('\n').filter((l) => /^\++@prepush-focus\.sh:/.test(l))
    expect(own.length, r.trace).toBeGreaterThan(5)
    expect(own.filter((l) => /: (cat|head|tail|sed|awk|tr|cut)( |$)/.test(l)), 'prepush-focus.sh started a process to read a file it can read with a builtin').toEqual([])
  })

  it('a test-only change runs the test and every guard, no matrix', () => {
    const r = decide({ 'tests/other.test.ts': 'export const x = 1\n' })
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/guards/tree.test.ts', 'tests/other.test.ts'])
  })

  it('a document change runs the guards, the failed file and the test that reads the document, and never the full leg', () => {
    const r = decide({ 'CHANGELOG.md': 'two\n' }, {}, { seed: changelogSeed })
    expect(r.note).toContain('win leg focused')
    expect(r.focus).toEqual(['tests/a.test.ts', 'tests/guards/tree.test.ts', 'tests/reads_changelog.test.ts'])
  })

  it('a src change lists a whole-src reader and a bundle spawner: run with room', () => {
    const roomy = decide({ 'src/a.ts': 'export const a = 2\n' }, {}, { seed: wholeSrcSeed })
    expect(roomy.focus).toEqual(expect.arrayContaining(['tests/whole_src.test.ts', 'tests/spawner.test.ts']))
  })

  it('a src change lists a whole-src reader and a bundle spawner: deferred without room', () => {
    const tight = decide({ 'src/a.ts': 'export const a = 2\n' }, { PREPUSH_BUDGET_S: '1' }, { seed: wholeSrcSeed })
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

  it('a new branch is focused from its merge base with origin/main', () => {
    const withBase = decide({ 'tests/other.test.ts': 'export const x = 1\n' }, {}, { newBranch: true, originMain: true })
    expect(withBase.note).toContain('win leg focused')
    expect(withBase.focus).toContain('tests/other.test.ts')
  })

  it('a new branch with no merge base on origin/main is a doubt', () => {
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

describe.skipIf(BASH === null || !CAN_JUNCTION || !HOOK_BASH_FOUND)('prepush focus note', () => {
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

// Provenance: FORMAT-DERIVED from .lefthook-scripts/prepush-reaper.sh, the `rec "reaper: pid=$$ winpid=$W owner=$OWNER life=$LIFE grace=$GRACE"` line; the winpid is empty where /proc has no winpid file (the CI Linux runners), where the old pattern matched no pid and failed with "left no record naming its pid".
describe('the pid a cleanup record names', () => {
  it('is the Windows pid where Git Bash gave one', () => {
    expect(reaperRecordPid('reaper: pid=1234 winpid=5678 owner=99 life=630 grace=30\nhook gone: 41\n')).toBe(5678)
  })

  it('is the plain pid where the record has no Windows pid off Windows', () => {
    expect(reaperRecordPid('reaper: pid=1234 winpid= owner=99 life=630 grace=30\nhook gone: 41\n', 'linux')).toBe(1234)
    expect(reaperRecordPid('reaper: pid=1234 winpid= owner=99 life=630 grace=30\nhook gone: 41\n', 'darwin')).toBe(1234)
  })

  it('is null on Windows when the record has no Windows pid', () => {
    expect(reaperRecordPid('reaper: pid=1234 winpid= owner=99 life=630 grace=30\nhook gone: 41\n', 'win32')).toBeNull()
  })

  it('is null for a record with no reaper line', () => {
    expect(reaperRecordPid('hook gone: 41\nexit: 53\n')).toBeNull()
  })
})

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
    // The script only asks git for the work tree's top (rev-parse --show-toplevel); git accepts HEAD, objects and refs as a repository, so no git init process is forked for it
    mkdirSync(path.join(root, '.git/objects'), { recursive: true })
    mkdirSync(path.join(root, '.git/refs'))
    writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
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
