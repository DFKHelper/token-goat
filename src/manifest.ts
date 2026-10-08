/** The compaction manifest: what this session touched, rendered for whoever reads it next. Ports the intent of `hooks_compact.py` / `build_manifest`: a concise summary of the files read, the files edited and the web URLs fetched, so a compaction preserves that context instead of dropping it. The manifest is intentionally compact -- aim well under 2000 chars. Two things the discarded builder did are deliberately not here. It inferred a session goal from the file names it saw and put that sentence at the top of the injected text: an inference stated as fact to the one reader who cannot check it, and wrong exactly when a session changed direction, which is when a manifest matters most. It also grouped rows by directory, which collapses the per-file read counts the rows exist to carry. Its noise-path filtering was worth keeping and is here, through {@link isNoisePath}. Reopen either decision by measuring against a real compaction, not by preference. It lives apart from the hook that emits it because it has two callers with different jobs. `hooks_compact.ts` builds it at `pre_compact` and hands it to the summarizing model; `cache_session_commands.ts` builds it for `compact-hint`, which reports what the next compaction will carry. Those two used to build different text from different code, so the command sized a manifest the hook would never produce and a reader checking one learned nothing about the other. One builder, two callers, and the module holds no `registerHook` call of its own -- importing it from a command must not install a hook as a side effect. */

import { resolveOnPath, spawnResolvedSync } from './process_util.js'

import { WEB_FETCH_KEY_SEP, epochReadCounts, getSessionFiles, getSessionWebFetches, getSessionBashOutputs, getSessionBashReruns, mergeEpochBase, wasEditedSinceCompaction } from './session.js'
import type { FileEntry, SerializedSession } from './session.js'
import { listSiblingSessionStates } from './session_store.js'
import { foldPath, toKB, runGit } from './util.js'
import { getBashOutput } from './bash_output_cache.js'
import { hasWebOutput } from './web_cache.js'
import { loadConfig } from './config.js'
import { computeAdaptiveBudget, getContextPressure, isNoisePath, loadSessionCache } from './compact.js'
import { displaySafePath, displaySafeText } from './paths.js'
import { neutralizeSpokenMarkers, UNTRUSTED_FILE_TAG } from './injection_scan.js'
import { projectNotesFor } from './project_memory.js'
import { fitSections } from './manifest_fit.js'
import type { FitSection } from './manifest_fit.js'

/** Bound on how long we'll wait for `mem epoch` before giving up -- see {@link buildMemEpochSection}. The launcher is a `.cmd` file on Windows, so each call pays a cmd.exe start: 20 calls to an echo-only one took 93-213 ms with 3 stalls of 729-1043 ms on a loaded machine, and the earlier 800 ms cap dropped the epoch on those. 2000 ms clears the worst stall about twice over and, added to the rest of the hook, still ends inside the 3000 ms the Claude Code shim gives its spawned fallback (src/bridges/shim_common.ts). */
const MEM_EPOCH_TIMEOUT_MS = 2000

/** Cap on read/edit/web rows so a huge session can't blow the token budget. */
const MAX_ROWS = 40

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

/** Fold sibling subagent file entries into the parent's own file list, keyed by {@link foldPath} (case-insensitive-filesystem-safe path identity, same key session_store.ts's own merge logic uses). A file counts as edited if ANY blob — parent or any subagent — marked it edited; readCount/lastReadAt take the max across blobs and sizeBytes comes from whichever view is most recent. symbols_read unions both blobs' lists (deduplicated) so a file that was surgically read by one blob and whole-read or edited by the other keeps its symbol list rather than losing it on collision, which previously made such a file vanish from every buildManifest section: readFiles/editedFiles require readCount>0/wasEdited, and symbolOnlyFiles required a non-empty symbols_read that this merge was silently dropping. This is a display-only merge for the compaction manifest, not the persisted-state merge in session_store.ts (that one tracks per-process read-count baselines that don't apply to blobs read cold off disk here). */
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
    const fullReadCount = Math.max(prev.fullReadCount ?? 0, f.fullReadCount ?? 0)
    const lastFullReadAt = Math.max(prev.lastFullReadAt ?? -1, f.lastFullReadAt ?? -1)
    const epochBase = mergeEpochBase(prev.epochBase, f.epochBase)
    const lastEditedAt = Math.max(prev.lastEditedAt ?? 0, f.lastEditedAt ?? 0)
    byPath.set(key, {
      path: prev.path,
      readCount: Math.max(prev.readCount, f.readCount),
      lastReadAt: Math.max(prev.lastReadAt, f.lastReadAt),
      ...(fullReadCount > 0 ? { fullReadCount } : {}),
      ...(lastFullReadAt >= 0 ? { lastFullReadAt } : {}),
      wasEdited: prev.wasEdited || f.wasEdited,
      ...(lastEditedAt > 0 ? { lastEditedAt } : {}),
      sizeBytes: f.lastReadAt >= prev.lastReadAt ? f.sizeBytes : prev.sizeBytes,
      ...(prev.wasTruncated || f.wasTruncated ? { wasTruncated: true } : {}),
      ...(mergedSymbols.length > 0 ? { symbols_read: mergedSymbols } : {}),
      ...(epochBase !== undefined ? { epochBase } : {}),
    })
  }
  return Array.from(byPath.values())
}

