import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadSessionState, saveSessionState } from '../src/session_store.js'
import {
  exportSessionState,
  importSessionState,
  recordLargeFileHintPending,
  takePendingLargeFileHint,
  type FileEntry,
  type SerializedSession,
} from '../src/session.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sess-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

function file(p: string, lastReadAt: number, extra: Partial<FileEntry> = {}): FileEntry {
  return { path: p, readCount: 1, lastReadAt, wasEdited: false, sizeBytes: 100, ...extra }
}

function empty(): SerializedSession {
  return { files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }
}

function sessionFile(sid: string): string {
  return path.join(tmpHome, 'sessions', `${sid}.json`)
}

describe('save/load round-trip', () => {
  it('persists and restores the full session shape', () => {
    importSessionState({
      files: [file('/a.ts', 10), file('/b.ts', 20, { wasEdited: true, wasTruncated: true })],
      hintsShown: ['hint:1', 'hint:2'],
      webFetches: [['http://x', 'idx']],
      bashOutputs: [['cmdhash', 'outid']],
      curlDownloads: [['http://dl', '/tmp/f']],
    })
    saveSessionState('sid-1')

    importSessionState(empty())
    expect(exportSessionState().files).toHaveLength(0)

    loadSessionState('sid-1')
    const got = exportSessionState()
    expect(got.files.map((f) => f.path).sort()).toEqual(['/a.ts', '/b.ts'])
    expect(got.hintsShown.sort()).toEqual(['hint:1', 'hint:2'])
    expect(got.webFetches).toEqual([['http://x', 'idx']])
    expect(got.bashOutputs).toEqual([['cmdhash', 'outid']])
    expect(got.curlDownloads).toEqual([['http://dl', '/tmp/f']])
    expect(got.files.find((f) => f.path === '/b.ts')?.wasTruncated).toBe(true)
  })
})

describe('empty session id', () => {
  it('save is a no-op and writes no file', () => {
    importSessionState({ ...empty(), hintsShown: ['x'] })
    saveSessionState('')
    expect(fs.existsSync(path.join(tmpHome, 'sessions'))).toBe(false)
  })

  it('load is a no-op for an empty id', () => {
    importSessionState({ ...empty(), hintsShown: ['keep'] })
    loadSessionState('')
    expect(exportSessionState().hintsShown).toEqual(['keep'])
  })
})

describe('merge-on-save (concurrent writer not clobbered)', () => {
  it('unions hints and keeps both processes file edits', () => {
    // Process 1 saves its view.
    importSessionState({ ...empty(), files: [file('/a.ts', 10)], hintsShown: ['h1'] })
    saveSessionState('sid-2')

    // Process 2 starts cold, sees a different file + hint, and saves.
    importSessionState({ ...empty(), files: [file('/b.ts', 20)], hintsShown: ['h2'] })
    saveSessionState('sid-2')

    // The on-disk state must carry both processes' contributions.
    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-2'), 'utf8')) as SerializedSession
    expect(disk.hintsShown.sort()).toEqual(['h1', 'h2'])
    expect(disk.files.map((f) => f.path).sort()).toEqual(['/a.ts', '/b.ts'])
  })

  it('field-merges the same file: keeps the edit flag and newest size', () => {
    importSessionState({ ...empty(), files: [file('/a.ts', 10, { readCount: 3 })] })
    saveSessionState('sid-3')
    importSessionState({
      ...empty(),
      files: [file('/a.ts', 25, { wasEdited: true, sizeBytes: 999 })],
    })
    saveSessionState('sid-3')

    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-3'), 'utf8')) as SerializedSession
    expect(disk.files).toHaveLength(1)
    const a = disk.files[0]!
    expect(a.wasEdited).toBe(true) // edit flag never lost
    expect(a.readCount).toBe(3) // max of the two
    expect(a.lastReadAt).toBe(25) // newest
    expect(a.sizeBytes).toBe(999) // size from the newest read
  })
})

