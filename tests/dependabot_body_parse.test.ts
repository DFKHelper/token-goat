import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- a maintainer script in plain JavaScript, deliberately outside the typed source tree.
import { isDependabotPullRequest, isValidPackageName, npmCommand, packageNamesFromBody, summarizeGuardFailure } from '../scripts/dependabot-body.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// CAPTURE: the body of DFKHelper/token-goat#31, taken with `gh pr view 31 --json body --jq .body` on 2026-09-10. Real output from the producer, not a table written to match the regex below it, which is the only kind of fixture that can catch Dependabot restyling its own body.
const body = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'dependabot', 'grouped-npm-pr-body.md'), 'utf8')

describe('dependabot pull request body', () => {
  it('reads every package in a grouped batch, and nothing else', () => {
    // The batch #31 actually proposed, in the order the table lists it. An exact match rather than a containment check: a parse that also swept up release-note or commit rows would still satisfy `arrayContaining`, and over-collecting is the failure that would send `npm update` at packages this repository does not depend on.
    expect(packageNamesFromBody(body)).toEqual([
      '@types/jpeg-js',
      '@types/node',
      'lefthook',
      'tsx',
      'typescript-eslint',
      'zod',
      'pdfjs-dist',
    ])
  })

  it('returns nothing for a body with no table, rather than a name-shaped fragment of prose', () => {
    expect(packageNamesFromBody('Bumps zod from 4.5.4 to 4.6.1.\n\nSome prose | with a pipe in it.')).toEqual([])
    expect(packageNamesFromBody('')).toEqual([])
    expect(packageNamesFromBody(undefined)).toEqual([])
  })

  it('takes only rows carrying two backticked versions, which is what separates a package row from the header and the rule beneath it', () => {
    // HAND-DERIVED: the minimal three-line table, written from the markdown spec rather than from the parser. The header and separator are excluded because neither has backticked version cells, not because the name `Package` is filtered by name -- an explicit check for that was in the parser and survived deletion, so it was removed rather than left looking load-bearing.
    expect(packageNamesFromBody('| Package | From | To |\n| --- | --- | --- |\n| zod | `1.0.0` | `1.0.1` |')).toEqual(['zod'])
    // A package genuinely named `Package` is still collected, which is the behaviour the deleted check would have got wrong.
    expect(packageNamesFromBody('| Package | `1.0.0` | `1.0.1` |')).toEqual(['Package'])
  })
})

// CAPTURE: the body of DFKHelper/token-goat#40, taken with `gh pr view 40 --json body --jq .body` on 2026-09-29. A grouped batch of two, which Dependabot writes with no summary table: `npm run deps:refresh` stopped on it with `#40 lists no package rows; pass --packages`.
const tablelessBody = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'dependabot', 'grouped-npm-pr-body-no-table.md'), 'utf8')

describe('a grouped batch too small for a summary table', () => {
  it('reads the packages from the top-level Updates lines', () => {
    expect(packageNamesFromBody(tablelessBody)).toEqual(['smol-toml', 'typescript-eslint'])
  })

  it('confirms the real body has no table, so the case above is the fallback and not the table parse', () => {
    expect(tablelessBody.split('\n').filter((line) => line.trim().startsWith('|'))).toEqual([])
  })

  // HAND-DERIVED: the captured body's own shape, with an Updates line smuggled into a release note's code block. Dependabot keeps `<pre><code>` lines verbatim (see the table case below), so upstream text can carry this line.
  const smuggledUpdate = [
    'Bumps the npm-dependencies group with 1 update in the / directory: [zod](https://github.com/colinhacks/zod).',
    '',
    'Updates `zod` from 1.0.0 to 1.0.1',
    '<details>',
    '<summary>Release notes</summary>',
    '<pre><code>How to upgrade:',
    'Updates `evil-package` from 1.0.0 to 9.9.9',
    '</code></pre>',
    '</details>',
  ].join('\n')

  it('ignores an Updates line inside a details block', () => {
    expect(packageNamesFromBody(smuggledUpdate)).toEqual(['zod'])
  })

  it('refuses a body whose Updates lines do not match the count it declares', () => {
    expect(packageNamesFromBody(smuggledUpdate.replace('with 1 update', 'with 2 updates'))).toEqual([])
    expect(packageNamesFromBody(smuggledUpdate.replace('Bumps the npm-dependencies group with 1 update', 'Bumps zod'))).toEqual([])
  })
})

