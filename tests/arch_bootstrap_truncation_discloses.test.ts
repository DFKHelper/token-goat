/**
 * `arch` and `bootstrap-audit` are exempt from the row-truncation guard
 * (tests/guards/truncation_invariant_holds.test.ts) for a shape reason, not a behaviour one:
 * `arch` renders three independent lists under one --top and `bootstrap-audit` reads an installed
 * home rather than an indexed project, so neither fits that guard's single-row-array harness or
 * its fixture. This file is what makes those two exemptions checked rather than asserted.
 *
 * Both reasons used to be about the harness and were read as being about the commands. `arch`
 * said "there is no single row list to check" and `bootstrap-audit` said "audits an installed
 * agent configuration, not a project" -- true sentences, neither of which is a reason the command
 * may drop rows in silence, which is what both were doing: `arch --top 2` cut hubs from 270 and
 * entry points from 511, and `bootstrap-audit --top 1` showed one of 77 installed entries.
 *
 * Provenance: CAPTURE. Every expectation below is measured from a real run of the built bundle
 * against the fixture in this file -- the uncapped count is taken by running the same command
 * with the cap lifted, never read off the source that produces it.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

/** Well above the cap used below, so a cut is unambiguous rather than an off-by-one. */
const ENTRIES = 9
const CAP = 2

let projectDir: string
let homeDir: string

function run(args: string[], cwd: string): { out: string; err: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '' }
}

function json(args: string[], cwd: string): Record<string, unknown> {
  const r = run([...args, '--json'], cwd)
  try {
    return JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return expect.fail(`\`${args.join(' ')} --json\` emitted no JSON.\nstdout: ${r.out.slice(0, 300)}\nstderr: ${r.err.slice(0, 300)}`)
  }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-arch-trunc-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-arch-trunc-home-'))

  // `arch` reads the git-tracked file list, so an untracked temp directory yields zero files and
  // every assertion below would pass on an empty report. The calibration test guards that too.
  writeFileSync(join(projectDir, 'hub.ts'), 'export function hub(): number {\n  return 1\n}\n')
  for (let i = 1; i <= ENTRIES; i++) {
    // Each importer is an entry point (nobody imports it) and each import makes hub.ts a hub;
    // a second per-file module gives the hubs list more than one member to rank.
    writeFileSync(join(projectDir, `leaf${i}.ts`), `import { hub } from './hub.js'\nimport { side } from './side${i}.js'\nexport const v${i} = hub() + side()\n`)
    writeFileSync(join(projectDir, `side${i}.ts`), `export function side(): number {\n  return ${i}\n}\n`)
  }
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')

  // bootstrap-audit walks <home>/.claude/{agents,skills}; --home points it at this tree.
  const agents = join(homeDir, 'audit-home', '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  for (let i = 1; i <= ENTRIES; i++) {
    writeFileSync(join(agents, `a${i}.md`), `---\nname: a${i}\ndescription: fixture agent ${i} ${'x'.repeat(i * 20)}\n---\n\nbody\n`)
  }
})

