/**
 * pre_tool_use hook for the Bash tool.
 *
 * When a build tool command (cargo, go, mvn, make, etc.) is about to run and its output is already cached in the session bash-output store, inject a recall hint so the model can inspect cached output instead of re-running the command.
 */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, denyOutput, emitRewrite, passOutput, extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS, getCwd } from './hooks_common.js'
import { applyHintTracking, classifyBashHint, meetsSavingsFloor, logSuppressedDetection } from './hint_stats.js'
import { fenceUntrusted, fenceUntrustedSpans } from './untrusted_fence.js'
import { UNTRUSTED_TOOL_TAG, type FenceSpan } from './injection_scan.js'
import type { HookOutput } from './types.js'
import { getBashOutputId, getFileServedOutputs, recordFileServedOutput, recordBashOutput, recordBashRerun, recordCurlDownload, getCurlDownloadPath, clearCurlDownload, getFileLineRanges, recordFileLineRange, recordFileRead, markFileTruncated, wasHintShown, markHintShown, wasCliReadThisSession, recordCliRead, recordSymbolRead, wasFileReadThisSession, takePendingLargeFileHint, GENERIC_SERVED_OUTPUT_KEY } from './session.js'
import { resolveIndexPath, toDisplayPath, displaySafePath, displaySafeText } from './paths.js'
import { shortFingerprint } from './fingerprint.js'
import { isBuildCommand, getMonitoringRecallHint, isTestRunnerCommand } from './hints/lang_patterns.js'
import { storeBashOutput, getBashOutput, isBashEntryStale, isScopedGitStatusOrDiffStatCommand, commandHash, bashOutputIdSync, summarizeOutputDelta } from './bash_output_cache.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { loadConfig } from './config.js'
import { deliveredOutputBytes, clipToDeliveryCap } from './delivery_cap.js'
import { foldDelivery, foldingEnabled, type FoldRow } from './fold_delivery.js'
import { isStructuralRewriteAccepted, planMarkdownOutline, planSourceSkeleton } from './fold_structure.js'
import { foldDetail, type BodyFold } from './code_fold.js'
import { redactSecrets } from './secret_redact.js'
import { findProject } from './project.js'
import { indexServedBody, planServedElisions, servedRunNotice, type NumberedRow, type ServedBody } from './served_lines.js'
import { compressOutput, detectFromCommand, filterByName, isRewriteWorthwhile, resolveMinNetSavingsBytes, splitOwnTrailingNotices } from './tool_filters/index.js'
import { stripAnsiEscapes } from './render/ansi.js'
import { looksLikeHtml, extractCleanText } from './web_extract.js'
import { canRunWrappedShell, canRunPowerShell } from './shell.js'
import { detectStructuralIndexRewrite } from './bash_structural_index.js'
import { rangeSubstituteFor } from './bash_range_savings.js'
import { runnableTargetFor } from './bash_surgical_target.js'
import { statSync, existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { runGit, IDENTICAL_READ_MIN_BODY_BYTES, containsLineRun } from './util.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { isInsideRoot } from './path_containment.js'
import { projectTranscriptsDir } from './waste.js'
import { MAX_CAPTURE_BYTES } from './bash_runner.js'
import {
  stripCdPrefix,
  stripTrailingStderrRedirect,
  hasTestRunScopeOrBudget,
  isDirectTestRunnerCommand,
  resolveCdHintPath,
  cdPrefixCwd,
  stripOutputPipeline,
  pipelineDivergenceNote,
  extractCommand,
  isHeadMovingGitCommand,
  ORIG_HEAD_ELIGIBLE_GIT_RE,
  ORIG_HEAD_REFLOG_MSG_RE,
  gitRepoRoot,
  enqueueNonHeadMovingRewrites,
  pipelineShapeFilter,
  isFullRecallCommand,
  pureFileReadPath,
  deliveredLineNumbers,
  isWholeFileDump,
  unwrapCompressCommand,
  detectUnbalancedShellSyntax,
} from './hooks_bash_commands.js'

export { isHeadMovingGitCommand, stripTrailingStderrRedirect } from './hooks_bash_commands.js'

import {
  surgicalHintFor,
  surgicalHintForConfigDoc,
  extractCatSourceFile,
  extractCatFile,
  extractCatFilesMulti,
  commandPathIsTouchable,
  extractPowerShellWrappedGetContent,
  extractPowerShellFileMethodRead,
  extractTerminalXmlParsing,
  extractRgSymbolSearch,
  extractCatJsonPipe,
  extractPowerShellJsonPipeline,
  extractWslCatFile,
  extractPythonFileRead,
  extractHeadFile,
  extractLineRangeRead,
  extractLineRangeReadsCompound,
  sedRangeHint,
  type RangeSubstituteFigures,
  leadingLinesHint,
  findRangeOverlap,
  sedOverlapHint,
  extractNodeFileRead,
  extractTailFile,
  extractGetContentTail,
  extractGetContentSelectFirst,
  extractGetContentHead,
  taskOutputIsJsonlTranscript,
  extractTasksOutput,
  extractToolResultsFile,
  extractDirectoryListing,
  extractForLoopWcL,
  extractFindCommand,
  extractMarkdownHeadingGrep,
  extractRgStructuralSearch,
  extractGrepPipeChain,
  extractCurlUrl,
  extractTgSurgicalRead,
  isCurlGetCommand,
  isReadOnlyGhApi,
  GH_VIEW_BATCH_HINT_KEY,
  extractGhViewForBatchAdvisory,
  buildGhViewBatchAdvisory,
  extractCurlDownload,
  buildRecallHint,
  shellQuoteSingle,
  isCompressibleSingleCommand
} from './bash_extractors.js'

export {
  extractCatFile,
  extractCatFilesMulti,
  extractPowerShellWrappedGetContent,
  extractPowerShellFileMethodRead,
  extractRgSymbolSearch,
  type PythonFileReadResult,
  extractPythonFileRead,
  extractMarkdownHeadingGrep,
  extractGhViewForBatchAdvisory,
  extractCurlDownload,
} from './bash_extractors.js'

/**
 * Wrap a recognized command in `token-goat compress` so its output is structurally compressed on this run. Returns a `rewriteInput` HookOutput that replaces the Bash tool input wholesale (preserving description/timeout), or null when compression is disabled (`TOKEN_GOAT_BASH_COMPRESS=0` or config), the command is unsuitable, or the chosen filter is disabled.
 *
 * @param event  hook event; its toolInput is preserved verbatim except `command`
 * @param rawCmd original command INCLUDING any `cd … &&` prefix (run by compress)
 * @param cmd    the cd-stripped command, used only to pick the filter
 */
function maybeCompressRewrite(event: HookEvent, rawCmd: string, cmd: string): HookOutput | null {
  if (process.env['TOKEN_GOAT_BASH_COMPRESS'] === '0') return null
  // VS Code's run_in_terminal runs the command in whatever shell the user's terminal uses, and its payload does not say which one, so no quoting of the wrapped command is safe in every one of them: the command is never rewritten there.
  if (event.raw['_tg_harness'] === 'vscode') return null

  const isPwshHarness =
    process.platform === 'win32' &&
    (event.raw['_tg_harness'] === 'codex' ||
      event.raw['_tg_harness'] === 'copilot_cli' ||
      event.raw['tool_name'] === 'powershell')

  if (isPwshHarness) {
    if (!canRunPowerShell()) return null
  } else {
    // No usable shell to run the wrapper under (Windows with no Git-Bash): leave the command to run normally in the harness bash, uncompressed, rather than wrapping it into a cmd.exe execution.
    if (!canRunWrappedShell()) return null
  }

  let cfg: { enabled: boolean; disabled_filters: string[]; timeout_seconds: number }
  try {
    cfg = loadConfig().bash_compress
  } catch {
    return null
  }
  if (!cfg.enabled) return null

  // A specific filter (once the framework recognizes the command) wins over the generic catch-all. Either way the command must be a single pipe/redirect-free invocation: detectFromCommand enforces that for specific filters; the generic path requires it explicitly.
  const gateCmd = stripTrailingStderrRedirect(cmd)
  const detected = detectFromCommand(gateCmd, getCwd(event))
  let filterName: string
  if (detected !== null) {
    filterName = detected.filter.name
  } else if (isCompressibleSingleCommand(gateCmd)) {
    filterName = 'generic'
  } else {
    return null
  }
  if (cfg.disabled_filters.includes(filterName)) return null

  if (isPwshHarness) {
    // For PowerShell harnesses on Windows (Codex, Copilot CLI), avoid shell quoting pitfalls (backslashes, quotes, operators) by using base64.
    // Skip wrapping if the base64 representation does not round-trip exactly.
    const b64 = Buffer.from(rawCmd, 'utf8').toString('base64')
    if (Buffer.from(b64, 'base64').toString('utf8') !== rawCmd) return null

    const wrapped = `token-goat compress -f ${filterName} --timeout ${cfg.timeout_seconds} --shell pwsh --cmd-b64 ${b64}`
    return { hookType: 'rewriteInput', updatedInput: { ...event.toolInput, command: wrapped } }
  }

  const wrapped = `token-goat compress -f ${filterName} --timeout ${cfg.timeout_seconds} -c ${shellQuoteSingle(rawCmd)}`
  return { hookType: 'rewriteInput', updatedInput: { ...event.toolInput, command: wrapped } }
}

/**
 * The stretches of a shell file read this session already served, withheld in place.
 *
 * The containment collapse this sits inside is all-or-nothing: it fires only when the whole output appears verbatim inside one earlier body. Measured over 201 session transcripts, that caught 0.49 MB across 211 of 3,848 shell range reads, while another 1.96 MB of already-served lines shipped again inside reads that merely overlapped rather than nested -- `sed -n '100,140p'` after `sed -n '120,160p'` is not contained in anything, yet half of it has been seen. This applies the per-stretch search the Read hook already uses, over the same per-file served store, differing only in that shell output carries no line-number gutter so a row's rendered form is the line itself.
 *
 * `unknownLineNumbers` is for a caller that has no file to pin rows to at all (a generic command's stdout): it skips `deliveredLineNumbers` and numbers every row null, which `servedRunNotice` already renders as a line count instead of a range -- the same fallback the compound-read case below relies on.
 *
 * Returns null when the numbering is unknowable, when nothing overlaps, or when no cut pays for the notice replacing it.
 */
function elideServedShellLines(cmd: string, output: string, priorIds: readonly string[], unknownLineNumbers = false): FenceSpan[] | null {
  if (priorIds.length === 0) return null
  const lines = output.split('\n')
  const numbers = unknownLineNumbers ? Array.from({ length: lines.length }, () => null) : deliveredLineNumbers(cmd, lines.length)
  if (numbers === null) return null
  // `?? null` rather than `?? 0`: a row whose number the command does not determine has to stay unknown all the way to the notice, which then counts the lines instead of naming them. Coercing it to a number here would print `lines 0-0`, which reads exactly like a real answer.
  const rows: NumberedRow[] = lines.map((text, i) => ({ no: numbers[i] ?? null, text, raw: text }))
  const bodies: ServedBody[] = []
  for (let i = priorIds.length - 1; i >= 0; i--) {
    const id = priorIds[i]
    if (id === undefined) continue
    const prior = getBashOutput(id)
    if (prior !== null) bodies.push(indexServedBody(id, prior.output))
  }
  const cuts = planServedElisions(rows, bodies)
  if (cuts.length === 0) return null
  // Spans, not one joined string. The notices below are token-goat's own voice spliced BETWEEN the command's own lines, so this body has no cut point that puts our words outside a fence tag. Marking authorship here -- where it is known, because this function just wrote them -- is what lets the fencer neutralize the command's lines without mangling our notices into `&#91;token-goat] ...`. Matching the notices by their text later would be forgeable by the very bytes being fenced.
  const spans: FenceSpan[] = []
  const push = (text: string, own: boolean): void => {
    const sep = spans.length === 0 ? '' : '\n'
    const prev = spans[spans.length - 1]
    if (prev !== undefined && (prev.own === true) === own) spans[spans.length - 1] = { text: prev.text + sep + text, own }
    else spans.push({ text: sep + text, own })
  }
  let at = 0
  for (const cut of cuts) {
    for (let i = at; i < cut.start; i++) push(rows[i]?.raw ?? '', false)
    const first = rows[cut.start]
    const last = rows[cut.start + cut.len - 1]
    if (first === undefined || last === undefined) return null
    push(servedRunNotice(first.no, last.no, cut.id, cut.len), true)
    at = cut.start + cut.len
  }
  for (let i = at; i < rows.length; i++) push(rows[i]?.raw ?? '', false)
  return spans
}

/**
 * Fold the long bodies out of a shell read of a source file, the way the Read hook already folds its own first reads.
 *
 * Why this surface needs its own caller: measured over 814 session transcripts, 15.61 MB of source arrives through `cat`, `head` and `sed -n` rather than through the Read tool, and none of it is visible to the Read hook. It is a first-read surface, so every mechanism beside this one is useless on it -- the elision above needs an earlier delivery to withhold against, and on a first read there is not one.
 *
 * It cannot borrow the Read path's safety rule. That path declines any read carrying offset or limit, on the grounds that a window the caller deliberately narrowed is surgical already; here 14.61 MB of the 15.61 MB is a range, so the same rule would exempt the surface rather than protect it. What protects a range instead is `planBodyFolds` requiring a span's declaration to sit among the delivered rows, which is what stops a window landing inside one enormous function from folding away to a single notice.
 *
 * Returns null whenever the delivery cannot be pinned to file lines. A `tail` has no fixed first line, and a compound read interleaves its ranges with whatever the segments between them printed, so `deliveredLineNumbers` reports every row as unknown. Folding either would cut at a guessed line and then print that guess inside a notice, where it reads exactly like a real answer.
 */
function foldShellReadBodies(cmd: string, output: string, fileKey: string, cwd: string | null): { text: string; folds: readonly BodyFold[] } | null {
  if (!foldingEnabled()) return null
  // Composing a rewrite makes this handler the author of what the model reads, and a file holding a secret would be handed back redacted. Declining is the honest move: a plain read gives the user more of their own file than a redacted rewrite would. Same call foldCodeBodies makes on the Read side.
  if (redactSecrets(output).count > 0) return null

  const lines = output.split('\n')
  const numbers = deliveredLineNumbers(cmd, lines.length)
  if (numbers === null) return null
  const rows: FoldRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const no = numbers[i]
    // One unknown row abandons the whole fold. `?? 0` here would put a fabricated line number into a notice that otherwise reads as a precise answer. Defence in depth, and deliberately not claimed as more than that: `deliveredLineNumbers` today returns either all-real numbers or all-null, and the all-null case is already rejected downstream by the `lastRow.no - firstRow.no + 1 === len` contiguity check in both planners, so mutating this line to `?? 0` leaves the suite green. What it guards is a *mixed* array, which no producer emits yet and which the contiguity check would wave through for any run that happened to be numbered.
    if (no === undefined || no === null) return null
    rows.push({ no, text: lines[i] ?? '', raw: lines[i] ?? '' })
  }

  // Whether the model is holding a slice rather than the whole file. Left to its default this was false for every shell read, so the shell door folded windows without the edge guard the Read door applies. A fold touching an edge of a slice has a recall that re-folds its own answer and hands back less than the notice promised. A ranged read is always a slice. A `head -n N` that came back with fewer than N rows hit end-of-file, so it delivered the whole file and its edges are the file's own; one that returned N or more may have been truncated and is treated as a window. That ambiguous case costs at most one edge fold, where guessing the other way ships a recall that folds itself. Written as positive matchers rather than `extractCatFile(cmd) === null` so a command both matchers claim is still treated as the window it is, mirroring the precedence deliveredLineNumbers already uses.
  const headRead = extractHeadFile(cmd) ?? extractGetContentHead(cmd)
  const windowed = extractLineRangeRead(cmd) !== null || (headRead !== null && lines.length >= headRead.n)
  // Repo-relative, so the notice stays a command that can be run as printed without carrying an absolute Windows path once per fold. Against the directory a leading `cd` actually left the shell in, which is the cwd already resolved into fileKey.
  const folded = foldDelivery(rows, fileKey, displaySafePath(toDisplayPath(findProject(cwd ?? process.cwd())?.root, fileKey)), windowed)
  if (folded === null) return null
  return { text: folded.numbered.join('\n'), folds: folded.folds }
}


