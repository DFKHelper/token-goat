/**
 * Session, corpus audit, memory, and output recall command handlers.
 *
 * Implements token-goat session-audit, session-outline, session-slice,
 * context-stats, bootstrap-audit, memory, waste, mcp-audit, recall,
 * statusline, and hint-stats.
 */

import * as fs from 'node:fs'

import { CliError, out, requireNonNegativeInt } from './cli.js'
import { displaySafeJson } from './paths.js'
import {
  auditSessionCorpus,
  formatSessionAudit,
} from './session_audit.js'
import {
  buildSessionOutline,
  formatSessionOutline,
  formatSessionSlice,
  parseTurnRange,
  resolveSessionTranscript,
  sliceSessionTurns,
} from './session_read.js'
import {
  recordStat,
  savedTokensFromBytes,
} from './stats.js'
import { cappedSourceBytesSaved } from './util.js'
import { runContextStats } from './cli_context_stats.js'
import { runBootstrapAudit } from './cli_bootstrap_audit.js'
import { runMemoryCommand } from './cli_memory.js'
import { runWasteCommand } from './cli_waste.js'
import { runAuditCommand } from './cli_audit.js'
import { runMcpAuditCommand } from './cli_mcp_audit.js'
import { runRecallCommand } from './cli_recall.js'
import { isRecallCacheType, type RecallCacheType } from './recall_index.js'
import { runStatuslineCommand } from './cli_statusline.js'
import { runHintStatsCommand } from './cli_hint_stats.js'
import { isHintCategory } from './hint_stats.js'

export function cmdContextStats(opts: { project?: string; json?: boolean; fix?: boolean; yes?: boolean } = {}): Promise<void> {
  return runContextStats(opts)
}

export function cmdBootstrapAudit(opts: {
  project?: string
  home?: string
  followLinks?: boolean
  json?: boolean
  top?: string
  warnTokens?: string
  failTokens?: string
  warnBytes?: string
  failBytes?: string
} = {}): Promise<void> {
  return runBootstrapAudit({
    ...(opts.project === undefined ? {} : { project: opts.project }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.followLinks === undefined ? {} : { followLinks: opts.followLinks }),
    ...(opts.json === undefined ? {} : { json: opts.json }),
    ...(opts.top === undefined ? {} : { top: Number(opts.top) }),
    ...(opts.warnTokens === undefined ? {} : { warnTokens: Number(opts.warnTokens) }),
    ...(opts.failTokens === undefined ? {} : { failTokens: Number(opts.failTokens) }),
    ...(opts.warnBytes === undefined ? {} : { warnBytes: Number(opts.warnBytes) }),
    ...(opts.failBytes === undefined ? {} : { failBytes: Number(opts.failBytes) }),
  })
}

export function cmdMemory(opts: { project?: string; analyze?: boolean; fix?: boolean; yes?: boolean } = {}): Promise<void> {
  return runMemoryCommand(opts)
}

export function cmdWaste(opts: { project?: string; transcript?: string; json?: boolean; top?: string; copilot?: boolean } = {}): Promise<void> {
  return runWasteCommand({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.transcript !== undefined ? { transcript: opts.transcript } : {}),
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
    ...(opts.copilot === true ? { copilot: true } : {}),
  })
}

export function cmdAudit(opts: { project?: string; transcript?: string; json?: boolean } = {}): Promise<void> {
  return runAuditCommand({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.transcript !== undefined ? { transcript: opts.transcript } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

export async function cmdSessionAudit(opts: { dir?: string; json?: boolean } = {}): Promise<void> {
  let summary
  try {
    summary = await auditSessionCorpus({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) })
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err))
  }
  out(opts.json === true ? displaySafeJson(summary, 0) : formatSessionAudit(summary))
}

