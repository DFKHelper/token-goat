/** `token-goat doctor --probe <harness>`: start the harness headless on one real prompt with a probe nonce set, then read back which of token-goat's context hooks fired and whether what they said reached the model. The hook half is src/probe_marker.ts. Only harnesses whose headless mode has been run against this code are listed; each costs one prompt on the user's own account. */
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { BRIDGE_CAPABILITY_MATRIX } from './bridges_status.js'
import type { HarnessName } from './bridges/types.js'
import { displaySafeText } from './paths.js'
import { resolveOnPath, spawnResolvedSync } from './process_util.js'
import { PROBE_EVENT_TAGS, PROBE_NONCE_ENV, probeDir } from './probe_marker.js'
import { HOOK_PROBE_ENV } from './stats.js'
import type { HookEventName } from './types.js'

/** The prompt every probe sends. No quote, `%`, `!`, `^`, `&`, `|`, `<` or `>`, so it passes through cmd.exe unchanged when the harness is a `.cmd` shim. */
export const PROBE_PROMPT = 'Reply with every line of your context that begins with token-goat probe marker, copied exactly, one per line. If there are none, reply NONE.'

/** How each probeable harness runs one prompt headless. Each was run against the probe marker before it went here (claude 2.1.284, codex-cli 0.158.0, Copilot CLI 1.0.88). Copilot gets no `--allow-all-tools`: the prompt needs no tool, and a diagnostic has no business granting the model every tool in the user's project. */
export const PROBE_COMMANDS: Readonly<Partial<Record<HarnessName, { readonly bin: string; readonly args: readonly string[] }>>> = {
  claudecode: { bin: 'claude', args: ['-p', PROBE_PROMPT] },
  codex: { bin: 'codex', args: ['exec', PROBE_PROMPT] },
  copilot_cli: { bin: 'copilot', args: ['-p', PROBE_PROMPT] },
}

export function isProbeHarness(name: string): name is HarnessName {
  return Object.prototype.hasOwnProperty.call(PROBE_COMMANDS, name)
}

/** Variables that would make the hooks the child runs take themselves for a different harness than the one being probed. A probe started from inside Claude Code inherits its markers, and detectHarness() checks those ahead of codex's. */
const MISLEADING_ENV = ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CODEX_SESSION_ID', 'CODEX_SESSION']

const PROBE_TIMEOUT_MS = 240_000

export type ProbeEventResult = 'reached' | 'fired_not_delivered' | 'not_fired' | 'not_wired'
export type ProbeRunStatus = 'ok' | 'not_installed' | 'timeout' | 'failed'

export interface ProbeReport {
  readonly harness: HarnessName
  readonly command: string
  readonly status: ProbeRunStatus
  readonly exitCode: number | null
  readonly events: ReadonlyArray<{ readonly event: HookEventName; readonly result: ProbeEventResult }>
  /** The last lines of stderr, when the run did not finish cleanly. */
  readonly detail?: string
}

/** One event's verdict. The marker is matched as a substring rather than a line: Copilot CLI 1.0.88 was captured echoing `<nonce>-S` with a timestamp run straight onto it, and the nonce is random, so a substring cannot match by accident. */
export function classifyProbeEvent(opts: { wired: boolean; nonce: string; tag: string; stdout: string; receipts: ReadonlySet<string> }): ProbeEventResult {
  if (!opts.wired) return 'not_wired'
  if (opts.stdout.includes(`${opts.nonce}-${opts.tag}`)) return 'reached'
  return opts.receipts.has(opts.tag) ? 'fired_not_delivered' : 'not_fired'
}

/** The child's environment: the caller's, minus {@link MISLEADING_ENV} and a `TERM_PROGRAM` Claude Code set, plus the nonce and the flag that keeps the probe's own hook calls out of `stats`. */
export function probeEnv(nonce: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env }
  for (const key of MISLEADING_ENV) delete child[key]
  if (child['TERM_PROGRAM'] === 'claude-code') delete child['TERM_PROGRAM']
  child[PROBE_NONCE_ENV] = nonce
  child[HOOK_PROBE_ENV] = '1'
  return child
}

