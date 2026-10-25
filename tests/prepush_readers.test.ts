/** scripts/prepush-readers.mjs lists the tests the import graph cannot see (text readers of a changed path, whole-src readers, bundle spawners); a test that should be considered must end up run or listed as deferred, never in neither. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTrackedTests, textReaderTiers, withoutCommentsOrUrls } from '../scripts/prepush-readers.mjs'
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

describe('prepush docs rule reads code, not comments or URLs', () => {
  // Fixture provenance: the comment shape is CAPTURE of tests/recovery_pairs.test.ts line 1 (the URL the owner's push picked the file for), reduced to its one line; the readFileSync rows are HAND-DERIVED from the shape of the repo's own docs readers, and the expected tiers are computed by hand from the rule, not read off the implementation.
  const DOCS_PUSH = ['docs/hooks.md']
  const pick = (text: string) => textReaderTiers(new Map([['tests/t.test.ts', text]]), DOCS_PUSH, false)
  const URL_ONLY = "// see https://code.claude.com/docs/en/hooks\nexpect(readFileSync(join(root, 'package.json'), 'utf8')).toBeTruthy()\n"

  it('a test whose only docs mention is a URL in a comment is not picked on a doc push', () => {
    expect(pick(URL_ONLY)).toEqual([[], [], []])
  })

  it('a test that reads docs/ as a path is picked on a doc push', () => {
    expect(pick("const x = readFileSync(join(root, 'docs', 'x.md'), 'utf8')\n")).toEqual([['tests/t.test.ts'], [], []])
  })

  it('a docs/ path named in a comment or a URL string does not count, a template path does', () => {
    expect(pick("// readFileSync(join(root, 'docs', 'x.md'))\n")).toEqual([[], [], []])
    expect(pick("const u = 'https://example.com/docs/x'\nreadFileSync(u)\n")).toEqual([[], [], []])
    expect(pick('readFileSync(`${root}/docs/x.md`)\n')).toEqual([['tests/t.test.ts'], [], []])
  })

  it('a regular expression literal holding a quote does not hide a docs read after it', () => {
    expect(pick("const re = /'/\nreadFileSync(join(root, 'docs', 'x.md'))\n")).toEqual([['tests/t.test.ts'], [], []])
  })

  it('blanks a comment and a URL string to spaces, keeping the newlines and the code around them', () => {
    // "// x" is 4 characters and the quoted URL 16, so each becomes that many spaces.
    expect(withoutCommentsOrUrls("a // x\nb 'https://h.io/p' c /* y */ d")).toBe(`a ${' '.repeat(4)}\nb ${' '.repeat(16)} c ${' '.repeat(7)} d`)
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
    // HAND-DERIVED: 45 s fixed + 1.4 x n files x 6.2 s / 4 workers = 45 + 2.17 n; the guard and the matrix are two files (49.3 s), so 52 s holds one reader (51.5 s) and not two (53.7 s)
    const r = select({ PREPUSH_BUDGET_S: '52' })
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

describe('prepush bundle spawners: every spelling, every helper, every fixture', () => {
  // Fixture provenance: HAND-DERIVED from the spellings this repo's tests take: tests/cli_epipe.test.ts builds the bundle path with join(..., 'dist', 'token-goat.mjs'), and tests import tests/helpers/bundle.ts or a helper of their own that names the bundle.
  it('a test that builds the bundle path from split segments is a bundle spawner', () => {
    const t = new Map([['tests/epipe.test.ts', "const bin = join(here, '..', 'dist', 'token-goat.mjs')\nspawnSync(process.execPath, [bin])\n"]])
    expect(textReaderTiers(t, ['src/cli.ts'], true)[2]).toEqual(['tests/epipe.test.ts'])
  })

  it('a test that imports a helper naming the bundle is a bundle spawner', () => {
    const t = new Map([['tests/imports_helper.test.ts', "import { run } from './helpers/spawn.js'\nrun()\n"]])
    const support = new Map([['tests/helpers/spawn.ts', "export const BIN = join(root, 'dist', 'token-goat.mjs')\n"]])
    expect(textReaderTiers(t, ['src/cli.ts'], true, support)[2]).toEqual(['tests/imports_helper.test.ts'])
  })

  it('a test that imports a fixture which spawns the bundle is a bundle spawner', () => {
    const t = new Map([['tests/imports_fixture.test.ts', "import './fixtures/serve.js'\n"]])
    const support = new Map([['tests/fixtures/serve.ts', "spawn(join(root, 'dist', 'token-goat.mjs'))\n"]])
    expect(textReaderTiers(t, ['src/cli.ts'], true, support)[2]).toEqual(['tests/imports_fixture.test.ts'])
  })

  it('a test that imports only a helper with no bundle reference is not a bundle spawner', () => {
    const t = new Map([['tests/plain.test.ts', "import './helpers/plain.js'\n"]])
    expect(textReaderTiers(t, ['src/cli.ts'], true, new Map([['tests/helpers/plain.ts', 'export {}\n']]))[2]).toEqual([])
  })

  it('a test that imports a helper which imports a second helper naming the bundle is a bundle spawner', () => {
    const t = new Map([['tests/two_hops.test.ts', "import { run } from './helpers/outer.js'\nrun()\n"]])
    const support = new Map([
      ['tests/helpers/outer.ts', "import { BIN } from './inner.js'\nexport const run = () => BIN\n"],
      ['tests/helpers/inner.ts', "export const BIN = join(root, 'dist', 'token-goat.mjs')\n"],
    ])
    expect(textReaderTiers(t, ['src/cli.ts'], true, support)[2]).toEqual(['tests/two_hops.test.ts'])
  })

  // Fixture provenance: FORMAT-DERIVED from scripts/build-options.mjs (the ENTRY_POINTS keys token-goat.core, token-goat-hook and token-goat-hook-client, and the CJS_CLIENT entry) and esbuild.config.mjs (the launcher token-goat.mjs, the chunks token-goat-chunk-*.mjs). The names are the emitted file names, not a list copied from the scanner.
  it.each(['token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs', 'token-goat-hook-client.cjs', 'token-goat-chunk-26PGP2OK.mjs'])('a test that spawns dist/%s is a bundle spawner', (name) => {
    const t = new Map([['tests/sibling.test.ts', `spawnSync(process.execPath, [join(here, '..', 'dist', '${name}')])\n`]])
    expect(textReaderTiers(t, ['src/cli.ts'], true)[2]).toEqual(['tests/sibling.test.ts'])
  })

  // Fixture provenance: HAND-DERIVED. These names begin like the bundle's but are not built artifacts, and a src path is not one either; each must stay out of the bundle tier.
  it.each(['token-goatish.ts', 'token-goat-util.mjs', 'src/token-goat.ts'])('a name that only starts like the bundle (%s) is not a bundle spawner', (name) => {
    const t = new Map([['tests/near.test.ts', `const p = '${name}'\nspawnSync(p)\n`]])
    expect(textReaderTiers(t, ['src/cli.ts'], true)[2]).toEqual([])
  })
})
