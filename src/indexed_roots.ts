/** Which projects were indexed on purpose: by `token-goat index`, or by the first index `install` queues. Session start's indexed reminder and its drift sweep both key on this, and so does install's "already indexed" skip. Symbols in the index cannot answer it, because the edit hook and the worker index single files in a project nobody indexed: one edited file made the whole repository read as indexed, and the drift sweep then queued every other tracked file as "changed outside this session". */

import * as path from 'node:path'

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { canonicalize } from './path_containment.js'
import { findProject } from './project.js'
import { pathEqClause } from './sql_path.js'
import { foldPath, normalizePath } from './util.js'

/** The root a marker is filed under: the project `dir` belongs to, spelled as known_roots spells it, or `dir` itself for a folder with no project marker (a non-git folder indexed with `--walk`). */
function indexedRootOf(dir: string): string | null {
  const project = findProject(dir)
  if (project !== null) return normalizePath(project.root)
  try {
    return normalizePath(canonicalize(path.resolve(dir)))
  } catch {
    return null
  }
}

/** Record that the project containing `dir` was indexed on purpose. Never throws: the indexing it records has already happened, and a marker that failed to write costs only the indexed reminder. */
export function recordIndexedRoot(dir: string, dbPath: string = globalDbPath()): void {
  try {
    const root = indexedRootOf(dir)
    if (root === null) return
    getDb(dbPath).prepare('INSERT INTO indexed_roots (root, indexed_ms) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET indexed_ms = excluded.indexed_ms').run(root, Date.now())
  } catch {
    // best-effort, see above
  }
}

/** True when the project containing `dir` was indexed on purpose (see {@link recordIndexedRoot}). False on any failure, which reads as "not indexed": the generic reminder and no drift sweep. */
export function isIndexedRoot(dir: string | undefined, dbPath: string = globalDbPath()): boolean {
  if (dir === undefined) return false
  try {
    const root = indexedRootOf(dir)
    if (root === null) return false
    return getDb(dbPath).prepare(`SELECT 1 FROM indexed_roots WHERE ${pathEqClause('root')} LIMIT 1`).get(foldPath(root)) !== undefined
  } catch {
    return false
  }
}
