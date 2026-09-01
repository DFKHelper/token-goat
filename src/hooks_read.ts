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

import { getCwd, getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { applyHintTracking, classifyReadHint, meetsSavingsFloor } from './hint_stats.js'
import { displaySafePath, normalizePath } from './paths.js'
import { decodeSource, foldPath, isWithinQuietHours, statSize, toKB, PER_FILE_COUNTERFACTUAL_CEILING, IDENTICAL_READ_MIN_BODY_BYTES, containsLineRun } from './util.js'
import { loadConfig } from './config.js'
import { recordFileRead, wasFileReadThisSession, getCompactedAt, getSessionFileEntry, getSessionFiles, markFileTruncated, wasFileTruncatedThisSession, getSessionId, recordLargeFileHintPending, takePendingLargeFileHint, exportSessionState, markHintShown, recordFileServedOutput, getFileServedOutputs } from './session.js'
import { storeBashOutputSync, getBashOutput } from './bash_output_cache.js'
import { writeSessionManifest, readAllSessionManifests, loadSessionCache, getContextPressure } from './compact.js'
import { store as snapshotStore, load as snapshotLoad } from './snapshots.js'
import { contextOutput, passOutput, denyOutput, extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS } from './hooks_common.js'
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
import { fenceUntrustedFileContent } from './injection_scan.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { findProject, makeProjectAt } from './project.js'
import { isCompactStale, contentHash, getCompactAnySessionSync } from './skill_cache.js'
import { isImagePath } from './image_shrink.js'
import { compactPathFor, isCompactFresh, readCompactBody } from './doc_compact.js'
import { findVerifiedFileEvidence, recordEvidence } from './evidence_cache.js'
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

/** Bytes a pre-read intercept may honestly claim it saved. The counterfactual is the Read this intercept replaced, and that Read would itself have been truncated, so it is capped at PER_FILE_COUNTERFACTUAL_CEILING before anything the intercept still emits (a compact body, a stripped notebook, a diff) is subtracted back off. */
function counterfactualCredit(counterfactualBytes: number, emittedBytes = 0): number {
  return Math.max(0, Math.min(counterfactualBytes, PER_FILE_COUNTERFACTUAL_CEILING) - emittedBytes)
}

/** Check if a path is under node_modules/. Case-insensitive on case-insensitive filesystems (Windows, macOS by default), case-sensitive elsewhere. */
function isNodeModulesPath(p: string): boolean {
  const check = foldPath(p)
  // Match both forward slashes (normalized) and backslashes (Windows).
  return check.includes('/node_modules/') || check.includes('\\node_modules\\')
}

/** Forward-slashed path of `target` relative to `root`, or null when `target` is not actually
 *  inside `root`. A bare `!rel.startsWith('..')` check (the previous form of this guard, at both
 *  cross-session-manifest call sites below) is not sufficient on Windows: when `root` and
 *  `target` are on different drive letters, `path.relative` returns `target`'s own absolute path
 *  unchanged rather than a `..`-prefixed relative path (this is documented Node behavior, not a
 *  bug in path.relative), so a file on an unrelated drive silently passed the guard and got
 *  written into (or matched against) the project's cross-session read-dedup manifest as if it
 *  were a real in-project relative path -- leaking an out-of-project absolute path into a
 *  manifest meant to hold only project-relative paths. Mirrors pack.ts's `isPathWithinRoot`
 *  guard, which already includes the `!path.isAbsolute(rel)` check this lacked. */
export function relPathWithinRoot(root: string, target: string): string | null {
  const rel = path.relative(root, target).replace(/\\/g, '/')
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
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
function sessionArtifactRecall(rawPath: string): string {
  const filePath = displaySafePath(rawPath)
  return 'Use `token-goat bash-output --file "' + filePath + '" --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.'
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
function describeSliceAdvice(slice: RequestedSlice, rawAbsPath: string): string {
  const absPath = displaySafePath(rawAbsPath)
  if (slice.kind === 'nearSingleLine') {
    return BYTE_RANGE_ADVICE(absPath)
  }
  if (slice.kind === 'bytes') {
    return (
      `The requested offset/limit range is still ~${toKB(slice.bytes)}KB — ` +
      'narrow the range further (a smaller limit) rather than reading the whole file.'
    )
  }
  return 'Use Read with offset/limit to sample specific sections.'
}

/** Source/style/data extensions eligible for diff-on-reread when serve_diff_on_reread is enabled. */
const DIFFABLE_SOURCE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|json|jsonc|py|go|rs|java|rb|php|kt|c|h|cpp|cc|cxx|hpp|cs|sql|yaml|yml|toml|ps1|psm1|cls|trigger|swift|scala|sc|lua|ex|exs|dart|zig|r|R)$/i

/**
 * Extensions with a tree-sitter language adapter AND where `token-goat skeleton`/`outline`
 * are the intended re-read tool (markdown, json, yaml, etc. also have adapters but keep
 * their own dedicated read path -- e.g. `token-goat section` -- so they're deliberately
 * excluded here even though EXTENSION_LANGUAGE recognizes them). Previously omitted several
 * real language extensions (.cs, .mjs/.cjs/.mts/.cts, .cc/.cxx/.hpp/.hxx, .kts, .pyi) and
 * wrongly included `.swift`, which at the time had no adapter at all (it now does -- see
 * `src/languages/swift.ts` -- so it belongs here again). Also previously omitted
 * .ps1/.psm1 (powershell) and .cls/.trigger (apex), both of which have real adapters.
 */
const SOURCE_EXT_RE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|rb|php|kt|kts|cpp|cc|cxx|hpp|hxx|c|h|cs|ps1|psm1|cls|trigger|swift|scala|sc|lua|ex|exs|dart|zig|r|R)$/i

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

/** Generate extension-aware surgical-read hint for a file, gated on
 *  hints.min_file_lines_for_hint — files below the threshold return '' since a surgical-read
 *  suggestion isn't worth the noise for a file that's already small enough to read whole. */
function surgicalHint(filePath: string, basename: string, lineCount: number): string {
  if (lineCount < loadConfig().hints.min_file_lines_for_hint) return ''

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
 * Compute a compact unified-style diff between two versions of a doc file, reporting whether the body had to be truncated.
 *
 * Strips the common prefix/suffix to isolate the changed region, then formats it as a truncated unified diff (at most 50 changed lines). `text` is '' when the contents are identical. `truncated` is true when the changed region did not fit in the 50-line cap, i.e. the body deliberately omits changed lines -- callers that decide whether to serve the diff INSTEAD of the file must consult it, because the omitted lines are content the reader still needs (see {@link loadSnapshotDiff}).
 */
function buildLineDiffDetailed(oldContent: string, newContent: string, label: string): { readonly text: string; readonly truncated: boolean } {
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

  if (prefix === oldLines.length && prefix === newLines.length) return { text: '', truncated: false }

  const changedOld = oldLines.slice(prefix, oldSuffix)
  const changedNew = newLines.slice(prefix, newSuffix)

  const MAX_LINES = 50
  const removedLines = changedOld.map(l => `-${l}`)
  const addedLines = changedNew.map(l => `+${l}`)
  const allChanges = [...removedLines, ...addedLines]

  // The header's hunk counts must describe what the body actually shows, not the
  // pre-truncation totals -- otherwise `@@ -x,{changedOld.length} +x,{changedNew.length} @@`
  // overstates the line counts on any diff over MAX_LINES, breaking any consumer that
  // trusts the header (a real unified-diff parser, or a human eyeballing it) instead of
  // recounting the body itself. Derive the shown removed/added counts from the same slice
  // point used for the body below.
  const shownRemoved = Math.min(removedLines.length, MAX_LINES)
  const shownAdded = Math.max(0, Math.min(addedLines.length, MAX_LINES - shownRemoved))

  const out: string[] = [
    `--- ${label} (prev)`,
    `+++ ${label} (current)`,
    `@@ -${prefix + 1},${shownRemoved} +${prefix + 1},${shownAdded} @@`,
  ]

  const truncated = allChanges.length > MAX_LINES
  if (!truncated) {
    out.push(...allChanges)
  } else {
    out.push(...allChanges.slice(0, MAX_LINES))
    out.push(`... (${allChanges.length - MAX_LINES} more changed lines)`)
  }

  return { text: out.join('\n'), truncated }
}

/** String-only view of {@link buildLineDiffDetailed}, for the display-only callers (`cli.ts`'s history/restore previews, `confirm_apply.ts`'s change preview) that render a diff alongside the content rather than in place of it, and so do not care whether the body was truncated. */
export function buildLineDiff(oldContent: string, newContent: string, label: string): string {
  return buildLineDiffDetailed(oldContent, newContent, label).text
}

type SnapshotDiffResult =
  | { readonly kind: 'unchanged'; readonly currentContent: string }
  | { readonly kind: 'diff'; readonly diff: string; readonly savedBytes: number; readonly currentContent: string }
  | { readonly kind: 'none' }

/**
 * Shared by the session-artifact and doc/source re-read paths below: load the prior snapshot
 * for `normalized` under `sessionId`, strip its trailing `<snapshot truncated at ` marker if
 * present, and compare to the file's current on-disk content. Size-gated at 256KB and fails
 * soft to `{kind: 'none'}` on any missing snapshot, oversized file, or read/stat error --
 * callers fall through to their own generic re-read handling in that case, exactly as before
 * this was factored out of two independent ~25-line copies. `currentContent` is threaded back
 * out on the non-'none' variants so callers that need it (e.g. for `countTextLines`) don't
 * re-read the file a second time. Callers own their own messaging, stat name, and any
 * additional savings-floor gate.
 */
function loadSnapshotDiff(sessionId: string, normalized: string, basename: string): SnapshotDiffResult {
  const oldSnap = snapshotLoad(sessionId, normalized)
  if (oldSnap === null) return { kind: 'none' }
  try {
    const sz = statSize(normalized)
    if (sz === null || sz > 256 * 1024) return { kind: 'none' }
    const currentContent = fs.readFileSync(normalized, 'utf8')
    const TRUNC_MARKER = '\n<snapshot truncated at '
    const oldRaw = oldSnap.toString('utf8')
    const truncIdx = oldRaw.indexOf(TRUNC_MARKER)
    const oldContent = truncIdx >= 0 ? oldRaw.slice(0, truncIdx) : oldRaw
    if (oldContent === currentContent) return { kind: 'unchanged', currentContent }
    const { text: diff, truncated } = buildLineDiffDetailed(oldContent, currentContent, basename)
    if (diff === '') return { kind: 'none' }
    // A truncated body is never servable in place of the file. savedBytes below is measured against the diff TEXT, so every changed line the 50-line cap omits makes the diff shorter and the apparent saving larger -- the widest changes would clear the savings floor most easily while hiding the most content, and the caller's "Here is what changed" wording would be false. Fail soft to 'none' so the caller falls through to its generic re-read handling, exactly as it already does when a diff misses the savings floor.
    if (truncated) return { kind: 'none' }
    const savedBytes = Math.max(0, currentContent.length - diff.length)
    return { kind: 'diff', diff, savedBytes, currentContent }
  } catch {
    return { kind: 'none' }
  }
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
    const relPath = relPathWithinRoot(projectRoot, filePath)
    if (relPath === null) return false
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

/**
 * contextOutput, degraded to passOutput during hints.quiet_hours. Only the advisory/
 * informational hint paths (contextOutput -- lets the call proceed, injects a suggestion)
 * are gated this way; correctness-relevant denyOutput blocks (truncation, oversized-file,
 * reread-deny) are never suppressed by quiet hours.
 */
function quietContextOutput(context: string): HookOutput {
  if (isWithinQuietHours(loadConfig().hints.quiet_hours)) {
    return passOutput()
  }
  return contextOutput(context)
}

/**
 * Suffix appended to the large-file structural-nav hint when context pressure is elevated,
 * gated on hints.context_threshold_advisory. Only 'hot'/'critical' warrant surfacing this --
 * 'cool'/'warm' are the normal operating range and would just be noise on every large-file hint.
 */
function contextPressureAdvisorySuffix(): string {
  if (!loadConfig().hints.context_threshold_advisory) return ''
  const tier = getContextPressure(loadSessionCache(getSessionId()) ?? undefined).tier
  if (tier === 'hot') {
    return ' Context pressure: hot -- consider wrapping up soon or running /compact.'
  }
  if (tier === 'critical') {
    return ' Context pressure: critical -- strongly consider /compact now.'
  }
  return ''
}

/**
 * True if `normalized` is among the `n` most-recently-read files this session (ranked by
 * lastReadAt descending, ties broken by path for determinism). `n` <= 0 means no exemption
 * ever applies. Used to exempt just-read files from the re-read-deny hints below.
 *
 * The path tiebreak uses a plain ordinal (UTF-16 code-unit) comparison, never localeCompare()
 * -- with no explicit locale it resolves to the host's default ICU collation (Windows regional
 * setting, or LANG/LC_ALL on Linux/CI), which genuinely differs across locales for non-ASCII
 * paths. lastReadAt ties are common in practice: a reloaded session's entries come from
 * session_store.ts's second-granularity persisted timestamps (`lastReadTs * 1000`), so any two
 * files read within the same second tie exactly, and a locale-dependent tiebreak could
 * silently protect a different file on a different machine. Same fix already applied to
 * graph_commands.ts's compareHopEntries for the identical reason.
 */
function isProtectedRecentRead(normalized: string, n: number): boolean {
  if (n <= 0) return false
  // Pre-compaction reads are excluded from the ranking entirely, not just from being protected themselves: this exemption is about content the model still holds, so a stale entry must not occupy one of the n protection slots and push a genuinely-recent post-compaction read out of the window.
  const compactedAt = getCompactedAt()
  const ranked = Array.from(getSessionFiles().entries()).filter(([, e]) => e.lastReadAt >= compactedAt).sort((a, b) => {
    const byRecency = b[1].lastReadAt - a[1].lastReadAt
    return byRecency !== 0 ? byRecency : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  const rank = ranked.findIndex(([filePath]) => filePath === normalized)
  return rank !== -1 && rank < n
}

function preReadHandlerInner(event: HookEvent): HookOutput {
  let filePath = getFilePath(event)
  if (filePath === undefined && event.toolName === 'Grep') {
    const rawPath = event.toolInput['path']
    if (typeof rawPath === 'string' && rawPath !== '') filePath = rawPath
  }
  if (filePath === undefined) return passOutput()

  const normalized = normalizePath(filePath)
  const shown = displaySafePath(normalized)

  if (isNodeModulesPath(normalized)) {
    return denyOutput(
      'node_modules is typically noise; use npm ls, npm outdated, or npm audit instead for dependency info. ' +
      'To force access, use: token-goat read node_modules/package/file.js::symbol-name or token-goat section node_modules/package/file.js::heading',
    )
  }

  if (event.toolName === 'Read' && loadConfig().hints.cross_session_read_dedup) {
    try {
      const cwd = getCwd(event) ?? process.cwd()
      const project = findProject(cwd) ?? makeProjectAt(cwd)
      const current = fs.readFileSync(normalized, 'utf8')
      const evidence = findVerifiedFileEvidence(project.root, normalized, current)
      if (evidence !== null) {
        recordStat('evidence_cache_hit', 0)
        return quietContextOutput(
          `Verified cross-session evidence exists for this unchanged file (${evidence.id}). ` +
          'Use a narrow read instead of loading the full file again.',
        )
      }
    } catch {
      // A cache miss or unreadable file must preserve the normal Read path.
    }
  }

  const basename = path.basename(normalized)

  if (isLockFile(basename)) {
    return denyOutput(
      'Lock files are rarely useful to read in full. Use `token-goat section "' + shown + '::<section>"` ' +
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

  if (!wasFileReadThisSession(normalized)) {
    const manifestHint = buildPackageManifestHint({ file_path: normalized })
    if (manifestHint) {
      recordActualRead(event, normalized)
      markHintShown('manifest-hint:' + normalized)
      return quietContextOutput(manifestHint.text)
    }
  }

  if (isTsConfigFile(basename) && wasFileReadThisSession(normalized)) {
    recordActualRead(event, normalized)
    return quietContextOutput(
      'Already read ' + basename + '. Use `token-goat section "' + shown + '::compilerOptions"` ' +
      'to extract compiler options, or `token-goat config-get ' + shown + ' compilerOptions.target` for a single value.',
    )
  }

  if (isManifestFile(basename) && wasFileReadThisSession(normalized)) {
    recordActualRead(event, normalized)
    return quietContextOutput(
      'You\'ve already read ' + basename + '. Use `token-goat section "' + shown + '::<field>"` ' +
      'or `token-goat config-get ' + shown + ' <key>` to extract just the value you need.',
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
        return quietContextOutput(
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
  // Grep needs to search the doc's live content for a pattern — serving the compact
  // sidecar instead would swap out the actual search target and skip the search
  // entirely, so Grep is exempt from this intercept (same rationale as the
  // count-based re-read dedup and large-file gate exemptions further below).
  if (event.toolName !== 'Grep' && loadConfig().hints.stable_doc_compacts && _isDocFile(normalized)) {
    const compactPath = compactPathFor(normalized)
    if (isCompactFresh(compactPath, normalized)) {
      const compactBody = readCompactBody(compactPath)
      if (compactBody !== null) {
        recordActualRead(event, normalized)
        const fullSize = statSize(normalized) ?? 0
        const savedBytes = counterfactualCredit(fullSize, compactBody.length)
        recordStat('session_hint', savedBytes, savedTokensFromBytes(savedBytes))
        return denyOutput(
          'Serving the extractive compact sidecar in place of the full file ' +
          '(source unchanged since the last `compact-doc` build):\n\n' +
          fenceUntrustedFileContent(compactBody) +
          '\n\nUse `token-goat compact-doc "' + shown + '" --force` to rebuild it, ' +
          'or `token-goat compact-doc "' + shown + '" --show` to view it directly. ' +
          editAnywayHint(normalized),
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
  // Grep needs to search the notebook's actual content, not the output-stripped
  // sidecar this intercept would serve instead — exempt it from this intercept
  // (same rationale as the doc-compact exemption above).
  if (event.toolName !== 'Grep' && isNotebook) {
    try {
      const rawBytes = fs.readFileSync(normalized)
      const [sidecarPath] = getOrCreateSidecar(rawBytes, dataDir())
      const sidecarContent = fs.readFileSync(sidecarPath, 'utf-8')
      const savedBytes = rawBytes.length - sidecarContent.length
      if (savedBytes >= NB_STRIP_MIN_SAVINGS) {
        recordActualRead(event, normalized)
        const nbCredit = counterfactualCredit(rawBytes.length, sidecarContent.length)
        recordStat('session_hint', nbCredit, savedTokensFromBytes(nbCredit))
        return denyOutput(
          'Serving the output-stripped notebook in place of the full file ' +
          '(code-cell outputs and execution counts removed; source and metadata preserved):\n\n' +
          fenceUntrustedFileContent(sidecarContent) +
          '\n\n' + editAnywayHint(normalized),
        )
      }
    } catch {
      // Malformed JSON, non-notebook JSON shape, or a binary file with an
      // .ipynb extension: fall through to the normal read path unchanged.
    }
  }

  // Markdown large-file intercept
  const isMarkdown = /\.(md|mdx|markdown|rst)$/i.test(basename)
  // Grep's operation is a search over the file's content, not a read of the whole
  // file — the heading-tree deny/hint below only makes sense for an actual Read,
  // so Grep is exempt from this intercept (same rationale as the doc-compact and
  // notebook exemptions above).
  if (event.toolName !== 'Grep' && isMarkdown) {
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
        // Filter the hardcoded per-basename shortcut list down to headings that actually
        // exist in this file — otherwise a README missing e.g. 'API' or 'Getting Started'
        // gets a hint recommending a `section` command that will just 404.
        const headingTextsLower = new Set(headings.map((h) => h.text.trim().toLowerCase()))
        const wellKnown = getWellKnownSections(basename).filter((s) => headingTextsLower.has(s.trim().toLowerCase()))
        const wellKnownText =
          wellKnown.length > 0
            ? '\nQuick access: ' +
              wellKnown
                .map(s => 'token-goat section "' + shown + '::' + s + '"')
                .join(' | ')
            : ''
        const changelogExtra = basename.toLowerCase() === 'changelog.md'
          ? extractChangelogVersionHint(fileContent, normalized)
          : ''
        // hintText (the heading tree) and changelogExtra (version headings) are verbatim bytes from the file, so they are fenced as untrusted data before being spliced into a message the harness attributes to token-goat. wellKnownText is not fenced: it is built from token-goat's own hardcoded shortcut list plus the file path, with no file-derived bytes, so fencing it would spend markers on nothing.
        let message = fenceUntrustedFileContent(hintText + changelogExtra) + wellKnownText
        // A re-read is always hard-denied. A first read is also hard-denied when the file
        // is at or above the generic large-file deny threshold: this branch returns before
        // the size-based deny further below ever runs, so it must enforce that gate itself.
        // A genuine, bounded offset/limit request gates on the requested slice's size
        // instead of the whole file's, same as the generic large-file gate and the
        // file-type dispatcher further below — a small window into a huge markdown file
        // should be let through rather than hard-denied.
        const slice = estimateRequestedSlice(event, normalized)
        const gateSize =
          slice.kind === 'bytes' && markdownSize !== null
            ? Math.min(slice.bytes, markdownSize)
            : markdownSize
        const tooLargeForFirstRead = gateSize !== null && gateSize >= largeFileDenyBytes()
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
          message += ' ' + editAnywayHint(normalized)
          return denyOutput(message)
        }
        recordActualRead(event, normalized)
        return quietContextOutput(message)
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
        : shown + ' was already read this session. Memory files rarely change mid-session. Use `token-goat section "' + shown + '::SectionHeading"` to extract one section.',
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
      shown + ' was already read this session. Environment files rarely change mid-session. ' +
      'Use `token-goat config-get ' + shown + ' KEY_NAME` to extract a specific variable.',
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
      const snapDiff = loadSnapshotDiff(artifactSessionId, normalized, basename)
      if (snapDiff.kind === 'unchanged') {
        recordActualRead(event, normalized)
        recordStat('session_hint', 0, 0)
        return denyOutput(
          basename + ' is unchanged since last read. ' + sessionArtifactRecall(normalized),
        )
      }
      if (snapDiff.kind === 'diff') {
        recordActualRead(event, normalized)
        const artifactDiffCredit = counterfactualCredit(snapDiff.currentContent.length, snapDiff.diff.length)
        recordStat('session_hint', artifactDiffCredit, savedTokensFromBytes(artifactDiffCredit))
        return denyOutput(
          'Content changed since last read of ' + basename + '. Here is what changed:\n\n' +
          fenceUntrustedFileContent('```diff\n' + snapDiff.diff + '\n```') + '\n\n' + sessionArtifactRecall(normalized),
        )
      }
      // No snapshot or file too large — generic re-read denial
      recordActualRead(event, normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        shown + ' was already read this session. ' + sessionArtifactRecall(normalized),
      )
    }
    // First read of tasks/*.output or tool-results/*.txt — size-gated like every other first-read intercept in this function. A small file is a cheap advisory pass; at/above TASK_OUTPUT_DENY_BYTES it's denied outright, forcing even the first read through bash-output --file/--tail instead of one free unsized full dump. Both artifact kinds share this gate -- tool-results/*.txt previously fell through to the lenient generic 100KB threshold with no advisory at all, unlike tasks/*.output.
    {
      const isTaskOutput = /[/\\]tasks[/\\][a-z0-9]+\.output$/i.test(normalized)
      const label = isTaskOutput ? 'Session transcript' : 'Tool-result file'
      const outputSize = statSize(normalized)
      recordActualRead(event, normalized)
      if (outputSize !== null && outputSize >= TASK_OUTPUT_DENY_BYTES) {
        const artifactDenyCredit = counterfactualCredit(outputSize)
        recordStat('session_hint', artifactDenyCredit, savedTokensFromBytes(artifactDenyCredit))
        return denyOutput(
          label + ' is large (' + toKB(outputSize) + 'KB). ' + sessionArtifactRecall(normalized),
        )
      }
      return quietContextOutput(label + ': ' + sessionArtifactRecall(normalized))
    }
  }

  // Doc-file auto-diff on re-read: .md/.mdx/.rst/.txt files that have been read before get a compact diff (or "unchanged") instead of a wasteful full re-read, provided a snapshot was captured by postReadHandler on the first read. When serve_diff_on_reread is enabled, source/style/data files also get diffs. Falls through to the generic wasFileReadThisSession block when no snapshot exists, preserving existing context vs. deny behavior for un-snapshotted files.
  const isDocDiffable = /\.(md|mdx|markdown|rst|txt)$/i.test(basename)
  const isSourceDiffable = loadConfig().hints.serve_diff_on_reread && DIFFABLE_SOURCE_RE.test(basename)
  if (
    (isDocDiffable || isSourceDiffable) &&
    wasFileReadThisSession(normalized) &&
    !isProtectedRecentRead(normalized, loadConfig().hints.protect_recent_reads)
  ) {
    // Truncation takes priority: redirect to skeleton/surgical reads, gated on
    // hints.truncated_read_min_lines so a small file that happened to trip the token-based
    // truncation marker doesn't get denied for a redirect that wouldn't help it.
    if (wasFileTruncatedThisSession(normalized)) {
      if (estimateTruncatedLineCount(normalized) >= loadConfig().hints.truncated_read_min_lines) {
        recordActualRead(event, normalized)
        recordStat('session_hint', 0, 0)
        return denyOutput(truncatedReadDenyMessage(normalized))
      }
    }

    const sessionId = getSessionId()
    const snapDiff = loadSnapshotDiff(sessionId, normalized, basename)

    if (snapDiff.kind === 'unchanged') {
      recordActualRead(event, normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        (basename + ' is unchanged since last read. ' +
        surgicalHint(normalized, basename, countTextLines(snapDiff.currentContent))).trimEnd(),
      )
    }

    if (snapDiff.kind === 'diff') {
      // Savings guard, uniform for doc and source files: only serve the diff if it
      // clears the configured token-savings floor (hints.diff_hint_min_tokens_saved).
      // The gate prices the saving with savedTokensFromBytes, the same function the credit three lines below uses, so a change to the divisor can never leave the threshold that admits the hint and the figure booked for it on two different scales.
      if (savedTokensFromBytes(snapDiff.savedBytes) >= loadConfig().hints.diff_hint_min_tokens_saved) {
        recordActualRead(event, normalized)
        const diffCredit = counterfactualCredit(snapDiff.currentContent.length, snapDiff.diff.length)
        recordStat('diff_hint', diffCredit, savedTokensFromBytes(diffCredit))
        return denyOutput(
          ('Content changed since last read of ' + basename + '. Here is what changed:\n\n' +
          fenceUntrustedFileContent('```diff\n' + snapDiff.diff + '\n```') + '\n\n' +
          surgicalHint(normalized, basename, countTextLines(snapDiff.currentContent))).trimEnd(),
        )
      }
      // Diff is not a good savings — fall through to generic deny block below
    }

    // No snapshot yet or file too large — fall through to generic wasFileReadThisSession logic below, which uses readCount and file size to pick context vs. deny.
  }

  // Cross-session read dedup: check if another session (different sessionId) working in the same project already read this file recently
  const config = loadConfig()
  if (config.hints.cross_session_read_dedup && !wasFileReadThisSession(normalized)) {
    try {
      const cwd = getCwd(event) ?? process.cwd()
      let project = findProject(cwd)
      if (!project) {
        project = makeProjectAt(cwd)
      }

      if (relPathWithinRoot(project.root, normalized) !== null) {
        const ttlSecs = config.hints.cross_session_read_dedup_ttl_secs
        if (scanCrossSessionManifests(project.root, project.hash, normalized, ttlSecs)) {
          recordActualRead(event, normalized)
          return quietContextOutput(
            'This file may have already been read by another agent/session working in this project recently. ' +
            'If you are a subagent continuing shared work, consider whether you already have this content from context, ' +
            'or use `token-goat read ' + shown + '::SymbolName` for a narrower slice instead of a full re-read.',
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

    // Rank must be computed against session state as of the *last* read, before the read
    // below bumps this file's own lastReadAt -- otherwise every re-read would trivially rank
    // itself as the most recent and the protection window would be meaningless.
    const protectedRead = isProtectedRecentRead(normalized, loadConfig().hints.protect_recent_reads)

    recordActualRead(event, normalized)
    const rereadBytes = statSize(normalized) ?? 0
    // What a blocked re-read may claim it saved. Gating below still uses the true size -- only the amount CREDITED is capped, because the counterfactual being priced is "the Read that didn't happen", and that Read would itself have been truncated. See PER_FILE_COUNTERFACTUAL_CEILING.
    const rereadCredit = counterfactualCredit(rereadBytes)

    const config = loadConfig()
    if (config.hints.log_large_file_hint_outcomes) {
      const pendingSize = takePendingLargeFileHint(normalized)
      if (pendingSize !== null) {
        recordStat('large_file_hint_ignored', 0, 0, undefined, `${normalized} (${pendingSize} bytes) — hint fired but file was fully re-read instead of surgically read`)
      }
    }

    // Proof beats the count. Every branch below reasons about how many times this file has been
    // read, and the recent-read protection window exists because that reasoning can be wrong -- it
    // waves through the four most recently read files precisely so a legitimate re-read is never
    // blocked on a guess. Measured over a month of real sessions, 830 Read calls returned a line
    // range the session had already been given, and the largest reason nothing fired was that the
    // file sat inside that window: exactly the case where the bytes are most certainly still in
    // context. So when the bytes are *known* rather than guessed, the guess-protection does not
    // apply, and the read is answered with a pointer at the copy already delivered.
    //
    // Still gated on hints.reread_deny: a user who turned denials off asked for hints, not blocks,
    // and having proof does not change what they asked for.
    if (config.hints.reread_deny) {
      const alreadyServed = alreadyServedOutputId(event, normalized)
      if (alreadyServed !== null) {
        // Credit the bytes this read would actually have delivered, not the whole file: a Read
        // carrying offset/limit was only ever going to hand over its window, and crediting the file
        // would book bytes nothing was ever going to spend.
        const blocked = counterfactualCredit(alreadyServed.bytes)
        recordStat('read_served_deny', blocked, savedTokensFromBytes(blocked))
        recordStat('session_hint', 0, 0)
        return denyOutput(
          'Every line of ' + shown + ' this read would return was already served in this session, byte for byte. ' +
          'Recall it with `token-goat bash-output ' + alreadyServed.id + '`, or pull just the part you need with ' +
          '`token-goat read "' + shown + '::Symbol"`.' +
          ' ' + editAnywayHint(normalized),
        )
      }
    }

    // session_hint is recorded per-branch below, only where a deny actually returns or the
    // final quietContextOutput will actually be visible -- recording it unconditionally here
    // (as this used to) over-counted the ledger on every quiet-hours re-read that degraded to
    // passOutput(), including protected/non-denying re-reads whose only possible output is that
    // same quiet-hours-degradable fallback note. Session tracking above is unaffected either
    // way; only this stat's accounting changes.

    // All deny branches below are gated on hints.reread_deny -- with it disabled, a re-read
    // still gets recorded/stat'd above (session tracking is unaffected) but never blocked, only
    // hinted via the contextOutput fallback at the bottom of this block.
    if (config.hints.reread_deny && !protectedRead) {
      // Item 1: file was truncated on last read — surgical reads only, gated on
      // hints.truncated_read_min_lines (same gate as the doc/source diff-on-reread branch
      // above) so a small file that happened to trip the token-based truncation marker
      // doesn't get denied for a redirect that wouldn't help it.
      if (wasFileTruncatedThisSession(normalized)) {
        if (estimateTruncatedLineCount(normalized) >= config.hints.truncated_read_min_lines) {
          recordStat('session_hint', rereadCredit, savedTokensFromBytes(rereadCredit))
          return denyOutput(truncatedReadDenyMessage(normalized))
        }
      }

      // Item 2: any .md/.mdx/.markdown/.rst already read this session is denied on 2nd+ read regardless of size
      if (/\.(md|mdx|markdown|rst)$/i.test(basename)) {
        recordStat('session_hint', rereadCredit, savedTokensFromBytes(rereadCredit))
        return denyOutput(
          'Markdown file already read this session. Use `token-goat section "' + shown + '::HeadingName"` to read one section.' +
          ' ' + editAnywayHint(normalized),
        )
      }

      // Count-based deny: 3rd+ read of source files — even small ones that the size threshold misses
      const isSourceExt = isSourceExtension(basename)
      if (isSourceExt && reads >= 2) {
        // read_count_deny carries the credit for this blocked read. Both it and session_hint
        // map to SOURCE_HINT (see stats.ts's KIND_TO_SOURCE), so a second, non-zero session_hint
        // row here would double the same blocked bytes into the by_source rollup that
        // hint-stats reads -- one deny, one blocked read, one credit. session_hint is still
        // recorded (at 0, 0) so this branch stays visible in its own per-kind breakdown.
        recordStat('read_count_deny', rereadCredit, savedTokensFromBytes(rereadCredit))
        recordStat('session_hint', 0, 0)
        return denyOutput(
          'Read this file ' + reads + ' times already — use `token-goat read "' + shown + '::Symbol"`, `token-goat skeleton ' + shown + '`, or `token-goat outline ' + shown + '` to pull just the part you need.' +
          ' ' + editAnywayHint(normalized),
        )
      }
    }

    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + shown + '::SectionName"` to read one section.'
      : 'Use token-goat read/section/symbol to re-read surgically.'
    if (config.hints.reread_deny && !protectedRead && (rereadBytes >= config.hints.reread_deny_min_bytes || reads >= 2)) {
      recordStat('session_hint', rereadCredit, savedTokensFromBytes(rereadCredit))
      return denyOutput(
        shown + ' was already read this session (' + reads + ' ' + plural + '). ' + hint +
        ' ' + editAnywayHint(normalized),
      )
    }
    // Only counted when the note actually reaches the caller -- quietContextOutput silently
    // degrades to passOutput() during hints.quiet_hours, and recording unconditionally (as this
    // used to) over-counted the ledger on every quiet-hours re-read that produced no visible
    // output at all.
    // Zero bytes, deliberately: this branch does NOT block the read. The note is appended and the Read still proceeds, so the file's full contents reach the model anyway and the hint text is spent on top of them -- crediting rereadCredit here booked the entire file as saved on the one path where nothing was. The event is still recorded (count, not bytes) because how often the soft note fires is worth knowing; what it is worth is separately measurable through hint-stats' acted-on tracking, which is the only thing that can tell whether the note ever changed what the model did next.
    if (!isWithinQuietHours(config.hints.quiet_hours)) {
      recordStat('session_hint', 0, 0)
    }
    return quietContextOutput(
      'Note: ' + shown + ' was already read this session (' + reads + ' ' + plural + '). ' +
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

    const kb = toKB(size)
    const config = loadConfig()
    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + shown + '::SectionName"` to read one section.'
      : 'Consider token-goat skeleton or token-goat section.'
    if (gateSize >= largeFileDenyBytes()) {
      // The read is blocked outright, so it never actually happened — don't record it
      // against re-read dedup. Otherwise a retry (this hook doesn't distinguish
      // offset/limit params from a plain re-read) hits "already read this session"
      // instead of this same actionable deny, leaving no way to follow its own advice.
      const denyCredit = counterfactualCredit(size)
      recordStat('session_hint', denyCredit, savedTokensFromBytes(denyCredit))
      return denyOutput(
        shown + ' is very large (' + kb + 'KB). ' + hint + ' ' + describeSliceAdvice(slice, normalized) +
        ' ' + editAnywayHint(normalized),
      )
    }
    recordActualRead(event, normalized)
    if (!meetsSavingsFloor(size)) {
      return passOutput()
    }
    if (config.hints.log_large_file_hint_outcomes) {
      recordLargeFileHintPending(normalized, size)
    }
    // Only counted when the hint actually reaches the caller -- quietContextOutput silently
    // degrades to passOutput() during hints.quiet_hours, and recording unconditionally here
    // (as this used to, before the deny-gate check above) over-counted the session_hint ledger
    // on every quiet-hours large-file read that produced no visible hint at all.
    // Zero bytes for the same reason as the re-read note above: this is advisory, not a block. The Read proceeds and the whole file reaches the model anyway, so the hint is a cost, not a saving; the event is still counted because how often it fires is worth knowing.
    if (!isWithinQuietHours(config.hints.quiet_hours)) {
      recordStat('session_hint', 0, 0)
    }
    return quietContextOutput(
      'Note: ' + shown + ' is large (' + kb + 'KB). ' +
        hint + contextPressureAdvisorySuffix(),
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
    // Same offset/limit honoring as above: gate the per-type handlers (handleTxt/handleCsv/
    // handleHtml/handleGenericLarge) on the requested slice's size when one was given.
    const ftSlice = estimateRequestedSlice(event, normalized)
    const ftEffectiveLength = ftSlice.kind === 'bytes' ? Math.min(ftSlice.bytes, fileStatSize) : fileStatSize
    let ftContent = ''
    // Guarded the same way every other full-content fs.readFileSync in this file is (see
    // SLICE_ESTIMATE_SCAN_CAP_BYTES's other call sites above) -- without this, a multi-GB
    // .csv/.txt/.log/.html file (isKnownFileType is unconditional on size) would be read
    // into a JS string in full on every single call, even a cheap bounded offset/limit
    // request whose small ftEffectiveLength was always going to pass every handler's
    // length-gate below without ever touching content.
    if (!BINARY_FILE_TYPE_EXTS.has(fileTypeExt) && fileStatSize <= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
      try {
        ftContent = fs.readFileSync(normalized, 'utf8')
      } catch {
        // best-effort — empty content will pass through
      }
    }
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

/** Public wrapper: intercepts every `context` (hint) output from {@link preReadHandlerInner} for efficacy tracking/suppression — see hint_stats.ts's module doc comment. */
export function preReadHandler(event: HookEvent): HookOutput {
  return applyHintTracking(event, preReadHandlerInner(event), classifyReadHint)
}

registerHook('pre_tool_use', preReadHandler, { toolName: 'Read' })
registerHook('pre_tool_use', preReadHandler, { toolName: 'Grep' })

/** Extract tool response text from a post_tool_use Read event. */
function extractReadOutput(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
}

/** Count text lines the way `wc -l` does: newline count, plus one for a final non-empty
 *  line with no trailing newline. Empty content has zero lines. Used to gate the
 *  post-read structural-navigation hint against `post_read_code_compress.min_lines`. */
function countTextLines(content: string): number {
  if (content.length === 0) return 0
  const parts = content.split(/\r\n|\r|\n/)
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

/** Line count of `normalized`, capped by SLICE_ESTIMATE_SCAN_CAP_BYTES; Infinity when the
 *  file is too large to scan or unreadable (fail open toward the truncated-read deny). */
function estimateTruncatedLineCount(normalized: string): number {
  try {
    const sz = statSize(normalized)
    if (sz !== null && sz <= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
      return countTextLines(fs.readFileSync(normalized, 'utf8'))
    }
  } catch {
    // best-effort — treat as eligible for the deny below on read/stat failure
  }
  return Infinity
}

function editAnywayHint(rawPath: string): string {
  const normalized = displaySafePath(rawPath)
  return (
    'To edit it anyway, use `token-goat replace "' + normalized + '" --old-b64 <base64> --new-b64 <base64>` (preferred — no temp files needed) or `--old-from <oldfile> --new-from <newfile>` for a snippet edit, or `token-goat write-file "' + normalized + '" --b64 <base64>` (or `--from <newfile>`) to rewrite the whole file — Read/Edit\'s own precondition can\'t be satisfied after this deny.'
  )
}

function truncatedReadDenyMessage(rawPath: string): string {
  const normalized = displaySafePath(rawPath)
  return (
    'File was truncated on last read (>33K tokens). Use `token-goat skeleton "' + normalized + '"` for structure or `token-goat read "' + normalized + '::SymbolName"` for one function.' +
    ' ' + editAnywayHint(normalized)
  )
}

/**
 * post_tool_use handler for the Read tool.
 *
 * Detects truncation markers in the tool response and flags the file so the
 * next pre_tool_use for the same file returns an immediate deny with a
 * surgical-read hint instead of allowing another full (and expensive) read.
 */
function postReadHandlerInner(event: HookEvent): HookOutput {
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  const normalized = normalizePath(filePath)
  const shown = displaySafePath(normalized)
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

  if (loadConfig().hints.cross_session_read_dedup) {
    try {
      const cwd = getCwd(event) ?? process.cwd()
      const project = findProject(cwd) ?? makeProjectAt(cwd)
      const source = decodeSource(fs.readFileSync(normalized))
      recordEvidence({ projectRoot: project.root, source: normalized, representation: 'file', text: source })
    } catch {
      // Evidence is best-effort; it must never affect the completed Read.
    }
  }

  // Cross-session manifest recording: write this session's reads for other sessions to discover
  if (loadConfig().hints.cross_session_read_dedup) {
    try {
      const cwd = getCwd(event) ?? process.cwd()
      let project = findProject(cwd)
      if (!project) {
        project = makeProjectAt(cwd)
      }

      const sessionState = exportSessionState()
      const mappedFiles: Array<{rel_path: string; hit_count: number}> = []

      for (const fileEntry of sessionState.files) {
        const relPath = relPathWithinRoot(project.root, fileEntry.path)
        if (relPath !== null) {
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
        if (lineCount >= minLines && meetsSavingsFloor(sz)) {
          // Advisory only -- the read is not blocked, so nothing was saved here either.
          recordStat('session_hint', 0, 0)
          return quietContextOutput(
            shown + ' is ' + lineCount + ' lines. Use `token-goat skeleton "' + shown + '"` or `token-goat outline "' + shown + '"` for structural navigation instead of a future full re-read.',
          )
        }
      }
    } catch {
      // best-effort; never block the hook
    }
  }

  return passOutput()
}

/**
 * The exact text a Read of `normalized` delivers (or would deliver), read from disk.
 *
 * The Read tool's own `offset`/`limit` bound a line window, so an event carrying them was handed
 * that window and nothing else. Returns raw file lines rather than the tool's numbered rendering,
 * because every consumer compares against what a plain `sed`/`cat` prints. Null when the file
 * cannot be read or is past the scan cap.
 *
 * Shared by the two ends that must agree byte-for-byte on "what this read is worth": the producer
 * that stores a finished Read, and the pre-read check that asks whether the same bytes were already
 * served. Two copies of this slicing would be a silent miss the moment they drifted.
 */
function readWindowFromDisk(event: HookEvent, normalized: string): string | null {
  const size = statSize(normalized)
  if (size === null || size > SLICE_ESTIMATE_SCAN_CAP_BYTES) return null
  const text = decodeSource(fs.readFileSync(normalized))
  const limit = readIntToolInput(event, 'limit')
  if (limit === undefined || limit <= 0) return text
  const offset = readIntToolInput(event, 'offset')
  const start = offset !== undefined && offset >= 1 ? offset : 1
  return text.split('\n').slice(start - 1, start - 1 + limit).join('\n')
}

/**
 * The id of an already-served body that provably contains every line this Read would deliver, or
 * null when there is no such proof.
 *
 * The count-based re-read machinery below reasons about how many times a *file* was read. That is a
 * heuristic, and the recent-read protection window exists precisely because it can be wrong. This
 * is not a heuristic: the bytes this Read would hand over are compared, whole-line aligned, against
 * bytes the session recorded as already delivered for this same file. A hit means the model is
 * holding this exact text.
 *
 * Everything about the comparison fails toward allowing the read:
 *   - the current text comes from disk, so a file that changed since the earlier delivery no longer
 *     matches and the read proceeds. Line numbers are never consulted, for the reason stated on
 *     `_fileServedOutputs` in session.ts: an edit token-goat did not observe moves them.
 *   - stored bodies pass through secret redaction on the way in, so a body that carried a secret no
 *     longer matches the raw file and the read proceeds rather than being answered from a redacted
 *     copy.
 *   - a body below the shared floor is not worth a pointer that is itself ~200 bytes.
 */
function alreadyServedOutputId(event: HookEvent, normalized: string): { id: string; bytes: number } | null {
  try {
    const ids = getFileServedOutputs(normalized)
    if (ids.length === 0) return null
    const wouldServe = readWindowFromDisk(event, normalized)
    if (wouldServe === null) return null
    const bytes = Buffer.byteLength(wouldServe, 'utf-8')
    if (bytes < IDENTICAL_READ_MIN_BODY_BYTES) return null
    // Newest first: the most recent delivery is the one most likely still in context.
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]
      if (id === undefined) continue
      const prior = getBashOutput(id)
      if (prior !== null && containsLineRun(prior.output, wouldServe)) return { id, bytes }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Record what a completed Read handed the model, as raw file lines, so the shell-side re-read
 * collapse in hooks_bash.ts can recognise a later `sed -n 'A,Bp'` or `cat` of the same lines as
 * bytes the model is already holding.
 *
 * That collapse decides containment on BYTES rather than on line numbers, deliberately: an edit
 * token-goat never observed moves the lines while leaving a recorded range looking valid, so a
 * number-keyed store would happily withhold text the model does not have. It therefore needs the
 * served text itself -- and until now only Bash ever produced any. A file first delivered through
 * the Read tool was invisible to it, which is why its contained-re-read branch booked nothing at
 * all while a third of bounded shell reads asked for lines already delivered.
 *
 * Three constraints follow from "the model is already holding these bytes", and each is a skip:
 *   - Store only the slice actually delivered. A Read carrying offset/limit handed over that window
 *     and nothing else, so storing the whole file would let the collapse withhold lines that were
 *     never shown.
 *   - Skip a truncated Read entirely. It delivered less than its own window and there is no way
 *     from here to know where it stopped.
 *   - Store raw file lines, not the Read tool's rendered output. The rendered form carries
 *     line-number prefixes, and the later shell read emits neither; whole-line containment is
 *     compared against what `sed`/`cat` will actually print.
 *
 * Best-effort throughout: the Read has already completed and nothing here may change its result.
 * Synchronous on purpose: a hook is its own short-lived process, so a write left pending on the
 * microtask queue is a write that may never reach disk.
 */
function recordReadAsServedOutput(event: HookEvent): void {
  try {
    const cfg = loadConfig().bash_compress
    // Nothing consumes the store when compression is off, so storing would be pure disk cost.
    if (!cfg.enabled) return
    const filePath = getFilePath(event)
    if (filePath === undefined) return
    const normalized = normalizePath(filePath)
    if (isImagePath(normalized)) return
    // Deliberately re-read from THIS response rather than asking the session whether the file has
    // ever been truncated: that flag is sticky for the rest of the session, so one truncated Read
    // would disqualify every later complete Read of the same file, which does deliver its window.
    const respText = extractReadOutput(event.raw)
    if (respText.includes('[Truncated:') || respText.includes('Truncated: PARTIAL view')) return
    const served = readWindowFromDisk(event, normalized)
    if (served === null) return

    // A stored body can only ever contain a later read that is itself at or above the collapse's
    // own floor, so anything smaller is dead weight in the cache.
    if (Buffer.byteLength(served, 'utf-8') < Math.max(cfg.cache_min_bytes, IDENTICAL_READ_MIN_BODY_BYTES)) return

    const id = storeBashOutputSync('Read ' + normalized, served, 0, getCwd(event) ?? process.cwd())
    recordFileServedOutput(normalized, id)
  } catch {
    // best-effort; never affect the completed Read
  }
}

/** Public wrapper: same tracking as {@link preReadHandler} above. */
export function postReadHandler(event: HookEvent): HookOutput {
  const out = applyHintTracking(event, postReadHandlerInner(event), classifyReadHint)
  recordReadAsServedOutput(event)
  return out
}

registerHook('post_tool_use', postReadHandler, { toolName: 'Read' })
