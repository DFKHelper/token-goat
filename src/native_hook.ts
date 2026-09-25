/** The native hook client (native/tg-hook) as installers and `doctor` see it: where this install's binary is, whether an install should wire it, the command lines that put it in front of a hook's Node command, and how to read one of those back. The native form is always the Node command's own argv with a prefix, `tg-hook --harness H --event E --entry ENTRY [--script-dir DIR] -- NODE SHIM EVENT ENTRY`, so every reader that knows the Node command also knows what the native client falls back to. */
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { nativeHooksEnabled } from './config.js'
import { dataDir } from './constants.js'
import { powershellHookLine, quotePowershellPath, quotePosixShellWord } from './process_util.js'
import { registerReset } from './reset.js'
import { withRetryOnLock } from './util.js'

/** The harnesses whose installers can wire the native client, spelled as tg-hook's `--harness` takes them. */
export type NativeHarness = 'claudecode' | 'codex' | 'grok' | 'kimi' | 'copilot_cli'

/** How the harness runs a hook's command string: `sh` for a POSIX shell (Git Bash for Claude Code on Windows), `powershell` for `powershell -Command`, `cmd` for `cmd.exe /d /s /c`. */
export type HookShell = 'sh' | 'powershell' | 'cmd'

/** `<platform>-<arch>` pairs whose installs wire the native client. macOS keeps the Node command: its binary must be signed and notarized before a harness may run it on every tool call. */
const NATIVE_TARGETS: ReadonlySet<string> = new Set(['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'])

/** How long the install-time self-test may take before the binary counts as unusable. A healthy one answers in milliseconds; this only bounds a hung or quarantined one. */
const SELFTEST_TIMEOUT_MS = 5000

function exeName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tg-hook.exe' : 'tg-hook'
}

/** The binary shipped beside `entryPath` (dist/token-goat.mjs) for this platform, or undefined when this platform is not a native target or the package carries no binary for it. */
export function packagedNativeBinary(entryPath: string | undefined = process.argv[1]): string | undefined {
  if (entryPath === undefined || entryPath === '') return undefined
  const target = `${process.platform}-${process.arch}`
  if (!NATIVE_TARGETS.has(target)) return undefined
  const bin = path.join(path.dirname(entryPath), 'native', target, exeName())
  return fs.existsSync(bin) ? bin : undefined
}

/** Where a Windows install runs the binary from: a copy in the data directory, keyed by the bundle directory's real path so each install (global, a dev checkout) keeps one stable path that settings files can name across upgrades. The copy exists because Windows will not delete or replace an executable that is running: a harness mid-hook held the packaged binary open, and `npm install -g` then failed with EBUSY and left a half-upgraded tree (package.json of the new version, binary of the old). A copy outside the package is never in npm's way, and replacing it while it runs is handled by {@link syncNativeCopy}. */
export function nativeCopyPath(entryPath: string, home: string = dataDir()): string {
  let bundleDir = path.dirname(entryPath)
  try {
    bundleDir = fs.realpathSync.native(bundleDir)
  } catch {
    // an unresolvable directory keys by its spelling
  }
  const id = crypto.createHash('sha256').update(bundleDir.toLowerCase()).digest('hex').slice(0, 16)
  return path.join(home, 'native', id, exeName('win32'))
}

/** Leftovers of earlier replacements in the copy's directory: `.old` files that were running when they were moved aside, and `.new` files a crash left behind. */
const LEFTOVER = /^tg-hook\.exe\.[0-9a-f]+\.(?:old|new)$/

/** Delete every leftover in `dir` that can be deleted; one still running stays until a later install. */
function reclaimLeftovers(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!LEFTOVER.test(name)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      // still running, or locked by a scanner: the next install tries again
    }
  }
}

