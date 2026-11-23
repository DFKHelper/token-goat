import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsModule from 'node:fs'
import type * as InstallIndexModule from '../src/install_index.js'
import type * as ResidentProcess from '../src/resident_process.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runDoctorAndExit, runDoctorRepair } from '../src/cli_doctor.js'
import { checkDbExists } from '../src/cli_doctor_index.js'
import * as indexReclaimModule from '../src/index_reclaim.js'
import { _resetDataDirCacheForTesting, globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import Database from '../src/sqlite_driver.js'
import {
  checkDbIntegrity,
  isSqliteCorruptionDetail,
  isSqliteCorruptionError,
  MAX_FULL_SCAN_BYTES,
  quickCheckDb,
  smokeCheckDb,
} from '../src/db_integrity.js'
import { daemonEntryScript, workerLeftRunningNote, workerPidPath } from '../src/worker_lifecycle.js'
import { DENIED_WORKER_PID, plantDeniedWorker } from './helpers/denied_worker.js'
import { clearUpdateCheck, seedUpdateCheck } from './helpers/update-check.js'
import { workerCommandLine } from './helpers/worker_identity.js'
import { invalidateConfigCache } from '../src/config.js'

const queueMock = vi.hoisted(() => ({ override: undefined as undefined | (() => unknown) }))
const renameMock = vi.hoisted(() => ({ failFor: undefined as undefined | string }))
// The identity lookup stopWorker makes before it ends a pid-file pid: the planted pid is not a real process, so the lookup reports the command line a worker daemon has. The line is set per test, after the modules are loaded, because building it needs worker_lifecycle.ts, which imports this module.
const identity = vi.hoisted(() => ({ commandLine: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (renameMock.failFor !== undefined && String(from).endsWith(renameMock.failFor)) throw new Error('EBUSY: resource busy or locked')
    actual.renameSync(from, to)
  }
  return { ...actual, renameSync, default: { ...actual, renameSync } }
})

vi.mock('../src/resident_process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ResidentProcess>()
  return { ...actual, queryProcessCommandLine: () => ({ status: 'found', commandLine: identity.commandLine }) }
})