/** One `- url (cacheId: ...)` row for a recorded web fetch, shared by the compaction manifest and `resume`'s packet. The map key is the redactedUrl + redactedPrompt + digest composite (see webFetchKey in session.ts), so split it back apart for display instead of treating the whole key as the url. Taking only the first two fields drops the trailing digest, which exists for identity and means nothing to a reader. Every other manifest row routes its file-derived text through displaySafePath/displaySafeText; this one did not, and a URL is no more ours than a filename is. The key holds only the redacted spellings, and redactSecrets removes secrets rather than neutralizing markers, so a fetched URL containing `[tg]` reached the manifest raw inside a block token-goat speaks in its own voice. The prompt is neutralized after JSON.stringify rather than before it: stringify already escapes quotes and control characters, and running the escaper first would leave the backslashes it produces to be escaped a second time. */
export function renderWebFetchRow(key: string, cacheId: string, live = true): string {
  const [url = key, prompt = ''] = key.split(WEB_FETCH_KEY_SEP)
  if (!live) return `- ${displaySafeText(url)} (cache expired)`
  const promptSuffix = prompt ? `, prompt: ${neutralizeSpokenMarkers(JSON.stringify(prompt))}` : ''
  return `- ${displaySafeText(url)} (cacheId: ${cacheId}${promptSuffix})`
}

/** The rows for a list of `[key, cacheId]` fetches, shared by the compaction manifest and `resume`. A fetch whose cached body has expired keeps its url, so the model still knows the page was consulted, but loses the cacheId and prompt that would only point at nothing; when every fetch has expired the rows collapse to one line naming the count and the urls. */
export function renderWebFetchRows(entries: ReadonlyArray<readonly [string, string]>): string[] {
  const live = entries.map(([, cacheId]) => hasWebOutput(cacheId))
  if (entries.length > 0 && !live.includes(true)) {
    const urls = entries.map(([key]) => displaySafeText(key.split(WEB_FETCH_KEY_SEP)[0] ?? key))
    return [`- ${entries.length} fetched page${entries.length === 1 ? '' : 's'}, cache expired: ${urls.join(', ')}`]
  }
  return entries.map(([key, cacheId], n) => renderWebFetchRow(key, cacheId, live[n]))
}

