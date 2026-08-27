/**
 * pre_compact session-manifest hook.
 *
 * Ports the intent of `hooks_compact.py` / `build_manifest`: before Claude Code
 * compacts the conversation, inject a concise summary of what this session
 * touched (files read, files edited, web URLs fetched) so the compaction
 * preserves that context instead of dropping it. The manifest is intentionally
 * compact — aim well under 2000 chars — and is emitted as a `context` output.
 *
 * Also carries the `post_compact` counterpart, which measures what compaction
 * actually produced. See {@link postCompactHandler}.
 */

import { spawnSync } from 'node:child_process'

import { WEB_FETCH_KEY_SEP, getSessionFiles, getSessionWebFetches, getSessionBashOutputs, getSessionBashReruns, markCompacted } from './session.js'
import type { FileEntry } from './session.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput, getCwd } from './hooks_common.js'
import { listSiblingSessionStates } from './session_store.js'
import { foldPath, toKB, runGit } from './util.js'
import type { HookOutput } from './types.js'
import { getBashOutput } from './bash_output_cache.js'
import { recordStat } from './stats.js'
import { estimateTokensFromLength } from './overflow_guard.js'
import { loadConfig } from './config.js'
import { computeAdaptiveBudget, getContextPressure, loadSessionCache } from './compact.js'

/** Bound on how long we'll wait for `mem epoch` before giving up -- see {@link buildMemEpochSection}. */
const MEM_EPOCH_TIMEOUT_MS = 800

/** Cap on read/edit/web rows so a huge session can't blow the token budget. */
const MAX_ROWS = 40

/**
 * Appends a blank line, `header`, up to `cap` of `rows` verbatim, and an `- ...and N more`
 * overflow line when `rows` exceeds `cap`. No-op when `rows` is empty. Shared by every
 * capped-list section in {@link buildManifest} and {@link buildSafeToDiscardSection}.
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
  return `- ${entry.path} (${kb}kb, ${entry.readCount} ${plural}${edited})`
}

/** Render one surgically-read row: `path (symbols: a, b)`. The symbol list is what the preamble tells the summarizer to keep verbatim, so it is spelled out rather than counted. */
function renderSymbolReadRow(entry: FileEntry): string {
  return `- ${entry.path} (symbols: ${(entry.symbols_read ?? []).join(', ')})`
}

/**
 * Fold sibling subagent file entries into the parent's own file list, keyed
 * by {@link foldPath} (case-insensitive-filesystem-safe path identity, same
 * key session_store.ts's own merge logic uses). A file counts as edited if
 * ANY blob — parent or any subagent — marked it edited; readCount/lastReadAt
 * take the max across blobs and sizeBytes comes from whichever view is most
 * recent. This is a display-only merge for the compaction manifest, not the
 * persisted-state merge in session_store.ts (that one tracks per-process
 * read-count baselines that don't apply to blobs read cold off disk here).
 */