describe('arch discloses each list it cut', () => {
  it('cuts at all, so the assertions below are not reading a complete report', () => {
    // Calibration first. A repo `arch` finds no tracked files in reports three empty lists and
    // would satisfy "did not lie about a total" trivially.
    const capped = json(['arch', '--top', String(CAP)], projectDir)
    const full = json(['arch', '--top', '999'], projectDir)

    expect((full.hubs as unknown[]).length, 'arch found no hubs in the fixture; nothing below is being tested').toBeGreaterThan(CAP)
    expect((full.entryPoints as unknown[]).length, 'arch found no entry points in the fixture').toBeGreaterThan(CAP)
    expect((capped.hubs as unknown[]).length).toBe(CAP)
    expect((capped.entryPoints as unknown[]).length).toBe(CAP)
  })

  it('reports a per-list total equal to the real one, not a restatement of what it showed', () => {
    const capped = json(['arch', '--top', String(CAP)], projectDir)
    // Measured independently: the same command with the cap lifted.
    const full = json(['arch', '--top', '999'], projectDir)
    const trueHubs = (full.hubs as unknown[]).length
    const trueEntries = (full.entryPoints as unknown[]).length

    expect(capped.hubsTruncated, `arch showed ${CAP} of ${trueHubs} hubs without flagging it`).toBe(true)
    expect(capped.entryPointsTruncated, `arch showed ${CAP} of ${trueEntries} entry points without flagging it`).toBe(true)
    // Equality, not "greater than shown" -- any wrong larger number satisfies the latter.
    expect(capped.hubsTotal, 'arch reports a hub total that is not the real pre-cap count').toBe(trueHubs)
    expect(capped.entryPointsTotal, 'arch reports an entry-point total that is not the real pre-cap count').toBe(trueEntries)
  })

  it('flags the two lists independently, so one cut list cannot vouch for the other', () => {
    // The whole reason this command needs per-list fields: one --top clips both lists, and a
    // reader of a cut hubs list beside a complete entry-point list has to be able to tell them
    // apart. Setting the cap to the smaller list's exact size cuts the larger one and leaves the
    // smaller intact, whichever way round the fixture happens to come out -- which is not a
    // detail worth hardcoding, since the first version of this test asserted the wrong direction
    // and the fixture has 10 hubs to 9 entry points.
    const full = json(['arch', '--top', '999'], projectDir)
    const hubCount = (full.hubs as unknown[]).length
    const entryCount = (full.entryPoints as unknown[]).length
    expect(hubCount, 'the two lists are the same size, so no cap can cut one and spare the other').not.toBe(entryCount)
    const cap = Math.min(hubCount, entryCount)

    const between = json(['arch', '--top', String(cap)], projectDir)

    expect(between.hubsTruncated, `hubs (${hubCount}) at --top ${cap} was flagged wrongly`).toBe(hubCount > cap)
    expect(between.entryPointsTruncated, `entry points (${entryCount}) at --top ${cap} was flagged wrongly`).toBe(entryCount > cap)
    // Exactly one of them, or the case proves nothing about independence.
    expect([between.hubsTruncated, between.entryPointsTruncated].filter(Boolean), 'the cap cut both lists or neither, so this case cannot show they are flagged independently').toHaveLength(1)
  })

  it('says nothing about a cut when every list fits', () => {
    const full = json(['arch', '--top', '999'], projectDir)

    expect(full.hubsTruncated, 'arch flags a complete hub list as truncated').toBe(false)
    expect(full.entryPointsTruncated, 'arch flags a complete entry-point list as truncated').toBe(false)
  })
})

describe('bootstrap-audit discloses the entries it cut', () => {
  const auditHome = (): string => join(homeDir, 'audit-home')

  it('cuts at all', () => {
    const capped = json(['bootstrap-audit', '--home', auditHome(), '--top', String(CAP)], projectDir)
    const full = json(['bootstrap-audit', '--home', auditHome(), '--top', '999'], projectDir)

    expect((full.largest as unknown[]).length, 'the fixture home holds no scannable entries; every assertion here would be vacuous').toBeGreaterThan(CAP)
    expect((capped.largest as unknown[]).length).toBe(CAP)
  })

  it('reports the real pre-cap count', () => {
    const capped = json(['bootstrap-audit', '--home', auditHome(), '--top', String(CAP)], projectDir)
    const truth = (json(['bootstrap-audit', '--home', auditHome(), '--top', '999'], projectDir).largest as unknown[]).length

    expect(capped.largestTruncated, `bootstrap-audit showed ${CAP} of ${truth} entries without flagging it`).toBe(true)
    expect(capped.largestTotal, 'bootstrap-audit reports a total that is not the real pre-cap count').toBe(truth)
  })

  it('says so in table mode too, where most readers see it', () => {
    const r = run(['bootstrap-audit', '--home', auditHome(), '--top', String(CAP)], projectDir)
    const truth = (json(['bootstrap-audit', '--home', auditHome(), '--top', '999'], projectDir).largest as unknown[]).length

    // CAPTURE: the literal footer a real run emits, read from that run's stdout.
    expect(r.out, 'the table rendered a clipped list with no closing count').toContain(`...and ${truth - CAP} more`)
  })

  it('says nothing when every entry fits', () => {
    const full = json(['bootstrap-audit', '--home', auditHome(), '--top', '999'], projectDir)
    const r = run(['bootstrap-audit', '--home', auditHome(), '--top', '999'], projectDir)

    expect(full.largestTruncated, 'a complete entry list was reported as cut').toBe(false)
    expect(r.out, 'the table claimed a remainder on a complete list').not.toMatch(/\.\.\.and \d+ more/)
  })
})
