/** The pre-read navigation probe behind the first-read symbol policy. It lives apart from index_reader.ts because that module is an embed-fingerprint source: a tweak to this probe, which only a hook reads, would otherwise re-embed every user's corpus on upgrade. */

import * as fs from 'node:fs'
import { withProbeIndex } from './db.js'
import { fingerprintFile } from './fingerprint.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { hostPathOfIndexKey } from './paths.js'
import { fileRowByIndexKey, filePathSpellingsClause } from './sql_path.js'

export interface NavigationSymbol {
  readonly name: string
  readonly kind: string
  readonly lineStart: number
  readonly lineEnd: number
}

export interface NavigationEvidence {
  readonly filePath: string
  readonly symbolCount: number
  readonly headingCount: number
  readonly topSymbols: readonly NavigationSymbol[]
  readonly topHeadings: readonly NavigationSymbol[]
  readonly indexedMtime: number
  readonly isStale: boolean
}

interface NavigationRow {
  readonly name: string
  readonly kind: string
  readonly line_start: number
  readonly line_end: number
  readonly total: number
  readonly headings: number | null
}

/** Rows read per probe, and how many of each kind the evidence keeps. */
const PROBE_ROWS = 60
const KEPT_PER_KIND = 8

/** Is the indexed copy of `onDisk` out of date? files.mtime is seconds (parser.ts safeMtime) and stat.mtimeMs milliseconds, so the unit is converted here, as reconcile.ts does. An unchanged mtime is fresh; a moved one is only a suspicion, settled by the content fingerprint the read commands' staleWarning compares, because a checkout rewrites mtimes over unchanged bytes. When the bytes match, the path goes on the dirty queue: the worker re-stamps the row's mtime, so the next read pays one stat rather than a hash of the whole file, and the hook itself writes nothing to the database. */
function indexedCopyIsStale(filePath: string, row: { mtime?: number | null; sha?: string | null }): boolean {
  try {
    const onDisk = hostPathOfIndexKey(filePath)
    if (fs.statSync(onDisk).mtimeMs / 1000 === row.mtime) return false
    if (!row.sha || fingerprintFile(onDisk) !== row.sha) return true
    enqueueDirtyPathSafe(onDisk)
    return false
  } catch {
    // The file may be removed or inaccessible.
    return true
  }
}

/** Fast, fail-open navigation probe for pre-read tool interception. Uses a non-blocking read-only connection without schema migrations or lock contention. Returns null if the file is not indexed or has no symbols/headings. */
export function getReadNavigationEvidence(filePath: string, dbPath?: string): NavigationEvidence | null {
  return withProbeIndex((db) => {
    const fileRow = fileRowByIndexKey<{ path: string; mtime?: number | null; sha?: string | null }>(db, filePath, 'path, mtime, sha')
    if (!fileRow) return null
    const isStale = indexedCopyIsStale(filePath, fileRow)

    // One statement, so the rows and the totals come from one snapshot: a worker commit between a row query and a separate COUNT could make them disagree.
    const spellings = filePathSpellingsClause('file_path', fileRow.path)
    const rows = db
      .prepare(
        `SELECT name, kind, line_start, line_end, COUNT(*) OVER () AS total, SUM(CASE WHEN kind = 'heading' THEN 1 ELSE 0 END) OVER () AS headings FROM symbols WHERE ${spellings.clause} ORDER BY line_start ASC, rowid LIMIT ${PROBE_ROWS}`,
      )
      .all(...spellings.params) as NavigationRow[]
    const first = rows[0]
    if (first === undefined) return null

    const headingCount = Number(first.headings ?? 0)
    const topSymbols: NavigationSymbol[] = []
    const topHeadings: NavigationSymbol[] = []
    for (const r of rows) {
      const item: NavigationSymbol = { name: r.name, kind: r.kind, lineStart: r.line_start, lineEnd: r.line_end }
      const kept = r.kind === 'heading' ? topHeadings : topSymbols
      if (kept.length < KEPT_PER_KIND) kept.push(item)
    }

    return {
      filePath: fileRow.path,
      symbolCount: Math.max(0, first.total - headingCount),
      headingCount,
      topSymbols,
      topHeadings,
      indexedMtime: fileRow.mtime ?? 0,
      isStale,
    }
  }, dbPath)
}