function receiptTags(nonce: string): Set<string> {
  const tags = new Set<string>()
  try {
    for (const name of readdirSync(probeDir())) {
      if (name.startsWith(`${nonce}.`)) tags.add(name.slice(nonce.length + 1))
    }
  } catch {
    // no probe directory: nothing fired
  }
  return tags
}

function removeReceipts(nonce: string): void {
  for (const tag of receiptTags(nonce)) rmSync(path.join(probeDir(), `${nonce}.${tag}`), { force: true })
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-5).join('\n')
}

/** Run the probe for `harness` in `cwd`. `resolve` is the PATH lookup, a parameter only so a test can name a stand-in harness; everything after it (the spawn, the hooks the child runs, the receipt directory) is the shipping path. */
export function runProbe(harness: HarnessName, opts: { cwd?: string; resolve?: (bin: string) => string | null; timeoutMs?: number } = {}): ProbeReport {
  const spec = PROBE_COMMANDS[harness]
  if (spec === undefined) throw new Error(`no headless probe for ${harness}; supported: ${Object.keys(PROBE_COMMANDS).join(', ')}`)
  const command = `${spec.bin} ${spec.args[0] ?? ''} "<probe prompt>"`
  const implemented = BRIDGE_CAPABILITY_MATRIX.find((r) => r.harness === harness)?.implemented ?? new Set<HookEventName>()
  const probed = Object.keys(PROBE_EVENT_TAGS) as HookEventName[]
  const resolved = (opts.resolve ?? resolveOnPath)(spec.bin)
  if (resolved === null) {
    return { harness, command, status: 'not_installed', exitCode: null, events: probed.map((event) => ({ event, result: implemented.has(event) ? 'not_fired' : 'not_wired' })) }
  }
  const nonce = randomBytes(10).toString('hex')
  try {
    const run = spawnResolvedSync(resolved, spec.args, { cwd: opts.cwd ?? process.cwd(), env: probeEnv(nonce), encoding: 'utf8', timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = run.stdout ?? ''
    const receipts = receiptTags(nonce)
    const events = probed.map((event) => ({ event, result: classifyProbeEvent({ wired: implemented.has(event), nonce, tag: PROBE_EVENT_TAGS[event] ?? '', stdout, receipts }) }))
    const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    const status: ProbeRunStatus = timedOut ? 'timeout' : run.status === 0 ? 'ok' : 'failed'
    const report: ProbeReport = { harness, command, status, exitCode: run.status, events }
    return status === 'ok' ? report : { ...report, detail: tail(run.stderr ?? run.error?.message ?? '') }
  } finally {
    removeReceipts(nonce)
  }
}

const RESULT_TEXT: Record<ProbeEventResult, string> = {
  reached: 'reached the model',
  fired_not_delivered: 'hook ran, but the model never saw its output',
  not_fired: 'hook did not run',
  not_wired: 'not wired for this harness',
}

/** True when every wired event reached the model and the run itself finished. */
export function probePassed(report: ProbeReport): boolean {
  return report.status === 'ok' && report.events.every((e) => e.result === 'reached' || e.result === 'not_wired')
}

export function formatProbeReport(report: ProbeReport): string {
  const lines = [`Probe: ${report.command} (one real prompt on your account)`]
  if (report.status === 'not_installed') lines.push(`  [FAIL] ${PROBE_COMMANDS[report.harness]?.bin ?? report.harness} is not on PATH`)
  else if (report.status === 'timeout') lines.push('  [FAIL] the harness did not finish in time')
  else if (report.status === 'failed') lines.push(`  [FAIL] the harness exited with code ${report.exitCode ?? 'unknown'}`)
  if (report.status !== 'not_installed') {
    for (const e of report.events) {
      const mark = e.result === 'reached' ? '[OK]  ' : e.result === 'not_wired' ? '[--]  ' : '[FAIL]'
      lines.push(`  ${mark} ${e.event.padEnd(19)} ${RESULT_TEXT[e.result]}`)
    }
  }
  // The harness's stderr: its text, not token-goat's, so it is escaped before it lands in a report that also reaches the model as an MCP tool result.
  if (report.detail !== undefined && report.detail !== '') lines.push(...displaySafeText(report.detail).split('\n').map((l) => `         ${l}`))
  return lines.join('\n')
}
