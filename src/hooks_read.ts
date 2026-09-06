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
import { registerHook, sessionStateKey } from './hook_registry.js'
import { applyHintTracking, classifyReadHint, meetsSavingsFloor } from './hint_stats.js'
import { displaySafePath, normalizePath } from './paths.js'
import { decodeSource, foldPath, isWithinQuietHours, statSize, toKB, PER_FILE_COUNTERFACTUAL_CEILING, IDENTICAL_READ_MIN_BODY_BYTES, containsLineRun } from './util.js'
import { loadConfig } from './config.js'
import { recordFileRead, wasFileReadThisSession, getCompactedAt, getSessionFileEntry, getSessionFiles, markFileTruncated, wasFileTruncatedThisSession, getSessionId, recordLargeFileHintPending, takePendingLargeFileHint, exportSessionState, markHintShown, recordFileServedOutput, getFileServedOutputs } from './session.js'
import { storeBashOutputSync, getBashOutput } from './bash_output_cache.js'
import { writeSessionManifest, readAllSessionManifests, loadSessionCache, getContextPressure } from './compact.js'
import { store as snapshotStore, load as snapshotLoad } from './snapshots.js'
import { contextOutput, passOutput, denyOutput, emitRewrite, extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS } from './hooks_common.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'
import { redactSecrets } from './secret_redact.js'
import type { HookOutput } from './types.js'
import { buildPackageManifestHint } from './hints.js'
import { isLockFile, isManifestFile, isInBuildDir, isGeneratedFile } from './hints/lang_patterns.js'
import {
  extractMarkdownHeadings,
  formatHeadingTreeParts,
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
import { planBodyFolds, planCommentFolds, mergeFolds, commentSyntaxFor, type FoldSpan } from './code_fold.js'
import { querySymbols, getFileEntry } from './index_reader.js'
import { fingerprintFile } from './fingerprint.js'
import { PARSER_FINGERPRINT } from './parser_fingerprint.js'

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
 * Size gate for `hints.subagent_markdown_first_read_deny`: a subagent's first, un-ranged Read of a
 * markdown file this large is denied in favour of its heading tree.
 *
 * 30KB, not the 10KB where the measured pool starts. Across 4,664 real session transcripts, a
 * subagent's first un-ranged Read of a >=10KB markdown file was 1,645 events / 50.7MB -- 10.4% of
 * all Reads but 38.5% of all Read result bytes, and only 12% of them were followed by an Edit of
 * the same file within 10 calls, so this is overwhelmingly reading-to-understand. The >=30KB slice
 * is 643 of those events / 31.3MB: roughly 62% of the bytes for 39% of the interruptions, which is
 * the highest-value, lowest-regret cut of the pool. Widening to 10KB triples the number of denied
 * reads for the remaining 38% of the bytes and is deliberately left for a later version, after
 * this one has enough fires for session-audit to report real outcome rates.
 */
const SUBAGENT_MD_FIRST_READ_DENY_BYTES = 30 * 1024

/** Markdown extensions the subagent first-read deny covers. Narrower than the heading-tree intercept's own regex, which also accepts `.rst`: the measured pool is markdown only, so reStructuredText is left to the existing advisory path. */
const SUBAGENT_MD_FIRST_READ_DENY_EXT_RE = /\.(md|mdx|markdown)$/i

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

/** The 1-based file line the delivered body starts at, from `tool_response.file.startLine`. Defaults to 1, which is both the whole-file case and the safe answer when the harness sends no such field: a wrong start would shift every fold span against the file it came from. */
function readStartLine(event: HookEvent): number {
  const resp = event.raw['tool_response']
  if (resp === null || typeof resp !== 'object') return 1
  const file = (resp as Record<string, unknown>)['file']
  if (file === null || typeof file !== 'object') return 1
  const start = (file as Record<string, unknown>)['startLine']
  if (typeof start === 'number' && Number.isSafeInteger(start) && start >= 1) return start
  return 1
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
    // A truncated snapshot only ever holds the first SNAPSHOT_TRUNCATE_BYTES of the original file, never the whole thing. Equality against currentContent can never hold (the stored prefix is always shorter), and a diff built against it always reports the missing tail as a fabricated addition -- even when nothing changed. There is no truthful answer to give from a partial baseline, so bail to 'none' exactly as for a missing snapshot, letting the caller fall through to its own re-read handling instead of asserting something about content it never actually compared.
    if (truncIdx >= 0) return { kind: 'none' }
    const oldContent = oldRaw
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
  // the full file — typically 60-95% smaller. Runs ahead of the markdown large-file
  // intercept below, which is the expensive full-read path this preempts.
  // Gated by [hints] stable_doc_compacts (default on).
  // Grep needs to search the doc's live content for a pattern — serving the compact sidecar instead would swap out the actual search target and skip the search entirely, so Grep is exempt from this intercept (same rationale as the count-based re-read dedup and large-file gate exemptions further below). A Read carrying offset/limit is asking for one line window, and the compact is a summary of the whole file: serving it answers a different question and silently drops the requested range. It also costs more than it saves -- a 5-line window of a 100KB doc is ~200 bytes against a ~9KB compact. Same rule the subagent-markdown deny below already applies: a read that is surgical already is left alone.
  const compactUnrangedRead =
    readIntToolInput(event, 'offset') === undefined && readIntToolInput(event, 'limit') === undefined
  if (
    event.toolName !== 'Grep' &&
    compactUnrangedRead &&
    loadConfig().hints.stable_doc_compacts &&
    _isDocFile(normalized)
  ) {
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
          '\n\nThis is a lossy extract, not the whole file: front matter and any prose before ' +
          'the first heading are dropped entirely, each section is cut to its opening ' +
          'sentences, and long code fences are truncated. If you need content it left out, ' +
          're-read with offset/limit for a line window, or ' +
          '`token-goat section "' + shown + '::Heading"` for one section in full. ' +
          'Use `token-goat compact-doc "' + shown + '" --force` to rebuild it, ' +
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
        const { guidance, sectionsList } = formatHeadingTreeParts(headings, normalized)
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
        // guidance is token-goat's own authored instruction text (the "use token-goat
        // section" preamble plus the "Sections:" label) and stays OUTSIDE the fence, same
        // as wellKnownText below. sectionsList (the actual heading text) and changelogExtra
        // (version headings) are verbatim bytes from the file, so they are fenced as
        // untrusted data before being spliced into a message the harness attributes to
        // token-goat. wellKnownText is not fenced either: it is built from token-goat's own
        // hardcoded shortcut list plus the file path, with no file-derived bytes, so fencing
        // it would spend markers on nothing.
        let message = guidance + '\n' + fenceUntrustedFileContent(sectionsList + changelogExtra) + wellKnownText
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
            // A genuine re-read of a large markdown file: prefer the same
            // unchanged/diff snapshot machinery the isDocDiffable block further
            // below uses, rather than re-emitting the (roughly 1.1KB median)
            // heading tree that says nothing new. This branch is otherwise
            // unreachable for markdown files large enough to trip the heading-tree
            // intercept, since that intercept returns before isDocDiffable runs.
            // Reuses that block's exact message shapes so the session-audit census
            // (DENY_TEMPLATES in session_audit.ts) recognizes them as
            // doc_unchanged_deny/doc_diff_deny rather than a new, invisible shape.
            // recordStat stays session_hint/0 on every branch here (never diff_hint
            // with a byte credit, unlike the isDocDiffable block) because these
            // heading-tree denies are measured to be frequently routed around by a
            // shell re-read anyway, so crediting withheld bytes would book a saving
            // this path cannot back up.
            const snapDiff = loadSnapshotDiff(sessionStateKey(event), normalized, basename)
            if (snapDiff.kind === 'unchanged') {
              recordActualRead(event, normalized)
              recordStat('session_hint', 0, 0)
              return denyOutput(
                (basename + ' is unchanged since last read. ' +
                surgicalHint(normalized, basename, countTextLines(snapDiff.currentContent))).trimEnd(),
              )
            }
            if (
              snapDiff.kind === 'diff' &&
              savedTokensFromBytes(snapDiff.savedBytes) >= loadConfig().hints.diff_hint_min_tokens_saved
            ) {
              recordActualRead(event, normalized)
              recordStat('session_hint', 0, 0)
              return denyOutput(
                ('Content changed since last read of ' + basename + '. Here is what changed:\n\n' +
                fenceUntrustedFileContent('```diff\n' + snapDiff.diff + '\n```') + '\n\n' +
                surgicalHint(normalized, basename, countTextLines(snapDiff.currentContent))).trimEnd(),
              )
            }
            // No snapshot, a snapshot too large/truncated for loadSnapshotDiff to
            // use (kind 'none'), or a diff that doesn't clear the savings floor --
            // fall back to the heading tree below, unchanged.
            recordActualRead(event, normalized)
            recordStat('session_hint', 0, 0)
          } else {
            // Only a genuinely-first read leaves Read/Edit's precondition unsatisfied -- a prior
            // real read (alreadyRead) already satisfied it, so the "edit anyway" escape hatch would
            // steer toward token-goat replace/write-file when a plain Edit works fine.
            message += ' ' + editAnywayHint(normalized)
          }
          return denyOutput(message)
        }
        // Subagent first-read markdown deny, behind hints.subagent_markdown_first_read_deny
        // (default false, so the path above is what ships until someone opts in). Reaching here
        // means: a genuinely-first read of a markdown file with >=3 headings that is under the
        // generic large-file deny threshold. Narrow it further to the measured pool -- a subagent
        // lane, an un-ranged Read, a real markdown extension, and at least
        // SUBAGENT_MD_FIRST_READ_DENY_BYTES -- and hard-deny it with the same heading tree the
        // advisory branch below would have offered. A read that already carries offset/limit is
        // surgical already and is left alone. Like the tooLargeForFirstRead branch above, this
        // deliberately skips recordActualRead: the read never happened, so a retry with
        // offset/limit must still count as a first read rather than tripping the re-read denies.
        const unrangedRead =
          readIntToolInput(event, 'offset') === undefined && readIntToolInput(event, 'limit') === undefined
        if (
          loadConfig().hints.subagent_markdown_first_read_deny &&
          event.agentId !== undefined &&
          unrangedRead &&
          SUBAGENT_MD_FIRST_READ_DENY_EXT_RE.test(basename) &&
          markdownSize !== null &&
          markdownSize >= SUBAGENT_MD_FIRST_READ_DENY_BYTES
        ) {
          // 0 bytes and 0 tokens, deliberately, exactly as the heading-tree re-read deny above
          // books itself. There is no first-read deny of this shape anywhere in the transcript
          // corpus, so its outcome rates (abandoned / substituted / shell-read / retried) are
          // unknown -- the only figures available are borrowed from the re-read heading-tree
          // census, and crediting withheld bytes against borrowed rates would book a saving this
          // path has never demonstrated. The stat exists to make the intervention countable in
          // `session-audit` so its kill conditions can be checked, not to claim a win.
          recordStat('subagent_markdown_first_read_deny', 0, 0)
          return denyOutput(
            'Subagent first read of a large markdown file (' +
            Math.round(markdownSize / 1024) + 'KB). Read the section you need, not the whole file.\n\n' +
            message + ' ' + editAnywayHint(normalized),
          )
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
    // Prefer the same unchanged/diff snapshot machinery the isDocDiffable block
    // further below uses, rather than the bare denial that says nothing about
    // whether the file actually changed. Reuses that block's exact message
    // shapes (see the analogous markdown heading-tree branch above) so the
    // session-audit census (DENY_TEMPLATES in session_audit.ts) recognizes
    // them as doc_unchanged_deny/doc_diff_deny rather than a new, invisible
    // shape. recordStat stays session_hint/0 on every branch here (never a
    // byte credit) because these denies are measured to be frequently routed
    // around anyway, so crediting withheld bytes would book a saving this
    // path cannot back up.
    const memSnapDiff = loadSnapshotDiff(sessionStateKey(event), normalized, basename)
    if (memSnapDiff.kind === 'unchanged') {
      recordActualRead(event, normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        (basename + ' is unchanged since last read. ' +
        surgicalHint(normalized, basename, countTextLines(memSnapDiff.currentContent))).trimEnd(),
      )
    }
    if (
      memSnapDiff.kind === 'diff' &&
      savedTokensFromBytes(memSnapDiff.savedBytes) >= loadConfig().hints.diff_hint_min_tokens_saved
    ) {
      recordActualRead(event, normalized)
      recordStat('session_hint', 0, 0)
      return denyOutput(
        ('Content changed since last read of ' + basename + '. Here is what changed:\n\n' +
        fenceUntrustedFileContent('```diff\n' + memSnapDiff.diff + '\n```') + '\n\n' +
        surgicalHint(normalized, basename, countTextLines(memSnapDiff.currentContent))).trimEnd(),
      )
    }
    // No snapshot, a snapshot too large/truncated for loadSnapshotDiff to use
    // (kind 'none'), or a diff that doesn't clear the savings floor -- fall
    // back to the existing hard deny below, unchanged.
    recordActualRead(event, normalized)
    recordStat('session_hint', 0, 0)
    const isMainMemory = basename.toLowerCase() === 'memory.md'
    return denyOutput(
      isMainMemory
        ? 'MEMORY.md was already read this session. Memory files rarely change mid-session. Use `token-goat section "' + shown + '::SectionHeading"` to extract one section.'
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
      const artifactSessionId = sessionStateKey(event)
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

    const sessionId = sessionStateKey(event)
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
        // No editAnywayHint here: this file was already read successfully this session (that's the whole premise of "already served"), so Read/Edit's precondition is already satisfied -- a plain Edit works fine without token-goat replace/write-file.
        return denyOutput(
          'Every line of ' + shown + ' this read would return was already served in this session, byte for byte. ' +
          'Recall it with `token-goat bash-output ' + alreadyServed.id + '`, or pull just the part you need with ' +
          '`token-goat read "' + shown + '::Symbol"`.',
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
        // No editAnywayHint here: this branch only fires inside the wasFileReadThisSession block above, so a prior real Read already satisfied Read/Edit's precondition -- a plain Edit works fine.
        return denyOutput(
          'Markdown file already read this session. Use `token-goat section "' + shown + '::HeadingName"` to read one section.',
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
        // No editAnywayHint here: this branch only fires inside the wasFileReadThisSession block above, so a prior real Read already satisfied Read/Edit's precondition -- a plain Edit works fine.
        return denyOutput(
          'Read this file ' + reads + ' times already — use `token-goat read "' + shown + '::Symbol"`, `token-goat skeleton ' + shown + '`, or `token-goat outline ' + shown + '` to pull just the part you need.',
        )
      }
    }

    const hint = _isDocFile(normalized)
      ? 'Use `token-goat section "' + shown + '::SectionName"` to read one section.'
      : 'Use token-goat read/section/symbol to re-read surgically.'
    if (config.hints.reread_deny && !protectedRead && (rereadBytes >= config.hints.reread_deny_min_bytes || reads >= 2)) {
      recordStat('session_hint', rereadCredit, savedTokensFromBytes(rereadCredit))
      // No editAnywayHint here: this branch only fires inside the wasFileReadThisSession block above, so a prior real Read already satisfied Read/Edit's precondition -- a plain Edit works fine.
      return denyOutput(
        shown + ' was already read this session (' + reads + ' ' + plural + '). ' + hint,
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

// No editAnywayHint here: both call sites only fire inside a wasFileReadThisSession-gated block, so a prior real Read already satisfied Read/Edit's precondition -- a plain Edit works fine.
function truncatedReadDenyMessage(rawPath: string): string {
  const normalized = displaySafePath(rawPath)
  return (
    'File was truncated on last read (>33K tokens). Use `token-goat skeleton "' + normalized + '"` for structure or `token-goat read "' + normalized + '::SymbolName"` for one function.'
  )
}

/**
 * post_tool_use handler for the Read tool.
 *
 * Detects truncation markers in the tool response and flags the file so the
 * next pre_tool_use for the same file returns an immediate deny with a
 * surgical-read hint instead of allowing another full (and expensive) read.
 */
function postReadHandlerInner(event: HookEvent, suppressStructuralHint: boolean): HookOutput {
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
        snapshotStore(sessionStateKey(event), normalized, content)
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
        if (lineCount >= minLines && meetsSavingsFloor(sz) && !suppressStructuralHint) {
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
function recordReadAsServedOutput(event: HookEvent, deliveredRaw: string | null = null): void {
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
    // What the model was actually handed, which is the disk window ONLY when nothing rewrote it. A body fold delivers strictly less than the file holds, and storing the disk copy would tell every later read that the folded lines were served -- so a re-read coming back for exactly those lines would have them elided as "already seen". The store's whole contract is a record of what reached the model, and a rewrite is the one case where that differs from disk.
    const served = deliveredRaw ?? readWindowFromDisk(event, normalized)
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

/** One row of the Read tool's `cat -n` rendering: its line number, the raw line, and the row verbatim. */
interface NumberedRow {
  readonly no: number
  readonly text: string
  readonly raw: string
}

/** A Read result row: leading pad, the line number, a tab or arrow separator, then the file's line. */
const READ_NUMBERED_ROW_RE = /^\s*(\d+)[\t→](.*)$/

/** The numbered block inside a Read result, with whatever the harness wrapped around it kept intact. */
interface ParsedReadResult {
  readonly header: string[]
  readonly rows: NumberedRow[]
  readonly trailer: string[]
}

/**
 * Split a Read result into the `cat -n` block it delivered and the harness text around it.
 *
 * The block must be strictly consecutive -- row n followed by row n+1 -- because that is the one
 * property separating a real rendering from file content that merely looks numbered. A file whose
 * own lines begin with digits and a tab would otherwise parse as rows, and lines would be withheld
 * on a coincidence. A break in the sequence ends the block rather than voiding it, so a
 * system-reminder or notice appended after the rows is preserved verbatim instead of costing the
 * whole rewrite.
 *
 * A result carrying no numbered block at all is not necessarily unusable. Claude Code hands the hook the file's own text in `tool_response.file.content` and applies the `cat -n` rendering afterwards, for display only, so every real Read arrives here unnumbered -- 104 of 104 in a captured session. Treating that as unparseable made both post-read rewrites dead code on that harness: the fold booked 0 events across a full session while the rest of the read hook ran normally. So an unnumbered result is parsed as one row per line, numbered from `firstLine`, and both callers keep working against whichever form the harness sends.
 *
 * `raw` equals `text` for those synthesized rows, which is what a caller must emit back: `updatedToolOutput.file.content` is the same unnumbered field the content came from, and writing a numbered rendering into it would number the file twice on display.
 *
 * Null only when there is nothing to work with: an empty body, an image read, an error, a deny message.
 */
function parseNumberedReadResult(respText: string, firstLine = 1): ParsedReadResult | null {
  const lines = respText.split('\n')
  const header: string[] = []
  const rows: NumberedRow[] = []
  const trailer: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = READ_NUMBERED_ROW_RE.exec(line)
    if (m === null || !Number.isSafeInteger(Number(m[1]))) {
      header.push(line)
      continue
    }
    rows.push({ no: Number(m[1]), text: m[2] ?? '', raw: line })
    i++
    break
  }
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = READ_NUMBERED_ROW_RE.exec(line)
    const prev = rows[rows.length - 1]
    if (m === null || prev === undefined || Number(m[1]) !== prev.no + 1) break
    rows.push({ no: prev.no + 1, text: m[2] ?? '', raw: line })
  }
  for (; i < lines.length; i++) trailer.push(lines[i] ?? '')
  if (rows.length > 0) return { header, rows, trailer }
  // No numbered block: the harness sent the file's own text. One row per line, numbered from firstLine, nothing treated as header or trailer -- there is no wrapper here to preserve, and claiming one would drop a real line.
  if (respText === '') return null
  const plain = lines.map((text, idx) => ({ no: firstLine + idx, text, raw: text }))
  return { header: [], rows: plain, trailer: [] }
}

/** Maximum line-to-line comparisons one elision search may spend before giving up and passing. */
const SERVED_RUN_COMPARISON_BUDGET = 400_000

/** Anchors kept per distinct line of a served body. A line repeated more often than this in one
 *  body contributes nothing further: the run that matters still starts at one of the first few. */
const SERVED_RUN_ANCHORS_PER_LINE = 32

/** An already-served body, indexed by line text so a run can be anchored without scanning it. */
interface ServedBody {
  readonly id: string
  readonly lines: string[]
  readonly positions: Map<string, number[]>
}

/** A stretch of the current read that appears, in the same order, inside one already-served body. */
interface ServedRun {
  readonly start: number
  readonly len: number
  readonly id: string
}

function indexServedBody(id: string, output: string): ServedBody {
  const lines = output.split('\n')
  const positions = new Map<string, number[]>()
  for (let j = 0; j < lines.length; j++) {
    const key = lines[j] ?? ''
    let at = positions.get(key)
    if (at === undefined) {
      at = []
      positions.set(key, at)
    }
    if (at.length < SERVED_RUN_ANCHORS_PER_LINE) at.push(j)
  }
  return { id, lines, positions }
}

/**
 * The longest run of `rows[from..to)` that appears as a contiguous line run inside some served body.
 *
 * Anchored on exact line text and extended forward, which is what makes it safe on a file full of
 * repeated lines: a lone `}` matching a `}` somewhere in a served body proves nothing on its own,
 * and only becomes a run when the lines around it match too. This is the same whole-line
 * containment rule `containsLineRun` applies for the deny path, generalised from "is the whole
 * window there" to "which part of it is".
 *
 * `budget` bounds the work rather than the input: a pathological file (thousands of identical
 * lines) would otherwise make this quadratic inside a hook that has to finish in milliseconds.
 * Exhausting it returns the best run found so far, so the outcome degrades to a smaller saving
 * rather than a wrong one.
 */
function longestServedRun(
  rows: NumberedRow[],
  from: number,
  to: number,
  bodies: readonly ServedBody[],
  budget: { left: number },
): ServedRun | null {
  let best: ServedRun | null = null
  for (const body of bodies) {
    for (let i = from; i < to; i++) {
      if (best !== null && to - i <= best.len) break
      const anchors = body.positions.get(rows[i]?.text ?? '')
      if (anchors === undefined) continue
      for (const j of anchors) {
        let k = 0
        while (i + k < to && j + k < body.lines.length && rows[i + k]?.text === body.lines[j + k]) {
          k++
          if (--budget.left <= 0) return best !== null && best.len > 0 ? best : null
        }
        if (best === null || k > best.len) best = { start: i, len: k, id: body.id }
      }
    }
  }
  return best !== null && best.len > 0 ? best : null
}

/** Most runs one Read result may have withheld. Past this the result reads as a list of notices. */
const MAX_SERVED_ELISIONS = 3

/** The notice standing in for a withheld run, phrased so the line numbers it replaces stay visible. */
function servedRunNotice(firstLine: number, lastLine: number, id: string): string {
  return (
    '[token-goat] lines ' + firstLine + '-' + lastLine +
    ' were already served verbatim in this session; withheld here. ' +
    'Recall them with `token-goat bash-output ' + id + '`.'
  )
}

/**
 * Bytes a run removes from the result, which is what a notice replacing it has to beat.
 *
 * Measured on the rendered rows rather than the file's lines, because those rows are what is
 * actually leaving the output. The two differ by the line-number prefix on every row, and on a file
 * of short lines that prefix is a large fraction of each one -- exactly the case where a cut is
 * closest to not paying for itself.
 */
function renderedRunBytes(rows: NumberedRow[], start: number, len: number): number {
  let bytes = 0
  for (let i = start; i < start + len; i++) bytes += Buffer.byteLength(rows[i]?.raw ?? '', 'utf-8') + 1
  return bytes
}

/**
 * Replace stretches of a completed Read that the session has already been handed, keeping every
 * line it has not.
 *
 * `alreadyServedOutputId` withholds a read whose window is entirely inside an earlier delivery.
 * The partial case is the larger one and it cannot be denied: measured over a month of real
 * sessions, 589 Read calls carried a mix of new and already-served lines against 400 fully-served
 * ones, and denying any of the 589 would have deleted the new lines along with the old. Rewriting
 * the result keeps the new lines and turns the rest into a pointer at the copy the model holds.
 *
 * Line numbers survive untouched -- an elided run becomes a notice naming the exact range it stood
 * for, and every kept row is emitted verbatim, padding included, so the rewrite is purely
 * subtractive. Nothing downstream has to re-derive a position from a shortened body, and no part of
 * the saving comes from quietly reformatting rows that were not withheld.
 *
 * Skipped, each toward showing the model more rather than less:
 *   - anything `redactSecrets` would touch. On a pass-through the harness's own text reaches the
 *     model, so a file carrying a credential keeps behaving exactly as it does today instead of
 *     coming back redacted because it happened to overlap an earlier read.
 *   - a truncated read, which delivered less than its own window with no way from here to know
 *     where it stopped.
 *   - a rewrite that does not clear the shared net-savings floor.
 */
function elideAlreadyServedLines(event: HookEvent, respText: string): HookOutput | null {
  if (!loadConfig().hints.elide_served_lines) return null
  const filePath = getFilePath(event)
  if (filePath === undefined) return null
  const normalized = normalizePath(filePath)
  if (isImagePath(normalized)) return null
  if (respText.includes('[Truncated:') || respText.includes('Truncated: PARTIAL view')) return null

  const ids = getFileServedOutputs(normalized)
  if (ids.length === 0) return null
  const parsed = parseNumberedReadResult(respText, readStartLine(event))
  if (parsed === null) return null

  // Composing a rewrite makes this handler the author of what the model reads, and every sibling
  // that composes redacts first. Here the honest move is to decline instead: redacting would hand
  // back less of the user's own file than a plain Read does today.
  if (redactSecrets(respText).count > 0) return null

  const bodies: ServedBody[] = []
  // Newest first: the most recent delivery is the one most likely still in context.
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (id === undefined) continue
    const prior = getBashOutput(id)
    if (prior !== null) bodies.push(indexServedBody(id, prior.output))
  }
  if (bodies.length === 0) return null

  const budget = { left: SERVED_RUN_COMPARISON_BUDGET }
  // Row spans still eligible for a run. An elision splits its span in two, so a later pass can
  // still reach lines on either side of it.
  let spans: Array<[number, number]> = [[0, parsed.rows.length]]
  const cuts: ServedRun[] = []
  for (let pass = 0; pass < MAX_SERVED_ELISIONS; pass++) {
    let bestRun: ServedRun | null = null
    let bestSpan = -1
    for (let s = 0; s < spans.length; s++) {
      const span = spans[s]
      if (span === undefined) continue
      const run = longestServedRun(parsed.rows, span[0], span[1], bodies, budget)
      if (run !== null && (bestRun === null || run.len > bestRun.len)) {
        bestRun = run
        bestSpan = s
      }
    }
    if (bestRun === null || bestSpan < 0) break
    // Every cut pays for itself. The net-savings gate below judges the rewrite as a whole, which a
    // cut that loses bytes can hide inside as long as an earlier one won enough: this is what stops
    // a five-line overlap of short lines from costing a ~130-byte notice to remove ~45 bytes.
    const first = parsed.rows[bestRun.start]
    const last = parsed.rows[bestRun.start + bestRun.len - 1]
    if (first === undefined || last === undefined) break
    const noticeBytes = Buffer.byteLength(servedRunNotice(first.no, last.no, bestRun.id), 'utf-8') + 1
    if (renderedRunBytes(parsed.rows, bestRun.start, bestRun.len) <= noticeBytes) break
    cuts.push(bestRun)
    const chosen = spans[bestSpan]
    if (chosen === undefined) break
    const rebuilt: Array<[number, number]> = []
    for (let s = 0; s < spans.length; s++) {
      const span = spans[s]
      if (span === undefined) continue
      if (s !== bestSpan) {
        rebuilt.push(span)
        continue
      }
      if (bestRun.start > chosen[0]) rebuilt.push([chosen[0], bestRun.start])
      if (bestRun.start + bestRun.len < chosen[1]) rebuilt.push([bestRun.start + bestRun.len, chosen[1]])
    }
    spans = rebuilt
  }
  if (cuts.length === 0) return null

  cuts.sort((a, b) => a.start - b.start)
  const out: string[] = [...parsed.header]
  let at = 0
  for (const cut of cuts) {
    for (let i = at; i < cut.start; i++) out.push(parsed.rows[i]?.raw ?? '')
    const first = parsed.rows[cut.start]
    const last = parsed.rows[cut.start + cut.len - 1]
    if (first === undefined || last === undefined) return null
    out.push(servedRunNotice(first.no, last.no, cut.id))
    at = cut.start + cut.len
  }
  for (let i = at; i < parsed.rows.length; i++) out.push(parsed.rows[i]?.raw ?? '')
  out.push(...parsed.trailer)

  const rewritten = out.join('\n')
  const originalBytes = Buffer.byteLength(respText, 'utf-8')
  if (
    !isRewriteWorthwhile({
      originalBytes,
      rewrittenBytes: Buffer.byteLength(rewritten, 'utf-8'),
      noticeBytes: 0,
      minNetSavingsBytes: resolveMinNetSavingsBytes(),
    })
  ) {
    return null
  }
  return emitRewrite(rewritten, 'read', { kind: 'read:served_elide', originalBytes })
}

/** Lines kept at the head of each folded body: the declaration plus enough to judge the rest. */
const BODY_FOLD_KEEP_LINES = 8

/**
 * Shortest function span worth folding, in lines.
 *
 * Measured with this code path over the 162 source files in this repo above 8 KB, against an index written by the same parser build: keep=10/span>=25 removes 34.8% of delivered bytes across 150 files, keep=20/span>=40 removes 25.8% across 126, keep=6/span>=15 removes 41.0% across 152. The aggressive setting cuts into bodies short enough to read at a glance, which is where a fold costs the reader more than it saves; this is the middle one.
 */
const BODY_FOLD_MIN_SPAN = 20

/** Rows kept at the head of each folded comment block: enough for the summary a doc block opens with, and for a banner's title. */
const COMMENT_FOLD_KEEP_LINES = 2

/**
 * Shortest comment block worth folding, in rows.
 *
 * Measured over this repo's 256 source files, holding keep=10/span>=25 fixed and varying only this: >=30 rows adds 2.6 points of first-read savings, >=20 adds 5.1, >=12 adds 9.9, >=8 adds 14.2. The last of those starts folding ordinary eight-line explanations, which is where the notice costs a reader more than the rationale it defers; 12 is the point where a block is an essay rather than a note.
 */
const COMMENT_FOLD_MIN_BLOCK = 12

/** Symbols pulled per file. Matches ALL_SYMBOLS_IN_FILE_LIMIT without importing graph_commands. */
const BODY_FOLD_SYMBOL_LIMIT = 10000

/**
 * The line standing in for a folded body.
 *
 * It names the symbol, the exact line range removed, and the command that returns it -- everything needed to undo the fold without re-reading the file. Unlike a re-read elision, the reader has never seen these lines, so the notice must read as "here is what is missing and how to get it", not as a pointer to something already in context.
 */
function bodyFoldNotice(name: string, firstLine: number, lastLine: number, shownPath: string): string {
  const n = lastLine - firstLine + 1
  return `... ${n} more lines of ${name} (${firstLine}-${lastLine}) folded -- token-goat read "${shownPath}::${name}"`
}

/**
 * The line standing in for a folded comment block.
 *
 * A comment has no symbol to name, so there is no `token-goat read "file::symbol"` that returns it. What does return it is a ranged Read of the exact span, which is also the one Read shape this fold never touches -- offset/limit reads are left alone as already surgical -- so the pointer cannot loop back into another fold.
 */
function commentFoldNotice(firstLine: number, lastLine: number, shownPath: string): string {
  const n = lastLine - firstLine + 1
  return `... ${n} more comment lines (${firstLine}-${lastLine}) folded -- Read "${shownPath}" with offset=${firstLine}, limit=${n}`
}

/**
 * Replace the inside of long function bodies with a pointer, keeping everything else verbatim.
 *
 * This is the only mechanism on the Read path aimed at a FIRST read. Everything beside it -- served-run elision, identical-read collapse, the heading-tree re-read deny -- keys on prior sight, and 83.6% of hooked Read bytes have none.
 *
 * It uses the rewrite channel rather than a deny on purpose. A deny that carries a compact still blocks the call: the agent pays a round trip, may re-acquire the file anyway, and the measured analogue abandons its task 42.7% of the time and runs edit errors at 4x baseline. A rewrite changes only what the same successful call delivers, so none of those costs apply.
 *
 * Returns the rewrite together with the raw text it actually delivered, because the served-output store must record what the model saw and not what is on disk -- see {@link recordReadAsServedOutput}.
 */
function foldCodeBodies(event: HookEvent, respText: string): { output: HookOutput; deliveredRaw: string } | null {
  if (!loadConfig().hints.fold_code_bodies) return null
  const filePath = getFilePath(event)
  if (filePath === undefined) return null
  const normalized = normalizePath(filePath)
  if (isImagePath(normalized)) return null

  // A read carrying offset/limit is surgical already, and folding a window the caller deliberately narrowed answers a different question than the one asked. Same rule the subagent-markdown deny and the doc-compact intercept both apply.
  if (readIntToolInput(event, 'offset') !== undefined || readIntToolInput(event, 'limit') !== undefined) return null
  if (respText.includes('[Truncated:') || respText.includes('Truncated: PARTIAL view')) return null

  // Composing a rewrite makes this handler the author of what the model reads, and a file holding a secret would be handed back redacted. Declining is the honest move: a plain Read gives the user more of their own file than a redacted rewrite would. Same call as elideAlreadyServedLines.
  if (redactSecrets(respText).count > 0) return null

  const parsed = parseNumberedReadResult(respText, readStartLine(event))
  if (parsed === null) return null

  // The spans come from the index, so they describe the file the indexer last parsed. Fold only when that is still this file, on BOTH freshness keys: files.sha answers "has the content changed", parser_sha answers "did different extraction logic write these rows". Content alone is not enough -- measured on a real index, 37 of 237 source files disagreed with what the current parser produced while their content sha still matched. A stale span cuts at the wrong line, and on a first read there is no earlier copy for the reader to notice that against.
  // An unusable index costs the body folds and nothing else. Comment blocks are read off the delivered text, so they cannot be stale and do not need the index at all -- which is what keeps this working on a file the indexer has never seen, the case that used to return nothing.
  let spans: FoldSpan[] = []
  try {
    const entry = getFileEntry(normalized)
    if (
      entry !== null &&
      entry.sha !== '' &&
      entry.sha === fingerprintFile(normalized) &&
      entry.parserSha === PARSER_FINGERPRINT
    ) {
      spans = querySymbols({ filePath: normalized, limit: BODY_FOLD_SYMBOL_LIMIT })
    }
  } catch {
    // A missing or locked index is not a reason to fail a Read that already succeeded.
    spans = []
  }

  const bodyFolds = planBodyFolds(parsed.rows, spans, BODY_FOLD_KEEP_LINES, BODY_FOLD_MIN_SPAN)
  const claimed = new Set<number>()
  for (const fold of bodyFolds) for (let i = fold.startIdx; i < fold.startIdx + fold.len; i++) claimed.add(i)
  const commentFolds = planCommentFolds(
    parsed.rows,
    commentSyntaxFor(normalized),
    COMMENT_FOLD_KEEP_LINES,
    COMMENT_FOLD_MIN_BLOCK,
    claimed,
  )
  const folds = mergeFolds(bodyFolds, commentFolds)
  if (folds.length === 0) return null

  const shown = displaySafePath(normalized)
  const out: string[] = [...parsed.header]
  // The raw (un-numbered) form of the same delivery, for the served-output store, which compares against plain file lines rather than the tool's numbered rendering.
  const rawOut: string[] = []
  let at = 0
  for (const fold of folds) {
    for (let i = at; i < fold.startIdx; i++) {
      out.push(parsed.rows[i]?.raw ?? '')
      rawOut.push(parsed.rows[i]?.text ?? '')
    }
    out.push(fold.kind === 'comment' ? commentFoldNotice(fold.firstLine, fold.lastLine, shown) : bodyFoldNotice(fold.name, fold.firstLine, fold.lastLine, shown))
    at = fold.startIdx + fold.len
  }
  for (let i = at; i < parsed.rows.length; i++) {
    out.push(parsed.rows[i]?.raw ?? '')
    rawOut.push(parsed.rows[i]?.text ?? '')
  }
  out.push(...parsed.trailer)

  const rewritten = out.join('\n')
  const originalBytes = Buffer.byteLength(respText, 'utf-8')
  if (
    !isRewriteWorthwhile({
      originalBytes,
      rewrittenBytes: Buffer.byteLength(rewritten, 'utf-8'),
      noticeBytes: 0,
      minNetSavingsBytes: resolveMinNetSavingsBytes(),
    })
  ) {
    return null
  }
  return {
    output: emitRewrite(rewritten, 'read', { kind: 'read:body_fold', originalBytes }),
    deliveredRaw: rawOut.join('\n'),
  }
}

/**
 * Public wrapper: same tracking as {@link preReadHandler} above, plus the served-line elision.
 *
 * The order of these three lines is the whole correctness argument.
 *
 * The elision runs FIRST, before {@link recordReadAsServedOutput} puts this very read into the
 * store it compares against -- otherwise every line matches itself and the entire result is
 * withheld as "already served". It is the same self-contamination shape as a structural guard
 * that scans its own source.
 *
 * It also runs before {@link postReadHandlerInner}, whose structural-navigation hint would
 * otherwise be composed, booked as shown by {@link applyHintTracking}, and then thrown away in
 * favour of the rewrite -- a hint charged to the efficacy ledger that no model ever saw. The
 * flag is a required parameter rather than a defaulted one so no call site can silently take
 * the un-suppressed path the shipping one does not.
 *
 * The rewrite wins over the hint where both apply, because it acts on the bytes instead of
 * asking: a hint is followed a small fraction of the time, and a withheld run is withheld.
 */
export function postReadHandler(event: HookEvent): HookOutput {
  const respText = extractReadOutput(event.raw)
  const elided = elideAlreadyServedLines(event, respText)
  // Only one rewrite may win, and elision goes first: it cuts lines the model already holds, which costs the reader nothing, while a fold withholds lines it has never seen. Running both would also double-count the same bytes in the ledger.
  const folded = elided === null ? foldCodeBodies(event, respText) : null
  const rewrite = elided ?? folded?.output ?? null
  const out = applyHintTracking(event, postReadHandlerInner(event, rewrite !== null), classifyReadHint)
  recordReadAsServedOutput(event, folded?.deliveredRaw ?? null)
  return rewrite ?? out
}

registerHook('post_tool_use', postReadHandler, { toolName: 'Read' })
