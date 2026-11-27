/** `doctor`'s native hook client rows: per harness and scope, which form of hook command is wired (the native client in front of the Node command, or the Node command alone), whether the wired binary resolves and this build's binary passes its self-test, whether it is the form this build would write, and how the last week's hook calls were answered. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { wiredCodexHookWords } from './bridges/codex_install.js'
import { wiredCopilotHookWords } from './bridges/copilot_cli_install.js'
import { wiredGrokHookWords } from './bridges/grok_install.js'
import { wiredKimiHookWords } from './bridges/kimi_install.js'
import { SHIM_FILE_WORD } from './cli_doctor_hooks.js'
import { nativeHooksEnabled } from './config.js'
import { getDb } from './db.js'
import type { DoctorResult } from './doctor_result.js'
import { nativeHookCounts, type NativeHookCounts } from './hook_latency.js'
import { HOOK_BROKEN_FILE, hookPointerPath, readHookBroken, readHookPointer } from './hook_pointer.js'
import { wiredClaudeHookEntries } from './install.js'
import { nativeCopyCurrent, nativeCopyPath, nativeHookBinary, nativeSelftest, packagedNativeBinary, parseNativeInvocation, type NativeSelftest, type WiredHookEntry } from './native_hook.js'
import { displaySafeText } from './paths.js'
import { resolveOnPath } from './process_util.js'
import { HOOK_STATS_RETENTION_DAYS } from './stats.js'
import { fencedCommand } from './hint_suggestion_guard.js'

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
  /** Windows only, with native hooks on: the data-directory copy the entries run, current or not, so the doctor can self-test it. */
  readonly copy?: string
  /** The packaged binary's self-test, when an install would have to run it to decide. */
  readonly selftest?: NativeSelftest
}

/** What this build would wire right now, for the running bundle. */
export function nativeAvailability(entry: string | undefined = process.argv[1]): NativeAvailability {
  const enabled = nativeHooksEnabled()
  const target = `${process.platform}-${process.arch}`
  const packaged = packagedNativeBinary(entry)
  const copyStale = process.platform === 'win32' && packaged !== undefined && entry !== undefined
    && !nativeCopyCurrent(packaged, nativeCopyPath())
  const expected = nativeHookBinary(entry, { sync: false })
  // A current copy (or a Linux binary) that still yields no decision failed its self-test, and that failure is the reason an install writes the Node form.
  const selftest = enabled && packaged !== undefined && !copyStale && expected === undefined
    ? nativeSelftest(process.platform === 'win32' && entry !== undefined ? nativeCopyPath() : packaged)
    : undefined
  const copy = process.platform === 'win32' && enabled && packaged !== undefined && entry !== undefined
    ? nativeCopyPath()
    : undefined
  return { enabled, target, packaged, expected, copyStale, ...(copy === undefined ? {} : { copy }), ...(selftest === undefined ? {} : { selftest }) }
}

