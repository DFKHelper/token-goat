/** scripts/prepush-readers.mjs lists the tests the import graph cannot see (text readers of a changed path, whole-src readers, bundle spawners); a test that should be considered must end up run or listed as deferred, never in neither. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTrackedTests, textReaderTiers } from '../scripts/prepush-readers.mjs'
import { decideSelection } from '../scripts/prepush-select.mjs'

// Fixture provenance. Test texts: HAND-DERIVED from the two shapes the repo's own tests take (tests/bridges_status.test.ts scans every file of src with readdirSync and readFileSync; tests/helpers/bundle.ts is imported by the files that spawn dist/token-goat.mjs), reduced to the lines the scan keys on. The shas are synthetic.
const WHOLE_SRC = "import fs from 'node:fs'\nconst names = fs.readdirSync(path.join(ROOT, 'src'))\n"
const BUNDLE_SPAWNER = "import { bundleTg } from './helpers/bundle.js'\nbundleTg(project, env, ['status'])\n"
const NAMES_PATH = "const text = fs.readFileSync(path.join(ROOT, 'src/read_commands.ts'), 'utf8')\n"
const ONLY_IMPORTS = "import { run } from '../src/read_commands.js'\nrun()\n"
const texts = new Map([
  ['tests/names.test.ts', NAMES_PATH],
  ['tests/only_imports.test.ts', ONLY_IMPORTS],
  ['tests/whole_src.test.ts', WHOLE_SRC],
  ['tests/spawner.test.ts', BUNDLE_SPAWNER],
  ['tests/unrelated.test.ts', 'expect(1).toBe(1)\n'],
])

describe('prepush text and bundle readers', () => {
  it('a src change yields three tiers: tests naming the path, tests scanning src, tests spawning the bundle', () => {
    expect(textReaderTiers(texts, ['src/read_commands.ts'], true)).toEqual([['tests/names.test.ts'], ['tests/whole_src.test.ts'], ['tests/spawner.test.ts']])
  })

  it('a push that changes no src file lists only the tests naming the changed path', () => {
    expect(textReaderTiers(texts, ['CHANGELOG.md'], false)).toEqual([[], [], []])
    expect(textReaderTiers(new Map([['tests/doc.test.ts', "fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'))"], ['tests/other.test.ts', "'SECURITY.md'"]]), ['CHANGELOG.md'], false)).toEqual([['tests/doc.test.ts'], [], []])
  })

  it('a file name is not the tail of a longer one, and an import alone is the graph business', () => {
    const t = new Map([['tests/longer.test.ts', "read('src/path_util.ts')"], ['tests/exact.test.ts', "read('src/util.ts')"], ['tests/imports.test.ts', "import { u } from '../src/util.js'"]])
    expect(textReaderTiers(t, ['src/util.ts'], false)[0]).toEqual(['tests/exact.test.ts'])
  })
})

describe('prepush readers in the selection', () => {
  const HEAD = 'a'.repeat(40)
  const REMOTE = 'b'.repeat(40)
  const GUARDS = ['tests/guards/a.test.ts']
  const MATRIX = ['tests/command_matrix_e2e.1.test.ts']
  const READERS = [['tests/names.test.ts'], ['tests/whole_src.test.ts'], ['tests/spawner.test.ts']]
  const everyReader = READERS.flat()
  function select(env: Record<string, string>) {
    return decideSelection({
      leg: 'win',
      headSha: HEAD,
      pushText: `refs/heads/feat ${HEAD} refs/heads/feat ${REMOTE}\n`,
      env,
      changed: () => [{ status: 'M', path: 'src/read_commands.ts' }],
      failed: () => [],
      unparsedFailure: () => false,
      exists: () => true,
      guards: () => GUARDS,
      matrix: () => MATRIX,
      importers: () => new Map(),
      mergeBase: () => null,
      readers: () => READERS,
      durations: () => ({}),
      workers: 4,
    })
  }

  it('with room, a whole-src reader and a bundle spawner are selected', () => {
    const r = select({})
    expect(r.full === false && r.files).toEqual([...GUARDS, ...MATRIX, ...everyReader].sort())
  })

  it('with no room, each is listed as deferred, so none is in neither list', () => {
    const r = select({ PREPUSH_BUDGET_S: '1' })
    expect(r.full === false && r.files).toEqual([...GUARDS, ...MATRIX].sort())
    for (const f of everyReader) expect(r.full === false && r.deferredReport, `${f} is neither run nor deferred`).toContain(`  ${f}\n`)
    expect(r.full === false && r.deferredReport).toMatch(/^deferred to CI: 3 files \(~\d+ s\)\n/)
  })

  it('the budget cuts the generic readers before a test that names the changed path', () => {
    // HAND-DERIVED: 45 s fixed + 1.4 x n files x 3 s / 4 workers = 45 + 1.05 n, so 49 s holds three files (48.15 s) and not four (49.2 s); the guard and the matrix are two, leaving room for exactly one reader
    const r = select({ PREPUSH_BUDGET_S: '49' })
    expect(r.full === false && r.files).toContain('tests/names.test.ts')
    expect(r.full === false && r.deferred).toEqual(['tests/whole_src.test.ts', 'tests/spawner.test.ts'])
    expect(r.full === false && r.files).not.toContain('tests/whole_src.test.ts')
  })
})

describe('prepush tracked test scan', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the tracked test files only: not untracked ones, fixtures or non-test files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-readers-'))
    const files: Record<string, string> = { 'tests/a.test.ts': 'a', 'tests/helpers/h.ts': 'h', 'tests/fixtures/f.test.ts': 'f', 'tests/guards/g.test.ts': 'g' }
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), text)
    }
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    git('add', '-A')
    writeFileSync(path.join(dir, 'tests/untracked.test.ts'), 'u')
    expect([...readTrackedTests(dir).keys()].sort()).toEqual(['tests/a.test.ts', 'tests/guards/g.test.ts'])
  })
})
