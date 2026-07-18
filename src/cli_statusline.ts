/**
 * CLI handler for `token-goat statusline`.
 *
 * Renders one line of terminal status text from the JSON session payload a
 * harness pipes on stdin, for use as a Claude Code `statusLine` command
 * (settings.json `statusLine.command`). The status line is re-rendered on a
 * short cadence and any failure here (crash, hang, non-zero exit that the
 * harness doesn't expect) degrades the user's entire terminal UI -- so this
 * command must never throw uncaught and must never block waiting on stdin
 * that never arrives.
 *
 * Payload shape: verified against Claude Code's own statusline docs
 * (https://code.claude.com/docs/en/statusline, "Full JSON schema" accordion,
 * fetched 2026-07-18). That page documents `cwd`, `workspace.current_dir`,
 * `model.{id,display_name}`, and `context_window.used_percentage` exactly as
 * used below, so those four are high-confidence. Everything else about the
 * payload (whether a given field is present on a given Claude Code version,
 * whether other harnesses that shell out to a "statusline" command send the
 * same shape at all) is unverified -- every field access here is
 * optional-chained with a safe fallback rather than assumed present, so a
 * schema drift or a non-Claude-Code caller degrades this line, it never
 * crashes it.
 */

import { readStdinJson } from './relay.js'
import { colorStdout, stripAnsi, fg, RESET, C } from './render/ansi.js'
import { dataDir } from './constants.js'
import { getDirtyPathsFor } from './worker.js'
import { summarize } from './stats.js'

/**
 * Stdin read timeout for statusline specifically. Claude Code refreshes the
 * status line at most every ~300ms, so this needs to resolve fast on the
 * "no payload arrives" path -- relay.ts's 5s default (tuned for a one-shot
 * hook dispatch) would make a statusline with no stdin visibly hang the UI
 * for up to 5 seconds on every refresh.
 */
const STDIN_TIMEOUT_MS = 1500

/** The subset of Claude Code's documented statusline payload this command reads.
 * All fields optional -- see module doc comment for confidence level per field. */
export interface StatuslinePayload {
  cwd?: string
  model?: { id?: string; display_name?: string }
  workspace?: { current_dir?: string; project_dir?: string }
  context_window?: { used_percentage?: number }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read and loosely validate the stdin payload. Never throws -- any failure
 * (no stdin, timeout, non-JSON, non-object JSON) yields `{}`. */
async function readPayload(): Promise<StatuslinePayload> {
  try {
    const raw = await readStdinJson(STDIN_TIMEOUT_MS)
    return isPlainObject(raw) ? (raw as StatuslinePayload) : {}
  } catch {
    return {}
  }
}

/** Format a token count compactly (1234 -> "1.2K", 1_500_000 -> "1.5M"), mirroring
 * fmtBytes's style in render/ansi.ts but for token counts rather than byte counts. */
function fmtTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return `${Math.trunc(n)}`
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Number of files queued for reindex (across the whole install, since the dirty
 * queue is not project-scoped -- see project_global_symbol_index memory note).
 * `null` when the queue can't be read (fresh install, permissions, etc). */
function indexPendingCount(): number | null {
  try {
    return getDirtyPathsFor(dataDir()).length
  } catch {
    return null
  }
}

/** Tokens saved by token-goat today. `null` when stats are unavailable (no DB yet,
 * read error) rather than 0, so callers can distinguish "no data" from "saved nothing". */
function tokensSavedToday(): number | null {
  try {
    return summarize(1).total_tokens_saved
  } catch {
    return null
  }
}

/** Fully-resolved data for one statusline render -- also the `--json` output shape. */
export interface StatuslineData {
  project: string
  model: string | null
  contextPct: number | null
  indexPending: number | null
  savedToday: number | null
}

/**
 * Derive display data from a (possibly empty/partial) statusline payload.
 * Never throws: an internal lookup failure (index queue, stats DB) degrades
 * that one field to `null` rather than aborting the whole line.
 */
export function buildStatuslineData(payload: StatuslinePayload): StatuslineData {
  const cwd = payload.workspace?.current_dir ?? payload.cwd ?? process.cwd()
  // Split on both separators rather than the host-platform `path.basename` --
  // the payload's current_dir reflects the OS Claude Code is running on, which
  // may differ from the OS this hook process is running on (e.g. a Linux CI
  // runner rendering a fixture captured on Windows).
  const project = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || cwd
  const model = typeof payload.model?.display_name === 'string' ? payload.model.display_name : null
  const contextPct =
    typeof payload.context_window?.used_percentage === 'number' ? payload.context_window.used_percentage : null
  return {
    project,
    model,
    contextPct,
    indexPending: indexPendingCount(),
    savedToday: tokensSavedToday(),
  }
}

/**
 * Render `data` as one ANSI-colored line of status text (no trailing newline,
 * no embedded newlines). Callers strip color via {@link stripAnsi} when the
 * destination isn't a color-capable stdout.
 */
export function renderStatusline(data: StatuslineData): string {
  const wrap = (text: string, rgb: readonly [number, number, number]): string => `${fg(rgb[0], rgb[1], rgb[2])}${text}${RESET}`

  const segments: string[] = [wrap(data.project, C.TEXT_BRIGHT)]
  if (data.model !== null) segments.push(wrap(data.model, C.BLUE))
  if (data.contextPct !== null) segments.push(wrap(`ctx ${Math.round(data.contextPct)}%`, C.TEAL))
  if (data.indexPending !== null) {
    segments.push(
      data.indexPending === 0 ? wrap('idx fresh', C.GREEN3) : wrap(`idx ${data.indexPending} pending`, C.ORANGE),
    )
  }
  if (data.savedToday !== null && data.savedToday > 0) {
    segments.push(wrap(`tg saved ${fmtTokens(data.savedToday)}`, C.GREEN4))
  }

  return segments.join(wrap(' | ', C.TEXT_DIM))
}

export interface StatuslineCommandOptions {
  json?: boolean
}

/**
 * Run `token-goat statusline`. Always writes exactly one line to stdout and
 * always exits cleanly -- there is no failure path that should propagate
 * past this function (see module doc comment).
 */
export async function runStatuslineCommand(opts: StatuslineCommandOptions = {}): Promise<void> {
  let data: StatuslineData
  try {
    const payload = await readPayload()
    data = buildStatuslineData(payload)
  } catch {
    // Absolute last-resort fallback: even buildStatuslineData's own try/catches
    // are bypassed by something (e.g. process.cwd() throwing) -- still must not throw.
    data = { project: 'token-goat', model: null, contextPct: null, indexPending: null, savedToday: null }
  }

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(data)}\n`)
    return
  }

  const line = renderStatusline(data)
  process.stdout.write(`${colorStdout() ? line : stripAnsi(line)}\n`)
}
