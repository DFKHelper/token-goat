/**
 * post_tool_use edit hooks (Write / Edit).
 *
 * Ports `hooks_edit.py::post_edit`: after a successful Write/Edit, record the
 * file in the session cache and append it to the dirty queue so the background
 * indexer (Layer 7) reindexes only what changed. Never blocks an edit — always
 * returns `pass`.
 *
 * The dirty-queue path and write logic live in `hooks_index.ts`
 * ({@link appendDirtyPath}) so this writer and the queue drainer share one
 * definition.
 */

import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { passOutput } from './hooks_common.js'
import { appendDirtyPath } from './hooks_index.js'
import { normalizePath } from './paths.js'
import { recordFileEdit } from './session.js'
import type { HookOutput } from './types.js'

/**
 * post_tool_use handler for Write/Edit.
 *
 * Records the edit in the session cache and enqueues the normalized path for
 * reindexing. A missing `file_path` (malformed payload) is tolerated — the
 * call passes through without touching the queue.
 */
export function postEditHandler(event: HookEvent): HookOutput {
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()

  const normalized = normalizePath(filePath)
  recordFileEdit(normalized)
  appendDirtyPath(normalized)
  return passOutput()
}

registerHook('post_tool_use', postEditHandler, { toolName: 'Write' })
registerHook('post_tool_use', postEditHandler, { toolName: 'Edit' })