/** Make `dest` a byte-identical copy of `src`, returning false when it could not be. The new bytes are written beside `dest` and renamed over it. Windows refuses that rename while `dest` is running, but lets the running file itself be renamed, so it is moved aside to a `.old` name first, and a later install deletes it once nothing runs it. A hook starting in the gap between the two renames finds no binary and fails that one call; the gap is two renames long. */
export function syncNativeCopy(src: string, dest: string): boolean {
  let want: Buffer
  try {
    want = fs.readFileSync(src)
  } catch {
    return false
  }
  try {
    if (fs.readFileSync(dest).equals(want)) return true
  } catch {
    // absent or unreadable: write it
  }
  const dir = path.dirname(dest)
  const tag = crypto.randomBytes(6).toString('hex')
  const staged = `${dest}.${tag}.new`
  try {
    fs.mkdirSync(dir, { recursive: true })
    reclaimLeftovers(dir)
    fs.writeFileSync(staged, want, { mode: 0o755 })
  } catch {
    fs.rmSync(staged, { force: true })
    return false
  }
  try {
    fs.renameSync(staged, dest)
    return true
  } catch {
    // dest is running, or a scanner still holds the file just written
  }
  try {
    // A running dest can be renamed but not replaced; an absent one (nothing to move aside) leaves only the scanner's hold on the staged file, which the retry outwaits.
    if (fs.existsSync(dest)) withRetryOnLock(() => fs.renameSync(dest, `${dest}.${tag}.old`))
    withRetryOnLock(() => fs.renameSync(staged, dest))
    return true
  } catch {
    fs.rmSync(staged, { force: true })
    return false
  }
}

/** True when the copy at `dest` holds exactly the packaged binary's bytes. */
export function nativeCopyCurrent(src: string, dest: string): boolean {
  try {
    return fs.readFileSync(dest).equals(fs.readFileSync(src))
  } catch {
    return false
  }
}

/** Outcome of `tg-hook --selftest`. */
export interface NativeSelftest {
  readonly ok: boolean
  /** Why it failed, in words `doctor` can print. */
  readonly reason?: string
}

const _selftests = new Map<string, NativeSelftest>()

