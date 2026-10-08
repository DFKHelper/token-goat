/** The pre-read navigation probe against a really drained index: the totals it reports, and what it does about an mtime that moved over unchanged bytes. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Fingerprint from '../src/fingerprint.js'
import { closeDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce } from '../src/worker.js'

const fingerprintCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/fingerprint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Fingerprint>()
  return {
    ...actual,
    fingerprintFile: (filePath: string) => {
      fingerprintCalls.count += 1
      return actual.fingerprintFile(filePath)
    },
  }
})

// The hook must not write the database or spawn anything: it hands the path to the dirty queue. The real function would also drop a path under the OS temp dir, where these files live.
const enqueued = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('../src/hooks_index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueDirtyPathSafe: (filePath: string) => {
    enqueued.paths.push(filePath)
  },
}))

const { getReadNavigationEvidence } = await import('../src/read_navigation_evidence.js')

let DIR: string
let dbPath: string

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nav-evidence-'))
  dbPath = path.join(DIR, 'global.db')
  enqueued.paths.length = 0
})

afterEach(() => {
  closeDb(dbPath)
  fs.rmSync(DIR, { recursive: true, force: true })
})

/** Drain `file` through the worker's default path, as a real drain does. */
function drain(file: string): void {
  const queue = path.join(DIR, 'queue', 'dirty.txt')
  fs.mkdirSync(path.dirname(queue), { recursive: true })
  fs.writeFileSync(queue, `${normalizePath(file)}\n`)
  drainOnce(DIR)
}

// HAND-DERIVED: a module of `count` one-line functions named by their index.
function writeModule(name: string, count: number): string {
  const file = path.join(DIR, name)
  const lines: string[] = []
  for (let i = 0; i < count; i++) lines.push(`export function entry${i}(value: number): number { return value + ${i} }`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('getReadNavigationEvidence totals', () => {
  it('counts every symbol, not just the rows it keeps', () => {
    const file = writeModule('many.ts', 75)
    drain(file)
    const evidence = getReadNavigationEvidence(file, dbPath)
    expect(evidence?.symbolCount).toBe(75)
    expect(evidence?.headingCount).toBe(0)
    expect(evidence?.topSymbols.map((s) => s.name)).toEqual(Array.from({ length: 8 }, (_, i) => `entry${i}`))
  })

  it('counts headings apart from symbols', () => {
    const file = path.join(DIR, 'guide.md')
    const sections: string[] = []
    for (let i = 0; i < 70; i++) sections.push(`## Step ${i}\n\nProse for step ${i}.\n`)
    fs.writeFileSync(file, '# Guide\n\n' + sections.join('\n'))
    drain(file)
    const evidence = getReadNavigationEvidence(file, dbPath)
    expect(evidence?.headingCount).toBe(71)
    expect(evidence?.symbolCount).toBe(0)
    expect(evidence?.topHeadings).toHaveLength(8)
  })

  it('is null for a file that is not indexed', () => {
    expect(getReadNavigationEvidence(path.join(DIR, 'nothing.ts'), dbPath)).toBeNull()
  })
})

describe('getReadNavigationEvidence freshness', () => {
  it('is fresh and queues nothing when the mtime has not moved', () => {
    const file = writeModule('fresh.ts', 5)
    drain(file)
    fingerprintCalls.count = 0
    expect(getReadNavigationEvidence(file, dbPath)?.isStale).toBe(false)
    expect(fingerprintCalls.count).toBe(0)
    expect(enqueued.paths).toEqual([])
  })

  it('is stale, and queues nothing, when the bytes changed', () => {
    const file = writeModule('edited.ts', 5)
    drain(file)
    fs.appendFileSync(file, 'export const added = 1\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(file, later, later)
    expect(getReadNavigationEvidence(file, dbPath)?.isStale).toBe(true)
    expect(enqueued.paths).toEqual([])
  })

  it('is fresh over unchanged bytes, queues the path once, and stops hashing after the worker re-stamps it', () => {
    const file = writeModule('touched.ts', 5)
    drain(file)
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(file, later, later)

    fingerprintCalls.count = 0
    expect(getReadNavigationEvidence(file, dbPath)?.isStale).toBe(false)
    expect(fingerprintCalls.count).toBe(1)
    expect(enqueued.paths).toHaveLength(1)
    expect(normalizePath(enqueued.paths[0] ?? '')).toBe(normalizePath(file))

    drain(enqueued.paths[0] ?? file)

    fingerprintCalls.count = 0
    enqueued.paths.length = 0
    const again = getReadNavigationEvidence(file, dbPath)
    expect(again?.isStale).toBe(false)
    expect(fingerprintCalls.count).toBe(0)
    expect(enqueued.paths).toEqual([])
    expect(again?.indexedMtime).toBe(fs.statSync(file).mtimeMs / 1000)
  })
})
