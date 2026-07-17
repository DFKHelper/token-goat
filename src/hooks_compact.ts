/**
 * pre_compact session-manifest hook.
 *
 * Ports the intent of `hooks_compact.py` / `build_manifest`: before Claude Code
 * compacts the conversation, inject a concise summary of what this session
 * touched (files read, files edited, web URLs fetched) so the compaction
 * preserves that context instead of dropping it. The manifest is intentionally
 * compact — aim well under 2000 chars — and is emitted as a `context` output.
 */

import { spawnSync } from 'node:child_process'

import { getSessionFiles, getSessionWebFetches, getSessionBashOutputs, getSessionBashReruns } from './session.js'
import type { FileEntry } from './session.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput } from './hooks_common.js'
import { listSiblingSessionStates } from './session_store.js'
import { foldPath, toKB } from './util.js'
import type { HookOutput } from './types.js'
import { getBashOutput } from './bash_output_cache.js'

/** Bound on how long we'll wait for `mem epoch` before giving up -- see {@link buildMemEpochSection}. */
const MEM_EPOCH_TIMEOUT_MS = 800

/** Cap on read/edit/web rows so a huge session can't blow the token budget. */
const MAX_ROWS = 40

/** Render one read-file row: `path (Xkb, N reads[, edited])`. */
function renderReadRow(entry: FileEntry): string {
  const kb = Math.max(1, toKB(entry.sizeBytes))
  const plural = entry.readCount === 1 ? 'read' : 'reads'
  const edited = entry.wasEdited ? ', edited' : ''
  return `- ${entry.path} (${kb}kb, ${entry.readCount} ${plural}${edited})`
}

/**
 * Fold sibling subagent file entries into the parent's own file list, keyed
 * by {@link foldPath} (case-insensitive-filesystem-safe path identity, same
 * key session_store.ts's own merge logic uses). A file counts as edited if
 * ANY blob — parent or any subagent — marked it edited; readCount/lastReadAt
 * take the max across blobs and sizeBytes comes from whichever view is most
 * recent. This is a display-only merge for the compaction manifest, not the
 * persisted-state merge in session_store.ts (that one tracks per-process
 * read-count baselines that don't apply to blobs read cold off disk here).
 */
