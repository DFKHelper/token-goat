/** Guard: a case-only rename must not leave the index reporting the old spelling. On a case-insensitive filesystem (Windows, macOS) `mv b.ts B.ts` changes nothing about the file's content, so the indexer's sha gate saw a byte-identical file and skipped it, and the deletion sweep left it alone because the file still exists. The row went on saying `b.ts` forever, and `symbol beta` answered `b.ts:1-3` for a file spelled `B.ts` on disk. Only a later change to the file's *content* ever corrected it. Why didn't a test catch this: every rename covered elsewhere in the suite changes the name to a genuinely different one, which the "file is gone" branch prunes on a case-insensitive filesystem exactly as it does on a case-sensitive one. A case-only rename is the single rename shape where the old path still resolves, so it is the only one that reaches the sha gate at all -- and no fixture ever performed one. The negative case is the one that costs something: `indexedPathSpellingIsStale` is narrowed to a pure case difference precisely so that a project reached through a symlink or a Windows junction (whose realpath is structurally different, not just differently cased) does not read as stale on every single file, every single run. Both halves are mutation-proved: forcing the helper to return false reddens the rename case alone, and dropping the fold comparison against the resolved spelling reddens the structural case alone. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../../src/db.js'
import { querySymbols } from '../../src/index_reader.js'
import { normalizePath } from '../../src/paths.js'
import { indexedPathSpellingIsStale } from '../../src/parser.js'
import { findGlobalDb } from '../helpers/find_global_db.js'
import { releaseFixture } from '../helpers/release_fixture.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

function run(projectDir: string, homeDir: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, TOKEN_GOAT_CASE_INSENSITIVE_FS: '1' },
  })
  return { status: res.status ?? 1, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

/** Does the host filesystem itself fold case? Probed rather than inferred from `process.platform`, because the cases below need the *stale* spelling to still open a file, which no environment override can arrange on a genuinely case-sensitive filesystem. */
function hostFsIsCaseInsensitive(): boolean {
  // Its own directory, not projectDir: skipIf is evaluated at collection time, before beforeAll has assigned projectDir at all.
  const dir = mkdtempSync(join(tmpdir(), 'tg-caseprobe-'))
  try {
    writeFileSync(join(dir, 'CaseProbe.txt'), 'x')
    return existsSync(join(dir, 'caseprobe.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('indexedPathSpellingIsStale', () => {
  // Only a directory holding a real beta.ts: nothing here reads the index, so nothing is indexed.
  let projectDir = ''

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'tg-caserename-'))
    writeFileSync(join(projectDir, 'beta.ts'), 'export function betaFn(): number {\n  return 2\n}\n')
  })

  afterAll(() => releaseFixture(projectDir))

  it('is false when the stored spelling already matches', () => {
    expect(indexedPathSpellingIsStale(normalizePath(join(projectDir, 'beta.ts')), join(projectDir, 'beta.ts'))).toBe(false)
  })

  it('is false for a structurally different path, not merely a differently cased one', () => {
    // A symlinked or junctioned route to the same file resolves to a different path entirely. Reporting that as stale would mark every file in such a project stale on every run.
    expect(indexedPathSpellingIsStale('/elsewhere/entirely/beta.ts', join(projectDir, 'beta.ts'))).toBe(false)
  })

  it('is false for a path that cannot be resolved rather than guessing a spelling', () => {
    const missing = join(projectDir, 'NoSuchFile.ts')
    expect(indexedPathSpellingIsStale(normalizePath(missing).toLowerCase(), missing)).toBe(false)
  })

  // The caller agreeing with the stored spelling proves nothing: git reports the name in its own index (still the old one until a case rename is staged) and an editor hook reports whatever the editor passed, so both can hand back the very spelling that has gone stale. An early `storedPath === candidate` return would answer "not stale" without ever asking the filesystem, and the row would stay wrong forever on exactly the paths that never reach a walk. Only reachable where the stale spelling still opens, i.e. a case-insensitive filesystem. Not every stored path in the index was written by normalizePath: the incremental worker writes the dirty queue's own spelling through unchanged, so a row it indexed can carry an upper-case drive letter where the bulk `index` command's rows carry the lower-case one. If the stored side is compared raw against a normalized candidate, that difference reads as a stale spelling and the file reindexes on every single drain, forever -- observed as files.indexed_at advancing on each pass over a byte-identical, correctly-spelled file.
  it('is false for a stored drive letter that merely differs in case from the normalized form', () => {
    const abs = join(projectDir, 'beta.ts')
    const stored = normalizePath(abs)
    const rawDriveSpelling = /^[a-z]:/.test(stored) ? stored[0]!.toUpperCase() + stored.slice(1) : stored
    expect(indexedPathSpellingIsStale(rawDriveSpelling, abs), 'an un-normalized stored drive letter reads as a stale spelling, reindexing forever').toBe(false)
  })

  it('is false for an ambient directory prefix that merely differs in case from realpathSync', () => {
    const abs = join(projectDir, 'beta.ts')
    const stored = normalizePath(abs)
    // Flip case of a parent directory segment in stored and candidate together (mimicking %TEMP% or cwd casing differences)
    const segments = stored.split('/')
    if (segments.length > 2) {
      segments[1] = segments[1]!.toUpperCase()
      const ambientCased = segments.join('/')
      expect(indexedPathSpellingIsStale(ambientCased, ambientCased)).toBe(false)
    }
  })

  it.skipIf(!hostFsIsCaseInsensitive())('is true when the caller repeats the stale spelling the row already holds', () => {
    const real = join(projectDir, 'Repeated.ts')
    writeFileSync(real, 'export const repeated = 1\n')
    const stale = normalizePath(real).toLowerCase()
    expect(indexedPathSpellingIsStale(stale, stale), 'the caller repeating a stale spelling hid it from the filesystem check').toBe(true)
  })
})

