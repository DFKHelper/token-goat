import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type * as NodeFsModule from 'node:fs'

import type * as ConstantsModule from '../../src/constants.js'

type NodeFs = typeof NodeFsModule

// Provenance: HAND-DERIVED. The queue body this asserts on is the one-path-per-line, newline-terminated format named in appendDirtyPaths' own contract, written out by hand from the input array. The mechanism assertion is against Node's documented `fs.readFileSync` entry point, counted by a pass-through wrapper around the real `node:fs`, so it measures what the module under test actually calls rather than restating any token-goat string.

// Every whole-file read of the queue, recorded by the wrapper below. `appendDirtyPath` used to do one of these per append, which made enqueueing N paths read 1 + 2 + ... + N lines; the whole point of the change is that this list stays empty however long the queue is.
const wholeFileReads: string[] = []

const DATA_DIR = path.join(os.tmpdir(), `tg-dqc-${process.pid}-${Date.now()}`)

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFs>()
  return {
    ...actual,
    default: actual,
    readFileSync: (p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      wholeFileReads.push(String(p))
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
  }
})

vi.mock('../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, globalDbPath: () => path.join(DATA_DIR, 'global.db') }
})

const fs = await vi.importActual<NodeFs>('node:fs')
const mockedFs = await import('node:fs')
const { appendDirtyPath, appendDirtyPaths, clearDirtyQueue, dirtyQueuePath, getDirtyPaths } =
  await import('../../src/hooks_index.js')

function seed(lines: number): void {
  const qp = dirtyQueuePath()
  fs.mkdirSync(path.dirname(qp), { recursive: true })
  fs.writeFileSync(qp, Array.from({ length: lines }, (_, i) => `/a/seed_${i}.ts\n`).join(''))
  wholeFileReads.length = 0
}

describe('dirty queue append does not scale with queue length', () => {
  it('appendDirtyPath never reads the whole queue file, however many entries it already holds', () => {
    for (const queueLength of [1, 500, 5000]) {
      seed(queueLength)
      appendDirtyPath(`/a/after_${queueLength}.ts`)
      expect(wholeFileReads.filter((p) => p === dirtyQueuePath())).toEqual([])
    }
    expect(getDirtyPaths().length).toBe(5001)
    clearDirtyQueue()
  })

  it('appendDirtyPaths never reads the whole queue file for a batch either', () => {
    seed(5000)
    appendDirtyPaths(['/a/b1.ts', '/a/b2.ts', '/a/b3.ts'])
    expect(wholeFileReads.filter((p) => p === dirtyQueuePath())).toEqual([])
    expect(fs.readFileSync(dirtyQueuePath(), 'utf8').endsWith('/a/b1.ts\n/a/b2.ts\n/a/b3.ts\n')).toBe(true)
    clearDirtyQueue()
  })

  it('the read counter is non-firing on a real whole-file read of the same queue (calibration)', () => {
    seed(10)
    const entries = fs.readFileSync(dirtyQueuePath(), 'utf8').split('\n').filter(Boolean)
    expect(entries.length).toBeGreaterThan(0)
    // Deliberately reading through the mocked module, so this proves the counter does record a whole-file read when one happens -- without it, the two empty-list assertions above would pass just as well against a broken wrapper that records nothing.
    mockedFs.readFileSync(dirtyQueuePath(), 'utf8')
    expect(wholeFileReads.filter((p) => p === dirtyQueuePath())).toEqual([dirtyQueuePath()])
    clearDirtyQueue()
  })
})
