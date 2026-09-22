/**
 * The compaction manifest: what this session touched, rendered for whoever reads it next.
 *
 * Ports the intent of `hooks_compact.py` / `build_manifest`: a concise summary of the files read, the files edited and the web URLs fetched, so a compaction preserves that context instead of dropping it. The manifest is intentionally compact -- aim well under 2000 chars.
 *
 * Two things the discarded builder did are deliberately not here. It inferred a session goal from the file names it saw and put that sentence at the top of the injected text: an inference stated as fact to the one reader who cannot check it, and wrong exactly when a session changed direction, which is when a manifest matters most. It also grouped rows by directory, which collapses the per-file read counts the rows exist to carry. Its noise-path filtering was worth keeping and is here, through {@link isNoisePath}. Reopen either decision by measuring against a real compaction, not by preference.
 *
 * It lives apart from the hook that emits it because it has two callers with different jobs. `hooks_compact.ts` builds it at `pre_compact` and hands it to the summarizing model; `cache_session_commands.ts` builds it for `compact-hint`, which reports what the next compaction will carry. Those two used to build different text from different code, so the command sized a manifest the hook would never produce and a reader checking one learned nothing about the other. One builder, two callers, and the module holds no `registerHook` call of its own -- importing it from a command must not install a hook as a side effect.
 */

import { spawnSync } from 'node:child_process'

import { WEB_FETCH_KEY_SEP, getSessionFiles, getSessionWebFetches, getSessionBashOutputs, getSessionBashReruns } from './session.js'
import type { FileEntry } from './session.js'
import { listSiblingSessionStates } from './session_store.js'
import { foldPath, toKB, runGit } from './util.js'
import { getBashOutput } from './bash_output_cache.js'
import { loadConfig } from './config.js'
import { computeAdaptiveBudget, getContextPressure, isNoisePath, loadSessionCache } from './compact.js'
import { displaySafePath, displaySafeText } from './paths.js'
import { neutralizeSpokenMarkers } from './injection_scan.js'

/** Bound on how long we'll wait for `mem epoch` before giving up -- see {@link buildMemEpochSection}. */
const MEM_EPOCH_TIMEOUT_MS = 800

/** Cap on read/edit/web rows so a huge session can't blow the token budget. */
const MAX_ROWS = 40

/**
 * Appends a blank line, `header`, up to `cap` of `rows` verbatim, and an `- ...and N more` overflow line when `rows` exceeds `cap`. No-op when `rows` is empty. Shared by every capped-list section in {@link buildManifest} and {@link buildSafeToDiscardSection}.
 */
function appendCappedSection(lines: string[], header: string, rows: readonly string[], cap: number): void {
  if (rows.length === 0) return
  lines.push('')
  lines.push(header)
  for (const row of rows.slice(0, cap)) lines.push(row)
  if (rows.length > cap) lines.push(`- ...and ${rows.length - cap} more`)
}

/** Render one read-file row: `path (Xkb, N reads[, edited])`. */
function renderReadRow(entry: FileEntry): string {
  const kb = Math.max(1, toKB(entry.sizeBytes))
  const plural = entry.readCount === 1 ? 'read' : 'reads'
  const edited = entry.wasEdited ? ', edited' : ''
  return `- ${displaySafePath(entry.path)} (${kb}kb, ${entry.readCount} ${plural}${edited})`
}

/** Render one surgically-read row: `path (symbols: a, b)`. The symbol list is what the preamble tells the summarizer to keep verbatim, so it is spelled out rather than counted. */
function renderSymbolReadRow(entry: FileEntry): string {
  return `- ${displaySafePath(entry.path)} (symbols: ${(entry.symbols_read ?? []).map(displaySafeText).join(', ')})`
}

/**
 * Fold sibling subagent file entries into the parent's own file list, keyed by {@link foldPath} (case-insensitive-filesystem-safe path identity, same key session_store.ts's own merge logic uses). A file counts as edited if ANY blob — parent or any subagent — marked it edited; readCount/lastReadAt take the max across blobs and sizeBytes comes from whichever view is most recent. symbols_read unions both blobs' lists (deduplicated) so a file that was surgically read by one blob and whole-read or edited by the other keeps its symbol list rather than losing it on collision, which previously made such a file vanish from every buildManifest section: readFiles/editedFiles require readCount>0/wasEdited, and symbolOnlyFiles required a non-empty symbols_read that this merge was silently dropping. This is a display-only merge for the compaction manifest, not the persisted-state merge in session_store.ts (that one tracks per-process read-count baselines that don't apply to blobs read cold off disk here).
 */
