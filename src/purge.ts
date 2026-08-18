/**
 * `uninstall --purge`: delete everything token-goat has written to disk.
 *
 * Uninstall deliberately leaves the data directory alone, because it holds an index that took
 * real time to build and a user who reinstalls wants it back. Offboarding a machine wants the
 * opposite, and "remove it by hand" is not an answer an organisation can put in a runbook: there
 * are two roots, they differ per platform, and neither is obvious.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir } from './constants.js'
import { tokenGoatHome } from './disk_cache.js'

export interface PurgeResult {
  /** Roots that were deleted, with the bytes each held. */
  removed: Array<{ path: string; bytes: number }>
  /** Roots that did not exist, so there was nothing to delete. */
  absent: string[]
  /** Roots that could not be deleted, with the reason. */
  failed: Array<{ path: string; reason: string }>
}

/** Recursive size in bytes, counting only regular files. Unreadable entries count as zero rather than aborting the walk. */
export function directorySize(root: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      total += directorySize(full)
      continue
    }
    if (!entry.isFile()) continue
    try {
      total += fs.statSync(full).size
    } catch {
      // A file that vanished mid-walk contributes nothing; the walk continues.
    }
  }
  return total
}

/**
 * The roots token-goat writes to. Two, not one: the data directory holds the index, caches and
 * logs, while the home directory holds session state and the OCR cache, and they are different
 * places on every platform.
 */
export function purgeRoots(): string[] {
  const roots = [dataDir(), tokenGoatHome()]
  return roots.filter((root, index) => roots.indexOf(root) === index)
}

/** Deletes every root in {@link purgeRoots}. Reports what went, what was already gone, and what would not delete. */
export function purgeDataDirectories(): PurgeResult {
  const result: PurgeResult = { removed: [], absent: [], failed: [] }
  for (const root of purgeRoots()) {
    if (!fs.existsSync(root)) {
      result.absent.push(root)
      continue
    }
    const bytes = directorySize(root)
    try {
      fs.rmSync(root, { recursive: true, force: true })
      result.removed.push({ path: root, bytes })
    } catch (e) {
      result.failed.push({ path: root, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

/** Human-readable size, matching the units the rest of the CLI prints. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