describe('rows the body carries but Dependabot did not propose', () => {
  // HAND-DERIVED: a summary table naming one package, then a release note carrying a fenced code block whose lines are table-shaped. Written from Dependabot's rendering behaviour, which is CAPTURE-confirmed by the real body: `grep -c '|' ` over everything below the summary table of tests/fixtures/dependabot/grouped-npm-pr-body.md returns 0, because Dependabot converts embedded upstream markdown to HTML -- an upstream table becomes <table>. A <pre><code> block is the exception: its lines survive verbatim, pipes and all.
  const smuggled = [
    '| Package | From | To |',
    '| --- | --- | --- |',
    '| [zod](https://github.com/colinhacks/zod) | `1.0.0` | `1.0.1` |',
    '',
    'Updates `zod` from 1.0.0 to 1.0.1',
    '<details>',
    '<summary>Release notes</summary>',
    '<blockquote>',
    '<pre><code>Example table from our changelog:',
    '| evil-package | `9.9.9` | `9.9.9` |',
    '| another-one | `1` | `2` |',
    '</code></pre>',
    '</blockquote>',
    '</details>',
  ].join('\n')

  it('takes only the summary table, not a table-shaped code block in an upstream release note', () => {
    // Before the contiguity bound this returned ['zod', 'evil-package', 'another-one'], which would have put two packages on the `npm update` command line on the authority of a dependency's own release notes -- packages no maintainer reviewed and Dependabot never proposed.
    expect(packageNamesFromBody(smuggled)).toEqual(['zod'])
  })

  it('still reads the whole of a real grouped batch, so the bound is not just refusing everything', () => {
    expect(packageNamesFromBody(body)).toHaveLength(7)
  })

  it('confirms the real body puts nothing pipe-shaped below its summary table', () => {
    // The positive control for the claim above: if Dependabot ever stops rendering embedded markdown to HTML, this fails and the reasoning behind the bound needs revisiting.
    const belowTable = body.split('\n').slice(12)
    expect(belowTable.filter((line) => line.includes('|'))).toEqual([])
  })
})

describe('package names reaching the command line', () => {
  // HAND-DERIVED from npm's package-name grammar: these are the shapes npm itself publishes under, written independently of the regex so the test is not the implementation restated.
  it('accepts the names npm actually allows', () => {
    for (const name of ['zod', 'pdfjs-dist', '@types/node', 'typescript-eslint', 'lodash.merge', 'a', '@a/b-c_d.e']) {
      expect(isValidPackageName(name), name).toBe(true)
    }
  })

  it('rejects every shape that would reach a shell as more than one word', () => {
    // These names reached npm through `shell: true` on Windows until npmCommand, where an argument is concatenated rather than escaped, and this check is what held then. Each of these was chosen as a separator or substitution cmd.exe or sh would act on.
    for (const name of [
      'lodash & echo pwned',
      'lodash&&whoami',
      'lodash | tee out',
      'lodash; rm -rf .',
      'lodash > file',
      'lodash $(id)',
      'lodash `id`',
      'lodash %CD%',
      'two words',
      '../escape',
      'UPPERCASE',
      '',
    ]) {
      expect(isValidPackageName(name), name).toBe(false)
    }
    expect(isValidPackageName(undefined)).toBe(false)
    expect(isValidPackageName('a'.repeat(215))).toBe(false)
  })

  it('refuses to run at all when a name is not a package name, before it reaches npm', () => {
    // The regression test for the real defect: a name carrying a shell separator used to be printed and then handed to `npm update`. Driving the script itself rather than the predicate, because the predicate being correct is worth nothing if the resolve path does not consult it.
    const script = path.join(repoRoot, 'scripts', 'refresh-dependabot-lock.mjs')
    const hostile = spawnSync(process.execPath, [script, '--check', '--packages', 'lodash & echo pwned'], { encoding: 'utf8' })
    expect(hostile.status, hostile.stdout + hostile.stderr).toBe(1)
    expect(hostile.stderr).toContain('refusing to put them on a command line')
    // The honest case still works, so the check is not passing by rejecting everything.
    const clean = spawnSync(process.execPath, [script, '--check', '--packages', 'zod'], { encoding: 'utf8' })
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
    expect(clean.stdout).toContain('zod')
  })
})

