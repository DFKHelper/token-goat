import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: indexFileSync must ignore ENOENT but propagate other read failures. The direct-call cases below pin that contract. The worker integration uses a different guarantee: fingerprintFileWithBytes supplies the raw bytes to indexFileSync, so a dirty file is not reopened after its fingerprint read.
//
// The module mock counts matching raw and canonical-path reads. Direct indexFileSync tests inject a failure on the first read; the worker integration allows the fingerprint read and would fail a second read. vi.spyOn cannot patch node:fs namespace exports, so this follows the module-mock seam in parser_sha_race.test.ts.
const mockState = vi.hoisted(() => ({
  target: '',
  extraTargets: [] as string[],
  errorCode: '',
  skipCalls: 0,
  callCount: 0,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedReadFileSync = (
    target: fs.PathOrFileDescriptor,
    options?: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | null,
  ): string | Buffer => {
    if (
      typeof target === 'string' &&
      (target === mockState.target || mockState.extraTargets.includes(target)) &&
      mockState.errorCode
    ) {
      const shouldThrow = mockState.callCount >= mockState.skipCalls
      mockState.callCount++
      if (shouldThrow) {
        throw Object.assign(new Error(`simulated ${mockState.errorCode} failure`), {
          code: mockState.errorCode,
        })
      }
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
import { normalizePath, resolveIndexPath } from '../src/paths.js'
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
    mockState.extraTargets = []
    mockState.errorCode = ''
    mockState.skipCalls = 0
    mockState.callCount = 0
  })

  afterEach(() => {
    mockState.target = ''
    mockState.extraTargets = []
    mockState.errorCode = ''
    mockState.skipCalls = 0
    mockState.callCount = 0
    closeAllDbs()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('silently no-ops on ENOENT (the file disappeared before parsing) without throwing', () => {
    const file = path.join(TMP, 'deleted.ts')
    fs.writeFileSync(file, 'export function goneSoon(): number {\n  return 1\n}\n')
    // indexFileSync reads through the canonicalized spelling of `file` (same as `resolveIndexPath`), not the raw native one, so the mock must guard that same target or the injected failure never fires and the real read succeeds.
    mockState.target = resolveIndexPath(file)
    mockState.errorCode = 'ENOENT'

    expect(() => indexFileSync(file, dbPath)).not.toThrow()
    // Nothing was written: the file's row must not exist.
    expect(getFileEntry(file, dbPath)).toBeNull()
  })

  it('rethrows a non-ENOENT read failure (e.g. a Windows AV/editor lock) instead of swallowing it', () => {
    const file = path.join(TMP, 'locked.ts')
    fs.writeFileSync(file, 'export function neverIndexed(): number {\n  return 1\n}\n')
    // Same canonicalization as the ENOENT case above: the mock must guard the target indexFileSync actually reads through.
    mockState.target = resolveIndexPath(file)
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

  // Integration coverage: drives the REAL production path (drainOnce -> processDirtyBatch -> makeIndexer -> indexFileSync), proving that the worker indexes the same bytes it fingerprinted rather than reopening the file.
  it('reuses worker fingerprint bytes for indexing without a second file read', () => {
    const good = path.join(TMP, 'good.ts')
    const bad = path.join(TMP, 'bad.ts')
    fs.writeFileSync(good, 'export function knownGoodSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(bad, 'export function neverIndexedSymbol(): number {\n  return 2\n}\n')
    writeQueue(TMP, [good, bad])

    // The fingerprint reads the raw `bad` spelling; indexFileSync would reopen its canonical spelling if the worker did not pass the pre-read bytes.
    mockState.target = bad
    mockState.extraTargets = [resolveIndexPath(bad)]
    mockState.errorCode = 'EBUSY'
    // Allow the fingerprint read; the mock throws if the worker causes a second read of either spelling.
    mockState.skipCalls = 1

    const projectDb = path.join(TMP, 'global.db')
    const count = drainOnce(TMP)

    expect(count).toBe(2)
    expect(mockState.callCount, 'the worker read the dirty file more than once').toBe(1)
    const badEntry = getFileEntry(normalizePath(bad), projectDb)
    expect(badEntry, 'the fingerprinted file must have an index row').not.toBeNull()
    expect(querySymbols({ name: 'neverIndexedSymbol', limit: 10 }, projectDb).length).toBeGreaterThan(0)
    expect(querySymbols({ name: 'knownGoodSymbol', limit: 10 }, projectDb).length).toBeGreaterThan(
      0,
    )

    const logPath = path.join(TMP, 'worker-errors.log')
    expect(fs.existsSync(logPath)).toBe(false)
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
    mockState.skipCalls = 0
    mockState.callCount = 0
  })

  afterEach(() => {
    mockState.target = ''
    mockState.extraTargets = []
    mockState.errorCode = ''
    mockState.skipCalls = 0
    mockState.callCount = 0
    closeAllDbs()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  // Regression: e833b00f made indexFileSync rethrow any non-ENOENT read failure instead of silently miscounting the file as indexed -- correct for worker.ts's makeIndexer, which already wraps its call in a try/catch and logs an INDEX_FAILED sentinel (see the sibling describe block above). But cmdIndex's own per-file loop in cli.ts called indexFileSync with NO try/catch at all, so the very first transient per-file failure (EBUSY/EPERM from an AV scan or an open editor -- both common on Windows) in a real `token-goat index` walk aborted the whole command uncaught, leaving every file after the failing one unindexed -- the opposite of what indexFileSync's own ENOENT fail-soft design intends for a bulk walk.
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
    expect(querySymbols({ name: 'knownGoodSymbol', limit: 10 }, dbPath).length).toBe(1)
    // ...and the failing file must not be silently counted as indexed.
    expect(querySymbols({ name: 'neverIndexedSymbol', limit: 10 }, dbPath).length).toBe(0)
    expect(getFileEntry(bad, dbPath)).toBeNull()

    // The failure must be surfaced to the user, not swallowed: file path + error on stderr, and a non-zero failure count folded into the final summary.
    expect(stderrChunks.join('')).toContain(path.basename(bad))
    expect(stderrChunks.join('')).toContain('EBUSY')
    expect(stdoutChunks.join('')).toMatch(/failed to index 1 file/i)
  })

  it('aggregates repeated foreground read failures by error message', async () => {
    const badA = path.join(TMP, 'bad-a.ts')
    const badB = path.join(TMP, 'bad-b.ts')
    fs.writeFileSync(badA, 'export function neverIndexedA(): number {\n  return 1\n}\n')
    fs.writeFileSync(badB, 'export function neverIndexedB(): number {\n  return 2\n}\n')

    mockState.target = resolveIndexPath(badA)
    mockState.extraTargets = [resolveIndexPath(badB)]
    mockState.errorCode = 'UNKNOWN'

    const stderrChunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk))
      return true
    })
    try {
      await cmdIndex(TMP, { walk: true, dbPath })
    } finally {
      stderrSpy.mockRestore()
    }

    const output = stderrChunks.join('')
    expect(output.match(/failed to index/g)).toHaveLength(1)
    expect(output).toContain('and 1 other file')
  })

  // Regression: cmdIndex's per-file loop counted failures but never set process.exitCode, so a run where every single file failed (indexed: 0, failed: N -- a completely broken index) still exited 0. Any script gating on `$?` after `token-goat index` had no way to detect a total failure. Forces the only file in the walk to throw on read and asserts a nonzero exit code is set; the control test below confirms a normal successful run still exits 0.
  it('sets a nonzero exit code when every file in the walk fails to index', async () => {
    const bad = path.join(TMP, 'bad.ts')
    fs.writeFileSync(bad, 'export function neverIndexedSymbol(): number {\n  return 2\n}\n')

    mockState.target = resolveIndexPath(bad)
    mockState.errorCode = 'EBUSY'

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      await cmdIndex(TMP, { walk: true, dbPath })
      // cmdIndex sets a fixed literal 1, not a failure count.
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previousExitCode
      stderrSpy.mockRestore()
    }
  })

  it('control: a normal successful index run still exits 0', async () => {
    const good = path.join(TMP, 'good.ts')
    fs.writeFileSync(good, 'export function knownGoodSymbol(): number {\n  return 1\n}\n')

    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      await cmdIndex(TMP, { walk: true, dbPath })
      expect(process.exitCode).toBeFalsy()
    } finally {
      process.exitCode = previousExitCode
    }
  })
})
