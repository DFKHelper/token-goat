/** scripts/prepush-select.mjs decides which test files a pre-push suite leg runs: a wrong selection fails silently (a red test is skipped), so every doubt must come back as the full leg. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as graph from '../scripts/prepush-graph.mjs'
import { classifyPath, decideSelection, importSeams, orNull, parseNameStatus, parsePushRefs, rangeOf } from '../scripts/prepush-select.mjs'

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
    expect(r.full === false && r.note).toBe('win leg focused: 6 file(s), estimated ~58 s of a 600 s budget (default); 0 failed before, 0 changed tests, 2 guard tests, 2 bundle matrix tests, 1 direct and 1 further importers, 0 text or bundle readers; deferred to CI: 0 files; costs: no duration table, every file costed at the default 6 s; set PREPUSH_FULL=1 for the full leg')
  })
})

describe('prepush selection: a pre-push hook file', () => {
  // Fixture provenance: the path shapes are HAND-DERIVED from the hook layout (.lefthook-scripts/prepush-focus.sh is the file the leg sources, lib/x.sh a nested helper); the verdict is the full leg by the rule, not read off the implementation.
  it.each(['.lefthook-scripts/prepush-focus.sh', '.lefthook-scripts/lib/x.sh', '.lefthook-scripts/notes.txt', '.lefthook-scripts/README.md'])('a change to %s runs the full leg, since a focused leg cannot verify the hook', (p) => {
    expect(select([m(p)])).toEqual({ full: true, why: expect.stringContaining('pre-push hook file') })
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

describe('prepush selection: the full leg', () => {
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
    ['PREPUSH_FULL=1', [m('src/a.ts')], { env: { PREPUSH_FULL: '1' } }, 'PREPUSH_FULL=1'],
    ['TG_PREPUSH_FULL=1 (the older name)', [m('src/a.ts')], { env: { TG_PREPUSH_FULL: '1' } }, 'PREPUSH_FULL=1'],
    ['last red run named no failing file', [m('tests/x.test.ts')], { unparsedFailure: () => true }, 'named no failing test file'],
    ['the import graph cannot be read', [m('src/a.ts')], { importers: () => null }, 'import graph'],
    ['src changed and no bundle matrix is found', [m('src/a.ts')], { matrix: () => [] }, 'matrix tests could not be listed'],
    ['no guard tests found', [m('tests/x.test.ts')], { guards: () => [] }, 'no guard tests'],
  ]
  it.each(cases)('%s', (_name, changed, over, why) => {
    const r = select(changed, over)
    expect(r.full, `expected the full leg, got ${JSON.stringify(r)}`).toBe(true)
    expect(r.full && r.why).toContain(why)
  })

  it('PREPUSH_FULL=0 and an empty value do not force it', () => {
    expect(select([m('tests/x.test.ts')], { env: { PREPUSH_FULL: '0' } }).full).toBe(false)
    expect(select([m('tests/x.test.ts')], { env: { PREPUSH_FULL: '' } }).full).toBe(false)
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
  it('a plain update is remote..local; a deletion, a new ref and a foreign local sha are not', () => {
    expect(rangeOf({ lref: 'r', lsha: HEAD, rref: 'r', rsha: REMOTE }, HEAD)).toEqual({ from: REMOTE, to: HEAD })
    expect(rangeOf({ lref: '(delete)', lsha: ZERO, rref: 'r', rsha: REMOTE }, HEAD)).toHaveProperty('full')
    expect(rangeOf({ lref: 'r', lsha: HEAD, rref: 'r', rsha: ZERO }, HEAD)).toHaveProperty('full')
    expect(rangeOf({ lref: 'r', lsha: OTHER, rref: 'r', rsha: REMOTE }, HEAD)).toHaveProperty('full')
  })

  it('a new remote ref is diffed from its merge base with origin/main, and is full only without one', () => {
    const fresh = { lref: 'r', lsha: HEAD, rref: 'r', rsha: ZERO }
    expect(rangeOf(fresh, HEAD, OTHER)).toEqual({ from: OTHER, to: HEAD })
    expect(rangeOf(fresh, HEAD, null)).toHaveProperty('full')
    expect(rangeOf({ ...fresh, lsha: OTHER }, HEAD, REMOTE)).toHaveProperty('full')
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
    expect(classifyPath('M', p)).toHaveProperty('full')
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

describe('a failing git call in select main runs the full leg', () => {
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
      const out = spawnSync(process.execPath, [SCRIPT, root, 'win', HEAD, pushFile, '', ''], { encoding: 'utf8', timeout: 60000 })
      expect(out.stdout.split('\n')[0]).toBe(`FULL\twin leg full: git could not list ${REMOTE.slice(0, 9)}..${HEAD.slice(0, 9)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a change that reaches test setup, or a wide push, runs the full leg', () => {
  // Fixture provenance: HAND-DERIVED. The setup seam is a stub returning the setup file the graph reached; the real-tree row reads the repo's own import graph.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  it('a changed module that reaches a setup file selects the full leg and names the file', () => {
    const r = select([m('src/hint_stats.ts')], { importers: () => new Map(), setups: () => ['tests/setup/reset-hint-stats.ts'] })
    expect(r.full ? r.why : 'focused').toBe('tests/setup/reset-hint-stats.ts is test setup, which runs before every test')
  })
  it('a changed module whose setup read fails selects the full leg, with the import-graph reason', () => {
    // Fixture provenance: HAND-DERIVED. The importers seam answers, and the setups seam returns null: the setup read failed on its own.
    const run = () => select([m('src/a.ts')], { importers: () => new Map(), setups: () => null })
    expect(run).not.toThrow()
    const r = run()
    expect(r.full ? r.why : 'focused').toBe('the import graph of src and tests could not be read')
  })
  it('the real import graph: src/hint_stats.ts reaches tests/setup and selects the full leg', () => {
    const r = select([m('src/hint_stats.ts')], { importers: (mods) => graph.testsImporting(ROOT, mods), setups: (mods) => graph.importReach(ROOT, mods).setups })
    expect(r.full ? r.why : 'focused').toMatch(/^tests\/setup\/.+ is test setup, which runs before every test$/)
  })
  const docs = (n: number): Row[] => Array.from({ length: n }, (_, i) => m(`docs/d${i}.md`))
  it('201 changed paths select the full leg and name the count', () => {
    const r = select(docs(201))
    expect(r.full ? r.why : 'focused').toBe('the pushed range changes 201 paths, more than the 200 a focused leg reads')
  })
  it('200 changed paths are not cut by the cap', () => {
    const r = select(docs(200))
    expect(r.full).toBe(false)
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

describe('a new ref with no readable merge base runs the full leg, from the real script', () => {
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
      const out = spawnSync(process.execPath, [SCRIPT, root, 'win', head, pushFile, '', ''], { encoding: 'utf8', timeout: 60000 })
      expect(out.stdout.split('\n')[0]).toBe('FULL\twin leg full: new remote ref refs/heads/feat with no merge base on origin/main')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
