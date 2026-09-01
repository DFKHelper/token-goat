/**
 * `token-goat affected` walks the import graph backwards from changed files to the tests that
 * reach them, so a CI run can be narrowed to the tests a diff can actually break.
 *
 * The defect this file is built around is not "returns the wrong tests" -- it is "returns fewer
 * tests than exist and looks complete". A short list and a correct list are the same shape, and
 * acting on the short one means shipping an untested change believing it was covered. So every
 * case below either measures against an independently-known answer or asserts that a truncation
 * was named: the depth cut, the untracked seed, and the invalid `--filter` each have a case.
 *
 * Provenance: CAPTURE. Every expectation is measured from a real run of the built bundle against
 * the fixture built in `beforeAll`, whose import chain is written here by hand and therefore known
 * independently of the resolver under test. No expected value is read off `affected.ts`.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[], input?: string): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function json(args: string[]): Record<string, unknown> {
  const r = run([...args, '--json'])
  try {
    return JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return expect.fail(`\`affected --json\` emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

/**
 * A deliberately layered chain, so depth is testable rather than incidental:
 *
 *   deep.test.ts -> layer2.ts -> layer1.ts -> core.ts
 *   near.test.ts -> core.ts
 *   unrelated.test.ts -> island.ts       (never reaches core.ts, at any depth)
 *
 * `deep.test.ts` sits 3 reverse hops from `core.ts` and `near.test.ts` sits 1, so a `--depth 1`
 * run must find exactly one of them -- which is what makes the depth-cut case discriminate rather
 * than merely not crash.
 */
beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-affected-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-affected-home-'))

  writeFileSync(join(projectDir, 'core.ts'), 'export function core(): number {\n  return 1\n}\n')
  writeFileSync(join(projectDir, 'layer1.ts'), "import { core } from './core.js'\nexport const l1 = core()\n")
  writeFileSync(join(projectDir, 'layer2.ts'), "import { l1 } from './layer1.js'\nexport const l2 = l1\n")
  writeFileSync(join(projectDir, 'island.ts'), 'export const island = 0\n')
  // Imported by nothing, so a walk from it resolves the seed and legitimately finds no tests --
  // the other empty answer, which must not read like the untraceable-seed one.
  writeFileSync(join(projectDir, 'orphan.ts'), 'export const orphan = 0\n')
  writeFileSync(join(projectDir, 'deep.test.ts'), "import { l2 } from './layer2.js'\nexport const d = l2\n")
  writeFileSync(join(projectDir, 'near.test.ts'), "import { core } from './core.js'\nexport const n = core()\n")
  writeFileSync(join(projectDir, 'unrelated.test.ts'), "import { island } from './island.js'\nexport const u = island\n")

  // `affected` reads the git-tracked file list, so an untracked temp directory yields an empty
  // graph and every assertion below would pass against nothing.
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')
})

