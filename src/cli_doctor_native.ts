/** `doctor`'s native hook client rows: per harness and scope, which form of hook command is wired (the native client in front of the Node command, or the Node command alone), whether the wired binary exists and passes its self-test, whether it is the form this build would write, and how the last week's hook calls were answered. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { wiredCodexHookWords } from './bridges/codex_install.js'
import { wiredCopilotHookWords } from './bridges/copilot_cli_install.js'
import { wiredGrokHookWords } from './bridges/grok_install.js'
import { wiredKimiHookWords } from './bridges/kimi_install.js'
import { nativeHooksEnabled } from './config.js'
import { getDb } from './db.js'
import type { DoctorResult } from './doctor_result.js'
import { nativeHookCounts, type NativeHookCounts } from './hook_latency.js'
import { wiredClaudeHookWords } from './install.js'
import { nativeCopyCurrent, nativeCopyPath, nativeHookBinary, nativeSelftest, packagedNativeBinary, parseNativeInvocation, type NativeSelftest, type WiredHookEntry } from './native_hook.js'
import { displaySafeText } from './paths.js'
import { HOOK_STATS_RETENTION_DAYS } from './stats.js'

/** One harness scope's wiring, as its installer reads it back. */
export interface NativeWiring {
  /** The row's label, e.g. `Claude Code (user)`. */
  readonly label: string
  /** The command that rewrites this scope's entries. */
  readonly install: string
  /** The `stats.harness` values this scope's hook calls are recorded under. */
  readonly harnesses: readonly string[]
  /** Each token-goat hook entry wired there. */
  readonly entries: readonly WiredHookEntry[]
}

/** What this build would wire, decided without writing anything. */
export interface NativeAvailability {
  /** hooks.native and TOKEN_GOAT_NATIVE_HOOKS allow the native client. */
  readonly enabled: boolean
  /** `<platform>-<arch>` of this machine, for the message when no binary ships for it. */
  readonly target: string
  /** The binary shipped beside the running bundle, if any. */
  readonly packaged: string | undefined
  /** The binary an install would wire now (the Windows copy, or the packaged binary elsewhere), or undefined when it would write the Node form. */
  readonly expected: string | undefined
  /** Windows only: the copy an install runs is missing or differs from the packaged binary. */
  readonly copyStale: boolean
  /** The packaged binary's self-test, when an install would have to run it to decide. */
  readonly selftest?: NativeSelftest
}

/** What this build would wire right now, for the running bundle. */
export function nativeAvailability(entry: string | undefined = process.argv[1]): NativeAvailability {
  const enabled = nativeHooksEnabled()
  const target = `${process.platform}-${process.arch}`
  const packaged = packagedNativeBinary(entry)
  const copyStale = process.platform === 'win32' && packaged !== undefined && entry !== undefined && !nativeCopyCurrent(packaged, nativeCopyPath(entry))
  const expected = nativeHookBinary(entry, { sync: false })
  // A current copy (or a Linux binary) that still yields no decision failed its self-test, and that failure is the reason an install writes the Node form.
  const selftest = enabled && packaged !== undefined && !copyStale && expected === undefined ? nativeSelftest(process.platform === 'win32' && entry !== undefined ? nativeCopyPath(entry) : packaged) : undefined
  return { enabled, target, packaged, expected, copyStale, ...(selftest === undefined ? {} : { selftest }) }
}

/** Every harness scope an installer can wire the native client into, read back from its config. */
export function nativeWirings(): NativeWiring[] {
  return [
    { label: 'Claude Code (user)', install: 'token-goat install', harnesses: ['claudecode'], entries: wiredClaudeHookWords('user').map((words) => ({ words })) },
    { label: 'Claude Code (project)', install: 'token-goat install --project', harnesses: ['claudecode'], entries: wiredClaudeHookWords('project').map((words) => ({ words })) },
    { label: 'Codex', install: 'token-goat install --codex', harnesses: ['codex'], entries: wiredCodexHookWords() },
    { label: 'Grok CLI', install: 'token-goat install --grok', harnesses: ['grok'], entries: wiredGrokHookWords() },
    { label: 'Kimi Code', install: 'token-goat install --kimi', harnesses: ['kimi'], entries: wiredKimiHookWords() },
    { label: 'Copilot CLI (user)', install: 'token-goat install --copilot', harnesses: ['copilot_cli', 'vscode'], entries: wiredCopilotHookWords() },
    { label: 'Copilot CLI (project)', install: 'token-goat install --copilot --local', harnesses: ['copilot_cli', 'vscode'], entries: wiredCopilotHookWords({ local: true }) },
  ]
}

function samePath(a: string, b: string): boolean {
  const fold = (p: string): string => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return fold(a) === fold(b)
}

