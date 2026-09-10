import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * `dataDir()` resolves the storage root from a DIFFERENT environment variable per platform
 * (see src/constants.ts): `LOCALAPPDATA` on win32, `XDG_DATA_HOME` on macOS and Linux. A test
 * that redirects only one of them is therefore isolated on exactly one platform and silently
 * leaks on the others -- `recordStat` writes to the worker-wide data dir while the assertion
 * reads the per-test one, so every stat count comes back zero.
 *
 * That is not hypothetical. `tests/content_store.test.ts` pinned `LOCALAPPDATA` alone, passed
 * on every Windows developer machine, and failed `expected 0 to be greater than 0` on the
 * `test` (ubuntu) and `test-macos` CI jobs -- a red main that no local run reproduced.
 *
 * This guard is a filesystem read over the test tree, so it costs nothing and runs everywhere.
 */

const TESTS_DIR = path.resolve(__dirname, '..')
const ASSIGN_LOCALAPPDATA = /process\.env\[['"]LOCALAPPDATA['"]\]\s*=/
const ASSIGN_XDG = /process\.env\[['"]XDG_DATA_HOME['"]\]\s*=/

/**
 * A per-line assignment to `varName`, excluding the restore half of the save/restore idiom every
 * pinning test uses: a saved-value variable captured up front, then written back in an `else`
 * branch once the real pin is no longer needed. That restore write matches the bare ASSIGN_*
 * regex just as well as the real pinning write does, so removing only the real pin from a test
 * file while leaving its own untouched cleanup block still read, to the bare regex, as "this file
 * pins both variables" -- confirmed by mutating bash_runner.test.ts's real pin away and watching
 * this guard stay green on the strength of its own restore line alone. Excluded here: any line
 * whose trimmed text starts with `else ` (the idiom's restore branch), and any assignment whose
 * right-hand side is itself a saved-value identifier (the same idiom without the keyword on its
 * own line, e.g. a one-line ternary restore). Deliberately worded above without spelling out the
 * literal assignment shape on one line, since this file is itself part of the scanned population
 * and a docstring quoting that shape verbatim would satisfy the very regex it documents.
 */
function realAssignments(source: string, varName: string): string[] {
  const re = new RegExp(`process\\.env\\[['"]${varName}['"]\\]\\s*=\\s*([^;\\n]+)`, 'g')
  const out: string[] = []
  for (const line of source.split('\n')) {
    if (/^\s*else\b/.test(line)) continue
    re.lastIndex = 0
    const m = re.exec(line)
    if (m === null) continue
    if (/^_saved/i.test(m[1]!.trim())) continue
    out.push(line)
  }
  return out
}

/**
 * Files that legitimately pin one variable alone because the behavior under test is that
 * variable itself, not the data directory it feeds. Keep this list short and justified.
 */
const SINGLE_VAR_EXEMPT = new Map<string, string>([
  ['screenshot.test.ts', 'exercises the Playwright-cache-under-LOCALAPPDATA discovery path, which is win32-specific by definition and never reaches dataDir()'],
])

function collectTestFiles(dir: string): string[] {
  const found: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    // A sibling test's temp dir can vanish mid-walk; a genuinely bad path still throws.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return found
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectTestFiles(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

describe('data-dir environment pinning is platform-complete', () => {
  // Pinned: a walk that returns nothing would report every test file as correctly pinning its
  // data dir, which is exactly what it would report if every test file stopped pinning it.
  const files = pinnedPopulation({
    what: 'tests/**/*.ts files checked for data-dir env pinning',
    items: collectTestFiles(TESTS_DIR),
    floor: 300,
    mustInclude: ['worker.test.ts'],
  })

  it('found test files to scan (sanity check that discovery is not silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  // The check above pins discovery, not either scan below, and the gap between the two is wide:
  // it passes on several hundred files while the scans read a couple of dozen. Both scans select
  // by an assignment regex, and if either stopped matching -- the env key renamed, or tests moving
  // to a helper that assigns it out of line -- that scan would read nothing, report no offenders,
  // and leave this file-count check green the whole time. So pin what each scan actually reads.
  it('both assignment regexes still select a live population, not just a live file list', () => {
    const sources = files.map((file) => fs.readFileSync(file, "utf8"))
    const pinsLocal = sources.filter((source) => ASSIGN_LOCALAPPDATA.test(source)).length
    const pinsXdg = sources.filter((source) => ASSIGN_XDG.test(source)).length
    expect(
      pinsLocal,
      `no test file assigns LOCALAPPDATA any more, so the first scan below examines nothing and its ` +
        `clean result is vacuous. Check whether ASSIGN_LOCALAPPDATA still describes how tests pin it.`,
    ).toBeGreaterThan(0)
    expect(
      pinsXdg,
      `no test file assigns XDG_DATA_HOME any more, so the second scan below examines nothing and its ` +
        `clean result is vacuous. Check whether ASSIGN_XDG still describes how tests pin it.`,
    ).toBeGreaterThan(0)
  })

  it('every file that pins LOCALAPPDATA also pins XDG_DATA_HOME', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      if (realAssignments(source, 'LOCALAPPDATA').length === 0) continue
      if (realAssignments(source, 'XDG_DATA_HOME').length > 0) continue
      if (SINGLE_VAR_EXEMPT.has(path.basename(file))) continue
      offenders.push(path.relative(TESTS_DIR, file))
    }
    expect(
      offenders,
      `${offenders.join(', ')} redirect LOCALAPPDATA without XDG_DATA_HOME, so they isolate dataDir() on win32 only and leak on macOS/Linux. Pin both to the same directory, or add a justified entry to SINGLE_VAR_EXEMPT.`,
    ).toEqual([])
  })

  it('every file that pins XDG_DATA_HOME also pins LOCALAPPDATA', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      if (realAssignments(source, 'XDG_DATA_HOME').length === 0) continue
      if (realAssignments(source, 'LOCALAPPDATA').length > 0) continue
      if (SINGLE_VAR_EXEMPT.has(path.basename(file))) continue
      offenders.push(path.relative(TESTS_DIR, file))
    }
    expect(
      offenders,
      `${offenders.join(', ')} redirect XDG_DATA_HOME without LOCALAPPDATA, the same platform-partial isolation in reverse: they leak on win32.`,
    ).toEqual([])
  })

  it('the exemption list still describes files that exist and still pin exactly one variable', () => {
    for (const [basename, reason] of SINGLE_VAR_EXEMPT) {
      const match = files.find((f) => path.basename(f) === basename)
      expect(match, `exempt file ${basename} no longer exists; drop the stale entry`).toBeDefined()
      const source = fs.readFileSync(match as string, 'utf8')
      const pinsBoth = ASSIGN_LOCALAPPDATA.test(source) && ASSIGN_XDG.test(source)
      expect(pinsBoth, `${basename} now pins both variables, so its exemption ("${reason}") is stale; remove it`).toBe(false)
    }
  })
})
