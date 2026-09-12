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