/** `last 7 days: 40 served natively, 2 fell back (absent 2), 9 through Node`, summed over `harnesses`. */
export function formatNativeCounts(counts: ReadonlyMap<string, NativeHookCounts>, harnesses: readonly string[]): string {
  let native = 0
  let node = 0
  const fallback = new Map<string, number>()
  for (const h of harnesses) {
    const c = counts.get(h)
    if (c === undefined) continue
    native += c.native
    node += c.node
    for (const [reason, n] of Object.entries(c.fallback)) fallback.set(reason, (fallback.get(reason) ?? 0) + n)
  }
  const fellBack = [...fallback.values()].reduce((a, b) => a + b, 0)
  const window = `last ${HOOK_STATS_RETENTION_DAYS} days`
  if (native + fellBack + node === 0) return `${window}: no hook calls recorded`
  const reasons = [...fallback.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')
  return `${window}: ${native} served natively, ${fellBack} fell back${fellBack > 0 ? ` (${reasons})` : ''}, ${node} through Node`
}

/** The row for one harness scope, or null when nothing of token-goat's is wired there. */
export function checkNativeHookWiring(wiring: NativeWiring, avail: NativeAvailability, counts: ReadonlyMap<string, NativeHookCounts>, selftest: (bin: string) => NativeSelftest = nativeSelftest): DoctorResult | null {
  if (wiring.entries.length === 0) return null
  const name = `Native hooks (${wiring.label})`
  const total = wiring.entries.length
  const bins = wiring.entries.map((e) => parseNativeInvocation(e.words)?.bin).filter((b): b is string => b !== undefined)
  const nativeCount = bins.length
  const form = nativeCount === total ? 'native' : nativeCount === 0 ? 'Node' : 'mixed'
  const wiredBins = [...new Set(bins)]
  const tail = formatNativeCounts(counts, wiring.harnesses)
  const run = `run '${wiring.install}'`
  const row = (status: DoctorResult['status'], text: string): DoctorResult => ({ name, status, message: `${text}; ${tail}` })
  // An entry in the right form can still be an older build's line (one without the exit suffix, or the cmd-style Node form PowerShell cannot parse), which only a rewrite fixes.
  const outdated = wiring.entries.filter((e) => e.current === false).length
  const settled = (text: string): DoctorResult => (outdated > 0 ? row('warn', `${text}, but ${outdated} of ${total} hook entries are not the command this build writes; ${run} to rewrite them`) : row('ok', text))

  const missing = wiredBins.filter((b) => !fs.existsSync(b))
  if (missing.length > 0) {
    const broken = bins.filter((b) => missing.includes(b)).length
    return row('fail', `${broken} of ${total} hook entries run the native hook client at ${missing.map(displaySafeText).join(', ')}, which no longer exists, so those events fail instead of falling back to Node; ${run} to rewrite them`)
  }
  for (const bin of wiredBins) {
    const test = selftest(bin)
    if (!test.ok) return row('fail', `the native hook client at ${displaySafeText(bin)} fails its self-test (${displaySafeText(test.reason ?? 'unknown')}); ${run} to rewrite the entries as Node commands`)
  }
  const wiredText = form === 'Node' ? 'Node form' : `${form === 'native' ? 'native' : `mixed (${nativeCount} of ${total} native)`}, ${wiredBins.map(displaySafeText).join(', ')}, self-test passed`

  if (!avail.enabled) {
    if (form === 'Node') return settled('Node form; native hooks are off (hooks.native or TOKEN_GOAT_NATIVE_HOOKS)')
    return row('warn', `${wiredText}, but native hooks are off (hooks.native or TOKEN_GOAT_NATIVE_HOOKS); ${run} to switch back to the Node form`)
  }
  if (avail.packaged === undefined) {
    if (form === 'Node') return settled(`Node form; this build ships no native hook client for ${avail.target}`)
    return row('warn', `${wiredText}, but this build ships no native hook client for ${avail.target}; ${run} to switch to the Node form`)
  }
  if (avail.copyStale) {
    if (form === 'Node') return row('warn', `Node form while the native hook client is available; ${run} to switch`)
    return row('warn', `${wiredText}, but the copy differs from this build's binary; ${run} to refresh it`)
  }
  if (avail.expected === undefined) {
    const why = avail.selftest?.ok === false ? `this build's native hook client fails its self-test (${displaySafeText(avail.selftest.reason ?? 'unknown')})` : `this build's native hook client is unusable`
    if (form === 'Node') return row('warn', `Node form; ${why}`)
    return row('warn', `${wiredText}, but ${why}; ${run} to switch to the Node form`)
  }
  if (form !== 'native') return row('warn', `${form === 'Node' ? 'Node form' : wiredText} while the native hook client is available; ${run} to switch`)
  const expected = avail.expected
  const foreign = wiredBins.filter((b) => !samePath(b, expected))
  if (foreign.length > 0) return row('warn', `${wiredText}, not this build's ${displaySafeText(expected)}; ${run} to rewrite them`)
  return settled(wiredText)
}

/** Every native hook row for this machine, with counts read from the stats database at `dbPath` (none when it does not exist yet). */
export function checkNativeHooks(dbPath: string): DoctorResult[] {
  const avail = nativeAvailability()
  const counts = fs.existsSync(dbPath) ? nativeHookCounts(getDb(dbPath)) : new Map<string, NativeHookCounts>()
  return nativeWirings()
    .map((w) => checkNativeHookWiring(w, avail, counts))
    .filter((r): r is DoctorResult => r !== null)
}