describe('affected', () => {
  it('sees the fixture at all, so the cases below are not passing on an empty graph', () => {
    const r = json(['affected', 'core.ts'])
    expect(r.reachedCount, 'the walk reached nothing; the fixture is not tracked or the graph is empty').toBeGreaterThan(1)
    expect(r.unknownSeeds, 'core.ts was not recognised as a tracked file').toEqual([])
  })

  it('finds tests at every depth of the chain, not just the direct importer', () => {
    const r = json(['affected', 'core.ts'])
    // Both, and nothing else: `unrelated.test.ts` imports nothing that reaches core.ts, so a
    // walk that returned all three tests would be reporting the whole test suite as affected --
    // which is exactly as useless as returning none, and much harder to notice.
    expect(r.testFiles).toEqual(['deep.test.ts', 'near.test.ts'])
  })

  it('leaves out a test that cannot reach the changed file', () => {
    const r = json(['affected', 'island.ts'])
    expect(r.testFiles).toEqual(['unrelated.test.ts'])
  })

  it('counts a changed test file as affected by its own change', () => {
    const r = json(['affected', 'near.test.ts'])
    expect(r.testFiles).toContain('near.test.ts')
  })

  it('says so when the depth bound cut the walk short', () => {
    const shallow = json(['affected', 'core.ts', '--depth', '1'])
    // Discrimination first: the cut must actually drop a test, or "it disclosed a truncation" is
    // being asserted against a run that truncated nothing.
    expect(shallow.testFiles, 'depth 1 returned the same tests as an unbounded walk').toEqual(['near.test.ts'])
    expect(shallow.depthLimited, 'depth 1 dropped deep.test.ts without flagging the cut').toBe(true)
    expect(shallow.unexploredAtFrontier, 'the cut was flagged but the unexplored count was zero').toBeGreaterThan(0)
  })

  it('does not claim a truncation when the walk finished', () => {
    const full = json(['affected', 'core.ts', '--depth', '9'])
    expect(full.depthLimited, 'a complete walk was reported as depth-limited').toBe(false)
    expect(full.unexploredAtFrontier).toBe(0)
  })

  it('names a seed it could not trace instead of reporting it as affecting nothing', () => {
    const r = json(['affected', 'core.ts', 'not/a/real/file.ts'])
    expect(r.unknownSeeds).toEqual(['not/a/real/file.ts'])
    // The known seed still works: one bad path must not void the whole answer.
    expect(r.testFiles).toEqual(['deep.test.ts', 'near.test.ts'])
  })

  it('still prints the disclosures under --quiet, on stderr, with stdout left pipeable', () => {
    const r = run(['affected', 'core.ts', '--depth', '1', '--quiet', 'not/a/real/file.ts'])
    // stdout is what gets piped into a test runner, so it carries paths and nothing else.
    expect(r.out.trim().split('\n')).toEqual(['near.test.ts'])
    expect(r.err).toContain('not/a/real/file.ts')
    expect(r.err).toContain('--depth')
  })

  it('reads the changed-file list from stdin', () => {
    const r = run(['affected', '--stdin', '--quiet'], 'core.ts\n\n  island.ts  \n')
    expect(r.code).toBe(0)
    expect(r.out.trim().split('\n').sort()).toEqual(['deep.test.ts', 'near.test.ts', 'unrelated.test.ts'])
  })

  it('refuses an invalid --filter instead of quietly matching something else', () => {
    // `compileGrepMatcher` would degrade this to a substring search and select a different set of
    // tests without saying so. For a flag that decides which tests CI runs, a confident wrong
    // answer is worse than an error.
    const r = run(['affected', 'core.ts', '--filter', '([unclosed'])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('--filter')
  })

  it('honours a valid --filter over the built-in test heuristic', () => {
    const r = json(['affected', 'core.ts', '--filter', 'layer'])
    expect(r.testFiles).toEqual(['layer1.ts', 'layer2.ts'])
  })

  it('refuses an empty changed-file list rather than reporting nothing is affected', () => {
    const r = run(['affected'])
    expect(r.code).not.toBe(0)
    expect(r.err.toLowerCase()).toContain('no changed files')
  })
})

/**
 * The two empty answers are different answers.
 *
 * Found by running the command against this repository: `affected src/reconcile.ts` on a file git
 * did not yet track printed "No test files import 0 changed files (within 5 hops)" -- a sentence
 * that reads as a completed search returning nothing, when in fact no seed resolved and nothing
 * was searched. The stderr disclosure named the file, but the primary line contradicted it.
 *
 * Provenance: CAPTURE. Both expectations are the literal strings the built bundle prints.
 */
describe('affected distinguishes "searched and found nothing" from "nothing to search"', () => {
  it('says nothing could be traced when every seed is untracked', () => {
    const r = run(['affected', 'not-a-tracked-file.ts'])
    expect(r.code).toBe(0)
    expect(r.out, 'a zero count reads as a completed search').not.toMatch(/import 0 changed files/)
    // The whole sentence, not just its opening. Asserting only the prefix let a singular branch
    // ship reading "the file given is tracked in this project" -- the exact opposite of the fact
    // the stderr line beneath it was reporting. Caught by running the command, not by this test.
    expect(r.out).toContain('Nothing could be traced: the file given is not tracked in this project.')
  })

  it('gets the plural branch right too, since only one of the two is ever exercised at a time', () => {
    const r = run(['affected', 'nope-one.ts', 'nope-two.ts'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Nothing could be traced: none of the files given are tracked in this project.')
  })

  it('still says it searched when the seed resolved but nothing imports it', () => {
    // Calibration for the case above: without this, deleting the searched-and-found-nothing
    // branch entirely would leave the first test green.
    const r = run(['affected', 'orphan.ts'])
    expect(r.code).toBe(0)
    expect(r.out, 'a resolved seed that nothing imports is a real search with a real empty result').toMatch(/No test files import/)
  })
})