/**
 * Replace a bare whole-file shell dump of a large document or source file with the same structural view the Read hook already gives the identical bytes: a heading tree for prose, a declaration skeleton for code.
 *
 * The planners are shared with hooks_read.ts (see fold_structure.ts), so `cat CLAUDE.arch.md` and `Read CLAUDE.arch.md` either both fold or both decline. What is local here is the proof the Read side gets for free from its tool input: that this stdout genuinely IS the file's bytes.
 *
 * That proof is the on-disk size check. A command whose output is the file has stdout exactly as long as the file, so a mismatch means something else happened -- the harness truncated the delivery, the command was not what the shape check took it for, or the file changed under it -- and any of those make a fold a claim the bytes do not support. It is also the only truncation guard available on this surface, which has no equivalent of the notice the Read tool prints. A `Get-Content` of a CRLF file, whose line-ending handling changes the byte count, fails it and is declined rather than folded on a guess.
 */
function foldShellReadStructure(cmd: string, filePath: string, output: string, fileKey: string, cwd: string | null): { text: string; kind: string; detail: string } | null {
  if (!isWholeFileDump(cmd, filePath)) return null
  const originalBytes = Buffer.byteLength(output, 'utf-8')
  let onDisk: number
  try {
    onDisk = statSync(fileKey).size
  } catch {
    return null
  }
  if (onDisk !== originalBytes) return null
  // Composing a rewrite makes this handler the author of what the model reads, and a file holding a secret would be handed back redacted. Declining is the honest move: a plain read gives the user more of their own file than a redacted rewrite would. Same call foldShellReadBodies makes above.
  if (redactSecrets(output).count > 0) return null

  const lines = output.split('\n')
  // A file ending in a newline splits to a final empty element that is not one of its lines. Left in, it becomes a phantom row the skeleton's `limit=` pointer would over-count by one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const rows: FoldRow[] = lines.map((text, i) => ({ no: i + 1, text, raw: text }))

  // Repo-relative, so each notice stays a command that can be run as printed without carrying an absolute Windows path. Against the directory a leading `cd` actually left the shell in, which is the cwd already resolved into fileKey.
  const shown = displaySafePath(toDisplayPath(findProject(cwd ?? process.cwd())?.root, fileKey))
  const fold = planMarkdownOutline(rows, fileKey, shown, originalBytes) ?? planSourceSkeleton(rows, fileKey, shown, originalBytes)
  if (fold === null) return null
  const text = fold.numbered.join('\n')
  if (!isStructuralRewriteAccepted(originalBytes, Buffer.byteLength(text, 'utf-8'), fold.ratioCap)) return null
  // Filed under the bash_compress prefix, not the read: kinds the planners carry for their own surface, so the ledger attributes these bytes to the shell surface that actually delivered them.
  return { text, kind: fold.kind === 'read:markdown_outline' ? 'bash_compress:markdown-outline' : 'bash_compress:source-skeleton', detail: fold.detail }
}

/**
 * Collapse a byte-identical re-run of a pure file read down to a pointer at the cached copy.
 *
 * Unlike every other rewrite in this handler, this one needs no judgement about which parts of the output matter, because nothing is being summarized: the bytes the model already holds and the bytes it would be handed again are the same bytes. Only a duplicate is dropped, and the original stays whole in the bash-output cache, so a caller that genuinely wants it back can ask.
 *
 * Why a rewrite and not a hint. The advisory channel measurably does not work for bash: the `bash_redirect` and `bash_recall` hint categories sit at 2.7% and 13.8% acted-on and are suppressed by the backoff ledger for that reason, while the two paths that act on the payload instead of asking for cooperation (`read_reread_dedup`, `edit_reread_suggest`) sit at 95.6% and 98.5%. Advice about a redundant read still costs the redundant read.
 *
 * Returns null -- leaving output untouched -- on a command's first run, when the file changed so the output differs, on a non-zero exit, or when the net-benefit gate declines. The first run is also where the body gets cached, so a later identical run has a baseline to compare against.
 */
/** Appended OUTSIDE the fence when a composed rewrite had to be cut back to fit the delivery cap. */
const REWRITE_CLIP_NOTE = '\n[token-goat: rewrite clipped to the harness delivery cap; the pointer above recalls the untouched output]'

/**
 * Fence a body this file composed, clipped so that the fence still closes.
 *
 * The single place the tool-output fence is applied to a Bash rewrite, so no call site restates either half of the rule. Both halves are load-bearing:
 *
 * - The fence goes on because these bodies are SUBSTITUTIONS: token-goat splices its own notices in beside bytes it did not write, so the model needs to see where one voice ends. A pure pass-through owes no fence and does not come through here (see {@link maybeStripAnsiOnly}).
 * - The clip goes on because the harness truncates a result from the END and PERSISTS the substitute. An over-long fenced rewrite would therefore ship with its closing tag and its recall pointer cut off, leaving the model an unterminated fence and no route back to the original. Overhead is measured off a real fence call rather than assumed, because `fenceUntrustedSpans` returns the body unchanged when injection fencing is switched off.
 *
 * The caller prices what this RETURNS, never the unfenced body: pricing the body and then fencing it is how a fence silently pushes a rewrite under its own net-benefit gate, at which point the rewrite is declined and the bytes ship unfenced anyway.
 */
function fenceRewriteWithinCap(spans: readonly FenceSpan[]): string {
  const joined = spans.map((s) => s.text).join('')
  const fenced = fenceUntrustedSpans(spans, UNTRUSTED_TOOL_TAG)
  // Fencing switched off: nothing was wrapped around the body, so there is no closing tag to lose and the cap behaves exactly as it did before this fence existed.
  if (fenced === joined) return joined
  const overhead = Buffer.byteLength(fenced, 'utf-8') - Buffer.byteLength(joined, 'utf-8') + Buffer.byteLength(REWRITE_CLIP_NOTE, 'utf-8')
  const cut = clipToDeliveryCap(joined, overhead)
  if (!cut.clipped) return fenced
  // Re-cut the spans to the clipped length so authorship survives the clip: the clipped text is a prefix of `joined`, so taking that many characters back off the span list reproduces it exactly.
  const kept: FenceSpan[] = []
  let left = cut.text.length
  for (const s of spans) {
    if (left <= 0) break
    kept.push(s.text.length <= left ? s : { ...s, text: s.text.slice(0, left) })
    left -= s.text.length
  }
  return fenceUntrustedSpans(kept, UNTRUSTED_TOOL_TAG) + REWRITE_CLIP_NOTE
}

async function maybeCollapseIdenticalRead(
  cmd: string,
  rawCmd: string,
  output: string,
  exitCode: number | null,
  cwd: string | null,
  cacheMinBytes: number,
): Promise<HookOutput | null> {
  if (process.env['TOKEN_GOAT_BASH_COMPRESS'] === '0') return null
  // A failed read's output is an error message, not file content. Never store one as the baseline a later run would be collapsed against, and never collapse one away.
  if (exitCode !== null && exitCode !== 0) return null
  const filePath = pureFileReadPath(cmd)
  if (filePath === null) return null
  const originalBytes = Buffer.byteLength(output, 'utf-8')
  if (originalBytes < Math.max(cacheMinBytes, IDENTICAL_READ_MIN_BODY_BYTES)) return null

  // Session-scoped, deliberately. The blob cache behind storeBashOutput is on disk and outlives the session, but this rewrite's whole claim is that the model already holds these bytes -- which is only true if the earlier read happened in THIS conversation. Keying on the session's own per-file index (serialized per session id, and cleared on compaction) rather than on the blob cache alone is what makes the claim true: a first read in a fresh session finds nothing here and passes through whole, even when an identical body from yesterday is still sitting in the blob cache.
  //
  // Keyed by file rather than by command, because the measured waste is not one command repeated: it is several spellings of overlapping reads of one file, which hash differently and return different bytes. Newest first, since a later body is the more likely container and stopping at the first hit bounds how many blobs get read. Against the directory a leading `cd DIR` actually leaves the shell in, not this hook's own cwd: `cd docs` then a read of `README.md` is a different file from the `README.md` beside it, and two files can hold identical text. `cmd` arrives with the prefix already stripped, so the raw form is what still knows where the shell went.
  const fileKey = resolveIndexPath(filePath, cdPrefixCwd(rawCmd, cwd ?? process.cwd()))
  const priorIds = getFileServedOutputs(fileKey)
  let containerId: string | null = null
  let identical = false
  for (let i = priorIds.length - 1; i >= 0; i--) {
    const id = priorIds[i]
    if (id === undefined) continue
    const prior = getBashOutput(id)
    if (prior === null || !containsLineRun(prior.output, output)) continue
    containerId = id
    identical = prior.output === output
    break
  }

  const sessionKey = shortFingerprint(stripOutputPipeline(cmd))
  if (containerId === null) {
    // Nothing served this session contains these lines whole. That is not the same as nothing having been served: a read overlapping an earlier one without nesting inside it lands here too, and used to ship every already-seen line again. Withhold just those stretches, then cache what was actually delivered so a later read is matched against what the model saw rather than what the command printed.
    const elided = elideServedShellLines(cmd, output, priorIds)
    const priced = (text: string): boolean => isRewriteWorthwhile({ originalBytes, rewrittenBytes: Buffer.byteLength(text, 'utf-8'), noticeBytes: 0, minNetSavingsBytes: resolveMinNetSavingsBytes() })

    // Elision first, because withholding lines the model has already been shown always beats folding lines it has not. The fold is what is left for a first read, which is where this branch spends most of its time: there is nothing served to withhold and, until now, nothing else to do either.
    let rewrite: { text: string; reason: string; kind: string; detail?: string } | null = null
    if (elided !== null) {
      // Priced AFTER fencing, deliberately: see fenceRewriteWithinCap.
      const fenced = fenceRewriteWithinCap(elided)
      if (priced(fenced)) rewrite = { text: fenced, reason: 'already-served file lines withheld', kind: 'bash_compress:served-elide' }
    } else {
      // Structural replacement ahead of the body fold, matching the order postReadHandler applies to the identical bytes arriving through the Read tool. It is also the coarser of the two and the only one that works without an index: the body fold needs symbol spans written by the current parser build, and measured on a real index that stamp sits stale on 95% of this project's rows, so on most first reads it plans nothing at all.
      const structural = foldShellReadStructure(cmd, filePath, output, fileKey, cwd)
      if (structural !== null && priced(structural.text)) {
        rewrite = { text: structural.text, reason: structural.kind === 'bash_compress:markdown-outline' ? 'document replaced with its heading tree' : 'source replaced with its structural skeleton', kind: structural.kind, detail: structural.detail }
      }
      if (rewrite === null) {
        // One untrusted span: unlike the elision above, every notice this fold splices in (`... N more lines of X folded`, the comment and prose variants beside it) is bracket-free, and the marker neutralizer only matches the bracketed forms -- so nothing token-goat authored is at risk from fencing the block whole. Same argument planSourceSkeleton already makes for the structural fold, which is why that path arrives fenced by its own producer.
        const folded = foldShellReadBodies(cmd, output, fileKey, cwd)
        if (folded !== null) {
          const fenced = fenceRewriteWithinCap([{ text: folded.text }])
          if (priced(fenced)) rewrite = { text: fenced, reason: 'code bodies folded', kind: 'bash_compress:body-fold', detail: foldDetail(fileKey, folded.folds) }
        }
      }
    }

    // Exactly what the model was shown, never what the command printed. A later read of this file is matched against this copy, so storing a rewrite the net-benefit gate went on to decline would record lines as withheld that the reader actually received.
    const storedId = await storeBashOutput(cmd, rewrite?.text ?? output, exitCode ?? 0, cwd)
    recordBashOutput(sessionKey, storedId, originalBytes)
    recordFileServedOutput(fileKey, storedId)
    if (rewrite === null) return null
    // Priced against the delivered size for the same reason the containment pointer below is: the harness truncates a Bash result before the model sees it, so collapsing an oversized body spares at most the delivered slice.
    return emitRewrite(rewrite.text, rewrite.reason, { kind: rewrite.kind, originalBytes: deliveredOutputBytes(originalBytes), ...(rewrite.detail === undefined ? {} : { detail: rewrite.detail }) })
  }

  const pointer = identical
    ? '[token-goat] Identical to an earlier run of this command in this session; the file has not changed since. ' + originalBytes + ' bytes withheld -- recall them with `token-goat bash-output ' + containerId + ' --full`.'
    : '[token-goat] These ' + originalBytes + ' bytes already appear verbatim inside a wider read of ' + filePath + ' served earlier in this session. Withheld -- recall the full earlier output with `token-goat bash-output ' + containerId + ' --full`.'
  if (!isRewriteWorthwhile({ originalBytes, rewrittenBytes: Buffer.byteLength(pointer, 'utf-8'), noticeBytes: 0, minNetSavingsBytes: resolveMinNetSavingsBytes() })) return null
  // Deliberately NOT recordBashRerun() here, unlike the delta path below. That call marks the earlier run as safe for the compaction manifest to drop, which is right when a newer *full* copy has superseded it. Here the newer copy is a pointer, so dropping the earlier one would strand this pointer and leave the transcript with neither the body nor a duplicate of it. The earlier full copy is precisely what this rewrite is pointing at, so it must stay. Priced against the delivered size, not the original: the harness truncates a Bash result before the model sees it, so collapsing an oversized body spares at most the delivered slice. See deliveredOutputBytes in src/delivery_cap.ts. The worthwhile gate above deliberately stays on the uncapped bytes -- this is an accounting correction, not a change to which rewrites ship.
  return emitRewrite(pointer, identical ? 'identical file re-read collapsed' : 'already-served file lines collapsed', { kind: identical ? 'bash_compress:identical-reread' : 'bash_compress:contained-reread', originalBytes: deliveredOutputBytes(originalBytes) })
}

