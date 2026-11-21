/** The optional sqlite-vec extension must load through the production driver (src/sqlite_driver.ts) and create a vec0 table; any failure exits non-zero so CI and the WSL pre-push leg fail rather than letting the semantic tests skip. */
try {
  const { default: Database } = await import('../src/sqlite_driver.ts')
  const sqliteVec = await import('sqlite-vec')
  const db = new Database(':memory:')
  sqliteVec.load(db)
  db.exec('CREATE VIRTUAL TABLE probe USING vec0(embedding float[384])')
  console.log('vec0', db.prepare('SELECT vec_version() AS v').get().v)
  db.close()
} catch (err) {
  console.error('vec0 check failed: sqlite-vec did not load or could not create a vec0 table (pre-push: TG_PREPUSH_WSL=0 skips the Linux leg)')
  console.error(err)
  process.exitCode = 1
}
