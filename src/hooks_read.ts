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
import * as path from 'node:path'

import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { normalizePath } from './paths.js'
import { recordFileRead, wasFileReadThisSession, getSessionFiles } from './session.js'
import { contextOutput, passOutput, denyOutput } from './hooks_common.js'
import type { HookOutput } from './types.js'
import { buildPackageManifestHint } from './hints.js'
import { isLockFile, isManifestFile, isInBuildDir, isGeneratedFile } from './hints/lang_patterns.js'

/** Size at or above which a read is nudged toward a surgical command. */
const LARGE_FILE_BYTES = 100 * 1024

/** Check if a path is under node_modules/. Case-insensitive on Windows, case-sensitive elsewhere. */
function isNodeModulesPath(path: string): boolean {
  const isWindows = process.platform === 'win32'
  const check = isWindows ? path.toLowerCase() : path
  // Match both forward slashes (normalized) and backslashes (Windows).
  return check.includes('/node_modules/') || check.includes('\\node_modules\\')
}

/** True for documentation/markup files where `section` applies but `skeleton` and `symbol` do not. */
function _isDocFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return (
    lower.endsWith('.md') ||
    lower.endsWith('.mdx') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.rst')
  )
}

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

  if (isNodeModulesPath(normalized)) {
    return denyOutput(
      'node_modules is typically noise; use npm ls, npm outdated, or npm audit instead for dependency info. ' +
      'To force access, use: token-goat read node_modules/package/file.js::symbol-name or token-goat section node_modules/package/file.js::heading',
    )
  }

  const basename = path.basename(normalized)

  if (isLockFile(basename)) {
    return denyOutput(
      'Lock files are rarely useful to read in full. Use `token-goat section "' + normalized + '::<section>"` ' +
      'to extract a specific dependency, or read the relevant manifest instead.',
    )
  }

  if (isInBuildDir(normalized) || isGeneratedFile(normalized)) {
    return denyOutput(
      'Generated/build artifact — read the source file instead.',
    )
  }

  const manifestHint = buildPackageManifestHint({ file_path: normalized })
  if (manifestHint) {
    recordFileRead(normalized)
    return contextOutput(manifestHint.text)
  }

  if (isManifestFile(basename) && wasFileReadThisSession(normalized)) {
    recordFileRead(normalized)
    return contextOutput(
      'You\'ve already read ' + basename + '. Use `token-goat section "' + normalized + '::<field>"` ' +
      'or `token-goat config-get ' + normalized + ' <key>` to extract just the value you need.',
    )
  }

  if (wasFileReadThisSession(normalized)) {
    const entry = getSessionFiles().get(normalized)
    const reads = entry?.readCount ?? 1
    const plural = reads === 1 ? 'read' : 'reads'
    recordFileRead(normalized)
    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + normalized + '::SectionName"` to read one section.'
      : 'Use token-goat read/section/symbol to re-read surgically.'
    return contextOutput(
      'Note: ' + normalized + ' was already read this session (' + reads + ' ' + plural + '). ' +
        hint,
    )
  }

  const size = statSize(normalized)
  if (size !== null && size >= LARGE_FILE_BYTES) {
    const kb = Math.round(size / 1024)
    recordFileRead(normalized)
    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + normalized + '::SectionName"` to read one section.'
      : 'Consider token-goat skeleton or token-goat section.'
    return contextOutput(
      'Note: ' + normalized + ' is large (' + kb + 'kb). ' +
        hint,
    )
  }

  recordFileRead(normalized)
  return passOutput()
}

registerHook('pre_tool_use', preReadHandler, { toolName: 'Read' })
registerHook('pre_tool_use', preReadHandler, { toolName: 'Grep' })
