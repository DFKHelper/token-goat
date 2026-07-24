import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadSessionState, readSessionStateFile, saveSessionState } from '../src/session_store.js'
import { normalizePath } from '../src/paths.js'
import {
  clearCurlDownload,
  exportSessionState,
  getCurlDownloadPath,
  importSessionState,
  MAX_RANGES_PER_FILE,
  recordCurlDownload,
  recordFileRead,
  recordLargeFileHintPending,
  recordSymbolRead,
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
      grepQueries: [['["useEffect","/src","content",""]', 12]],
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
    expect(got.grepQueries).toEqual([['["useEffect","/src","content",""]', 12]])
    expect(got.files.find((f) => f.path === '/b.ts')?.wasTruncated).toBe(true)
  })

  it('persists and restores bashReruns across a save/load round-trip (regression: coerce() and mergeSessionState() both omitted bashReruns entirely, so it never survived the disk round-trip even though exportSessionState/importSessionState carry it in-process -- silently making hooks_compact.ts\'s cross-process SAFE_TO_DISCARD rerun detection inert)', () => {
    importSessionState({ ...empty(), bashReruns: ['cmdhash-1', 'cmdhash-2'] })
    saveSessionState('sid-bashreruns')

    importSessionState(empty())
    expect(exportSessionState().bashReruns).toEqual([])

    loadSessionState('sid-bashreruns')
    expect(exportSessionState().bashReruns?.sort()).toEqual(['cmdhash-1', 'cmdhash-2'])
  })

  it('persists and restores lastTabContext across a save/load round-trip (regression: coerce() and mergeSessionState() both omitted lastTabContext entirely, so it never survived the disk round-trip even though exportSessionState/importSessionState carry it in-process -- silently making hooks_browser_image.ts\'s cross-process Tab Context dedup inert)', () => {
    importSessionState({ ...empty(), lastTabContext: 'Tab Context: tab 1' })
    saveSessionState('sid-tabcontext')

    importSessionState(empty())
    expect(exportSessionState().lastTabContext).toBeUndefined()

    loadSessionState('sid-tabcontext')
    expect(exportSessionState().lastTabContext).toBe('Tab Context: tab 1')
  })
})