/** Every harness scope an installer can wire the native client into, read back from its config. */
export function nativeWirings(): NativeWiring[] {
  return [
    {
      label: 'Claude Code (user)',
      install: 'token-goat install',
      harnesses: ['claudecode'],
      entries: wiredClaudeHookEntries('user'),
    },
    {
      label: 'Claude Code (project)',
      install: 'token-goat install --project',
      harnesses: ['claudecode'],
      entries: wiredClaudeHookEntries('project'),
    },
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
  const resolvedBins = new Map<string, string>()
  const missing = wiredBins.filter((bin) => {
    const resolved = resolveOnPath(bin)
    if (resolved !== null) {
      resolvedBins.set(bin, resolved)
      return false
    }
    // Keep an existing relative spelling diagnosable; only the resolved build binary is self-tested.
    if (fs.existsSync(bin)) {
      resolvedBins.set(bin, path.resolve(bin))
      return false
    }
    return true
  })
  const tail = formatNativeCounts(counts, wiring.harnesses)
  const run = `run ${fencedCommand(wiring.install)}`
  const row = (status: DoctorResult['status'], text: string): DoctorResult => ({ name, status, message: `${text}; ${tail}` })
  // An entry in the right form can still be an older build's line (one without the exit suffix, or the cmd-style Node form PowerShell cannot parse), which only a rewrite fixes.
  const outdated = wiring.entries.filter((e) => e.current === false).length
  const unguarded = wiring.entries.filter(
    (e) => e.guarded === false && parseNativeInvocation(e.words) !== undefined,
  ).length
  const settled = (text: string): DoctorResult => {
    if (unguarded > 0) {
      return row('warn', `${text}, but ${unguarded} of ${total} hook entries are not the guarded form, ` +
        `so a missing native client breaks them instead of falling back to Node; ${run} to rewrite them`)
    }
    if (outdated > 0) {
      return row('warn', `${text}, but ${outdated} of ${total} hook entries are not the command this build ` +
        `writes; ${run} to rewrite them`)
    }
    return row('ok', text)
  }

  if (missing.length > 0) {
    const broken = wiring.entries.filter(
      (e) => e.guarded !== true && missing.includes(parseNativeInvocation(e.words)?.bin ?? ''),
    ).length
    if (broken === 0) {
      return row(
        'warn',
        `the native hook client at ${missing.map(displaySafeText).join(', ')} no longer exists; ` +
          `the guarded hook entries fall back to the Node shim meanwhile; ${run} to restore the native client`,
      )
    }
    return row('fail', `${broken} of ${total} hook entries run the native hook client at ${missing.map(displaySafeText).join(', ')}, which no longer exists, so those events fail instead of falling back to Node; ${run} to rewrite them`)
  }
  const selfTested = new Set<string>()
  // Every binary this build owns is self-tested: the one an install wires now, the one it ships, and the Windows copy, which can be stale or broken.
  const ownBins = [avail.expected, avail.packaged, avail.copy].filter((own): own is string => avail.enabled && own !== undefined)
  for (const bin of wiredBins) {
    const resolved = resolvedBins.get(bin)
    if (resolved === undefined || !ownBins.some((own) => samePath(resolved, own))) continue
    const test = selftest(resolved)
    if (!test.ok) return row('fail', `the native hook client at ${displaySafeText(resolved)} fails its self-test (${displaySafeText(test.reason ?? 'unknown')}); ${run} to rewrite the entries as Node commands`)
    selfTested.add(bin)
  }
  const allSelfTested = wiredBins.length > 0 && wiredBins.every((bin) => selfTested.has(bin))
  const wiredText = form === 'Node'
    ? 'Node form'
    : `${form === 'native' ? 'native' : `mixed (${nativeCount} of ${total} native)`}, ${wiredBins.map((bin) => displaySafeText(resolvedBins.get(bin) ?? bin)).join(', ')}${allSelfTested ? ', self-test passed' : ''}`

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
  const foreign = wiredBins.filter((bin) => {
    const resolved = resolvedBins.get(bin)
    return resolved !== undefined && !samePath(resolved, expected)
  })
  if (foreign.length > 0) return row('warn', `${wiredText}, not this build's ${displaySafeText(expected)}; ${run} to rewrite them`)
  return settled(wiredText)
}

/** The event and bundle of a Node-form hook (`node <shim> <event> <entry>`), or undefined for other shapes. */
function nodeFormInvocation(words: readonly string[]): { event: string; entry: string } | undefined {
  const [, shim, event, entry] = words
  return words.length === 4 && shim !== undefined && SHIM_FILE_WORD.test(shim) && event !== undefined && entry !== undefined ? { event, entry } : undefined
}

/** Whether the pointer's fallback route works for `harnesses`: a valid pointer, its shim and client exist. */
function pointerRouteLive(harnesses: readonly string[]): boolean {
  const read = readHookPointer()
  if (!read.ok) return false
  let raw: { nativeBin?: unknown; shims?: unknown }
  try {
    raw = JSON.parse(fs.readFileSync(hookPointerPath(), 'utf8')) as typeof raw
  } catch {
    return false
  }
  const harness = harnesses.find((h) => h !== 'claudecode')
  // As the native reader (Pointer::shim_for): with a `shims` object only its entry for the harness counts.
  const mapPresent = typeof raw.shims === 'object' && raw.shims !== null && !Array.isArray(raw.shims)
  const shim = mapPresent ? read.pointer.shims[harness ?? ''] : read.pointer.shim
  if (harness !== undefined && shim === undefined) return false
  return typeof raw.nativeBin === 'string' && fs.existsSync(raw.nativeBin)
}

/** The FAIL row for a hook whose bundle (native `--entry` or Node-form entry) is gone, or null if none is. */
export function checkNativeEntryPaths(wiring: NativeWiring): DoctorResult | null {
  const eventsByEntry = new Map<string, string[]>()
  let broken = 0
  let pointerLive: boolean | undefined
  for (const { words, guarded } of wiring.entries) {
    const invoked = parseNativeInvocation(words) ?? nodeFormInvocation(words)
    if (invoked?.entry === undefined || fs.existsSync(invoked.entry)) continue
    // A guarded entry with --entry gone still runs: the native client reads the pointer to the live bundle.
    if (guarded === true) {
      pointerLive ??= pointerRouteLive(wiring.harnesses)
      if (pointerLive) continue
    }
    broken += 1
    eventsByEntry.set(invoked.entry, [...(eventsByEntry.get(invoked.entry) ?? []), invoked.event ?? 'unknown event'])
  }
  if (broken === 0) return null
  const named = [...eventsByEntry].map(([entry, events]) => `${displaySafeText(entry)} (${events.join(', ')})`).join('; ')
  return {
    name: `Native hook entry (${wiring.label})`,
    status: 'fail',
    message: `${wiring.label}: ${broken} of ${wiring.entries.length} hook entries name a bundle that no longer exists, ${named}, which fails those events; run ${fencedCommand(wiring.install)} to rewrite them`,
  }
}

/** FAIL when the native client had to leave its first route (a missing node, shim or bundle entry, a crash) and answered from a fallback route or the safe no-op: the hooks still ran or failed open, but something an install should have kept in place is gone. `install` clears the notice. */
export function checkHookBroken(home: string): DoctorResult[] {
  const notice = readHookBroken(home)
  if (notice === undefined) return []
  const busy = notice.events.filter((e) => e.route === 'deadline-busy')
  const failures = notice.events.filter((e) => e.route !== 'deadline-busy')
  const rows: DoctorResult[] = []
  if (busy.length > 0) {
    rows.push({
      name: 'Hook busy answers',
      status: 'ok',
      message: `${String(busy.length)} hook call${busy.length === 1 ? ' was' : 's were'} answered busy: no lane freed before the deadline, so the host was told to run ${busy.length === 1 ? 'it' : 'them'} again; this is contention, not damage, and needs no reinstall (${HOOK_BROKEN_FILE})`,
    })
  }
  const last = failures[failures.length - 1]
  if (last === undefined) return rows
  // notice.count counts every event, busy ones included, so the busy events kept here are taken out of it.
  const routeFailures = notice.count - busy.length
  const what = `${last.route}${last.path === '' ? '' : ` ${displaySafeText(last.path)}`}: ${displaySafeText(last.error)}`
  rows.push({
    name: 'Hook fallback',
    status: 'fail',
    message: `hook calls left their first route ${String(routeFailures)} time${routeFailures === 1 ? '' : 's'} between ${notice.first} and ${notice.last}; last: ${what} (${HOOK_BROKEN_FILE}); run ${fencedCommand('token-goat install')} to repair it`,
  })
  return rows
}

/** The per-harness hook counts, or none when the stats database is missing or unreadable: a damaged global.db is the Database row's finding (`checkDbExists`), and must not stop doctor before it prints. */
function readNativeHookCounts(dbPath: string): Map<string, NativeHookCounts> {
  if (!fs.existsSync(dbPath)) return new Map<string, NativeHookCounts>()
  try {
    return nativeHookCounts(getDb(dbPath))
  } catch {
    return new Map<string, NativeHookCounts>()
  }
}

/** Every native hook row for this machine, with counts read from the stats database at `dbPath` (none when it does not exist yet). */
export function checkNativeHooks(dbPath: string): DoctorResult[] {
  const avail = nativeAvailability()
  const counts = readNativeHookCounts(dbPath)
  const broken = checkHookBroken(path.dirname(dbPath))
  const wiringRows = nativeWirings()
    .flatMap((w) => [checkNativeHookWiring(w, avail, counts), checkNativeEntryPaths(w)])
    .filter((r): r is DoctorResult => r !== null)
  return [...broken, ...wiringRows]
}
