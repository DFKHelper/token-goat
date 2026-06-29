import * as fs from 'node:fs'

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { deleteFileEmbeddings } from './embeddings.js'
import { deleteFileRows } from './parser.js'

type DbHandle = ReturnType<typeof getDb>

// Remove every indexed row (symbols, refs, files) and embedding chunk for one file. Shared primitive the full reindex prune and any future vanished-file reconciliation both build on.
export function removeFileFromIndex(db: DbHandle, filePath: string): void {
  deleteFileRows(db, filePath)
  deleteFileEmbeddings(db, filePath)
}

// A drive root (`c:/`) or empty prefix would scope the prune to an entire drive across every project in the shared global DB; refuse it so a malformed root can never mass-delete another project's rows.
function isTooShallowToPrune(rootPrefix: string): boolean {
  const segments = rootPrefix.split('/').filter((s) => s.length > 0 && !/^[a-z]:$/i.test(s))
  return segments.length === 0
}

// Remove index rows for files under rootPrefix that no longer exist on disk. Scoped by absolute-path prefix so the shared global DB never prunes another project's rows, and keeps every file still present on disk. Returns the count pruned.
export function pruneDeletedFiles(rootPrefix: string, dbPath: string = globalDbPath()): number {
  if (isTooShallowToPrune(rootPrefix)) return 0
  const db = getDb(dbPath)
  const prefix = rootPrefix.endsWith('/') ? rootPrefix : `${rootPrefix}/`
  const rows = db.prepare('SELECT DISTINCT path FROM files').all() as Array<{ path: string }>
  let pruned = 0
  for (const { path: p } of rows) {
    if (p !== rootPrefix && !p.startsWith(prefix)) continue
    if (fs.existsSync(p)) continue
    try {
      removeFileFromIndex(db, p)
      pruned += 1
    } catch {
      // Best-effort: one file's delete failure must not abort pruning the rest.
    }
  }
  return pruned
}