// One built-CLI spawn per step rather than a dozen in a single test: no test's pass depends on how many process starts fit inside one 60 s budget. The checks that only read the index read its rows in-process. Provenance: HAND-DERIVED -- beta.ts is written by each test's own fixture, and every spelling asserted is the one the test itself gave the file. LIKE folds ASCII case, so one query finds the row under either spelling and ignores the other fixtures in the directory.
const lastSegment = (p: string): string | undefined => p.replace(/\\/g, '/').split('/').pop()
// An explicit null check, so a run that never wrote global.db fails with this message rather than a cast handing `null` to the driver.
const requireGlobalDb = (homeDir: string): string => {
  const found = findGlobalDb(homeDir)
  if (found === null) throw new Error(`no global.db under ${homeDir}: the fixture's index run did not write one`)
  return found
}
const storedSpellings = (homeDir: string): (string | undefined)[] => (getDb(requireGlobalDb(homeDir)).prepare("SELECT path FROM files WHERE path LIKE '%/beta.ts'").pluck().all() as string[]).map(lastSegment)

describe('index after a case-only rename', () => {
  let projectDir = ''
  let homeDir = ''

  // Each test builds its own project and home: the rename mutates both the directory and the index, so nothing may carry from one test to the next.
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'tg-caserename-'))
    homeDir = mkdtempSync(join(tmpdir(), 'tg-caserename-home-'))
    writeFileSync(join(projectDir, 'beta.ts'), 'export function betaFn(): number {\n  return 2\n}\n')
    const indexed = run(projectDir, homeDir, ['index', '.', '--walk'])
    expect(indexed.status, `indexing the fixture failed: ${indexed.out.slice(0, 400)}`).toBe(0)
  })

  afterEach(() => {
    const dirs = [projectDir, homeDir]
    projectDir = ''
    homeDir = ''
    releaseFixture(...dirs)
  })

  // Two steps: a direct rename to a case variant is a no-op on a case-insensitive filesystem. Asserts the starting spelling first, so what follows is the rename at work.
  function renameAndReindex(): void {
    expect(storedSpellings(homeDir), 'the fixture was not indexed under its first spelling, so a spelling after the rename would not show the rename at work').toEqual(['beta.ts'])
    renameSync(join(projectDir, 'beta.ts'), join(projectDir, 'tmp-beta.ts'))
    renameSync(join(projectDir, 'tmp-beta.ts'), join(projectDir, 'BETA.ts'))
    const reindex = run(projectDir, homeDir, ['index', '.', '--walk'])
    expect(reindex.status, reindex.out).toBe(0)
  }

  // Calibration: the file is indexed under its first spelling, so whatever the other tests see is the rename at work.
  it('holds the file under its first spelling before anything is renamed', () => {
    expect(storedSpellings(homeDir)).toEqual(['beta.ts'])
    expect(querySymbols({ name: 'betaFn' }, requireGlobalDb(homeDir)).map((s) => lastSegment(s.filePath))).toEqual(['beta.ts'])
  })

  it('rewrites the stored spelling when the walk reindexes after the rename', () => {
    renameAndReindex()
    expect(storedSpellings(homeDir), 'the index kept a spelling the file no longer has').toEqual(['BETA.ts'])
    expect(querySymbols({ name: 'betaFn' }, requireGlobalDb(homeDir)).map((s) => lastSegment(s.filePath))).toEqual(['BETA.ts'])
  })

  it('reports the new spelling, not the one the file used to have', () => {
    renameAndReindex()
    const after = run(projectDir, homeDir, ['symbol', 'betaFn'])
    expect(after.status, after.out).toBe(0)
    expect(after.out, 'the index kept a spelling the file no longer has').toContain('BETA.ts')
  })
})