/**
 * Withhold already-served stretches inside a generic (non-file-read) Bash result: `npm test`, `git log`, `rg`, build output, and the rest of the surface `maybeCollapseIdenticalRead` cannot reach because it requires a `pureFileReadPath`.
 *
 * Reuses the same per-stretch search and notice as the file-read path above, over a session-wide served-output list instead of a per-file one -- there is no file to key this content on, and the search only ever withholds a run that is genuinely contiguous inside one earlier delivered body, so mixing unrelated commands' output into one list cannot manufacture a false match.
 *
 * Always stores what was actually delivered (the rewrite when one fires, otherwise the original) as a future match target, the same discipline `maybeCollapseIdenticalRead` follows and for the same reason: matching a later read against what the command printed, rather than what the model was shown, would credit lines never delivered.
 */
async function maybeElideServedGenericOutput(
  cmd: string,
  output: string,
  exitCode: number | null,
  cwd: string | null,
  cacheMinBytes: number,
): Promise<HookOutput | null> {
  if (process.env['TOKEN_GOAT_BASH_COMPRESS'] === '0') return null
  if (!loadConfig().bash_compress.elide_served_shell_output) return null
  // A failed command's output is an error message, not content a later run should be matched against or have withheld from it.
  if (exitCode !== null && exitCode !== 0) return null
  // storeBashOutput redacts before writing to the served-output list, so a later call's un-elided rows would be compared against a REDACTED prior body: a live secret in an unmatched row (the match starts after it, or never starts at all) would then ship raw inside a rewrite this function composed, same class of bug foldShellReadBodies/foldShellReadStructure above already decline for. Declining outright, rather than only skipping the parts that touch a secret, keeps this consistent with those: a plain, untouched command result is never less safe than one this function partially reassembles.
  if (redactSecrets(output).count > 0) return null
  const originalBytes = Buffer.byteLength(output, 'utf-8')
  if (originalBytes < cacheMinBytes) return null

  // Excludes a prior run of this SAME command: an identical rerun of, say, `npm test` is the finding, not redundancy -- collapsing it away deletes the one piece of information a rerun carries, that the result did not change. bash_identical_read_collapse.test.ts pins exactly this for maybeCollapseIdenticalRead's own file-read case; a same-command rerun reaching this generic path must not quietly reintroduce the same collapse through a different door. A stretch shared with a DIFFERENT command's earlier output carries no such signal, so it is still fair game.
  const priorIds = getFileServedOutputs(GENERIC_SERVED_OUTPUT_KEY).filter((id) => getBashOutput(id)?.command !== cmd)
  let rewrittenText: string | null = null
  if (priorIds.length > 0) {
    const elided = elideServedShellLines(cmd, output, priorIds, true)
    // Fenced before it is priced, for the reason spelled out on fenceRewriteWithinCap: this body is the command's own rows with token-goat's `[token-goat] N lines ... withheld` notices spliced between them, which is a substitution and owes a fence.
    const fenced = elided === null ? null : fenceRewriteWithinCap(elided)
    if (fenced !== null && isRewriteWorthwhile({ originalBytes, rewrittenBytes: Buffer.byteLength(fenced, 'utf-8'), noticeBytes: 0, minNetSavingsBytes: resolveMinNetSavingsBytes() })) {
      rewrittenText = fenced
    }
  }
  const storedId = await storeBashOutput(cmd, rewrittenText ?? output, exitCode ?? 0, cwd)
  recordFileServedOutput(GENERIC_SERVED_OUTPUT_KEY, storedId)
  if (rewrittenText === null) return null
  return emitRewrite(rewrittenText, 'already-served shell output collapsed', { kind: 'bash_compress:generic-served-elision', originalBytes: deliveredOutputBytes(originalBytes) })
}

async function maybeCompressCompoundOutput(
  cmd: string,
  output: string,
  exitCode: number | null,
  cwd: string | null,
  cacheMinBytes: number,
  isUnwrapped = false,
): Promise<HookOutput | null> {
  if (process.env['TOKEN_GOAT_BASH_COMPRESS'] === '0') return null
  // Single commands were handled by the pre-hook's wrapper if wrapped; unwrapped single commands (e.g. in environments without pre-hook rewriting) reach here and are eligible for compression.
  if (!isUnwrapped && isCompressibleSingleCommand(cmd)) return null
  // A recall of already-delivered full output must survive verbatim, or a piped/chained read of it (e.g. `bash-output <id> --full | head -300`) gets recompressed into a new, smaller pointer -- the model asked for the full text back and got another summary.
  if (isFullRecallCommand(cmd)) return null
  // Don't compact a command that reported a non-zero exit: a failing compound pipeline's diagnostics must reach the model in full on its first read, not behind a `--full` recall. An unknown exit (null -- common on harnesses that do not report one) is treated as non-failure, matching the success gates elsewhere in this handler.
  if (exitCode !== null && exitCode !== 0) return null
  let cfg: { enabled: boolean; disabled_filters: string[]; max_lines: number; max_bytes: number }
  try {
    cfg = loadConfig().bash_compress
  } catch {
    return null
  }
  if (!cfg.enabled || cfg.disabled_filters.includes('generic')) return null
  if (Buffer.byteLength(output, 'utf-8') < cacheMinBytes) return null
  // A pure pipeline whose downstream stages only pass bytes through gets the filter for whatever shaped them; an unwrapped single command gets its command-specific filter; everything else keeps the generic filter this path has always used.
  const shaped = pipelineShapeFilter(cmd, cwd) ?? (isUnwrapped ? detectFromCommand(cmd, cwd ?? undefined) ?? null : null)
  const useShaped = shaped !== null && !cfg.disabled_filters.includes(shaped.filter.name)
  const filter = useShaped ? shaped.filter : filterByName('generic')
  if (filter === null) return null
  // Only the shaped filter gets argv: the generic fallback is chosen precisely because no filter claimed this command, so handing it the first stage's tokens would invite it to read flags meant for something else.
  const filterArgv = useShaped ? shaped.argv : []
  // Output is the combined stdout/stderr stream the harness already merged, so pass it as stdout.
  const compressed = compressOutput(filter, output, '', exitCode ?? 0, filterArgv, {
    maxLines: cfg.max_lines,
    maxBytes: cfg.max_bytes,
  })
  const minNet = resolveMinNetSavingsBytes()
  // Cheap necessary pre-check: the recall pointer below only ever makes the rewrite bigger, so anything failing here can never clear the gate once the pointer is priced in either. Failing fast keeps a hopeless case from paying for a cache write.
  if (!compressed.worthApplying(minNet)) return null
  // The id is `bashOutputIdSync(cmd, output, cwd)`, exactly what the storeBashOutput call below returns for this same output, so the pointer's real byte cost is known before committing to the cache write -- and the pointer names this run's body rather than whatever the command last produced.
  const id = bashOutputIdSync(cmd, output, cwd)
  // `--full` is required for a truthful "full output" pointer: a bare `bash-output <id>` applies head/tail elision, so it would return a truncated view, not the complete original. The fence wraps the command's own bytes and nothing else: token-goat's marker and the recall pointer sit outside it. Fold them in and the model loses its one signal for where our voice ends and the command's output begins, and anyone who guesses the marker's wording gets to write text the model reads as ours. Every other rewrite hook already follows this rule -- fetch, websearch, MCP, and the Read splice sites -- and Bash was the one substitution site in the codebase that handed the model a replacement body with no fence at all. A filter that hit its cap appends a notice saying so, and that notice is ours, so it joins the marker outside the tag rather than riding inside with the command's bytes. Leaving it in was the one case where token-goat's voice really did sit inside its own fence, which is exactly the ambiguity the fence removes -- and the marker neutraliser escapes it, so the symptom was our own cap notice arriving mangled. Nothing positional is lost: the cap trims the tail, so the point it describes is where the body ends, which the closing tag already marks.
  const { body: untrusted, notices } = splitOwnTrailingNotices(compressed.text)
  const marker = compressed.withMarker(minNet).slice(compressed.text.length)
  const body =
    fenceUntrusted(untrusted, UNTRUSTED_TOOL_TAG) +
    notices +
    marker +
    '\n[token-goat] full output: bash-output ' + id + ' --full'
  // Unlike bash_runner's pipeline, this path appends a recall pointer on top of the filter's own marker, so `compressed.bytesSaved` (which prices in neither) is not what the model gains. Gate and record against the body actually emitted, matching the shared contract every other rewrite hook follows via isRewriteWorthwhile/emitRewrite.
  const emittedBytes = Buffer.byteLength(body, 'utf-8')
  if (
    !isRewriteWorthwhile({
      originalBytes: compressed.originalBytes,
      rewrittenBytes: emittedBytes,
      noticeBytes: 0,
      minNetSavingsBytes: minNet,
    })
  ) {
    return null
  }
  await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
  // emitRewrite prices the saving from the string it returns, which is this same `body`, converts it with the one savedTokensFromBytes every other saving uses, and books the placeholders the filter's own redaction pass left in that body. Nothing booked those before: the cache copy is redacted by bash_output_cache before disk_cache sees it, so disk_cache's count comes back zero and this path's redactions were protecting the model while reporting nothing. originalBytes is capped at the harness delivery cap (src/delivery_cap.ts): the model never receives more than that inline, so a larger counterfactual would book output it could not see. The kind names the filter that actually ran, not the one this path used to hardcode. A stat key fixed to `generic` while the filter varies makes every family selection invisible to the ledger and to any test asserting on it, which is the shape commit 6645b3f3 removed from the byte-crediting stats for the same reason.
  return emitRewrite(body, 'bash', { kind: `bash_compress:${filter.name}`, originalBytes: deliveredOutputBytes(compressed.originalBytes) })
}

/**
 * Last-resort, strictly lossless pass: drop terminal display escapes (SGR colour, cursor moves, OSC titles) from output that nothing else compressed. A model reads `\x1b[38;2;240;246;252m` as tokens and gets no information from it -- it is markup for a terminal, not content.
 *
 * Three things follow from "lossless" and separate this from every other rewrite on this path: nothing is withheld, so there is no recall pointer and no marker to price in (a marker would be pure cost -- there is nothing to recall); the saving is exactly the escape bytes removed; and it is deliberately NOT gated on exit code. The other paths skip a failing command so its diagnostics reach the model whole, but stripping display markup is what keeps a failing colourised build whole -- a red `FAIL` and a plain `FAIL` say the same thing to a reader that has no colours.
 *
 * Only single commands reach here in practice: a compound one is compressed by {@link maybeCompressCompoundOutput}, whose filter pipeline already strips escapes as its first stage. This closes the gap on the other side of that helper's `isCompressibleSingleCommand` early return, where the pre-hook wrapper only covers a whitelist of recognised command shapes and everything else -- including token-goat's own colourised output -- passed through untouched.
 */
function maybeStripAnsiOnly(output: string): HookOutput | null {
  if (!output.includes('\x1b')) return null
  // No explicit TOKEN_GOAT_BASH_COMPRESS check: config.ts folds that env var into `bash_compress.enabled`, so `!cfg.enabled` below already carries the kill switch. An extra check here read as a second guard while being unreachable -- mutation testing removed it and nothing went red, which is what an unreachable guard looks like.
  let cfg: { enabled: boolean; disabled_filters: string[] }
  try {
    cfg = loadConfig().bash_compress
  } catch {
    return null
  }
  if (!cfg.enabled || cfg.disabled_filters.includes('ansi')) return null
  const stripped = stripAnsiEscapes(output)
  const originalBytes = Buffer.byteLength(output, 'utf-8')
  // Deliberately not fenced, unlike the compressing path above. The fence marks where token-goat stops speaking and third-party bytes begin, and it earns that only where token-goat has something of its own in the block: the compressing path drops lines, vouches for what it kept, and splices a `[token-goat: ...]` marker in beside content it did not write. This path does none of that. It emits `stripped` alone -- no marker, no recall pointer, no summary -- so the model receives the same bytes the harness would have delivered anyway, minus escape sequences it cannot render. There is no token-goat voice here to delimit. Pricing a fence in here also costs the strip itself: the whole saving is the escape bytes, so the fence's ~123 outweighs it on ordinary build output, the gate returns null, and the raw output reaches the model unfenced regardless -- losing the strip and buying no safety.
  if (
    !isRewriteWorthwhile({
      originalBytes,
      rewrittenBytes: Buffer.byteLength(stripped, 'utf-8'),
      noticeBytes: 0,
      minNetSavingsBytes: resolveMinNetSavingsBytes(),
    })
  ) {
    return null
  }
  // 'counted-elsewhere': this pass redacts nothing, it only removes escape bytes. Any placeholder in `stripped` was already in the original and was booked by whoever put it there, so counting here would credit this path with a redaction it did not perform. Capped at the harness delivery cap for the same reason as the other Bash rewrite sites.
  return emitRewrite(stripped, 'ansi escapes stripped', { kind: 'bash_compress:ansi', originalBytes: deliveredOutputBytes(originalBytes) }, 'counted-elsewhere')
}

