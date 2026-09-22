/**
 * The compaction hooks: emit the session manifest before a compaction, measure what came out of it after.
 *
 * The manifest itself is built in manifest.ts, which `compact-hint` shares. This module owns only the two events and the choice of channel each one has available — see {@link preCompactHandler} for why that choice is not the same on every harness, and {@link postCompactHandler} for the measurement.
 */

import * as path from 'node:path'

import { markCompacted } from './session.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput, getCwd, getTranscriptPath } from './hooks_common.js'
import { foldPath } from './util.js'
import type { HookOutput } from './types.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { loadConfig } from './config.js'
import { normalizePath } from './paths.js'
import { BUDGET_ESCALATION_MARKER, MANIFEST_PREAMBLE, MANIFEST_RECOVERY_PREAMBLE, buildManifest, manifestPrintedPaths, summaryBudgetDirective } from './manifest.js'
import { dropsPreCompactContext } from './harness_channels.js'
import { MAX_PENDING_CONTEXT_BYTES, queuePendingContext } from './pending_context.js'

/**
 * pre_compact handler: hand the session manifest to the model that writes the compaction summary.
 *
 * On Claude Code this hook's stdout reaches that model as `customInstructions`, so the manifest is addressed to a reader rather than filed as an attachment -- see EVENTS_WITH_RAW_STDOUT_CONTEXT in hook_registry.ts for how that was established and why it is scoped to one harness. {@link MANIFEST_PREAMBLE} is what turns a block of facts into something a summarizer can act on.
 *
 * Returns `pass` (no-op) when `compact_assist.enabled` is off -- the config field is fully wired through TOML parsing/validation/env-override (TOKEN_GOAT_COMPACT_ASSIST) and `config export`, but nothing previously read it, so setting it false had zero effect on this hook. Otherwise always returns a `context` output so the manifest reaches the compaction summary even for an otherwise empty session (the counts confirm nothing was dropped).
 *
 * On a harness in PRE_COMPACT_CONTEXT_DROPPED the `context` output goes nowhere, so the manifest is queued for the next tool call instead of returned. That is a strictly weaker delivery — it lands after the summary is written, so it recovers state rather than preserving it — and it is the best that channel allows. Building it either way is deliberate: the event is a usable trigger on every harness even where the response is not a usable channel.
 */
export function preCompactHandler(event: HookEvent): HookOutput {
  // Order is load-bearing: buildManifest reads getSessionFiles(), and markCompacted stamps the epoch that makes every one of those reads count as no-longer-in-context. Stamping first would not corrupt the manifest today (it reads readCount/wasEdited directly rather than going through wasFileReadThisSession), but the dependency is real -- any future manifest input that asks "is this still in context" would silently render empty. Build first, stamp second. The stamp is NOT gated on compact_assist.enabled: compaction happens whether or not we inject a manifest, so the read ledger must be invalidated either way. Gating it would leave hooks_read.ts serving diffs and "unchanged" denials against content the model can no longer see, for every user who turned the manifest off.
  const cfg = loadConfig().compact_assist
  let out: HookOutput = passOutput()
  if (cfg.enabled) {
    const manifest = buildManifest(event.sessionId, getCwd(event), getTranscriptPath(event))
    if (!dropsPreCompactContext()) {
      out = contextOutput(`${MANIFEST_PREAMBLE}${summaryBudgetDirective(cfg.summary_budget_chars)}\n\n${manifest}`)
    } else if (event.sessionId) {
      // Trimmed here rather than left to the queue's own cap, which keeps the tail: the adaptive char bonus can push a manifest past MAX_PENDING_CONTEXT_BYTES, and a tail-keeping trim would drop the preamble saying what the block is while keeping the least important rows.
      queuePendingContext(event.sessionId, `${MANIFEST_RECOVERY_PREAMBLE}\n\n${manifest.slice(0, MAX_PENDING_CONTEXT_BYTES - MANIFEST_RECOVERY_PREAMBLE.length - 2)}`)
    }
  }
  markCompacted()
  return out
}

registerHook('pre_compact', preCompactHandler)

/**
 * Distinct path-shaped tokens to sample from the manifest when checking whether it survived compaction.
 *
 * Was 12, which is too narrow to answer the question a summary budget raises. Twelve paths taken from the head of an insertion-ordered map sample the session's *earliest* files, so the ratio can read healthy while later state evaporates, and on a session that compacts hundreds of times that loss compounds invisibly. 64 covers a typical session's whole touched set; the cost is 64 substring scans over a ~26 KB summary, once per compaction.
 */
const MANIFEST_SURVIVAL_SAMPLE = 64