export async function cmdSessionOutline(sessionIdOrPath: string | undefined, opts: { project?: string; json?: boolean } = {}): Promise<void> {
  const transcriptPath = resolveSessionTranscript(sessionIdOrPath, opts.project !== undefined ? { project: opts.project } : {})
  if (transcriptPath === null) {
    throw new CliError(
      sessionIdOrPath !== undefined
        ? `no session transcript found for '${sessionIdOrPath}'`
        : 'no session transcript found for the current project; pass a session id or path explicitly',
    )
  }
  const turns = await buildSessionOutline(transcriptPath)
  const text = opts.json === true ? displaySafeJson({ transcriptPath, turns }, 0) : `Transcript: ${transcriptPath}\n${formatSessionOutline(turns)}`
  out(text)
  const fullSourceBytes = sessionTranscriptSize(transcriptPath)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('session_outline', bytesSaved, savedTokensFromBytes(bytesSaved))
}

/** Best-effort on-disk size of a session transcript file; 0 if it can't be stat'd (never blocks stat recording). */
export function sessionTranscriptSize(transcriptPath: string): number {
  try {
    return fs.statSync(transcriptPath).size
  } catch {
    return 0
  }
}

export async function cmdSessionSlice(
  sessionIdOrPath: string | undefined,
  opts: { project?: string; range: string; json?: boolean },
): Promise<void> {
  const transcriptPath = resolveSessionTranscript(sessionIdOrPath, opts.project !== undefined ? { project: opts.project } : {})
  if (transcriptPath === null) {
    throw new CliError(
      sessionIdOrPath !== undefined
        ? `no session transcript found for '${sessionIdOrPath}'`
        : 'no session transcript found for the current project; pass a session id or path explicitly',
    )
  }
  const { start, end } = parseTurnRange(opts.range)
  const turns = await sliceSessionTurns(transcriptPath, start, end)
  const text = opts.json === true ? displaySafeJson({ transcriptPath, turns }, 0) : formatSessionSlice(turns)
  out(text)
  const fullSourceBytes = sessionTranscriptSize(transcriptPath)
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(text, 'utf8'))
  recordStat('session_slice', bytesSaved, savedTokensFromBytes(bytesSaved))
}

export function cmdMcpAudit(opts: { project?: string; json?: boolean } = {}): Promise<void> {
  return runMcpAuditCommand({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

export function cmdRecall(query: string | undefined, opts: { type?: string; limit?: string; json?: boolean } = {}): void {
  let type: RecallCacheType | undefined
  if (opts.type !== undefined) {
    if (!isRecallCacheType(opts.type)) {
      throw new CliError(`--type must be one of: bash, web, mcp (got: ${opts.type})`)
    }
    type = opts.type
  }
  runRecallCommand(query, {
    ...(type !== undefined ? { type } : {}),
    ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

export function cmdStatusline(opts: { json?: boolean } = {}): Promise<void> {
  return runStatuslineCommand({ ...(opts.json === true ? { json: true } : {}) })
}

export function cmdHintStats(opts: { json?: boolean; reset?: boolean; markEffective?: string; markIneffective?: string } = {}): void {
  if (opts.markEffective !== undefined && !isHintCategory(opts.markEffective)) {
    throw new CliError(`--mark-effective must be one of: bash_redirect, bash_recall, read_reread_dedup, read_structural_nav, edit_reread_suggest (got: ${opts.markEffective})`)
  }
  if (opts.markIneffective !== undefined && !isHintCategory(opts.markIneffective)) {
    throw new CliError(`--mark-ineffective must be one of: bash_redirect, bash_recall, read_reread_dedup, read_structural_nav, edit_reread_suggest (got: ${opts.markIneffective})`)
  }
  runHintStatsCommand({
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.reset === true ? { reset: true } : {}),
    ...(opts.markEffective !== undefined && isHintCategory(opts.markEffective) ? { markEffective: opts.markEffective } : {}),
    ...(opts.markIneffective !== undefined && isHintCategory(opts.markIneffective) ? { markIneffective: opts.markIneffective } : {}),
  })
}
