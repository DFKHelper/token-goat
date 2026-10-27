/** scripts/prepush-select.mjs decides which test files a pre-push suite leg runs: a wrong selection fails silently (a red test is skipped), so every doubt must come back as the full leg. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as graph from '../scripts/prepush-graph.mjs'
import { classifyPath, decideSelection, importSeams, onEveryRemote, orNull, parseNameStatus, parsePushRefs, planText, rangeOf } from '../scripts/prepush-select.mjs'

// Fixture provenance. Ref lines: FORMAT-DERIVED from githooks(5) pre-push, `<local-ref> SP <local-object-name> SP <remote-ref> SP <remote-object-name> LF`, with the all-zeroes name for a missing remote ref and `(delete)` as the local ref of a deletion; https://git-scm.com/docs/githooks read from Git 2.53.0.windows.1 doc/git-doc/githooks.html. The shas are synthetic. Changed-path rows: HAND-DERIVED. `git diff -z --name-status` text: FORMAT-DERIVED from git-diff(1) --name-status with -z (status, NUL, path, NUL); the real-git path is exercised in prepush_focus.test.ts.
const HEAD = 'a'.repeat(40)
const REMOTE = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)
const ZERO = '0'.repeat(40)
const refLine = (lsha: string, rsha: string, lref = 'refs/heads/feat', rref = 'refs/heads/feat'): string => `${lref} ${lsha} ${rref} ${rsha}\n`
const PUSH = refLine(HEAD, REMOTE)

const GUARDS = ['tests/guards/a.test.ts', 'tests/guards/b.test.ts']
const MATRIX = ['tests/command_matrix_e2e.1.test.ts', 'tests/command_matrix_e2e.2.test.ts']
// Test files that import the changed module: one hop away, and two hops away.
const IMPORTERS = new Map([
  ['tests/near.test.ts', 1],
  ['tests/far.test.ts', 2],
])

const SELECT_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prepush-select.mjs')
// The caller's environment without the knobs that change the verdict (PREPUSH_FULL, the budgets, the elapsed seconds), so a run from a shell that exports one still tests the default.
const hermeticEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:TG_)?PREPUSH_/.test(k)))
// Every test file of the synthetic tree a doubt chooses among: the guards, the matrix, the two importers and four others.
const OTHERS = ['tests/o1.test.ts', 'tests/o2.test.ts', 'tests/o3.test.ts', 'tests/o4.test.ts']
const ALL_TESTS = [...GUARDS, ...MATRIX, ...IMPORTERS.keys(), 'tests/x.test.ts', ...OTHERS].sort()

type Row = { status: string; path: string }
type Io = Parameters<typeof decideSelection>[0]
function select(changed: Row[] | null, over: Partial<Io> = {}): ReturnType<typeof decideSelection> {
  return decideSelection({
    leg: 'win',
    headSha: HEAD,
    pushText: PUSH,
    env: {},
    changed: () => changed,
    failed: () => [],
    unparsedFailure: () => false,
    exists: () => true,
    guards: () => GUARDS,
    matrix: () => MATRIX,
    importers: () => IMPORTERS,
    setups: () => [],
    mergeBase: () => null,
    onRemote: () => false,
    allTests: () => ALL_TESTS,
    readers: () => [[], [], []],
    durations: () => ({}),
    workers: 4,
    ...over,
  })
}
const m = (p: string): Row => ({ status: 'M', path: p })

describe('prepush selection: focused pushes', () => {
  it('src-only change: every guard, the bundle matrix and the tests that import the module', () => {
    const r = select([m('src/a.ts')])
    expect(r).toMatchObject({ full: false })
    expect(r.full === false && r.files).toEqual([...MATRIX, ...GUARDS, 'tests/far.test.ts', 'tests/near.test.ts'].sort())
  })

  it('test-only change: the test and every guard, no matrix', () => {
    const r = select([m('tests/x.test.ts')])
    expect(r.full === false && r.files).toEqual(['tests/guards/a.test.ts', 'tests/guards/b.test.ts', 'tests/x.test.ts'])
  })

  it('test helper change: the tests importing the helper join the guards, still no matrix', () => {
    const r = select([m('tests/helpers/bundle.ts')])
    expect(r.full === false && r.files).toEqual(['tests/far.test.ts', 'tests/guards/a.test.ts', 'tests/guards/b.test.ts', 'tests/near.test.ts'])
  })

  it('guard change: the guard files alone', () => {
    const r = select([m('tests/guards/b.test.ts')])
    expect(r.full === false && r.files).toEqual(GUARDS)
  })

  it('a documentation-only push runs the guards and the tests naming the document, not the full leg, the matrix or the import graph', () => {
    const r = select([m('CHANGELOG.md')], { readers: () => [['tests/reads_changelog.test.ts'], [], []], importers: () => { throw new Error('the import graph is not read for a document') } })
    expect(r.full === false && r.files).toEqual([...GUARDS, 'tests/reads_changelog.test.ts'])
  })

  it('a new branch is diffed from its merge base with origin/main', () => {
    const seen: string[] = []
    const r = select(null, {
      pushText: refLine(HEAD, ZERO),
      mergeBase: () => REMOTE,
      changed: (from: string) => {
        seen.push(from)
        return [m('tests/x.test.ts')]
      },
    })
    expect(seen).toEqual([REMOTE])
    expect(r.full === false && r.files).toContain('tests/x.test.ts')
  })

  it('two ref lines: the changes of both are selected', () => {
    const two = refLine(HEAD, REMOTE) + refLine(HEAD, OTHER, 'refs/heads/feat', 'refs/heads/other')
    const rows: Record<string, Row[]> = { [REMOTE]: [m('tests/x.test.ts')], [OTHER]: [m('tests/y.test.ts')] }
    const r = select(null, { pushText: two, changed: (from: string) => rows[from] ?? null })
    expect(r.full === false && r.files).toEqual(['tests/guards/a.test.ts', 'tests/guards/b.test.ts', 'tests/x.test.ts', 'tests/y.test.ts'])
  })

  it('failed files of an earlier red leg are added; one that no longer exists is not', () => {
    const r = select([m('tests/x.test.ts')], { failed: () => ['tests/old.test.ts', 'tests/gone.test.ts'], exists: (p: string) => p !== 'tests/gone.test.ts' })
    expect(r.full === false && r.files).toContain('tests/old.test.ts')
    expect(r.full === false && r.files).not.toContain('tests/gone.test.ts')
  })

  it('a deleted test file is dropped from the list and the rest stays focused', () => {
    const r = select([{ status: 'D', path: 'tests/old.test.ts' }, m('tests/x.test.ts')], { exists: (p: string) => p !== 'tests/old.test.ts' })
    expect(r.full === false && r.files).not.toContain('tests/old.test.ts')
  })

  it('the note counts what was chosen, the estimate and the budget, and names the escape hatch', () => {
    const r = select([m('src/a.ts')])
    // HAND-DERIVED: six files untimed at the 6.2 s cold default each = 37.2 s, over 4 workers = 9.3 s, times the 1.4 calibration = 13.02 s, plus the 45 s fixed overhead = 58.02 s
    expect(r.full === false && r.note).toBe('win leg focused: 6 file(s), estimated ~58 s of a 330 s budget (default); 0 failed before, 0 changed tests, 2 guard tests, 2 bundle matrix tests, 1 direct and 1 further importers, 0 text or bundle readers; deferred to CI: 0 files; costs: no duration table, every file costed at the default 6 s; set PREPUSH_FULL=1 for the full leg')
  })
})

describe('prepush selection: the floor, the fill and the wall-clock deadline of the plan', () => {
  const NOW = 1_800_000_000_000
  it('the floor is the guards and the matrix, the fill is the rest in priority order, and the deadline is the clock plus the leg budget', () => {
    // Fixture provenance: HAND-DERIVED from the synthetic tree above; the win leg budget is 330 s, so the deadline is NOW + 330000.
    const r = select([m('src/a.ts')], { now: () => NOW })
    if (r.full) throw new Error('expected a focused selection')
    expect(r.floor).toEqual([...GUARDS, ...MATRIX])
    expect(r.fill.length).toBeGreaterThan(0)
    expect([...r.fill].sort()).toEqual(r.files.filter((f) => !r.floor.includes(f)).sort())
    expect(r.fill.slice(0, 2)).toEqual(['tests/near.test.ts', 'tests/far.test.ts'])
    expect(r.deadlineAtMs).toBe(NOW + 330_000)
  })

  it('the WSL deadline is taken from the real elapsed seconds the hook passes, not from an estimate', () => {
    const r = select([m('src/a.ts')], { leg: 'wsl', env: { PREPUSH_ELAPSED_S: '400' }, now: () => NOW })
    if (r.full) throw new Error('expected a focused selection')
    // HAND-DERIVED: 490 s total minus 400 s elapsed = 90 s left
    expect(r.deadlineAtMs).toBe(NOW + 90_000)
  })

  it('planText is the deadline in epoch ms, then one fill file per line', () => {
    expect(planText({ fill: ['tests/b.test.ts', 'tests/a.test.ts'], deadlineAtMs: 42 })).toBe('42\ntests/b.test.ts\ntests/a.test.ts\n')
    expect(planText({ fill: [], deadlineAtMs: 7 })).toBe('7\n')
  })
})

describe('prepush selection: a pre-push hook file', () => {
  // Fixture provenance: the path shapes are HAND-DERIVED from the hook layout (.lefthook-scripts/prepush-focus.sh is the file the leg sources, lib/x.sh a nested helper); the verdict is the full leg by the rule, not read off the implementation.
  it.each(['.lefthook-scripts/prepush-focus.sh', '.lefthook-scripts/lib/x.sh', '.lefthook-scripts/notes.txt', '.lefthook-scripts/README.md'])('a change to %s is a doubt: the never-cut classes run and the budget is spent on the rest', (p) => {
    const r = select([m(p)])
    expect(r).toMatchObject({ full: false, doubts: [expect.stringContaining('pre-push hook file')] })
    expect(r.full === false && r.files).toEqual(expect.arrayContaining([...GUARDS, ...MATRIX]))
  })
})

describe('prepush git calls are bounded', () => {
  // Fixture provenance: HAND-DERIVED. The negative control is a call written without a timeout, the shape these scripts had before the bound; the scripts are read as text and each call is found by balancing its parentheses.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const callsOf = (text: string): string[] => {
    const out: string[] = []
    for (let at = text.indexOf('execFileSync('); at !== -1; at = text.indexOf('execFileSync(', at + 1)) {
      let depth = 0
      for (let j = at + 'execFileSync'.length; j < text.length; j += 1) {
        if (text[j] === '(') depth += 1
        if (text[j] === ')') depth -= 1
        if (depth === 0) {
          out.push(text.slice(at, j + 1))
          break
        }
      }
    }
    return out
  }
  const unbounded = (calls: string[]): string[] => calls.filter((c) => !/\btimeout\s*:/.test(c))

  it.each(['scripts/prepush-select.mjs', 'scripts/prepush-readers.mjs', 'scripts/prepush-graph.mjs'])('every git call in %s names a timeout', (rel) => {
    const calls = callsOf(readFileSync(path.join(ROOT, rel), 'utf8'))
    expect(calls.length, `no git call found in ${rel}`).toBeGreaterThan(0)
    expect(unbounded(calls)).toEqual([])
  })

  it('the call scan flags a git call written without a timeout', () => {
    expect(unbounded(callsOf("const out = execFileSync('git', ['ls-files'], { cwd: root })"))).toEqual(["execFileSync('git', ['ls-files'], { cwd: root })"])
  })
})

describe('prepush selection: the full leg is only forced or unlistable', () => {
  it.each([
    ['PREPUSH_FULL=1', { PREPUSH_FULL: '1' }],
    ['TG_PREPUSH_FULL=1 (the older name)', { TG_PREPUSH_FULL: '1' }],
  ])('%s', (_name, env) => {
    const r = select([m('src/a.ts')], { env })
    expect(r).toEqual({ full: true, why: 'PREPUSH_FULL=1' })
  })

  it('PREPUSH_FULL=0 and an empty value do not force it', () => {
    expect(select([m('tests/x.test.ts')], { env: { PREPUSH_FULL: '0' } }).full).toBe(false)
    expect(select([m('tests/x.test.ts')], { env: { PREPUSH_FULL: '' } }).full).toBe(false)
  })

  it('a doubt with no way to list the test files is the only other full leg, and names both reasons', () => {
    const r = select([m('package.json')], { allTests: () => null })
    expect(r.full && r.why).toContain('package.json is not a src or tests module')
    expect(r.full && r.why).toContain('could not be listed')
  })
})

describe('prepush selection: every doubt that was a full leg is now a bounded selection', () => {
  // Fixture provenance: HAND-DERIVED from the reasons the selector returned full for before: one row per reason, each paired with a fragment of the doubt it must now record.
  const cases: [string, Parameters<typeof select>[0], Partial<Io>, string][] = [
    ['vitest config changed', [m('vitest.config.ts')], {}, 'vitest.config.ts'],
    ['package.json changed', [m('package.json')], {}, 'package.json'],
    ['lock file changed', [m('package-lock.json')], {}, 'package-lock.json'],
    ['tsconfig changed', [m('tsconfig.json')], {}, 'tsconfig.json'],
    ['test setup changed', [m('tests/setup/isolate-home.ts')], {}, 'tests/setup/isolate-home.ts'],
    ['fixture changed', [m('tests/fixtures/x/a.txt')], {}, 'tests/fixtures/x/a.txt'],
    ['nested hook helper changed', [m('.lefthook-scripts/lib/run-test.sh')], {}, '.lefthook-scripts/lib/run-test.sh'],
    ['script a test runs changed', [m('scripts/prepush-select.mjs')], {}, 'scripts/prepush-select.mjs'],
    ['markdown inside src (the shipping tree)', [m('src/canonical_skill.md')], {}, 'src/canonical_skill.md'],
    ['markdown under .github (read by the hooks)', [m('.github/copilot-instructions.md')], {}, '.github/copilot-instructions.md'],
    ['markdown under scripts', [m('scripts/x.md')], {}, 'scripts/x.md'],
    ['markdown under tests/fixtures', [m('tests/fixtures/x/a.md')], {}, 'tests/fixtures/x/a.md'],
    ['markdown beside a package.json change', [m('README.md'), m('package.json')], {}, 'package.json'],
    ['the test files cannot be scanned', [m('src/a.ts')], { readers: () => null }, 'could not be scanned'],
    ['src file deleted', [{ status: 'D', path: 'src/a.ts' }], {}, 'src/a.ts was deleted'],
    ['test helper deleted', [{ status: 'D', path: 'tests/helpers/x.ts' }], {}, 'tests/helpers/x.ts was deleted'],
    ['new branch', [m('src/a.ts')], { pushText: refLine(HEAD, ZERO) }, 'new remote ref refs/heads/feat'],
    ['deletion', [m('src/a.ts')], { pushText: refLine(ZERO, REMOTE, '(delete)', 'refs/heads/feat') }, 'deletion of refs/heads/feat'],
    ['one of two ref lines is a new branch', [m('src/a.ts')], { pushText: refLine(HEAD, REMOTE) + refLine(HEAD, ZERO, 'refs/heads/feat', 'refs/heads/new') }, 'new remote ref refs/heads/new'],
    ['empty stdin', [m('src/a.ts')], { pushText: '' }, 'no pushed ref lines'],
    ['blank stdin', [m('src/a.ts')], { pushText: '\n  \n' }, 'no pushed ref lines'],
    ['malformed ref line', [m('src/a.ts')], { pushText: 'refs/heads/feat 67890 refs/heads/feat 12345\n' }, 'unreadable pushed ref line'],
    ['pushed commit is not the checked-out one', [m('src/a.ts')], { pushText: refLine(OTHER, REMOTE) }, 'is not the checked-out commit'],
    ['git cannot list the range', null, {}, 'git could not list'],
    ['empty range', [], {}, 'changes no file'],
    ['last red run named no failing file', [m('tests/x.test.ts')], { unparsedFailure: () => true }, 'named no failing test file'],
    ['the import graph cannot be read', [m('src/a.ts')], { importers: () => null }, 'import graph'],
  ]
  it.each(cases)('%s', (_name, changed, over, why) => {
    const r = select(changed, over)
    expect(r.full, `expected a bounded selection, got ${JSON.stringify(r)}`).toBe(false)
    expect(r.full === false && r.doubts.join('\n')).toContain(why)
    if (r.full) return
    // Never cut under a doubt: the guards (unless none exist) and the matrix (unless none is listed), because the doubt can reach src.
    if (!(over.guards && over.guards().length === 0)) expect(r.files).toEqual(expect.arrayContaining(GUARDS))
    if (!(over.matrix && over.matrix().length === 0)) expect(r.files).toEqual(expect.arrayContaining(MATRIX))
    expect(r.note).toContain('doubt (')
  })

  // A failed guard or matrix listing is the unlistable-tree case: the leg runs in full, never as a doubt that the budget can cut.
  const unlisted: [string, Row[] | null, Partial<Io>, string][] = [
    ['the guard list fails while the tests list works', [m('src/a.ts')], { guards: () => [] }, 'guard tests'],
    ['src changed and the bundle matrix cannot be listed', [m('src/a.ts')], { matrix: () => [] }, 'bundle matrix'],
    ['a doubt and the bundle matrix cannot be listed', [m('tests/x.test.ts')], { unparsedFailure: () => true, matrix: () => [] }, 'bundle matrix'],
  ]
  it.each(unlisted)('%s runs the full leg', (_name, changed, over, why) => {
    const r = select(changed, over)
    expect(r.full === true && r.why).toContain(why)
  })

  it('a test-only change never lists the bundle matrix, so an empty matrix stays a bounded leg', () => {
    const r = select([m('tests/x.test.ts')], { matrix: () => [] })
    expect(r.full).toBe(false)
  })

  it('a doubt fills the budget with the other tests cheapest first', () => {
    const r = select([m('package.json')], { durations: () => ({ 'tests/o1.test.ts': 9000, 'tests/o2.test.ts': 1000, 'tests/o3.test.ts': 5000, 'tests/o4.test.ts': 3000 }) })
    expect(r.full === false && r.files).toEqual([...ALL_TESTS].sort())
  })

  it('under a tight budget the doubt defers the dearest files, lists them, and keeps every never-cut class', () => {
    // HAND-DERIVED: 4 never-cut files at 10 s each = 40 s over 4 workers x 1.4 = 14 s, plus the 45 s overhead = 59 s; each further 10 s file adds 3.5 s, so a 70 s budget holds 3 more (69.5 s) and defers the rest.
    const durations = Object.fromEntries(ALL_TESTS.map((f) => [f, 10_000]))
    const r = select([m('package.json')], { env: { PREPUSH_BUDGET_S: '70' }, durations: () => durations, failed: () => ['tests/old.test.ts'] })
    if (r.full) throw new Error(`expected a bounded selection, got ${r.why}`)
    expect(r.deferred.length).toBeGreaterThan(0)
    expect(r.deferredReport).toContain(`deferred to CI: ${r.deferred.length} files`)
    for (const f of r.deferred) expect(r.files).not.toContain(f)
    expect(r.files).toEqual(expect.arrayContaining([...GUARDS, ...MATRIX, 'tests/old.test.ts']))
    expect(r.files.length + r.deferred.length).toBe(ALL_TESTS.length + 1)
  })

  it('a text reader of the changed path runs before a cheaper unrelated test', () => {
    const durations = Object.fromEntries(ALL_TESTS.map((f) => [f, 10_000]))
    const r = select([m('package-lock.json')], { env: { PREPUSH_BUDGET_S: '63' }, durations: () => ({ ...durations, 'tests/o1.test.ts': 5000 }), readers: () => [['tests/x.test.ts'], [], []] })
    if (r.full) throw new Error(`expected a bounded selection, got ${r.why}`)
    expect(r.files).toContain('tests/x.test.ts')
    expect(r.deferred).toContain('tests/o1.test.ts')
  })

  it('a floor of guards and matrix over the budget is kept and the note says so', () => {
    const r = select([m('package.json')], { env: { PREPUSH_BUDGET_S: '50' }, durations: () => Object.fromEntries(ALL_TESTS.map((f) => [f, 60_000])) })
    expect(r.full === false && r.note).toContain('the guards and the matrix alone are estimated at')
    expect(r.full === false && r.files).toEqual(expect.arrayContaining([...GUARDS, ...MATRIX]))
  })

  it('changed tests and failed files that alone exceed the budget are cut to it, cheapest first, with the guards and matrix intact', () => {
    const tests = ['tests/c1.test.ts', 'tests/c2.test.ts', 'tests/c3.test.ts', 'tests/c4.test.ts']
    const table: Record<string, number> = { ...Object.fromEntries(ALL_TESTS.map((f) => [f, 1_000])), 'tests/c1.test.ts': 40_000, 'tests/c2.test.ts': 30_000, 'tests/c3.test.ts': 20_000, 'tests/c4.test.ts': 10_000 }
    const r = select([m('src/a.ts'), ...tests.map((t) => m(t))], { env: { PREPUSH_BUDGET_S: '60' }, durations: () => table, exists: () => true, allTests: () => [...ALL_TESTS, ...tests].sort() })
    if (r.full) throw new Error(r.why)
    expect(r.files).toEqual(expect.arrayContaining([...GUARDS, ...MATRIX]))
    expect(r.files.filter((f) => tests.includes(f))).toEqual(['tests/c3.test.ts', 'tests/c4.test.ts'])
    expect(r.deferred.slice(0, 2)).toEqual(['tests/c2.test.ts', 'tests/c1.test.ts'])
    expect(r.note).toContain('the never-cut set (failed before, changed tests) exceeded the budget, 2 of its 4 files deferred')
    expect(r.deferredReport).toContain('tests/c1.test.ts')
  })

  it('the real script names the doubt and lists the cut files', () => {
    // Fixture provenance: HAND-DERIVED. A temp repo with three tracked tests and a guard; the push changes package.json, which no import edge reaches.
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-doubt-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      mkdirSync(path.join(root, 'tests', 'guards'), { recursive: true })
      // The bundle matrix is in the fixture because the real tree has one: an unlistable matrix runs the full leg.
      for (const f of ['tests/guards/g.test.ts', 'tests/a.test.ts', 'tests/b.test.ts', 'tests/command_matrix_e2e.1.test.ts']) writeFileSync(path.join(root, f), 'export {}\n')
      writeFileSync(path.join(root, 'package.json'), '{}\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      const commit = (msg: string): string => {
        execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', msg], { cwd: root })
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      }
      const first = commit('one')
      writeFileSync(path.join(root, 'package.json'), '{"a":1}\n')
      execFileSync('git', ['add', 'package.json'], { cwd: root })
      const second = commit('two')
      const pushFile = path.join(root, 'push.txt')
      writeFileSync(pushFile, refLine(second, first))
      const deferFile = path.join(root, 'defer.txt')
      // The worker count is pinned: unset, the estimate divides by 4 on Windows and 6 elsewhere, and at 6 all three files fit the 50 s budget and nothing is deferred.
      const out = spawnSync(process.execPath, [SELECT_SCRIPT, root, 'win', second, pushFile, '', deferFile], { encoding: 'utf8', timeout: 60000, env: { ...hermeticEnv(), PREPUSH_BUDGET_S: '50', TOKEN_GOAT_TEST_MAX_WORKERS: '4' } })
      const lines = out.stdout.split('\n')
      expect(lines[0]).toContain('FOCUS\twin leg focused')
      expect(lines[0]).toContain('doubt (')
      expect(lines[0]).toContain('package.json is not a src or tests module')
      expect(lines).toContain('tests/guards/g.test.ts')
      expect(readFileSync(deferFile, 'utf8')).toContain('deferred to CI')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('prepush selection: the pushed remote name, from the real script', () => {
  it('a tag of a commit origin has selects the guards alone when origin is named, even with a second remote that has no tracking refs, and still selects tests when the name is absent', () => {
    // Fixture provenance: HAND-DERIVED. A temp repo with two remotes, a tracking ref for origin only, and a tag of the commit that ref holds.
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-named-'))
    try {
      const git = (...a: string[]): string => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      git('init', '-q')
      mkdirSync(path.join(root, 'tests', 'guards'), { recursive: true })
      for (const f of ['tests/guards/g.test.ts', 'tests/a.test.ts', 'tests/command_matrix_e2e.1.test.ts']) writeFileSync(path.join(root, f), 'export {}\n')
      git('add', '.')
      git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'one')
      const head = git('rev-parse', 'HEAD').trim()
      git('remote', 'add', 'origin', root)
      git('remote', 'add', 'fork', root)
      git('update-ref', 'refs/remotes/origin/main', head)
      const pushFile = path.join(root, 'push.txt')
      writeFileSync(pushFile, refLine(head, ZERO, 'refs/tags/v1', 'refs/tags/v1'))
      const run = (...extra: string[]): string[] => spawnSync(process.execPath, [SELECT_SCRIPT, root, 'win', head, pushFile, '', '', ...extra], { encoding: 'utf8', timeout: 60000, env: hermeticEnv() }).stdout.split('\n')
      const named = run('origin')
      expect(named[0]).toContain('no pushed ref brings a commit the remote lacks')
      expect(named).toContain('tests/guards/g.test.ts')
      expect(named).not.toContain('tests/a.test.ts')
      const unnamed = run()
      expect(unnamed[0]).not.toContain('no pushed ref brings a commit the remote lacks')
      expect(unnamed).toContain('tests/a.test.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('prepush selection: a ref that brings no new commit', () => {
  const TAG =refLine(OTHER, ZERO, 'refs/tags/v1', 'refs/tags/v1')

  it('a tag of a commit the remote has runs the guards alone, without the diff, the graph or the readers', () => {
    const r = select(null, {
      pushText: TAG,
      onRemote: (sha: string) => sha === OTHER,
      changed: () => {
        throw new Error('no diff for a ref with no new commit')
      },
      importers: () => {
        throw new Error('no graph read')
      },
      readers: () => {
        throw new Error('no reader scan')
      },
    })
    expect(r).toMatchObject({ full: false, doubts: [], deferred: [] })
    expect(r.full === false && r.files).toEqual(GUARDS)
    expect(r.full === false && r.note).toContain('no pushed ref brings a commit the remote lacks')
  })

  it('a failed file of an earlier red leg still runs with such a tag', () => {
    const r = select(null, { pushText: TAG, onRemote: () => true, failed: () => ['tests/old.test.ts'] })
    expect(r.full === false && r.files).toEqual(['tests/guards/a.test.ts', 'tests/guards/b.test.ts', 'tests/old.test.ts'])
  })

  it('a tag whose commit is new to the remote still selects the importers of its changed modules', () => {
    const r = select([m('src/a.ts')], { pushText: TAG, onRemote: () => false, mergeBase: () => REMOTE })
    expect(r.full === false && r.doubts).toEqual([expect.stringContaining('is not the checked-out commit')])
    expect(r.full === false && r.files).toEqual(expect.arrayContaining([...GUARDS, ...MATRIX, 'tests/near.test.ts', 'tests/far.test.ts']))
  })

  it('an unknown remote state (onRemote false) selects the diff rather than nothing', () => {
    const r = select([m('tests/x.test.ts')], { pushText: refLine(HEAD, REMOTE), onRemote: () => false })
    expect(r.full === false && r.files).toContain('tests/x.test.ts')
  })

  it('one pushed ref with a new commit keeps its tests next to a tag with none', () => {
    const r = select([m('tests/x.test.ts')], { pushText: refLine(HEAD, REMOTE) + TAG, onRemote: (sha: string) => sha === OTHER })
    expect(r.full === false && r.files).toContain('tests/x.test.ts')
  })
})

describe('prepush onEveryRemote', () => {
  // Fixture provenance: HAND-DERIVED. The git seam answers like git: rev-parse prints the peeled commit, remote lists names, for-each-ref prints the refs that contain it.
  const fakeGit = (remotes: string[], containing: Record<string, string>, commit = HEAD) => (...args: string[]): string => {
    if (args[0] === 'rev-parse') return `${commit}\n`
    if (args[0] === 'remote') return remotes.join('\n')
    return containing[args[args.length - 1]!] ?? ''
  }
  it('is true when every remote has a tracking ref containing the commit', () => {
    expect(onEveryRemote(fakeGit(['origin'], { 'refs/remotes/origin/': 'refs/remotes/origin/main\n' }), OTHER)).toBe(true)
  })
  it('is false when one of two remotes lacks it', () => {
    expect(onEveryRemote(fakeGit(['origin', 'fork'], { 'refs/remotes/origin/': 'refs/remotes/origin/main\n' }), OTHER)).toBe(false)
  })
  it('with the pushed remote named, only that remote counts: an extra remote with no tracking refs does not matter', () => {
    const git = fakeGit(['origin', 'fork'], { 'refs/remotes/origin/': 'refs/remotes/origin/main\n' })
    expect(onEveryRemote(git, OTHER, 'origin')).toBe(true)
    expect(onEveryRemote(git, OTHER, 'fork')).toBe(false)
    expect(onEveryRemote(git, OTHER)).toBe(false)
    expect(onEveryRemote(git, OTHER, 'git@example.invalid:r.git')).toBe(false)
  })
  it('is false with no remote, no tracking ref, or a git call that throws', () => {
    expect(onEveryRemote(fakeGit([], {}), OTHER)).toBe(false)
    expect(onEveryRemote(fakeGit(['origin'], {}), OTHER)).toBe(false)
    expect(
      onEveryRemote(() => {
        throw new Error('git failed')
      }, OTHER),
    ).toBe(false)
  })
  it('is false when the object does not peel to a commit sha', () => {
    expect(onEveryRemote(fakeGit(['origin'], { 'refs/remotes/origin/': 'x\n' }, 'not-a-sha'), OTHER)).toBe(false)
  })
  it('with the real git: a commit on origin/main is known, a newer local commit is not, and a repo with no remote knows nothing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-remote-'))
    try {
      const git = (...a: string[]): string => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      git('init', '-q')
      git('config', 'user.email', 't@example.invalid')
      git('config', 'user.name', 't')
      writeFileSync(path.join(root, 'a.txt'), 'a\n')
      git('add', 'a.txt')
      git('commit', '-q', '-m', 'one')
      const first = git('rev-parse', 'HEAD').trim()
      expect(onEveryRemote(git, first)).toBe(false)
      git('remote', 'add', 'origin', root)
      git('update-ref', 'refs/remotes/origin/main', first)
      git('tag', '-a', 'v1', '-m', 'tag')
      const tagObject = git('rev-parse', 'v1').trim()
      expect(onEveryRemote(git, first)).toBe(true)
      expect(onEveryRemote(git, tagObject)).toBe(true)
      writeFileSync(path.join(root, 'a.txt'), 'b\n')
      git('commit', '-q', '-am', 'two')
      expect(onEveryRemote(git, git('rev-parse', 'HEAD').trim())).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('prepush pushed ref parsing', () => {
  it('reads each line into its four fields', () => {
    expect(parsePushRefs(refLine(HEAD, REMOTE) + refLine(OTHER, ZERO, 'refs/heads/b', 'refs/heads/b'))).toEqual({
      refs: [
        { lref: 'refs/heads/feat', lsha: HEAD, rref: 'refs/heads/feat', rsha: REMOTE },
        { lref: 'refs/heads/b', lsha: OTHER, rref: 'refs/heads/b', rsha: ZERO },
      ],
      bad: null,
    })
  })

  it.each([
    ['three fields', `refs/heads/a ${HEAD} refs/heads/a\n`],
    ['five fields', `refs/heads/a ${HEAD} refs/heads/a ${REMOTE} x\n`],
    ['a short sha', `refs/heads/a ${HEAD} refs/heads/a 12345\n`],
    ['a non-hex sha', `refs/heads/a ${'g'.repeat(40)} refs/heads/a ${REMOTE}\n`],
  ])('rejects %s', (_name, text) => {
    expect(parsePushRefs(text).bad).not.toBeNull()
  })

  it('accepts CRLF line ends and a 64-digit object name', () => {
    expect(parsePushRefs(`refs/heads/a ${'1'.repeat(64)} refs/heads/a ${'2'.repeat(64)}\r\n`).bad).toBeNull()
  })
})

describe('prepush range and path rules', () => {
  it('a plain update is remote..local, whichever commit is checked out', () => {
    expect(rangeOf({ lref: 'r', lsha: HEAD, rref: 'r', rsha: REMOTE })).toEqual({ from: REMOTE, to: HEAD })
    expect(rangeOf({ lref: 'r', lsha: OTHER, rref: 'r', rsha: REMOTE })).toEqual({ from: REMOTE, to: OTHER })
  })

  it('a new remote ref is diffed from its merge base with origin/main, and is a doubt only without one', () => {
    const fresh = { lref: 'r', lsha: HEAD, rref: 'r', rsha: ZERO }
    expect(rangeOf(fresh, OTHER)).toEqual({ from: OTHER, to: HEAD })
    expect(rangeOf(fresh, null)).toHaveProperty('doubt')
    expect(rangeOf({ ...fresh, lsha: OTHER }, REMOTE)).toEqual({ from: REMOTE, to: OTHER })
  })

  it.each([
    ['M', 'CHANGELOG.md'],
    ['M', 'docs/architecture.md'],
    ['A', 'docs/img/a.png'],
    ['D', 'docs/old.md'],
    ['M', 'vscode-extension/README.md'],
    ['M', 'demo/README.md'],
  ])('%s %s is documentation', (status, p) => {
    expect(classifyPath(status, p)).toEqual({ kind: 'doc' })
  })

  it.each([
    ['M', 'src/a.ts', { kind: 'module' }],
    ['A', 'src/tool_filters/x.mjs', { kind: 'module' }],
    ['M', 'tests/helpers/bundle.ts', { kind: 'module' }],
    ['M', 'tests/a.test.ts', { kind: 'test' }],
    ['D', 'tests/a.test.ts', { kind: 'skip' }],
  ])('%s %s is covered', (status, p, want) => {
    expect(classifyPath(status, p)).toEqual(want)
  })

  it.each(['src/data.json', 'src/queries/a.scm', 'tests/data/a.json', 'tests/setup/x.ts', 'tests/fixtures/a.ts', 'scripts/a.mjs', 'vscode-extension/src/a.ts', 'native/x.rs', '.github/workflows/ci.yml'])('%s is outside what vitest related can see', (p) => {
    expect(classifyPath('M', p)).toHaveProperty('doubt')
  })

  it('reads git -z --name-status output', () => {
    expect(parseNameStatus('M\0src/a.ts\0D\0tests/b.test.ts\0A\0docs/c.md\0')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'tests/b.test.ts' },
      { status: 'A', path: 'docs/c.md' },
    ])
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('a failing git call and no test tree in select main runs the full leg', () => {
  // Fixture provenance: HAND-DERIVED. The shas are synthetic and absent from the temp repo, so the git call that reads them fails on its own.
  const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prepush-select.mjs')
  it('orNull returns null when the read throws, and the read value otherwise', () => {
    expect(
      orNull(() => {
        throw new Error('git failed')
      }),
    ).toBeNull()
    expect(orNull(() => ['src/a.ts'])).toEqual(['src/a.ts'])
  })
  it('a range git cannot list selects the full leg and names the reason, from the real script', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-select-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      writeFileSync(path.join(root, 'a.txt'), 'a\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: root })
      execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
      const pushFile = path.join(root, 'push.txt')
      writeFileSync(pushFile, refLine(HEAD, REMOTE))
      const out = spawnSync(process.execPath, [SCRIPT, root, 'win', HEAD, pushFile, '', ''], { encoding: 'utf8', timeout: 60000, env: hermeticEnv() })
      expect(out.stdout.split('\n')[0]).toBe(`FULL\twin leg full: git could not list ${REMOTE.slice(0, 9)}..${HEAD.slice(0, 9)}, and the test files could not be listed to choose among them`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a range git cannot list with a listable test tree is a doubt, from the real script', () => {
  const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prepush-select.mjs')
  it('the guards and the matrix list, so the unlistable range is a bounded doubt leg, not the full one', () => {
    // Fixture provenance: HAND-DERIVED. The temp repo has the guard, matrix and ordinary test files; the remote sha is absent, so git cannot list the range on its own.
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-select-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      mkdirSync(path.join(root, 'tests', 'guards'), { recursive: true })
      for (const f of ['tests/guards/g.test.ts', 'tests/a.test.ts', 'tests/command_matrix_e2e.1.test.ts']) writeFileSync(path.join(root, f), 'export {}\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const pushFile = path.join(root, 'push.txt')
      writeFileSync(pushFile, refLine(head, REMOTE))
      const out = spawnSync(process.execPath, [SCRIPT, root, 'win', head, pushFile, '', ''], { encoding: 'utf8', timeout: 60000, env: hermeticEnv() })
      const first = out.stdout.split('\n')[0]
      expect(first.startsWith('FOCUS\t')).toBe(true)
      expect(first).toContain(`git could not list ${REMOTE.slice(0, 9)}..${head.slice(0, 9)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a change that reaches test setup, or a wide push, is a doubt, not the full leg', () => {
  // Fixture provenance: HAND-DERIVED. The setup seam is a stub returning the setup file the graph reached; the real-tree row reads the repo's own import graph.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  it('a changed module that reaches a setup file is a doubt that names the file', () => {
    const r = select([m('src/hint_stats.ts')], { importers: () => new Map(), setups: () => ['tests/setup/reset-hint-stats.ts'] })
    expect(r.full ? r.why : r.doubts).toEqual(['tests/setup/reset-hint-stats.ts is test setup, which runs before every test'])
  })
  it('a changed module whose setup read fails is a doubt with the import-graph reason', () => {
    // Fixture provenance: HAND-DERIVED. The importers seam answers, and the setups seam returns null: the setup read failed on its own.
    const run = () => select([m('src/a.ts')], { importers: () => new Map(), setups: () => null })
    expect(run).not.toThrow()
    const r = run()
    expect(r.full ? r.why : r.doubts).toEqual(['the import graph of src and tests could not be read'])
  })
  it('the real import graph: src/hint_stats.ts reaches tests/setup and is a doubt', () => {
    const r = select([m('src/hint_stats.ts')], { importers: (mods) => graph.testsImporting(ROOT, mods), setups: (mods) => graph.importReach(ROOT, mods).setups })
    expect(r.full ? r.why : r.doubts[0]).toMatch(/^tests\/setup\/.+ is test setup, which runs before every test$/)
  })
  const docs = (n: number): Row[] => Array.from({ length: n }, (_, i) => m(`docs/d${i}.md`))
  it('201 changed paths are a doubt that names the count, and skip the reader scan', () => {
    const r = select(docs(201), {
      readers: () => {
        throw new Error('no reader scan past the cap')
      },
    })
    expect(r.full ? r.why : r.doubts).toEqual(['the pushed range changes 201 paths, more than the 200 a focused leg reads'])
  })
  it('200 changed paths are not cut by the cap', () => {
    const r = select(docs(200))
    expect(r.full === false && r.doubts).toEqual([])
  })
})

describe('prepush import graph seams map a failed read to null', () => {
  // Fixture provenance: HAND-DERIVED. The read stubs are counters over synthetic module lists, not a real import graph.
  it('a throwing read makes both seams null, not an empty map or list', () => {
    const seams = importSeams(() => {
      throw new Error('graph unreadable')
    })
    expect(seams.importers(['src/a.ts'])).toBeNull()
    expect(seams.setups(['src/a.ts'])).toBeNull()
  })

  it('reads once per modules key, shares the read between both seams, and gives each key its own result', () => {
    let reads = 0
    const seams = importSeams((modules) => {
      reads += 1
      return { tests: new Map([[modules[0], 1]]), setups: [`tests/setup/${modules[0]}`] }
    })
    expect(seams.importers(['src/a.ts'])).toEqual(new Map([['src/a.ts', 1]]))
    expect(seams.setups(['src/a.ts'])).toEqual(['tests/setup/src/a.ts'])
    expect(reads).toBe(1)
    expect(seams.importers(['src/b.ts'])).toEqual(new Map([['src/b.ts', 1]]))
    expect(seams.setups(['src/b.ts'])).toEqual(['tests/setup/src/b.ts'])
    expect(reads).toBe(2)
  })
})

describe('a new ref with no readable merge base and no test tree runs the full leg, from the real script', () => {
  const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prepush-select.mjs')
  it('merge-base against a missing origin/main returns null, so the new ref selects the full leg', () => {
    // Fixture provenance: HAND-DERIVED. The temp repo has one commit and no origin/main, so git merge-base fails on its own; the pushed sha is the repo's real HEAD.
    const root = mkdtempSync(path.join(tmpdir(), 'prepush-select-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      writeFileSync(path.join(root, 'a.txt'), 'a\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: root })
      execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const pushFile = path.join(root, 'push.txt')
      writeFileSync(pushFile, refLine(head, ZERO))
      const out = spawnSync(process.execPath, [SCRIPT, root, 'win', head, pushFile, '', ''], { encoding: 'utf8', timeout: 60000, env: hermeticEnv() })
      expect(out.stdout.split('\n')[0]).toBe('FULL\twin leg full: new remote ref refs/heads/feat with no merge base on origin/main, and the test files could not be listed to choose among them')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
