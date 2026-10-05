/** The paths a compaction summary left out, kept beside the session so the resume packet can name them. postCompactHandler already checks which of the paths the manifest printed reappear in the summary Claude Code wrote, but until now it only counted them for the stats ledger. The model coming out of the compaction learns nothing from a count: the files the summary forgot are the ones it will re-read blind or not know to look at. PostCompact fires before SessionStart(compact), so the list written here is on disk by the time postCompactRecovery builds the resume packet for that same compaction. One file per state key, rewritten by every compaction that carries a summary, and removed by one that carries none (Codex CLI's post-compact input has no summary field), so a list from an earlier compaction is never presented as this one's. */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionSidecarPath } from './session_store.js'
import { ensureDirSync } from './util.js'

// Not `.json`: sessionSidecarPath refuses any other file ending in `.json`, because every reader that lists the sessions directory takes one to be a session.
const DROPPED_SUFFIX = '.compact-dropped'

/** Record `paths` as the ones the latest compaction summary for `stateKey` left out. An empty list, or `null` for a compaction whose summary was never seen, removes the record instead. Best-effort: a failed write leaves the packet without the section, never a failed hook. */
export function recordCompactDroppedPaths(stateKey: string, paths: readonly string[] | null): void {
  const target = sessionSidecarPath(stateKey, DROPPED_SUFFIX)
  if (target === null) return
  try {
    if (paths === null || paths.length === 0) {
      rmSync(target, { force: true })
      return
    }
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify(paths), 'utf8')
  } catch {
    // See the doc comment above.
  }
}

/** The paths the latest compaction summary for `stateKey` left out, in the manifest's print order, or an empty list when there is no record or it cannot be read. */
export function readCompactDroppedPaths(stateKey: string): string[] {
  const target = sessionSidecarPath(stateKey, DROPPED_SUFFIX)
  if (target === null) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string' && p !== '') : []
  } catch {
    return []
  }
}