// A `curl` GET of an HTML page is the one Bash shape hooks_fetch.ts's WebFetch path already solves and this surface never reached: the harness's delivery cap (see delivery_cap.ts) truncates a Bash result long before article text past the `<head>`/inline CSS/`<script>` preamble arrives, so the model can pay the full cap and still receive zero article content. Modelled on maybeStripAnsiOnly above, but this pass is lossy (extractCleanText drops markup, not just display-only bytes) so, unlike that one, it appends a recall notice pointing at the raw cached copy and prices that notice's own bytes in the net-benefit gate.
function maybeFoldCurlHtml(cmd: string, output: string, id: string): HookOutput | null {
  if (!isCurlGetCommand(cmd) || !looksLikeHtml(output)) return null
  let cfg: { enabled: boolean; disabled_filters: string[] }
  try {
    cfg = loadConfig().bash_compress
  } catch {
    return null
  }
  if (!cfg.enabled || cfg.disabled_filters.includes('curl-html')) return null
  let cleaned: string
  try {
    cleaned = extractCleanText(output)
  } catch {
    return null
  }
  const originalBytes = Buffer.byteLength(output, 'utf-8')
  // `--full` is mandatory here: `bash-output <id>` alone returns only a head slice, so a notice omitting the flag would point the reader at a command that silently loses most of the raw markup.
  const notice = `[token-goat: curl HTML body cleaned via extractCleanText; use \`token-goat bash-output ${id} --full\` to recall the raw markup]\n`
  const noticeBytes = Buffer.byteLength(notice, 'utf-8')
  // Fenced like maybeCompressCompoundOutput above: the cleaned text is a fetched webpage's own words, third-party content by provenance the same way a WebFetch body is, so it gets the same untrusted-content fence and injection scan hooks_fetch.ts already applies to that surface. Clipped to the harness delivery cap rather than shipped whole, because unlike every other rewrite in this file this one can legitimately EXCEED that cap: extractCleanText shrinks a page enormously relative to its markup and still leaves more prose than the cap carries, measured at 29,252 bytes of cleaned text from a 197,504-byte Wikipedia article. Shipping past the cap costs nothing in bytes (the harness truncates either way) but loses the tail, and the tail is where the closing fence marker and the recall notice sit. Losing the notice is the expensive half: the harness persists the CLEANED text it was handed, so once this hook substitutes, the raw markup survives only in token-goat's own bash cache and that notice is its only route back. Overhead is measured off an actual fence call rather than assumed, since fenceUntrusted returns the text unchanged when injection fencing is switched off.
  const clipNote = '\n[token-goat: cleaned text clipped to the harness delivery cap; the notice at the top of this output recalls the full raw markup]'
  const fenceOverhead = Buffer.byteLength(fenceUntrusted(cleaned, UNTRUSTED_TOOL_TAG), 'utf-8') - Buffer.byteLength(cleaned, 'utf-8')
  // The cap rule itself lives in delivery_cap.ts and is shared with fenceRewriteWithinCap above, so the two Bash paths that can outrun the cap cannot drift apart on where they cut.
  const cut = clipToDeliveryCap(cleaned, noticeBytes + fenceOverhead + Buffer.byteLength(clipNote, 'utf-8'))
  const body = cut.text
  const clipped = cut.clipped ? clipNote : ''
  // The clip note stays OUTSIDE the fence: it is token-goat's own sentence, and the fence escapes `[token-goat:` markers found within it so that third-party bytes cannot forge one, which rendered this note as `&#91;token-goat: ...` when it was fenced along with the page text.
  const fenced = fenceUntrusted(body, UNTRUSTED_TOOL_TAG) + clipped
  if (
    !isRewriteWorthwhile({
      originalBytes,
      rewrittenBytes: Buffer.byteLength(fenced, 'utf-8'),
      noticeBytes,
      minNetSavingsBytes: resolveMinNetSavingsBytes(),
    })
  ) {
    return null
  }
  // Default 'count-here' redaction accounting, matching the other lossy-rewrite sites in this file (the generic compress and identical/contained-reread paths above): extractCleanText performs no redaction of its own, so this is the same posture as those sites rather than the ansi path's 'counted-elsewhere', which exists only because that path is a pure identity transform on bytes already accounted for elsewhere. Notice FIRST, not appended: it is the only pointer back to the raw markup, and a trailing one sits exactly where the harness truncates.
  return emitRewrite(notice + fenced, 'curl HTML body cleaned', { kind: 'bash_compress:curl-html', originalBytes: deliveredOutputBytes(originalBytes) })
}

/**
 * pre_tool_use handler for the Bash tool.
 *
 * Emits a recall hint when the command is a known build tool and its output was already captured this session. Passes through for all other commands.
 */
