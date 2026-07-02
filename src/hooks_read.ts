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
import { isWindows } from './util.js'
import { loadConfig } from './config.js'
import { recordFileRead, wasFileReadThisSession, getSessionFiles, markFileTruncated, wasFileTruncatedThisSession, getSessionId, recordLargeFileHintPending, takePendingLargeFileHint, exportSessionState } from './session.js'
import { writeSessionManifest, readAllSessionManifests } from './compact.js'
import { store as snapshotStore, load as snapshotLoad } from './snapshots.js'
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
import { recordStat } from './stats.js'
import { findProject, makeProjectAt } from './project.js'
import { isCompactStale, contentHash, getCompactAnySessionSync } from './skill_cache.js'
import { isImagePath } from './image_shrink.js'

/** True when `basename` is a tsconfig or jsconfig file. */
function isTsConfigFile(basename: string): boolean {
  const lower = basename.toLowerCase()
  return /^tsconfig(\..+)?\.json$/i.test(lower) || lower === 'jsconfig.json'
}

/**
 * Size at or above which a read is nudged toward a surgical command.
 *
 * Shared with {@link FILE_TYPE_THRESHOLDS}.generic — both represent the same
 * "large file" boundary and must stay numerically identical, or a file sized
 * between the two literals gets a hard block from the universal file-type
 * handler (checked further below) instead of the softer "large" context nudge
 * this branch would otherwise give it.
 */
const LARGE_FILE_BYTES = FILE_TYPE_THRESHOLDS.generic

/** Re-read deny threshold: files above this size that have already been read are denied rather than just hinted. */
const REREAD_DENY_BYTES = 50 * 1024

/** First-read deny threshold: files this large are denied even on the first read (too expensive to load). */
const LARGE_FILE_DENY_BYTES = 500 * 1024

/** Check if a path is under node_modules/. Case-insensitive on Windows, case-sensitive elsewhere. */
function isNodeModulesPath(p: string): boolean {
  const check = isWindows() ? p.toLowerCase() : p
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

/**
 * True when the path is a Claude session artifact file: a tasks output blob
 * (`…/tasks/<id>.output`) or a tool-results file (`…/tool-results/<id>.txt`).
 * Matches both forward-slash and backslash separators.
 */
function isSessionArtifactFile(filePath: string): boolean {
  if (/[/\\]tasks[/\\][a-z0-9]+\.output$/i.test(filePath)) return true
  if (/[/\\]tool-results[/\\][a-z0-9]+\.txt$/i.test(filePath)) return true
  return false
}

/**
 * Recall hint for a session artifact file. Names a `bash-output --file` command
 * that actually works: the artifact is on disk but not in the bash-output cache,
 * so a bare `bash-output --tail N` (no id/path) or `bash-output <id>` (id is not
 * a cache key) both error. `--file <path>` reads the file and applies the slice.
 */
function sessionArtifactRecall(filePath: string): string {
  return 'Use `token-goat bash-output --file "' + filePath + '" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.'
}

/** Best-effort file size in bytes, or null when the file cannot be stat'd. */
function statSize(absPath: string): number | null {
  try {
    return fs.statSync(absPath).size
  } catch {
    return null
  }
}

/** Source/style/data extensions eligible for diff-on-reread when serve_diff_on_reread is enabled. */
const DIFFABLE_SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|json|jsonc|py|go|rs|java|rb|php|swift|kt|c|h|cpp|cc|cxx|hpp|cs|sql|yaml|yml|toml)$/i

/** Generate extension-aware surgical-read hint for a file. */
function surgicalHint(filePath: string, basename: string): string {
  const isDocFile = /\.(md|mdx|rst|txt)$/i.test(basename)
  const isSectionFile = /\.(json|jsonc|css|scss|sass|less|yaml|yml|toml)$/i.test(basename)

  if (isDocFile) {
    return 'Use `token-goat section "' + filePath + '::HeadingName"` to extract a part.'
  } else if (isSectionFile) {
    return 'Use `token-goat section "' + filePath + '::name"` to extract a part.'
  } else {
    return 'Use `token-goat read "' + filePath + '::SymbolName"` for one function or `token-goat skeleton "' + filePath + '"` for structure.'
  }
}

