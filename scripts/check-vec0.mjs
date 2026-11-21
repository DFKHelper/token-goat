/** The optional sqlite-vec extension must load into node:sqlite and create a vec0 table; any failure exits non-zero so CI and the WSL pre-push leg fail rather than letting the semantic tests skip. */
try {
  const { DatabaseSync } = await import('node:sqlite')
  const sqliteVec = await import('sqlite-vec')
  const db = new DatabaseSync(':memory:', { allowExtension: true })
  sqliteVec.load(db)
  db.exec('CREATE VIRTUAL TABLE probe USING vec0(embedding float[384])')
  console.log('vec0', db.prepare('SELECT vec_version() AS v').get().v)
} catch (err) {
  console.error('vec0 check failed: sqlite-vec did not load or could not create a vec0 table')
  console.error(err)
  process.exitCode = 1
}
