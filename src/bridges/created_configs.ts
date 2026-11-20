/** A record of the config files token-goat itself created, so uninstall can delete one it created and never one that was already the user's. Install and uninstall are separate runs, and once uninstall has removed token-goat's own entry the two cases are byte-identical: a `.mcp.json` token-goat created from nothing walks back to the same empty stub as a user's pre-existing `{"mcpServers": {}}`, which is an ordinary Claude Code project stub. Emptiness is therefore not evidence the file is token-goat's, and uninstall used to delete a user-authored file (with any comments in it) on exactly that reasoning. Content cannot tell the two apart, so creation has to be remembered instead. Every failure here is deliberately read as "not ours": an unreadable, missing or purged ledger leaves the file on disk. That direction leaves litter at worst, while the other direction deletes something nobody can get back. */
import * as fs from 'fs'
import * as path from 'path'

import { dataDir } from '../constants.js'
import { normalizePath } from '../paths.js'
import {
  atomicWriteBytes,
  atomicWriteText,
  ensureDirSync,
  foldPath,
  removeEmptyDirInScope,
  removeFileInScope,
  resolveSymlinkChain,
  tracingWrites,
  withFileLock,
} from '../util.js'

function ledgerPath(): string {
  return path.join(dataDir(), 'created-configs.json')
}

/** Separator- and drive-normalized, case PRESERVED: a ledger entry has to be able to name the file it recorded. Case folding used to happen here, which made every entry both the match key and a path that no longer existed. `backupFile` stamps a backup with `new Date().toISOString()`, so the real name carries an uppercase `T` and `Z` (`settings.json.bak.2026-09-12T00-00-00-000Z`) and the folded entry named `...t00-00-00-000z`. On Windows and a default macOS volume that resolves to the same file and nothing looked wrong; on Linux the unlink missed, `removeCreatedBackups` reported 0, and every backup token-goat wrote was orphaned in a directory the user had been told it was gone from -- the exact failure the ledger exists to prevent, on the one platform CI would have caught it on had these commits been pushed. */
function keyOf(filePath: string): string {
  return normalizePath(path.resolve(filePath))
}

/** The comparison form of a key. Matching still folds, because install and uninstall are separate runs that can spell the same path with different case. Only matching: what gets unlinked is the entry as recorded. Through {@link foldPath}, which asks the platform, and NOT an unconditional `.toLowerCase()`. On a case-SENSITIVE filesystem `/home/u/Repo/.zed/settings.json` and `/home/u/repo/.zed/settings.json` are two different files that fold to one key, and this ledger answers a delete question: `uninstallZed` does `if (empty && takeCreatedConfig(settingsPath)) { rm }`, so the other directory's entry answered "token-goat created this" and the caller removed a settings file the user wrote. `recordCreatedConfig` carried the mirror of it -- the second directory's entry was never recorded at all, orphaning its backups at uninstall. The codebase already had the platform-correct primitive; this module was the one bypassing it. */
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