/** Build the session manifest string. Counts reads and edits, then lists read files, an edited-files section (only when edits exist), and any fetched web URLs with their cache ids. Rows are capped at {@link MAX_ROWS} per section with a truncation note. `sessionId`, when provided, is the *unsalted* parent session id (relay.ts only salts `sessionStateKey` when `agentId` is set, which is never true on the main thread that runs pre_compact). Every subagent spawned during this session persisted its reads/edits into its own agent-salted blob (see relay.ts's `sessionStateKey`), separate from the parent's plain-keyed blob that {@link getSessionFiles} was just hydrated from — so without this, a subagent's edits are invisible to the compaction manifest that is supposed to preserve exactly that context across compaction. Sibling blobs are read straight off disk and merged in; nothing is written back. `cwd`, when provided, is passed through to {@link capManifestChars} so its {@link adaptiveCharBonus} can check real git dirty state for this project before capping -- omitted (e.g. a harness that doesn't send `cwd` on `pre_compact`), the cap falls back to the fixed configured value unchanged. */
/* Paths and symbol names below go through displaySafePath/displaySafeText rather than being interpolated raw. They are file-derived and a repository names its own files, while this manifest is emitted under a preamble instructing the summarizing model to reproduce these rows exactly as written -- the most persistent place in the tool where an unescaped `[tg]` marker could sit, since it survives compaction into the next context. */
function selectManifestFiles(siblings: readonly SerializedSession[]): { files: FileEntry[]; readFiles: FileEntry[]; editedFiles: FileEntry[]; symbolOnlyFiles: FileEntry[] } {
  const ownFiles = [...getSessionFiles().values()]
  const siblingFiles = siblings.flatMap((s) => s.files)
  const files = siblingFiles.length > 0 ? mergeManifestFiles(ownFiles, siblingFiles) : ownFiles
  const editedFiles = files.filter((f) => f.wasEdited)
  // Noise is dropped before the cap, never after. A session whose most-read paths are all lockfiles and `node_modules` entries would otherwise spend the whole row cap on rows it then discards and render `### Read files` as a heading with nothing under it -- a heading that asserts the list below is what was read. Edited files are exempt: a lockfile someone actually edited is a fact about the session, not incidental traffic.
  const readFiles = files.filter((f) => f.readCount > 0 && !f.wasEdited && !isNoisePath(f.path))
  // A file reached only through `token-goat read "file::symbol"` gets a readCount: 0, wasEdited: false entry carrying symbols_read (see recordSymbolRead in session.ts), so it falls through BOTH filters above and used to vanish from the manifest entirely -- while computeAdaptiveBudget was still granting it a symbolsBonus for content that was never emitted, and postCompactHandler's survival canary was sampling a path the manifest never printed. Give it its own bucket.
  const symbolOnlyFiles = files.filter((f) => f.readCount === 0 && !f.wasEdited && (f.symbols_read?.length ?? 0) > 0)
  return { files, readFiles, editedFiles, symbolOnlyFiles }
}

/** Every web fetch this session reached, the parent thread's and its subagents'. Merged for the same reason {@link selectManifestFiles} merges sibling files: a URL a subagent fetched lives only in that subagent's agent-salted blob, and `getSessionWebFetches` holds the parent's in-memory state alone. This section used to read that map directly, so a research subagent's fetches were absent from the one artifact whose job is to carry them across a compaction -- and a lost URL row costs more than a lost file row, because it takes the cache id that would have recalled the body for free with it. Parent entries are written last so a URL both fetched keeps the parent's cache id. The key already carries the prompt (see `WEB_FETCH_KEY_SEP`), so two fetches of one URL under different prompts stay two rows rather than collapsing into whichever was seen last. */
function selectManifestWebFetches(siblings: readonly SerializedSession[]): [string, string][] {
  const merged = new Map<string, string>()
  for (const sibling of siblings) for (const [key, cacheId] of sibling.webFetches) merged.set(key, cacheId)
  for (const [key, cacheId] of getSessionWebFetches()) merged.set(key, cacheId)
  return [...merged.entries()]
}

/** The paths {@link buildManifest} actually prints, in print order, capped at `limit`. The post-compaction survival canary counts how many of these the summary reproduced, so it must draw from the same selection the manifest printed rather than from the raw session file list. A path the manifest filtered out can never survive, so sampling one inflates the denominator and drives the canary's ratio down for a reason that has nothing to do with the channel it watches -- a false "channel dead" alarm, which is the one failure a canary must not raise. Paths come back in the spelling the rows print -- `displaySafePath` applied to the stored path, the same call every renderer makes -- so a caller comparing against the manifest is comparing like with like. Case tolerance belongs at that comparison, where both sides get folded together. `cwd` and `transcriptPath` must be whatever the emitting hook passed to {@link buildManifest}: they feed the adaptive character budget, and rebuilding under a different budget prints a different set of rows. */
export function manifestPrintedPaths(sessionId: string | undefined, limit: number, cwd?: string, transcriptPath?: string): string[] {
  // Taken from what the render step recorded, not parsed back out of its own output. Re-deriving from selectManifestFiles sampled the uncapped lists, so rows past each section's MAX_ROWS counted despite never being shown; capping at MAX_ROWS here instead would still have been a guess, because capManifestChars applies a character budget to the joined string afterwards. Re-parsing the rendered text was the next wrong answer: a path containing a space stops at the space, the `- ...and N more` overflow notice is itself a bullet, and with no web section to stop at the scan runs on into SAFE_TO_DISCARD and reads cached shell commands as paths. A path the model was never shown cannot survive into the summary, so every one of those counts retained context as lost.
  const { printed } = buildManifestParts(sessionId, cwd, transcriptPath)
  return printed.slice(0, limit)
}

