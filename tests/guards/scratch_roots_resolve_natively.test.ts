/**
 * A freshly created scratch directory must be resolved with the `.native` realpath, never the
 * plain one.
 *
 * The plain form is a JS walker: it follows symlinks and otherwise echoes back the spelling it was
 * handed. `.native` asks the OS. The two differ exactly where a machine spells a path one way and
 * the filesystem another, which is the case on every CI runner this suite runs on and on none of
 * the machines it is written on:
 *
 *   - `windows-latest` roots its temp directory at the 8.3 alias `C:\Users\RUNNER~1\...`, which
 *     canonicalizes to `C:\Users\runneradmin\...`. The plain walker keeps the alias.
 *   - `macos-latest` roots it at `/var/folders/...`, a symlink to `/private/var/folders/...`.
 *
 * Both rewrites change the path's LENGTH as well as its spelling, so a fixture that measures bytes
 * against the unresolved form is measuring a path the implementation never sees. That is how
 * `path_containment_walk_cap` failed on one Windows shard and nowhere else: it sized a path to sit
 * one byte under a 4096-byte cap, the runner's alias expanded by three bytes on canonicalization,
 * and the assertion that fired said only `expected false to be true`.
 *
 * `.native` is never worse here. The directory was created by this process microseconds earlier, so
 * its on-disk casing is the casing that was asked for, and the case-folding concern that keeps
 * `expandShortPath` from running `.native` over a whole caller-supplied path does not arise.
 *
 * KNOWN LIMITS, stated rather than implied. The scan is line-local, so it cannot see the two-
 * statement form (`const d = mkdtempSync(...)` on one line, then a resolve of `d` on the next), and
 * it is textual, so it cannot see a wrapper function or a destructured-and-renamed import. A regex
 * is the wrong tool for either, and pretending otherwise would make this header read as exhaustive
 * when it is not. What it does cover is the single-expression form: both calls on one line, either
 * API chosen independently on each side (so the mixed sync/async pairs too), under a receiver of
 * any depth including none.
 *
 * The first version of this guard was green while three tracked files broke its rule. It matched
 * only the `fs.`-prefixed spelling of the INNER call, which happened to be the only spelling the
 * sweep that preceded it had produced; the plain sync realpath wrapping a mkdtemp call under an `fsReal` alias, in two
 * VS Code path-confinement tests, and the awaited promises-API pair in the extension's
 * own suite were all invisible. Hence: no hardcoded receiver anywhere below, and a population
 * taken from the whole repository rather than from two directories.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The forbidden shapes, assembled rather than written out.
 *
 * A guard that scans the repo for a literal it also contains reports itself, and the usual repair
 * is to exempt its own path -- which then blinds it to a real occurrence added to it later. There
 * is deliberately no self-exemption here: the needles are built at run time, so the literal never
 * appears in this file and the guard is inside its own population like every other file.
 *
 * `.native` is excluded for free. The call text is `realpathSync.native(`, so a pattern that
 * requires `realpathSync` to be followed immediately by `(` cannot match it, and no lookbehind or
 * negative assertion is needed. An earlier `[^.\w]` lookbehind on the OUTER call bought nothing
 * and excluded the mixed form -- namespaced outer call, bare inner call -- by construction.
 */
// `*`, not `?`. A single optional receiver covers `fs.mkdtemp(` and the bare `mkdtemp(` and stops
// dead at `fs.promises.mkdtemp(` -- a two-segment shape this repo already writes elsewhere, so the
// depth limit was not hypothetical. Nesting is unbounded because there is no depth at which a
// deeper receiver stops being the same call.
const RECEIVER = String.raw`(?:[A-Za-z_$][\w$]*\s*\.\s*)*`

// ONE needle, not one per API. Two needles -- a sync one and an async one -- are each internally
// consistent and therefore blind to the MIXED pairs, where the outer call is taken from one API and
// the inner from the other. Both mixes are legal JavaScript, both are wrong, and a pair of same-API
// patterns cannot see either. Making the `Sync` suffix optional independently on each side is what
// reaches them. (The mixes are written out as calibration cases below, where they belong: spelled
// here they would be genuine offenders in a tracked file, and the scan would rightly report them.)
//
// `.native` is still excluded for free: the call text is `realpathSync.native(`, and requiring the
// name to be followed immediately by `(` cannot match it. There is no `realpath.native`.
const NEEDLES: readonly RegExp[] = [
  new RegExp(String.raw`\brealpath` + String.raw`(?:Sync)?\(\s*(?:await\s+)?` + RECEIVER + String.raw`mkdtemp` + String.raw`(?:Sync)?\(`),
]