function preBashHandlerInner(event: HookEvent): HookOutput {
  const rawCmd = extractCommand(event)
  if (rawCmd === undefined) return passOutput()
  const cmd = stripCdPrefix(rawCmd)
  const cdStripped = cmd !== rawCmd
  // The bash event's cwd, used to resolve any relative file path the same way the CLI/shell itself would — hoisted here (rather than computed right before its first use) so every path-keyed dedup check below (sed line-ranges, CLI surgical reads) shares one resolution.
  const preHookCwd = getCwd(event) ?? null
  // When a cd prefix was stripped, path-based hints below resolve their filePath against the directory that cd would actually leave the shell in, not this hook's own cwd.
  const hintCwd = preHookCwd ?? process.cwd()
  // Every hint below that names a file returns through this instead of a bare contextOutput, so the efficacy ledger is handed the path the hint was built from rather than regex-scraping one back out of the rendered sentence (see extractPathCorrelator's doc comment for what that scrape actually recorded). Measurement only -- relay.ts drops the field before the harness sees the output, so the hint text is byte-identical either way. The `token-goat bash-output <id>` recall branches near the end deliberately do NOT use this: their correlator is a cache id, which classifyBashHint already reads straight out of the command it printed, not a path.
  const pathHint = (paths: string | readonly string[], text: string): HookOutput =>
    contextOutput(text, typeof paths === 'string' ? [paths] : paths)
  // A leading-lines read's substitute, priced, or null when it could not be priced or was not cheaper -- the same gate the sed/awk branch applies, reached through one expression because two branches need it identically.
  const pricedSubstitute = (hintPath: string, start: number, end: number): RangeSubstituteFigures | null => {
    const sub = rangeSubstituteFor(hintPath, hintCwd, [[start, end]])
    return sub !== null && meetsSavingsFloor(sub.requestedBytes - sub.replacementBytes) ? sub : null
  }
  // Falling silent because the substitute was not cheaper is a decision, and it has to leave a trace or it is invisible to every surface: the hook returns the same empty object it returns for a command it never recognized, so without this a gate that declines on every file in the project and a gate that never fires read identically. Zero-byte and never scored -- nothing was shown, so there is nothing to score -- but the correlator records which file kept losing the comparison, which is what tells a reader whether to widen the gate or retire the hint.
  const declineUnpriced = (paths: string | readonly string[]): HookOutput => {
    for (const p of typeof paths === 'string' ? [paths] : paths) logSuppressedDetection('bash_redirect', event.sessionId, p)
    return passOutput()
  }
  // The size half of the condition each of the five `token-goat bash-output <id>` recall branches below repeated, plus the decline record none of them kept: a candidate that clears the dedup minimum but fails the savings floor was refused on price, which is a decision and has to leave a trace for the same reason declineUnpriced does. Callers still test their own id and entry for null, both to keep TypeScript's narrowing inside the branch and because neither absence is this gate declining anything -- no cached output, or an entry too stale to offer, never reached a price comparison, and recording it would credit the gate with refusing work it never had. The correlator is the cache id, which is what classifyBashHint reads back out of a recall hint that did get shown, so the declined and shown rows key alike.
  const recallWorthShowing = (outputId: string, entry: { sizeBytes: number }): boolean => {
    if (entry.sizeBytes < loadConfig().hints.bash_dedup_min_bytes) return false
    if (meetsSavingsFloor(entry.sizeBytes)) return true
    logSuppressedDetection('bash_recall', event.sessionId, outputId)
    return false
  }

  // Check for unbalanced shell quoting or unterminated heredocs
  const cfg = loadConfig()
  if (cfg.hints.warn_unbalanced_shell_quoting) {
    const quoteError = detectUnbalancedShellSyntax(cmd)
    if (quoteError !== null) {
      recordStat('session_hint', 0, 0)
      return contextOutput(
        'This command has ' + quoteError + '. If you\'re writing a multi-line string with embedded quotes or special characters, consider using the Write tool instead — it avoids shell quoting issues entirely.',
      )
    }
  }

  // Item 3: task output file — already cached, recall with bash-output
  const taskOutput = extractTasksOutput(cmd)
  if (taskOutput !== null) {
    const { id, path: outPath, n } = taskOutput
    recordStat('session_hint', 0, 0)
    // Only deny a genuine JSONL transcript; a background command's stdout is meant to be read and falls through to normal handling.
    if (taskOutputIsJsonlTranscript(outPath)) {
      const tail = n ?? 50
      return denyOutput(
        'Task output ' + id + ' is a JSONL agent transcript on disk. Use `token-goat bash-output --file "' + outPath + '" --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail ' + tail + '`, or read a specific line range (the only way to reach the MIDDLE of a large artifact) with `token-goat read "' + outPath + '@START-END"`, instead of reading the whole file.',
      )
    }
  }

  // Item 3b: tool-results plain-text file — cached tool output, recall with bash-output
  const toolResults = extractToolResultsFile(cmd)
  if (toolResults !== null) {
    // extractToolResultsFile only validates the trailing `tool-results/<safe-id>.txt` suffix, so everything before it is arbitrary and repository-shaped; displaySafePath at derivation matches every other path this handler puts on the context channel.
    const outPath = displaySafePath(toolResults.path)
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Tool output ' + outPath + ' is a plain-text artifact. Use `token-goat bash-output --file "' + outPath + '"` to read it with surgical narrowing via `--grep PATTERN` or `--tail N`, instead of reading the whole file.',
    )
  }

  // find interception — fd is faster and .gitignore-aware; xargs grep -l is a symbol-search anti-pattern
  const findResult = extractFindCommand(cmd)
  if (findResult !== null) {
    const { extGlob, isXargsGrepL } = findResult
    recordStat('session_hint', 0, 0)
    if (isXargsGrepL) {
      return denyOutput(
        '`find | xargs grep -l` is a slow symbol search. ' +
        'Use `token-goat refs <symbol>` or `rg -l <symbol>` for faster symbol-file discovery.',
      )
    }
    const fdHint = extGlob
      ? 'Use `fd \'' + extGlob + '\'` for faster file discovery (respects .gitignore).'
      : 'Use `fd` for faster file discovery (respects .gitignore).'
    return contextOutput(
      '`find` is slow and ignores .gitignore. ' + fdHint +
      ' For symbol definitions, use `token-goat symbol <Name>`.',
    )
  }

  // Item 7: directory listing — token-goat map is cheaper
  if (extractDirectoryListing(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat map --compact` (~300 tokens) for a repo overview, or `token-goat map <dir>` for a subdirectory.',
    )
  }

  // for-loop wc -l size probe — suggest outline instead
  if (extractForLoopWcL(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat outline <file>` to see symbol names and line counts without loading files.',
    )
  }

  // Terminal XML parsing interception (Select-Xml, [xml], PowerShell XML inspect scripts, Python xml.etree, xmlstarlet)
  const terminalXml = extractTerminalXmlParsing(cmd)
  if (terminalXml !== null) {
    const { filePath, toolOrScript } = terminalXml
    recordStat('session_hint', 0, 0)
    const target = filePath ? displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath) : '<file>'
    return pathHint(filePath ? [target] : [],
      `token-goat available for this file type, consider 'token-goat xml-query "${target}" "<xpath>"' or 'token-goat xml-outline "${target}"' first instead of terminal XML parsing (${toolOrScript}).`,
    )
  }

  // Item 4b: sed line-range extraction — replaced with extractSedRange to provide specific line range A single-command read is preferred; failing that, the compound spellings (echo-separated multi-span reads, formatting-only pipes) are the same read class and get the same per-file treatment.
  const singleLineRangeRead = extractLineRangeRead(cmd)
  const sedReads = singleLineRangeRead !== null ? [singleLineRangeRead] : extractLineRangeReadsCompound(cmd)
  if (sedReads !== null) {
    const hints: string[] = []
    // One emission can cover several files here (the per-file hints are joined into one context output), so every file named gets into the correlator set rather than just the first -- see joinCorrelators in hint_stats.ts for why the set, not a primary path, is the right representation.
    const hintPaths: string[] = []
    for (const { filePath, ranges, tool } of sedReads) {
      // When a cd prefix was stripped, both the dedup key and the displayed hint path must resolve against the directory cd would actually leave the shell in, matching every other path-carrying hint block above/below — otherwise a cd-prefixed sed read resolves against this hook's own cwd instead of the shell's real one, both mislabeling the hint and missing dedup against a non-cd-prefixed reference to the same file.
      const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
      // Dedup on the resolved/normalized path (relative-to-absolute, cwd-anchored, drive-letter-cased) — a relative and an absolute reference to the same file must collide under one key, matching how the CLI surgical-read dedup above already resolves paths. Multi-range `sed -n 'A,Bp;C,Dp'` commands are checked and recorded per-range (not as one combined min-max span) so a gap between ranges that was already read separately doesn't get misreported as newly-overlapping, and so each range's own history is tracked.
      hintPaths.push(hintPath)
      const sedDedupKey = resolveIndexPath(hintPath, preHookCwd ?? process.cwd())
      const overlapHints: string[] = []
      const freshRanges: Array<readonly [number, number]> = []
      for (const [start, end] of ranges) {
        const priorOverlap = findRangeOverlap(getFileLineRanges(sedDedupKey), start, end)
        recordFileLineRange(sedDedupKey, start, end)
        if (priorOverlap !== null) {
          overlapHints.push(sedOverlapHint(hintPath, priorOverlap, start, end))
        } else {
          freshRanges.push([start, end])
        }
      }
      hints.push(...overlapHints)
      // Priced, not assumed: the hint is pushed only when the regions a surgical read would have to return are measurably cheaper than the lines the command asked for. See bash_range_savings.ts for the comparison and for what it measures over a real corpus.
      const sub = freshRanges.length > 0 ? rangeSubstituteFor(hintPath, hintCwd, freshRanges) : null
      if (sub !== null && meetsSavingsFloor(sub.requestedBytes - sub.replacementBytes)) {
        hints.push(sedRangeHint(hintPath, freshRanges, tool, sub))
      }
    }
    if (hints.length === 0) return declineUnpriced(hintPaths)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPaths, hints.join(' '))
  }

  // These two must run before extractCatFile: a `-Tail`/`Select-Object -First`-flagged Get-Content command is a single path with a flag VALUE in the argument list (e.g. `Get-Content -Tail 50 src/auth.ts`, where `50` reads as a bare positional token), and extractCatFile's own trailing-flag catch-all matches that same shape. Left in its original position below, extractCatFile denied a `-Tail 50` read outright as a whole-file dump -- "loads the entire file into context" -- when only 50 lines were ever going to be read, exactly the ordering hazard extractCatFilesMulti's own out.length >= 2 guard was written to avoid, and recordBashFileReadsForSessionCache already orders its own gcTail/tail/gcSelect/head checks ahead of extractCatFile for this identical reason.
  const gcTailResult = extractGetContentTail(cmd)
  if (gcTailResult !== null) {
    const { filePath, isDoc, isConfig, isSql, isXml } = gcTailResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, '`Get-Content -Tail` bypasses read hooks. ' + surgicalHintForConfigDoc(hintPath, isConfig, isDoc, isSql, isXml))
  }

  const gcSelectResult = extractGetContentSelectFirst(cmd)
  if (gcSelectResult !== null) {
    const { filePath, n } = gcSelectResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const gcSelectHint = leadingLinesHint('`Select-Object -First` bypasses read hooks. ', hintPath, 1, n, preHookCwd, pricedSubstitute(hintPath, 1, n))
    if (gcSelectHint === null) return declineUnpriced(hintPath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, gcSelectHint)
  }

  const gcHeadResult = extractGetContentHead(cmd)
  if (gcHeadResult !== null) {
    const { filePath, n } = gcHeadResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const gcHeadHint = leadingLinesHint('`Get-Content -TotalCount` bypasses read hooks. ', hintPath, 1, n, preHookCwd, pricedSubstitute(hintPath, 1, n))
    if (gcHeadHint === null) return declineUnpriced(hintPath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, gcHeadHint)
  }

  const catJsonPipe = extractCatJsonPipe(cmd)
  if (catJsonPipe !== null) {
    const { filePath, isDirectJq } = catJsonPipe
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    const label = isDirectJq ? '`jq`' : '`cat | jq`'
    return pathHint(hintPath,
      label + ' loads the whole file. Use `token-goat json-query "' + hintPath + '" "<key>"` or `token-goat config-get "' + hintPath + '" KEY_NAME` to slice one value.',
    )
  }

  const psJsonPipe = extractPowerShellJsonPipeline(cmd)
  if (psJsonPipe !== null) {
    recordStat('session_hint', 0, 0)
    if (psJsonPipe.filePath) {
      const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, psJsonPipe.filePath, hintCwd) : psJsonPipe.filePath)
      return pathHint(hintPath,
        'PowerShell `ConvertFrom-Json` pipeline detected. Use `token-goat json-query "' + hintPath + '" "<selector>"` to extract fields directly without shell conversion scripts.',
      )
    }
    return contextOutput(
      'PowerShell `ConvertFrom-Json` pipeline detected. Use `token-goat json-query <file> "<selector>"` or `token-goat web-output` to extract fields directly.',
    )
  }

  const catResult = extractCatFile(cmd)
  if (catResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml, cmd0, advisoryOnly } = catResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    if (isSql) {
      return pathHint(hintPath,
        '`' + cmd0 + '` loads the entire file into context. Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, runnableTargetFor(hintPath, hintCwd, event))
    // advisoryOnly: a `2>/dev/null`-suffixed read tolerates the file being absent, so it gets guidance rather than a deny (a deny would redirect the agent at a file that may not exist).
    return cdStripped || advisoryOnly ? pathHint(hintPath, '`' + cmd0 + '` loads the entire file into context. ' + hint) : denyOutput('`' + cmd0 + '` loads the entire file into context. ' + hint)
  }

  const catMulti = extractCatFilesMulti(cmd)
  if (catMulti !== null) {
    recordStat('session_hint', 0, 0)
    const cmd0 = catMulti[0]!.cmd0
    const perPath = catMulti.map(({ filePath, isDoc, isEnv, isConfig, isSql, isXml }) => {
      const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
      const how = isXml
        ? 'token-goat xml-outline "' + hintPath + '" or token-goat xml-query "' + hintPath + '" "<selector>"'
        : isSql
          ? 'token-goat section "' + hintPath + '::table_name"'
          : isEnv || isConfig
            ? 'token-goat config-get "' + hintPath + '" KEY_NAME'
            : isDoc
              ? 'token-goat section "' + hintPath + '::SectionHeading"'
              : 'token-goat read "' + hintPath + '::SymbolName"'
      return '  ' + hintPath + ' -> `' + how + '`'
    })
    const msg =
      '`' + cmd0 + '` on multiple files loads them all into context. Read each surgically instead:\n' + perPath.join('\n')
    return cdStripped ? pathHint(catMulti.map((m) => displaySafePath(resolveCdHintPath(rawCmd, m.filePath, hintCwd))), msg) : denyOutput(msg)
  }

  const psGetContentResult = extractPowerShellWrappedGetContent(cmd, event)
  if (psGetContentResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml } = psGetContentResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    const lead = '`Get-Content` via a `powershell -Command` wrapper bypasses read hooks and loads the entire file into context. '
    if (isSql) {
      // SQL reads are always advisory-only (never denied), matching extractCatFile/extractWslCatFile's deliberate SQL-never-deny design (see the "Item 4 (nestpilot mining)" regression test) -- a schema/migration file is routinely read in full for review, and `token-goat section "file::table_name"` only extracts one block at a time, so denying the whole-file read here (as the cd-unprefixed branch below does for every other file type) would block a legitimate workflow this hint category was never meant to gate that hard.
      return pathHint(hintPath, lead + 'Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.')
    }
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, runnableTargetFor(hintPath, hintCwd, event))
    return cdStripped ? pathHint(hintPath, lead + hint) : denyOutput(lead + hint)
  }

  const wslCatResult = extractWslCatFile(cmd)
  if (wslCatResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml } = wslCatResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    if (isSql) {
      return pathHint(hintPath,
        '`cat` loads the entire file into context. Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, runnableTargetFor(hintPath, hintCwd, event))
    return cdStripped ? pathHint(hintPath, '`cat` loads the entire file into context. ' + hint) : denyOutput('`cat` loads the entire file into context. ' + hint)
  }

  const pyRead = extractPythonFileRead(cmd)
  if (pyRead !== null) {
    const { filePath, isDoc, isConfig, isEnv, isSql, isXml, isOutputFile } = pyRead
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    if (isOutputFile) {
      // Same two kinds the cat/tail guard above tells apart, decided the same way. An agent transcript is JSONL worth hundreds of kilobytes and reading it whole is the mistake worth blocking; a background command's stdout is plain text the harness expects to be read, so that only gets advice about narrowing it, never a refusal.
      if (taskOutputIsJsonlTranscript(filePath)) {
        const tHint = 'This `.output` file is a JSONL agent transcript. Use `token-goat bash-output --file "' + hintPath + '" --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail N`, instead of hand-parsing the JSONL.'
        return cdStripped ? pathHint(hintPath, tHint) : denyOutput(tHint)
      }
      return pathHint(hintPath,
        'This `.output` file is a background command\'s stdout. Use `token-goat bash-output --file "' + hintPath + '"` to narrow it with `--grep PATTERN`, `--tail N` or `--head N`, instead of reading the whole file.',
      )
    }
    if (isSql) {
      return pathHint(hintPath,
        'Python `open()` file reads bypass read hooks. Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, runnableTargetFor(hintPath, hintCwd, event))
    return cdStripped ? pathHint(hintPath, 'Python `open()` file reads bypass read hooks. ' + hint) : denyOutput('Python `open()` file reads bypass read hooks. ' + hint)
  }

  const tailResult = extractTailFile(cmd)
  if (tailResult !== null) {
    const { filePath, isDoc, isConfig, isSql, isXml } = tailResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, '`tail` bypasses read hooks. ' + surgicalHintForConfigDoc(hintPath, isConfig, isDoc, isSql, isXml))
  }

  const headResult = extractHeadFile(cmd)
  if (headResult !== null) {
    const { filePath, n } = headResult
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const headHint = leadingLinesHint('`head` bypasses read hooks. ', hintPath, 1, n, preHookCwd, pricedSubstitute(hintPath, 1, n))
    if (headHint === null) return declineUnpriced(hintPath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath, headHint)
  }

  const nodeRead = extractNodeFileRead(cmd)
  if (nodeRead !== null) {
    const { filePath, isDoc, isConfig, isSql } = nodeRead
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const lead = 'Node.js `fs.readFileSync()` bypasses read hooks. '
    if (isSql) {
      // SQL reads are always advisory-only (never denied), matching extractCatFile/extractWslCatFile/extractPowerShellWrappedGetContent's deliberate SQL-never-deny design (see the "Item 4 (nestpilot mining)" regression test) -- a schema/migration file is routinely read in full for review, and `token-goat section "file::table_name"` only extracts one block at a time, so denying the whole-file read here (as this handler did for every other file type, unconditionally, before this fix) would block a legitimate workflow this hint category was never meant to gate that hard. This branch previously fell through to the same cdStripped ? contextOutput : denyOutput as every non-SQL case below, so a non-cd-prefixed `node -e "readFileSync('x.sql')"` was hard-denied while the equivalent `cat x.sql` was always advisory -- the exact SQL-hint-classifier divergence already fixed for cat/head/tail/Get-Content.
      recordStat('session_hint', 0, 0)
      return pathHint(hintPath, lead + 'Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.')
    }
    // Folded onto the shared ladder every other whole-file-dump branch already uses. It was an
    // inlined near-copy with the same placeholders, plus one this codebase warns against
    // everywhere else: `read "path::SymbolName"` claims a specific symbol that file may not have,
    // which is exactly the fabricated name genericSurgicalFallback's note in bash_extractors.ts
    // says to never print. extractNodeFileRead reports no isEnv/isXml, so both pass false, which
    // is what the inlined ladder assumed anyway.
    const hint = surgicalHintFor(hintPath, false, isConfig, isDoc, false, runnableTargetFor(hintPath, hintCwd, event))
    recordStat('session_hint', 0, 0)
    return cdStripped ? pathHint(hintPath, lead + hint) : denyOutput(lead + hint)
  }

  const psMethodRead = extractPowerShellFileMethodRead(cmd, event)
  if (psMethodRead !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql, isXml } = psMethodRead
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    const lead = 'PowerShell `[IO.File]::ReadAllText()` bypasses read hooks. '
    if (isSql) {
      recordStat('session_hint', 0, 0)
      return pathHint(hintPath, lead + 'Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.')
    }
    const hint = surgicalHintFor(hintPath, isEnv, isConfig, isDoc, isXml, runnableTargetFor(hintPath, hintCwd, event))
    recordStat('session_hint', 0, 0)
    return cdStripped ? pathHint(hintPath, lead + hint) : denyOutput(lead + hint)
  }

  // A plain-enumeration rg/grep structural search (whole-file symbols, headings, imports) has an exact index answer -- rewrite the command to it instead of just hinting, so the model gets the answer in this one tool result. Checked on rawCmd (not the cd-stripped cmd) ahead of the hint-only checks below: detectStructuralIndexRewrite's own detectFromCommand call rejects any `cd DIR &&` prefix as a compound command, which is the correct pass-through for that shape rather than something this call needs to special-case.
  const structuralRewrite = detectStructuralIndexRewrite(rawCmd, hintCwd)
  if (structuralRewrite !== null) {
    return { hookType: 'rewriteInput', updatedInput: { ...event.toolInput, command: structuralRewrite.command } }
  }

  if (extractGrepPipeChain(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass). ' +
      'For symbol discovery: `token-goat refs <symbol>` or `token-goat semantic`.',
    )
  }

  // Markdown heading grep: `grep -n "^#" SKILL.md` → outline hint (before structural search so .md heading patterns don't get misrouted to the symbol-search advice)
  const mdHeadingGrep = extractMarkdownHeadingGrep(cmd)
  if (mdHeadingGrep !== null) {
    const { filePath } = mdHeadingGrep
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath,
      'Use `token-goat outline "' + hintPath + '"` to get all headings with line ranges — ' +
      'then `token-goat section "' + hintPath + '::Heading"` to read one section.',
    )
  }

  // Bare identifier search on a single source file — symbol lookup is cheaper
  const rgSymbol = extractRgSymbolSearch(cmd)
  if (rgSymbol !== null) {
    const { identifier } = rgSymbol
    recordStat('session_hint', 0, 0)
    // The correlator here is the identifier, not a path: this hint names no file, and the exact token a follow-through would have to carry is the symbol name. Left to extractPathCorrelator it scraped nothing at all, so the row went in permanently uncreditable.
    return contextOutput(
      'Use `token-goat symbol ' + identifier + '` to jump directly to the definition without scanning the file.',
      [identifier],
    )
  }

  const rgStructural = extractRgStructuralSearch(cmd)
  if (rgStructural !== null) {
    const { filePath } = rgStructural
    const hintPath = displaySafePath(cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath)
    recordStat('session_hint', 0, 0)
    return pathHint(hintPath,
      'Searching for code definitions with `rg`/`grep` is slower than surgical reads. ' +
      'Use `token-goat skeleton "' + hintPath + '"` to see all symbols with line numbers, ' +
      'or `token-goat outline "' + hintPath + '"` for symbols with docstrings and line ranges.'
    )
  }

  // Monitoring commands: always suggest recall if cached, even on a single prior run.
  const monitoringHint = getMonitoringRecallHint(cmd)
  if (monitoringHint !== null) {
    const monCmdHash = shortFingerprint(stripOutputPipeline(cmd))
    const monOutputId = getBashOutputId(monCmdHash)
    // Only emit the recall hint if the content entry is actually present (the session index may name an id whose blob was pruned) and not stale — a matching id whose stored git/dir/lockfile fingerprint no longer matches the current state means the source changed since it was cached, so it must not be recalled as fresh.
    const monEntryRaw = monOutputId !== null ? getBashOutput(monOutputId) : null
    const monEntry = monEntryRaw !== null && !isBashEntryStale(monEntryRaw, cmd, preHookCwd) ? monEntryRaw : null
    if (monOutputId !== null && monEntry !== null && recallWorthShowing(monOutputId, monEntry)) {
      const monBytes = monEntry.sizeBytes
      const catFile = extractCatSourceFile(cmd)
      if (catFile !== null) {
        recordStat('bash_compress:recall', monBytes, savedTokensFromBytes(monBytes))
        return contextOutput(
          'Prior output from `' + cmd + '`' + pipelineDivergenceNote(cmd, monEntry.command) + ' is cached. ' +
          'Use `token-goat bash-output ' + monOutputId + '` to recall the full file, or ' +
          '`token-goat read \'' + catFile + '::SymbolName\'` to extract only the symbol you need.'
        )
      }
      const cmdSummary = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      recordStat('bash_compress:recall', monBytes, savedTokensFromBytes(monBytes))
      return contextOutput(
        'Prior output from `' + cmdSummary + '`' + pipelineDivergenceNote(cmd, monEntry.command) + ' is cached.\n' +
        'Use `token-goat bash-output ' + monOutputId + ' ' + monitoringHint + '` to re-inspect without re-running.'
      )
    }
  }

  // Item 2: curl -o download recall — keyed by URL so a re-download to a different temp path still gets a recall hint pointing to the previously saved file.
  const curlDl = extractCurlDownload(cmd)
  if (curlDl !== null) {
    const prevPath = getCurlDownloadPath(curlDl.url)
    const prevResolvedPath = prevPath !== null && commandPathIsTouchable(prevPath, event)
      ? resolveIndexPath(prevPath, preHookCwd ?? process.cwd())
      : null
    if (prevPath !== null && prevResolvedPath !== null && !existsSync(prevResolvedPath)) {
      // The previously downloaded file is gone (deleted/moved since). Forget the stale session record and let the re-download proceed instead of denying.
      clearCurlDownload(curlDl.url)
    } else if (prevPath !== null && prevResolvedPath !== null && statSync(prevResolvedPath).size >= loadConfig().hints.bash_dedup_min_bytes) {
      recordStat('session_hint', 0, 0)
      return denyOutput(
        'Already downloaded to ' + prevPath + ' earlier this session. ' +
        'Use `rg \'<pattern>\' ' + prevPath + '` to search it, or ' +
        '`token-goat read "' + prevPath + '::SectionName"` to read a part of it.',
      )
    }
  }

  // curl GET recall — emit a hint when the same URL was already fetched this session. Key on URL only (not the full command) so `curl <url> | jq …` and `curl <url> | python3 …` share the same cache entry.
  if (isCurlGetCommand(cmd)) {
    const curlCacheKey = extractCurlUrl(cmd) ?? cmd
    const curlHash = shortFingerprint(curlCacheKey)
    const curlOutputId = getBashOutputId(curlHash)
    // Guard on the content entry and its freshness, not just the index (see the monitoring case above).
    const curlEntryRaw = curlOutputId !== null ? getBashOutput(curlOutputId) : null
    const curlEntry = curlEntryRaw !== null && !isBashEntryStale(curlEntryRaw, cmd, preHookCwd) ? curlEntryRaw : null
    if (curlOutputId !== null && curlEntry !== null && recallWorthShowing(curlOutputId, curlEntry)) {
      const curlBytes = curlEntry.sizeBytes
      recordStat('bash_compress:recall', curlBytes, savedTokensFromBytes(curlBytes))
      const curlPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'curl response cached (`' + curlPreview + '`).' + pipelineDivergenceNote(cmd, curlEntry.command) + ' ' +
        'Use `token-goat bash-output ' + curlOutputId + '` to recall it. ' +
        'Append `--grep PATTERN` to filter or `--section HeadingName` for a markdown section.',
      )
    }
  }

  // gh api recall — emit a hint when the same read-only `gh api` GET was already run this session. Key on the command minus output pipes/redirects (endpoint + flags), matching the post-side cache key.
  if (isReadOnlyGhApi(cmd)) {
    const ghHash = shortFingerprint(stripOutputPipeline(cmd))
    const ghOutputId = getBashOutputId(ghHash)
    const ghEntryRaw = ghOutputId !== null ? getBashOutput(ghOutputId) : null
    const ghEntry = ghEntryRaw !== null && !isBashEntryStale(ghEntryRaw, cmd, preHookCwd) ? ghEntryRaw : null
    if (ghOutputId !== null && ghEntry !== null && recallWorthShowing(ghOutputId, ghEntry)) {
      const ghBytes = ghEntry.sizeBytes
      recordStat('bash_compress:recall', ghBytes, savedTokensFromBytes(ghBytes))
      const ghPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'gh api response cached (`' + ghPreview + '`).' + pipelineDivergenceNote(cmd, ghEntry.command) + ' ' +
        'Use `token-goat bash-output ' + ghOutputId + '` to recall it. ' +
        "Append `--jq '.field'` on the original call, or `--grep PATTERN` / `--max-matches N` here, to narrow it.",
      )
    }
  }

  // Scoped git status / git diff --stat recall — `git status --porcelain -- <path>` or `git diff --stat -- <path>` is byte-identical on every rerun until HEAD moves or the working tree changes. The `gitMutable` fingerprint already attached in computeBashFingerprints (HEAD sha + `git status --porcelain` hash) invalidates the instant either happens — including an edit to the scoped path recorded through the normal postEditHandler/dirty-queue flow, since that edit shows up in `git status --porcelain` regardless of whether the reindex queue has drained yet — so this reuses the same staleness check as monitoring/curl/gh-api recall above rather than a bespoke one.
  if (isScopedGitStatusOrDiffStatCommand(cmd)) {
    const gitScopedHash = shortFingerprint(stripOutputPipeline(cmd))
    const gitScopedOutputId = getBashOutputId(gitScopedHash)
    const gitScopedEntryRaw = gitScopedOutputId !== null ? getBashOutput(gitScopedOutputId) : null
    const gitScopedEntry = gitScopedEntryRaw !== null && !isBashEntryStale(gitScopedEntryRaw, cmd, preHookCwd) ? gitScopedEntryRaw : null
    if (gitScopedOutputId !== null && gitScopedEntry !== null && recallWorthShowing(gitScopedOutputId, gitScopedEntry)) {
      const gitScopedBytes = gitScopedEntry.sizeBytes
      recordStat('bash_compress:recall', gitScopedBytes, savedTokensFromBytes(gitScopedBytes))
      const gitScopedPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'Output from `' + gitScopedPreview + '`' + pipelineDivergenceNote(cmd, gitScopedEntry.command) + ' is cached and unchanged (no edits to that path or HEAD since). ' +
        'Use `token-goat bash-output ' + gitScopedOutputId + '` to recall it instead of re-running.',
      )
    }
  }

  // CLI surgical-read dedup: warn on an exact repeat `token-goat symbol|read|section` invocation, and cross-check against the Read-tool ledger (a file already fully Read this session may already cover the same content).
  const tgRead = extractTgSurgicalRead(cmd, preHookCwd)
  if (tgRead !== null) {
    const cliKey = tgRead.sub + '::' + tgRead.spec
    const notes = []
    if (wasCliReadThisSession(cliKey)) {
      notes.push('You already ran this exact `token-goat ' + tgRead.sub + '` query earlier this session — check your context above before re-running it.')
    }
    if (tgRead.filePath !== null && wasFileReadThisSession(tgRead.filePath)) {
      notes.push('`' + tgRead.filePath + '` was already fully read via the Read tool this session — that content may already cover this.')
    }
    if (notes.length > 0) {
      recordStat('session_hint', 0, 0)
      return pathHint(tgRead.filePath !== null ? [tgRead.filePath] : [], notes.join(' '))
    }
    return passOutput()
  }

  if (isTestRunnerCommand(cmd) && isDirectTestRunnerCommand(cmd) && !hasTestRunScopeOrBudget(cmd)) {
    // The compressor supplies a timeout itself. Preserve that stronger existing safeguard instead of replacing its rewrite with an advisory that would leave the test unbounded.
    const compression = maybeCompressRewrite(event, rawCmd, cmd)
    if (compression !== null) return compression

    const key = `test-run-budget:${event.sessionId}:${shortFingerprint(cmd)}`
    if (!wasHintShown(key)) {
      markHintShown(key)
      recordStat('session_hint', 0, 0)
      return contextOutput(
        'This test command has no targeted selector or explicit timeout. Prefer a focused test path/name or the runner’s supported timeout before starting a potentially unbounded suite; run the full suite deliberately when it is needed.',
      )
    }
  }

  // Recognized command: recall a cached prior run, else compress this run. detectFromCommand matches a specific filter (none until the filters land); isBuildCommand is the generic-filter gate for build/test tools. isBuildCommand's patterns are prefix-anchored so a trailing `2>&1` never breaks them, but detectFromCommand rejects any redirect outright (hasRedirect) — so a command recognized only via detectFromCommand (e.g. `npm test`, resolved through its package-manager-script dispatch, not a BUILD_COMMAND_PATTERNS entry) needs the same trailing-`2>&1` allowance maybeCompressRewrite applies below, or it never reaches that function at all.
  if (!isBuildCommand(cmd) && detectFromCommand(stripTrailingStderrRedirect(cmd), preHookCwd ?? undefined) === null) return passOutput()

  // Derive the same command hash used by the session store.
  const cmdHash = shortFingerprint(stripOutputPipeline(cmd))
  const outputId = getBashOutputId(cmdHash)
  // A cached prior run wins: recall it instead of re-running (and re-compressing). Guard on the content blob and its freshness — a pruned id would make `bash-output <id>` error, and a stale fingerprint means the source changed since the output was cached.
  const entryRaw = outputId !== null ? getBashOutput(outputId) : null
  const entry = entryRaw !== null && !isBashEntryStale(entryRaw, cmd, preHookCwd) ? entryRaw : null
  if (outputId !== null && entry !== null && recallWorthShowing(outputId, entry)) {
    const bytes = entry.sizeBytes
    recordStat('bash_compress:recall', bytes, savedTokensFromBytes(bytes))
    return contextOutput(buildRecallHint(cmd, outputId))
  }

  // First run of a recognized command → transparently wrap it in the compressor so its output is structurally compressed before it reaches the model.
  return maybeCompressRewrite(event, rawCmd, cmd) ?? passOutput()
}