describe('deciding the disclosure guard failed', () => {
  // HAND-DERIVED: each error object is assembled here from what execFileSync documents it attaches on a nonzero exit (status, stdout, stderr), not copied out of the function being tested.
  it('reports the assertion lines when vitest ran and rejected the lock file', () => {
    const error = { status: 1, stdout: '', stderr: 'AssertionError: expected 3 to be 2\n  at foo\nFAIL tests/guards/x.test.ts\n' }
    const summary = summarizeGuardFailure(error)
    expect(summary).toContain('AssertionError: expected 3 to be 2')
    expect(summary).not.toContain('at foo')
  })

  it('still says something when the run failed without producing a line the filter matches', () => {
    // The real defect: the summary was the filtered lines and nothing else, so a run that died before reporting returned '', and the caller reads a falsy return as the guard having accepted the lock file. Asserting non-empty rather than on exact wording, since the wording is not the contract.
    for (const error of [
      { status: 7, stdout: '', stderr: 'Error: cannot find module vitest.config.ts\n' },
      { status: 137, stdout: '', stderr: '' },
      { status: undefined, stdout: undefined, stderr: undefined },
      {},
    ]) {
      expect(summarizeGuardFailure(error), JSON.stringify(error)).toBeTruthy()
    }
  })

  it('carries the tail of the output so the reason is visible, not just the exit code', () => {
    const summary = summarizeGuardFailure({ status: 7, stderr: 'Error: cannot find module vitest.config.ts\n' })
    expect(summary).toContain('cannot find module vitest.config.ts')
    expect(summary).toContain('7')
  })
})

describe('names that are not shell metacharacters but are still not operands', () => {
  // The second channel through the same argument vector. The shell is one consumer of these strings and npm's own option parser is another, and the first version of the check only closed the shell. CAPTURE: `npm config get before --before=2026-09-03 --before 2099-12-31 zod` on npm 11 reports 2099, so the later flag wins and the cooldown is gone. Run on 2026-09-10 against the real npm.
  it('rejects every leading-dash string npm would read as a flag', () => {
    for (const name of ['--before', '--force', '--package-lock-only', '--omit', '-g', '-f', '--']) {
      expect(isValidPackageName(name), name).toBe(false)
    }
  })

  it('rejects a leading tilde, which npm allows and a POSIX shell would expand', () => {
    expect(isValidPackageName('~root')).toBe(false)
    expect(isValidPackageName('~')).toBe(false)
  })

  it('still accepts the dashes and tildes that appear inside a real name', () => {
    for (const name of ['typescript-eslint', 'pdfjs-dist', '@types/node', 'a-b~c', 'x~']) {
      expect(isValidPackageName(name), name).toBe(true)
    }
  })

  it('refuses to run when a flag arrives dressed as a package name', () => {
    const script = path.join(repoRoot, 'scripts', 'refresh-dependabot-lock.mjs')
    const hostile = spawnSync(process.execPath, [script, '--check', '--packages', '--before,2099-12-31,zod'], { encoding: 'utf8' })
    expect(hostile.status, hostile.stdout + hostile.stderr).toBe(1)
    expect(hostile.stderr).toContain('refusing to put them on a command line')
    expect(hostile.stderr).toContain('--before')
  })

  it('puts -- before the operands, so a widened check cannot become a cooldown bypass again', () => {
    // Reading the source rather than running `npm update`, which would rewrite this repository's own lock file. FORMAT-DERIVED from the script itself, and deliberately paired with the behavioural test above: this one alone would only prove the file contains a string.
    const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'refresh-dependabot-lock.mjs'), 'utf8')
    expect(source).toContain("'update', `--before=${cutoff}`, '--', ...names]")
  })
})

