/**
 * `arch --modules` groups the import graph into the clusters of files that mostly import each
 * other, and reports how strong that grouping is.
 *
 * The defect this file is built around is not "puts a file in the wrong group" -- it is that
 * greedy modularity optimisation *always* returns a partition. Run it on a random graph and it
 * hands back groups that look exactly like real ones, so an output that looks like an
 * architectural finding is the default rather than the exception. Every case below therefore pins
 * something that a made-up partition would fail: the exact membership of a graph whose clusters
 * are known by construction, the modularity value computed by hand from that graph, the
 * distinction between a weak grouping and a strong one, and byte-identical output across runs.
 *
 * Provenance:
 *   - Membership and cross-import expectations: HAND-DERIVED. The fixture's edges are written out
 *     below by hand and the two triangles are visible in the source; no expected value is read off
 *     `modules.ts`.
 *   - The modularity value 0.357142857...: HAND-DERIVED, computed from the Newman-Girvan
 *     definition against the fixture's own edge list, worked through in the comment on that test.
 *     It is not a captured output, so it fails if the implementation's arithmetic is wrong rather
 *     than agreeing with it by construction.
 *   - Output wording: CAPTURE from the built bundle.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let twoCliques: string
let reverseBridge: string
let singleGroup: string
let noImports: string
let homeDir: string

function run(dir: string, args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function json(dir: string, args: string[]): Record<string, unknown> {
  const r = run(dir, [...args, '--json'])
  try {
    return JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return expect.fail(`\`arch --modules --json\` emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

function track(dir: string): void {
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')
}

/**
 * The main fixture is two triangles joined by a single edge -- the textbook shape for community
 * detection, chosen because its correct partition is obvious to a reader and its modularity is
 * computable by hand:
 *
 *   a -> b, a -> c, b -> c        (triangle 1)
 *   d -> e, d -> f, e -> f        (triangle 2)
 *   c -> d                        (the one bridge between them)
 *   orphan.ts                     (imports nothing, imported by nothing)
 *
 * Undirected, that is 7 edges of weight 1 over 6 nodes, with degrees a=2 b=2 c=3 d=3 e=2 f=2.
 */
beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-mod-home-'))

  twoCliques = mkdtempSync(join(tmpdir(), 'tg-mod-cliques-'))
  writeFileSync(join(twoCliques, 'a.ts'), "import './b.js'\nimport './c.js'\nexport const a = 1\n")
  writeFileSync(join(twoCliques, 'b.ts'), "import './c.js'\nexport const b = 1\n")
  writeFileSync(join(twoCliques, 'c.ts'), "import './d.js'\nexport const c = 1\n")
  writeFileSync(join(twoCliques, 'd.ts'), "import './e.js'\nimport './f.js'\nexport const d = 1\n")
  writeFileSync(join(twoCliques, 'e.ts'), "import './f.js'\nexport const e = 1\n")
  writeFileSync(join(twoCliques, 'f.ts'), 'export const f = 1\n')
  writeFileSync(join(twoCliques, 'orphan.ts'), 'export const orphan = 1\n')
  track(twoCliques)

  // The same two triangles with the bridge running the other way: f.ts -> a.ts, so the edge goes
  // from the second-ranked module into the first. Without this the direction assertion below does
  // not discriminate -- in the fixture above the bridge already runs from the lower-ranked module
  // to the higher one, so normalising the pair to (min, max) produces the identical key and a
  // direction-losing implementation passes. Confirmed by mutation: making the cross-import key
  // undirected left every case in this file green until this fixture existed.
  reverseBridge = mkdtempSync(join(tmpdir(), 'tg-mod-reverse-'))
  writeFileSync(join(reverseBridge, 'a.ts'), "import './b.js'\nimport './c.js'\nexport const a = 1\n")
  writeFileSync(join(reverseBridge, 'b.ts'), "import './c.js'\nexport const b = 1\n")
  writeFileSync(join(reverseBridge, 'c.ts'), 'export const c = 1\n')
  writeFileSync(join(reverseBridge, 'd.ts'), "import './e.js'\nimport './f.js'\nexport const d = 1\n")
  writeFileSync(join(reverseBridge, 'e.ts'), "import './f.js'\nexport const e = 1\n")
  writeFileSync(join(reverseBridge, 'f.ts'), "import './a.js'\nexport const f = 1\n")
  track(reverseBridge)

  // One group and nothing else: modularity of a single-community partition is exactly 0, which is
  // the calibration for the weak-grouping wording. Without it, deleting the weak branch entirely
  // would leave the "does not call a strong grouping weak" case green.
  singleGroup = mkdtempSync(join(tmpdir(), 'tg-mod-single-'))
  writeFileSync(join(singleGroup, 'x.ts'), "import './y.js'\nexport const x = 1\n")
  writeFileSync(join(singleGroup, 'y.ts'), 'export const y = 1\n')
  track(singleGroup)

  // Real tracked files, zero internal imports: the graph is not empty, but there is nothing to
  // group, and those are different sentences.
  noImports = mkdtempSync(join(tmpdir(), 'tg-mod-noimports-'))
  writeFileSync(join(noImports, 'p.ts'), 'export const p = 1\n')
  writeFileSync(join(noImports, 'q.ts'), 'export const q = 1\n')
  track(noImports)
})

