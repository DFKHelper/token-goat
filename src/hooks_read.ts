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
import { foldPath } from './util.js'
import { loadConfig } from './config.js'
import { recordFileRead, wasFileReadThisSession, getSessionFileEntry, markFileTruncated, wasFileTruncatedThisSession, getSessionId, recordLargeFileHintPending, takePendingLargeFileHint, exportSessionState } from './session.js'
import { writeSessionManifest, readAllSessionManifests, loadSessionCache, getContextPressure } from './compact.js'
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
import { dispatchFileTypeHandler, FILE_TYPE_THRESHOLDS, BYTE_RANGE_ADVICE } from './hints/file_type_handler.js'
import { recordStat } from './stats.js'
import { findProject, makeProjectAt } from './project.js'
import { isCompactStale, contentHash, getCompactAnySessionSync } from './skill_cache.js'
import { isImagePath } from './image_shrink.js'
import { compactPathFor, isCompactFresh, readCompactBody } from './doc_compact.js'
import { getOrCreateSidecar, NB_STRIP_MIN_SAVINGS } from './notebook_compact.js'
import { dataDir } from './constants.js'
import { detectLanguage } from './parser_types.js'

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

/**
 * Size gate for the *first* read of a tasks/<id>.output file. Unlike the markdown
 * intercept (MARKDOWN_SIZE_THRESHOLD) and the generic large-file gate (LARGE_FILE_BYTES)
 * in this same function, the tasks/*.output first-read branch used to let any size
 * through unconditionally with only an advisory hint -- a real session showed a
 * 57,920-byte first read going through unsized. Small task outputs stay a cheap
 * advisory pass; anything at or above this is denied outright, same as a re-read.
 */
const TASK_OUTPUT_DENY_BYTES = 20 * 1024

/**
 * Multiplies `hints.large_read_redirect_bytes` down as context pressure rises, so a first read
 * that's fine when the session is cool gets redirected to a surgical read sooner once the window
 * is nearly full. Mirrors the pre-TS-port pressure-scaling design (commit 66a25e88): cool keeps the
 * configured base, critical tightens to ~18% of it.
 */
const DENY_THRESHOLD_TIER_MULTIPLIERS: Record<'cool' | 'warm' | 'hot' | 'critical', number> = {
  cool: 1.0,
  warm: 0.67,
  hot: 0.33,
  critical: 0.18,
}

/** First-read deny threshold: files this large are denied even on the first read (too expensive to load), tightened by the current session's context pressure. */
function largeFileDenyBytes(): number {
  const base = loadConfig().hints.large_read_redirect_bytes
  const tier = getContextPressure(loadSessionCache(getSessionId()) ?? undefined).tier
  return Math.round(base * DENY_THRESHOLD_TIER_MULTIPLIERS[tier])
}

