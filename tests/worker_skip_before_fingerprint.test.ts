import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { drainOnce } from '../src/worker.js'
import { getDirtyPathsFor } from '../src/dirty_queue.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { querySymbols, getFileEntry } from '../src/index_reader.js'
import { closeDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { loadConfig } from '../src/config.js'
import type * as Fingerprint from '../src/fingerprint.js'

vi.mock('../src/config.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), loadConfig: vi.fn() }))
vi.mock('../src/fingerprint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Fingerprint>()
  return { ...actual, fingerprintFile: vi.fn(actual.fingerprintFile) }
})

let DIR: string

function setIndexing(indexing: Record<string, unknown>): void {
  vi.mocked(loadConfig).mockReturnValue({
    worker: { blocked_roots: [] },
    indexing: { skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576, ...indexing },
  } as unknown as ReturnType<typeof loadConfig>)
}

function enqueue(lines: string[]): void {
  const qp = path.join(DIR, 'queue', 'dirty.txt')
  fs.mkdirSync(path.dirname(qp), { recursive: true })
  fs.writeFileSync(qp, lines.map((l) => `${l}\n`).join(''))
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-skip-'))
  setIndexing({})
  vi.mocked(fingerprintFile).mockClear()
})

afterEach(() => {
  closeDb(path.join(DIR, 'global.db'))
  fs.rmSync(DIR, { recursive: true, force: true })
})

// Provenance: HAND-DERIVED. fingerprintFile reads the whole file, so the worker must decide a file is skip-eligible from its path and stat before that read: a log over large_file_skip_kb was otherwise loaded whole on every drain only to be skipped, and one Node cannot read whole (over 2 GiB, ERR_FS_FILE_TOO_LARGE) was requeued as a transient failure until its retries ran out, with its stale rows never purged. A file over 2 GiB cannot be created portably, so the skip-eligible case is a file excluded by skip_files after it was indexed, asserted never to reach fingerprintFile; a directory at the path is a deletion now (indexedFileIsGone) and is covered by tests/dir_replacing_indexed_file_is_pruned.test.ts.
describe('worker skip-eligibility is decided before the file is read', () => {
  it('reads an ordinary file to fingerprint it', () => {
    const src = path.join(DIR, 'plain.ts')
    fs.writeFileSync(src, 'export function plainWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    enqueue([norm])
    expect(drainOnce(DIR)).toBe(1)
    expect(vi.mocked(fingerprintFile).mock.calls.map((c) => c[0])).toContain(norm)
    expect(querySymbols({ name: 'plainWorkerSymbol', limit: 10 }, path.join(DIR, 'global.db')).length).toBe(1)
  })

  it('purges a file that crossed large_file_skip_kb without reading it', () => {
    const src = path.join(DIR, 'grown.ts')
    fs.writeFileSync(src, 'export function grownWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    const db = path.join(DIR, 'global.db')
    enqueue([norm])
    expect(drainOnce(DIR)).toBe(1)
    expect(querySymbols({ name: 'grownWorkerSymbol', limit: 10 }, db).length).toBe(1)

    setIndexing({ large_file_skip_kb: 0 })
    vi.mocked(fingerprintFile).mockClear()
    enqueue([norm])
    expect(drainOnce(DIR)).toBe(1)
    expect(vi.mocked(fingerprintFile).mock.calls.map((c) => c[0])).not.toContain(norm)
    expect(querySymbols({ name: 'grownWorkerSymbol', limit: 10 }, db).length).toBe(0)
    expect(getFileEntry(norm, db)).toBeNull()
  })

  it('purges a skip-eligible path that cannot be read whole instead of requeueing it', () => {
    const src = path.join(DIR, 'huge.ts')
    fs.writeFileSync(src, 'export function hugeWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    const db = path.join(DIR, 'global.db')
    enqueue([norm])
    expect(drainOnce(DIR)).toBe(1)
    expect(querySymbols({ name: 'hugeWorkerSymbol', limit: 10 }, db).length).toBe(1)

    setIndexing({ skip_files: ['huge.ts'] })
    vi.mocked(fingerprintFile).mockClear()
    enqueue([norm])
    expect(drainOnce(DIR)).toBe(1)
    expect(vi.mocked(fingerprintFile).mock.calls.map((c) => c[0])).not.toContain(norm)
    expect(querySymbols({ name: 'hugeWorkerSymbol', limit: 10 }, db).length).toBe(0)
    expect(getFileEntry(norm, db)).toBeNull()
    expect(getDirtyPathsFor(DIR)).not.toContain(norm)
  })
})
