/** Plain-text rendering of the summary session_audit.ts builds, for `token-goat session-audit`. The `--json` form prints that same summary without passing through here. */

import { displaySafeText } from './paths.js'
import { BASH_SMALL_RESULT_MAX_BYTES, type EstimatedCategory, type SessionAuditSummary } from './session_audit.js'

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`
}

/** Render the plain-text report. Aggregates only: no message content, paths, or project names. */
export function formatSessionAudit(s: SessionAuditSummary): string {
  const lines: string[] = []
  lines.push('# Session corpus audit')
  lines.push(`Corpus: ${displaySafeText(s.corpusDir)}`)
  lines.push(`Files: ${fmt(s.filesScanned)} scanned, ${fmt(s.filesFailed)} unreadable`)
  lines.push(`Lines: ${fmt(s.lines)} (${fmt(s.parseFailedLines)} unparseable), bytes: ${fmt(s.totalBytes)}`)
  lines.push(`Runtime: ${(s.runtimeMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('## Measured billed tokens (assistant message.usage, one count per API response)')
  const m = s.measured
  lines.push(`API calls: ${fmt(m.apiCalls)} (sidechain: ${fmt(s.measuredSidechain.apiCalls)})`)
  lines.push(`Output tokens:      ${fmt(m.outputTokens)}`)
  lines.push(`Input, uncached:    ${fmt(m.inputTokens)}`)
  lines.push(`Input, cache-write: ${fmt(m.cacheCreationTokens)}`)
  lines.push(`Input, cache-read:  ${fmt(m.cacheReadTokens)}`)
  const totalInput = m.inputTokens + m.cacheCreationTokens + m.cacheReadTokens
  lines.push(`Cache-read share of input: ${pct(m.cacheReadTokens, totalInput)}`)
  lines.push('')
  lines.push('## Estimated content attribution (chars/3 heuristic; NOT billed units)')
  const e = s.estimated
  const rows: [string, EstimatedCategory][] = [
    ['tool results', e.toolResults],
    ['assistant text', e.assistantText],
    ['assistant thinking', e.assistantThinking],
    ['tool call inputs', e.toolUseInputs],
    ['attachments (harness)', e.attachments],
    ['user turns', e.userTurns],
    ['meta user lines', e.harnessMeta],
    ['system lines', e.system],
    ['local bookkeeping (never sent)', e.otherLocal],
  ]
  const cal = s.calibration
  const modelVisibleBytes = cal.modelVisibleBytes
  for (const [label, cat] of rows.sort((a, b) => b[1].bytes - a[1].bytes)) {
    lines.push(`${label.padEnd(31)} count ${fmt(cat.count).padStart(11)}  bytes ${fmt(cat.bytes).padStart(15)}  est-tokens ${fmt(cat.estTokens).padStart(13)}  ${label === 'local bookkeeping (never sent)' ? '(excluded from share)' : pct(cat.bytes, modelVisibleBytes)}`)
  }
  lines.push('')
  lines.push('## Estimator calibration (the estimate above against the billed ledger above it)')
  lines.push(`Model-visible bytes:          ${fmt(cal.modelVisibleBytes).padStart(18)}`)
  lines.push(`Estimated tokens (chars/3):   ${fmt(cal.estimatedTokens).padStart(18)}`)
  lines.push(`Measured first-write tokens:  ${fmt(cal.measuredFirstWriteTokens).padStart(18)}  (input + cache-write; NEVER input alone -- a cached session bills nearly every first write as a cache write)`)
  lines.push(`Estimator error:              ${(cal.relativeError >= 0 ? '+' : '') + (cal.relativeError * 100).toFixed(1) + '%'} ${cal.relativeError >= 0 ? 'over' : 'under'} measured`)
  lines.push(`Implied bytes per token:      ${cal.bytesPerMeasuredToken.toFixed(2)}  (against the 3.0 the estimate divides by)`)
  lines.push('Read the error as a bound, not a correction factor. Two effects inflate the measured side and neither is separable here: a prefix whose cache entry expires is written again and billed twice while the estimate counts it once, and the system prompt and tool schemas are sent on every call but appear in the transcript only in part. Both push the measured figure up, so an estimate below it is expected and only the magnitude carries information.')
  lines.push('')
  lines.push('## Tool results by tool (estimated content size; calls = tool_use invocations)')
  for (const t of s.tools.slice(0, 25)) {
    // An MCP tool name is chosen by whichever server registered it, so it is third-party text.
    lines.push(`${displaySafeText(t.name).padEnd(42)} calls ${fmt(t.calls).padStart(9)}  bytes ${fmt(t.resultBytes).padStart(15)}  est-tokens ${fmt(t.resultEstTokens).padStart(12)}`)
  }
  if (s.tools.length > 25) lines.push(`(${s.tools.length - 25} smaller tools omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Attachment kinds by modeled billed cost (model-visible fields only; NOT billed units)')
  lines.push('Model: est-tokens x 1.25 cache-write + reread-tokens x 0.1 cache-read; an injection stays in context until the next compact boundary on its lane, or end of transcript.')
  for (const a of s.attachmentKinds.slice(0, 15)) {
    lines.push(`${a.kind.padEnd(28)} inj ${fmt(a.injections).padStart(9)}  visible-bytes ${fmt(a.visibleBytes).padStart(13)}  est-tok ${fmt(a.estTokens).padStart(12)}  reread-tok ${fmt(a.rereadTokens).padStart(14)}  billed-equiv ${fmt(a.billedEquivTokens).padStart(12)}  identical-reinject ${fmt(a.repeatedIdentical).padStart(8)}`)
  }
  if (s.attachmentKinds.length > 15) lines.push(`(${s.attachmentKinds.length - 15} smaller kinds omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Hook stdout channel (hook_success attachments; context-bytes is the model-visible share)')
  for (const h of s.hookOutputs) {
    lines.push(`${h.origin.padEnd(11)} ${h.event.padEnd(18)} fires ${fmt(h.fires).padStart(9)}  stdout-bytes ${fmt(h.stdoutBytes).padStart(13)}  context-bytes ${fmt(h.contextBytes).padStart(13)}`)
  }
  lines.push('')
  lines.push('## Measured billed tokens by session position (deciles of each session\'s API calls)')
  for (const d of s.positionDeciles) {
    lines.push(`decile ${d.decile.toString().padStart(2)}  calls ${fmt(d.apiCalls).padStart(9)}  input ${fmt(d.inputTokens).padStart(15)}  cache-read ${fmt(d.cacheReadTokens).padStart(15)}  output ${fmt(d.outputTokens).padStart(11)}`)
  }
  lines.push('')
  lines.push('## Subagent lanes (spawn-prefix carriage; same residency model as the attachment census; NOT billed units)')
  const sl = s.sidechainLanes
  lines.push(`Lane files: ${fmt(sl.laneFiles)} (${fmt(sl.lanesWithUsage)} with usage)`)
  lines.push(`First-call prefix tokens: mean ${fmt(sl.meanFirstCallPrefixTokens)}, median ${fmt(sl.medianFirstCallPrefixTokens)}, p90 ${fmt(sl.p90FirstCallPrefixTokens)}`)
  lines.push(`Calls per lane: mean ${fmt(sl.meanCallsPerLane)}; task-brief bytes: mean ${fmt(sl.meanBriefBytes)}`)
  lines.push(`Prefix billed-equiv tokens: ${fmt(sl.prefixBilledEquivTokens)} (write x 1.25, then x 0.1 per later call in the lane)`)
  for (const t of s.laneAgentTypes.slice(0, 12)) {
    lines.push(`  type ${t.agentType.padEnd(24)} lanes ${fmt(t.lanes).padStart(7)} (${fmt(t.lanesWithUsage)} with usage)  prefix mean ${fmt(t.meanFirstCallPrefixTokens).padStart(9)}, median ${fmt(t.medianFirstCallPrefixTokens).padStart(9)}`)
  }
  if (s.laneAgentTypes.length > 12) lines.push(`  (${s.laneAgentTypes.length - 12} smaller agent types omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Read interception (token-goat divert markers inside Read tool results)')
  const ri = s.readInterception
  lines.push(`Read results: ${fmt(ri.readResults)}; diverted by marker: ${fmt(ri.divertedByMarker)} (${fmt(ri.divertedBytes)} bytes); full serves >=10 KiB: ${fmt(ri.fullServesOver10k)} (${fmt(ri.fullServeBytesOver10k)} bytes)`)
  lines.push(`Full-serve split (same transcript file; a session's lanes are separate files, so repeats UNDER-count): first read ${fmt(ri.fullServesFirstRead)}, repeat ${fmt(ri.fullServesRepeat)} (${fmt(ri.repeatBytes)} bytes), path unknown ${fmt(ri.fullServesPathUnknown)}`)
  lines.push(`Repeats: with offset/limit ${fmt(ri.repeatWithRange)} (deliberate paging), whole-file ${fmt(ri.repeatFullNoRange)} (divert-miss candidates), in sessions with a token-goat hook fire ${fmt(ri.repeatInHookedSessions)} (whole-file among them: ${fmt(ri.repeatFullNoRangeInHookedSessions)}, of which post-compaction and so correct by design: ${fmt(ri.repeatFullNoRangeHookedAfterCompaction)})`)
  lines.push('')
  lines.push('## Deny outcomes (what actually happened after a token-goat Read deny; raw tokens, not billed units)')
  const eb = s.editErrorBaseline
  lines.push(`Edit-error baseline (all Edit tool_results, corpus-wide, independent of any deny): ${fmt(eb.totalErrors)}/${fmt(eb.totalEdits)} (${(eb.rate * 100).toFixed(1)}%) -- compare each row's edit-error<=10 ratio against this rate.`)
  for (const d of s.denyOutcomes) {
    const editErrorRatio = d.editWithin10Count > 0 ? `${fmt(d.editErrorWithin10Count)}/${fmt(d.editWithin10Count)}` : 'n/a'
    lines.push(`${d.kind.padEnd(34)} n ${fmt(d.count).padStart(6)}  compacted ${pct(d.compactedRate * d.count, d.count)}  retried ${pct(d.retriedRate * d.count, d.count)}  substituted ${pct(d.substitutedRate * d.count, d.count)}  shell-read ${pct(d.shellReadRate * d.count, d.count)}  unresolved ${pct(d.unresolvedRate * d.count, d.count)}  abandoned ${pct(d.abandonedRate * d.count, d.count)}  retried<=10 ${pct(d.retriedWithin10Rate * d.count, d.count)}  median-withheld ${d.medianWithheldBytes === null ? 'n/a' : fmt(d.medianWithheldBytes) + 'B'} (unknown ${pct(d.withheldBytesUnknownFraction * d.count, d.count)})  median-R ${fmt(d.medianR)}  shell-read-ambiguous ${fmt(d.shellReadAmbiguousCount)}  edit-error<=10 ${editErrorRatio}`)
  }
  if (s.denyOutcomes.length === 0) lines.push('(no denies matched a known template)')
  lines.push('')
  lines.push('## Bash filter fire-rate (token-goat in-band markers inside Bash tool results)')
  const bi = s.bashInterception
  lines.push(`Bash results: ${fmt(bi.bashResults)}; marked by a filter: ${fmt(bi.markedByFilter)} (${fmt(bi.markedBytes)} bytes); small unmarked <${fmt(BASH_SMALL_RESULT_MAX_BYTES)} B: ${fmt(bi.smallUntouched)} (${fmt(bi.smallUntouchedBytes)} bytes)`)
  lines.push(`Untouched >=${fmt(BASH_SMALL_RESULT_MAX_BYTES)} B: ${fmt(bi.untouched)} (${fmt(bi.untouchedBytes)} bytes, est-tokens ${fmt(bi.untouchedEstTokens)}, billed-equiv ${fmt(bi.untouchedBilledEquivTokens)})`)
  lines.push('A filter that matched but fell under the 100-byte net-savings floor leaves no transcript trace and counts as untouched here.')
  for (const h of bi.untouchedHeads.slice(0, 15)) {
    lines.push(`  ${h.head.padEnd(28)} results ${fmt(h.results).padStart(9)}  bytes ${fmt(h.bytes).padStart(15)}`)
  }
  if (bi.untouchedHeads.length > 15) lines.push(`  (${bi.untouchedHeads.length - 15} smaller command heads omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Mid-trim omission markers inside tool results')
  lines.push(`fires: ${fmt(s.omissionMarkers.fires)}, lines discarded: ${fmt(s.omissionMarkers.linesOmitted)}`)
  return lines.join('\n')
}
