/** Integrity probe and quarantine for the global index database. A file whose 16-byte header is intact can still hold pages SQLite cannot read, and every query then fails with "database disk image is malformed" while the header-only check in doctor reported it healthy. */

import * as fs from 'node:fs'

import { closeDb, getDb } from './db.js'
import Database from './sqlite_driver.js'
import { extractErrorMessage } from './util.js'
import { isWorkerRunning, stopWorker } from './worker_lifecycle.js'

export type QuickCheckResult = { ok: true } | { ok: false; detail: string }

export type QuarantineResult = { status: 'quarantined'; quarantinePath: string } | { status: 'failed'; error: string }

/** Run `PRAGMA quick_check` on `dbPath` through a read-only connection, so the probe never writes to a file it suspects is damaged. An open or read failure is itself a verdict: the file is unusable. */
export function quickCheckDb(dbPath: string): QuickCheckResult {
  let conn: InstanceType<typeof Database> | undefined
  try {
    conn = new Database(dbPath, { readonly: true, fileMustExist: true })
    conn.pragma('busy_timeout = 15000')
    const rows = conn.pragma('quick_check') as Array<Record<string, unknown>>
    const messages = rows.map((row) => String(Object.values(row)[0]))
    if (messages.length === 1 && messages[0] === 'ok') return { ok: true }
    return { ok: false, detail: messages.slice(0, 3).join('; ') }
  } catch (e) {
    return { ok: false, detail: extractErrorMessage(e) }
  } finally {
    try {
      conn?.close()
    } catch {
      // Best-effort: the verdict above is what the caller acts on.
    }
  }
}

/** Move the damaged database and its WAL and shared-memory siblings to timestamped `.malformed` names beside it, never deleting them: the user may still want to recover rows with the sqlite3 shell. The sibling files must move together, because a stale WAL left beside a fresh database would be replayed into it. */
export function quarantineMalformedDb(dbPath: string, dataDir: string, now: Date = new Date()): QuarantineResult {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const quarantinePath = `${dbPath}.${stamp}.malformed`
  try {
    closeDb(dbPath)
    // An open handle pins the file on Windows, and on POSIX a live worker would keep writing to the inode that was just renamed away.
    if (isWorkerRunning(dataDir)) stopWorker(dataDir)
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
export function hasSqliteHeader(dbPath: string): boolean {
  try {
    const fd = fs.openSync(dbPath, 'r')
    try {
      const buf = Buffer.alloc(16)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      return bytesRead === 16 && buf.toString('latin1') === 'SQLite format 3\0'
    } finally {
      fs.closeSync(fd)
    }
  } catch {
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
