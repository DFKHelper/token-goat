/**
 * Guard: the anti-vacuous-pass helper works, and every guard that needs it uses it.
 *
 * `pinnedPopulation` (tests/guards/population.ts) exists because a guard shaped "enumerate every X,
 * assert each satisfies P" passes when the enumeration returns nothing. Twenty-three guards in this
 * directory have that shape. Adding the helper fixed them; nothing stops the twenty-fourth from
 * being written without it, and nothing proves the helper itself fails when it should.
 *
 * Two halves, because either alone is defeatable:
 *
 *  - The behavioural half drives the helper with populations that must be rejected. Without this,
 *    a `pinnedPopulation` that silently returned early on an empty array would satisfy every
 *    retrofitted call site and look like coverage.
 *  - The structural half scans this directory for the enumeration shape and requires the helper.
 *    Without it, the retrofit is a one-time cleanup that decays with the next guard authored.
 *
 * Why didn't a test catch the original problem: nothing ever asserted on a *population*. Every
 * assertion in every guard was about a member of one, which is precisely the assertion an empty
 * population never reaches.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const GUARD_DIR = path.dirname(fileURLToPath(import.meta.url))
const SELF = path.basename(fileURLToPath(import.meta.url))

/** The helper's own module, excluded from the structural scan: it defines the check, it is not a caller of it. */
const HELPER = 'population.ts'

/**
 * Enumeration calls that produce a population from the filesystem or the CLI registry. A guard
 * containing one of these and iterating the result is the shape that can pass vacuously.
 *
 * `allCommandNames` is deliberately absent: it pins its own population inside tests/registry.ts, so
 * a caller of it is already covered and requiring a second, redundant pin at each call site would
 * be noise. That exemption is asserted below rather than trusted.
 */
const ENUMERATION_CALLS: readonly string[] = ['readdirSync(', 'globSync(']

describe('pinnedPopulation rejects the populations it exists to catch', () => {
  it('returns the items unchanged when the population is healthy', () => {
    const items = ['src/parser.ts', 'src/cli.ts', 'src/read_commands.ts']

    expect(pinnedPopulation({ what: 'x', items, floor: 3, mustInclude: ['parser.ts'] })).toEqual(items)
  })

  it('fails on an empty population rather than passing it through', () => {
    expect(() => pinnedPopulation({ what: 'src files', items: [], floor: 1 })).toThrow(/collapsed to 0/)
  })

  it('fails when the population shrank below its floor but is not empty', () => {
    // The in-between case: a walk that still returns something looks alive in a debugger, and a
    // bare `length > 0` check would wave it through while most of the coverage was gone.
    expect(() => pinnedPopulation({ what: 'src files', items: ['a.ts'], floor: 150 })).toThrow(/collapsed to 1 .*floor 150/)
  })

  it('fails when a pinned member is gone even though the count still meets the floor', () => {
    // Substitution, not collapse. A count floor alone cannot see this, and this repo has already
    // shipped a guard whose aggregate floor hid exactly this kind of coverage loss.
    const items = ['a.ts', 'b.ts', 'c.ts', 'd.ts']

    expect(() => pinnedPopulation({ what: 'src files', items, floor: 3, mustInclude: ['parser.ts'] })).toThrow(
      /no longer contains "parser\.ts"/,
    )
  })

  it('rejects a floor of zero as a spec error, since it would authorise the empty case', () => {
    // A caller who "satisfies" the helper by pinning floor: 0 has written the vacuous pass back in.
    expect(() => pinnedPopulation({ what: 'src files', items: [], floor: 0 })).toThrow(/floor must be >= 1/)
  })
})

describe('every population-scanning guard is pinned', () => {
  const guardFiles = fs
    .readdirSync(GUARD_DIR)
    .filter((f) => f.endsWith('.test.ts') && f !== SELF && f !== HELPER)
    .sort()

  it('finds guards to scan, so an empty sweep cannot pass as a clean one', () => {
    // This guard has the very shape it polices, so it pins its own population too.
    expect(
      pinnedPopulation({
        what: 'tests/guards/*.test.ts files',
        items: guardFiles,
        floor: 60,
        mustInclude: ['no_nul_bytes.test.ts', 'third_party_content_reaches_fence.test.ts'],
      }).length,
    ).toBeGreaterThanOrEqual(60)
  })

  it('finds guards that do enumerate, so the matcher is known to match something', () => {
    const enumerating = guardFiles.filter((f) =>
      ENUMERATION_CALLS.some((c) => fs.readFileSync(path.join(GUARD_DIR, f), 'utf8').includes(c)),
    )

    // A floor here rather than a bare non-empty check: if the enumeration-call list drifts out of
    // date, this set thins out quietly and the case below starts vouching for a handful of files
    // while the rest go unchecked.
    expect(enumerating.length, 'the enumeration-call list no longer matches how guards walk the tree').toBeGreaterThanOrEqual(20)
  })

  it('requires pinnedPopulation in every guard that walks the filesystem', () => {
    const unpinned: string[] = []
    for (const file of guardFiles) {
      const text = fs.readFileSync(path.join(GUARD_DIR, file), 'utf8')
      if (!ENUMERATION_CALLS.some((c) => text.includes(c))) continue
      if (text.includes('pinnedPopulation(')) continue
      unpinned.push(file)
    }

    expect(
      unpinned,
      `these guards enumerate a population and never assert it survived, so they pass when the walk ` +
        `returns nothing: ${unpinned.join(', ')}. Wrap the enumeration in pinnedPopulation() from ` +
        `tests/guards/population.ts.`,
    ).toEqual([])
  })

  it('confirms the allCommandNames exemption is real: its population is pinned at the source', () => {
    // The exemption above is load-bearing -- two guards sweep every CLI command without calling
    // pinnedPopulation themselves. If the pin ever leaves tests/registry.ts, those two silently
    // become unpinned sweeps and nothing else in this file would notice.
    const registry = fs.readFileSync(path.join(GUARD_DIR, '..', 'registry.ts'), 'utf8')

    expect(registry, 'allCommandNames() stopped pinning its population; its callers are exempt on that basis').toContain(
      'pinnedPopulation(',
    )
  })
})
