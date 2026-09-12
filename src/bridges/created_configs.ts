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
import { atomicWriteText } from '../util.js'

function ledgerPath(): string {
  return path.join(dataDir(), 'created-configs.json')
}

/** Case-folded and separator-normalized, since the same file is named differently by the install and uninstall runs. */
function keyOf(filePath: string): string {
  return normalizePath(path.resolve(filePath)).toLowerCase()
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
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true })
    atomicWriteText(ledgerPath(), `${JSON.stringify(entries)}\n`)
  } catch {
    // Best effort: a ledger that cannot be written just means uninstall leaves the file in place.
  }
}

/** Remember that token-goat created `filePath`. */
export function recordCreatedConfig(filePath: string): void {
  const key = keyOf(filePath)
  const entries = readLedger()
  if (entries.includes(key)) return
  writeLedger([...entries, key])
}

/** True when token-goat created `filePath` itself, forgetting it in the same step so the answer is not reused. */
export function takeCreatedConfig(filePath: string): boolean {
  const key = keyOf(filePath)
  const entries = readLedger()
  if (!entries.includes(key)) return false
  writeLedger(entries.filter((entry) => entry !== key))
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
 * Delete the backups token-goat created for `configPath`, and nothing else. Returns how many went.
 *
 * The candidate set is the ledger, not the directory: a user's own `settings.json.bak.keep` was
 * never recorded, so it is never even considered. A missing or unreadable ledger therefore removes
 * nothing, which leaves litter rather than deleting a file nobody can get back -- the direction
 * every other failure in this module is read in.
 */
export function removeCreatedBackups(configPath: string): number {
  const resolved = path.resolve(configPath)
  const prefix = `${keyOf(configPath)}.bak.`
  const entries = readLedger()
  const ours = entries.filter((entry) => entry.startsWith(prefix))
  if (ours.length === 0) return 0

  const failed = new Set<string>()
  let removed = 0
  for (const key of ours) {
    // Ledger keys are case-folded, which is right for matching and wrong for unlinking on a
    // case-sensitive filesystem. The real name is the caller's own path plus the recorded stamp.
    const target = `${resolved}.bak.${key.slice(prefix.length)}`
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true })
        removed++
      }
    } catch {
      failed.add(key)
    }
  }
  writeLedger(entries.filter((entry) => !ours.includes(entry) || failed.has(entry)))
  return removed
}
