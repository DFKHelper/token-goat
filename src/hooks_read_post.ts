/** post_tool_use hook for the Read tool. On each completed Read it flags a truncated delivery so the next Read of that file is denied with a surgical hint, snapshots doc files for diff-on-reread, records cross-session evidence and this session's read manifest, and nudges toward skeleton/outline once a source file is long enough. It also rewrites the delivery itself when that pays, choosing at most one rewrite: withholding lines the session already holds, or folding a large untargeted read to its outline, its skeleton, or its code bodies. The pre_tool_use half lives in hooks_read.ts; this module takes six small path and recording helpers from it, and nothing there imports this module. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { emitRewrite, emitRewriteWithContext, extractToolResponseField, getCwd, getFilePath, OUTPUT_FIRST_TOOL_RESPONSE_KEYS, passOutput } from './hooks_common.js'
import { type HookEvent, registerHook, sessionStateKey } from './hook_registry.js'
import { applyHintTracking, classifyReadHint, logSuppressedDetection, meetsSavingsFloor } from './hint_stats.js'
import { displaySafePath, hostPathOfIndexKey, normalizePath, toDisplayPath } from './paths.js'
import { indexServedBody, planServedElisions, type ServedBody, servedRunNotice } from './served_lines.js'
import { IDENTICAL_READ_MIN_BODY_BYTES, statSize } from './util.js'
import { loadConfig } from './config.js'
import { exportSessionState, getFileServedOutputs, markFileTruncated, recordFileServedOutput, resetFileLineRanges } from './session.js'
import { getBashOutput, storeBashOutputSync } from './bash_output_cache.js'
import { writeSessionManifest } from './compact.js'
import { store as snapshotStore } from './snapshots.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'
import { hasPreciseSecret } from './secret_redact.js'
import { countTextLines, harnessNumbersReadContent, isTruncatedReadDelivery, type NumberedRow, numberedRenderBytes, parseReadDelivery, readRequestedSliceWindow, readStartLine, readWindowFromDisk, SLICE_ESTIMATE_SCAN_CAP_BYTES } from './hooks_read_slice.js'
import type { HookOutput } from './types.js'
import { type ReadShape, recordReadShape } from './read_shape.js'
import { fenceNumberedFileContent, fenceUntrustedFileContent } from './injection_scan.js'
import { recordStat } from './stats.js'
import { findProject, makeProjectAt } from './project.js'
import { isImagePath } from './image_shrink.js'
import { readEvidenceFileText, recordEvidence } from './evidence_cache.js'
import { foldDetail } from './code_fold.js'
import { ALIGNED_LAYOUT_NOTE, type FoldLayout, foldDelivery, foldingEnabled, pushWithheld } from './fold_delivery.js'
import { isStructuralRewriteAccepted, planMarkdownOutline, planSourceSkeleton, type StructuralFold } from './fold_structure.js'
import { isDiffableSource, isSessionArtifactFile, isSourceExtension, quietContextOutput, recordActualSlice, relPathWithinRoot } from './hooks_read.js'

/** Extract tool response text from a post_tool_use Read event. */
function extractReadOutput(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
}

/** The layout every rewrite of this Read has to use. `aligned` wherever the harness numbers the result by position (Claude Code's Read envelope): there a withheld run must keep its lines and nothing may lead the body, or every line after the change is shown under the wrong number -- measured on a 176-line file with six folded bodies, real line 150 came back displayed as 57, and six independent review runs cited the displayed number. */
function readLayout(event: HookEvent): FoldLayout {
  return harnessNumbersReadContent(event) ? 'aligned' : 'compact'
}

/** The invariant `aligned` layout exists for, checked on the finished text rather than trusted to each planner: one line out for every line in. A rewrite that fails it is declined whole, because a Read delivered as it arrived is merely longer, while a misnumbered one silently points every later citation at the wrong line. */
function keepsLineNumbers(original: string, rewritten: string): boolean {
  return original.split('\n').length === rewritten.split('\n').length
}

