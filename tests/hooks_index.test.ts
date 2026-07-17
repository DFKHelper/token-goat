import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type * as UtilModule from '../src/util.js'

// A per-run data dir so the dirty queue never touches the real one. Created before the mocked dataDir() is read; the vi.mock factory below returns it.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idx-'))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  // globalDbPath()/configPath() close over dataDir() as a same-module self-reference, which
  // this factory's dataDir override can never redirect (a vi.mock export-spread only affects
  // what OTHER modules see when they import this one, not calls constants.ts makes to its own
  // exports internally). Every other test file isolating global.db/config.toml overrides these
  // two paths directly for the same reason -- see e.g. hooks_edit.test.ts, recall_index.test.ts.
  return {
    ...actual,
    dataDir: () => DATA_DIR,
    globalDbPath: () => path.join(DATA_DIR, 'global.db'),
  }
})

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    atomicWriteBytes: vi.fn(actual.atomicWriteBytes),
  }
})

const { appendDirtyPath, clearDirtyQueue, dirtyQueuePath, getDirtyPaths, preCompactIndexHandler } =
  await import('../src/hooks_index.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { globalDbPath } = await import('../src/constants.js')

beforeEach(() => {
  clearModuleCaches()
  clearDirtyQueue()
  try {
    fs.rmSync(path.join(DATA_DIR, 'queue'), { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

afterEach(() => {
  clearDirtyQueue()
})

describe('dirty queue', () => {
  it('getDirtyPaths returns [] when no dirty.txt exists', () => {
    expect(getDirtyPaths()).toEqual([])
  })

  it('getDirtyPaths returns appended paths in order', () => {
    appendDirtyPath('/a/one.ts')
    appendDirtyPath('/a/two.ts')
    expect(getDirtyPaths()).toEqual(['/a/one.ts', '/a/two.ts'])
  })

  it('getDirtyPaths deduplicates repeated paths', () => {
    appendDirtyPath('/a/one.ts')
    appendDirtyPath('/a/one.ts')
    appendDirtyPath('/a/two.ts')
    expect(getDirtyPaths()).toEqual(['/a/one.ts', '/a/two.ts'])
  })

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'getDirtyPaths deduplicates paths differing only by case on case-insensitive systems ' +
      '(regression: getDirtyPaths deduped by exact string only, drifting from getDirtyPathsFor ' +
      'in worker.ts which case-folds -- the two were documented as mirroring each other but only ' +
      'one was hardened; now both share parseDirtyQueueLines)',
    () => {
      appendDirtyPath('c:/projects/File.ts')
      appendDirtyPath('C:/PROJECTS/file.ts')
      expect(getDirtyPaths().length).toBe(1)
    },
  )

  it('appendDirtyPath writes to {dataDir}/queue/dirty.txt', () => {
    appendDirtyPath('/a/one.ts')
    expect(dirtyQueuePath()).toBe(path.join(DATA_DIR, 'queue', 'dirty.txt'))
    expect(fs.existsSync(dirtyQueuePath())).toBe(true)
  })

  it('clearDirtyQueue removes dirty.txt', () => {
    appendDirtyPath('/a/one.ts')
    expect(fs.existsSync(dirtyQueuePath())).toBe(true)
    clearDirtyQueue()
    expect(fs.existsSync(dirtyQueuePath())).toBe(false)
    expect(getDirtyPaths()).toEqual([])
  })

  it('clearDirtyQueue is idempotent when no file exists', () => {
    expect(() => clearDirtyQueue()).not.toThrow()
  })

  // Regression: if a previous process crashed mid-append, the queue file's last line can lack a
  // trailing newline. Appending directly after that torn fragment (no newline guard) merges it
  // with the new path into one garbage combined line, silently losing both until some other edit
  // touches either file.
  it('does not merge a torn last line into the next appended path (crash-recovery regression)', () => {
    fs.mkdirSync(path.dirname(dirtyQueuePath()), { recursive: true })
    fs.writeFileSync(dirtyQueuePath(), '/a/one.t') // torn: no trailing newline
    appendDirtyPath('/a/two.ts')
    expect(getDirtyPaths()).toEqual(['/a/one.t', '/a/two.ts'])
  })

  // Regression: appendDirtyPath used to unconditionally call resetTransientRetryCount, which
  // opens a full DB connection (WAL pragma, schema exec, FTS triggers, sqlite-vec extension
  // load attempt) via getDb() -- paying that cost on every single edit hook invocation just to
  // run a no-op retry-counter reset, and even creating global.db from scratch if it did not
  // already exist. processDirtyBatch (worker.ts) already resets the retry counter on every
  // successful read during a drain, so the append-time reset was redundant on the hot path.
  // This asserts the DB is never touched/created by a plain dirty-path append.
  it('does not open or create the global index DB on a plain append (no per-edit DB touch)', () => {
    const dbPath = globalDbPath()
    fs.rmSync(dbPath, { force: true })
    expect(fs.existsSync(dbPath)).toBe(false)

    appendDirtyPath('/a/one.ts')

    expect(fs.existsSync(dbPath)).toBe(false)
  })
})

describe('preCompactIndexHandler', () => {
  it('returns pass, writes an informational snapshot, and never clears the live queue', () => {
    appendDirtyPath('/a/one.ts')
    appendDirtyPath('/a/two.ts')

    const result = preCompactIndexHandler({
      eventName: 'pre_compact',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test',
      raw: {},
    })

    expect(result.hookType).toBe('pass')
    // Regression (M48): the live dirty queue must survive pre-compact. Clearing it here
    // dropped any entry appended around the same moment, since the snapshot sidecar is
    // never read back by anything (worker.ts only drains queue/dirty.txt).
    expect(getDirtyPaths()).toEqual(['/a/one.ts', '/a/two.ts'])
    const sidecar = path.join(DATA_DIR, 'queue', 'pending.txt')
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('/a/one.ts')
  })

  it('returns pass when the queue is empty', () => {
    const result = preCompactIndexHandler({
      eventName: 'pre_compact',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test',
      raw: {},
    })
    expect(result.hookType).toBe('pass')
  })

  it('preserves queue when sidecar write fails (regression: silent queue loss)', async () => {
    appendDirtyPath('/a/one.ts')
    appendDirtyPath('/a/two.ts')
    const queueBefore = getDirtyPaths()

    const { atomicWriteBytes } = await import('../src/util.js')
    vi.mocked(atomicWriteBytes).mockImplementation(() => {
      throw new Error('write failed')
    })

    const result = preCompactIndexHandler({
      eventName: 'pre_compact',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test',
      raw: {},
    })

    expect(result.hookType).toBe('pass')
    const queueAfter = getDirtyPaths()
    expect(queueAfter).toEqual(queueBefore)
    expect(queueAfter.length).toBeGreaterThan(0)
  })

  it('does not lose a path appended mid-snapshot (TOCTOU regression)', async () => {
    appendDirtyPath('/a/one.ts')

    const { atomicWriteBytes: actualAtomicWriteBytes } =
      await vi.importActual<typeof UtilModule>('../src/util.js')
    const { atomicWriteBytes } = await import('../src/util.js')
    vi.mocked(atomicWriteBytes).mockImplementation((...args) => {
      // Simulate appendDirtyPath racing in right as the snapshot is being written — this
      // must land in the live queue and survive the handler returning.
      appendDirtyPath('/a/concurrent.ts')
      return actualAtomicWriteBytes(...args)
    })

    const result = preCompactIndexHandler({
      eventName: 'pre_compact',
      toolName: undefined,
      toolInput: {},
      sessionId: 'test',
      raw: {},
    })

    expect(result.hookType).toBe('pass')
    expect(getDirtyPaths()).toEqual(['/a/one.ts', '/a/concurrent.ts'])
  })
})
