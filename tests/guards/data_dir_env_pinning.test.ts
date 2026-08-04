import { describe, expect, it } from 'vitest'
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
  const files = collectTestFiles(TESTS_DIR)

  it('found test files to scan (sanity check that discovery is not silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('every file that pins LOCALAPPDATA also pins XDG_DATA_HOME', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      if (!ASSIGN_LOCALAPPDATA.test(source)) continue
      if (ASSIGN_XDG.test(source)) continue
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
      if (!ASSIGN_XDG.test(source)) continue
      if (ASSIGN_LOCALAPPDATA.test(source)) continue
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
