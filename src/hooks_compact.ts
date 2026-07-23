/**
 * pre_compact session-manifest hook.
 *
 * Ports the intent of `hooks_compact.py` / `build_manifest`: before Claude Code
 * compacts the conversation, inject a concise summary of what this session
 * touched (files read, files edited, web URLs fetched) so the compaction
 * preserves that context instead of dropping it. The manifest is intentionally
 * compact — aim well under 2000 chars — and is emitted as a `context` output.
 */

import { spawnSync } from 'node:child_process'

import { getSessionFiles, getSessionWebFetches, getSessionBashOutputs, getSessionBashReruns } from './session.js'
import type { FileEntry } from './session.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput, getCwd } from './hooks_common.js'
import { listSiblingSessionStates } from './session_store.js'
import { foldPath, toKB, runGit } from './util.js'
import type { HookOutput } from './types.js'
import { getBashOutput } from './bash_output_cache.js'
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
  // The map key is the url+'\x00'+prompt composite (see recordWebFetch in session.ts), so split it back apart for display instead of treating the whole key as the url.
  appendCappedSection(
    lines,
    '### Web URLs fetched',
    webFetches.map(([key, cacheId]) => {
      const sep = key.indexOf('\x00')
      const url = sep === -1 ? key : key.slice(0, sep)
      const prompt = sep === -1 ? '' : key.slice(sep + 1)
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
 * pre_compact handler: inject the session manifest as context.
 *
 * Returns `pass` (no-op) when `compact_assist.enabled` is off -- the config field is fully
 * wired through TOML parsing/validation/env-override (TOKEN_GOAT_COMPACT_ASSIST) and `config
 * export`, but nothing previously read it, so setting it false had zero effect on this hook.
 * Otherwise always returns a `context` output so the manifest reaches the compaction summary
 * even for an otherwise empty session (the counts confirm nothing was dropped).
 */
export function preCompactHandler(event: HookEvent): HookOutput {
  if (!loadConfig().compact_assist.enabled) return passOutput()
  return contextOutput(buildManifest(event.sessionId, getCwd(event)))
}

registerHook('pre_compact', preCompactHandler)
