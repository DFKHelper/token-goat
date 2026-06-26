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
import {
  extractMarkdownHeadings,
  formatHeadingTree,
  getWellKnownSections,
  extractChangelogVersionHint,
  MARKDOWN_SIZE_THRESHOLD,
} from './hints/markdown_hints.js'
import { dispatchFileTypeHandler, FILE_TYPE_THRESHOLDS } from './hints/file_type_handler.js'

/** True when `basename` is a tsconfig or jsconfig file. */
function isTsConfigFile(basename: string): boolean {
  const lower = basename.toLowerCase()
  return /^tsconfig(\..+)?\.json$/i.test(lower) || lower === 'jsconfig.json'
}

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

  if (normalized.toLowerCase().endsWith('.tsbuildinfo')) {
    return denyOutput(
      'This is a TypeScript incremental build cache file. You don\'t need to read it directly.',
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

  if (isTsConfigFile(basename) && wasFileReadThisSession(normalized)) {
    recordFileRead(normalized)
    return contextOutput(
      'Already read ' + basename + '. Use `token-goat section "' + normalized + '::compilerOptions"` ' +
      'to extract compiler options, or `token-goat config-get ' + normalized + ' compilerOptions.target` for a single value.',
    )
  }

  if (isManifestFile(basename) && wasFileReadThisSession(normalized)) {
    recordFileRead(normalized)
    return contextOutput(
      'You\'ve already read ' + basename + '. Use `token-goat section "' + normalized + '::<field>"` ' +
      'or `token-goat config-get ' + normalized + ' <key>` to extract just the value you need.',
    )
  }

  // Markdown large-file intercept
  const isMarkdown = /\.(md|mdx|markdown|rst)$/i.test(basename)
  if (isMarkdown) {
    let fileContent: string | null = null
    try {
      const sz = statSize(normalized)
      if (sz !== null && sz >= MARKDOWN_SIZE_THRESHOLD) {
        fileContent = fs.readFileSync(normalized, 'utf8')
      }
    } catch {
      // best-effort
    }
    if (fileContent !== null) {
      const headings = extractMarkdownHeadings(fileContent)
      if (headings.length >= 3) {
        recordFileRead(normalized)
        const hintText = formatHeadingTree(headings, normalized)
        const wellKnown = getWellKnownSections(basename)
        const wellKnownText =
          wellKnown.length > 0
            ? '\nQuick access: ' +
              wellKnown
                .map(s => 'token-goat section "' + normalized + '::' + s + '"')
                .join(' | ')
            : ''
        const changelogExtra = basename.toLowerCase() === 'changelog.md'
          ? extractChangelogVersionHint(fileContent, normalized)
          : ''
        return denyOutput(hintText + wellKnownText + changelogExtra)
      }
    }
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

  // Universal file type handler (catch-all for non-code, non-markdown large files)
  const fileTypeExt = path.extname(normalized).slice(1).toLowerCase()
  const binaryExts = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'ott', 'odp'])
  const textTypeExts = new Set(['html', 'htm', 'xhtml', 'txt', 'log', 'out', 'err', 'trace', 'csv', 'tsv'])
  const fileStatSize = size ?? statSize(normalized) ?? 0
  const isKnownFileType = binaryExts.has(fileTypeExt) || textTypeExts.has(fileTypeExt)
  if (isKnownFileType || fileStatSize >= FILE_TYPE_THRESHOLDS.generic) {
    let ftContent = ''
    if (!binaryExts.has(fileTypeExt)) {
      try {
        ftContent = fs.readFileSync(normalized, 'utf8')
      } catch {
        // best-effort — empty content will pass through
      }
    }
    const ftResult = dispatchFileTypeHandler(normalized, ftContent, fileStatSize)
    if (ftResult?.shouldBlock) {
      recordFileRead(normalized)
      return denyOutput(ftResult.message)
    }
  }

  recordFileRead(normalized)
  return passOutput()
}

registerHook('pre_tool_use', preReadHandler, { toolName: 'Read' })
registerHook('pre_tool_use', preReadHandler, { toolName: 'Grep' })