/** The manifest text together with the file paths it actually printed, in print order. One pass, so the two can never disagree. A row is recorded only if it was inside its section's row cap AND its full rendered line survives the character budget -- `includes` on the whole row rather than on the path, so a row the budget sliced in half is not counted, and only the three file sections contribute, which is what keeps notices, web URLs and SAFE_TO_DISCARD rows out without needing to recognise them. */
function buildManifestParts(
  sessionId?: string,
  cwd?: string,
  transcriptPath?: string,
): { text: string; printed: string[] } {
  // Read once and shared by both selections below. Each sibling scan is a directory listing plus a JSON parse per blob, and the two sections have no reason to disagree about which subagents ran.
  const siblings = sessionId !== undefined ? listSiblingSessionStates(sessionId) : []
  const { files, readFiles, editedFiles, symbolOnlyFiles } = selectManifestFiles(siblings)
  const webFetches = selectManifestWebFetches(siblings)

  // Fill priority is edits, notes, surgical reads, reads, web: the budget drops whole rows from the low end first, and a display-order cut used to take the tail whichever section it held. Edits outrank reads because the two sections are not worth the same. The budget is 1600 chars by default and a read row runs about 55, so roughly 28 read rows consume all of it -- MAX_ROWS (40) is not even reachable. With reads rendered first, any session past that many reads had its entire edited-files section truncated away, and the summarizing model was told what the session had looked at but not what it had changed. Measured: 45 reads and one edit printed no edited row at all. Reads are also the recoverable half, since a dropped read row costs a re-read while a dropped edit is a fact about the session that nothing else records. Notes sit behind the edits and ahead of the reads for the reason the edits lead: the cap cuts the tail, and a note is a finding the session recorded on purpose that nothing else holds, while a dropped read row costs a re-read. It is also the only way a note gets back into a Codex session, whose SessionStart is unwired and whose manifest arrives after the compaction. Unmarked: this builder is synchronous and the anchor resolver is loaded lazily to keep the index reader off the hook eager path. On Claude Code the SessionStart that follows a compaction re-injects the notes with their markers.
  const fileSections: { entries: readonly FileEntry[]; section: FitSection }[] = []
  const fileSection = (header: string, entries: readonly FileEntry[], render: (entry: FileEntry) => string, priority: number): FitSection[] => {
    if (entries.length === 0) return []
    const section: FitSection = { header: ['', header], rows: entries.map(render), priority, maxRows: MAX_ROWS }
    fileSections.push({ entries, section })
    return [section]
  }
  const notes = projectNotesFor(cwd)
  const webRows = renderWebFetchRows(webFetches)
  const sections: FitSection[] = [
    { header: ['## Session context', `Files read: ${readFiles.length}`, `Files edited: ${editedFiles.length}`], priority: 0 },
    ...fileSection('### Edited files', editedFiles, (entry) => `- ${displaySafePath(entry.path)}`, 1),
    ...(notes === null ? [] : [notesSection(notes)]),
    ...fileSection('### Surgically read files (symbol/section reads, never read whole)', symbolOnlyFiles, renderSymbolReadRow, 3),
    ...fileSection('### Read files', readFiles, renderReadRow, 4),
    ...(webRows.length === 0 ? [] : [{ header: ['', '### Web URLs fetched'], rows: webRows, priority: 5, maxRows: MAX_ROWS }]),
    ...buildSafeToDiscardSection(files),
    ...buildMemEpochSection(),
  ]

  const fit = fitManifest(sections, sessionId, cwd, transcriptPath)

  // Paths come from the rows the fitter reports as emitted, never from a substring search over the text: a path is printed exactly when its whole row was.
  const seen = new Set<string>()
  const printed: string[] = []
  for (const { entries, section } of fileSections) {
    const count = fit.shown[sections.indexOf(section)] ?? 0
    for (const entry of entries.slice(0, count)) {
      const path = displaySafePath(entry.path)
      if (seen.has(path)) continue
      seen.add(path)
      printed.push(path)
    }
  }
  return { text: fit.text, printed }
}

/** The compaction manifest for `sessionId`, as text -- {@link buildManifestParts} without the survival sample its other caller needs. */
export function buildManifest(sessionId?: string, cwd?: string, transcriptPath?: string): string {
  return buildManifestParts(sessionId, cwd, transcriptPath).text
}

