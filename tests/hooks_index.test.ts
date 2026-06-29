import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'

// A per-run data dir so the dirty queue never touches the real one. Created before the mocked dataDir() is read; the vi.mock factory below returns it.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idx-'))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR }
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
})

describe('preCompactIndexHandler', () => {
  it('returns pass and clears the queue, snapshotting pending paths', () => {
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
    expect(getDirtyPaths()).toEqual([])
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
})