// Check if a file is a skill definition file (SKILL.md in ~/.claude/skills/<name>/SKILL.md) and return the skill name, or null.
function detectSkillFile(filePath: string): string | null {
  const match = filePath.match(/\.claude[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i)
  return match ? match[1]! : null
}

/**
 * Compute a compact unified-style diff between two versions of a doc file.
 *
 * Strips the common prefix/suffix to isolate the changed region, then formats
 * it as a truncated unified diff (at most 50 changed lines). Returns '' when
 * the contents are identical.
 */
export function buildLineDiff(oldContent: string, newContent: string, label: string): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  // Common prefix
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  // Common suffix (not overlapping the prefix region)
  let oldSuffix = oldLines.length
  let newSuffix = newLines.length
  while (oldSuffix > prefix && newSuffix > prefix && oldLines[oldSuffix - 1] === newLines[newSuffix - 1]) {
    oldSuffix--
    newSuffix--
  }

  if (prefix === oldLines.length && prefix === newLines.length) return ''

  const changedOld = oldLines.slice(prefix, oldSuffix)
  const changedNew = newLines.slice(prefix, newSuffix)

  const MAX_LINES = 50
  const out: string[] = [
    `--- ${label} (prev)`,
    `+++ ${label} (current)`,
    `@@ -${prefix + 1},${changedOld.length} +${prefix + 1},${changedNew.length} @@`,
  ]

  const removedLines = changedOld.map(l => `-${l}`)
  const addedLines = changedNew.map(l => `+${l}`)
  const allChanges = [...removedLines, ...addedLines]

  if (allChanges.length <= MAX_LINES) {
    out.push(...allChanges)
  } else {
    out.push(...allChanges.slice(0, MAX_LINES))
    out.push(`... (${allChanges.length - MAX_LINES} more changed lines)`)
  }

  return out.join('\n')
}

/**
 * True if a sibling session's manifest (see compact.ts) shows a recent read of filePath.
 * Delegates the directory walk / staleness / corrupt-JSON handling to readAllSessionManifests
 * instead of re-implementing it, so both cross-session dedup and compaction share one reader.
 */
function scanCrossSessionManifests(
  projectRoot: string,
  projectHash: string,
  filePath: string,
  ttlSecs: number,
): boolean {
  try {
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/')
    const manifests = readAllSessionManifests(projectHash, ttlSecs)

    for (const data of manifests) {
      const files = data['files']
      if (!Array.isArray(files)) continue

      for (const entry of files) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>)['rel_path'] === relPath &&
          typeof (entry as Record<string, unknown>)['hit_count'] === 'number' &&
          ((entry as Record<string, unknown>)['hit_count'] as number) > 0
        ) {
          return true
        }
      }
    }
  } catch {
    // Fail-soft: ignore any errors in cross-session scanning
  }

  return false
}

/**
 * pre_tool_use handler for Read/Grep/Glob.
 *
 * Returns `deny` for: node_modules, lock files, .tsbuildinfo, build artifacts,
 * large markdown files with headings, re-reads of files >50KB, first reads of
 * files >500KB, and file-type specific oversize files.
 * Returns `context` for: manifest/tsconfig re-reads, and large files 100KB–500KB.
 * Returns `pass` otherwise.
 * Always records the read so the re-read hint fires on the next touch.
 */