/** Public wrapper: intercepts every `context` (hint) output from {@link preBashHandlerInner} for efficacy tracking/suppression — see hint_stats.ts's module doc comment for the category list and honesty design. */
export function preBashHandler(event: HookEvent): HookOutput {
  return applyHintTracking(event, preBashHandlerInner(event), classifyBashHint)
}

registerHook('pre_tool_use', preBashHandler, { toolName: 'Bash' })

/** Read the full text a Bash tool_response points at via `persistedOutputPath`, when Claude Code already wrote the complete output to disk because it exceeded the harness's 20,000-char inline head -- `tool_response.stdout` in that case is only the head, so compressing or caching from it alone silently drops the rest of a larger real result. Confined to this session's own `<claude home>/projects/<slug>/<session id>/tool-results/` directory (resolved through symlinks via isInsideRoot, so a link escaping that directory cannot be followed), bounded to MAX_CAPTURE_BYTES, and sanity-checked against `persistedOutputSize`. Any failure returns null so the caller falls back to the head. */
export function readPersistedBashOutput(resp: Record<string, unknown>, cwd: string | null, sessionId: string): string | null {
  const persistedPath = resp['persistedOutputPath']
  if (typeof persistedPath !== 'string' || persistedPath === '' || sessionId === '') return null
  const root = path.join(projectTranscriptsDir(cwd ?? process.cwd()), sessionId, 'tool-results')
  if (!isInsideRoot(persistedPath, root)) return null
  try {
    const stat = statSync(persistedPath)
    if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) return null
    const persistedSize = resp['persistedOutputSize']
    // A few bytes of slack for a trailing newline the reported size may or may not count -- this is a sanity check against a mismatched or stale path, not an exact accounting.
    if (typeof persistedSize === 'number' && Math.abs(stat.size - persistedSize) > 8) return null
    return readFileSync(persistedPath, 'utf-8')
  } catch {
    return null
  }
}