function mergeManifestFiles(parent: FileEntry[], siblingFiles: FileEntry[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>()
  for (const f of parent) byPath.set(foldPath(f.path), f)
  for (const f of siblingFiles) {
    const key = foldPath(f.path)
    const prev = byPath.get(key)
    if (prev === undefined) {
      byPath.set(key, f)
      continue
    }
    byPath.set(key, {
      path: prev.path,
      readCount: Math.max(prev.readCount, f.readCount),
      lastReadAt: Math.max(prev.lastReadAt, f.lastReadAt),
      wasEdited: prev.wasEdited || f.wasEdited,
      sizeBytes: f.lastReadAt >= prev.lastReadAt ? f.sizeBytes : prev.sizeBytes,
      ...(prev.wasTruncated || f.wasTruncated ? { wasTruncated: true } : {}),
    })
  }
  return Array.from(byPath.values())
}

/**
 * Build the session manifest string.
 *
 * Counts reads and edits, then lists read files, an edited-files section (only
 * when edits exist), and any fetched web URLs with their cache ids. Rows are
 * capped at {@link MAX_ROWS} per section with a truncation note.
 *
 * `sessionId`, when provided, is the *unsalted* parent session id (relay.ts
 * only salts `sessionStateKey` when `agentId` is set, which is never true on
 * the main thread that runs pre_compact). Every subagent spawned during this
 * session persisted its reads/edits into its own agent-salted blob (see
 * relay.ts's `sessionStateKey`), separate from the parent's plain-keyed blob
 * that {@link getSessionFiles} was just hydrated from — so without this,
 * a subagent's edits are invisible to the compaction manifest that is
 * supposed to preserve exactly that context across compaction. Sibling blobs
 * are read straight off disk and merged in; nothing is written back.
 *
 * `cwd`, when provided, is passed through to {@link capManifestChars} so its
 * {@link adaptiveCharBonus} can check real git dirty state for this project
 * before capping -- omitted (e.g. a harness that doesn't send `cwd` on
 * `pre_compact`), the cap falls back to the fixed configured value unchanged.
 */
export function buildManifest(sessionId?: string, cwd?: string): string {
  const ownFiles = [...getSessionFiles().values()]
  const siblingFiles = sessionId !== undefined ? listSiblingSessionStates(sessionId).flatMap((s) => s.files) : []
  const files = siblingFiles.length > 0 ? mergeManifestFiles(ownFiles, siblingFiles) : ownFiles
  const editedFiles = files.filter((f) => f.wasEdited)
  const readFiles = files.filter((f) => f.readCount > 0 && !f.wasEdited)
  // A file reached only through `token-goat read "file::symbol"` gets a readCount: 0, wasEdited: false entry carrying symbols_read (see recordSymbolRead in session.ts), so it falls through BOTH filters above and used to vanish from the manifest entirely -- while computeAdaptiveBudget was still granting it a symbolsBonus for content that was never emitted, and postCompactHandler's survival canary was sampling a path the manifest never printed. Give it its own bucket.
  const symbolOnlyFiles = files.filter((f) => f.readCount === 0 && !f.wasEdited && (f.symbols_read?.length ?? 0) > 0)
  const webFetches = [...getSessionWebFetches().entries()]

  const lines: string[] = []
  lines.push('## Session context')
  lines.push(`Files read: ${readFiles.length}`)
  lines.push(`Files edited: ${editedFiles.length}`)

  appendCappedSection(lines, '### Read files', readFiles.map(renderReadRow), MAX_ROWS)
  appendCappedSection(
    lines,
    '### Edited files',
    editedFiles.map((entry) => `- ${entry.path}`),
    MAX_ROWS,
  )
  appendCappedSection(lines, '### Surgically read files (symbol/section reads, never read whole)', symbolOnlyFiles.map(renderSymbolReadRow), MAX_ROWS)
  // The map key is the redactedUrl + redactedPrompt + digest composite (see webFetchKey in session.ts), so split it back apart for display instead of treating the whole key as the url. Taking only the first two fields drops the trailing digest, which exists for identity and means nothing to a reader.
  appendCappedSection(
    lines,
    '### Web URLs fetched',
    webFetches.map(([key, cacheId]) => {
      const [url = key, prompt = ''] = key.split(WEB_FETCH_KEY_SEP)
      const promptSuffix = prompt ? `, prompt: ${JSON.stringify(prompt)}` : ''
      return `- ${url} (cacheId: ${cacheId}${promptSuffix})`
    }),
    MAX_ROWS,
  )

  lines.push(...buildSafeToDiscardSection(files))
  lines.push(...buildMemEpochSection())

  return capManifestChars(lines.join('\n'), sessionId, cwd)
}

/**
 * Detect real, pre-compaction git dirty state for `cwd` -- `hasPendingDiff` mirrors the
 * Python predecessor's `_get_git_diff_stat_summary()` signal (`git diff --stat HEAD`
 * non-empty: tracked working-tree/staged changes vs HEAD), `hasUncommittedChanges` mirrors
 * `_get_uncommitted_changes()` (`git status --porcelain` non-empty: also catches untracked
 * files `diff --stat HEAD` misses). Both feed {@link computeAdaptiveBudget}'s git-derived
 * bonuses via {@link adaptiveCharBonus}. Uses {@link runGit} (the only git spawn site in the
 * codebase) with `hints.git_hint_max_ms` (same bound `hooks_session.ts`'s own git-hint calls
 * use) so a slow/hung git can never block compaction; any spawn failure or non-zero exit
 * fails soft to `false` for that signal.
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
 * Extra manifest-char budget to add on top of the configured
 * `compact_assist.max_manifest_chars` cap, driven by real git dirty state right before this
 * compaction fires.
 *
 * Reuses `compact.ts`'s `computeAdaptiveBudget` -- ported from the Python predecessor's
 * `build_manifest_adaptive` (see `eb119425`) but never wired to this, the real production
 * PreCompact path, until now -- rather than reimplementing its bonus formula here. Calls it
 * twice with identical cache/age/pressure inputs, toggling only the git-derived opts, and
 * returns the *delta* between the two (in chars, at `estimateTokens`'s ~3 chars/token, floored
 * at 0). Using the delta -- instead of using `computeAdaptiveBudget`'s absolute result as the
 * cap outright -- guarantees the common case (a clean working tree: no pending diff, no
 * uncommitted changes) adds exactly 0 and therefore reproduces today's fixed
 * `max_manifest_chars` cap unchanged; a dirty tree only ever grows the cap, giving the
 * compaction LLM more room for the "Pending Changes"-equivalent git context precisely when
 * there is git state worth preserving, without ever shrinking below the configured default.
 *
 * No-op (returns 0) when `cwd` is unavailable (harness didn't send one) -- fails soft rather
 * than guessing a working directory for the git spawns.
 */
function adaptiveCharBonus(sessionId: string | undefined, cwd: string | undefined): number {
  if (!cwd) return 0
  const cache = loadSessionCache(sessionId ?? '') ?? {}
  const ageSecs = cache.created_ts !== undefined ? Math.max(0, Date.now() / 1000 - cache.created_ts) : 0
  const contextPressure = getContextPressure(cache)
  const { hasPendingDiff, hasUncommittedChanges } = gitDirtySignals(cwd)
  if (!hasPendingDiff && !hasUncommittedChanges) return 0

  const baseline = computeAdaptiveBudget(cache, ageSecs, { contextPressure })
  const withGitSignal = computeAdaptiveBudget(cache, ageSecs, { hasPendingDiff, hasUncommittedChanges, contextPressure })
  const deltaTokens = Math.max(0, withGitSignal - baseline)
  return deltaTokens * 3
}

/**
 * Enforce `compact_assist.max_manifest_chars` (default 1600) on the fully-built manifest --
 * this module's own doc comment promises the manifest stays "well under 2000 chars", but
 * nothing previously bounded the actual string: MAX_ROWS only caps rows *per section*, not the
 * manifest's total length, so a session with many populated sections (reads, edits, web
 * fetches, SAFE_TO_DISCARD, mem epoch) could still produce an arbitrarily large manifest.
 * `max_manifest_chars <= 0` means "no cap" (mirrors max_section_lines's own 0-means-unlimited
 * convention), so a 0 value never truncates -- and never spends the git-spawn cost of
 * {@link adaptiveCharBonus} either, since there is no cap for it to adjust. Likewise, when the
 * manifest already fits under the base (non-adaptive) cap, there is nothing for the bonus to
 * widen room for, so the two `git diff`/`git status` spawns in {@link adaptiveCharBonus} are
 * skipped entirely rather than paid on every compaction regardless of whether truncation could
 * ever happen.
 */
function capManifestChars(manifest: string, sessionId?: string, cwd?: string): string {
  const cap = loadConfig().compact_assist.max_manifest_chars
  if (cap <= 0) return manifest
  if (manifest.length <= cap) return manifest
  const effectiveCap = cap + adaptiveCharBonus(sessionId, cwd)
  if (manifest.length <= effectiveCap) return manifest
  const omitted = manifest.length - effectiveCap
  return manifest.slice(0, effectiveCap) + `\n...(manifest truncated at ${effectiveCap} chars; ${omitted} chars omitted)`
}

/**
 * Build the SAFE_TO_DISCARD manifest section: provably-inert prior context that
 * compaction can drop without losing data, because it is recoverable through an
 * existing recall command. Conservative by construction -- only three classes,
 * each backed by an explicit session-state signal (never inferred):
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
 * Always labels the section with an explicit item count and the recall
 * command needed to get each item's data back -- never implies data is gone,
 * only that the inline copy is a redundant duplicate of something recallable.
 */
function buildSafeToDiscardSection(files: FileEntry[]): string[] {
  const rerunHashes = getSessionBashReruns()
  const bashOutputs = getSessionBashOutputs()
  const rerunHashSet = new Set(rerunHashes)

  const rerunRows: string[] = []
  for (const hash of rerunHashes) {
    const id = bashOutputs.find(([h]) => h === hash)?.[1]
    if (id === undefined) continue
    const entry = getBashOutput(id)
    if (entry === null) continue
    const flatCommand = entry.command.replace(/[\t\r\n]+/g, ' ')
    rerunRows.push('- `' + flatCommand + '` — an older run of this exact command was superseded; recall the surviving copy with `bash-output ' + id + '`')
  }

  const supersededReadRows: string[] = []
  for (const f of files) {
    if (f.readCount > 1 || f.wasEdited) {
      const reason = f.wasEdited ? 'edited after being read' : ('re-read ' + f.readCount + 'x')
      supersededReadRows.push('- ' + f.path + ' (' + reason + ' — only the latest content already in context is current)')
    }
  }

  const cachedOutputRows: string[] = []
  for (const [hash, id] of bashOutputs) {
    if (rerunHashSet.has(hash)) continue
    const entry = getBashOutput(id)
    if (entry === null) continue
    const flatCommand = entry.command.replace(/[\t\r\n]+/g, ' ')
    cachedOutputRows.push('- `' + flatCommand + '` — recallable via `bash-output ' + id + '`')
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
 * Fold `mem epoch` (token-goat-mem's monotonic counter, when the `mem` binary is on PATH) into
 * the compaction manifest, so a resumed session can tell whether mem's fact store has advanced
 * since this transcript was captured.
 *
 * FINDING (searched for at implementation time): this codebase has no existing tracking of a
 * "current live TGMEM block" anywhere -- no `TGMEM` marker, no in-session summary of facts mem
 * currently holds. `hooks_compact.ts`'s manifest tracks only file reads/edits/web
 * fetches/bash-output caching (see {@link buildManifest}); nothing here shadows mem's own state.
 * Per spec, that gap is reported rather than papered over with a fabricated block-tracking
 * mechanism: this section folds in `mem epoch`'s bare integer alone, with an explicit note that
 * no live TGMEM block is tracked in this session.
 *
 * Must fail open: `mem` may be absent from PATH, may error, or may hang. `spawnSync` bounds the
 * wait to {@link MEM_EPOCH_TIMEOUT_MS} (same spawnSync-with-timeout pattern as
 * checkCopilotCli in cli_doctor.ts) and any failure -- ENOENT, non-zero exit, timeout kill,
 * unparsable stdout -- silently omits the section. No error is ever surfaced and compaction
 * never blocks or fails because of this.
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
 * pre_compact handler: hand the session manifest to the model that writes the compaction summary.
 *
 * On Claude Code this hook's stdout reaches that model as `customInstructions`, so the manifest is
 * addressed to a reader rather than filed as an attachment -- see EVENTS_WITH_RAW_STDOUT_CONTEXT in
 * hook_registry.ts for how that was established and why it is scoped to one harness. {@link
 * MANIFEST_PREAMBLE} is what turns a block of facts into something a summariser can act on.
 *
 * Returns `pass` (no-op) when `compact_assist.enabled` is off -- the config field is fully
 * wired through TOML parsing/validation/env-override (TOKEN_GOAT_COMPACT_ASSIST) and `config
 * export`, but nothing previously read it, so setting it false had zero effect on this hook.
 * Otherwise always returns a `context` output so the manifest reaches the compaction summary
 * even for an otherwise empty session (the counts confirm nothing was dropped).
 */
/**
 * One line of framing in front of the manifest, addressed to whoever writes the compaction summary.
 *
 * Deliberately asks for preservation and not for brevity. A shorter summary is the larger prize --
 * summaries measured on this machine average about 21 KB each -- but the summary is the only thing
 * the next turn has, and trading its completeness for tokens is a bad trade to make on a user's
 * behalf without being asked. Naming the paths as the things to keep verbatim is the part that is
 * safe: it costs nothing and it protects exactly the handles a surgical read needs afterwards.
 */
const MANIFEST_PREAMBLE =
  'When summarizing this session, keep the file paths and symbol names below exactly as written -- they are the handles the next turn needs to resume work. Do not paraphrase them into prose.'

export function preCompactHandler(event: HookEvent): HookOutput {
  // Order is load-bearing: buildManifest reads getSessionFiles(), and markCompacted stamps the epoch that makes every one of those reads count as no-longer-in-context. Stamping first would not corrupt the manifest today (it reads readCount/wasEdited directly rather than going through wasFileReadThisSession), but the dependency is real -- any future manifest input that asks "is this still in context" would silently render empty. Build first, stamp second.
  // The stamp is NOT gated on compact_assist.enabled: compaction happens whether or not we inject a manifest, so the read ledger must be invalidated either way. Gating it would leave hooks_read.ts serving diffs and "unchanged" denials against content the model can no longer see, for every user who turned the manifest off.
  const out = loadConfig().compact_assist.enabled
    ? contextOutput(`${MANIFEST_PREAMBLE}\n\n${buildManifest(event.sessionId, getCwd(event))}`)
    : passOutput()
  markCompacted()
  return out
}

registerHook('pre_compact', preCompactHandler)

/**
 * Distinct path-shaped tokens to sample from the manifest when checking whether it survived
 * compaction. Small on purpose: the check is a canary, not a census, and each candidate costs
 * one substring scan over a summary that averages roughly 21 KB.
 */
const MANIFEST_SURVIVAL_SAMPLE = 12

/**
 * Paths this session touched, in the same order and from the same source {@link buildManifest}
 * draws them from, capped to {@link MANIFEST_SURVIVAL_SAMPLE}.
 *
 * Deliberately re-derived from session state rather than stashed at pre_compact time. Nothing
 * mutates the file ledger between the two events -- no tool call can run while the harness is
 * compacting -- so the list is the same one the manifest was built from, and re-deriving it
 * avoids adding a field that would need all six of the session-state touch points (interface,
 * serialize, deserialize, reset, coerce, merge) to carry a value that is only ever read
 * milliseconds after it is written.
 *
 * The one imprecision is in the safe direction: `capManifestChars` may have cut the tail off the
 * emitted manifest, so a path here might never have been sent. That can only make survival look
 * worse than it was, never better, which is the bias a canary wants -- it cannot falsely report
 * that the channel is alive.
 */
function manifestPathSample(sessionId?: string): string[] {
  const ownFiles = [...getSessionFiles().values()]
  const siblingFiles = sessionId !== undefined ? listSiblingSessionStates(sessionId).flatMap((s) => s.files) : []
  const files = siblingFiles.length > 0 ? mergeManifestFiles(ownFiles, siblingFiles) : ownFiles
  const seen = new Set<string>()
  for (const entry of files) {
    // entry.path verbatim, because that is exactly what both manifest sections print -- renderReadRow and the edited-files rows each interpolate entry.path with no transformation. Folding here instead would compare a lowercased needle against the manifest's real spelling and match nothing on Windows, reporting every compaction as a dead channel. Case tolerance belongs at the comparison, where both sides get folded together.
    if (entry.path) seen.add(entry.path)
    if (seen.size >= MANIFEST_SURVIVAL_SAMPLE) break
  }
  return [...seen]
}

/**
 * post_compact handler: measure the summary compaction produced, and check whether the manifest
 * we sent into it survived.
 *
 * Two things make this worth wiring even though it changes nothing the model sees.
 *
 * The measurement: compaction summaries are the single largest thing token-goat could not see.
 * Every other number in `stats` came from a tool call token-goat intercepted, and a summary
 * arrives through none. Across 22 sessions on one machine they totalled roughly 27.5 MB, and
 * until now nothing counted a byte of it. Claude Code hands the finished summary to a PostCompact
 * hook verbatim, so counting it costs one `length` read of a string already in memory.
 *
 * The canary: {@link preCompactHandler}'s manifest reaches the summarizing model through an
 * undocumented channel -- Claude Code feeds a PreCompact hook's raw stdout in as the summarizer's
 * customInstructions, which its own hooks reference describes as going to a debug log. That can
 * stop working on any release, and it would stop silently: the hook would keep succeeding, the
 * manifest would keep being built, and nothing would fail. So this counts how many of the paths
 * the manifest named actually appear in the summary. A run of compactions where none survive is
 * the signal that the channel died.
 *
 * Recorded at zero bytes and zero tokens, always. Nothing here saves anything -- the summary was
 * written whether or not token-goat was watching -- and crediting a measurement as a saving is
 * the exact accounting mistake this project keeps having to undo.
 *
 * Returns `pass`. A PostCompact hook's stdout is not context: Claude Code's runner returns only
 * `userDisplayMessage`, a line echoed to the user's terminal, so anything printed here would be
 * noise in front of a person rather than help for a model.
 */
export function postCompactHandler(event: HookEvent): HookOutput {
  const raw = event.raw['compact_summary']
  const summary = typeof raw === 'string' ? raw : ''
  const bytes = Buffer.byteLength(summary, 'utf-8')
  const sample = manifestPathSample(event.sessionId)
  // Fold both sides on a case-insensitive filesystem so a summary that reproduces a path with different capitalization still counts as a survivor. Folding the needle alone was the first version of this and it matched nothing on Windows, which would have made the canary read "channel dead" on every compaction.
  const haystack = foldPath(summary)
  const survived = sample.filter((p) => haystack.includes(foldPath(p))).length
  const trigger = typeof event.raw['trigger'] === 'string' ? event.raw['trigger'] : 'unknown'
  recordStat(
    'compact_summary',
    0,
    0,
    undefined,
    `trigger=${trigger} bytes=${bytes} est_tokens=${estimateTokensFromLength(summary.length)} manifest_paths=${survived}/${sample.length}`,
  )
  return passOutput()
}

registerHook('post_compact', postCompactHandler)