export function preReadHandler(event: HookEvent): HookOutput {
  let filePath = getFilePath(event)
  if (filePath === undefined && event.toolName === 'Grep') {
    const rawPath = event.toolInput['path']
    if (typeof rawPath === 'string' && rawPath !== '') filePath = rawPath
  }
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

  // Skill file stale compact advisory.
  const skillName = detectSkillFile(normalized)
  if (skillName && basename === 'SKILL.md') {
    try {
      const body = fs.readFileSync(normalized, 'utf-8')
      const bodySha = contentHash(body)
      const compact = getCompactAnySessionSync(skillName)
      const stale = isCompactStale(compact, skillName, bodySha)
      if (stale === true) {
        recordFileRead(normalized)
        return contextOutput(
          'This skill\'s cached compact is stale. Run `token-goat skill-compact ' + skillName + '` to regenerate it.',
        )
      }
    } catch {
      // fail-soft: ignore errors and continue with normal read processing
    }
  }

  // Markdown large-file intercept
  const isMarkdown = /\.(md|mdx|markdown|rst)$/i.test(basename)
  if (isMarkdown) {
    let fileContent: string | null = null
    let markdownSize: number | null = null
    try {
      const sz = statSize(normalized)
      if (sz !== null && sz >= MARKDOWN_SIZE_THRESHOLD) {
        markdownSize = sz
        fileContent = fs.readFileSync(normalized, 'utf8')
      }
    } catch {
      // best-effort
    }
    if (fileContent !== null) {
      const headings = extractMarkdownHeadings(fileContent)
      if (headings.length >= 3) {
        const alreadyRead = wasFileReadThisSession(normalized)
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
        const message = hintText + wellKnownText + changelogExtra
        // A re-read is always hard-denied. A first read is also hard-denied when the file
        // is at or above the generic large-file deny threshold: this branch returns before
        // the size-based deny further below ever runs, so it must enforce that gate itself.
        const tooLargeForFirstRead = markdownSize !== null && markdownSize >= LARGE_FILE_DENY_BYTES
        return alreadyRead || tooLargeForFirstRead ? denyOutput(message) : contextOutput(message)
      }
    }
  }

  // Item 8: MEMORY.md re-read denial — content is already in the compact manifest. Also generalised to any .md file under a memory/ directory (e.g. memory/project_findings.md).
  const isMemoryMd = (
    normalized.toLowerCase().includes('memory/memory.md') ||
    /[/\\]memory[/\\][^/\\]+\.md$/i.test(normalized)
  )
  if (isMemoryMd && wasFileReadThisSession(normalized)) {
    recordFileRead(normalized)
    recordStat('session_hint', 0, 0)
    const isMainMemory = basename.toLowerCase() === 'memory.md'
    return denyOutput(
      isMainMemory
        ? "MEMORY.md was read this session. Its content is in the compact manifest as 'session memory'."
        : normalized + ' was already read this session. Memory files rarely change mid-session. Use `token-goat section "' + normalized + '::SectionHeading"` to extract one section.',
    )
  }

  // Item 5: .improve-state-*.json re-read denial
  if (/^\.improve-state-.*\.json$/.test(basename) && wasFileReadThisSession(normalized)) {
    recordFileRead(normalized)
    recordStat('session_hint', 0, 0)
    return denyOutput(
      'Orchestrator state already read this session. ' + sessionArtifactRecall(normalized),
    )
  }

  // .env re-read: deny after first read (size thresholds never catch tiny env files)
  if (/^\.env(\.\w+)?$/.test(basename) && wasFileReadThisSession(normalized)) {
    recordFileRead(normalized)
    recordStat('session_hint', 0, 0)
    return denyOutput(
      normalized + ' was already read this session. Environment files rarely change mid-session. ' +
      'Use `token-goat config-get ' + normalized + ' KEY_NAME` to extract a specific variable.',
    )
  }

  // Session artifact re-read dedup: tasks/<id>.output and tool-results/<id>.txt On first read of tasks/*.output, emit a proactive hint toward --tail/--grep. On re-reads (either type), inject a diff or "unchanged" denial using the same snapshot logic as doc files.
  if (isSessionArtifactFile(normalized)) {
    if (wasFileReadThisSession(normalized)) {
      if (wasFileTruncatedThisSession(normalized)) {
        recordFileRead(normalized)
        recordStat('session_hint', 0, 0)
        return denyOutput(
          'File was truncated on last read. ' + sessionArtifactRecall(normalized),
        )
      }
      const artifactSessionId = getSessionId()
      const oldArtifactSnap = snapshotLoad(artifactSessionId, normalized)
      if (oldArtifactSnap !== null) {
        try {
          const sz = statSize(normalized)
          if (sz !== null && sz <= 256 * 1024) {
            const currentContent = fs.readFileSync(normalized, 'utf8')
            const TRUNC_MARKER = '\n<snapshot truncated at '
            const oldRaw = oldArtifactSnap.toString('utf8')
            const truncIdx = oldRaw.indexOf(TRUNC_MARKER)
            const oldContent = truncIdx >= 0 ? oldRaw.slice(0, truncIdx) : oldRaw
            if (oldContent === currentContent) {
              recordFileRead(normalized)
              recordStat('session_hint', 0, 0)
              return denyOutput(
                basename + ' is unchanged since last read. ' + sessionArtifactRecall(normalized),
              )
            }
            const diff = buildLineDiff(oldContent, currentContent, basename)
            if (diff !== '') {
              recordFileRead(normalized)
              const savedBytes = Math.max(0, currentContent.length - diff.length)
              recordStat('session_hint', savedBytes, Math.round(savedBytes / 4))
              return denyOutput(
                'Content changed since last read of ' + basename + '. Here is what changed:\n\n' +
                '```diff\n' + diff + '\n```\n\n' + sessionArtifactRecall(normalized),
              )
            }
          }
        } catch {
          // best-effort — fall through to generic deny
        }
      }
      // No snapshot or file too large — generic re-read denial
      recordFileRead(normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        normalized + ' was already read this session. ' + sessionArtifactRecall(normalized),
      )
    }
    // First read of tasks/*.output — allow but emit a proactive hint
    if (/[/\\]tasks[/\\][a-z0-9]+\.output$/i.test(normalized)) {
      recordFileRead(normalized)
      return contextOutput('Session transcript: ' + sessionArtifactRecall(normalized))
    }
    // First read of tool-results/*.txt — fall through to normal handling
  }

  // Doc-file auto-diff on re-read: .md/.mdx/.rst/.txt files that have been read before get a compact diff (or "unchanged") instead of a wasteful full re-read, provided a snapshot was captured by postReadHandler on the first read. When serve_diff_on_reread is enabled, source/style/data files also get diffs. Falls through to the generic wasFileReadThisSession block when no snapshot exists, preserving existing context vs. deny behavior for un-snapshotted files.
  const isDocDiffable = /\.(md|mdx|markdown|rst|txt)$/i.test(basename)
  const isSourceDiffable = loadConfig().hints.serve_diff_on_reread && DIFFABLE_SOURCE_RE.test(basename)
  if ((isDocDiffable || isSourceDiffable) && wasFileReadThisSession(normalized)) {
    // Truncation takes priority: redirect to skeleton/surgical reads.
    if (wasFileTruncatedThisSession(normalized)) {
      recordFileRead(normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        'File was truncated on last read (>33K tokens). Use `token-goat skeleton "' + normalized + '"` for structure or `token-goat read "' + normalized + '::SymbolName"` for one function.',
      )
    }

    const sessionId = getSessionId()
    const oldSnap = snapshotLoad(sessionId, normalized)

    if (oldSnap !== null) {
      try {
        const sz = statSize(normalized)
        if (sz !== null && sz <= 256 * 1024) {
          const currentContent = fs.readFileSync(normalized, 'utf8')
          const TRUNC_MARKER = '\n<snapshot truncated at '
          const oldRaw = oldSnap.toString('utf8')
          const truncIdx = oldRaw.indexOf(TRUNC_MARKER)
          const oldContent = truncIdx >= 0 ? oldRaw.slice(0, truncIdx) : oldRaw

          if (oldContent === currentContent) {
            recordFileRead(normalized)
            recordStat('session_hint', 0, 0)
            return denyOutput(
              basename + ' is unchanged since last read. ' +
              surgicalHint(normalized, basename),
            )
          }

          const diff = buildLineDiff(oldContent, currentContent, basename)
          if (diff !== '') {
            // Savings guard for non-doc files: only serve diff if it's meaningfully smaller than a full re-read
            if (isSourceDiffable && !isDocDiffable && diff.length > currentContent.length * 0.6) {
              // Diff is not a good savings — fall through to generic deny block below
            } else {
              recordFileRead(normalized)
              const savedBytes = Math.max(0, currentContent.length - diff.length)
              recordStat('session_hint', savedBytes, Math.round(savedBytes / 4))
              return denyOutput(
                'Content changed since last read of ' + basename + '. Here is what changed:\n\n' +
                '```diff\n' + diff + '\n```\n\n' +
                surgicalHint(normalized, basename),
              )
            }
          }
        }
      } catch {
        // best-effort — fall through to generic wasFileReadThisSession logic
      }
    }

    // No snapshot yet or file too large — fall through to generic wasFileReadThisSession logic below, which uses readCount and file size to pick context vs. deny.
  }

  // Cross-session read dedup: check if another session (different sessionId) working in the same project already read this file recently
  const config = loadConfig()
  if (config.hints.cross_session_read_dedup && !wasFileReadThisSession(normalized)) {
    try {
      const cwd = (event.raw && typeof event.raw === 'object' && 'cwd' in event.raw && typeof event.raw['cwd'] === 'string') ? event.raw['cwd'] : process.cwd()
      let project = findProject(cwd)
      if (!project) {
        project = makeProjectAt(cwd)
      }

      const relPath = path.relative(project.root, normalized).replace(/\\/g, '/')
      if (!relPath.startsWith('..')) {
        const ttlSecs = config.hints.cross_session_read_dedup_ttl_secs
        if (scanCrossSessionManifests(project.root, project.hash, normalized, ttlSecs)) {
          recordFileRead(normalized)
          return contextOutput(
            'This file may have already been read by another agent/session working in this project recently. ' +
            'If you are a subagent continuing shared work, consider whether you already have this content from context, ' +
            'or use `token-goat read ' + normalized + '::SymbolName` for a narrower slice instead of a full re-read.',
          )
        }
      }
    } catch {
      // Fail-soft: ignore any errors in cross-session checking
    }
  }

  if (!isImagePath(normalized) && wasFileReadThisSession(normalized)) {
    const entry = getSessionFiles().get(normalized)
    const reads = entry?.readCount ?? 1
    const plural = reads === 1 ? 'read' : 'reads'
    recordFileRead(normalized)
    const rereadBytes = statSize(normalized) ?? 0
    recordStat('session_hint', rereadBytes, Math.round(rereadBytes / 4))

    const config = loadConfig()
    if (config.hints.log_large_file_hint_outcomes) {
      const pendingSize = takePendingLargeFileHint(normalized)
      if (pendingSize !== null) {
        recordStat('large_file_hint_ignored', 0, 0, undefined, `${normalized} (${pendingSize} bytes) — hint fired but file was fully re-read instead of surgically read`)
      }
    }

    // Item 1: file was truncated on last read — surgical reads only
    if (wasFileTruncatedThisSession(normalized)) {
      return denyOutput(
        'File was truncated on last read (>33K tokens). Use `token-goat skeleton "' + normalized + '"` for structure or `token-goat read "' + normalized + '::SymbolName"` for one function.',
      )
    }

    // Item 2: any .md/.mdx/.markdown/.rst already read this session is denied on 2nd+ read regardless of size
    if (/\.(md|mdx|markdown|rst)$/i.test(basename)) {
      return denyOutput(
        'Markdown file already read this session. Use `token-goat section "' + normalized + '::HeadingName"` to read one section.',
      )
    }

    // Count-based deny: 3rd+ read of source files — even small ones that the size threshold misses
    const isSourceExt = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|swift|kt|cpp|c|h)$/i.test(basename)
    if (isSourceExt && reads >= 2) {
      recordStat('read_count_deny', rereadBytes, Math.round(rereadBytes / 4))
      return denyOutput(
        'Read this file ' + reads + ' times already — use `token-goat read "' + normalized + '::Symbol"`, `token-goat skeleton ' + normalized + '`, or `token-goat outline ' + normalized + '` to pull just the part you need.',
      )
    }

    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + normalized + '::SectionName"` to read one section.'
      : 'Use token-goat read/section/symbol to re-read surgically.'
    if (rereadBytes >= REREAD_DENY_BYTES || reads >= 2) {
      return denyOutput(
        normalized + ' was already read this session (' + reads + ' ' + plural + '). ' + hint,
      )
    }
    return contextOutput(
      'Note: ' + normalized + ' was already read this session (' + reads + ' ' + plural + '). ' +
        hint,
    )
  }

  const size = statSize(normalized)
  if (size !== null && size >= LARGE_FILE_BYTES && !isImagePath(normalized)) {
    const kb = Math.round(size / 1024)
    const config = loadConfig()
    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + normalized + '::SectionName"` to read one section.'
      : 'Consider token-goat skeleton or token-goat section.'
    recordStat('session_hint', size, Math.round(size / 4))
    if (size >= LARGE_FILE_DENY_BYTES) {
      // The read is blocked outright, so it never actually happened — don't record it
      // against re-read dedup. Otherwise a retry (this hook doesn't distinguish
      // offset/limit params from a plain re-read) hits "already read this session"
      // instead of this same actionable deny, leaving no way to follow its own advice.
      return denyOutput(
        normalized + ' is very large (' + kb + 'KB). ' + hint + ' Use Read with offset/limit to sample specific sections.',
      )
    }
    recordFileRead(normalized)
    if (config.hints.log_large_file_hint_outcomes) {
      recordLargeFileHintPending(normalized, size)
    }
    return contextOutput(
      'Note: ' + normalized + ' is large (' + kb + 'KB). ' +
        hint,
    )
  }

  // Universal file type handler (catch-all for non-code, non-markdown large files)
  const fileTypeExt = path.extname(normalized).slice(1).toLowerCase()
  const binaryExts = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'ott', 'odp'])
  const textTypeExts = new Set(['html', 'htm', 'xhtml', 'txt', 'log', 'out', 'err', 'trace', 'csv', 'tsv'])
  const fileStatSize = size ?? statSize(normalized) ?? 0
  const isKnownFileType = binaryExts.has(fileTypeExt) || textTypeExts.has(fileTypeExt)
  if (!isImagePath(normalized) && (isKnownFileType || fileStatSize >= FILE_TYPE_THRESHOLDS.generic)) {
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
      // Blocked read never happened — don't count it against re-read dedup. These
      // messages (large txt/log/csv/generic) tell the caller to retry with
      // offset/limit; recording the read here would make that retry hit the
      // "already read this session" deny instead, with no way to ever read the file.
      return denyOutput(ftResult.message)
    }
  }

  recordFileRead(normalized)
  return passOutput()
}

