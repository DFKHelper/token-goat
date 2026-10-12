/** The work one suggestPaths call does, counted rather than timed: the index's file list is read once however many rungs use it, and a directory is read entry by entry only up to the cap. The counts are HAND-DERIVED from the rungs: a missing `confg.ts` reaches the same-name rung (a file list) and the near-name rung (the same file list), so the old code read the table twice or more and this one reads it once. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as IndexReader from '../src/index_reader.js'
import type * as NodeFs from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ entryLoads: 0, handles: [] as number[], fakeDirs: false }))
const TOTAL_FAKE_ENTRIES = 20_000

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const real = await importOriginal<typeof IndexReader>()
  return {
    ...real,
    getOwnProjectFileEntries: (...args: Parameters<typeof real.getOwnProjectFileEntries>) => {
      probe.entryLoads += 1
      return real.getOwnProjectFileEntries(...args)
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>()
  const opendirSync = ((...args: Parameters<typeof real.opendirSync>) => {
    if (!probe.fakeDirs) return real.opendirSync(...args)
    const slot = probe.handles.push(0) - 1
    return {
      readSync: () => {
        probe.handles[slot] = (probe.handles[slot] ?? 0) + 1
        const n = probe.handles[slot] ?? 0
        return n <= TOTAL_FAKE_ENTRIES ? { name: `entry_${n}.ts` } : null
      },
      closeSync: () => undefined,
    }
  }) as typeof real.opendirSync
  return { ...real, default: { ...real, opendirSync }, opendirSync }
})

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { MAX_DIR_ENTRIES, suggestPaths } from '../src/path_suggest.js'

let project: string

beforeAll(() => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-ps-bounds-')))
  writeFileSync(join(project, 'package.json'), '{"name":"bounds"}\n')
  mkdirSync(join(project, 'src'), { recursive: true })
  const file = join(project, 'src', 'config.ts')
  writeFileSync(file, 'export const marker = 1\n', 'utf8')
  indexFileSync(normalizePath(file))
})

afterAll(() => rmSync(project, { recursive: true, force: true }))

beforeEach(() => {
  probe.entryLoads = 0
  probe.handles = []
  probe.fakeDirs = false
})

describe('one lookup, one read of the index', () => {
  it('reads the file list once while the same-name and near-name rungs both use it', () => {
    expect(suggestPaths('confg.ts', project, project)).toEqual(['src/config.ts'])
    expect(probe.entryLoads).toBe(1)
  })

  it('reads it once for a name that reaches every rung', () => {
    expect(suggestPaths('src/Confg.ts', project, project)).toEqual(['src/config.ts'])
    expect(probe.entryLoads).toBe(1)
  })

  it('reads none where there is no project', () => {
    suggestPaths('confg.ts', project, null)
    expect(probe.entryLoads).toBe(0)
  })
})

describe('a directory is read up to the cap and no further', () => {
  it('opens no directory outside the project', () => {
    probe.fakeDirs = true
    suggestPaths(join(project, '..', 'elsewhere', 'confg.ts'), project, project)
    expect(probe.handles.length).toBe(0)
  })

  it('stops each directory handle at the cap, however many entries it holds', () => {
    probe.fakeDirs = true
    suggestPaths('src/confg.ts', project, project)
    expect(probe.handles.length).toBeGreaterThan(0)
    expect(TOTAL_FAKE_ENTRIES).toBeGreaterThan(MAX_DIR_ENTRIES)
    for (const reads of probe.handles) expect(reads).toBe(MAX_DIR_ENTRIES)
  })
})