/** Detect real, pre-compaction git dirty state for `cwd` -- `hasPendingDiff` mirrors the Python predecessor's `_get_git_diff_stat_summary()` signal (`git diff --stat HEAD` non-empty: tracked working-tree/staged changes vs HEAD), `hasUncommittedChanges` mirrors `_get_uncommitted_changes()` (`git status --porcelain` non-empty: also catches untracked files `diff --stat HEAD` misses). Both feed {@link computeAdaptiveBudget}'s git-derived bonuses via {@link adaptiveCharBonus}. Uses {@link runGit} (the only git spawn site in the codebase) with `hints.git_hint_max_ms` (same bound `hooks_session.ts`'s own git-hint calls use) so a slow/hung git can never block compaction; any spawn failure or non-zero exit fails soft to `false` for that signal. */
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

/** Extra manifest-char budget to add on top of the configured `compact_assist.max_manifest_chars` cap, driven by real git dirty state right before this compaction fires. Reuses `compact.ts`'s `computeAdaptiveBudget` -- ported from the Python predecessor's `build_manifest_adaptive` (see `eb119425`) but never wired to this, the real production PreCompact path, until now -- rather than reimplementing its bonus formula here. Calls it twice with identical cache/age/pressure inputs, toggling only the git-derived opts, and returns the *delta* between the two (in chars, at `estimateTokens`'s ~3 chars/token, floored at 0). Using the delta -- instead of using `computeAdaptiveBudget`'s absolute result as the cap outright -- guarantees the common case (a clean working tree: no pending diff, no uncommitted changes) adds exactly 0 and therefore reproduces today's fixed `max_manifest_chars` cap unchanged; a dirty tree only ever grows the cap, giving the compaction LLM more room for the "Pending Changes"-equivalent git context precisely when there is git state worth preserving, without ever shrinking below the configured default. No-op (returns 0) when `cwd` is unavailable (harness didn't send one) -- fails soft rather than guessing a working directory for the git spawns. */
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

/** Enforce `compact_assist.max_manifest_chars` (default 1600) on the sections by dropping whole rows through {@link fitSections}, so no row or fence is ever cut. The unbudgeted render is built first and returned as is when it fits, which keeps the git probe behind {@link adaptiveCharBonus} off the common path. A fit that dropped anything ends with the truncation notice, naming any section left out entirely. */
function fitManifest(sections: readonly FitSection[], sessionId?: string, cwd?: string, transcriptPath?: string): { text: string; shown: number[] } {
  const full = fitSections(sections, Infinity)
  const cap = loadConfig().compact_assist.max_manifest_chars
  if (cap <= 0 || full.text.length <= cap) return full
  const effectiveCap = cap + adaptiveCharBonus(sessionId, cwd, transcriptPath)
  if (full.text.length <= effectiveCap) return full
  const fit = fitSections(sections, effectiveCap)
  const gone = fit.omitted.length > 0 ? `; sections omitted: ${fit.omitted.map((h) => h.replace(/^#+\s*/, '')).join(', ')}` : ''
  const notice = `\n...(manifest truncated at ${effectiveCap} chars; ${full.text.length - fit.text.length} chars omitted${gone})`
  return { text: closeCutFence(fit.text) + notice, shown: fit.shown }
}

/** The project notes arrive fenced as data, and the cap can land inside the fence. Left open, the truncation notice and everything after the manifest would read as part of the fenced notes, so a cut fence is closed here; a close tag the cut split in half is dropped first so the fence ends on one whole tag. */
export function closeCutFence(kept: string): string {
  const open = `<${UNTRUSTED_FILE_TAG}>`
  const close = `\n</${UNTRUSTED_FILE_TAG}>`
  const lastOpen = kept.lastIndexOf(open)
  if (lastOpen === -1 || kept.includes(close, lastOpen)) return kept
  let body = kept
  for (let n = close.length - 1; n > 0; n--) {
    if (body.endsWith(close.slice(0, n))) { body = body.slice(0, -n); break }
  }
  return body + close
}