registerHook('pre_tool_use', preReadHandler, { toolName: 'Read' })
registerHook('pre_tool_use', preReadHandler, { toolName: 'Grep' })

/** Extract tool response text from a post_tool_use Read event. */
function extractReadOutput(raw: Record<string, unknown>): string {
  const resp = raw['tool_response']
  if (typeof resp === 'string') return resp
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>
    for (const key of ['output', 'content', 'text', 'body']) {
      if (typeof r[key] === 'string') return r[key] as string
    }
  }
  return ''
}

/**
 * post_tool_use handler for the Read tool.
 *
 * Detects truncation markers in the tool response and flags the file so the
 * next pre_tool_use for the same file returns an immediate deny with a
 * surgical-read hint instead of allowing another full (and expensive) read.
 */
export function postReadHandler(event: HookEvent): HookOutput {
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  const normalized = normalizePath(filePath)
  const respText = extractReadOutput(event.raw)
  if (respText.includes('[Truncated:') || respText.includes('Truncated: PARTIAL view')) {
    markFileTruncated(normalized)
  }

  // Snapshot doc file content so the next re-read can inject a diff instead of the full file.
  const postBasename = path.basename(normalized)
  const diffSourcesEnabled = loadConfig().hints.serve_diff_on_reread
  if (/\.(md|mdx|markdown|rst|txt)$/i.test(postBasename) || isSessionArtifactFile(normalized) || (diffSourcesEnabled && DIFFABLE_SOURCE_RE.test(postBasename))) {
    try {
      const sz = statSize(normalized)
      if (sz !== null && sz <= 256 * 1024) {
        const content = fs.readFileSync(normalized)
        snapshotStore(getSessionId(), normalized, content)
      }
    } catch {
      // best-effort; never block the hook
    }
  }

  // Cross-session manifest recording: write this session's reads for other sessions to discover
  if (loadConfig().hints.cross_session_read_dedup) {
    try {
      const cwd = (event.raw && typeof event.raw === 'object' && 'cwd' in event.raw && typeof event.raw['cwd'] === 'string') ? event.raw['cwd'] : process.cwd()
      let project = findProject(cwd)
      if (!project) {
        project = makeProjectAt(cwd)
      }

      const sessionState = exportSessionState()
      const mappedFiles: Array<{rel_path: string; hit_count: number}> = []

      for (const fileEntry of sessionState.files) {
        const relPath = path.relative(project.root, fileEntry.path).replace(/\\/g, '/')
        if (!relPath.startsWith('..')) {
          mappedFiles.push({
            rel_path: relPath,
            hit_count: fileEntry.readCount,
          })
        }
      }

      writeSessionManifest(project.hash, getSessionId(), { files: mappedFiles })
    } catch {
      // Fail-soft: ignore any errors in manifest writing
    }
  }

  return passOutput()
}

registerHook('post_tool_use', postReadHandler, { toolName: 'Read' })
