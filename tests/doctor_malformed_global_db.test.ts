import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsModule from 'node:fs'
import type * as InstallIndexModule from '../src/install_index.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runDoctorRepair } from '../src/cli_doctor.js'
import { checkDbExists } from '../src/cli_doctor_index.js'
import { _resetDataDirCacheForTesting, globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { quickCheckDb } from '../src/db_integrity.js'
import { clearUpdateCheck, seedUpdateCheck } from './helpers/update-check.js'

const queueMock = vi.hoisted(() => ({ override: undefined as undefined | (() => unknown) }))
const renameMock = vi.hoisted(() => ({ failFor: undefined as undefined | string }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (renameMock.failFor !== undefined && String(from).endsWith(renameMock.failFor)) throw new Error('EBUSY: resource busy or locked')
    actual.renameSync(from, to)
  }
  return { ...actual, renameSync, default: { ...actual, renameSync } }
})

vi.mock('../src/install_index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallIndexModule>()
  return { ...actual, queueInstallIndex: (...args: Parameters<typeof actual.queueInstallIndex>) => (queueMock.override !== undefined ? queueMock.override() : actual.queueInstallIndex(...args)) }
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
    getDb(dbFile)
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
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('the Database check fails instead of reporting a healthy file', () => {
    expect(corrupted.toString('latin1', 0, 15)).toBe('SQLite format 3')
    const row = checkDbExists(path.dirname(dbFile))
    expect(row.status).toBe('fail')
    expect(row.message).toContain('malformed')
    expect(row.message).toContain('doctor --repair')
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
})