/** Run `bin --selftest` once per process and binary: it passes only on exit code exactly 0 within {@link SELFTEST_TIMEOUT_MS}. The self-test touches no server and no data, so a pass says only that this binary starts and runs on this machine, which is what an installer must know before a harness runs it on every tool call. */
export function nativeSelftest(bin: string): NativeSelftest {
  const cached = _selftests.get(bin)
  if (cached !== undefined) return cached
  let result: NativeSelftest
  const res = spawnSync(bin, ['--selftest'], { encoding: 'utf8', timeout: SELFTEST_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.error !== undefined) result = { ok: false, reason: (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `no answer within ${SELFTEST_TIMEOUT_MS} ms` : res.error.message }
  else if (res.status !== 0) result = { ok: false, reason: res.signal !== null ? `killed by ${res.signal}` : `exit code ${String(res.status)}` }
  else result = { ok: true }
  _selftests.set(bin, result)
  return result
}

/** Decisions by `sync` flag and entry path. A `sync: true` decision also replaces the `sync: false` one for its entry, since it has just brought the copy up to date. */
const _decisions = new Map<string, string | null>()

registerReset(() => {
  _selftests.clear()
  _decisions.clear()
})

/** The binary an install run from `entryPath` wires in front of each hook's Node command, or undefined when it must write the Node command alone: native hooks switched off (hooks.native, TOKEN_GOAT_NATIVE_HOOKS), no binary for this platform beside the bundle, the Windows copy could not be brought up to date, or the binary failed its self-test. With `sync: false` (what `doctor` asks) nothing is written: a Windows copy that is missing or differs from the packaged binary answers undefined, so an entry naming it reads as one `install` has to rewrite. Decided once per process, flag and entry. */
export function nativeHookBinary(entryPath: string | undefined = process.argv[1], opts: { sync?: boolean } = {}): string | undefined {
  if (entryPath === undefined || entryPath === '' || !nativeHooksEnabled()) return undefined
  const sync = opts.sync !== false
  const key = `${String(sync)}\0${entryPath}`
  const cached = _decisions.get(key)
  if (cached !== undefined) return cached ?? undefined
  const packaged = packagedNativeBinary(entryPath)
  let bin: string | undefined = packaged
  if (packaged !== undefined && process.platform === 'win32') {
    const copy = nativeCopyPath(entryPath)
    const current = sync ? syncNativeCopy(packaged, copy) : nativeCopyCurrent(packaged, copy)
    bin = current ? copy : undefined
  }
  if (bin !== undefined && !nativeSelftest(bin).ok) bin = undefined
  _decisions.set(key, bin ?? null)
  if (sync) _decisions.set(`false\0${entryPath}`, bin ?? null)
  return bin
}

/** The flags tg-hook takes before `--`, as every installer writes them. `scriptDir` is passed only for Copilot CLI, whose adapter hands the shim's directory to VS Code's duplicate-hook guard; no other adapter reads it. */
export function nativeHookFlags(harness: NativeHarness, event: string, entry: string, scriptPath: string): string[] {
  const flags = ['--harness', harness, '--event', event, '--entry', entry]
  if (harness === 'copilot_cli') flags.push('--script-dir', path.dirname(scriptPath))
  return flags
}

/** The Node hook command's argv (util.ts hookExecPartsFor, as one list), or undefined without an entry path, which the native flags need. */
function nodeHookArgv(scriptPath: string, event: string, entry: string | undefined): string[] | undefined {
  if (entry === undefined || entry === '') return undefined
  return [process.execPath, scriptPath, event, entry]
}

/** One word of a generated command line: `quote` marks a path, which is always quoted; a flag, harness or event name is written bare. */
interface Word {
  readonly text: string
  readonly quote: boolean
}

/** The flags whose value is a path. */
const PATH_FLAGS: ReadonlySet<string> = new Set(['--entry', '--script-dir'])

function nativeWords(bin: string, harness: NativeHarness, scriptPath: string, event: string, entry: string): Word[] {
  const flags = nativeHookFlags(harness, event, entry, scriptPath)
  const flagWords = flags.map((text, i) => ({ text, quote: i > 0 && PATH_FLAGS.has(flags[i - 1]!) }))
  return [{ text: bin, quote: true }, ...flagWords, { text: '--', quote: false }, { text: process.execPath, quote: true }, { text: scriptPath, quote: true }, { text: event, quote: false }, { text: entry, quote: true }]
}

/** Quote one path for `shell`. POSIX shells get single quotes, the only quoting in which nothing (`$`, a backtick, a backslash) is special. PowerShell gets its single quotes too, for the same reason. cmd.exe has no quoting that stops `%NAME%` expansion, so a path containing a defined variable's name between two percent signs cannot be written for it; Windows paths cannot contain the double quote that would end the word. */
function quoteFor(shell: HookShell, text: string): string {
  if (shell === 'sh') return quotePosixShellWord(text)
  if (shell === 'powershell') return quotePowershellPath(text)
  return `"${text}"`
}

/** The native command line for a harness that runs hooks through `shell`, or undefined when there is no entry path to name. A PowerShell one is powershellHookLine's, for the call operator and the hook's own exit code. */
export function nativeHookCommandLine(shell: HookShell, bin: string, harness: NativeHarness, scriptPath: string, event: string, entry: string | undefined = process.argv[1]): string | undefined {
  if (nodeHookArgv(scriptPath, event, entry) === undefined) return undefined
  const line = nativeWords(bin, harness, scriptPath, event, entry!).map((w) => (w.quote ? quoteFor(shell, w.text) : w.text)).join(' ')
  return shell === 'powershell' ? powershellHookLine(line) : line
}

/** The native exec-form entry (Claude Code >= 2.1.139): the binary as `command`, everything else as `args`, with no shell in between. */
export function nativeHookExecParts(bin: string, harness: NativeHarness, scriptPath: string, event: string, entry: string | undefined = process.argv[1]): { command: string; args: string[] } | undefined {
  if (nodeHookArgv(scriptPath, event, entry) === undefined) return undefined
  return { command: bin, args: nativeWords(bin, harness, scriptPath, event, entry!).slice(1).map((w) => w.text) }
}

/** Split a hook command string into the argv its harness's shell hands the program, for the quoting token-goat writes: single quotes (with `'\''` in a POSIX shell, `''` in PowerShell), double quotes (backslash escapes only in a POSIX shell off Windows, where hookCommandFor writes them), and bare words. A leading PowerShell call operator is dropped, and a PowerShell line ends at its first unquoted `;` (what follows is POWERSHELL_EXIT_SUFFIX, not the program's argv). Not a general shell parser: variables, globs and operators are not expanded, because nothing token-goat writes contains them. */
export function splitHookCommand(command: string, shell: HookShell): string[] {
  const words: string[] = []
  let text = command.trim()
  if (shell === 'powershell' && text.startsWith('& ')) text = text.slice(2)
  const posix = shell === 'sh'
  const dqEscapes = posix && process.platform !== 'win32'
  let cur = ''
  let inWord = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === ';' && shell === 'powershell') break
    if (/\s/.test(ch)) {
      if (inWord) words.push(cur)
      cur = ''
      inWord = false
      continue
    }
    inWord = true
    if (ch === "'" && shell !== 'cmd') {
      for (i++; i < text.length; i++) {
        if (text[i] !== "'") cur += text[i]
        else if (shell === 'powershell' && text[i + 1] === "'") cur += text[++i]
        else break
      }
      continue
    }
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (dqEscapes && text[i] === '\\' && i + 1 < text.length) cur += text[++i]
        else cur += text[i]
      }
      continue
    }
    if (posix && ch === '\\' && i + 1 < text.length && (process.platform !== 'win32' || text[i + 1] === "'")) {
      cur += text[++i]
      continue
    }
    cur += ch
  }
  if (inWord) words.push(cur)
  return words
}

