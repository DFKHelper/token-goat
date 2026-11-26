/** The optional sqlite-vec extension must load through the production driver (src/sqlite_driver.ts) and create a vec0 table; any failure exits non-zero so CI and the WSL pre-push leg fail rather than letting the semantic tests skip. */
import { createRequire } from 'node:module'

try {
  const { default: Database } = await import('../src/sqlite_driver.ts')
  // The CJS entry src/db.ts loadSqliteVec requires, so a broken CJS entry fails here too.
  const sqliteVec = createRequire(import.meta.url)('sqlite-vec')
  const db = new Database(':memory:')
  try {
    sqliteVec.load(db)
    db.exec('CREATE VIRTUAL TABLE probe USING vec0(embedding float[384])')
    console.log('vec0', db.prepare('SELECT vec_version() AS v').get().v)
  } finally {
    db.close()
  }
} catch (err) {
  // CI runs have no pre-push leg to skip, so the opt-out hint is for local pushes only.
  const ciSet = process.env.CI === 'true' // same strict rule as isCiRun in tests/setup/ci-run.ts
  const hint = ciSet ? '' : ' (pre-push: TG_PREPUSH_WSL=0 skips the Linux leg)'
  console.error(`vec0 check failed: sqlite-vec did not load or could not create a vec0 table${hint}`)
  console.error(err)
  process.exitCode = 1
}
