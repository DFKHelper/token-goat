import Database from '../../src/sqlite_driver.js'

/** Write a real SQLite file at `dbPath` holding at least `minBytes` of payload: doctor runs PRAGMA quick_check, so a fake header followed by padding now fails as malformed. */
export function writeRealDb(dbPath: string, minBytes = 0): void {
  const db = new Database(dbPath)
  try {
    db.exec('CREATE TABLE t(b)')
    if (minBytes > 0) db.prepare('INSERT INTO t VALUES (zeroblob(?))').run(minBytes)
  } finally {
    db.close()
  }
}