/** The project notes block as a fitter section: the lines up to and including the open fence tag are the header, the close tag and anything after it the footer, and each note is one row, so the fence is only ever emitted whole. A line that does not open a note belongs to the one before it. A block with no fence is header-only. */
function notesSection(notes: string): FitSection {
  const lines = notes.split('\n')
  const open = lines.indexOf(`<${UNTRUSTED_FILE_TAG}>`)
  const close = lines.lastIndexOf(`</${UNTRUSTED_FILE_TAG}>`)
  if (open === -1 || close < open) return { header: ['', ...lines], priority: 2 }
  const rows: string[] = []
  for (const line of lines.slice(open + 1, close)) {
    if (rows.length > 0 && !line.startsWith('- ')) rows[rows.length - 1] += '\n' + line
    else rows.push(line)
  }
  return { header: ['', ...lines.slice(0, open + 1)], rows, footer: lines.slice(close), priority: 2, maxRows: MAX_ROWS }
}

/** Whether the earlier read content of `f` in context is replaced by something later, which needs a whole-file read: two of them, a ranged read followed by one, or an edit after one. readCount also counts offset/limit slices, and disjoint slices (lines 1-300 then 301-600) replace nothing, so neither a run of slices nor an edit after slices alone qualifies; a file only edited, never read, has no read to supersede. */
function readIsSuperseded(f: FileEntry): boolean {
  // Only the reads and edits since the last compaction are in the context this manifest describes; an earlier copy was already dropped, so it supersedes nothing and is not superseded.
  const { reads, fullReads } = epochReadCounts(f)
  if (wasEditedSinceCompaction(f)) return fullReads > 0
  return fullReads > 1 || (reads > 1 && fullReads > 0 && f.lastFullReadAt !== undefined && f.lastFullReadAt >= f.lastReadAt)
}

