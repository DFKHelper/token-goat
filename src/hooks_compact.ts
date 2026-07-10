/**
 * pre_compact session-manifest hook.
 *
 * Ports the intent of `hooks_compact.py` / `build_manifest`: before Claude Code
 * compacts the conversation, inject a concise summary of what this session
 * touched (files read, files edited, web URLs fetched) so the compaction
 * preserves that context instead of dropping it. The manifest is intentionally
 * compact — aim well under 2000 chars — and is emitted as a `context` output.
 */

import { getSessionFiles, getSessionWebFetches } from './session.js'
import type { FileEntry } from './session.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput } from './hooks_common.js'
import { listSiblingSessionStates } from './session_store.js'
import { foldPath } from './util.js'
import type { HookOutput } from './types.js'

/** Cap on read/edit/web rows so a huge session can't blow the token budget. */
const MAX_ROWS = 40

/** Render one read-file row: `path (Xkb, N reads[, edited])`. */
function renderReadRow(entry: FileEntry): string {
  const kb = Math.max(1, Math.round(entry.sizeBytes / 1024))
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

  return lines.join('\n')
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