/** Thrown by an installer, before it writes any hook config, when a command it would write contains text the harness rewrites before the command runs, so the hook would run something other than token-goat. */
export class HookCommandRewriteError extends Error {}

/** The first span of `command` that `reader` replaces before the command runs, or undefined. `cmd`: cmd.exe's `%NAME%`, expanded in its first parsing phase, before it reads a single quote, so no quoting keeps it literal. `grok`: `$NAME` and `${...}`, which Grok CLI substitutes itself when it loads a hook, whatever the quoting and whatever the shell, refusing to run a hook that names an unset variable (grok-build xai-grok-hooks `env_expand.rs` `iter_env_var_references`, which has no escape, and `runner/command.rs` `find_unresolved_env_vars`). */
export function hookCommandRewrittenSpan(command: string, reader: 'cmd' | 'grok'): string | undefined {
  return (reader === 'cmd' ? /%[^%\r\n]+%/ : /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\})/).exec(command)?.[0]
}

/** One token-goat hook entry read back from a harness config. */
export interface WiredHookEntry {
  /** Its argv words, split the way the shell the harness runs it in would. */
  readonly words: string[]
  /** Whether it is exactly a command this build writes for that harness now; undefined where the reader does not judge it. */
  readonly current?: boolean
}

/** A native-form invocation read back from a hook's argv. */
export interface NativeInvocation {
  readonly bin: string
  readonly harness: string | undefined
  /** The Node command after `--`, which the client runs whenever the server cannot answer. */
  readonly wrapped: readonly string[]
}

/** The native invocation `argv` is, or undefined when it is not one: its program is a `tg-hook` binary and a `--` separates the flags from the wrapped command. */
export function parseNativeInvocation(argv: readonly string[]): NativeInvocation | undefined {
  const bin = argv[0]
  if (bin === undefined || !/^tg-hook(?:\.exe)?$/i.test(path.basename(bin.replace(/\\/g, '/')))) return undefined
  const split = argv.indexOf('--')
  if (split < 0) return undefined
  const flags = argv.slice(1, split)
  const h = flags.indexOf('--harness')
  return { bin, harness: h >= 0 ? flags[h + 1] : undefined, wrapped: argv.slice(split + 1) }
}
