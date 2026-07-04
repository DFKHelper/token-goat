import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: indexFileSync's own fs.readFileSync catch swallowed EVERY read failure alike
// (ENOENT, EBUSY, EACCES, ...), returning silently instead of throwing for anything but a
// genuinely-deleted file. That made a transient, non-ENOENT failure (e.g. a Windows AV/editor
// file lock) indistinguishable from success: makeIndexer never saw a throw, so the INDEX_FAILED
// sentinel + worker-errors.log path -- the whole "never silently count a failed reindex as
// success" guarantee -- never fired, and processDirtyBatch counted the file as indexed even
// though nothing was ever read or written, leaving its files.sha row stale forever. ENOENT (the
// file was legitimately deleted in the race window between being fingerprinted and
// indexFileSync's own read) must stay silent -- that is expected and harmless, not a failure
// worth logging.
//
// The guarded fs mock distinguishes by the `options` argument, mirroring the real difference
// between fingerprintFile's own read (fs.readFileSync(path), Buffer, no options) and
// indexFileSync's read (fs.readFileSync(path, 'utf8')). Targeting only the 'utf8' call
// reproduces the exact race window this fix protects -- fingerprintFile already succeeded (the
// file existed then); the read moments later, inside indexFileSync itself, hits the injected
// error -- without faking fingerprintFile's own read. vi.spyOn cannot patch node:fs (its
// namespace exports are non-configurable), so a module mock with hoisted flags is the portable
// way to inject this, matching the pattern already used in parser_sha_race.test.ts.
const mockState = vi.hoisted(() => ({ target: '', errorCode: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedReadFileSync = (
    target: fs.PathOrFileDescriptor,
    options?: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | null,
  ): string | Buffer => {
    if (
      typeof target === 'string' &&
      target === mockState.target &&
      options === 'utf8' &&
      mockState.errorCode
    ) {
      throw Object.assign(new Error(`simulated ${mockState.errorCode} failure`), {
        code: mockState.errorCode,
      })
    }
    return actual.readFileSync(target, options as never)
  }
  return { ...actual, default: actual, readFileSync: guardedReadFileSync }
})

import * as fs from 'node:fs'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { getFileEntry, querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { resolveIndexPath } from '../src/paths.js'
import { drainOnce } from '../src/worker.js'

function writeQueue(dir: string, lines: string[]): void {
  const qp = path.join(dir, 'queue', 'dirty.txt')
  fs.mkdirSync(path.dirname(qp), { recursive: true })
  fs.writeFileSync(qp, lines.map((l) => `${l}\n`).join(''))
}

describe('indexFileSync read-failure handling (regression)', () => {
  let TMP: string
  let dbPath: string

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parser-read-failure-'))
    dbPath = path.join(TMP, 'index.db')
    mockState.target = ''
    mockState.errorCode = ''
  })

  afterEach(() => {
    mockState.target = ''
    mockState.errorCode = ''
    closeAllDbs()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('silently no-ops on ENOENT (deleted between fingerprint and read) without throwing', () => {
    const file = path.join(TMP, 'deleted.ts')
    fs.writeFileSync(file, 'export function goneSoon(): number {\n  return 1\n}\n')
    mockState.target = file
    mockState.errorCode = 'ENOENT'

    expect(() => indexFileSync(file, dbPath)).not.toThrow()
    // Nothing was written: the file's row must not exist.
    expect(getFileEntry(file, dbPath)).toBeNull()
  })

  it('rethrows a non-ENOENT read failure (e.g. a Windows AV/editor lock) instead of swallowing it', () => {
    const file = path.join(TMP, 'locked.ts')
    fs.writeFileSync(file, 'export function neverIndexed(): number {\n  return 1\n}\n')
    mockState.target = file
    mockState.errorCode = 'EBUSY'

    let caught: unknown
    try {
      indexFileSync(file, dbPath)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as NodeJS.ErrnoException).code).toBe('EBUSY')
    // Nothing was written: the file's row must not exist.
    expect(getFileEntry(file, dbPath)).toBeNull()
  })

  // Integration coverage: drives the REAL production path (drainOnce -> processDirtyBatch ->
  // makeIndexer -> indexFileSync), not a reimplementation of the plumbing, so the fix is proven
  // against the actual observable guarantee the worker provides (INDEX_FAILED sentinel +
  // worker-errors.log), not just "indexFileSync itself throws".
  it('does not count a non-ENOENT read failure as indexed, and surfaces it via worker-errors.log', () => {
    const good = path.join(TMP, 'good.ts')
    const bad = path.join(TMP, 'bad.ts')
    fs.writeFileSync(good, 'export function knownGoodSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(bad, 'export function neverIndexedSymbol(): number {\n  return 2\n}\n')
    writeQueue(TMP, [good, bad])

    mockState.target = bad
    mockState.errorCode = 'EBUSY'

    const projectDb = path.join(TMP, 'global.db')
    const count = drainOnce(TMP)

    // The bad file must not be counted as a successful index...
    expect(count).toBe(1)
    // ...and nothing was ever actually written for it (files.sha row untouched)...
    expect(getFileEntry(bad, projectDb)).toBeNull()
    expect(querySymbols({ name: 'neverIndexedSymbol', limit: 10 }, projectDb).length).toBe(0)
    // ...while the rest of the batch still succeeds.
    expect(querySymbols({ name: 'knownGoodSymbol', limit: 10 }, projectDb).length).toBeGreaterThan(
      0,
    )

    // The swallowed failure must be surfaced somewhere discoverable: the worker's error log,
    // via the INDEX_FAILED sentinel path (see makeIndexer/logIndexFailure in worker.ts).
    const logPath = path.join(TMP, 'worker-errors.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const logContent = fs.readFileSync(logPath, 'utf8')
    expect(logContent).toContain(bad)
    expect(logContent).toContain('EBUSY')
  })
})

describe('cmdIndex per-file failure handling (regression)', () => {
  let TMP: string
  let dbPath: string

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-filefail-'))
    dbPath = path.join(TMP, 'index.db')
    mockState.target = ''
    mockState.errorCode = ''
  })

  afterEach(() => {
    mockState.target = ''
    mockState.errorCode = ''
    closeAllDbs()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  // Regression: e833b00f made indexFileSync rethrow any non-ENOENT read failure instead of
  // silently miscounting the file as indexed -- correct for worker.ts's makeIndexer, which
  // already wraps its call in a try/catch and logs an INDEX_FAILED sentinel (see the sibling
  // describe block above). But cmdIndex's own per-file loop in cli.ts called indexFileSync with
  // NO try/catch at all, so the very first transient per-file failure (EBUSY/EPERM from an AV
  // scan or an open editor -- both common on Windows) in a real `token-goat index` walk aborted
  // the whole command uncaught, leaving every file after the failing one unindexed -- the
  // opposite of what indexFileSync's own ENOENT fail-soft design intends for a bulk walk.
  it('skips a file whose read throws and still indexes the rest of the walk', async () => {
    const good = path.join(TMP, 'good.ts')
    const bad = path.join(TMP, 'bad.ts')
    fs.writeFileSync(good, 'export function knownGoodSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(bad, 'export function neverIndexedSymbol(): number {\n  return 2\n}\n')

    mockState.target = resolveIndexPath(bad)
    mockState.errorCode = 'EBUSY'

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk))
      return true
    })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk))
      return true
    })
    try {
      await cmdIndex(TMP, { walk: true, dbPath })
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    }

    // The rest of the walk must still be indexed...
    expect(querySymbols({ name: 'knownGoodSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
    // ...and the failing file must not be silently counted as indexed.
    expect(querySymbols({ name: 'neverIndexedSymbol', limit: 10 }, dbPath).length).toBe(0)
    expect(getFileEntry(bad, dbPath)).toBeNull()

    // The failure must be surfaced to the user, not swallowed: file path + error on stderr, and
    // a non-zero failure count folded into the final summary.
    expect(stderrChunks.join('')).toContain(path.basename(bad))
    expect(stderrChunks.join('')).toContain('EBUSY')
    expect(stdoutChunks.join('')).toMatch(/failed to index 1 file/i)
  })
})
