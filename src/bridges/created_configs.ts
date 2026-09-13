/**
 * A record of the config files token-goat itself created, so uninstall can delete one it created
 * and never one that was already the user's.
 *
 * Install and uninstall are separate runs, and once uninstall has removed token-goat's own entry
 * the two cases are byte-identical: a `.mcp.json` token-goat created from nothing walks back to the
 * same empty stub as a user's pre-existing `{"mcpServers": {}}`, which is an ordinary Claude Code
 * project stub. Emptiness is therefore not evidence the file is token-goat's, and uninstall used to
 * delete a user-authored file (with any comments in it) on exactly that reasoning. Content cannot
 * tell the two apart, so creation has to be remembered instead.
 *
 * Every failure here is deliberately read as "not ours": an unreadable, missing or purged ledger
 * leaves the file on disk. That direction leaves litter at worst, while the other direction deletes
 * something nobody can get back.
 */
import * as fs from 'fs'
import * as path from 'path'

import { dataDir } from '../constants.js'
import { normalizePath } from '../paths.js'
import { atomicWriteText, ensureDirSync, foldPath, removeFileInScope } from '../util.js'

function ledgerPath(): string {
  return path.join(dataDir(), 'created-configs.json')
}

/**
 * Separator- and drive-normalized, case PRESERVED: a ledger entry has to be able to name the file
 * it recorded.
 *
 * Case folding used to happen here, which made every entry both the match key and a path that no
 * longer existed. `backupFile` stamps a backup with `new Date().toISOString()`, so the real name
 * carries an uppercase `T` and `Z` (`settings.json.bak.2026-09-12T00-00-00-000Z`) and the folded
 * entry named `...t00-00-00-000z`. On Windows and a default macOS volume that resolves to the same
 * file and nothing looked wrong; on Linux the unlink missed, `removeCreatedBackups` reported 0, and
 * every backup token-goat wrote was orphaned in a directory the user had been told it was gone
 * from -- the exact failure the ledger exists to prevent, on the one platform CI would have caught
 * it on had these commits been pushed.
 */
function keyOf(filePath: string): string {
  return normalizePath(path.resolve(filePath))
}

/**
 * The comparison form of a key.
 *
 * Matching still folds, because install and uninstall are separate runs that can spell the same
 * path with different case. Only matching: what gets unlinked is the entry as recorded.
 *
 * Through {@link foldPath}, which asks the platform, and NOT an unconditional `.toLowerCase()`.
 * On a case-SENSITIVE filesystem `/home/u/Repo/.zed/settings.json` and
 * `/home/u/repo/.zed/settings.json` are two different files that fold to one key, and this ledger
 * answers a delete question: `uninstallZed` does `if (empty && takeCreatedConfig(settingsPath))
 * { rm }`, so the other directory's entry answered "token-goat created this" and the caller
 * removed a settings file the user wrote. `recordCreatedConfig` carried the mirror of it -- the
 * second directory's entry was never recorded at all, orphaning its backups at uninstall. The
 * codebase already had the platform-correct primitive; this module was the one bypassing it.
 */
function foldKey(key: string): string {
  return foldPath(key)
}

function readLedger(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function writeLedger(entries: readonly string[]): void {
  try {
    ensureDirSync(path.dirname(ledgerPath()))
    atomicWriteText(ledgerPath(), `${JSON.stringify(entries)}\n`)
  } catch {
    // Best effort: a ledger that cannot be written just means uninstall leaves the file in place.
  }
}

/** Remember that token-goat created `filePath`. */
export function recordCreatedConfig(filePath: string): void {
  const key = keyOf(filePath)
  const entries = readLedger()
  if (entries.some((entry) => foldKey(entry) === foldKey(key))) return
  writeLedger([...entries, key])
}

/**
 * True when token-goat on THIS machine created `filePath`, without forgetting it.
 *
 * Separate from {@link takeCreatedConfig} because the two questions differ: uninstall asks once and
 * must not be able to answer twice, while a hook asks on every invocation and must keep getting the
 * same answer. Same failure direction as everything else here -- an unreadable or purged ledger
 * answers "not ours".
 */
export function hasCreatedConfig(filePath: string): boolean {
  const key = foldKey(keyOf(filePath))
  return readLedger().some((entry) => foldKey(entry) === key)
}

/** True when token-goat created `filePath` itself, forgetting it in the same step so the answer is not reused. */
export function takeCreatedConfig(filePath: string): boolean {
  const key = foldKey(keyOf(filePath))
  const entries = readLedger()
  if (!entries.some((entry) => foldKey(entry) === key)) return false
  writeLedger(entries.filter((entry) => foldKey(entry) !== key))
  return true
}

/**
 * Remember that token-goat wrote the backup at `backupPath`.
 *
 * Backups share the created-configs ledger because they pose the identical question. Once written,
 * a `<config>.bak.<stamp>` token-goat made is indistinguishable on disk from one a user made by
 * hand, so uninstall cannot tell them apart by name -- and a glob over `*.bak.*` would delete the
 * user's. Creation is recorded instead, exactly as it is for a config file.
 */
export function recordCreatedBackup(backupPath: string): void {
  recordCreatedConfig(backupPath)
}

/** Drop a backup from the ledger without deleting it: for when something else already unlinked it. */
export function forgetCreatedBackup(backupPath: string): void {
  takeCreatedConfig(backupPath)
}

/**
 * Full paths of the backups token-goat recorded for `configPath`, oldest first (ISO-with-dashes
 * timestamps sort chronologically as strings). Taken from the ledger, not from a directory
 * listing: a user can name a file anything, and a prune keyed on `readdirSync` + prefix match
 * would delete a user file that merely looks like one of ours.
 */
export function createdBackupsFor(configPath: string): string[] {
  const prefix = foldKey(`${keyOf(configPath)}.bak.`)
  return readLedger()
    .filter((entry) => foldKey(entry).startsWith(prefix))
    .sort()
}

/**
 * Delete the backups token-goat created for `configPath`, and nothing else. Returns how many went.
 *
 * The candidate set is the ledger, not the directory: a user's own `settings.json.bak.keep` was
 * never recorded, so it is never even considered. A missing or unreadable ledger therefore removes
 * nothing, which leaves litter rather than deleting a file nobody can get back -- the direction
 * every other failure in this module is read in.
 */
export function removeCreatedBackups(configPath: string): number {
  const prefix = foldKey(`${keyOf(configPath)}.bak.`)
  const entries = readLedger()
  const ours = entries.filter((entry) => foldKey(entry).startsWith(prefix))
  if (ours.length === 0) return 0

  const failed = new Set<string>()
  let removed = 0
  for (const target of ours) {
    // The entry itself, not a name rebuilt out of the folded match key: rebuilding is what dropped
    // the ISO stamp's `T` and `Z` and made every unlink miss on a case-sensitive filesystem.
    try {
      if (fs.existsSync(target) && removeFileInScope(target)) {
        removed++
      }
    } catch {
      failed.add(target)
    }
  }
  writeLedger(entries.filter((entry) => !ours.includes(entry) || failed.has(entry)))
  return removed
}