/** Every tracked source file in the repository, whatever directory or extension it lives under. */
function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter((p) => /\.[cm]?[jt]sx?$/.test(p))
}

describe('a scratch root is resolved the way the OS spells it', () => {
  it('never resolves a mkdtemp result with the non-native realpath, in any spelling', () => {
    const offenders: string[] = []
    let scanned = 0
    let withMkdtemp = 0
    for (const rel of trackedSources()) {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
      scanned += 1
      if (!text.includes('mkdtemp')) continue
      withMkdtemp += 1
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        if (NEEDLES.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}`)
      }
    }
    // Non-vacuity, both halves. A `git ls-files` that returns nothing, an extension filter that
    // stops matching, or a repo that stopped using mkdtemp would each make the assertion below
    // pass while checking nothing. The floors are set well under the current counts so ordinary
    // growth does not trip them, and well over zero so a collapsed population does.
    // The two floors do not matter equally. `scanned` counts every JS/TS file whether or not the
    // rule can apply to it; the population the rule is actually checked against is `withMkdtemp`,
    // and a floor near zero there does not notice a collapse. Measured 2026-09-13: scanned 1115,
    // withMkdtemp 404. Folding scratch-dir creation into one shared helper is an ordinary refactor
    // that would take withMkdtemp to a handful of files while leaving `scanned` untouched, and the
    // guard would then inspect ten files, certify the repo, and stay green. So withMkdtemp is
    // floored just under its measured count: close enough to trip on a structural collapse, far
    // enough below to survive ordinary churn.
    expect(scanned, 'no source files were scanned, so this guard would certify an empty set').toBeGreaterThan(900)
    expect(withMkdtemp, 'the set of files using mkdtemp collapsed (404 when this floor was set), so the rule under test lost its population').toBeGreaterThan(300)
    expect(offenders, 'resolve these with the .native realpath: the plain one echoes the spelling it is handed, which is the 8.3 alias on windows-latest and the /var symlink on macos-latest').toEqual([])
  })

  it('is calibrated: each needle matches the shape it is meant to catch and rejects the .native form', () => {
    // Without this, widening or narrowing a needle by accident is invisible -- the guard would go
    // green over a population it no longer inspects, which is how its first version shipped.
    // Built from parts for the same reason the needles are: a literal offending line written here
    // would be a real offender in a tracked file, and the scan above would report it. Assembling
    // keeps the calibration honest without an exemption that could later hide a genuine one.
    const RP = `realpath${'Sync'}`
    const MK = `mkdtemp${'Sync'}`
    const shouldMatch = [
      `const d = fs.${RP}(fs.${MK}(path.join(os.tmpdir(), "x-")))`,
      `base = fsReal.${RP}(fsReal.${MK}(path.join(os.tmpdir(), "x-")))`,
      `const d = ${RP}(${MK}(dir))`,
      `const d = fs.${RP}(${MK}(dir))`,
      `const binDir = await fs.${'realpath'}(await fs.${'mkdtemp'}(path.join(os.tmpdir(), "x-")))`,
      // Two-level receivers. A single-optional-receiver pattern misses both, and the second is the
      // real spelling that slipped past the first version of this guard.
      `const d = node.fs.${RP}(node.fs.${MK}(dir))`,
      `const binDir = await fs.promises.${'realpath'}(await fs.promises.${'mkdtemp'}(dir))`,
    ]
    const shouldNotMatch = [
      `const d = fs.${RP}.native(fs.${MK}(path.join(os.tmpdir(), "x-")))`,
      `base = fsReal.${RP}.native(fsReal.${MK}(dir))`,
      `const binDir = ${RP}.native(await fs.${'mkdtemp'}(dir))`,
      `const d = node.fs.${RP}.native(node.fs.${MK}(dir))`,
      `const d = fs.${RP}(somethingElse)`,
      `const d = fs.${MK}(prefix)`,
    ]
    expect(
      shouldMatch.filter((s) => !NEEDLES.some((re) => re.test(s))),
      'these offending spellings are not caught by any needle',
    ).toEqual([])
    expect(
      shouldNotMatch.filter((s) => NEEDLES.some((re) => re.test(s))),
      'these acceptable spellings are wrongly flagged',
    ).toEqual([])
  })
})