describe('arch --modules', () => {
  it('sees the fixture at all, so the cases below are not passing on an empty graph', () => {
    const r = json(twoCliques, ['arch', '--modules'])
    expect(r.modulesTotal, 'no modules at all: the fixture is untracked or the graph is empty').toBeGreaterThan(0)
    expect(r.noImportEdges, 'the fixture has seven import edges but was reported as having none').toBe(false)
  })

  it('recovers the two triangles exactly, and puts nothing else in them', () => {
    const r = json(twoCliques, ['arch', '--modules'])
    const modules = r.modules as { size: number; files: string[] }[]
    expect(r.modulesTotal, 'the two triangles must come back as exactly two groups').toBe(2)
    // Sorted so the assertion does not depend on which triangle ranks first; the rank ordering is
    // pinned separately by the determinism case below.
    const groups = modules.map((m) => [...m.files].sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : 1))
    expect(groups).toEqual([
      ['a.ts', 'b.ts', 'c.ts'],
      ['d.ts', 'e.ts', 'f.ts'],
    ])
  })

  it('matches modularity computed by hand from the fixture edge list', () => {
    // Newman-Girvan Q = sum over groups of [ Sigma_in / 2m - (Sigma_tot / 2m)^2 ], where Sigma_in
    // is twice the weight inside a group and Sigma_tot is the summed degree of its members.
    //
    // 7 edges, so 2m = 14. Each triangle holds 3 internal edges (Sigma_in = 6) and its members'
    // degrees sum to 7 (2+2+3). Each group contributes 6/14 - (7/14)^2 = 0.428571... - 0.25.
    // Two identical groups: Q = 2 * 0.178571... = 0.3571428571...
    expect(json(twoCliques, ['arch', '--modules']).modularity as number).toBeCloseTo(0.35714285714, 8)
  })

  it('does not call a grouping weak when the modularity says otherwise', () => {
    const r = run(twoCliques, ['arch', '--modules'])
    expect(r.out).toContain('modularity 0.36')
    expect(r.out, 'a grouping above the weak threshold was hedged as weak').not.toContain('weak')
  })

  it('names a weak grouping as weak instead of presenting it as structure', () => {
    const r = json(singleGroup, ['arch', '--modules'])
    // Discrimination first: this fixture must actually be below the threshold, or the wording
    // assertion below is being made against a run that was never weak.
    expect(r.modularity, 'a single-community partition has modularity exactly 0').toBeCloseTo(0, 10)
    const text = run(singleGroup, ['arch', '--modules'])
    expect(text.out).toContain('weak')
  })

  it('reports a file that imports nothing as outside every module, not as a module of one', () => {
    const r = json(twoCliques, ['arch', '--modules'])
    expect(r.isolatedCount, 'orphan.ts is the one unconnected file in the fixture').toBe(1)
    const allMembers = (r.modules as { files: string[] }[]).flatMap((m) => m.files)
    expect(allMembers, 'an unconnected file was given its own module').not.toContain('orphan.ts')
  })

  it('reports the one bridge edge, with its direction', () => {
    const r = json(twoCliques, ['arch', '--modules'])
    const cross = r.crossImports as { fromCore: string; toCore: string; imports: number }[]
    expect(r.crossImportsTotal, 'c.ts -> d.ts is the only edge crossing between the triangles').toBe(1)
    expect(cross[0]!.imports).toBe(1)
    // Direction, not just presence: the bridge runs from the a/b/c triangle into the d/e/f one, and
    // an undirected read of it would report the pair with the endpoints swapped half the time.
    expect(cross[0]!.fromCore).toBe('a.ts')
    expect(cross[0]!.toCore).toBe('d.ts')
  })

  it('keeps the direction when the bridge runs from the second module into the first', () => {
    // The discriminating half of the case above: here the only crossing edge is f.ts -> a.ts, so a
    // reader that lost direction and normalised the pair would report #1 -> #2 and be exactly
    // backwards about which module depends on which.
    const r = json(reverseBridge, ['arch', '--modules'])
    const cross = r.crossImports as { fromCore: string; toCore: string; imports: number }[]
    expect(r.crossImportsTotal, 'f.ts -> a.ts is the only edge crossing between the triangles').toBe(1)
    expect(cross[0]!.fromCore, 'the bridge runs out of the d/e/f triangle, not into it').toBe('d.ts')
    expect(cross[0]!.toCore).toBe('a.ts')
  })

  it('produces byte-identical output on repeated runs of an unchanged project', () => {
    // The grouping depends on node visit order and tie-breaking, both of which come from hash-map
    // iteration order in the naive implementation. A result that changes between runs is not a
    // finding anyone can act on, and nothing else in this file would catch it.
    const first = run(twoCliques, ['arch', '--modules']).out
    const second = run(twoCliques, ['arch', '--modules']).out
    const third = run(twoCliques, ['arch', '--modules']).out
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('says there was nothing to group rather than reporting zero modules', () => {
    const r = run(noImports, ['arch', '--modules'])
    expect(r.code).toBe(0)
    // "modules (0 found)" over a project with no import edges reads as a statement about the
    // architecture when it is a statement about the input.
    expect(r.out, 'an edgeless graph was rendered as a real zero').not.toMatch(/modules \(0 found/)
    expect(r.out).toContain('nothing to group')
    expect(json(noImports, ['arch', '--modules']).noImportEdges).toBe(true)
  })

  it('says so when --top cut the module list short', () => {
    const r = json(twoCliques, ['arch', '--modules', '--top', '1'])
    expect((r.modules as unknown[]).length, 'the cap must actually bite for this case to test anything').toBe(1)
    expect(r.modulesTotal).toBe(2)
    expect(r.modulesTruncated).toBe(true)
    expect(run(twoCliques, ['arch', '--modules', '--top', '1']).out).toContain('top 1 of 2')
  })

  it('leaves arch untouched when --modules is not passed', () => {
    // An opt-in that emits anyway is not an opt-in. Both surfaces are checked: the text output must
    // gain no lines, and the JSON payload no keys, for every existing caller.
    const text = run(twoCliques, ['arch'])
    expect(text.out).not.toContain('modules')
    expect(text.out).not.toContain('cross-module')
    const plain = json(twoCliques, ['arch'])
    expect(Object.keys(plain).sort()).toEqual(['cycles', 'entryPoints', 'entryPointsTotal', 'entryPointsTruncated', 'hubs', 'hubsTotal', 'hubsTruncated'])
  })
})
