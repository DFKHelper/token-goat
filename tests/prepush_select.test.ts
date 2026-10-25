/** scripts/prepush-select.mjs decides which test files a pre-push suite leg runs: a wrong selection fails silently (a red test is skipped), so every doubt must come back as the full leg. */
import { describe, expect, it } from 'vitest'
import { classifyPath, decideSelection, parseNameStatus, parsePushRefs, rangeOf } from '../scripts/prepush-select.mjs'

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
    // HAND-DERIVED: six files untimed at 3 s each = 18 s, over 4 workers = 4.5 s, times the 1.4 calibration = 6.3 s, plus the 45 s fixed overhead = 51.3 s
    expect(r.full === false && r.note).toBe('win leg focused: 6 file(s), estimated ~51 s of a 600 s budget (default); 0 failed before, 0 changed tests, 2 guard tests, 2 bundle matrix tests, 1 direct and 1 further importers; deferred to CI: 0 files; set PREPUSH_FULL=1 for the full leg')
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
    ['hook script changed', [m('.lefthook-scripts/run-test.sh')], {}, '.lefthook-scripts/run-test.sh'],
    ['script a test runs changed', [m('scripts/prepush-select.mjs')], {}, 'scripts/prepush-select.mjs'],
    ['markdown changed beside a src change', [m('src/a.ts'), m('README.md')], {}, 'README.md'],
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

  it.each([
    ['M', 'src/a.ts', { kind: 'module' }],
    ['A', 'src/tool_filters/x.mjs', { kind: 'module' }],
    ['M', 'tests/helpers/bundle.ts', { kind: 'module' }],
    ['M', 'tests/a.test.ts', { kind: 'test' }],
    ['D', 'tests/a.test.ts', { kind: 'skip' }],
  ])('%s %s is covered', (status, p, want) => {
    expect(classifyPath(status, p)).toEqual(want)
  })

  it.each(['src/data.json', 'src/queries/a.scm', 'tests/data/a.json', 'tests/setup/x.ts', 'tests/fixtures/a.ts', 'scripts/a.mjs', 'vscode-extension/src/a.ts', 'docs/a.md', 'native/x.rs', '.github/workflows/ci.yml'])('%s is outside what vitest related can see', (p) => {
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