describe('case-insensitive filesystem path matching (#48)', () => {
  const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
  afterEach(() => {
    if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
  })

  // Regression: mergeSessionState keyed its byPath Map by the raw, case-preserved FileEntry.path.
  // A file recorded under one literal casing on disk (from an earlier save) and the SAME physical
  // file recorded under different casing in the fresh in-memory snapshot (case-insensitive
  // filesystems -- Windows/macOS) were treated as two distinct entries, producing duplicate
  // FileEntry rows for one physical file on every saveSessionState() call. Fold the merge key with
  // foldPath(), matching the fix already applied in session.ts (#47) and compact.ts.
  it('merges disk and in-memory entries for the same physical file recorded under different casing', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'

    // Process 1 saves its view, recording the file under one casing.
    importSessionState({ ...empty(), files: [file('C:/foo/Bar.ts', 10)] })
    saveSessionState('sid-case-1')

    // Process 2 starts cold, records the SAME physical file under different casing, and saves.
    // readDiskState() at save time still sees process 1's entry under its original casing.
    importSessionState({ ...empty(), files: [file('c:/foo/bar.ts', 20)] })
    saveSessionState('sid-case-1')

    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-case-1'), 'utf8')) as SerializedSession
    expect(disk.files).toHaveLength(1)
  })

  it('control: case-sensitive FS keeps differently-cased paths for the same file as distinct entries', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'

    importSessionState({ ...empty(), files: [file('C:/foo/Bar.ts', 10)] })
    saveSessionState('sid-case-2')

    importSessionState({ ...empty(), files: [file('c:/foo/bar.ts', 20)] })
    saveSessionState('sid-case-2')

    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-case-2'), 'utf8')) as SerializedSession
    expect(disk.files).toHaveLength(2)
  })
})

describe('pendingLargeFileHints merge (consumed hints stay consumed)', () => {
  it('does not resurrect a hint this process consumed, even though a fresh disk read at save time still has it (fail-on-buggy: a plain union-of-entries merge restores the deleted key)', () => {
    // Process A: a pre-read hook fires a pending hint for a large file and saves.
    importSessionState(empty())
    recordLargeFileHintPending('/big.md', 999999)
    saveSessionState('sid-pending-1')

    const diskAfterA = JSON.parse(fs.readFileSync(sessionFile('sid-pending-1'), 'utf8')) as SerializedSession
    expect(diskAfterA.pendingLargeFileHints).toEqual([['/big.md', 999999]])

    // Process B: a fresh hook process loads that session, resolves the hint (the CLI read that
    // followed it), and saves. Nothing else touches the file in between, so the disk read at B's
    // save time still shows the entry — the merge must still drop it, not resurrect it.
    importSessionState(empty())
    loadSessionState('sid-pending-1')
    expect(takePendingLargeFileHint('/big.md')).toBe(999999)
    saveSessionState('sid-pending-1')

    const diskAfterB = JSON.parse(fs.readFileSync(sessionFile('sid-pending-1'), 'utf8')) as SerializedSession
    expect(diskAfterB.pendingLargeFileHints ?? []).toEqual([])
  })

  it('still preserves an unrelated pending hint recorded by a concurrent process', () => {
    importSessionState(empty())
    recordLargeFileHintPending('/a.md', 100)
    saveSessionState('sid-pending-2')

    // Process B loads and consumes /a.md...
    importSessionState(empty())
    loadSessionState('sid-pending-2')
    takePendingLargeFileHint('/a.md')

    // ...but before B saves, a concurrent process records a different pending hint.
    const diskState = JSON.parse(fs.readFileSync(sessionFile('sid-pending-2'), 'utf8')) as SerializedSession
    diskState.pendingLargeFileHints = [['/a.md', 100], ['/c.md', 200]]
    fs.writeFileSync(sessionFile('sid-pending-2'), JSON.stringify(diskState))

    saveSessionState('sid-pending-2')

    const finalDisk = JSON.parse(fs.readFileSync(sessionFile('sid-pending-2'), 'utf8')) as SerializedSession
    expect((finalDisk.pendingLargeFileHints ?? []).map(([k]: [string, number]) => k).sort()).toEqual(['/c.md'])
  })
})