/** post_tool_use handler for the Read tool. Detects truncation markers in the tool response and flags the file so the next pre_tool_use for the same file returns an immediate deny with a surgical-read hint instead of allowing another full (and expensive) read. */
function postReadHandlerInner(event: HookEvent, suppressStructuralHint: boolean): HookOutput {
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  const normalized = normalizePath(filePath)
  const shown = displaySafePath(normalized)
  const respText = extractReadOutput(event.raw)
  if (isTruncatedReadDelivery(event, respText)) {
    markFileTruncated(normalized, !readRequestedSliceWindow(event).isExplicitSlice)
  }

  // Snapshot doc file content so the next re-read can inject a diff instead of the full file.
  const postBasename = path.basename(normalized)
  const diffSourcesEnabled = loadConfig().hints.serve_diff_on_reread
  if (/\.(md|mdx|markdown|rst|txt)$/i.test(postBasename) || isSessionArtifactFile(normalized) || (diffSourcesEnabled && isDiffableSource(postBasename))) {
    try {
      const onDisk = hostPathOfIndexKey(normalized)
      const sz = statSize(onDisk)
      if (sz !== null && sz <= 256 * 1024) {
        const content = fs.readFileSync(onDisk)
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
      const source = readEvidenceFileText(normalized)
      if (source !== null) recordEvidence({ projectRoot: project.root, source: normalized, representation: 'file', text: source })
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

      // Name the manifest after the ledger it is a copy of. The blob being written is exportSessionState(), which relay.ts persists under sessionStateKey(event), so any other key here files one agent's reads under another's name. getSessionId() was two keys wrong at once: it is memoized per process, and the bridges in src/bridges/ serve more than one session from one cached process, so a second session's reads overwrote the first session's manifest and the first session's reads stopped being discoverable; and it ignores agentId, so every subagent under one parent overwrote the same file with only its own reads. sanitizeIdForFilename in writeSessionManifest makes the `:` separators path-safe.
      writeSessionManifest(project.hash, sessionStateKey(event), { files: mappedFiles })
    } catch {
      // Fail-soft: ignore any errors in manifest writing
    }
  }

  // Post-read structural-navigation hint: once a just-read source file crosses post_read_code_compress.min_lines, nudge toward token-goat skeleton/outline instead of a future full re-read. Only fires for extensions with a tree-sitter language adapter (the sourceHints column of src/language_specs.ts), where skeleton/outline actually produce structure.
  if (isSourceExtension(postBasename)) {
    try {
      const onDisk = hostPathOfIndexKey(normalized)
      const sz = statSize(onDisk)
      if (sz !== null && sz <= SLICE_ESTIMATE_SCAN_CAP_BYTES) {
        const lineCount = countTextLines(fs.readFileSync(onDisk, 'utf8'))
        const minLines = loadConfig().post_read_code_compress.min_lines
        if (lineCount >= minLines && !suppressStructuralHint) {
          if (!meetsSavingsFloor(sz)) {
            // Split out of the single condition this used to be so that only the floor's own refusals are recorded: a file under min_lines had no hint to compose, and a suppressed one was already replaced upstream by a better rewrite, and booking either as a decline would credit this gate with refusing work it never had.
            logSuppressedDetection('read_structural_nav', event.sessionId, normalized)
          } else {
            // Advisory only -- the read is not blocked, so nothing was saved here either.
            recordStat('session_hint', 0, 0)
            return quietContextOutput(
              shown + ' is ' + lineCount + ' lines. Use `token-goat skeleton "' + shown + '"` or `token-goat outline "' + shown + '"` for structural navigation instead of a future full re-read.',
            )
          }
        }
      }
    } catch {
      // best-effort; never block the hook
    }
  }

  return passOutput()
}

/** Record what a completed Read handed the model, as raw file lines, so the shell-side re-read collapse in hooks_bash_post.ts can recognise a later `sed -n 'A,Bp'` or `cat` of the same lines as bytes the model is already holding. That collapse decides containment on BYTES rather than on line numbers, deliberately: an edit token-goat never observed moves the lines while leaving a recorded range looking valid, so a number-keyed store would happily withhold text the model does not have. It therefore needs the served text itself -- and until now only Bash ever produced any. A file first delivered through the Read tool was invisible to it, which is why its contained-re-read branch booked nothing at all while a third of bounded shell reads asked for lines already delivered. Three constraints follow from "the model is already holding these bytes", and each is a skip: - Store only the slice actually delivered. A Read carrying offset/limit handed over that window and nothing else, so storing the whole file would let the collapse withhold lines that were never shown. - Skip a truncated Read entirely. It delivered less than its own window and there is no way from here to know where it stopped. - Store raw file lines, not the Read tool's rendered output. The rendered form carries line-number prefixes, and the later shell read emits neither; whole-line containment is compared against what `sed`/`cat` will actually print. Best-effort throughout: the Read has already completed and nothing here may change its result. Synchronous on purpose: a hook is its own short-lived process, so a write left pending on the microtask queue is a write that may never reach disk. */
function recordReadAsServedOutput(event: HookEvent, deliveredRaw: string | null = null): void {
  try {
    const cfg = loadConfig().bash_compress
    // Nothing consumes the store when compression is off, so storing would be pure disk cost.
    if (!cfg.enabled) return
    const filePath = getFilePath(event)
    if (filePath === undefined) return
    const normalized = normalizePath(filePath)
    if (isImagePath(normalized)) return
    // Deliberately re-read from THIS response rather than asking the session whether the file has ever been truncated: that flag is sticky for the rest of the session, so one truncated Read would disqualify every later complete Read of the same file, which does deliver its window.
    const respText = extractReadOutput(event.raw)
    if (isTruncatedReadDelivery(event, respText)) return
    // A fold's delivery is not its whole window, and postReadHandler has already taken that window's range back (forgetFoldedWindow), so recording it here would put it straight back.
    if (deliveredRaw === null) recordActualSlice(event, normalized)
    // What the model was actually handed, which is the disk window ONLY when nothing rewrote it. A body fold delivers strictly less than the file holds, and storing the disk copy would tell every later read that the folded lines were served -- so a re-read coming back for exactly those lines would have them elided as "already seen". The store's whole contract is a record of what reached the model, and a rewrite is the one case where that differs from disk.
    const served = deliveredRaw ?? readWindowFromDisk(event, normalized)
    if (served === null) return

    // A stored body can only ever contain a later read that is itself at or above the collapse's own floor, so anything smaller is dead weight in the cache.
    if (Buffer.byteLength(served, 'utf-8') < Math.max(cfg.cache_min_bytes, IDENTICAL_READ_MIN_BODY_BYTES)) return

    // The synthetic command must carry the requested window, mirroring what the Bash surface gets for free from its literal command line (e.g. `sed -n '120,160p'`); commandHashSync keys only on this string plus cwd, so without the window every offset/limit of one file in one cwd collapses onto the same id and each later Read silently overwrites the previous window's stored body.
    const window = readRequestedSliceWindow(event)
    let syntheticCommand = 'Read ' + normalized
    if (window.isExplicitSlice) {
      syntheticCommand += ' --offset ' + window.offset
      if (window.limit !== undefined) syntheticCommand += ' --limit ' + window.limit
    }
    const id = storeBashOutputSync(syntheticCommand, served, 0, getCwd(event) ?? process.cwd())
    recordFileServedOutput(normalized, id)
  } catch {
    // best-effort; never affect the completed Read
  }
}

/** Replace stretches of a completed Read that the session has already been handed, keeping every line it has not. `alreadyServedOutputId` withholds a read whose window is entirely inside an earlier delivery. The partial case is the larger one and it cannot be denied: measured over a month of real sessions, 589 Read calls carried a mix of new and already-served lines against 400 fully-served ones, and denying any of the 589 would have deleted the new lines along with the old. Rewriting the result keeps the new lines and turns the rest into a pointer at the copy the model holds. Line numbers survive untouched -- an elided run becomes a notice naming the exact range it stood for, and every kept row is emitted verbatim, padding included, so the rewrite is purely subtractive. Nothing downstream has to re-derive a position from a shortened body, and no part of the saving comes from quietly reformatting rows that were not withheld. Skipped, each toward showing the model more rather than less: - anything a precise secret pattern matches (`hasPreciseSecret`, not the recall-tuned catch-all, which false-fires on ordinary source and would forfeit the rewrite without protecting anything). On a pass-through the harness's own text reaches the model, so a file carrying a credential keeps behaving exactly as it does today instead of coming back redacted because it happened to overlap an earlier read. - a truncated read, which delivered less than its own window with no way from here to know where it stopped. - a rewrite that does not clear the shared net-savings floor. */
function elideAlreadyServedLines(event: HookEvent, respText: string): HookOutput | null {
  if (!loadConfig().hints.elide_served_lines) return null
  const filePath = getFilePath(event)
  if (filePath === undefined) return null
  const normalized = normalizePath(filePath)
  if (isImagePath(normalized)) return null
  if (isTruncatedReadDelivery(event, respText)) return null

  const ids = getFileServedOutputs(normalized)
  if (ids.length === 0) return null
  const parsed = parseReadDelivery(event, respText)
  if (parsed === null) return null

  // Composing a rewrite makes this handler the author of what the model reads, and every sibling that composes redacts first. Here the honest move is to decline instead: redacting would hand back less of the user's own file than a plain Read does today. Asked of the precise patterns only, never the recall-tuned catch-all: because declining passes the file through unredacted, a false positive here protects nothing and costs the whole rewrite -- the opposite of the asymmetry redactSecrets itself is tuned for.
  if (hasPreciseSecret(respText)) return null

  const bodies: ServedBody[] = []
  // Newest first: the most recent delivery is the one most likely still in context.
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (id === undefined) continue
    const prior = getBashOutput(id)
    if (prior !== null) bodies.push(indexServedBody(id, prior.output))
  }
  if (bodies.length === 0) return null

  const cuts = planServedElisions(parsed.rows, bodies)
  if (cuts.length === 0) return null

  const layout = readLayout(event)
  const bodyRows: string[] = []
  let at = 0
  for (const cut of cuts) {
    for (let i = at; i < cut.start; i++) bodyRows.push(parsed.rows[i]?.raw ?? '')
    const first = parsed.rows[cut.start]
    const last = parsed.rows[cut.start + cut.len - 1]
    if (first === undefined || last === undefined) return null
    pushWithheld(bodyRows, servedRunNotice(first.no, last.no, cut.id, cut.len), cut.len, layout)
    at = cut.start + cut.len
  }
  for (let i = at; i < parsed.rows.length; i++) bodyRows.push(parsed.rows[i]?.raw ?? '')

  // fenceNumberedFileContent's `body` is the marker-neutralised text alone (no fence lines added, unlike fenceUntrustedFileContent), so it is safe to use here regardless of layout: a hostile file line spelling out this exact notice ("[token-goat] lines 1-500 were already served -- bash-output x") is escaped in place, at no line-count cost, header and trailer (the harness's own framing, never file content) left outside it. Aligned layout additionally can't let the fence's own preamble lead the body -- the same reason every other aligned producer (planMarkdownOutline, planSourceSkeleton, foldCodeBodies) moves it into the PostToolUse context instead of printing it inline.
  const fenced = fenceNumberedFileContent(bodyRows.join('\n'), ALIGNED_LAYOUT_NOTE)
  const rewritten = [...parsed.header, fenced.body, ...parsed.trailer].join('\n')
  if (layout === 'aligned' && !keepsLineNumbers(respText, rewritten)) return null
  const originalBytes = Buffer.byteLength(respText, 'utf-8')

  if (layout === 'aligned') {
    if (
      !isRewriteWorthwhile({
        originalBytes,
        rewrittenBytes: Buffer.byteLength(rewritten, 'utf-8') + Buffer.byteLength(fenced.preamble, 'utf-8'),
        noticeBytes: 0,
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
    ) {
      return null
    }
    return emitRewriteWithContext(rewritten, fenced.preamble, 'read', { kind: 'read:served_elide', originalBytes })
  }

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

/** Replace the inside of long function bodies with a pointer, keeping everything else verbatim. This is the only mechanism on the Read path aimed at a FIRST read. Everything beside it -- served-run elision, identical-read collapse, the heading-tree re-read deny -- keys on prior sight, and 83.6% of hooked Read bytes have none. It uses the rewrite channel rather than a deny on purpose. A deny that carries a compact still blocks the call: the agent pays a round trip, may re-acquire the file anyway, and the measured analogue abandons its task 42.7% of the time and runs edit errors at 4x baseline. A rewrite changes only what the same successful call delivers, so none of those costs apply. Returns the rewrite together with the raw text it actually delivered, because the served-output store must record what the model saw and not what is on disk -- see {@link recordReadAsServedOutput}. Where the harness numbers the result (`aligned` layout) the fence cannot lead the body, since its two lines put real line 1 at displayed line 3: the file bytes get the fence's neutralisation in place, and its preamble travels beside the result with the note on how the withheld runs are laid out. */
/** The gates only a Read can answer, applied ahead of either structural planner below. Untargeted only: a reader who asked for a specific window gets that window, not a map of the file it came from. Never a truncated delivery, or the rewrite would withhold lines the model was never handed in the first place. And never a body a precise secret pattern matches: composing a rewrite makes this handler the author of what the model reads, and a file holding a secret would be handed back redacted, so declining is the honest move and the same call {@link foldCodeBodies} makes. Returns the delivered rows together with the harness text around them, which is the one thing a shell read has no equivalent of and the reason this split falls where it does. */
function structuralFoldInputs(event: HookEvent, respText: string): { rows: readonly NumberedRow[]; header: string[]; trailer: string[]; normalized: string; shown: string; originalBytes: number; respText: string; layout: FoldLayout; startLine: number } | null {
  const filePath = getFilePath(event)
  if (filePath === undefined) return null
  if (readRequestedSliceWindow(event).isExplicitSlice) return null
  if (isTruncatedReadDelivery(event, respText)) return null
  if (hasPreciseSecret(respText)) return null
  const parsed = parseReadDelivery(event, respText)
  if (parsed === null) return null
  const normalized = normalizePath(filePath)
  // Repo-relative, because the notices repeat this path and an absolute Windows path is most of one. toDisplayPath returns the target unchanged when there is no project root or the file sits outside it, so an out-of-tree read still gets a path the reader can act on.
  const shown = displaySafePath(toDisplayPath(findProject(getCwd(event) ?? process.cwd())?.root, normalized))
  return { rows: parsed.rows, header: parsed.header, trailer: parsed.trailer, normalized, shown, originalBytes: Buffer.byteLength(respText, 'utf-8'), respText, layout: readLayout(event), startLine: readStartLine(event) }
}

/** Assemble a planned structural fold back into a Read delivery, or decline it on the shared acceptance gate. The recorded `deliveredRaw` is the plan's own `raw` field and nothing else, the same contract {@link foldCodeBodies} relies on: a line the plan withheld, trimmed at the lead-in cap, or rendered into a heading tree rather than delivered verbatim must never be recorded as served, or a later read of the file would elide a line the reader was never shown. A fold carrying `context` is an `aligned` one: it keeps every line, so the harness's number prefixes are no longer a cost the rewrite sheds, and the gate prices both sides as rendered, with the context counted as part of what the rewrite delivers. */
function emitStructuralFold(inputs: { header: string[]; trailer: string[]; originalBytes: number; respText: string; startLine: number }, fold: StructuralFold): { output: HookOutput; deliveredRaw: string } | null {
  const rewritten = [...inputs.header, ...fold.numbered, ...inputs.trailer].join('\n')
  if (fold.context !== undefined) {
    if (!keepsLineNumbers(inputs.respText, rewritten)) return null
    const renderedOriginal = numberedRenderBytes(inputs.respText, inputs.startLine)
    const renderedRewrite = numberedRenderBytes(rewritten, inputs.startLine) + Buffer.byteLength(fold.context, 'utf-8')
    if (!isStructuralRewriteAccepted(renderedOriginal, renderedRewrite, fold.ratioCap)) return null
    return {
      output: emitRewriteWithContext(rewritten, fold.context, 'read', { kind: fold.kind, originalBytes: inputs.originalBytes, detail: fold.detail }),
      deliveredRaw: fold.raw.join('\n'),
    }
  }
  if (!isStructuralRewriteAccepted(inputs.originalBytes, Buffer.byteLength(rewritten, 'utf-8'), fold.ratioCap)) return null
  return {
    output: emitRewrite(rewritten, 'read', { kind: fold.kind, originalBytes: inputs.originalBytes, detail: fold.detail }),
    deliveredRaw: fold.raw.join('\n'),
  }
}

/** Replace a large, untargeted markdown Read with its heading tree plus the document's lead-in, so a reader who wanted the whole document's prose still gets pointed at each section by name instead of losing it outright. The planning lives in fold_structure.ts, shared with the shell-read surface: `cat CLAUDE.arch.md` delivers the same bytes as `Read CLAUDE.arch.md` and now gets the same tree, rather than one surface folding and the other not. */
function foldMarkdownOutline(event: HookEvent, respText: string): { output: HookOutput; deliveredRaw: string } | null {
  const inputs = structuralFoldInputs(event, respText)
  if (inputs === null) return null
  const fold = planMarkdownOutline(inputs.rows, inputs.normalized, inputs.shown, inputs.originalBytes, inputs.layout)
  return fold === null ? null : emitStructuralFold(inputs, fold)
}

/** Replace a large, untargeted source Read with its structural skeleton, so a reader who asked for a whole file still gets every declaration by name plus the command that returns any one body verbatim. The source-code sibling of {@link foldMarkdownOutline} above, sharing its gates and, through fold_structure.ts, its planner with the shell-read surface. */
function foldSourceSkeleton(event: HookEvent, respText: string): { output: HookOutput; deliveredRaw: string } | null {
  const inputs = structuralFoldInputs(event, respText)
  if (inputs === null) return null
  const fold = planSourceSkeleton(inputs.rows, inputs.normalized, inputs.shown, inputs.originalBytes, inputs.layout)
  return fold === null ? null : emitStructuralFold(inputs, fold)
}

function foldCodeBodies(event: HookEvent, respText: string): { output: HookOutput; deliveredRaw: string } | null {
  if (!foldingEnabled()) return null
  const filePath = getFilePath(event)
  if (filePath === undefined) return null
  const normalized = normalizePath(filePath)
  if (isImagePath(normalized)) return null

  // A windowed read is foldable, but only when its delivered rows carry the file's own line numbers. `planBodyFolds` decides whether a window is narrow enough to leave alone: it declines any span whose declaration sits above the first delivered line, so a caller asking for the middle of one function still gets every line back, while a window wide enough to hold whole declarations folds them. That containment test compares row numbers against indexed spans, so it is meaningless against numbers synthesised from line 1, and the harness reports the true window start in `tool_response.file.startLine`. An offset it does not confirm is declined rather than guessed at: measured over 566 real ranged Reads, 562 agree exactly, and the four that disagree are negative offsets the harness clamps to line 1, which this equality rejects. A bare `limit` needs no check, its window starting at line 1 either way.
  const sliceWin = readRequestedSliceWindow(event)
  const requestedOffset = sliceWin.offset
  if (requestedOffset !== undefined && readStartLine(event) !== requestedOffset) return null
  if (isTruncatedReadDelivery(event, respText)) return null

  // Composing a rewrite makes this handler the author of what the model reads, and a file holding a secret would be handed back redacted. Declining is the honest move: a plain Read gives the user more of their own file than a redacted rewrite would. Same call as elideAlreadyServedLines, including its reason for asking only the precise patterns.
  if (hasPreciseSecret(respText)) return null

  const parsed = parseReadDelivery(event, respText)
  if (parsed === null) return null

  // Repo-relative, because the notice repeats this path once per fold and an absolute Windows path is most of the notice: measured over 201 session transcripts, the absolute form costs 10.9 KB of notice against 9.0 KB relative. toDisplayPath returns the target unchanged when there is no project root or the file sits outside it, so an out-of-tree read still gets a path the reader can act on, and either way the notice stays a command that can be run as printed.
  const shown = displaySafePath(toDisplayPath(findProject(getCwd(event) ?? process.cwd())?.root, normalized))
  const layout = readLayout(event)
  const folded = foldDelivery(parsed.rows, normalized, shown, sliceWin.isExplicitSlice, layout)
  if (folded === null) return null
  const originalBytes = Buffer.byteLength(respText, 'utf-8')

  if (layout === 'aligned') {
    const fenced = fenceNumberedFileContent(folded.numbered.join('\n'), ALIGNED_LAYOUT_NOTE)
    const rewritten = [...parsed.header, fenced.body, ...parsed.trailer].join('\n')
    if (!keepsLineNumbers(respText, rewritten)) return null
    if (
      !isRewriteWorthwhile({
        originalBytes,
        rewrittenBytes: Buffer.byteLength(rewritten, 'utf-8') + Buffer.byteLength(fenced.preamble, 'utf-8'),
        noticeBytes: 0,
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
    ) {
      return null
    }
    return {
      output: emitRewriteWithContext(rewritten, fenced.preamble, 'read', { kind: 'read:body_fold', originalBytes, detail: foldDetail(normalized, folded.folds) }),
      deliveredRaw: folded.raw.join('\n'),
    }
  }

  // `folded.numbered` is file bytes with this fold's own `... N lines folded` pointers interleaved, and it shipped unfenced: a source file's own text arrived beside token-goat's narration in one unlabelled block, so a first line spelling `[tg] ...` read as this rewrite's preamble. Fence the whole run, header and trailer (the harness's own framing) left outside it. Same repair as planSourceSkeleton.
  const rewritten = [...parsed.header, fenceUntrustedFileContent(folded.numbered.join('\n')), ...parsed.trailer].join('\n')
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
    output: emitRewrite(rewritten, 'read', { kind: 'read:body_fold', originalBytes, detail: foldDetail(normalized, folded.folds) }),
    deliveredRaw: folded.raw.join('\n'),
  }
}

/** Public wrapper: the same hint tracking as hooks_read.ts's preReadHandler, plus the served-line elision. The order of these three lines is the whole correctness argument. The elision runs FIRST, before {@link recordReadAsServedOutput} puts this very read into the store it compares against -- otherwise every line matches itself and the entire result is withheld as "already served". It is the same self-contamination shape as a structural guard that scans its own source. It also runs before {@link postReadHandlerInner}, whose structural-navigation hint would otherwise be composed, booked as shown by {@link applyHintTracking}, and then thrown away in favour of the rewrite -- a hint charged to the efficacy ledger that no model ever saw. The flag is a required parameter rather than a defaulted one so no call site can silently take the un-suppressed path the shipping one does not. The rewrite wins over the hint where both apply, because it acts on the bytes instead of asking: a hint is followed a small fraction of the time, and a withheld run is withheld. */
export function postReadHandler(event: HookEvent): HookOutput {
  const respText = extractReadOutput(event.raw)
  const elided = elideAlreadyServedLines(event, respText)
  // Only one rewrite may win, and elision goes first: it cuts lines the model already holds, which costs the reader nothing, while a fold withholds lines it has never seen. Running both would also double-count the same bytes in the ledger. The outline replacement runs before the granular fold: it only ever fires on a large, untargeted, many-headinged markdown document, which is a coarser and larger win than the line-level body/comment/prose folds below it would find on the same delivery.
  const outlined = elided === null ? foldMarkdownOutline(event, respText) : null
  // The source-file sibling of the outline replacement directly above, and it sits at the same level for the same reason: it fires only on a large, untargeted, many-symboled source file, a coarser and larger win than the line-level body/comment folds below would find on the same delivery. The two never contend, one taking documents and the other taking tree-sitter languages, but the ordering is written out rather than left to that: an extension that ever qualified for both would otherwise pick a winner by accident.
  const skeletoned = elided === null && outlined === null ? foldSourceSkeleton(event, respText) : null
  const folded = elided === null && outlined === null && skeletoned === null ? foldCodeBodies(event, respText) : null
  const rewrite = elided ?? outlined?.output ?? skeletoned?.output ?? folded?.output ?? null
  const out = applyHintTracking(event, postReadHandlerInner(event, rewrite !== null), classifyReadHint)
  const deliveredRaw = outlined?.deliveredRaw ?? skeletoned?.deliveredRaw ?? folded?.deliveredRaw ?? null
  if (deliveredRaw !== null) forgetFoldedWindow(event)
  recordReadAsServedOutput(event, deliveredRaw)
  recordLastReadShape(event, respText, outlined !== null ? 'outline' : skeletoned !== null ? 'skeleton' : folded !== null ? 'fold' : null)
  return rewrite ?? out
}

/** Keep how much of the file this Read handed over, for postEditHandler to book an Edit that follows a partial one (read_shape.ts). A rewrite names itself; otherwise a harness truncation, then a window that stops short of the file, the latter decided from the response's own placement of the window (`startLine`, `numLines`, `totalLines`) when it carries one, since a window asked for past the end still delivers the whole file, and from the request alone when it does not. Elided lines are not a shortfall: they were withheld because the model already holds them. */
function recordLastReadShape(event: HookEvent, respText: string, rewrite: ReadShape | null): void {
  try {
    const filePath = getFilePath(event)
    if (filePath === undefined) return
    const normalized = normalizePath(filePath)
    if (isImagePath(normalized)) return
    let shape = rewrite
    if (shape === null && isTruncatedReadDelivery(event, respText)) shape = 'truncated'
    if (shape === null && readRequestedSliceWindow(event).isExplicitSlice && windowCoversFile(event) !== true) shape = 'partial'
    recordReadShape(sessionStateKey(event), normalized, shape)
  } catch {
    // best-effort; a lost measurement never affects the completed Read
  }
}

/** Whether the response places its window over the whole file, or `undefined` when it carries no placement. */
function windowCoversFile(event: HookEvent): boolean | undefined {
  const resp = event.raw['tool_response'] as Record<string, unknown> | null
  const file = resp?.['file'] as Record<string, unknown> | null
  const start = file?.['startLine']
  const num = file?.['numLines']
  const total = file?.['totalLines']
  if (typeof start !== 'number' || typeof num !== 'number' || typeof total !== 'number') return undefined
  return start <= 1 && start + num - 1 >= total
}

/** Take back the line range a ranged Read put on record before a fold withheld part of it. preReadHandler records the requested window as served before the Read runs, so it cannot know a fold will withhold some of it, and the range re-read deny then refuses the very `Read offset/limit` a comment-fold notice names as "Lines A..B ... was already read this session" for lines the model was never shown. The whole file's ranges go, not just this window's, for the reason hooks_bash_post.ts's forgetPersistedLineRangeReads gives: session_store.ts merges ranges as a union and only a file-level removal survives the merge. A whole-file Read records no range, so it has none of its own to take back. */
function forgetFoldedWindow(event: HookEvent): void {
  if (!readRequestedSliceWindow(event).isExplicitSlice) return
  const filePath = getFilePath(event)
  if (filePath !== undefined) resetFileLineRanges(normalizePath(filePath))
}

registerHook('post_tool_use', postReadHandler, { toolName: 'Read' })
