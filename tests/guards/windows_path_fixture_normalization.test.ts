/**
 * Guard against hand-rolled Windows path normalization in test fixtures.
 *
 * A test that builds a synthetic file_path/session-path fixture by hand-flipping
 * backslashes to forward slashes and lowercasing the drive letter (instead of importing
 * normalizePath from src/paths.ts) silently diverges from it on a runner whose %TEMP% is
 * pinned to its 8.3 short form -- GitHub's windows-latest uses `RUNNER~1`, and
 * normalizePath expands that to its long form while a hand-rolled version does not. The
 * fixture then never matches what the app's own normalizePath-routed code produces at
 * runtime, so the test fails on CI while passing on a dev machine whose %TEMP% happens not
 * to be short-form. This exact anti-pattern has already caused four separate incidents
 * (commit 442f42d3, the cmdHot --project regression test, cli_waste.test.ts's
 * no-transcript-found --json test in commit f592ea05, and cli_doctor.test.ts's rootDir-
 * scoping regression test in commit bf10171a) -- the third one slipped past this guard's
 * original detection, which additionally required a dedicated `[A-Za-z]` drive-letter
 * capture-group regex to be present; a blanket whole-string `.toLowerCase()` folds the
 * drive letter too without needing one, so that variant went undetected. The fourth one
 * slipped past even the widened `.toLowerCase()`-co-occurrence check: it hand-flipped
 * backslashes with no lowercase call at all, and still diverged from normalizePath() --
 * not via 8.3 short-name expansion this time, but via normalizeDarwinSystemAlias()
 * rewriting macOS's `/var` temp-dir alias to `/private/var`, which a bare backslash-flip
 * never applies either. A second, independent check below flags any file that hand-rolls
 * a backslash-flip while also inserting rows directly into `files`/`symbols`/`refs` --
 * the fixture-construction shape every one of these four incidents shared -- regardless
 * of whether `.toLowerCase()` happens to be present, so this guard makes a fifth one fail
 * loudly and locally instead of silently only on CI.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const TESTS_DIR = path.join(ROOT, 'tests')

/**
 * `fs.readdirSync` that treats a directory which no longer exists as empty rather than
 * throwing. Other test files create and remove scratch directories under `tests/` via
 * mkdtemp while the suite runs in parallel, so one of them can vanish between this walk
 * listing it as an entry and descending into it -- an ENOENT that failed this guard for a
 * reason unrelated to what it checks. A directory that disappeared mid-walk holds no
 * committed `.test.ts` file for the guard to inspect, so skipping it is correct rather than
 * merely tolerant. Any other error still propagates.
 */
export function readdirIfPresent(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function walkTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirIfPresent(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTestFiles(full, out)
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

// The literal regex-literal token a hand-rolled backslash-to-forward-slash conversion uses.
const BACKSLASH_TO_SLASH_TOKEN = '/\\\\/g'

// Any direct INSERT into a path-keyed table -- the fixture-construction shape shared by
// every incident so far, independent of what else the conversion happens to do (lowercase,
// nothing at all).
const INSERT_PATH_TABLE_RE = /INSERT INTO (files|symbols|refs)\b/

function importsNormalizePath(src: string): boolean {
  return /from\s+['"](\.\.\/)+src\/paths\.js['"]/.test(src) && src.includes('normalizePath')
}

describe('no hand-rolled Windows path normalization in test fixtures', () => {
  // Regression: the walk used a bare readdirSync, so a scratch directory another test
  // removed between this walk listing it and descending into it threw ENOENT and failed
  // the guard for a reason unrelated to path normalization.
  it('treats a directory that vanished mid-walk as empty instead of throwing', () => {
    const gone = path.join(TESTS_DIR, 'tmp_guard_never_created_9f2a')
    expect(fs.existsSync(gone)).toBe(false)
    expect(readdirIfPresent(gone)).toEqual([])
  })

  it('still propagates a non-ENOENT readdir failure instead of swallowing it as empty', () => {
    // Only ENOENT means "vanished mid-walk". Pointing at a real file yields ENOTDIR, which
    // must still throw -- otherwise the helper would mask a genuinely broken walk as a clean
    // empty result and the guard would silently stop inspecting anything.
    const notADir = fileURLToPath(import.meta.url)
    expect(fs.existsSync(notADir)).toBe(true)
    expect(() => readdirIfPresent(notADir)).toThrow(/ENOTDIR/)
  })

  it('every test file that flips backslashes to slashes for a path fixture and also lowercases it imports normalizePath from src/paths.ts instead of reimplementing it', () => {
    const offenders: string[] = []
    for (const file of walkTestFiles(TESTS_DIR)) {
      const src = fs.readFileSync(file, 'utf8')
      if (!src.includes(BACKSLASH_TO_SLASH_TOKEN)) continue
      if (!src.toLowerCase().includes('tolowercase()')) continue
      if (importsNormalizePath(src)) continue
      offenders.push(path.relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it('every test file that hand-flips backslashes AND inserts fixture rows into a path-keyed table (files/symbols/refs) imports normalizePath from src/paths.ts instead of reimplementing it', () => {
    const offenders: string[] = []
    for (const file of walkTestFiles(TESTS_DIR)) {
      const src = fs.readFileSync(file, 'utf8')
      if (!src.includes(BACKSLASH_TO_SLASH_TOKEN)) continue
      if (!INSERT_PATH_TABLE_RE.test(src)) continue
      if (importsNormalizePath(src)) continue
      offenders.push(path.relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
})