describe('pendingLargeFileHints merge does not resurrect an untouched carried key (#M22)', () => {
  it('does not resurrect a key a process merely carried from load when a concurrent process legitimately consumed and removed it', () => {
    const sid = 'sid-pending-3'

    // Seed disk: an earlier process recorded and persisted a pending hint for /k.md.
    importSessionState(empty())
    recordLargeFileHintPending('/k.md', 555)
    saveSessionState(sid)

    // Process A: loads the disk snapshot (sees /k.md) but never touches it — it's just
    // carried along in memory, unconsumed and unmodified.
    importSessionState(empty())
    loadSessionState(sid)
    expect(exportSessionState().pendingLargeFileHints).toEqual([['/k.md', 555]])
    const aSnapshot = exportSessionState()

    // Process B: independently loads the same disk snapshot, legitimately consumes /k.md
    // (resolves the hint), and saves — removing it from disk.
    importSessionState(empty())
    loadSessionState(sid)
    expect(takePendingLargeFileHint('/k.md')).toBe(555)
    saveSessionState(sid)
    const afterB = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    expect(afterB.pendingLargeFileHints ?? []).toEqual([])

    // Process A now saves its own (stale) view. Its own bookkeeping correctly shows it never
    // consumed /k.md (it never touched it, so the key is not in its own "consumed since load"
    // set) — a plain union-of-entries overlay would still resurrect it from A's stale
    // in-memory copy. It must not: B already legitimately removed the key.
    importSessionState(aSnapshot)
    saveSessionState(sid)

    const finalDisk = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    expect(finalDisk.pendingLargeFileHints ?? []).toEqual([])
  })

  it('still persists a genuinely new pending hint a process added after loading', () => {
    const sid = 'sid-pending-4'
    importSessionState(empty())
    recordLargeFileHintPending('/existing.md', 10)
    saveSessionState(sid)

    importSessionState(empty())
    loadSessionState(sid)
    recordLargeFileHintPending('/new.md', 20)
    saveSessionState(sid)

    const disk = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    expect((disk.pendingLargeFileHints ?? []).slice().sort()).toEqual([
      ['/existing.md', 10],
      ['/new.md', 20],
    ])
  })
})

describe('sed line-range overlap persistence (#87)', () => {
  it('persists and restores per-file served line ranges', () => {
    importSessionState({
      ...empty(),
      fileLineRanges: [['src/app.ts', [[1, 50], [40, 90]]]],
    })
    saveSessionState('sid-lr-1')

    importSessionState(empty())
    expect(exportSessionState().fileLineRanges ?? []).toHaveLength(0)

    loadSessionState('sid-lr-1')
    expect(exportSessionState().fileLineRanges).toEqual([['src/app.ts', [[1, 50], [40, 90]]]])
  })

  it('unions ranges for one file across two writers, deduping identical ranges', () => {
    importSessionState({ ...empty(), fileLineRanges: [['f.ts', [[1, 20]]]] })
    saveSessionState('sid-lr-2')
    importSessionState({ ...empty(), fileLineRanges: [['f.ts', [[1, 20], [30, 60]]]] })
    saveSessionState('sid-lr-2')

    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-lr-2'), 'utf8')) as SerializedSession
    expect(disk.fileLineRanges).toEqual([['f.ts', [[1, 20], [30, 60]]]])
  })

  it('drops malformed range entries on load without throwing', () => {
    importSessionState(empty())
    const sid = 'sid-lr-3'
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    fs.writeFileSync(
      sessionFile(sid),
      JSON.stringify({
        files: [],
        hintsShown: [],
        fileLineRanges: [['ok.ts', [[1, 9]]], 'garbage', ['bad.ts', 'notarray'], ['mixed.ts', [[2, 5], [99]]]],
      }),
    )
    expect(() => loadSessionState(sid)).not.toThrow()
    expect(exportSessionState().fileLineRanges ?? []).toEqual([['ok.ts', [[1, 9]]], ['mixed.ts', [[2, 5]]]])
  })
})

describe('line-range merge cap eviction fairness (#M6)', () => {
  it('does not evict already-persisted disk ranges to make room for a new local range at the cap', () => {
    const sid = 'sid-lr-cap'
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    const diskRanges: Array<[number, number]> = []
    for (let i = 0; i < 64; i++) diskRanges.push([i * 10, i * 10 + 5])
    fs.writeFileSync(
      sessionFile(sid),
      JSON.stringify({ ...empty(), fileLineRanges: [['big.ts', diskRanges]] }),
    )

    // This process only saw one brand-new, small range for the same file — far less than what
    // another process already had confirmed on disk.
    importSessionState({ ...empty(), fileLineRanges: [['big.ts', [[9999, 10005]]]] })
    saveSessionState(sid)

    const disk = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    const savedRanges = disk.fileLineRanges!.find(([f]) => f === 'big.ts')![1]
    // Every one of the other process's already-persisted ranges must survive the merge — none
    // may be evicted just to make room for this process's own not-yet-persisted contribution.
    for (const r of diskRanges) {
      expect(savedRanges).toContainEqual(r)
    }
  })
})