/** Build the SAFE_TO_DISCARD manifest section: provably-inert prior context that compaction can drop without losing data, because it is recoverable through an existing recall command. Conservative by construction -- only three classes, each backed by an explicit session-state signal (never inferred): 1. Superseded identical-command bash reruns: a store call this session overwrote an already-cached entry under the exact same command key (see recordBashRerun in session.ts, wired from hooks_bash_post.ts's Item F delta-folding path). The raw transcript copy of the OLDER run is dead -- the surviving cached id already holds the freshest output. 2. File reads superseded by a later Edit/Write/Read of the same file, as decided by {@link readIsSuperseded}: a later whole-file read, or an edit after a whole-file read, means an earlier textual copy in the transcript no longer reflects the file's current content; ranged slices never qualify, since a later slice of other lines replaces none of them. 3. Every other bash output still tracked in the session's cache index -- each is recallable verbatim via bash-output <id>, so its inline transcript copy is redundant regardless of whether it was ever rerun. Reruns already itemized under (1) are excluded here to avoid double counting the same command under two headings. Always labels the section with an explicit item count and the recall command needed to get each item's data back -- never implies data is gone, only that the inline copy is a redundant duplicate of something recallable. */
function buildSafeToDiscardSection(files: FileEntry[]): FitSection[] {
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
    if (readIsSuperseded(f)) {
      const reason = wasEditedSinceCompaction(f) ? 'edited after being read' : ('re-read ' + epochReadCounts(f).reads + 'x')
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

  const title = '### SAFE_TO_DISCARD (' + total + ' items — provably inert; each is recallable, not gone)'
  const groups: [string, string[]][] = [
    ['Superseded reruns (' + rerunRows.length + '):', rerunRows],
    ['Superseded file reads (' + supersededReadRows.length + '):', supersededReadRows],
    ['Other cached bash outputs (' + cachedOutputRows.length + '):', cachedOutputRows],
  ]
  // The title rides on the first non-empty group's header, so it can never be emitted over nothing.
  const sections: FitSection[] = []
  for (const [header, rows] of groups) {
    if (rows.length === 0) continue
    sections.push({ header: sections.length === 0 ? ['', title, '', header] : ['', header], rows, priority: 9, reserved: true, maxRows: MAX_ROWS })
  }
  return sections
}
/** Fold `mem epoch` (token-goat-mem's monotonic counter, when the `mem` binary is on PATH) into the compaction manifest, so a resumed session can tell whether mem's fact store has advanced since this transcript was captured. FINDING (searched for at implementation time): this codebase has no existing tracking of a "current live TGMEM block" anywhere -- no `TGMEM` marker, no in-session summary of facts mem currently holds. `hooks_compact.ts`'s manifest tracks only file reads/edits/web fetches/bash-output caching (see {@link buildManifest}); nothing here shadows mem's own state. Per spec, that gap is reported rather than papered over with a fabricated block-tracking mechanism: this section folds in `mem epoch`'s bare integer alone, with an explicit note that no live TGMEM block is tracked in this session. Must fail open: `mem` may be absent from PATH, may error, or may hang. `mem` is resolved on PATH and launched through `spawnResolvedSync`, because an npm or cargo install leaves a `.cmd` shim on Windows that a bare `spawnSync('mem')` cannot start; the timeout bounds the wait to {@link MEM_EPOCH_TIMEOUT_MS} and any failure -- not on PATH, non-zero exit, timeout kill, unparsable stdout -- silently omits the section. No error is ever surfaced and compaction never blocks or fails because of this. */
function buildMemEpochSection(): FitSection[] {
  let result: ReturnType<typeof spawnResolvedSync>
  try {
    const resolved = resolveOnPath('mem')
    if (resolved === null) return []
    result = spawnResolvedSync(resolved, ['epoch'], {
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

  return [{
    header: ['', '### mem epoch', `mem epoch: ${stdout} (no live TGMEM block is tracked in this session -- only the epoch counter is folded in; see buildMemEpochSection's doc comment)`],
    priority: 9,
    reserved: true,
  }]
}

/** Framing in front of the manifest, addressed to whoever writes the compaction summary. Reaches the summarizer as raw `customInstructions`: `hook_registry.ts` lists `pre_compact` in EVENTS_WITH_RAW_STDOUT_CONTEXT, so this text is handed over unwrapped rather than rendered as a tool result. That is the only lever token-goat holds on the compaction channel. An earlier revision asked for preservation and deliberately not for brevity, reasoning that trading a summary's completeness for tokens was a bad trade to make on a user's behalf without being asked. The budget below exists because the user asked. It does not replace that reasoning: preservation stays the first instruction, the budget is a target rather than a cap, and {@link BUDGET_ESCALATION_MARKER} lets a session that genuinely cannot fit exceed it on the record instead of silently dropping state. */
export const MANIFEST_PREAMBLE =
  'When summarizing this session, keep the file paths and symbol names below exactly as written -- they are the handles the next turn needs to resume work. Do not paraphrase them into prose.'

/** Framing in front of the manifest when it arrives *after* the compaction rather than before it. {@link MANIFEST_PREAMBLE} instructs whoever writes the summary, which only works on a harness whose pre-compact hook feeds that writer. Where the event fires and the response is discarded -- see PRE_COMPACT_CONTEXT_DROPPED in harness_channels.ts -- the same text has to reach the model on the next tool call instead, by which point the summary is already written and nothing can be preserved that was not. So it stops being instructions and becomes recovery: here is what the session touched, in case the summary lost it. Addressing it to a summarizer that has already finished would ask for something impossible and read as a stale instruction. */
export const MANIFEST_RECOVERY_PREAMBLE =
  "The conversation was just compacted. Below is what this session touched, recovered from token-goat's own ledger rather than from the summary -- use it to re-establish paths and symbol names the summary may have dropped."

/** Opening token a summary uses to declare it exceeded its budget on purpose. One constant for both voices: {@link summaryBudgetDirective} asks for it and {@link postCompactHandler} counts it. Two literals would let the emitter drift from the detector, and that failure is silent -- every escalation would read as an ordinary overrun. */
export const BUDGET_ESCALATION_MARKER = 'TG-BUDGET-ESCALATION:'

/** The length target appended to {@link MANIFEST_PREAMBLE}, or an empty string when budgeting is off. Measured before it was chosen: 847 summaries over 7 days on the machine this was built on ran 24.56 MB in total, p50 26,240 characters, max 145,587. A 24,000 target binds 504 of those 847. The trim that implies is a ceiling on the mechanism's reach and never a prediction -- whether a summarizer honors a length request in `customInstructions` is exactly what the `budget=` and `over=` fields recorded by {@link postCompactHandler} exist to answer. */
export function summaryBudgetDirective(budgetChars: number): string {
  if (budgetChars <= 0) return ''
  return ` Aim for at most ${budgetChars} characters. Prefer a shorter summary that keeps every path, symbol, command and decision over a longer one that reproduces tool output verbatim: cite the recall id (\`token-goat bash-output <id> --full\`) rather than quoting the output again. If this session genuinely cannot be summarized within that target without losing state the next turn needs, exceed it and open the summary with a single line reading \`${BUDGET_ESCALATION_MARKER} <one-sentence reason>\`.`
}