function mergeManifestFiles(parent: FileEntry[], siblingFiles: FileEntry[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>()
  for (const f of parent) byPath.set(foldPath(f.path), f)
  for (const f of siblingFiles) {
    const key = foldPath(f.path)
    const prev = byPath.get(key)
    if (prev === undefined) {
      byPath.set(key, f)
      continue
    }
    byPath.set(key, {
      path: prev.path,
      readCount: Math.max(prev.readCount, f.readCount),
      lastReadAt: Math.max(prev.lastReadAt, f.lastReadAt),
      wasEdited: prev.wasEdited || f.wasEdited,
      sizeBytes: f.lastReadAt >= prev.lastReadAt ? f.sizeBytes : prev.sizeBytes,
      ...(prev.wasTruncated || f.wasTruncated ? { wasTruncated: true } : {}),
    })
  }
  return Array.from(byPath.values())
}

/**
 * Build the session manifest string.
 *
 * Counts reads and edits, then lists read files, an edited-files section (only
 * when edits exist), and any fetched web URLs with their cache ids. Rows are
 * capped at {@link MAX_ROWS} per section with a truncation note.
 *
 * `sessionId`, when provided, is the *unsalted* parent session id (relay.ts
 * only salts `sessionStateKey` when `agentId` is set, which is never true on
 * the main thread that runs pre_compact). Every subagent spawned during this
 * session persisted its reads/edits into its own agent-salted blob (see
 * relay.ts's `sessionStateKey`), separate from the parent's plain-keyed blob
 * that {@link getSessionFiles} was just hydrated from — so without this,
 * a subagent's edits are invisible to the compaction manifest that is
 * supposed to preserve exactly that context across compaction. Sibling blobs
 * are read straight off disk and merged in; nothing is written back.
 */
export function buildManifest(sessionId?: string): string {
  const ownFiles = [...getSessionFiles().values()]
  const siblingFiles = sessionId !== undefined ? listSiblingSessionStates(sessionId).flatMap((s) => s.files) : []
  const files = siblingFiles.length > 0 ? mergeManifestFiles(ownFiles, siblingFiles) : ownFiles
  const editedFiles = files.filter((f) => f.wasEdited)
  const readFiles = files.filter((f) => f.readCount > 0 && !f.wasEdited)
  const webFetches = [...getSessionWebFetches().entries()]

  const lines: string[] = []
  lines.push('## Session context')
  lines.push(`Files read: ${readFiles.length}`)
  lines.push(`Files edited: ${editedFiles.length}`)

  if (readFiles.length > 0) {
    lines.push('')
    lines.push('### Read files')
    for (const entry of readFiles.slice(0, MAX_ROWS)) {
      lines.push(renderReadRow(entry))
    }
    if (readFiles.length > MAX_ROWS) {
      lines.push(`- ...and ${readFiles.length - MAX_ROWS} more`)
    }
  }

  if (editedFiles.length > 0) {
    lines.push('')
    lines.push('### Edited files')
    for (const entry of editedFiles.slice(0, MAX_ROWS)) {
      lines.push(`- ${entry.path}`)
    }
    if (editedFiles.length > MAX_ROWS) {
      lines.push(`- ...and ${editedFiles.length - MAX_ROWS} more`)
    }
  }

  if (webFetches.length > 0) {
    lines.push('')
    lines.push('### Web URLs fetched')
    // The map key is the url+'\x00'+prompt composite (see recordWebFetch in session.ts),
    // so split it back apart for display instead of treating the whole key as the url.
    for (const [key, cacheId] of webFetches.slice(0, MAX_ROWS)) {
      const sep = key.indexOf('\x00')
      const url = sep === -1 ? key : key.slice(0, sep)
      const prompt = sep === -1 ? '' : key.slice(sep + 1)
      const promptSuffix = prompt ? `, prompt: ${JSON.stringify(prompt)}` : ''
      lines.push(`- ${url} (cacheId: ${cacheId}${promptSuffix})`)
    }
    if (webFetches.length > MAX_ROWS) {
      lines.push(`- ...and ${webFetches.length - MAX_ROWS} more`)
    }
  }

  lines.push(...buildSafeToDiscardSection(files))
  lines.push(...buildMemEpochSection())

  return lines.join('\n')
}

/**
 * Build the SAFE_TO_DISCARD manifest section: provably-inert prior context that
 * compaction can drop without losing data, because it is recoverable through an
 * existing recall command. Conservative by construction -- only three classes,
 * each backed by an explicit session-state signal (never inferred):
 *
 * 1. Superseded identical-command bash reruns: a store call this session
 *    overwrote an already-cached entry under the exact same command key (see
 *    recordBashRerun in session.ts, wired from hooks_bash.ts's Item F
 *    delta-folding path). The raw transcript copy of the OLDER run is dead --
 *    the surviving cached id already holds the freshest output.
 * 2. File reads superseded by a later Edit/Write/Read of the same file:
 *    readCount > 1 (re-read at least once) or wasEdited (the file changed
 *    after being read) both mean an earlier textual copy in the transcript no
 *    longer reflects the file's current content.
 * 3. Every other bash output still tracked in the session's cache index --
 *    each is recallable verbatim via bash-output <id>, so its inline
 *    transcript copy is redundant regardless of whether it was ever rerun.
 *    Reruns already itemized under (1) are excluded here to avoid double
 *    counting the same command under two headings.
 *
 * Always labels the section with an explicit item count and the recall
 * command needed to get each item's data back -- never implies data is gone,
 * only that the inline copy is a redundant duplicate of something recallable.
 */
function buildSafeToDiscardSection(files: FileEntry[]): string[] {
  const rerunHashes = getSessionBashReruns()
  const bashOutputs = getSessionBashOutputs()
  const rerunHashSet = new Set(rerunHashes)

  const rerunRows: string[] = []
  for (const hash of rerunHashes) {
    const id = bashOutputs.find(([h]) => h === hash)?.[1]
    if (id === undefined) continue
    const entry = getBashOutput(id)
    if (entry === null) continue
    const flatCommand = entry.command.replace(/[\t\r\n]+/g, ' ')
    rerunRows.push('- `' + flatCommand + '` — an older run of this exact command was superseded; recall the surviving copy with `bash-output ' + id + '`')
  }

  const supersededReadRows: string[] = []
  for (const f of files) {
    if (f.readCount > 1 || f.wasEdited) {
      const reason = f.wasEdited ? 'edited after being read' : ('re-read ' + f.readCount + 'x')
      supersededReadRows.push('- ' + f.path + ' (' + reason + ' — only the latest content already in context is current)')
    }
  }

  const cachedOutputRows: string[] = []
  for (const [hash, id] of bashOutputs) {
    if (rerunHashSet.has(hash)) continue
    const entry = getBashOutput(id)
    if (entry === null) continue
    const flatCommand = entry.command.replace(/[\t\r\n]+/g, ' ')
    cachedOutputRows.push('- `' + flatCommand + '` — recallable via `bash-output ' + id + '`')
  }

  const total = rerunRows.length + supersededReadRows.length + cachedOutputRows.length
  if (total === 0) return []

  const lines: string[] = []
  lines.push('')
  lines.push('### SAFE_TO_DISCARD (' + total + ' items — provably inert; each is recallable, not gone)')
  if (rerunRows.length > 0) {
    lines.push('')
    lines.push('Superseded reruns (' + rerunRows.length + '):')
    for (const row of rerunRows.slice(0, MAX_ROWS)) lines.push(row)
    if (rerunRows.length > MAX_ROWS) lines.push('- ...and ' + (rerunRows.length - MAX_ROWS) + ' more')
  }
  if (supersededReadRows.length > 0) {
    lines.push('')
    lines.push('Superseded file reads (' + supersededReadRows.length + '):')
    for (const row of supersededReadRows.slice(0, MAX_ROWS)) lines.push(row)
    if (supersededReadRows.length > MAX_ROWS) lines.push('- ...and ' + (supersededReadRows.length - MAX_ROWS) + ' more')
  }
  if (cachedOutputRows.length > 0) {
    lines.push('')
    lines.push('Other cached bash outputs (' + cachedOutputRows.length + '):')
    for (const row of cachedOutputRows.slice(0, MAX_ROWS)) lines.push(row)
    if (cachedOutputRows.length > MAX_ROWS) lines.push('- ...and ' + (cachedOutputRows.length - MAX_ROWS) + ' more')
  }
  return lines
}

/**
 * Fold `mem epoch` (token-goat-mem's monotonic counter, when the `mem` binary is on PATH) into
 * the compaction manifest, so a resumed session can tell whether mem's fact store has advanced
 * since this transcript was captured.
 *
 * FINDING (searched for at implementation time): this codebase has no existing tracking of a
 * "current live TGMEM block" anywhere -- no `TGMEM` marker, no in-session summary of facts mem
 * currently holds. `hooks_compact.ts`'s manifest tracks only file reads/edits/web
 * fetches/bash-output caching (see {@link buildManifest}); nothing here shadows mem's own state.
 * Per spec, that gap is reported rather than papered over with a fabricated block-tracking
 * mechanism: this section folds in `mem epoch`'s bare integer alone, with an explicit note that
 * no live TGMEM block is tracked in this session.
 *
 * Must fail open: `mem` may be absent from PATH, may error, or may hang. `spawnSync` bounds the
 * wait to {@link MEM_EPOCH_TIMEOUT_MS} (same spawnSync-with-timeout pattern as
 * checkCopilotCli in cli_doctor.ts) and any failure -- ENOENT, non-zero exit, timeout kill,
 * unparsable stdout -- silently omits the section. No error is ever surfaced and compaction
 * never blocks or fails because of this.
 */
function buildMemEpochSection(): string[] {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('mem', ['epoch'], {
      encoding: 'utf-8',
      timeout: MEM_EPOCH_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch {
    return []
  }
  if (result.error !== undefined || result.status !== 0) return []

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  if (!/^\d+$/.test(stdout)) return []

  return [
    '',
    '### mem epoch',
    `mem epoch: ${stdout} (no live TGMEM block is tracked in this session -- only the epoch counter is folded in; see buildMemEpochSection's doc comment)`,
  ]
}

/**
 * pre_compact handler: inject the session manifest as context.
 *
 * Always returns a `context` output so the manifest reaches the compaction
 * summary even for an otherwise empty session (the counts confirm nothing was
 * dropped).
 */
export function preCompactHandler(event: HookEvent): HookOutput {
  return contextOutput(buildManifest(event.sessionId))
}

registerHook('pre_compact', preCompactHandler)