vi.mock('../src/install_index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallIndexModule>()
  return { ...actual, queueInstallIndex: (...args: Parameters<typeof actual.queueInstallIndex>) => (queueMock.override !== undefined ? queueMock.override() : actual.queueInstallIndex(...args)) }
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A database with an intact 16-byte header and unreadable pages behind it. PROVENANCE: CAPTURE of the original defect, 2026-10-03, built bundle on an isolated home: a global.db with one byte in seven overwritten from offset 100 printed "Database: global.db exists (304 KB)" under `doctor`, while `symbol` and `reclaim-index` failed with "database disk image is malformed". The corruption below repeats that overwrite on a database created by getDb; the expected statuses come from the issue statement, not from checkDbExists. */
function corruptPages(file: string): void {
  const bytes = fs.readFileSync(file)
  for (let i = 100; i < bytes.length; i += 7) bytes[i] = 0xa5
  fs.writeFileSync(file, bytes)
}

describe('doctor with a global.db whose header is intact but whose pages are malformed', () => {
  let home: string
  let root: string
  let dbFile: string
  let corrupted: Buffer

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-malformed-home-'))
    root = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-doctor-malformed-root-'))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.stubEnv('TOKEN_GOAT_HOME', home)
    vi.stubEnv('LOCALAPPDATA', home)
    vi.stubEnv('XDG_DATA_HOME', home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
    vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
    vi.stubEnv('TOKEN_GOAT_EMBEDDINGS_ENABLED', '0')
    _resetDataDirCacheForTesting()
    seedUpdateCheck()
    dbFile = globalDbPath()
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    getDb(dbFile).prepare('INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?, ?, ?, ?)').run(
      'large.ts',
      1,
      10,
      'x'.repeat(2 * 1024 * 1024),
    )
    closeAllDbs()
    corruptPages(dbFile)
    corrupted = fs.readFileSync(dbFile)
    queueMock.override = undefined
    renameMock.failFor = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeAllDbs()
    clearUpdateCheck()
    vi.unstubAllEnvs()
    _resetDataDirCacheForTesting()
    invalidateConfigCache()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('uses a bounded smoke check for fast or over-cap databases and a full check otherwise', () => {
    expect(checkDbIntegrity(dbFile, { fast: true }).mode).toBe('smoke')
    expect(checkDbIntegrity(dbFile, { sizeBytes: MAX_FULL_SCAN_BYTES + 1 }).mode).toBe('smoke')
    expect(checkDbIntegrity(dbFile, { sizeBytes: MAX_FULL_SCAN_BYTES }).mode).toBe('full')
    expect(checkDbIntegrity(dbFile).mode).toBe('full')
  })

  it('smokeCheckDb detects page corruption behind a valid SQLite header', () => {
    expect(smokeCheckDb(dbFile)).toMatchObject({ ok: false, corrupt: true })
    expect(quickCheckDb(dbFile)).toMatchObject({ ok: false, corrupt: true })
  })

  it('classifies lock errors as transient and only recognizes confirmed SQLite corruption', () => {
    expect(isSqliteCorruptionDetail('database is locked')).toBe(false)
    expect(isSqliteCorruptionDetail('database disk image is malformed')).toBe(true)
    expect(isSqliteCorruptionError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))).toBe(false)
    expect(isSqliteCorruptionError(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }))).toBe(true)
    expect(isSqliteCorruptionError(Object.assign(new Error('corrupt virtual table'), { code: 'SQLITE_CORRUPT_VTAB' }))).toBe(true)
    expect(isSqliteCorruptionError(Object.assign(new Error('corrupt index'), { code: 'SQLITE_CORRUPT_INDEX' }))).toBe(true)
    expect(isSqliteCorruptionError(Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR' }))).toBe(true)
    expect(isSqliteCorruptionError(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_ERROR' }))).toBe(false)
    expect(isSqliteCorruptionError(Object.assign(new Error('no such table: corrupted_cache'), { code: 'ERR_SQLITE_ERROR' }))).toBe(false)
    expect(isSqliteCorruptionError(Object.assign(new Error('no such table: corrupted_cache'), { code: 'SQLITE_ERROR' }))).toBe(false)
  })

  it.each(['ENOENT', 'EACCES', 'EPERM', 'EBUSY'] as const)('handles statSync failures with %s without throwing', (code) => {
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw Object.assign(new Error(`simulated ${code}`), { code })
    })
    let row: ReturnType<typeof checkDbExists> | undefined
    expect(() => {
      row = checkDbExists(path.dirname(dbFile), undefined, root)
    }).not.toThrow()
    expect(row?.name).toBe('Database')
    expect(row?.status).toBe('warn')
    expect(row?.message).toContain(dbFile)
    expect(row?.message).toContain(code === 'ENOENT' ? 'global.db not found' : 'could not be inspected')
  })

  it('the Database check fails instead of reporting a healthy file', () => {
    expect(corrupted.toString('latin1', 0, 15)).toBe('SQLite format 3')
    const row = checkDbExists(path.dirname(dbFile))
    expect(row.status).toBe('fail')
    expect(row.message).toContain('malformed')
    expect(row.message).toContain('doctor --repair')
  })

  it('--repair leaves an unstatable database untouched', async () => {
    const originalStatSync = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((filePath: fs.PathLike) => {
      if (path.resolve(String(filePath)) === dbFile) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return originalStatSync(filePath)
    }) as typeof fs.statSync)

    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })

    expect(result.errors.join('\n')).toContain(`Could not inspect global.db at ${dbFile}`)
    expect(fs.existsSync(dbFile)).toBe(true)
    expect(fs.readdirSync(path.dirname(dbFile)).some((file) => file.endsWith('.malformed'))).toBe(false)
  })

  it('--repair leaves a database alone when it vanishes during header inspection', async () => {
    const originalOpenSync = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((filePath: fs.PathLike, flags: string | number, mode?: number) => {
      if (path.resolve(String(filePath)) === dbFile) {
        throw Object.assign(new Error('file vanished'), { code: 'ENOENT' })
      }
      return originalOpenSync(filePath, flags, mode)
    }) as typeof fs.openSync)

    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })

    expect(result.errors.join('\n')).not.toContain('global.db')
    expect(result.repairs.some((repair) => repair.includes('Moved the malformed global.db'))).toBe(false)
    expect(fs.existsSync(dbFile)).toBe(true)
    expect(fs.readdirSync(path.dirname(dbFile)).some((file) => file.endsWith('.malformed'))).toBe(false)
  })

  it('--repair moves the file aside byte for byte, builds a fresh database, and never claims a queue that did not happen', async () => {
    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })
    const moved = fs.readdirSync(path.dirname(dbFile)).filter((f) => f.startsWith('global.db.') && f.endsWith('.malformed'))
    expect(moved).toHaveLength(1)
    expect(fs.readFileSync(path.join(path.dirname(dbFile), moved[0] as string)).equals(corrupted)).toBe(true)
    expect(quickCheckDb(dbFile)).toEqual({ ok: true })
    expect(checkDbExists(path.dirname(dbFile)).status).toBe('ok')
    expect(result.repairs.some((r) => r.includes('Moved the malformed global.db aside'))).toBe(true)
    // The suite's setup turns the install index off, so nothing was queued and no line may say it was.
    expect(result.repairs.some((r) => /Queued/.test(r))).toBe(false)
    expect(result.notices.join('\n')).toContain('token-goat index')
  })

  it('quarantines a malformed database before attempting automatic embedding reclaim', async () => {
    vi.stubEnv('TOKEN_GOAT_INDEXING_AUTO_RECLAIM_EMBEDDINGS', 'true')
    vi.stubEnv('TOKEN_GOAT_INDEXING_MAX_DB_SIZE_MB', '1')
    invalidateConfigCache()
    const reclaimSpy = vi.spyOn(indexReclaimModule, 'reclaimIndex')

    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })

    expect(reclaimSpy).not.toHaveBeenCalled()
    expect(result.repairs.some((r) => r.includes('Moved the malformed global.db aside'))).toBe(true)
  })

  it('quarantines corruption discovered by reclaim after an oversized smoke check', async () => {
    vi.stubEnv('TOKEN_GOAT_INDEXING_AUTO_RECLAIM_EMBEDDINGS', 'true')
    vi.stubEnv('TOKEN_GOAT_INDEXING_MAX_DB_SIZE_MB', '1')
    invalidateConfigCache()
    closeAllDbs()
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true })

    const db = getDb(dbFile)
    const pageSize = db.pragma('page_size', { simple: true }) as number
    const initialPageCount = db.pragma('page_count', { simple: true }) as number
    db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?, ?, ?, ?)').run(
      'large.ts',
      1,
      10,
      'x'.repeat(2 * 1024 * 1024),
    )
    const pageCount = db.pragma('page_count', { simple: true }) as number
    closeAllDbs()
    expect(checkDbIntegrity(dbFile, { sizeBytes: fs.statSync(dbFile).size, maxFullScanBytes: 1 })).toEqual({
      ok: true,
      mode: 'smoke',
    })

    const damagedPage = Math.floor((initialPageCount + pageCount) / 2)
    const reclaim = indexReclaimModule.reclaimIndex
    const reclaimSpy = vi.spyOn(indexReclaimModule, 'reclaimIndex').mockImplementation((target, opts) => {
      const bytes = fs.readFileSync(target)
      bytes.writeUInt32BE(pageCount + 1, (damagedPage - 1) * pageSize)
      fs.writeFileSync(target, bytes)
      return reclaim(target, opts)
    })
    try {
      const result = await runDoctorRepair({
        dataDir: path.dirname(dbFile),
        rootDir: root,
        maxFullScanBytes: 1,
      })

      expect(reclaimSpy).toHaveBeenCalledTimes(1)
      expect(result.repairs.some((repair) => repair.includes('Moved the malformed global.db aside'))).toBe(true)
      closeAllDbs()
      expect(fs.existsSync(dbFile)).toBe(true)
      expect(quickCheckDb(dbFile).ok).toBe(true)
      expect(
        fs.readdirSync(path.dirname(dbFile)).some((name) => name.startsWith('global.db.') && name.endsWith('.malformed')),
      ).toBe(true)
    } finally {
      reclaimSpy.mockRestore()
      closeAllDbs()
    }
  })

  it('reuses a healthy repair integrity result instead of running quick_check twice', async () => {
    closeAllDbs()
    fs.rmSync(dbFile, { force: true })
    getDb(dbFile)
    closeAllDbs()
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma')

    try {
      await runDoctorAndExit({
        dataDir: path.dirname(dbFile),
        rootDir: root,
        repair: true,
        processes: [],
      })

      const quickChecks = pragmaSpy.mock.calls.filter(([statement]) => statement === 'quick_check')
      expect(quickChecks).toHaveLength(1)
    } finally {
      pragmaSpy.mockRestore()
    }
  })

  it('reports a failed queue as an error with its reason, not as a repair', async () => {
    queueMock.override = () => ({ status: 'failed', error: 'database disk image is malformed' })
    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })
    expect(result.repairs.some((r) => /Queued/.test(r))).toBe(false)
    expect(result.errors.join('\n')).toContain('database disk image is malformed')
    expect(result.errors.join('\n')).toContain('token-goat index')
  })

  it('names the manual recovery when the file cannot be moved', async () => {
    renameMock.failFor = 'global.db'
    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })
    expect(result.errors.join('\n')).toContain('could not be moved aside (EBUSY')
    expect(result.errors.join('\n')).toContain('token-goat index')
    expect(result.repairs.some((r) => /Queued|Moved the malformed/.test(r))).toBe(false)
    expect(fs.readFileSync(dbFile).equals(corrupted)).toBe(true)
  })

  // HAND-DERIVED: kill(2) documents EPERM as the error for a signal the caller may not send to a process that exists; the worker is planted by tests/helpers/denied_worker.ts.
  it('--repair leaves the file in place and says the worker is left running when the stop is denied', async () => {
    identity.commandLine = workerCommandLine(daemonEntryScript())
    const undo = plantDeniedWorker(path.dirname(dbFile))
    try {
      const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })
      expect(result.errors.join('\n'), 'the repair did not say the denied worker kept running').toContain(workerLeftRunningNote(DENIED_WORKER_PID))
      expect(result.repairs.some((r) => /Moved the malformed/.test(r)), 'the repair claimed to move a database a live worker holds').toBe(false)
      expect(fs.readFileSync(dbFile).equals(corrupted), 'the database was moved or changed under a live worker').toBe(true)
      expect(fs.readdirSync(path.dirname(dbFile)).filter((f) => f.endsWith('.malformed'))).toEqual([])
      expect(fs.existsSync(workerPidPath(path.dirname(dbFile))), 'the pid file of a worker left running was removed').toBe(true)
    } finally {
      undo()
    }
  })

  // CAPTURE: round 12 dogfood of the built bundle on an isolated home: plain `doctor` on a 0-byte global.db turned it into a valid 303,104-byte database, because SQLite opens a zero-length file as an empty one. There is nothing in it to recover, so the repair must not move it aside as malformed.
  it('--repair leaves a 0-byte global.db for its first open instead of quarantining it', async () => {
    fs.writeFileSync(dbFile, '')
    expect(checkDbExists(path.dirname(dbFile)).status).toBe('warn')
    const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })
    expect(result.errors).toEqual([])
    expect(result.repairs.some((r) => r.includes('Moved the malformed global.db'))).toBe(false)
    expect(fs.readdirSync(path.dirname(dbFile)).filter((f) => f.endsWith('.malformed'))).toEqual([])
    getDb(dbFile)
    closeAllDbs()
    expect(quickCheckDb(dbFile)).toEqual({ ok: true })
    expect(checkDbExists(path.dirname(dbFile)).status).toBe('ok')
  })

  it('leaves a healthy database untouched when integrity probes hit a transient lock', async () => {
    closeAllDbs()
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true })
    getDb(dbFile).prepare('INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?, ?, ?, ?)').run(
      'large.ts',
      1,
      10,
      'x'.repeat(2 * 1024 * 1024),
    )
    closeAllDbs()
    const original = fs.readFileSync(dbFile)
    const locked = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    const originalPragma = Database.prototype.pragma
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: InstanceType<typeof Database>,
      statement: string,
      options?: { simple?: boolean },
    ) {
      if (statement === 'quick_check' || statement === 'freelist_count') throw locked
      return originalPragma.call(this, statement, options)
    })
    try {
      vi.stubEnv('TOKEN_GOAT_INDEXING_AUTO_RECLAIM_EMBEDDINGS', 'true')
      vi.stubEnv('TOKEN_GOAT_INDEXING_MAX_DB_SIZE_MB', '1')
      invalidateConfigCache()
      queueMock.override = () => ({ status: 'skipped' })

      expect(quickCheckDb(dbFile)).toEqual({ ok: false, detail: 'database is locked', corrupt: false })
      expect(smokeCheckDb(dbFile)).toEqual({ ok: false, detail: 'database is locked', corrupt: false })

      const row = checkDbExists(path.dirname(dbFile), undefined, root, { fast: true })
      expect(row.status).toBe('warn')
      expect(row.message).toBe(
        `${dbFile} integrity probe could not complete (database is locked) — database may be busy; retry when indexing settles`,
      )

      const reclaimSpy = vi.spyOn(indexReclaimModule, 'reclaimIndex')
      try {
        const result = await runDoctorRepair({ dataDir: path.dirname(dbFile), rootDir: root })
        expect(result.checkedIntegrity).toEqual({
          ok: false,
          detail: 'database is locked',
          corrupt: false,
          mode: 'full',
        })
        expect(result.errors.join('\n')).toContain(
          `Database integrity probe could not complete (database is locked) — left ${dbFile} untouched`,
        )
        expect(reclaimSpy).not.toHaveBeenCalled()
        expect(fs.readFileSync(dbFile).equals(original)).toBe(true)
        expect(fs.readdirSync(path.dirname(dbFile)).filter((name) => name.endsWith('.malformed'))).toEqual([])
      } finally {
        reclaimSpy.mockRestore()
      }
    } finally {
      pragmaSpy.mockRestore()
    }
  })
})