export function mergeManifestFiles(parent: FileEntry[], siblingFiles: FileEntry[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>()
  for (const f of parent) byPath.set(foldPath(f.path), f)
  for (const f of siblingFiles) {
    const key = foldPath(f.path)
    const prev = byPath.get(key)
    if (prev === undefined) {
      byPath.set(key, f)
      continue
    }
    const mergedSymbols = [...new Set([...(prev.symbols_read ?? []), ...(f.symbols_read ?? [])])]
    byPath.set(key, {
      path: prev.path,
      readCount: Math.max(prev.readCount, f.readCount),
      lastReadAt: Math.max(prev.lastReadAt, f.lastReadAt),
      wasEdited: prev.wasEdited || f.wasEdited,
      sizeBytes: f.lastReadAt >= prev.lastReadAt ? f.sizeBytes : prev.sizeBytes,
      ...(prev.wasTruncated || f.wasTruncated ? { wasTruncated: true } : {}),
      ...(mergedSymbols.length > 0 ? { symbols_read: mergedSymbols } : {}),
    })
  }
  return Array.from(byPath.values())
}

/**
 * One `- url (cacheId: ...)` row for a recorded web fetch, shared by the compaction manifest and `resume`'s packet.
 *
 * The map key is the redactedUrl + redactedPrompt + digest composite (see webFetchKey in session.ts), so split it back apart for display instead of treating the whole key as the url. Taking only the first two fields drops the trailing digest, which exists for identity and means nothing to a reader.
 *
 * Every other manifest row routes its file-derived text through displaySafePath/displaySafeText; this one did not, and a URL is no more ours than a filename is. The key holds only the redacted spellings, and redactSecrets removes secrets rather than neutralizing markers, so a fetched URL containing `[tg]` reached the manifest raw inside a block token-goat speaks in its own voice. The prompt is neutralized after JSON.stringify rather than before it: stringify already escapes quotes and control characters, and running the escaper first would leave the backslashes it produces to be escaped a second time.
 */
export function renderWebFetchRow(key: string, cacheId: string): string {
  const [url = key, prompt = ''] = key.split(WEB_FETCH_KEY_SEP)
  const promptSuffix = prompt ? `, prompt: ${neutralizeSpokenMarkers(JSON.stringify(prompt))}` : ''
  return `- ${displaySafeText(url)} (cacheId: ${cacheId}${promptSuffix})`
}

/**
 * Build the session manifest string.
 *
 * Counts reads and edits, then lists read files, an edited-files section (only when edits exist), and any fetched web URLs with their cache ids. Rows are capped at {@link MAX_ROWS} per section with a truncation note.
 *
 * `sessionId`, when provided, is the *unsalted* parent session id (relay.ts only salts `sessionStateKey` when `agentId` is set, which is never true on the main thread that runs pre_compact). Every subagent spawned during this session persisted its reads/edits into its own agent-salted blob (see relay.ts's `sessionStateKey`), separate from the parent's plain-keyed blob that {@link getSessionFiles} was just hydrated from — so without this, a subagent's edits are invisible to the compaction manifest that is supposed to preserve exactly that context across compaction. Sibling blobs are read straight off disk and merged in; nothing is written back.
 *
 * `cwd`, when provided, is passed through to {@link capManifestChars} so its {@link adaptiveCharBonus} can check real git dirty state for this project before capping -- omitted (e.g. a harness that doesn't send `cwd` on `pre_compact`), the cap falls back to the fixed configured value unchanged.
 */
/*
 * Paths and symbol names below go through displaySafePath/displaySafeText rather than being interpolated raw. They are file-derived and a repository names its own files, while this manifest is emitted under a preamble instructing the summarizing model to reproduce these rows exactly as written -- the most persistent place in the tool where an unescaped `[tg]` marker could sit, since it survives compaction into the next context.
 */
function selectManifestFiles(sessionId?: string): { files: FileEntry[]; readFiles: FileEntry[]; editedFiles: FileEntry[]; symbolOnlyFiles: FileEntry[] } {
  const ownFiles = [...getSessionFiles().values()]
  const siblingFiles = sessionId !== undefined ? listSiblingSessionStates(sessionId).flatMap((s) => s.files) : []
  const files = siblingFiles.length > 0 ? mergeManifestFiles(ownFiles, siblingFiles) : ownFiles
  const editedFiles = files.filter((f) => f.wasEdited)
  // Noise is dropped before the cap, never after. A session whose most-read paths are all lockfiles and `node_modules` entries would otherwise spend the whole row cap on rows it then discards and render `### Read files` as a heading with nothing under it -- a heading that asserts the list below is what was read. Edited files are exempt: a lockfile someone actually edited is a fact about the session, not incidental traffic.
  const readFiles = files.filter((f) => f.readCount > 0 && !f.wasEdited && !isNoisePath(f.path))
  // A file reached only through `token-goat read "file::symbol"` gets a readCount: 0, wasEdited: false entry carrying symbols_read (see recordSymbolRead in session.ts), so it falls through BOTH filters above and used to vanish from the manifest entirely -- while computeAdaptiveBudget was still granting it a symbolsBonus for content that was never emitted, and postCompactHandler's survival canary was sampling a path the manifest never printed. Give it its own bucket.
  const symbolOnlyFiles = files.filter((f) => f.readCount === 0 && !f.wasEdited && (f.symbols_read?.length ?? 0) > 0)
  return { files, readFiles, editedFiles, symbolOnlyFiles }
}

/**
 * The paths {@link buildManifest} actually prints, in print order, capped at `limit`.
 *
 * The post-compaction survival canary counts how many of these the summary reproduced, so it must draw from the same selection the manifest printed rather than from the raw session file list. A path the manifest filtered out can never survive, so sampling one inflates the denominator and drives the canary's ratio down for a reason that has nothing to do with the channel it watches -- a false "channel dead" alarm, which is the one failure a canary must not raise.
 *
 * Paths are returned verbatim, because that is exactly what the rows print: {@link renderReadRow} and the edited/symbol rows each interpolate the stored path with no transformation. Case tolerance belongs at the comparison, where both sides get folded together.
 */
export function manifestPrintedPaths(sessionId: string | undefined, limit: number): string[] {
  // Taken from what the render step recorded, not parsed back out of its own output. Re-deriving from selectManifestFiles sampled the uncapped lists, so rows past each section's MAX_ROWS counted despite never being shown; capping at MAX_ROWS here instead would still have been a guess, because capManifestChars applies a character budget to the joined string afterwards. Re-parsing the rendered text was the next wrong answer: a path containing a space stops at the space, the `- ...and N more` overflow notice is itself a bullet, and with no web section to stop at the scan runs on into SAFE_TO_DISCARD and reads cached shell commands as paths. A path the model was never shown cannot survive into the summary, so every one of those counts retained context as lost.
  const { printed } = buildManifestParts(sessionId)
  return printed.slice(0, limit)
}

/**
 * The manifest text together with the file paths it actually printed, in print order.
 *
 * One pass, so the two can never disagree. A row is recorded only if it was inside its section's row cap AND its full rendered line survives the character budget -- `includes` on the whole row rather than on the path, so a row the budget sliced in half is not counted, and only the three file sections contribute, which is what keeps notices, web URLs and SAFE_TO_DISCARD rows out without needing to recognise them.
 */
function buildManifestParts(
  sessionId?: string,
  cwd?: string,
  transcriptPath?: string,
): { text: string; printed: string[] } {
  const { files, readFiles, editedFiles, symbolOnlyFiles } = selectManifestFiles(sessionId)
  const webFetches = [...getSessionWebFetches().entries()]

  const lines: string[] = []
  lines.push('## Session context')
  lines.push(`Files read: ${readFiles.length}`)
  lines.push(`Files edited: ${editedFiles.length}`)

  // Every row a file section prints, paired with the path it names, so the survival sample below is taken rather than re-derived.
  const fileRows: { path: string; row: string }[] = []
  const appendFileSection = (header: string, entries: readonly FileEntry[], render: (entry: FileEntry) => string): void => {
    const rows = entries.map(render)
    appendCappedSection(lines, header, rows, MAX_ROWS)
    for (let i = 0; i < Math.min(rows.length, MAX_ROWS); i++) fileRows.push({ path: displaySafePath(entries[i]!.path), row: rows[i]! })
  }

  // Edits before reads, because capManifestChars cuts the tail and the two sections are not worth the same. The budget is 1600 chars by default and a read row runs about 55, so roughly 28 read rows consume all of it -- MAX_ROWS (40) is not even reachable. With reads rendered first, any session past that many reads had its entire edited-files section truncated away, and the summarizing model was told what the session had looked at but not what it had changed. Measured: 45 reads and one edit printed no edited row at all. Reads are also the recoverable half, since a dropped read row costs a re-read while a dropped edit is a fact about the session that nothing else records.
  appendFileSection('### Edited files', editedFiles, (entry) => `- ${displaySafePath(entry.path)}`)
  appendFileSection('### Surgically read files (symbol/section reads, never read whole)', symbolOnlyFiles, renderSymbolReadRow)
  appendFileSection('### Read files', readFiles, renderReadRow)
  appendCappedSection(lines, '### Web URLs fetched', webFetches.map(([key, cacheId]) => renderWebFetchRow(key, cacheId)), MAX_ROWS)

  lines.push(...buildSafeToDiscardSection(files))
  lines.push(...buildMemEpochSection())

  const text = capManifestChars(lines.join('\n'), sessionId, cwd, transcriptPath)

  const seen = new Set<string>()
  const printed: string[] = []
  for (const { path, row } of fileRows) {
    if (seen.has(path) || !text.includes(row)) continue
    seen.add(path)
    printed.push(path)
  }
  return { text, printed }
}

/** The compaction manifest for `sessionId`, as text -- {@link buildManifestParts} without the survival sample its other caller needs. */
export function buildManifest(sessionId?: string, cwd?: string, transcriptPath?: string): string {
  return buildManifestParts(sessionId, cwd, transcriptPath).text
}

/**
 * Detect real, pre-compaction git dirty state for `cwd` -- `hasPendingDiff` mirrors the Python predecessor's `_get_git_diff_stat_summary()` signal (`git diff --stat HEAD` non-empty: tracked working-tree/staged changes vs HEAD), `hasUncommittedChanges` mirrors `_get_uncommitted_changes()` (`git status --porcelain` non-empty: also catches untracked files `diff --stat HEAD` misses). Both feed {@link computeAdaptiveBudget}'s git-derived bonuses via {@link adaptiveCharBonus}. Uses {@link runGit} (the only git spawn site in the codebase) with `hints.git_hint_max_ms` (same bound `hooks_session.ts`'s own git-hint calls use) so a slow/hung git can never block compaction; any spawn failure or non-zero exit fails soft to `false` for that signal.
 */
function gitDirtySignals(cwd: string): { hasPendingDiff: boolean; hasUncommittedChanges: boolean } {
  const timeoutMs = loadConfig().hints.git_hint_max_ms
  let hasPendingDiff = false
  try {
    const diffResult = runGit(['diff', '--no-color', '--stat', 'HEAD'], { cwd, timeoutMs })
    hasPendingDiff = diffResult.exitCode === 0 && diffResult.stdout.trim() !== ''
  } catch {
    // fail-soft: treat as no pending diff
  }
  let hasUncommittedChanges = false
  try {
    const statusResult = runGit(['status', '--porcelain'], { cwd, timeoutMs })
    hasUncommittedChanges = statusResult.exitCode === 0 && statusResult.stdout.trim() !== ''
  } catch {
    // fail-soft: treat as no uncommitted changes
  }
  return { hasPendingDiff, hasUncommittedChanges }
}

/**
 * Extra manifest-char budget to add on top of the configured `compact_assist.max_manifest_chars` cap, driven by real git dirty state right before this compaction fires.
 *
 * Reuses `compact.ts`'s `computeAdaptiveBudget` -- ported from the Python predecessor's `build_manifest_adaptive` (see `eb119425`) but never wired to this, the real production PreCompact path, until now -- rather than reimplementing its bonus formula here. Calls it twice with identical cache/age/pressure inputs, toggling only the git-derived opts, and returns the *delta* between the two (in chars, at `estimateTokens`'s ~3 chars/token, floored at 0). Using the delta -- instead of using `computeAdaptiveBudget`'s absolute result as the cap outright -- guarantees the common case (a clean working tree: no pending diff, no uncommitted changes) adds exactly 0 and therefore reproduces today's fixed `max_manifest_chars` cap unchanged; a dirty tree only ever grows the cap, giving the compaction LLM more room for the "Pending Changes"-equivalent git context precisely when there is git state worth preserving, without ever shrinking below the configured default.
 *
 * No-op (returns 0) when `cwd` is unavailable (harness didn't send one) -- fails soft rather than guessing a working directory for the git spawns.
 */
function adaptiveCharBonus(sessionId: string | undefined, cwd: string | undefined, transcriptPath: string | undefined): number {
  if (!cwd) return 0
  const cache = loadSessionCache(sessionId ?? '') ?? {}
  const ageSecs = cache.created_ts !== undefined ? Math.max(0, Date.now() / 1000 - cache.created_ts) : 0
  const contextPressure = getContextPressure(cache, transcriptPath)
  const { hasPendingDiff, hasUncommittedChanges } = gitDirtySignals(cwd)
  if (!hasPendingDiff && !hasUncommittedChanges) return 0

  const baseline = computeAdaptiveBudget(cache, ageSecs, { contextPressure })
  const withGitSignal = computeAdaptiveBudget(cache, ageSecs, { hasPendingDiff, hasUncommittedChanges, contextPressure })
  const deltaTokens = Math.max(0, withGitSignal - baseline)
  return deltaTokens * 3
}

/**
 * Enforce `compact_assist.max_manifest_chars` (default 1600) on the fully-built manifest -- this module's own doc comment promises the manifest stays "well under 2000 chars", but nothing previously bounded the actual string: MAX_ROWS only caps rows *per section*, not the manifest's total length, so a session with many populated sections (reads, edits, web fetches, SAFE_TO_DISCARD, mem epoch) could still produce an arbitrarily large manifest. `max_manifest_chars <= 0` means "no cap", the same 0-means-unlimited convention the rest of token-goat's numeric caps use, so a 0 value never truncates -- and never spends the git-spawn cost of {@link adaptiveCharBonus} either, since there is no cap for it to adjust. Likewise, when the manifest already fits under the base (non-adaptive) cap, there is nothing for the bonus to widen room for, so the two `git diff`/`git status` spawns in {@link adaptiveCharBonus} are skipped entirely rather than paid on every compaction regardless of whether truncation could ever happen.
 */
function capManifestChars(manifest: string, sessionId?: string, cwd?: string, transcriptPath?: string): string {
  const cap = loadConfig().compact_assist.max_manifest_chars
  if (cap <= 0) return manifest
  if (manifest.length <= cap) return manifest
  const effectiveCap = cap + adaptiveCharBonus(sessionId, cwd, transcriptPath)
  if (manifest.length <= effectiveCap) return manifest
  const omitted = manifest.length - effectiveCap
  return manifest.slice(0, effectiveCap) + `\n...(manifest truncated at ${effectiveCap} chars; ${omitted} chars omitted)`
}

/**
 * Build the SAFE_TO_DISCARD manifest section: provably-inert prior context that compaction can drop without losing data, because it is recoverable through an existing recall command. Conservative by construction -- only three classes, each backed by an explicit session-state signal (never inferred):
 *
 * 1. Superseded identical-command bash reruns: a store call this session
 *    overwrote an already-cached entry under the exact same command key (see
 *    recordBashRerun in session.ts, wired from hooks_bash.ts's Item F
 *    delta-folding path). The raw transcript copy of the OLDER run is dead --
 *    the surviving cached id already holds the freshest output.
 * 2. File reads superseded by a later Edit/Write/Read of the same file:
 *    readCount > 1 (re-read at least once) or wasEdited (the file changed
 *    after being read) both mean an earlier textual copy in the transcript no
 *    longer reflects the file's current content.
 * 3. Every other bash output still tracked in the session's cache index --
 *    each is recallable verbatim via bash-output <id>, so its inline
 *    transcript copy is redundant regardless of whether it was ever rerun.
 *    Reruns already itemized under (1) are excluded here to avoid double
 *    counting the same command under two headings.
 *
 * Always labels the section with an explicit item count and the recall command needed to get each item's data back -- never implies data is gone, only that the inline copy is a redundant duplicate of something recallable.
 */
function buildSafeToDiscardSection(files: FileEntry[]): string[] {
  const rerunHashes = getSessionBashReruns()
  const bashOutputs = getSessionBashOutputs()
  const rerunHashSet = new Set(rerunHashes)

  // entry.command only ever passes through redactSecrets (bash_output_cache.ts), never marker neutralization, so a command string containing `[tg]`/`[token-goat: ...]` reached this unfenced manifest row raw; neutralizeSpokenMarkers below closes that the same way the web-fetch URL row already does above.
  const rerunRows: string[] = []
  for (const hash of rerunHashes) {
    const id = bashOutputs.find(([h]) => h === hash)?.[1]
    if (id === undefined) continue
    const entry = getBashOutput(id)
    if (entry === null) continue
    const flatCommand = neutralizeSpokenMarkers(entry.command.replace(/[\t\r\n]+/g, ' '))
    rerunRows.push('- `' + flatCommand + '` — an older run of this exact command was superseded; recall the surviving copy with `bash-output ' + id + ' --full`')
  }

  const supersededReadRows: string[] = []
  for (const f of files) {
    if (f.readCount > 1 || f.wasEdited) {
      const reason = f.wasEdited ? 'edited after being read' : ('re-read ' + f.readCount + 'x')
      supersededReadRows.push('- ' + displaySafePath(f.path) + ' (' + reason + ' — only the latest content already in context is current)')
    }
  }

  const cachedOutputRows: string[] = []
  for (const [hash, id] of bashOutputs) {
    if (rerunHashSet.has(hash)) continue
    const entry = getBashOutput(id)
    if (entry === null) continue
    const flatCommand = neutralizeSpokenMarkers(entry.command.replace(/[\t\r\n]+/g, ' '))
    cachedOutputRows.push('- `' + flatCommand + '` — recallable via `bash-output ' + id + ' --full`')
  }

  const total = rerunRows.length + supersededReadRows.length + cachedOutputRows.length
  if (total === 0) return []

  const lines: string[] = []
  lines.push('')
  lines.push('### SAFE_TO_DISCARD (' + total + ' items — provably inert; each is recallable, not gone)')
  appendCappedSection(lines, 'Superseded reruns (' + rerunRows.length + '):', rerunRows, MAX_ROWS)
  appendCappedSection(lines, 'Superseded file reads (' + supersededReadRows.length + '):', supersededReadRows, MAX_ROWS)
  appendCappedSection(lines, 'Other cached bash outputs (' + cachedOutputRows.length + '):', cachedOutputRows, MAX_ROWS)
  return lines
}

/**
 * Fold `mem epoch` (token-goat-mem's monotonic counter, when the `mem` binary is on PATH) into the compaction manifest, so a resumed session can tell whether mem's fact store has advanced since this transcript was captured.
 *
 * FINDING (searched for at implementation time): this codebase has no existing tracking of a "current live TGMEM block" anywhere -- no `TGMEM` marker, no in-session summary of facts mem currently holds. `hooks_compact.ts`'s manifest tracks only file reads/edits/web fetches/bash-output caching (see {@link buildManifest}); nothing here shadows mem's own state. Per spec, that gap is reported rather than papered over with a fabricated block-tracking mechanism: this section folds in `mem epoch`'s bare integer alone, with an explicit note that no live TGMEM block is tracked in this session.
 *
 * Must fail open: `mem` may be absent from PATH, may error, or may hang. `spawnSync` bounds the wait to {@link MEM_EPOCH_TIMEOUT_MS} (same spawnSync-with-timeout pattern as checkCopilotCli in cli_doctor.ts) and any failure -- ENOENT, non-zero exit, timeout kill, unparsable stdout -- silently omits the section. No error is ever surfaced and compaction never blocks or fails because of this.
 */
function buildMemEpochSection(): string[] {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('mem', ['epoch'], {
      encoding: 'utf-8',
      timeout: MEM_EPOCH_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch {
    return []
  }
  if (result.error !== undefined || result.status !== 0) return []

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  if (!/^\d+$/.test(stdout)) return []

  return [
    '',
    '### mem epoch',
    `mem epoch: ${stdout} (no live TGMEM block is tracked in this session -- only the epoch counter is folded in; see buildMemEpochSection's doc comment)`,
  ]
}

/**
 * Framing in front of the manifest, addressed to whoever writes the compaction summary.
 *
 * Reaches the summarizer as raw `customInstructions`: `hook_registry.ts` lists `pre_compact` in EVENTS_WITH_RAW_STDOUT_CONTEXT, so this text is handed over unwrapped rather than rendered as a tool result. That is the only lever token-goat holds on the compaction channel.
 *
 * An earlier revision asked for preservation and deliberately not for brevity, reasoning that trading a summary's completeness for tokens was a bad trade to make on a user's behalf without being asked. The budget below exists because the user asked. It does not replace that reasoning: preservation stays the first instruction, the budget is a target rather than a cap, and {@link BUDGET_ESCALATION_MARKER} lets a session that genuinely cannot fit exceed it on the record instead of silently dropping state.
 */
export const MANIFEST_PREAMBLE =
  'When summarizing this session, keep the file paths and symbol names below exactly as written -- they are the handles the next turn needs to resume work. Do not paraphrase them into prose.'

/**
 * Framing in front of the manifest when it arrives *after* the compaction rather than before it.
 *
 * {@link MANIFEST_PREAMBLE} instructs whoever writes the summary, which only works on a harness whose pre-compact hook feeds that writer. Where the event fires and the response is discarded -- see PRE_COMPACT_CONTEXT_DROPPED in harness_channels.ts -- the same text has to reach the model on the next tool call instead, by which point the summary is already written and nothing can be preserved that was not. So it stops being instructions and becomes recovery: here is what the session touched, in case the summary lost it. Addressing it to a summarizer that has already finished would ask for something impossible and read as a stale instruction.
 */
export const MANIFEST_RECOVERY_PREAMBLE =
  "The conversation was just compacted. Below is what this session touched, recovered from token-goat's own ledger rather than from the summary -- use it to re-establish paths and symbol names the summary may have dropped."

/**
 * Opening token a summary uses to declare it exceeded its budget on purpose.
 *
 * One constant for both voices: {@link summaryBudgetDirective} asks for it and {@link postCompactHandler} counts it. Two literals would let the emitter drift from the detector, and that failure is silent -- every escalation would read as an ordinary overrun.
 */
export const BUDGET_ESCALATION_MARKER = 'TG-BUDGET-ESCALATION:'

/**
 * The length target appended to {@link MANIFEST_PREAMBLE}, or an empty string when budgeting is off.
 *
 * Measured before it was chosen: 847 summaries over 7 days on the machine this was built on ran 24.56 MB in total, p50 26,240 characters, max 145,587. A 24,000 target binds 504 of those 847. The trim that implies is a ceiling on the mechanism's reach and never a prediction -- whether a summarizer honors a length request in `customInstructions` is exactly what the `budget=` and `over=` fields recorded by {@link postCompactHandler} exist to answer.
 */
export function summaryBudgetDirective(budgetChars: number): string {
  if (budgetChars <= 0) return ''
  return ` Aim for at most ${budgetChars} characters. Prefer a shorter summary that keeps every path, symbol, command and decision over a longer one that reproduces tool output verbatim: cite the recall id (\`token-goat bash-output <id> --full\`) rather than quoting the output again. If this session genuinely cannot be summarized within that target without losing state the next turn needs, exceed it and open the summary with a single line reading \`${BUDGET_ESCALATION_MARKER} <one-sentence reason>\`.`
}