describe("choosing which open pull request is Dependabot's", () => {
  // CAPTURE: `gh pr view 31 --json author,isCrossRepository` on 2026-09-10 returned {"author":{"is_bot":true,"login":"app/dependabot"},"isCrossRepository":false}. The login string is gh's own rendering for an app, not a guess, and a branch-name prefix is not an identity: this repository is public, so a fork can open a pull request on any branch name it likes.
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'refresh-dependabot-lock.mjs'), 'utf8')

  it('asks gh for the fields the decision needs', () => {
    expect(source).toContain('number,title,headRefName,author,isCrossRepository')
  })

  it('accepts every real Dependabot pull request this repository has had', () => {
    // CAPTURE: `gh pr list --state all --limit 6 --json number,title,headRefName,author,isCrossRepository` on 2026-09-10. Running the predicate against real gh output, because the source-grep tests around it would pass just as happily if the field name were wrong.
    const listing = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'dependabot', 'gh-pr-list.json'), 'utf8'))
    // That every entry is Dependabot's is a property of this capture, not of `gh pr list`, so it is asserted on `is_bot` -- a field the predicate never reads -- rather than assumed. Regenerating the fixture over a range containing a human pull request fails here, which is the honest place to fail rather than inside the predicate's own test.
    expect(listing.length).toBeGreaterThan(0)
    expect(listing.every((pr: { author?: { is_bot?: boolean } }) => pr.author?.is_bot === true)).toBe(true)
    for (const pr of listing) {
      expect(isDependabotPullRequest(pr), `#${pr.number} ${pr.headRefName}`).toBe(true)
    }
  })

  it('rejects a fork wearing the branch name, which is the shape a public repository invites', () => {
    const real = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'dependabot', 'gh-pr-list.json'), 'utf8'))[0]
    // HAND-DERIVED: each variant flips exactly one field of a genuine entry, so a passing case cannot be explained by the other two fields carrying the decision.
    expect(isDependabotPullRequest({ ...real, author: { login: 'someone-else' } })).toBe(false)
    expect(isDependabotPullRequest({ ...real, isCrossRepository: true })).toBe(false)
    expect(isDependabotPullRequest({ ...real, headRefName: 'feature/looks-innocent' })).toBe(false)
    expect(isDependabotPullRequest({ ...real, author: undefined })).toBe(false)
    expect(isDependabotPullRequest(null)).toBe(false)
    expect(isDependabotPullRequest({})).toBe(false)
  })

  it('names a limit, because gh pr list stops at thirty and page two would read as no batch at all', () => {
    expect(source).toContain("'--limit', '200'")
  })
})

// HAND-DERIVED: each expected invocation follows from the platform, the environment and which files exist, independently of the implementation; the last case runs the answer for real on whatever platform the suite is on.
describe('npmCommand', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const bundled = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const only = (...paths: string[]) => (p: string) => paths.includes(p)

  it('runs the npm that `npm run` names, through this Node', () => {
    const named = 'D:\\tools\\npm\\bin\\npm-cli.js'
    expect(npmCommand({ platform: 'win32', env: { npm_execpath: named }, execPath, exists: only(named, bundled) })).toEqual({ file: execPath, prefix: [named] })
  })

  it('ignores another package manager in npm_execpath and takes the npm beside Node on Windows', () => {
    const pnpm = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs'
    expect(npmCommand({ platform: 'win32', env: { npm_execpath: pnpm }, execPath, exists: only(pnpm, bundled) })).toEqual({ file: execPath, prefix: [bundled] })
  })

  it('answers null on Windows when there is no npm-cli.js to run, rather than a shell', () => {
    expect(npmCommand({ platform: 'win32', env: {}, execPath, exists: only() })).toBeNull()
  })

  it('spawns npm directly where the platform can', () => {
    expect(npmCommand({ platform: 'linux', env: {}, execPath: '/usr/bin/node', exists: only() })).toEqual({ file: 'npm', prefix: [] })
  })

  it('resolves an npm that runs with no shell on this machine', () => {
    const npm = npmCommand({ platform: process.platform, env: process.env, execPath: process.execPath, exists: fs.existsSync })
    expect(npm).not.toBeNull()
    const res = spawnSync(npm.file, [...npm.prefix, '--version'], { encoding: 'utf8' })
    expect(res.error, String(res.error)).toBeUndefined()
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
