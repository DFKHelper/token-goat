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
 * Build the session manifest string.
 *
 * Counts reads and edits, then lists read files, an edited-files section (only
 * when edits exist), and any fetched web URLs with their cache ids. Rows are
 * capped at {@link MAX_ROWS} per section with a truncation note.
 */
export function buildManifest(): string {
  const files = [...getSessionFiles().values()]
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
    for (const [url, cacheId] of webFetches.slice(0, MAX_ROWS)) {
      lines.push(`- ${url} (cacheId: ${cacheId})`)
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
export function preCompactHandler(_event: HookEvent): HookOutput {
  return contextOutput(buildManifest())
}

registerHook('pre_compact', preCompactHandler)
