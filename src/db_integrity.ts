/** Integrity probe and quarantine for the global index database. A file whose 16-byte header is intact can still hold pages SQLite cannot read, and every query then fails with "database disk image is malformed" while the header-only check in doctor reported it healthy. */

import * as fs from 'node:fs'

import { closeDb, getDb } from './db.js'
import Database from './sqlite_driver.js'
import { extractErrorMessage } from './util.js'
import { isWorkerRunning, stopWorkerDetailed, workerLeftRunningNote } from './worker_lifecycle.js'

export type QuickCheckResult = { ok: true } | { ok: false; detail: string; corrupt: boolean }

export const MAX_FULL_SCAN_BYTES = 512 * 1024 * 1024

export type IntegrityCheckMode = 'full' | 'smoke'
export type IntegrityCheckResult = QuickCheckResult & { mode: IntegrityCheckMode }

export type QuarantineResult = { status: 'quarantined'; quarantinePath: string } | { status: 'failed'; error: string }

const SQLITE_CORRUPTION_DETAIL =
  /(?:database disk image is malformed|malformed database schema|file is not a database|file is encrypted or is not a database|invalid rootpage|btreeInitPage)/i

export function isSqliteCorruptionDetail(detail: string): boolean {
  return SQLITE_CORRUPTION_DETAIL.test(detail)
}

export function isSqliteCorruptionError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '').toUpperCase()
      : ''
  return (
    code === 'SQLITE_CORRUPT' ||
    code.startsWith('SQLITE_CORRUPT_') ||
    code === 'SQLITE_NOTADB' ||
    code.startsWith('SQLITE_NOTADB_') ||
    (code === 'ERR_SQLITE_ERROR' && isSqliteCorruptionDetail(extractErrorMessage(error)))
  )
}

export function resolveMaxFullScanBytes(override?: number): number {
  return typeof override === 'number' && Number.isFinite(override) && override >= 0 ? override : MAX_FULL_SCAN_BYTES
}

/** Run `PRAGMA quick_check` on `dbPath` through a read-only connection, so the probe never writes to a file it suspects is damaged. An open or read failure is not proof of corruption: a lock or I/O error must not trigger quarantine. */
export function quickCheckDb(dbPath: string): QuickCheckResult {
  let conn: InstanceType<typeof Database> | undefined
  try {
    conn = new Database(dbPath, { readonly: true, fileMustExist: true })
    conn.pragma('busy_timeout = 15000')
    const rows = conn.pragma('quick_check') as Array<Record<string, unknown>>
    const messages = rows.map((row) => String(Object.values(row)[0]))
    if (messages.length === 1 && messages[0] === 'ok') return { ok: true }
    return { ok: false, detail: messages.slice(0, 3).join('; '), corrupt: true }
  } catch (e) {
    return { ok: false, detail: extractErrorMessage(e), corrupt: isSqliteCorruptionError(e) }
  } finally {
    try {
      conn?.close()
    } catch {
      // Best-effort: the verdict above is what the caller acts on.
    }
  }
}

