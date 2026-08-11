/**
 * Token-savings regression benchmark.
 *
 * token-goat's core product claim (README / CLAUDE.md) is that its surgical-read
 * commands -- `symbol`, `read`, `outline`, `section` -- return dramatically smaller
 * output than a full-file `Read`, "typically 85-97% smaller". Nothing else in the
 * suite measures that claim: a regression that made e.g. `outline` dump near-full-file
 * output would pass every other test untouched.
 *
 * This spawns the real built bundle (dist/token-goat.mjs) against small synthetic
 * fixtures (tests/fixtures/token_savings/), indexes them through the shipping CLI
 * path, then measures each surgical-read command's stdout byte size against the
 * fixture's full-file byte size and asserts the savings percentage stays above a
 * conservative floor. Numbers are logged so a maintainer can see the real ratios
 * when a regression trips the floor.
 *
 * Floor rationale: measured savings across these fixtures today run ~76-93%, with
 * one documented exception below. A floor of 0% would never fail (defeats the
 * purpose); a floor at today's measured number would flake on any incidental
 * formatting byte. SAVINGS_FLOOR_PERCENT=60 leaves real headroom below every
 * measured command (>=16 points) while still catching a genuine regression, e.g. a
 * command silently degrading into a near-full-file dump.
 *
 * A case may override the shared floor via `floorPercent`, but only where a lower
 * number is a understood consequence of a deliberate change rather than a
 * regression. Lowering the SHARED floor to accommodate one case would silently
 * relax the guard for every other case too, which is the opposite of what this
 * test is for -- so the exception is scoped to the case that earned it.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'token_savings')

const SAVINGS_FLOOR_PERCENT = 60

const tempDirs = new Set<string>()

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

function runBundle(
  repo: string,
  dataBase: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    // token-goat follows platformdirs semantics: macOS derives its data dir from HOME,
    // Linux from XDG_DATA_HOME, and Windows from LOCALAPPDATA/USERPROFILE.
    env: {
      ...process.env,
      HOME: dataBase,
      USERPROFILE: dataBase,
      LOCALAPPDATA: dataBase,
      XDG_DATA_HOME: dataBase,
    },
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

interface Measurement {
  readonly label: string
  readonly command: readonly string[]
  readonly fixtureFile: string
  /**
   * Per-case override of {@link SAVINGS_FLOOR_PERCENT}. Only set this where a lower
   * ratio is an understood consequence of a deliberate change; an unexplained drop is
   * exactly the regression this benchmark exists to catch, and belongs in the code
   * under test rather than here.
   */
  readonly floorPercent?: number
}

const MEASUREMENTS: readonly Measurement[] = [
  { label: 'symbol fetchUser (service.ts)', command: ['symbol', 'fetchUser'], fixtureFile: 'service.ts' },
  { label: 'read service.ts::fetchUser', command: ['read', 'service.ts::fetchUser'], fixtureFile: 'service.ts' },
  { label: 'read report.py::calculate_total', command: ['read', 'report.py::calculate_total'], fixtureFile: 'report.py' },
  // Go's outline now surfaces each declaration's leading `//` doc comment, which the
  // parser previously dropped on the floor for every non-Python language. The output is
  // correspondingly larger -- that is the fix working, not a command degrading toward a
  // full-file dump, and this fixture is densely doc-commented so it feels it most. Kept
  // as a scoped exception with real headroom rather than by relaxing the shared floor.
  { label: 'outline inventory.go', command: ['outline', 'inventory.go'], fixtureFile: 'inventory.go', floorPercent: 50 },
  { label: 'section guide.md::Configuration', command: ['section', 'guide.md::Configuration'], fixtureFile: 'guide.md' },
]

function savingsPercent(fullBytes: number, outputBytes: number): number {
  return ((fullBytes - outputBytes) / fullBytes) * 100
}

describe('token savings regression benchmark', () => {
  it('surgical-read commands stay well below the floor of the claimed 85-97% output reduction', () => {
    const repo = tempDir('tg-savings-repo-')
    const dataBase = tempDir('tg-savings-data-')
    fs.cpSync(FIXTURE_DIR, repo, { recursive: true })
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

    const indexed = runBundle(repo, dataBase, ['index', repo])
    expect(indexed.status, indexed.stderr).toBe(0)
    expect(indexed.stdout).toMatch(/Indexed \d+ files? /)

    const results: Array<{ label: string; fullBytes: number; outputBytes: number; percent: number; floor: number }> = []

    for (const measurement of MEASUREMENTS) {
      const result = runBundle(repo, dataBase, measurement.command)
      expect(result.status, `${measurement.label} exited nonzero: ${result.stderr}`).toBe(0)
      expect(result.stdout.length, `${measurement.label} returned empty output`).toBeGreaterThan(0)

      const fullBytes = fs.statSync(path.join(repo, measurement.fixtureFile)).size
      const outputBytes = Buffer.byteLength(result.stdout, 'utf8')
      const percent = savingsPercent(fullBytes, outputBytes)
      results.push({
        label: measurement.label,
        fullBytes,
        outputBytes,
        percent,
        floor: measurement.floorPercent ?? SAVINGS_FLOOR_PERCENT,
      })
    }

    // Print the real measured numbers so a maintainer can see the actual ratios,
    // not just a pass/fail, when this test is inspected or when it trips the floor.
    console.log(
      '\nToken-savings benchmark results:\n' +
        results
          .map(
            (r) =>
              `  ${r.label}: full=${r.fullBytes}B output=${r.outputBytes}B savings=${r.percent.toFixed(1)}%`,
          )
          .join('\n'),
    )

    for (const r of results) {
      expect(r.percent, `${r.label}: only ${r.percent.toFixed(1)}% smaller than the full file (floor ${r.floor}%)`).toBeGreaterThanOrEqual(
        r.floor,
      )
    }

    const average = results.reduce((sum, r) => sum + r.percent, 0) / results.length
    console.log(`  average savings: ${average.toFixed(1)}%\n`)
    expect(average).toBeGreaterThanOrEqual(SAVINGS_FLOOR_PERCENT)
  }, 60_000)
})