/** Extract the tool response text from a post_tool_use event. Claude Code may send a string or an object with an output/content field. Prefers the on-disk persisted output over the payload's own (possibly head-truncated) field when one is present and confined to this session's tool-results directory. */
function extractBashOutput(event: HookEvent): string {
  const raw = event.raw
  const resp = raw['tool_response']
  if (resp !== null && typeof resp === 'object') {
    const persisted = readPersistedBashOutput(resp as Record<string, unknown>, getCwd(event) ?? null, event.sessionId)
    if (persisted !== null) return persisted
  }
  return extractToolResponseField(raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
}

/**
 * Best-effort exit code from a Bash tool_response (absent on many harnesses).
 *
 * On Claude Code this is always null, and deliberately so. Measured over 186,335 recorded Bash results: not one carried `exit_code`, `exitCode`, `returncode` or `code`. The only status-shaped field the harness ever sends is `returnCodeInterpretation` (2,133 results), and its every observed value is a BENIGN non-zero exit -- "No matches found", "Files differ", "Some directories were inaccessible" -- never a genuine failure, and it never co-occurred with non-empty stderr. Treating it as "exit != 0" would fire the failing-test-runner advisory on a clean grep that matched nothing, so it is not consulted. Non-empty stderr is no better: plenty of green runs write to it. Every caller but the test-runner advisory reads null as success, so the rest of the handler is unaffected; that one advisory stays dormant on this harness until a real exit status is on the wire, which is the correct trade against a false "your test run failed" nudge on a passing run.
 */
function extractExitCode(raw: Record<string, unknown>): number | null {
  const resp = raw['tool_response']
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>
    for (const key of ['exit_code', 'exitCode', 'returncode', 'code']) {
      if (typeof r[key] === 'number') return r[key] as number
    }
  }
  return null
}

// `gh api` endpoints that require an elevated token scope the default lacks.
const GH_SECURITY_PATHS = ['/security_advisories', '/advisories', 'security_events'] as const
// Phrases GitHub returns when the token lacks the scope/permission for a call. `You are not authorized to perform this operation` is what a real 403 on the dependabot/security endpoints says, captured from a live `gh api repos/nodejs/node/dependabot/alerts`; it was missing here, and the blanket non-zero-exit branch below used to paper over the gap.
const GH_SCOPE_PHRASES = [
  'Must have push access',
  'Resource not accessible by integration',
  'Must be an admin',
  'You are not authorized to perform this operation',
] as const
// gh prints `gh: <message> (HTTP <code>)` on its own line for every failing call, and the response body carries a `status` field; either form identifies a 404 without depending on the exit code alone. Both are anchored rather than matched as bare substrings, so a successful listing whose body merely quotes `(HTTP 404)` in advisory prose cannot be read as a failure.
const GH_NOT_FOUND = /^gh: .*\(HTTP 404\)|"status":\s*"404"/m

/**
 * Advisory hints for `gh api` commands: a scope/permission nudge when the call hits a permission wall, and a token-savings nudge when the JSON response is wide enough that a `--jq` projection would meaningfully shrink it. Returns the joined hint text, or null when nothing applies.
 *
 * The scope hint is accumulated before the response is parsed, so a non-JSON or malformed body still surfaces it — unlike the original Python, where a `json.loads` failure discarded an already-detected scope hint. Never throws.
 */
function buildGhApiHint(cmd: string, stdout: string, exitCode: number | null): string | null {
  if (stdout === '' || !cmd.startsWith('gh api')) return null
  const hints: string[] = []
  const isSecurityPath = GH_SECURITY_PATHS.some((p) => cmd.includes(p))
  const hasScopePhrase = GH_SCOPE_PHRASES.some((p) => stdout.includes(p))
  // Note the asymmetry: extractExitCode is always null on Claude Code (see its comment), so the 404 branch below is dormant there and the phrase list is the whole of this hint on that harness -- which is why a missing phrase cost real coverage rather than being masked. A 404 on a security path is genuinely ambiguous: GitHub answers it identically for a repo that does not exist and for one whose advisories the token cannot see (captured: an owned repo with advisories off and a nonexistent owner/repo returned byte-identical bodies). So say so, rather than asserting a scope problem. Requiring the 404 itself matters -- a non-zero exit alone also covers gh's own `invalid API endpoint` error, a rate limit and a network failure, none of which a token refresh fixes.
  const ambiguousSecurity404 = exitCode !== null && exitCode !== 0 && isSecurityPath && GH_NOT_FOUND.test(stdout)
  if (hasScopePhrase) {
    hints.push('[token-goat] GitHub API scope issue: try gh auth refresh -s security_events')
  } else if (ambiguousSecurity404) {
    hints.push(
      '[token-goat] GitHub answers 404 both for a resource that does not exist and for one your token cannot see: check the owner/repo spelling, then gh auth status for the security_events scope.',
    )
  }
  // Large-response nudge: only a JSON object can carry the 15+ boilerplate fields this targets, so skip the parse entirely unless the body looks like one (avoids parsing huge non-JSON logs).
  const trimmed = stdout.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(stdout)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keyCount = Object.keys(parsed as Record<string, unknown>).length
        if (keyCount >= 15) {
          hints.push(`[token-goat] Large API response (${keyCount} keys). Filter with --jq '.key1,.key2' to reduce tokens.`)
        }
      }
    } catch {
      // Malformed JSON: keep any scope hint already accumulated, skip the large-response nudge.
    }
  }
  return hints.length > 0 ? hints.join(' ') : null
}

// Classify a successful read-shaped Bash command by reusing the same extractors preBashHandler uses for its deny/hint logic, then feed the file path(s) into the session read-cache: recordFileRead for a provable whole-file dump, recordFileLineRange for a dump whose shown lines are known exactly (head/Select-Object -First always cover 1..n), and markFileTruncated for a dump whose shown lines are NOT known relative to the file (tail-style — the absolute start line depends on total file length, which isn't known here) so a later Read gets redirected to a surgical tool instead of being falsely told the whole file was already seen. Ordering matters for correctness, not just readability: extractCatFile's trailing `-flag ...` catch-all also matches `Get-Content foo.ts -Tail 20` (same cmd0 alternation), so the narrower Get-Content extractors must run first or a partial Get-Content read would get recorded as a full one. extractPowerShellWrappedGetContent is deliberately skipped here: its return value doesn't expose whether the trailing flag (if any) was -Raw (whole file) or -Tail/-First (partial), so classifying it either way would be a guess — skipping loses a caching opportunity but can't introduce a false full-read record.
function recordBashFileReadsForSessionCache(cmd: string, cwd: string | null): void {
  const resolve = (p: string) => resolveIndexPath(p, cwd ?? process.cwd())

  const gcTail = extractGetContentTail(cmd)
  if (gcTail !== null) {
    markFileTruncated(resolve(gcTail.filePath))
    return
  }
  const tail = extractTailFile(cmd)
  if (tail !== null) {
    markFileTruncated(resolve(tail.filePath))
    return
  }
  const gcSelect = extractGetContentSelectFirst(cmd)
  if (gcSelect !== null) {
    recordFileLineRange(resolve(gcSelect.filePath), 1, gcSelect.n)
    return
  }
  const gcHead = extractGetContentHead(cmd)
  if (gcHead !== null) {
    recordFileLineRange(resolve(gcHead.filePath), 1, gcHead.n)
    return
  }
  const head = extractHeadFile(cmd)
  if (head !== null) {
    recordFileLineRange(resolve(head.filePath), 1, head.n)
    return
  }
  const cat = extractCatFile(cmd)
  if (cat !== null) {
    recordFileRead(resolve(cat.filePath))
    return
  }
  const catMulti = extractCatFilesMulti(cmd)
  if (catMulti !== null) {
    for (const r of catMulti) recordFileRead(resolve(r.filePath))
    return
  }
  const wslCat = extractWslCatFile(cmd)
  if (wslCat !== null) {
    recordFileRead(resolve(wslCat.filePath))
    return
  }
  const nodeRead = extractNodeFileRead(cmd)
  if (nodeRead !== null) {
    recordFileRead(resolve(nodeRead.filePath))
    return
  }
  const psMethod = extractPowerShellFileMethodRead(cmd)
  if (psMethod !== null) {
    recordFileRead(resolve(psMethod.filePath))
    return
  }
  const pyRead = extractPythonFileRead(cmd)
  if (pyRead !== null && !pyRead.isOutputFile) {
    recordFileRead(resolve(pyRead.filePath))
    return
  }
}

/**
 * post_tool_use handler for the Bash tool.
 *
 * Caches the output of monitoring and build commands so that `preBashHandler` can emit a recall hint the next time the same command is run, avoiding a redundant re-execution and the token cost of re-reading the output.
 */