/**
 * Paths this session touched, exactly the ones {@link buildManifest} prints, capped to {@link MANIFEST_SURVIVAL_SAMPLE}.
 *
 * Deliberately re-derived from session state rather than stashed at pre_compact time. Nothing mutates the file ledger between the two events -- no tool call can run while the harness is compacting -- so the list is the same one the manifest was built from, and re-deriving it avoids adding a field that would need all six of the session-state touch points (interface, serialize, deserialize, reset, coerce, merge) to carry a value that is only ever read milliseconds after it is written.
 *
 * The one imprecision is in the safe direction: `capManifestChars` may have cut the tail off the emitted manifest, so a path here might never have been sent. That can only make survival look worse than it was, never better, which is the bias a canary wants -- it cannot falsely report that the channel is alive.
 */
function manifestPathSample(sessionId?: string): string[] {
  return manifestPrintedPaths(sessionId, MANIFEST_SURVIVAL_SAMPLE)
}

/**
 * post_compact handler: measure the summary compaction produced, and check whether the manifest we sent into it survived.
 *
 * Two things make this worth wiring even though it changes nothing the model sees.
 *
 * The measurement: compaction summaries are the single largest thing token-goat could not see. Every other number in `stats` came from a tool call token-goat intercepted, and a summary arrives through none. Across 22 sessions on one machine they totalled roughly 27.5 MB, and until now nothing counted a byte of it. Claude Code hands the finished summary to a PostCompact hook verbatim, so counting it costs one `length` read of a string already in memory.
 *
 * The canary: {@link preCompactHandler}'s manifest reaches the summarizing model through an undocumented channel -- Claude Code feeds a PreCompact hook's raw stdout in as the summarizer's customInstructions, which its own hooks reference describes as going to a debug log. That can stop working on any release, and it would stop silently: the hook would keep succeeding, the manifest would keep being built, and nothing would fail. So this counts how many of the paths the manifest named actually appear in the summary. A run of compactions where none survive is the signal that the channel died.
 *
 * Recorded at zero bytes and zero tokens, always. Nothing here saves anything -- the summary was written whether or not token-goat was watching -- and crediting a measurement as a saving is the exact accounting mistake this project keeps having to undo.
 *
 * Returns `pass`. A PostCompact hook's stdout is not context: Claude Code's runner returns only `userDisplayMessage`, a line echoed to the user's terminal, so anything printed here would be noise in front of a person rather than help for a model.
 */
export function postCompactHandler(event: HookEvent): HookOutput {
  const raw = event.raw['compact_summary']
  const summary = typeof raw === 'string' ? raw : ''
  const bytes = Buffer.byteLength(summary, 'utf-8')
  const sample = manifestPathSample(event.sessionId)
  // Fold both sides on a case-insensitive filesystem so a summary that reproduces a path with different capitalization still counts as a survivor. Folding the needle alone was the first version of this and it matched nothing on Windows, which would have made the canary read "channel dead" on every compaction. The summarizer rewrites the manifest's absolute paths relative to the project root (322 recorded summaries named `src/...` files and none by absolute path), so a path also survives as its cwd-relative spelling; matching the absolute form alone read 0/64 on every compaction and made doctor report a live channel as dead. Separators are unified on both sides because the summary writes `/` whatever the platform, and cwd goes through normalizePath like the stored paths did, or a macOS `/var` or Windows 8.3 short-name cwd would relativize every path to `../`.
  const cwd = normalizePath(getCwd(event) ?? process.cwd())
  const spell = (p: string): string => foldPath(p.replaceAll('\\', '/'))
  const haystack = spell(summary)
  const survived = sample.filter((p) => {
    const rel = path.relative(cwd, p)
    const forms = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? [p, rel] : [p]
    return forms.some((f) => haystack.includes(spell(f)))
  }).length
  const trigger = typeof event.raw['trigger'] === 'string' ? event.raw['trigger'] : 'unknown'
  const budget = loadConfig().compact_assist.summary_budget_chars
  // Characters against characters: the directive asks for a character count, so a summary carrying non-ASCII would overrun a byte comparison it never actually broke. `bytes` stays byte-length because the token estimate is derived from it.
  const over = budget > 0 && summary.length > budget ? 1 : 0
  const escalated = summary.includes(BUDGET_ESCALATION_MARKER) ? 1 : 0
  recordStat(
    'compact_summary',
    0,
    0,
    undefined,
    `trigger=${trigger} bytes=${bytes} est_tokens=${savedTokensFromBytes(bytes)} manifest_paths=${survived}/${sample.length} budget=${budget} over=${over} escalated=${escalated}`,
  )
  return passOutput()
}

registerHook('post_compact', postCompactHandler)
