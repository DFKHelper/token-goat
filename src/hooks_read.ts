/**
 * pre_tool_use read hooks (Read / Grep / Glob).
 *
 * Ports the re-read dedup and large-file nudge from `hooks_read.py::pre_read`
 * to the TypeScript hook surface. On each Read/Grep/Glob the handler:
 *   1. extracts `file_path` (passes through when absent),
 *   2. emits a re-read hint if the file was already read this session,
 *   3. emits a large-file hint when the file exceeds {@link LARGE_FILE_BYTES},
 *   4. records the read so later calls dedup against it.
 *
 * The handler returns at most one `context` output per call; image routing
 * (Layer 6) and the heavier `pre_read` machinery are out of scope here.
 */

import * as fs from 'node:fs'

import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { normalizePath } from './paths.js'
import { recordFileRead, wasFileReadThisSession, getSessionFiles } from './session.js'
import { contextOutput, passOutput } from './hooks_common.js'
import type { HookOutput } from './types.js'

/** Size at or above which a read is nudged toward a surgical command. */
const LARGE_FILE_BYTES = 100 * 1024

/** Best-effort file size in bytes, or null when the file cannot be stat'd. */
function statSize(absPath: string): number | null {
  try {
    return fs.statSync(absPath).size
  } catch {
    return null
  }
}

/**
 * pre_tool_use handler for Read/Grep/Glob.
 *
 * Returns a `context` hint (re-read or large-file) when one applies, otherwise
 * `pass`. Always records the read on the way out so the re-read hint fires on
 * the *next* touch, not the current one.
 */
export function preReadHandler(event: HookEvent): HookOutput {
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()

  const normalized = normalizePath(filePath)

  if (wasFileReadThisSession(normalized)) {
    const entry = getSessionFiles().get(normalized)
    const reads = entry?.readCount ?? 1
    const plural = reads === 1 ? 'read' : 'reads'
    recordFileRead(normalized)
    return contextOutput(
      `Note: ${normalized} was already read this session (${reads} ${plural}). ` +
        `Use token-goat read/section/symbol to re-read surgically.`,
    )
  }

  const size = statSize(normalized)
  if (size !== null && size >= LARGE_FILE_BYTES) {
    const kb = Math.round(size / 1024)
    recordFileRead(normalized)
    return contextOutput(
      `Note: ${normalized} is large (${kb}kb). ` +
        `Consider token-goat skeleton or token-goat section.`,
    )
  }

  recordFileRead(normalized)
  return passOutput()
}

registerHook('pre_tool_use', preReadHandler, { toolName: 'Read' })