describe('grepQueries merge-on-save (concurrent writer not clobbered)', () => {
  it('unions grepQueries from two saves under the same session id, mem overlays disk on key collision', () => {
    importSessionState({ ...empty(), grepQueries: [['sig-a', 3]] })
    saveSessionState('sid-grep-1')

    importSessionState({ ...empty(), grepQueries: [['sig-b', 7], ['sig-a', 9]] })
    saveSessionState('sid-grep-1')

    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-grep-1'), 'utf8')) as SerializedSession
    expect(new Map(disk.grepQueries ?? [])).toEqual(
      new Map([
        ['sig-a', 9],
        ['sig-b', 7],
      ]),
    )
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

describe('concurrent readCount increments are not lost on merge (task #110)', () => {
  it('sums two processes genuine reads instead of collapsing them via Math.max', () => {
    // Two processes both start from the same on-disk baseline (readCount 5 for the same
    // file) and each independently records exactly one new, real read via recordFileRead --
    // the actual production increment path, not a hand-built FileEntry -- simulating a
    // realistic race where two hook invocations read the same file close together.
    const filePath = path.join(tmpHome, 'shared.ts')
    fs.writeFileSync(filePath, 'export const x = 1\n')
    const normalized = normalizePath(filePath)
    const baseline: SerializedSession = { ...empty(), files: [file(normalized, 100, { readCount: 5 })] }

    // Process A: loads the shared baseline, records one genuine new read, saves first.
    importSessionState(baseline)
    recordFileRead(filePath)
    saveSessionState('sid-race')

    // Process B: independently loads the SAME baseline -- unaware of A's write -- records
    // its own genuine new read, and saves after A.
    importSessionState(baseline)
    recordFileRead(filePath)
    saveSessionState('sid-race')

    // Two distinct real reads happened (one per process) on top of a shared baseline of 5,
    // so the correct total is 7. Math.max(a.readCount, b.readCount) collapses this to 6,
    // silently losing process B's read.
    const disk = JSON.parse(fs.readFileSync(sessionFile('sid-race'), 'utf8')) as SerializedSession
    const entry = disk.files.find((f) => f.path === normalized)
    expect(entry?.readCount).toBe(7)
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

describe('curlDownloads merge (cleared downloads stay cleared)', () => {
  it('does not resurrect a curl download this process cleared, even though a fresh disk read at save time still has it (fail-on-buggy: a plain union-of-entries merge restores the deleted key)', () => {
    // Process A: a curl -o download is recorded and saved.
    importSessionState(empty())
    recordCurlDownload('http://x/f.zip', '/repo/a/downloads/f.zip')
    saveSessionState('sid-curl-1')

    const diskAfterA = JSON.parse(fs.readFileSync(sessionFile('sid-curl-1'), 'utf8')) as SerializedSession
    expect(diskAfterA.curlDownloads).toEqual([['http://x/f.zip', '/repo/a/downloads/f.zip']])

    // Process B: a fresh hook process loads that session, clears the download (its saved file
    // is gone), and saves. Nothing else touches the file in between, so the disk read at B's
    // save time still shows the entry — the merge must still drop it, not resurrect it.
    importSessionState(empty())
    loadSessionState('sid-curl-1')
    clearCurlDownload('http://x/f.zip')
    saveSessionState('sid-curl-1')

    const diskAfterB = JSON.parse(fs.readFileSync(sessionFile('sid-curl-1'), 'utf8')) as SerializedSession
    expect(diskAfterB.curlDownloads).toEqual([])
  })

  it('does not resurrect an untouched carried curl download when a concurrent process legitimately cleared it', () => {
    const sid = 'sid-curl-2'

    // Seed disk: an earlier process recorded and persisted a curl download.
    importSessionState(empty())
    recordCurlDownload('http://y/g.zip', '/repo/a/downloads/g.zip')
    saveSessionState(sid)

    // Process A: loads the disk snapshot (sees the URL) but never touches it — it's just
    // carried along in memory, unconsumed and unmodified.
    importSessionState(empty())
    loadSessionState(sid)
    expect(exportSessionState().curlDownloads).toEqual([['http://y/g.zip', '/repo/a/downloads/g.zip']])
    const aSnapshot = exportSessionState()

    // Process B: independently loads the same disk snapshot, legitimately clears the URL
    // (its saved file is gone), and saves — removing it from disk.
    importSessionState(empty())
    loadSessionState(sid)
    clearCurlDownload('http://y/g.zip')
    saveSessionState(sid)
    const afterB = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    expect(afterB.curlDownloads).toEqual([])

    // Process A now saves its own (stale) view. A plain union-of-entries overlay would still
    // resurrect the URL from A's stale in-memory copy. It must not: B already legitimately
    // cleared it.
    importSessionState(aSnapshot)
    saveSessionState(sid)

    const finalDisk = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    expect(finalDisk.curlDownloads).toEqual([])
  })

  it('still persists a genuinely new curl download a process recorded after loading', () => {
    const sid = 'sid-curl-3'
    importSessionState(empty())
    recordCurlDownload('http://existing/a.zip', '/repo/downloads/a.zip')
    saveSessionState(sid)

    importSessionState(empty())
    loadSessionState(sid)
    recordCurlDownload('http://new/b.zip', '/repo/downloads/b.zip')
    saveSessionState(sid)

    const disk = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')) as SerializedSession
    expect(disk.curlDownloads.slice().sort()).toEqual([
      ['http://existing/a.zip', '/repo/downloads/a.zip'],
      ['http://new/b.zip', '/repo/downloads/b.zip'],
    ])
    expect(getCurlDownloadPath('http://new/b.zip')).toBe('/repo/downloads/b.zip')
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
    // Regression (mutation-testing gap): the cap itself must actually be enforced -- the merge
    // was already at MAX_RANGES_PER_FILE from disk alone, so this process's new range must be
    // REJECTED, not silently appended past the cap. A mutation dropping the
    // `prev.length >= MAX_RANGES_PER_FILE` guard still passed every prior assertion here since
    // they only checked survival of the disk ranges, never the total count or the new range's
    // absence.
    expect(savedRanges.length).toBe(MAX_RANGES_PER_FILE)
    expect(savedRanges).not.toContainEqual([9999, 10005])
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

describe('created_ts (session-cache creation timestamp)', () => {
  // Regression: compact.ts::buildManifestAdaptive derives the session-age budget
  // multiplier from `created_ts`, but nothing ever wrote it, so age was always 0
  // and the multiplier was permanently stuck at the young/0.6 tier. saveSessionState
  // must stamp it once, in seconds, and never bump it on later writes.
  it('stamps created_ts once on first save and preserves it across later saves', () => {
    importSessionState(empty())
    const before = Date.now() / 1000
    recordFileRead('/proj/x.ts')
    saveSessionState('sid-created')
    const after = Date.now() / 1000

    const first = readSessionStateFile('sid-created')
    expect(first?.created_ts).toBeTypeOf('number')
    // Unit is seconds (matches compact.ts's `Date.now() / 1000 - created_ts`), not ms.
    expect(first!.created_ts!).toBeGreaterThanOrEqual(before)
    expect(first!.created_ts!).toBeLessThanOrEqual(after)

    const originalTs = first!.created_ts!
    // A later save (even after more activity and wall-clock movement) must not
    // move created_ts forward — it marks creation, not last modification.
    recordFileRead('/proj/y.ts')
    saveSessionState('sid-created')
    const second = readSessionStateFile('sid-created')
    expect(second!.created_ts!).toBe(originalTs)
  })

  it('does not resurrect created_ts as "now" after a write that inherits an older value', () => {
    importSessionState(empty())
    // Pre-seed a backdated created_ts on disk, then drive a real save; the merge
    // must keep the old value rather than overwrite it with the current time.
    recordFileRead('/proj/z.ts')
    saveSessionState('sid-backdate')
    const p = sessionFile('sid-backdate')
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as SerializedSession
    const backdated = Math.floor(Date.now() / 1000) - 4000
    raw.created_ts = backdated
    fs.writeFileSync(p, JSON.stringify(raw), 'utf8')

    recordFileRead('/proj/z2.ts')
    saveSessionState('sid-backdate')
    expect(readSessionStateFile('sid-backdate')!.created_ts).toBe(backdated)
  })
})

describe('symbols_read (surgical-read tokens) persistence', () => {
  // Regression: compact.ts::computeAdaptiveBudget rewards files with a non-empty
  // symbols_read via symbolsBonus, but the field was never written and, even if
  // present, asFileEntry/mergeFileEntry dropped it — so the bonus was always 0.
  // Drive the real writer (recordSymbolRead) through the real store round-trip.
  it('preserves symbols_read across a save -> load round-trip', () => {
    importSessionState(empty())
    recordSymbolRead('/proj/src/foo.ts', 'myFunc')
    recordSymbolRead('/proj/src/foo.ts', 'otherFunc')
    saveSessionState('sid-symbols')

    const disk = readSessionStateFile('sid-symbols')
    const entry = disk?.files.find((f) => f.path.endsWith('foo.ts'))
    expect(entry).toBeDefined()
    expect(entry!.symbols_read).toEqual(['myFunc', 'otherFunc'])
    // A surgical CLI read is not a Read-tool fire, so readCount stays 0.
    expect(entry!.readCount).toBe(0)
  })

  it('unions symbols_read from disk and memory on merge (concurrent writer not clobbered)', () => {
    importSessionState(empty())
    // Landed on disk by another process: foo.ts read for symbol "a".
    recordSymbolRead('/proj/src/foo.ts', 'a')
    saveSessionState('sid-symbols-merge')

    // This process starts fresh and records a different symbol for the same file,
    // then saves — the merge must keep both, not drop the disk one.
    importSessionState(empty())
    recordSymbolRead('/proj/src/foo.ts', 'b')
    saveSessionState('sid-symbols-merge')

    const entry = readSessionStateFile('sid-symbols-merge')?.files.find((f) => f.path.endsWith('foo.ts'))
    expect(entry?.symbols_read?.sort()).toEqual(['a', 'b'])
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