/** Check if a path is under node_modules/. Case-insensitive on case-insensitive filesystems (Windows, macOS by default), case-sensitive elsewhere. */
function isNodeModulesPath(p: string): boolean {
  const check = foldPath(p)
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

/** Reads a numeric tool-input param (Read's `offset`/`limit`), tolerating a numeric string. */
function readIntToolInput(event: HookEvent, key: string): number | undefined {
  const value = event.toolInput[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Cap on bytes scanned while estimating an offset/limit slice — keeps the estimate itself cheap. */
const SLICE_ESTIMATE_SCAN_CAP_BYTES = 2 * 1024 * 1024

/** Below this many lines-scanned-so-far, a scan that didn't close its window reads as near-single-line. */
const NEAR_SINGLE_LINE_SCAN_THRESHOLD = 20

interface SliceScan {
  /** Bytes counted as falling inside the requested [offset, offset+limit) window so far. */
  bytes: number
  /** True when `bytes` is safe to treat as the real slice size: either the window genuinely
   *  closed (a line number >= offset+limit was reached), or the scan reached real EOF — both
   *  give full visibility into what a Read call would actually return. False only for the
   *  scan-cap case where the window hadn't even started (e.g. a very deep offset into a huge
   *  file) — there, `bytes` is just "0 so far" and would be misleading to trust. */
  trustworthy: boolean
  /** True when the scan ended (EOF or cap) after seeing very few line breaks relative to bytes
   *  scanned — the base64/minified-blob shape where there's ~1 "line" to window over, so
   *  line-based offset/limit can't help regardless of what's requested. */
  nearSingleLine: boolean
}

/**
 * Scans the 1-indexed line window [offset, offset + limit) — matching the Read tool's own
 * offset/limit semantics — without reading the whole file into memory. Reads in bounded
 * chunks and stops as soon as the window closes, EOF is hit, or the scan cap is hit.
 *
 * Returns null only when the file can't be opened at all.
 */
function scanRequestedSlice(absPath: string, offset: number, limit: number): SliceScan | null {
  const windowEnd = offset + limit // exclusive, 1-indexed line numbers
  let fd: number
  try {
    fd = fs.openSync(absPath, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    let lineNumber = 1
    let sliceBytes = 0
    let totalScanned = 0
    for (;;) {
      if (totalScanned >= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
        const nearSingleLine = lineNumber < NEAR_SINGLE_LINE_SCAN_THRESHOLD
        return { bytes: sliceBytes, trustworthy: nearSingleLine, nearSingleLine }
      }
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null)
      if (bytesRead === 0) {
        // Real EOF — full visibility into the file, so `bytes` is exact even if the window
        // never formally "closed" (the file simply has fewer lines than the request asked for).
        return {
          bytes: sliceBytes,
          trustworthy: true,
          nearSingleLine: lineNumber < NEAR_SINGLE_LINE_SCAN_THRESHOLD && totalScanned > 2000,
        }
      }
      totalScanned += bytesRead
      for (let i = 0; i < bytesRead; i++) {
        if (lineNumber >= offset && lineNumber < windowEnd) sliceBytes++
        if (buf[i] === 0x0a) {
          lineNumber++
          if (lineNumber >= windowEnd) return { bytes: sliceBytes, trustworthy: true, nearSingleLine: false }
        }
      }
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // best-effort
    }
  }
}

/** Outcome of trying to size a Read call's requested offset/limit window instead of the whole file. */
type RequestedSlice =
  | { readonly kind: 'bytes'; readonly bytes: number } // a trustworthy slice size — safe to gate on
  | { readonly kind: 'unbounded' } // no offset/limit given, missing limit, or couldn't be cheaply sized — gate on the whole file
  | { readonly kind: 'nearSingleLine' } // content shape makes any line window meaningless regardless of what's requested

/**
 * Reads `offset`/`limit` off the Read tool call (when present) and estimates the size of
 * just that slice, so a genuinely small, bounded request isn't gated on the whole file's
 * size. Only Read tool calls carry offset/limit — Grep/Glob events always resolve to
 * `unbounded` since they have no notion of a line window.
 */
function estimateRequestedSlice(event: HookEvent, absPath: string): RequestedSlice {
  const offset = readIntToolInput(event, 'offset')
  const limit = readIntToolInput(event, 'limit')
  // A non-positive limit (zero or negative) has no well-defined real-world slice size: fed
  // straight into scanRequestedSlice, offset + limit <= offset makes the window close before it
  // opens, so the byte counter never advances and the very first line break trips the "window
  // closed" branch -- fabricating a trustworthy-looking {bytes: 0} instead of reporting that the
  // requested size genuinely can't be estimated. Treat it exactly like a missing limit: fall back
  // to gating on the whole file.
  if (limit === undefined || limit <= 0) return { kind: 'unbounded' }
  const effectiveOffset = offset !== undefined && offset >= 1 ? offset : 1
  const scan = scanRequestedSlice(absPath, effectiveOffset, limit)
  if (scan === null) return { kind: 'unbounded' }
  if (scan.nearSingleLine) return { kind: 'nearSingleLine' }
  if (scan.trustworthy) return { kind: 'bytes', bytes: scan.bytes }
  return { kind: 'unbounded' } // cap hit before the window even started — can't tell cheaply, fall back safely
}

/** Phrases the retry advice for a large-file deny based on whether/how offset/limit would help. */
function describeSliceAdvice(slice: RequestedSlice, absPath: string): string {
  if (slice.kind === 'nearSingleLine') {
    return BYTE_RANGE_ADVICE(absPath)
  }
  if (slice.kind === 'bytes') {
    return (
      `The requested offset/limit range is still ~${Math.round(slice.bytes / 1024)}KB — ` +
      'narrow the range further (a smaller limit) rather than reading the whole file.'
    )
  }
  return 'Use Read with offset/limit to sample specific sections.'
}

/** Source/style/data extensions eligible for diff-on-reread when serve_diff_on_reread is enabled. */
const DIFFABLE_SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|json|jsonc|py|go|rs|java|rb|php|swift|kt|c|h|cpp|cc|cxx|hpp|cs|sql|yaml|yml|toml)$/i

/**
 * Extensions with a tree-sitter language adapter AND where `token-goat skeleton`/`outline`
 * are the intended re-read tool (markdown, json, yaml, etc. also have adapters but keep
 * their own dedicated read path -- e.g. `token-goat section` -- so they're deliberately
 * excluded here even though EXTENSION_LANGUAGE recognizes them). Previously omitted several
 * real language extensions (.cs, .mjs/.cjs/.mts/.cts, .cc/.cxx/.hpp/.hxx, .kts, .pyi) and
 * wrongly included `.swift`, which has no adapter at all.
 */
const SOURCE_EXT_RE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|rb|php|kt|kts|cpp|cc|cxx|hpp|hxx|c|h|cs)$/i

function isSourceExtension(basename: string): boolean {
  if (SOURCE_EXT_RE.test(basename)) return true
  const language = detectLanguage(basename)
  return language === 'apex' || language === 'salesforce_metadata' || language === 'salesforce_markup'
}

// Extensions dispatchFileTypeHandler() (hints/file_type_handler.ts) recognizes and gives
// type-specific advice for (real headers/sample rows for CSV, always-block for PDF, etc).
// BINARY_FILE_TYPE_EXTS/TEXT_FILE_TYPE_EXTS mirror that dispatcher's own binary/text split
// (binary ones are never read as utf8 text before dispatch) -- single source of truth for
// both the early large-file-gate exemption below and the universal handler further down.
const BINARY_FILE_TYPE_EXTS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'ott', 'odp'])
const TEXT_FILE_TYPE_EXTS = new Set(['html', 'htm', 'xhtml', 'txt', 'log', 'out', 'err', 'trace', 'csv', 'tsv', 'vtt', 'srt'])
const DISPATCHED_FILE_TYPE_EXTS = new Set([...BINARY_FILE_TYPE_EXTS, ...TEXT_FILE_TYPE_EXTS])