describe('corrupt / malformed disk state', () => {
  it('load treats a corrupt file as an empty session (fail-soft)', () => {
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    fs.writeFileSync(sessionFile('sid-4'), '{ broken', 'utf8')
    importSessionState({ ...empty(), hintsShown: ['preexisting'] })
    expect(() => loadSessionState('sid-4')).not.toThrow()
    // importSessionState is only called on a successful parse, so prior state stays.
    expect(exportSessionState().hintsShown).toEqual(['preexisting'])
  })

  it('save drops malformed file entries already on disk', () => {
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    fs.writeFileSync(
      sessionFile('sid-5'),
      JSON.stringify({ files: [{ path: 123 }, { nope: true }], hintsShown: ['ok'] }),
      'utf8',
    )
    importSessionState({ ...empty(), files: [file('/good.ts', 5)] })
    saveSessionState('sid-5')
    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-5'), 'utf8')) as SerializedSession
    expect(disk.files.map((f) => f.path)).toEqual(['/good.ts'])
    expect(disk.hintsShown).toEqual(['ok'])
  })
})

describe('Python-format session file compatibility', () => {
  it('loads file entries from a Python-format files dict', () => {
    const sid = 'py-compat-1'
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    // Write a Python-format session file (files is an object, not an array).
    const pySession = {
      schema_version: 1,
      created_by: 'token-goat',
      session_id: sid,
      files: {
        '/c/projects/bugcrowd/report.md': {
          rel_or_abs: '/c/projects/bugcrowd/report.md',
          read_count: 42,
          last_read_ts: 1700000000.5,
          read_size: 8192,
          last_edit_ts: 0,
          line_ranges: [[1, 50], [51, 100]],
        },
        '/c/projects/bugcrowd/scratch.md': {
          rel_or_abs: '/c/projects/bugcrowd/scratch.md',
          read_count: 7,
          last_read_ts: 1700000100.25,
          read_size: 512,
          last_edit_ts: 1700000200.0,
        },
      },
      hints_seen: ['hint-a', 'hint-b'],
      greps: [],
    }
    fs.writeFileSync(sessionFile(sid), JSON.stringify(pySession), 'utf8')

    importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
    loadSessionState(sid)

    const got = exportSessionState()
    expect(got.files).toHaveLength(2)
    const report = got.files.find((f) => f.path === '/c/projects/bugcrowd/report.md')
    expect(report).toBeDefined()
    expect(report!.readCount).toBe(42)
    expect(report!.lastReadAt).toBe(1700000000.5 * 1000)
    expect(report!.sizeBytes).toBe(8192)
    expect(report!.wasEdited).toBe(false)

    const scratch = got.files.find((f) => f.path === '/c/projects/bugcrowd/scratch.md')
    expect(scratch).toBeDefined()
    expect(scratch!.readCount).toBe(7)
    expect(scratch!.wasEdited).toBe(true)

    // hints_seen imported as hintsShown
    expect(got.hintsShown.sort()).toEqual(['hint-a', 'hint-b'])
  })

  it('uses dict key as path fallback when rel_or_abs is absent', () => {
    const sid = 'py-compat-2'
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    fs.writeFileSync(
      sessionFile(sid),
      JSON.stringify({
        files: {
          '/c/projects/fallback-key.md': {
            read_count: 3,
            last_read_ts: 1700000000,
            read_size: 256,
          },
        },
      }),
      'utf8',
    )
    importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
    loadSessionState(sid)
    const got = exportSessionState()
    expect(got.files).toHaveLength(1)
    expect(got.files[0]!.path).toBe('/c/projects/fallback-key.md')
  })

  it('Python-format session is migrated to TS format after save', () => {
    const sid = 'py-compat-migrate'
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true })
    fs.writeFileSync(
      sessionFile(sid),
      JSON.stringify({
        schema_version: 1,
        files: {
          '/mig.ts': { rel_or_abs: '/mig.ts', read_count: 5, last_read_ts: 1700000000, read_size: 1024 },
        },
        hints_seen: ['h1'],
      }),
      'utf8',
    )
    importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
    loadSessionState(sid)
    saveSessionState(sid)

    // The saved file must now use the TS format (files as array with the migrated entry).
    const saved = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as { files: unknown[] }
    expect(Array.isArray(saved.files)).toBe(true)
    expect(saved.files).toHaveLength(1)
  })
})

describe('file cap', () => {
  it('keeps only the most-recently-read entries past the cap', () => {
    const many: FileEntry[] = []
    for (let i = 0; i < 600; i++) many.push(file(`/f${i}.ts`, i))
    importSessionState({ ...empty(), files: many })
    saveSessionState('sid-6')
    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-6'), 'utf8')) as SerializedSession
    expect(disk.files).toHaveLength(500)
    const minKept = Math.min(...disk.files.map((f) => f.lastReadAt))
    expect(minKept).toBe(100) // the 100 oldest (lastReadAt 0..99) are evicted
  })
})