async function maybeEmitLargeUncompressedHint(
  cmd: string,
  output: string,
  exitCode: number | null,
  cwd: string | null,
  isUnwrapped: boolean,
  event: HookEvent,
  ansiResult: HookOutput | null,
): Promise<HookOutput | null> {
  const outputBytes = Buffer.byteLength(output, 'utf-8')
  if (
    outputBytes < 4096 ||
    process.env['TOKEN_GOAT_BASH_COMPRESS'] === '0' ||
    (exitCode !== null && exitCode !== 0) ||
    // token-goat's own output is already the narrow form; telling the model to compress it is noise.
    /^\s*token-goat\s/.test(cmd) ||
    (event.raw['_tg_harness'] !== 'vscode' && (isCompressibleSingleCommand(cmd) || !isUnwrapped))
  ) {
    return null
  }
  const key = `bash-uncompressed-4k:${event.sessionId ?? ''}:${shortFingerprint(cmd)}`
  if (wasHintShown(key)) return null
  markHintShown(key)
  recordStat('session_hint', 0, 0)
  const id = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
  const kb = Math.round(outputBytes / 1024)
  // The recall pointer leads and each suggestion sits in its own backticks: the suggestion scrubber cuts from an unsafe suggestion to the last backtick on the line, so a compress suggestion ahead of it took the pointer down with it. A command holding a quote, backtick, `$` or line break cannot be wrapped in the double quotes below at all, so it gets no compress suggestion.
  const compressable = !/["`$\r\n]/.test(cmd)
  const msg = `[tg] Output was ${kb}KB uncompressed; \`token-goat bash-output ${id}\` recalls it` + (compressable ? `, and \`token-goat compress -c "${displaySafeText(cmd)}"\` compresses the next run.` : '.')
  if (ansiResult !== null && ansiResult.hookType === 'rewriteOutput') {
    // The ansi strip already emitted through emitRewrite and booked its own saving there, so this re-emit carries the same text and books no saving of its own -- the hint is the session_hint stat recorded above, and double-booking those bytes would inflate every total that sums them. Routing through emitRewrite rather than constructing the object here is also what applies the vscode guard: that harness has no field which replaces a tool result, so a hand-built rewrite was silently dropped while still reading as an emit. maybeStripAnsiOnly may ship those bytes unfenced because it adds nothing of ours to them, but this block does add a marker, so the command output is fenced here and the marker stays outside it: otherwise the model cannot tell which of the two voices in the block is token-goat's, and output that forged the marker wording would read as ours. The marker leads rather than trails because it carries the only pointer back to the full output, and the harness truncates from the end.
    return emitRewrite(msg + '\n' + fenceUntrusted(ansiResult.updatedOutput, UNTRUSTED_TOOL_TAG), 'large uncompressed output hint', undefined, 'counted-elsewhere')
  }
  return contextOutput(msg)
}

export async function postBashHandler(event: HookEvent): Promise<HookOutput> {
  try {
    const rawCmdRaw = extractCommand(event)
    if (rawCmdRaw === undefined) return passOutput()
    // If the pre-hook rewrote this into a `token-goat compress` wrapper, recover the original command so the cache keys on it (matching the pre-hook hash).
    const isUnwrapped = unwrapCompressCommand(rawCmdRaw) === null
    const rawCmd = unwrapCompressCommand(rawCmdRaw) ?? rawCmdRaw
    const cmd = stripCdPrefix(rawCmd)
    const output = extractBashOutput(event)
    const exitCode = extractExitCode(event.raw)
    const cwd = getCwd(event) ?? null
    // Matches MIN_CACHE_BYTES's old hardcoded value as the config default, so an untouched install sees identical behavior; a configured cache_min_bytes now actually moves the floor instead of being silently ignored.
    const cacheMinBytes = loadConfig().bash_compress.cache_min_bytes

    // Git-mutation staleness enqueue: checkout/switch/pull/merge/rebase/reset/cherry-pick move HEAD and rewrite working-tree file content without ever going through Claude Code's Edit tool, so those files never enter queue/dirty.txt via the normal postEditHandler path -- every surgical-read command (symbol/refs/semantic/dead/map) would otherwise silently keep serving whatever was indexed before the mutation until each file happens to be individually read. `HEAD@{1}` is git's own reflog record of "where HEAD was immediately before this command moved it" -- correct for single-step operations, but a multi-commit rebase or `pull --rebase` creates several intermediate reflog entries, so `HEAD@{1}` can only capture the last replayed step. `ORIG_HEAD` is the more robust base for the subcommands that set it (see ORIG_HEAD_ELIGIBLE_GIT_RE above) since it survives that internal churn; `HEAD@{1}` remains the fallback for checkout/switch/reset/cherry-pick (which never set it, or for which it's excluded) and for the rare case ORIG_HEAD hasn't been set yet at all.
    if (isHeadMovingGitCommand(cmd) && (exitCode === null || exitCode === 0)) {
      const gitDir = cwd ?? process.cwd()
      let diffBase = 'HEAD@{1}'
      if (ORIG_HEAD_ELIGIBLE_GIT_RE.test(cmd)) {
        const reflogTop = runGit(['reflog', '-1', '--format=%gs', 'HEAD'], { cwd: gitDir, timeoutMs: 5000 })
        if (reflogTop.exitCode === 0 && ORIG_HEAD_REFLOG_MSG_RE.test(reflogTop.stdout.trim())) {
          const origHead = runGit(['rev-parse', '--verify', '-q', 'ORIG_HEAD'], { cwd: gitDir, timeoutMs: 5000 })
          if (origHead.exitCode === 0 && origHead.stdout.trim() !== '') diffBase = 'ORIG_HEAD'
        }
      }
      const mutationDiff = runGit(['diff', '--name-only', diffBase, 'HEAD'], { cwd: gitDir, timeoutMs: 5000 })
      if (mutationDiff.exitCode === 0) {
        // `git diff --name-only` always reports paths relative to the repo top-level, regardless of which directory git was invoked from -- resolving them against the raw event cwd (a monorepo subpackage, or a `cd sub && git checkout ...`) would compute the wrong absolute path and silently enqueue nothing useful. Resolve the real top-level first.
        const repoRoot = gitRepoRoot(gitDir)
        for (const rel of mutationDiff.stdout.split('\n')) {
          const trimmed = rel.trim()
          if (trimmed.length === 0) continue
          enqueueDirtyPathSafe(resolveIndexPath(trimmed, repoRoot), { alreadyResolved: true })
        }
      }
    }

    // Working-tree rewrites that never move HEAD, so the block above cannot see them: `git restore`, `git stash pop|apply`, and the plain shell in-place writes (`sed -i`, `>`/`>>`, `tee`, `git apply`, `patch`, `prettier --write`, `eslint --fix`). Same staleness failure class, one gap over -- none of these go through the Edit tool either, so before this nothing enqueued them and every surgical read kept serving pre-mutation content. See enqueueNonHeadMovingRewrites.
    if (exitCode === null || exitCode === 0) {
      enqueueNonHeadMovingRewrites(cmd, rawCmd, cwd ?? process.cwd())
    }

    // Item 2: record curl -o downloads by URL for cross-command dedup — only after confirming the download actually succeeded. Recording it unconditionally (before checking exit code or that the file landed on disk) meant a FAILED curl (network error, 404, ...) still got recorded as if it succeeded, and the recall-deny above would then block the user from ever retrying the same download.
    const curlDl = extractCurlDownload(cmd)
    if (curlDl !== null && (exitCode === null || exitCode === 0)) {
      const resolvedOutputPath = resolveIndexPath(curlDl.outputPath, cwd ?? process.cwd())
      if (existsSync(resolvedOutputPath)) {
        recordCurlDownload(curlDl.url, resolvedOutputPath)
      }
    }

    // Feed the pre-hook's own file-path extractors into the session read-cache so a file dumped through Bash (cat/head/Get-Content) is no longer invisible to a later Read's dedup hint. Whole-file dumps record a full read; partial dumps (head/tail/-Tail/-First) record only what was actually shown, so a later Read is never falsely told the whole file was already seen.
    if (exitCode === null || exitCode === 0) recordBashFileReadsForSessionCache(cmd, cwd)

    // `gh api` advisory hints: scope/permission nudge and large-JSON --jq nudge. These commands are not cached (not build/monitoring/curl-GET), so emit the hint and return here.

    // Record a successful `token-goat symbol|read|section` invocation so a later identical call gets the re-read dedup hint from the pre-hook.
    const tgRead = extractTgSurgicalRead(cmd, cwd)
    if (tgRead !== null && (exitCode === null || exitCode === 0)) {
      recordCliRead(tgRead.sub + '::' + tgRead.spec)
      // Record a surgical (symbol/section/range-scoped) read against the file's session entry so compact.ts's symbolsBonus can reward narrowly-engaged files. `spec` for read/section is `filePath` + a narrowing suffix (`::symbol`, `::heading`, and/or `@line-range`); an empty suffix means a whole-file `token-goat read <file>`, which is not symbol-scoped and is left out. `symbol`/`skill-*` subcommands carry no filePath and are skipped.
      if (tgRead.filePath !== null) {
        const narrowing = tgRead.spec.slice(tgRead.filePath.length)
        if (narrowing.length > 0) recordSymbolRead(tgRead.filePath, narrowing.replace(/^::/, ''))
      }
      if (tgRead.filePath !== null && loadConfig().hints.log_large_file_hint_outcomes) {
        const pendingSize = takePendingLargeFileHint(tgRead.filePath)
        if (pendingSize !== null) {
          recordStat('large_file_hint_followed', 0, 0, undefined, `${tgRead.filePath} (${pendingSize} bytes) — hint fired, then followed by a surgical token-goat read`)
        }
      }
    }

    // Cache a successful, read-only `gh api` GET so a later identical call recalls it instead of re-fetching. Done as a side effect before the advisory-hint return below, so a wide-JSON response is both nudged toward --jq and cached. Gated on exit 0 (and the shared size floor) so an error/permission body is never stored as content.
    if (isReadOnlyGhApi(cmd) && (exitCode === null || exitCode === 0) && Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
      const ghCacheHash = shortFingerprint(stripOutputPipeline(cmd))
      const ghCacheId = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
      recordBashOutput(ghCacheHash, ghCacheId, Buffer.byteLength(output, 'utf-8'))
    }

    const ghHint = buildGhApiHint(cmd, output, exitCode)
    if (ghHint !== null) {
      recordStat('session_hint', 0, 0)
      return contextOutput(ghHint)
    }

    // One-time field-batching advisory: on the first successful read-only `gh pr view`/`gh issue view` this session, nudge toward a single batched `--json a,b,c` instead of querying field-by-field across many calls. Cache the output inline first (as the monitoring path would) so a later identical view still recalls, then return the advisory.
    const ghView = extractGhViewForBatchAdvisory(cmd)
    if (ghView !== null && (exitCode === null || exitCode === 0) && !wasHintShown(GH_VIEW_BATCH_HINT_KEY)) {
      markHintShown(GH_VIEW_BATCH_HINT_KEY)
      if (Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
        const ghViewId = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
        recordBashOutput(shortFingerprint(stripOutputPipeline(cmd)), ghViewId, Buffer.byteLength(output, 'utf-8'))
      }
      recordStat('session_hint', 0, 0)
      return contextOutput(buildGhViewBatchAdvisory(ghView.sub, ghView.ref))
    }

    // Failing test-runner advisory: nudge toward `token-goat failures` instead of the caller scrolling the raw dump. Covers pytest/jest/vitest/go test/cargo test plus the npm/yarn/pnpm script wrappers, including bare `npm test`, which the build/monitoring cache patterns above deliberately exclude as too generic to cache on every green run -- so those commands never get a cached id from the blocks below, and this is the only place that stores one for them. Cache the output here (even for the runners the later blocks would otherwise cache) so the returned id is always real, then return before falling into the later cache logic to avoid a duplicate store under the same key. Gated on a genuine non-zero exit (never on exitCode === null, unlike the git-mutation and gh-api paths above, since an unknown exit code here would silently repeat this hint on every ambiguous run) and on the shared cache_min_bytes floor, same as the other advisory caches in this handler.
    if (isTestRunnerCommand(cmd) && exitCode !== null && exitCode !== 0 && Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
      const testFailHash = shortFingerprint(stripOutputPipeline(cmd))
      const testFailId = await storeBashOutput(cmd, output, exitCode, cwd)
      recordBashOutput(testFailHash, testFailId, Buffer.byteLength(output, 'utf-8'))
      recordStat('session_hint', 0, 0)
      return contextOutput(`[token-goat] Tests failed. Run \`token-goat bash-output ${testFailId} | token-goat failures\` to see just the failing blocks instead of the full output.`)
    }

    // Cache a successful scoped `git status`/`git diff --stat -- <path>` so a later identical call recalls it instead of re-running (see isScopedGitStatusOrDiffStatCommand above). Gated on exit 0 and the shared size floor, same as the gh-api cache above; staleness is enforced entirely by the `gitMutable` fingerprint recorded via computeBashFingerprints (HEAD sha + `git status --porcelain` hash), not a separate mechanism.
    if (isScopedGitStatusOrDiffStatCommand(cmd) && (exitCode === null || exitCode === 0) && Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
      const gitScopedCacheHash = shortFingerprint(stripOutputPipeline(cmd))
      const gitScopedCacheId = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
      recordBashOutput(gitScopedCacheHash, gitScopedCacheId, Buffer.byteLength(output, 'utf-8'))
    }

    // In environments without pre-hook wrapping (VS Code run_in_terminal, unwrapped shells), an eligible single command (e.g. `git diff`) that ran directly is compressed here on post-hook.
    if (isUnwrapped && /^git(?:\s+-[^\s]+|\s+--[^\s]+)*\s+diff\b/i.test(cmd)) {
      const unwrappedCompressed = await maybeCompressCompoundOutput(cmd, output, exitCode, cwd, cacheMinBytes, isUnwrapped)
      if (unwrappedCompressed !== null) return unwrappedCompressed
    }

    // Only cache monitoring, build, and curl GET commands — not generic shell commands.
    const isMonitoring = getMonitoringRecallHint(cmd) !== null
    // A whole-file dump goes to the file-read branch even when a monitoring pattern also names it, and one does: MONITORING_COMMAND_PATTERNS carries `cat <file>.(ts|py|go|...)`, so every `cat` of a SOURCE file was classified as a monitored command and routed past this branch entirely, while the same `cat` of a document -- which no monitoring pattern names -- fell into it and folded normally. That left the whole first-read fold below unreachable for exactly the files it was written for. The branch still caches the output under the same key the monitoring path would (shortFingerprint(stripOutputPipeline(cmd)), see maybeCollapseIdenticalRead), so recall by id is unaffected; what a source-file read gives up is the cross-run delta summary, in exchange for the stronger identical/contained collapse the same branch already applies to every other file read. The diversion is gated on pureFileReadPath alone. An additional whole-file SHAPE test was tried here on the theory that pureFileReadPath would also admit `tail -f app.log`, the live-log shape monitoring exists to summarise; measured against 15 fold controls and 6 monitoring shapes it changed no outcome, so it was dropped rather than kept as an unfalsifiable second opinion. Re-deciding the path's identity at this site is how a repo ends up with two parsers disagreeing: that check stays inside isWholeFileDump, where the fold weighs it against the on-disk size.
    const isFileRead = pureFileReadPath(cmd) !== null
    if (isFileRead || (!isMonitoring && !isBuildCommand(cmd) && !isCurlGetCommand(cmd))) {
      // A plain file read reaches here and, before this branch existed, left with nothing: no cache entry, no dedup, no compression, and only a pre-hook advisory the backoff ledger suppresses. Re-reading the same unchanged file therefore cost its full body every time. Collapse the byte-identical repeat first, since it is strictly cheaper than compressing a body the model has already been given verbatim.
      const identical = await maybeCollapseIdenticalRead(cmd, rawCmd, output, exitCode, cwd, cacheMinBytes)
      if (identical !== null) return identical
      // Before giving up, a compound/piped/redirect command (which the pre-hook could not wrap for compression) or an unwrapped single command gets its already-captured output compressed here. File reads are excluded: they are served or collapsed via file-reading semantics, not generic compression. Single commands are compressed via pre-hook wrapping (or unwrapped git diff earlier); compound/piped/redirect commands are compressed here.
      if (!isFileRead && (!isUnwrapped || !isCompressibleSingleCommand(cmd))) {
        const compound = await maybeCompressCompoundOutput(cmd, output, exitCode, cwd, cacheMinBytes, isUnwrapped)
        if (compound !== null) return compound
      }
      // A file read stays out of the generic list entirely, including the two-or-more-file compound shape `pureFileReadPath` itself declines to name (a single `filePath` has nowhere to put a second file): it already has its own per-file served store above, and letting a `sed`/`awk` range read's content leak into the session-wide list here is how a second, unrelated file that happens to share text with the first gets a stretch of itself withheld on the strength of a read of a DIFFERENT file -- exactly what the per-file scoping above exists to prevent.
      if (!isFileRead && extractLineRangeReadsCompound(cmd) === null) {
        const genericElision = await maybeElideServedGenericOutput(cmd, output, exitCode, cwd, cacheMinBytes)
        if (genericElision !== null) return genericElision
      }
      // Nothing compressed this output. Escape bytes can still go, losslessly, whatever the shape.
      const ansiStripped = maybeStripAnsiOnly(output)
      const largeHint = await maybeEmitLargeUncompressedHint(cmd, output, exitCode, cwd, isUnwrapped, event, ansiStripped)
      if (largeHint !== null) return largeHint
      return ansiStripped ?? passOutput()
    }

    if (Buffer.byteLength(output, 'utf-8') < cacheMinBytes) return passOutput()

    // For curl GET commands, key the cache on the URL so that the same endpoint fetched with different downstream pipes (| jq vs | python3) shares a single cache entry.
    const cacheKey = isCurlGetCommand(cmd) ? (extractCurlUrl(cmd) ?? cmd) : stripOutputPipeline(cmd)
    const simpleHash = shortFingerprint(cacheKey)
    // Item F: cross-run delta folding. Capture whatever was cached under this exact command's id BEFORE storeBashOutput overwrites it — the id is stable per normalized command (commandHash), so a hit here means this exact command already ran and cached output earlier. storeBashOutput always still runs unconditionally below: the full new output stays cached and recallable via `bash-output <id>` regardless of whether a delta hint fires: the delta is an additive summary, never a replacement for the underlying data.
    const priorId = await commandHash(cmd, cwd)
    const priorEntry = getBashOutput(priorId)
    const id = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
    recordBashOutput(simpleHash, id, Buffer.byteLength(output, 'utf-8'))
    if (priorEntry !== null) {
      // Item G: a store call just overwrote an already-present cached entry under this exact key -- record it so hooks_compact.ts's SAFE_TO_DISCARD manifest section can name the now-superseded prior run as provably safe to drop from context.
      recordBashRerun(simpleHash)
      const delta = summarizeOutputDelta(priorEntry.output, output)
      if (delta !== null) {
        recordStat('session_hint', 0, 0)
        return contextOutput(delta + ' — full output: bash-output ' + id + ' --full')
      }
    }
    // A curl of an HTML page is folded before the ansi-only pass, since the ansi pass alone cannot help a page that carries no escape codes at all.
    const curlHtmlFold = maybeFoldCurlHtml(cmd, output, id)
    if (curlHtmlFold !== null) return curlHtmlFold
    // Deliberately after the delta hint, which keeps its existing priority: a hook returns one channel, and the delta is only reachable on a rerun whose output actually changed. Every other cached command -- including the colourised build runs `isBuildCommand` routes here -- reaches this line, so this is where most escape bytes are removed.
    const ansiOnly = maybeStripAnsiOnly(output)
    const largeHint = await maybeEmitLargeUncompressedHint(cmd, output, exitCode, cwd, isUnwrapped, event, ansiOnly)
    if (largeHint !== null) return largeHint
    if (ansiOnly !== null) return ansiOnly
  } catch {
    // Never block — hook failures must be silent.
  }
  return passOutput()
}

registerHook('post_tool_use', postBashHandler, { toolName: 'Bash' })