function isDispatchedFileType(basename: string): boolean {
  return DISPATCHED_FILE_TYPE_EXTS.has(path.extname(basename).slice(1).toLowerCase())
}

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
    // Case-insensitive filesystems (Windows, macOS): rel_path is stored case-preserved by
    // writeSessionManifest/readAllSessionManifests, so a sibling session that read the same
    // physical file under a different literal casing (e.g. "Worker.ts" vs "worker.ts") must
    // still fold-match here -- foldPath (util.ts) is already used elsewhere in this file (see
    // isNodeModulesPath above).
    const foldedRelPath = foldPath(relPath)
    const manifests = readAllSessionManifests(projectHash, ttlSecs)

    for (const data of manifests) {
      const files = data['files']
      if (!Array.isArray(files)) continue

      for (const entry of files) {
        if (typeof entry !== 'object' || entry === null) continue
        const entryRelPath = (entry as Record<string, unknown>)['rel_path']
        const entryHitCount = (entry as Record<string, unknown>)['hit_count']
        if (
          typeof entryRelPath === 'string' &&
          foldPath(entryRelPath) === foldedRelPath &&
          typeof entryHitCount === 'number' &&
          entryHitCount > 0
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
// Grep's cost/relevance depends on its search pattern, not the file's total size or content —
// re-scoping several Greps at the same path is a legitimate workflow, so Grep must never feed
// the Read-specific read-count that the count-based deny check (and every "already read X"
// hint below) relies on. Route every recordFileRead call in this handler through here so a
// Grep on a file can never poison a subsequent single Read's count.
function recordActualRead(event: HookEvent, filePath: string): void {
  if (event.toolName === 'Grep') return
  recordFileRead(filePath)
}

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
    recordActualRead(event, normalized)
    return contextOutput(manifestHint.text)
  }

  if (isTsConfigFile(basename) && wasFileReadThisSession(normalized)) {
    recordActualRead(event, normalized)
    return contextOutput(
      'Already read ' + basename + '. Use `token-goat section "' + normalized + '::compilerOptions"` ' +
      'to extract compiler options, or `token-goat config-get ' + normalized + ' compilerOptions.target` for a single value.',
    )
  }

  if (isManifestFile(basename) && wasFileReadThisSession(normalized)) {
    recordActualRead(event, normalized)
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
        recordActualRead(event, normalized)
        return contextOutput(
          'This skill\'s cached compact is stale. Run `token-goat skill-compact ' + skillName + '` to regenerate it.',
        )
      }
    } catch {
      // fail-soft: ignore errors and continue with normal read processing
    }
  }

  // Stable-doc compact serving: if a fresh extractive compact sidecar exists for
  // this doc (built via `token-goat compact-doc`), serve its content in place of
  // the full file — 80-95% smaller. Runs ahead of the markdown large-file
  // intercept below, which is the expensive full-read path this preempts.
  // Gated by [hints] stable_doc_compacts (default on).
  if (loadConfig().hints.stable_doc_compacts && _isDocFile(normalized)) {
    const compactPath = compactPathFor(normalized)
    if (isCompactFresh(compactPath, normalized)) {
      const compactBody = readCompactBody(compactPath)
      if (compactBody !== null) {
        recordActualRead(event, normalized)
        const fullSize = statSize(normalized) ?? 0
        const savedBytes = Math.max(0, fullSize - compactBody.length)
        recordStat('session_hint', savedBytes, Math.round(savedBytes / 4))
        return denyOutput(
          'Serving the extractive compact sidecar in place of the full file ' +
          '(source unchanged since the last `compact-doc` build):\n\n' +
          compactBody +
          '\n\nUse `token-goat compact-doc "' + normalized + '" --force` to rebuild it, ' +
          'or `token-goat compact-doc "' + normalized + '" --show` to view it directly. ' +
          'To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
        )
      }
    }
  }

  // Notebook output stripping: .ipynb reads get code-cell `outputs` and
  // `execution_count` fields stripped before the content reaches the model
  // (cell source and metadata are preserved). Restores the original
  // Python-era behavior, which was never config-gated, unlike the
  // doc-compact block above, which always applies for eligible files.
  // Falls through unchanged for malformed/non-notebook JSON, binary files,
  // or when stripping wouldn't save enough to be worth denying the
  // original Read over.
  const isNotebook = /\.ipynb$/i.test(basename)
  if (isNotebook) {
    try {
      const rawBytes = fs.readFileSync(normalized)
      const [sidecarPath] = getOrCreateSidecar(rawBytes, dataDir())
      const sidecarContent = fs.readFileSync(sidecarPath, 'utf-8')
      const savedBytes = rawBytes.length - sidecarContent.length
      if (savedBytes >= NB_STRIP_MIN_SAVINGS) {
        recordActualRead(event, normalized)
        recordStat('session_hint', savedBytes, Math.round(savedBytes / 4))
        return denyOutput(
          'Serving the output-stripped notebook in place of the full file ' +
          '(code-cell outputs and execution counts removed; source and metadata preserved):\n\n' +
          sidecarContent +
          '\n\nTo edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
        )
      }
    } catch {
      // Malformed JSON, non-notebook JSON shape, or a binary file with an
      // .ipynb extension: fall through to the normal read path unchanged.
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
        let message = hintText + wellKnownText + changelogExtra
        // A re-read is always hard-denied. A first read is also hard-denied when the file
        // is at or above the generic large-file deny threshold: this branch returns before
        // the size-based deny further below ever runs, so it must enforce that gate itself.
        const tooLargeForFirstRead = markdownSize !== null && markdownSize >= largeFileDenyBytes()
        if (alreadyRead || tooLargeForFirstRead) {
          // A genuinely-first read that's blocked outright (tooLargeForFirstRead, not
          // alreadyRead) never actually happened, so don't record it against re-read dedup --
          // mirrors the generic large-file path's same rule further below. Otherwise a retry
          // (offset/limit) on the same file hits the "already read this session" 2nd-read deny
          // instead of this same heading-tree guidance, which a genuinely-unread file should
          // still get. A deny that IS because of a real prior read (alreadyRead) still records,
          // same as every other re-read-deny branch in this file.
          if (alreadyRead) {
            recordActualRead(event, normalized)
          }
          message += ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.'
          return denyOutput(message)
        }
        recordActualRead(event, normalized)
        return contextOutput(message)
      }
    }
  }

  // Item 8: MEMORY.md re-read denial — content is already in the compact manifest. Also generalised to any .md file under a memory/ directory (e.g. memory/project_findings.md).
  const isMemoryMd = (
    normalized.toLowerCase().includes('memory/memory.md') ||
    /[/\\]memory[/\\][^/\\]+\.md$/i.test(normalized)
  )
  if (isMemoryMd && wasFileReadThisSession(normalized)) {
    recordActualRead(event, normalized)
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
    recordActualRead(event, normalized)
    recordStat('session_hint', 0, 0)
    return denyOutput(
      'Orchestrator state already read this session. ' + sessionArtifactRecall(normalized),
    )
  }

  // .env re-read: deny after first read (size thresholds never catch tiny env files)
  if (/^\.env(\.\w+)?$/.test(basename) && wasFileReadThisSession(normalized)) {
    recordActualRead(event, normalized)
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
        recordActualRead(event, normalized)
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
              recordActualRead(event, normalized)
              recordStat('session_hint', 0, 0)
              return denyOutput(
                basename + ' is unchanged since last read. ' + sessionArtifactRecall(normalized),
              )
            }
            const diff = buildLineDiff(oldContent, currentContent, basename)
            if (diff !== '') {
              recordActualRead(event, normalized)
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
      recordActualRead(event, normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        normalized + ' was already read this session. ' + sessionArtifactRecall(normalized),
      )
    }
    // First read of tasks/*.output — size-gated like every other first-read intercept in
    // this function. A small task output is a cheap advisory pass; at/above
    // TASK_OUTPUT_DENY_BYTES it's denied outright, forcing even the first read through
    // bash-output --file/--tail instead of one free unsized full dump.
    if (/[/\\]tasks[/\\][a-z0-9]+\.output$/i.test(normalized)) {
      const outputSize = statSize(normalized)
      recordActualRead(event, normalized)
      if (outputSize !== null && outputSize >= TASK_OUTPUT_DENY_BYTES) {
        recordStat('session_hint', outputSize, Math.round(outputSize / 4))
        return denyOutput(
          'Session transcript is large (' + Math.round(outputSize / 1024) + 'KB). ' + sessionArtifactRecall(normalized),
        )
      }
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
      recordActualRead(event, normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        'File was truncated on last read (>33K tokens). Use `token-goat skeleton "' + normalized + '"` for structure or `token-goat read "' + normalized + '::SymbolName"` for one function.' +
        ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
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
            recordActualRead(event, normalized)
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
              recordActualRead(event, normalized)
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
          recordActualRead(event, normalized)
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

  // Grep's cost/relevance depends on its pattern, not just the directory/file it's scoped to —
  // re-scoping several Greps at the same path with different patterns is a legitimate workflow,
  // so Grep is exempt from the count-based re-read dedup below (unlike a repeated whole-file Read).
  if (event.toolName !== 'Grep' && !isImagePath(normalized) && wasFileReadThisSession(normalized)) {
    const entry = getSessionFileEntry(normalized)
    const reads = entry?.readCount ?? 1
    const plural = reads === 1 ? 'read' : 'reads'
    recordActualRead(event, normalized)
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
        'File was truncated on last read (>33K tokens). Use `token-goat skeleton "' + normalized + '"` for structure or `token-goat read "' + normalized + '::SymbolName"` for one function.' +
        ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
      )
    }

    // Item 2: any .md/.mdx/.markdown/.rst already read this session is denied on 2nd+ read regardless of size
    if (/\.(md|mdx|markdown|rst)$/i.test(basename)) {
      return denyOutput(
        'Markdown file already read this session. Use `token-goat section "' + normalized + '::HeadingName"` to read one section.' +
        ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
      )
    }

    // Count-based deny: 3rd+ read of source files — even small ones that the size threshold misses
    const isSourceExt = isSourceExtension(basename)
    if (isSourceExt && reads >= 2) {
      recordStat('read_count_deny', rereadBytes, Math.round(rereadBytes / 4))
      return denyOutput(
        'Read this file ' + reads + ' times already — use `token-goat read "' + normalized + '::Symbol"`, `token-goat skeleton ' + normalized + '`, or `token-goat outline ' + normalized + '` to pull just the part you need.' +
        ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
      )
    }

    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + normalized + '::SectionName"` to read one section.'
      : 'Use token-goat read/section/symbol to re-read surgically.'
    if (rereadBytes >= REREAD_DENY_BYTES || reads >= 2) {
      return denyOutput(
        normalized + ' was already read this session (' + reads + ' ' + plural + '). ' + hint +
        ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
      )
    }
    return contextOutput(
      'Note: ' + normalized + ' was already read this session (' + reads + ' ' + plural + '). ' +
        hint,
    )
  }

  const size = statSize(normalized)
  // Grep never reads/returns the whole file — its cost is the search pattern's match count,
  // not the file's total size (same rationale as the re-read dedup exemption above), and
  // estimateRequestedSlice() always reports 'unbounded' for it (no offset/limit on its schema),
  // which would otherwise gate it on the full file size and hard-deny it with an "edit it
  // anyway" message that makes no sense for a search operation.
  if (event.toolName !== 'Grep' && size !== null && size >= LARGE_FILE_BYTES && !isImagePath(normalized) && !isDispatchedFileType(normalized)) {
    // A genuine, bounded offset/limit request gates on the requested slice's size instead
    // of the whole file's — a small window into a huge file should be let through. Whole-file
    // requests (no offset/limit, or an unboundable window) keep gating on the real file size.
    const slice = estimateRequestedSlice(event, normalized)
    const gateSize = slice.kind === 'bytes' ? Math.min(slice.bytes, size) : size

    if (gateSize < LARGE_FILE_BYTES) {
      recordActualRead(event, normalized)
      return passOutput()
    }

    const kb = Math.round(size / 1024)
    const config = loadConfig()
    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + normalized + '::SectionName"` to read one section.'
      : 'Consider token-goat skeleton or token-goat section.'
    recordStat('session_hint', size, Math.round(size / 4))
    if (gateSize >= largeFileDenyBytes()) {
      // The read is blocked outright, so it never actually happened — don't record it
      // against re-read dedup. Otherwise a retry (this hook doesn't distinguish
      // offset/limit params from a plain re-read) hits "already read this session"
      // instead of this same actionable deny, leaving no way to follow its own advice.
      return denyOutput(
        normalized + ' is very large (' + kb + 'KB). ' + hint + ' ' + describeSliceAdvice(slice, normalized) +
        ' To edit it anyway, use `token-goat replace "' + normalized + '" --old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --from <newfile>` to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.',
      )
    }
    recordActualRead(event, normalized)
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
  const fileStatSize = size ?? statSize(normalized) ?? 0
  const isKnownFileType = DISPATCHED_FILE_TYPE_EXTS.has(fileTypeExt)
  // Same Grep exemption as the large-file gate above: this catch-all's per-type handlers
  // (handleTxt/handleCsv/handleHtml/handleGenericLarge/handlePdf/handleOfficeBinary) block
  // purely on the whole file's size/type, with no notion of a search pattern — without this,
  // a Grep call would fall through from the exempted gate above straight into an equally
  // tool-blind deny here for any large .txt/.log/.csv/.html/binary file.
  if (event.toolName !== 'Grep' && !isImagePath(normalized) && (isKnownFileType || fileStatSize >= FILE_TYPE_THRESHOLDS.generic)) {
    let ftContent = ''
    if (!BINARY_FILE_TYPE_EXTS.has(fileTypeExt)) {
      try {
        ftContent = fs.readFileSync(normalized, 'utf8')
      } catch {
        // best-effort — empty content will pass through
      }
    }
    // Same offset/limit honoring as above: gate the per-type handlers (handleTxt/handleCsv/
    // handleHtml/handleGenericLarge) on the requested slice's size when one was given.
    const ftSlice = estimateRequestedSlice(event, normalized)
    const ftEffectiveLength = ftSlice.kind === 'bytes' ? Math.min(ftSlice.bytes, fileStatSize) : fileStatSize
    const ftResult = dispatchFileTypeHandler(normalized, ftContent, ftEffectiveLength)
    if (ftResult?.shouldBlock) {
      // Blocked read never happened — don't count it against re-read dedup. These
      // messages (large txt/log/csv/generic) tell the caller to retry with
      // offset/limit; recording the read here would make that retry hit the
      // "already read this session" deny instead, with no way to ever read the file.
      return denyOutput(ftResult.message)
    }
  }

  recordActualRead(event, normalized)
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
/** Count text lines the way `wc -l` does: newline count, plus one for a final non-empty
 *  line with no trailing newline. Empty content has zero lines. Used to gate the
 *  post-read structural-navigation hint against `post_read_code_compress.min_lines`. */
function countTextLines(content: string): number {
  if (content.length === 0) return 0
  const parts = content.split(/\r\n|\r|\n/)
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

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

  // Post-read structural-navigation hint: once a just-read source file crosses
  // post_read_code_compress.min_lines, nudge toward token-goat skeleton/outline instead of
  // a future full re-read. Only fires for extensions with a tree-sitter language adapter
  // (SOURCE_EXT_RE), where skeleton/outline actually produce structure.
  if (isSourceExtension(postBasename)) {
    try {
      const sz = statSize(normalized)
      if (sz !== null && sz <= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
        const lineCount = countTextLines(fs.readFileSync(normalized, 'utf8'))
        const minLines = loadConfig().post_read_code_compress.min_lines
        if (lineCount >= minLines) {
          recordStat('session_hint', sz, Math.round(sz / 4))
          return contextOutput(
            normalized + ' is ' + lineCount + ' lines. Use `token-goat skeleton "' + normalized + '"` or `token-goat outline "' + normalized + '"` for structural navigation instead of a future full re-read.',
          )
        }
      }
    } catch {
      // best-effort; never block the hook
    }
  }

  return passOutput()
}

registerHook('post_tool_use', postReadHandler, { toolName: 'Read' })