/** Check representative rows without walking every page of a large index. */
export function smokeCheckDb(dbPath: string): QuickCheckResult {
  let ro: InstanceType<typeof Database> | undefined
  try {
    ro = new Database(dbPath, { readonly: true, fileMustExist: true })
    ro.pragma('busy_timeout = 3000')
    ro.pragma('freelist_count', { simple: true })
    const masterRows = ro.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    const tables = new Set(masterRows.map((row) => row.name))
    const tablesToProbe = ['files', 'symbols', 'refs', 'chunks', 'stats'] as const
    const probes: Record<(typeof tablesToProbe)[number], [string, string]> = {
      files: ['SELECT 1 FROM "files" LIMIT 1', 'SELECT 1 FROM "files" ORDER BY rowid DESC LIMIT 1'],
      symbols: ['SELECT 1 FROM "symbols" LIMIT 1', 'SELECT 1 FROM "symbols" ORDER BY rowid DESC LIMIT 1'],
      refs: ['SELECT 1 FROM "refs" LIMIT 1', 'SELECT 1 FROM "refs" ORDER BY rowid DESC LIMIT 1'],
      chunks: ['SELECT 1 FROM "chunks" LIMIT 1', 'SELECT 1 FROM "chunks" ORDER BY rowid DESC LIMIT 1'],
      stats: ['SELECT 1 FROM "stats" LIMIT 1', 'SELECT 1 FROM "stats" ORDER BY rowid DESC LIMIT 1'],
    }
    for (const tbl of tablesToProbe) {
      if (!tables.has(tbl)) continue
      const [firstQuery, lastQuery] = probes[tbl]
      ro.prepare(firstQuery).get()
      ro.prepare(lastQuery).get()
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: extractErrorMessage(e), corrupt: isSqliteCorruptionError(e) }
  } finally {
    try {
      ro?.close()
    } catch {
      // Best-effort: the verdict above is what the caller acts on.
    }
  }
}

/** Bound integrity work on large or explicitly fast doctor runs. */
export function checkDbIntegrity(
  dbPath: string,
  opts?: { fast?: boolean; sizeBytes?: number; maxFullScanBytes?: number },
): IntegrityCheckResult {
  const sizeBytes = opts?.sizeBytes ?? fs.statSync(dbPath).size
  const cap = resolveMaxFullScanBytes(opts?.maxFullScanBytes)
  if (opts?.fast || sizeBytes > cap) return { ...smokeCheckDb(dbPath), mode: 'smoke' }
  return { ...quickCheckDb(dbPath), mode: 'full' }
}

/** Move the damaged database and its WAL and shared-memory siblings to timestamped `.malformed` names beside it, never deleting them: the user may still want to recover rows with the sqlite3 shell. The sibling files must move together, because a stale WAL left beside a fresh database would be replayed into it. */
export function quarantineMalformedDb(dbPath: string, dataDir: string, now: Date = new Date()): QuarantineResult {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const quarantinePath = `${dbPath}.${stamp}.malformed`
  try {
    closeDb(dbPath)
    // An open handle pins the file on Windows, and on POSIX a live worker would keep writing to the inode that was just renamed away.
    if (isWorkerRunning(dataDir)) {
      const { leftRunning } = stopWorkerDetailed(dataDir)
      // The worker the stop was denied still holds the database, so moving it aside would rename a file in use (or let the worker keep writing to the renamed inode); the caller reports the failure like any other that left the file in place.
      if (leftRunning !== null) return { status: 'failed', error: workerLeftRunningNote(leftRunning) }
    }
    fs.renameSync(dbPath, quarantinePath)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, `${quarantinePath}${suffix}`)
    }
    return { status: 'quarantined', quarantinePath }
  } catch (e) {
    return { status: 'failed', error: extractErrorMessage(e) }
  }
}

/** Create an empty database with the current schema at `dbPath` and release the handle. */
export function recreateDb(dbPath: string): void {
  getDb(dbPath)
  closeDb(dbPath)
}

/** True when the first 16 bytes of `dbPath` are the SQLite magic string: the file is a database whose pages are the open question, rather than a file that was never one. */
export function hasSqliteHeader(dbPath: string, onError?: (error: unknown) => void): boolean {
  try {
    const fd = fs.openSync(dbPath, 'r')
    try {
      const buf = Buffer.alloc(16)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      return bytesRead === 16 && buf.toString('latin1') === 'SQLite format 3\0'
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    onError?.(error)
    return false
  }
}

/** True when `dbPath` is a zero-length file. SQLite opens one as a new, empty database and the next getDb writes the schema into it, so it holds nothing to recover and is not damage: doctor reports it as empty rather than failed, and the repair leaves it for that first open instead of moving it aside. */
export function isZeroLengthDb(dbPath: string): boolean {
  try {
    return fs.statSync(dbPath).size === 0
  } catch {
    return false
  }
}