/** The ledger's entries, with `error` set when the file exists but cannot be read or is not a list: unlike {@link readLedger}, a damaged ledger is not read as an empty one. */
export function readCreatedLedgerStrict(): { entries: string[]; error?: string } {
  let text: string
  try {
    text = fs.readFileSync(ledgerPath(), 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { entries: [] } : { entries: [], error: `could not be read (${code ?? 'unknown error'})` }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return { entries: [], error: 'is not a list' }
    return { entries: parsed.filter((entry): entry is string => typeof entry === 'string') }
  } catch {
    return { entries: [], error: 'is not valid JSON' }
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

/** Run `work` under a cross-process ledger lock (bounded wait, stale lock stolen); no lock, run it bare. */
function withLedgerLock<T>(work: () => T): T {
  let ran = false
  let result: T | undefined
  try {
    // limit: a first write before the data dir exists runs unlocked revisit-when: a lost entry shows up
    withFileLock(`${ledgerPath()}.lock`, () => {
      ran = true
      result = work()
    })
  } catch (err) {
    if (ran) throw err
  }
  return ran ? (result as T) : work()
}

/** Remember that token-goat created `filePath`. */
export function recordCreatedConfig(filePath: string): void {
  const key = keyOf(filePath)
  withLedgerLock(() => {
    const entries = readLedger()
    if (entries.some((entry) => foldKey(entry) === foldKey(key))) return
    writeLedger([...entries, key])
  })
}

/** True when token-goat on THIS machine created `filePath`, without forgetting it. Separate from {@link takeCreatedConfig} because the two questions differ: uninstall asks once and must not be able to answer twice, while a hook asks on every invocation and must keep getting the same answer. Same failure direction as everything else here -- an unreadable or purged ledger answers "not ours". */
export function hasCreatedConfig(filePath: string): boolean {
  const key = foldKey(keyOf(filePath))
  return readLedger().some((entry) => foldKey(entry) === key)
}

/** True when token-goat created `filePath` itself, forgetting it in the same step so the answer is not reused. */
export function takeCreatedConfig(filePath: string): boolean {
  const key = foldKey(keyOf(filePath))
  return withLedgerLock(() => {
    const entries = readLedger()
    if (!entries.some((entry) => foldKey(entry) === key)) return false
    writeLedger(entries.filter((entry) => foldKey(entry) !== key))
    return true
  })
}

/** The ledger key for "this install added the `rootKey` object to `filePath`": the file's own key plus a marker, so it can never equal a real path or a backup entry. */
function rootKeyMarker(filePath: string, rootKey: string): string {
  return `${filePath}#root-key=${rootKey}`
}

/** Remember that an install added the `rootKey` object (e.g. `servers`) to `filePath`, which `dropEmptyServers` needs on uninstall: once the managed entry is gone, an object install added and one the user already had are the same bytes. */
export function recordCreatedRootKey(filePath: string, rootKey: string): void {
  recordCreatedConfig(rootKeyMarker(filePath, rootKey))
}

/** True when an install added the `rootKey` object to `filePath`, forgetting the marker in the same step. */
export function takeCreatedRootKey(filePath: string, rootKey: string): boolean {
  return takeCreatedConfig(rootKeyMarker(filePath, rootKey))
}

/** Ledger suffix of the entry naming a settings file that holds token-goat hooks, whoever created the file. */
export const HOOK_CONFIG_SUFFIX = '#hook-config'

/** Remember that `filePath` holds token-goat hooks, so another project's uninstall keeps their shim. */
export function recordHookConfig(filePath: string): void {
  recordCreatedConfig(`${filePath}${HOOK_CONFIG_SUFFIX}`)
}

/** Forget that `filePath` holds token-goat hook commands; true when it was recorded. */
export function takeHookConfig(filePath: string): boolean {
  return takeCreatedConfig(`${filePath}${HOOK_CONFIG_SUFFIX}`)
}

/** The ledger key for "token-goat changed the setting `key` in `filePath` from a literal `true` to `false`", built like {@link rootKeyMarker}. The prior value is part of the key because it is the only one ever turned off, so uninstall knows what to put back. */
function turnedOffMarker(filePath: string, key: string): string {
  return `${filePath}#turned-off=${key}:true`
}

/** Remember that token-goat turned the user's `key` in `filePath` from true to false. */
export function recordTurnedOffSetting(filePath: string, key: string): void {
  recordCreatedConfig(turnedOffMarker(filePath, key))
}

/** True when token-goat turned `key` in `filePath` from true to false, forgetting the marker in the same step. */
export function takeTurnedOffSetting(filePath: string, key: string): boolean {
  return takeCreatedConfig(turnedOffMarker(filePath, key))
}

/** Remember that token-goat wrote the backup at `backupPath`. Backups share the created-configs ledger because they pose the identical question. Once written, a `<config>.bak.<stamp>` token-goat made is indistinguishable on disk from one a user made by hand, so uninstall cannot tell them apart by name -- and a glob over `*.bak.*` would delete the user's. Creation is recorded instead, exactly as it is for a config file. */
export function recordCreatedBackup(backupPath: string): void {
  recordCreatedConfig(backupPath)
}

/** Drop a backup from the ledger without deleting it: for when something else already unlinked it. */
export function forgetCreatedBackup(backupPath: string): void {
  takeCreatedConfig(backupPath)
}

/** Full paths of the backups token-goat recorded for `configPath`, oldest first (ISO-with-dashes timestamps sort chronologically as strings). Taken from the ledger, not from a directory listing: a user can name a file anything, and a prune keyed on `readdirSync` + prefix match would delete a user file that merely looks like one of ours. */
export function createdBackupsFor(configPath: string): string[] {
  const prefix = foldKey(`${keyOf(configPath)}.bak.`)
  return readLedger()
    .filter((entry) => foldKey(entry).startsWith(prefix))
    .sort()
}

/** Delete the backups token-goat created for `configPath`, and nothing else. Returns how many went. The candidate set is the ledger, not the directory: a user's own `settings.json.bak.keep` was never recorded, so it is never even considered. A missing or unreadable ledger therefore removes nothing, which leaves litter rather than deleting a file nobody can get back -- the direction every other failure in this module is read in. */
export function removeCreatedBackups(configPath: string): number {
  return withLedgerLock(() => removeCreatedBackupsLocked(configPath))
}

function removeCreatedBackupsLocked(configPath: string): number {
  const prefix = foldKey(`${keyOf(configPath)}.bak.`)
  const entries = readLedger()
  const ours = entries.filter((entry) => foldKey(entry).startsWith(prefix))
  if (ours.length === 0) return 0

  const failed = new Set<string>()
  let removed = 0
  for (const target of ours) {
    // The entry itself, not a name rebuilt out of the folded match key: rebuilding is what dropped the ISO stamp's `T` and `Z` and made every unlink miss on a case-sensitive filesystem.
    try {
      if (removeFileInScope(target)) removed++
    } catch {
      failed.add(target)
    }
  }
  writeLedger(entries.filter((entry) => !ours.includes(entry) || failed.has(entry)))
  return removed
}

/** `ensureDirSync`, recording `dir` in the created-configs ledger when this call is what brought it into being, so uninstall can take away a directory token-goat's install made and leave one that was already there. */
export function ensureDirRecordingCreation(dir: string): void {
  const existed = fs.existsSync(dir)
  ensureDirSync(dir)
  if (!existed) recordCreatedConfig(dir)
}

/** True for text with no content: nothing but whitespace, or the empty JSON object a settings file is left as once its last token-goat key is stripped. */
function holdsNothing(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || /^\{\s*\}$/.test(trimmed)
}

/** Delete `target`, an empty directory or a file holding nothing but whitespace, when the created-configs ledger says a token-goat install created it, and forget the entry once it is gone. Anything else stays: a directory or file the user made, however empty, and one token-goat made that now holds anything at all. Emptiness alone is not evidence either way, which is why the ledger is asked first. */
export function removeCreatedIfEmpty(target: string): void {
  if (!hasCreatedConfig(target)) return
  let removed = false
  try {
    removed = fs.lstatSync(target).isDirectory() ? removeEmptyDirInScope(target) : holdsNothing(fs.readFileSync(target, 'utf8')) && removeFileInScope(target)
  } catch {
    // Already gone, unreadable, or not a plain file or directory: nothing is removed, and the entry stays for a later uninstall.
  }
  if (removed) takeCreatedConfig(target)
}

/** Run `work`, then record in the ledger each of `targets` and each directory above one that `work` brought into being, so uninstall can take away exactly what this install made. Recorded even when `work` throws, since whatever it created before failing is still token-goat's. */
export function recordCreatedBy<T>(targets: readonly string[], work: () => T): T {
  const absent = absentPaths(targets)
  try {
    return work()
  } finally {
    for (const p of absent) if (fs.existsSync(p)) recordCreatedConfig(p)
  }
}

/** On a throw, undo what `work` alone made (absent targets and parent dirs, new backups, ledger entries). */
// A file already there stays with its entry and earlier bytes; the error is rethrown as it was.
// limit: a file a concurrent install creates meanwhile is undone too; revisit-when: installs overlap by design
export function undoCreatedOnFailure<T>(targets: readonly string[], work: () => T): T {
  const absent = absentPaths(targets)
  const recordedBefore = new Set([...absent, ...targets.map((t) => path.resolve(t))].filter(hasCreatedConfig))
  const backupsBefore = new Set(targets.flatMap(createdBackupsFor))
  const earlier = earlierBytes(targets)
  const wrote = new Map<string, Buffer>()
  const leftAsFound: string[] = []
  try {
    return tracingWrites(wrote, work)
  } catch (error) {
    undoQuietly(() => restoreEarlierBytes(earlier, wrote, leftAsFound))
    undoQuietly(() => {
      for (const p of [...absent].sort((a, b) => b.length - a.length)) {
        if (!lexists(p)) continue
        if (fs.lstatSync(p).isDirectory()) removeEmptyDirInScope(p)
        else if (holdsBytesWritten(p, wrote)) removeFileInScope(p)
        else leftAsFound.push(p)
      }
    })
    for (const backup of targets.flatMap(createdBackupsFor).filter((b) => !backupsBefore.has(b))) {
      undoQuietly(() => {
        removeFileInScope(backup)
        forgetCreatedBackup(backup)
      })
    }
    for (const p of [...absent, ...targets.map((t) => path.resolve(t))]) {
      if (!recordedBefore.has(p)) undoQuietly(() => void takeCreatedConfig(p))
    }
    if (leftAsFound.length > 0 && error instanceof Error) {
      error.message += `\nchanged by another program, left as found: ${leftAsFound.join(', ')}`
    }
    throw error
  }
}

/** Run `write`, noting what it published to `paths`; `revert` undoes only what still holds those bytes. */
export function tracedFileWrites<T>(
  paths: readonly string[],
  write: () => T,
): { result: T; revert: (error: unknown) => void } {
  const earlier = earlierBytes(paths)
  const wrote = new Map<string, Buffer>()
  const result = tracingWrites(wrote, write)
  const revert = (error: unknown): void => {
    const left: string[] = []
    undoQuietly(() => restoreEarlierBytes(earlier, wrote, left))
    const created = [...paths.map((t) => path.resolve(t)), ...missingReferents(paths)]
    for (const p of created.filter((t) => !earlier.has(t) && lexists(t) && !fs.lstatSync(t).isSymbolicLink())) {
      if (holdsBytesWritten(p, wrote)) undoQuietly(() => removeFileInScope(p))
      else left.push(p)
    }
    if (left.length > 0 && error instanceof Error) {
      error.message += `\nchanged by another program, left as found: ${left.join(', ')}`
    }
  }
  return { result, revert }
}

/** The bytes of each of `targets` that is a file now (or a link to one), for a failed install to restore. */
function earlierBytes(targets: readonly string[]): Map<string, Buffer> {
  const earlier = new Map<string, Buffer>()
  for (const target of targets) {
    const p = path.resolve(target)
    try {
      // The installers write through a link to its target, so the target's bytes are what changed.
      if (fs.statSync(p).isFile()) earlier.set(p, fs.readFileSync(p))
    } catch {
      // Absent, dangling or unreadable: nothing to put back, and an absent target is removed by the caller.
    }
  }
  return earlier
}

/** True when `p` holds exactly the bytes this attempt last published there: only then is it ours to undo. */
function holdsBytesWritten(p: string, wrote: ReadonlyMap<string, Buffer>): boolean {
  const mine = wrote.get(foldPath(path.resolve(p)))
  try {
    return mine !== undefined && fs.readFileSync(p).equals(mine)
  } catch {
    return false
  }
}

/** Write back each `earlier` file still holding the bytes this attempt published; any other goes in `left`. */
function restoreEarlierBytes(
  earlier: ReadonlyMap<string, Buffer>,
  wrote: ReadonlyMap<string, Buffer>,
  left: string[],
): void {
  for (const [p, bytes] of earlier) {
    undoQuietly(() => {
      if (holdsBytesWritten(p, new Map([[foldPath(path.resolve(p)), bytes]]))) return
      if (holdsBytesWritten(p, wrote)) atomicWriteBytes(p, bytes)
      else left.push(p)
    })
  }
}

function undoQuietly(step: () => void): void {
  try {
    step()
  } catch {
    // The install already failed with its own error; an undo that fails leaves litter, never a second error.
  }
}

/** The uninstall half of {@link recordCreatedBy}: walk `targets` and every directory above them, deepest first, deleting what the ledger says an install created and that now holds nothing, and forgetting an entry whose path is already gone. The ledger decides, never emptiness alone, so a pre-existing file or directory and anything holding user content stay. */
export function removeCreatedTree(targets: readonly string[]): void {
  const paths = new Set<string>()
  for (const target of targets) {
    for (let p = path.resolve(target); !paths.has(p); p = path.dirname(p)) {
      paths.add(p)
      if (path.dirname(p) === p) break
    }
  }
  for (const p of [...paths].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(p)) removeCreatedIfEmpty(p)
    else if (hasCreatedConfig(p)) takeCreatedConfig(p)
  }
}

/** True when anything, a dangling link included, is at `p`: `existsSync` follows a link and says no. */
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Where each link in `paths` ends when that file does not exist yet: the file a write through it creates. */
function missingReferents(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const target of paths) {
    const p = path.resolve(target)
    try {
      const end = resolveSymlinkChain(p)
      if (end !== p && !lexists(end)) out.push(end)
    } catch {
      // A link loop: the write fails on its own and there is no end to name.
    }
  }
  return out
}

/** The `targets`, the files their links lead to, and each directory above one, that are not there now. */
function absentPaths(targets: readonly string[]): Set<string> {
  const absent = new Set<string>()
  for (const target of [...targets.map((t) => path.resolve(t)), ...missingReferents(targets)]) {
    for (let p = target; !lexists(p) && !absent.has(p); p = path.dirname(p)) absent.add(p)
  }
  return absent
}
