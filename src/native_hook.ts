/** The native hook client (native/tg-hook) as installers and `doctor` see it: where this install's binary is, whether an install should wire it, the command lines that put it in front of a hook's Node command, and how to read one of those back. The native form is always the Node command's own argv with a prefix, `tg-hook --harness H --event E --entry ENTRY [--script-dir DIR] -- NODE SHIM EVENT ENTRY`, so every reader that knows the Node command also knows what the native client falls back to. */
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { nativeHooksEnabled } from './config.js'
import { dataDir } from './constants.js'
import { emitErr } from './emit.js'
import { displaySafeText } from './paths.js'
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

/** The packaged binary path for this platform beside `entryPath`, or undefined off a native target. */
function packagedNativePath(entryPath: string): string | undefined {
  const target = `${process.platform}-${process.arch}`
  if (!NATIVE_TARGETS.has(target)) return undefined
  return path.join(path.dirname(entryPath), 'native', target, exeName())
}

/** The binary shipped beside `entryPath` (dist/token-goat.mjs) for this platform, or undefined when this platform is not a native target or the package carries no binary for it. */
export function packagedNativeBinary(entryPath: string | undefined = process.argv[1]): string | undefined {
  if (entryPath === undefined || entryPath === '') return undefined
  const bin = packagedNativePath(entryPath)
  return bin !== undefined && fs.existsSync(bin) ? bin : undefined
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

/** Leftovers of earlier replacements in the copy's directory: `.old` files that were running when they were moved aside, and `.new` files a crash left behind. The tag is the writing process's pid as 8 hex digits and 12 random ones; a 12-digit tag is an older build's and names no pid. */
const LEFTOVER = /^tg-hook\.exe\.([0-9a-f]+)\.(?:old|new)$/

/** A staging directory under `native/.staging`, named by the same tag. */
const STAGING_NAME = /^[0-9a-f]{20}$/

/** How old a dead process's leftover must be before it is reclaimed: another install may be between its two renames, and a young file is never reclaimed. */
const RECLAIM_MIN_AGE_MS = 10 * 60 * 1000

/** What reclaiming needs from the machine, injectable so a test needs no real process or clock. */
export interface ReclaimEnv {
  /** True when `pid` names a running process, or when that cannot be told. */
  readonly isAlive?: (pid: number) => boolean
  readonly now?: () => number
}

/** Signal 0 asks the OS about a pid without sending anything. EPERM means it exists. Anything not a plain pid above 1 reads as alive, since a signal to 0 or 1 would reach a group or init. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A tag for one sync's files: this process's pid, then random digits, so a later install can tell whose they are. */
function ownerTag(): string {
  return `${process.pid.toString(16).padStart(8, '0').slice(-8)}${crypto.randomBytes(6).toString('hex')}`
}

/** True when the leftover or staging entry `tag` named at `full` may go: this process's own (a sync is synchronous, so none of its files is in flight), or one whose pid is dead and which is older than {@link RECLAIM_MIN_AGE_MS}. An older build's tag has no pid and goes by age alone. */
function reclaimable(tag: string, full: string, env: ReclaimEnv): boolean {
  const pid = tag.length === 20 ? Number.parseInt(tag.slice(0, 8), 16) : undefined
  if (pid === process.pid) return true
  if (pid !== undefined && (env.isAlive ?? pidIsAlive)(pid)) return false
  try {
    return (env.now ?? Date.now)() - fs.statSync(full).mtimeMs > RECLAIM_MIN_AGE_MS
  } catch {
    return false
  }
}

/** Delete the leftovers in `dir`, and the staging directories beside it, that {@link reclaimable} allows; anything else, or anything still running, stays until a later install. */
function reclaimLeftovers(dir: string, env: ReclaimEnv = {}): void {
  const sweep = (parent: string, pattern: RegExp, remove: (full: string) => void): void => {
    let names: string[]
    try {
      names = fs.readdirSync(parent)
    } catch {
      return
    }
    for (const name of names) {
      const tag = pattern === STAGING_NAME ? name : LEFTOVER.exec(name)?.[1]
      if (tag === undefined || !pattern.test(name)) continue
      const full = path.join(parent, name)
      if (!reclaimable(tag, full, env)) continue
      try {
        remove(full)
      } catch {
        // still running, or locked by a scanner: the next install tries again
      }
    }
  }
  sweep(dir, LEFTOVER, (full) => fs.unlinkSync(full))
  sweep(path.join(path.dirname(dir), '.staging'), STAGING_NAME, (full) => fs.rmSync(full, { recursive: true, force: true }))
}

/** Put the copy moved to `aside` back at `dest`: a rename, then a plain copy when the rename keeps failing. A destination missing here is what makes every hook that names it fail, so this is the last thing a failed swap does and its failure is said aloud. */
function restoreDest(aside: string, dest: string): void {
  try {
    withRetryOnLock(() => fs.renameSync(aside, dest))
    return
  } catch {
    // fall through to a copy: the aside image can be read even while it is running
  }
  try {
    fs.copyFileSync(aside, dest, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(dest, 0o755)
  } catch (e) {
    try {
      fs.rmSync(dest, { force: true })
    } catch {
      // a partial copy that cannot be removed stays for doctor to report
    }
    emitErr(`token-goat: could not put the previous native hook client back at ${dest} (${displaySafeText(e instanceof Error ? e.message : String(e))}); the copy is at ${aside}. Run \`token-goat install\` to rewrite it.`)
  }
}

/** Make `dest` a byte-identical copy of `src`, returning false when it could not be. After any return a `dest` that existed before still exists and is a complete file. The new bytes are written to `native/.staging/<tag>/`, outside every hash directory, and only then is the hash directory created and the file renamed into it, so a failed write leaves no empty directory. Windows refuses that rename while `dest` is running, but lets the running file itself be renamed, so it is moved aside to a `.old` name first, and a later install deletes it once nothing runs it. A hook starting in the gap between the two renames finds no binary and fails that one call; the gap is two renames long, because a scanner's hold on the new bytes is outwaited before the old copy moves. A swap that fails after the move puts the old copy back, by copy if a rename will not do. */
export function syncNativeCopy(src: string, dest: string, env: ReclaimEnv = {}): boolean {
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
  const tag = ownerTag()
  const stagingDir = path.join(path.dirname(dir), '.staging', tag)
  const staged = path.join(stagingDir, path.basename(dest))
  let createdDir = false
  const finish = (): void => {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // reclaimed by a later install
    }
    // Only an empty directory this call made goes; rmdir refuses one that holds anything.
    if (createdDir) {
      try {
        fs.rmdirSync(dir)
      } catch {
        // not empty, which is the point
      }
    }
  }
  try {
    reclaimLeftovers(dir, env)
    fs.mkdirSync(stagingDir, { recursive: true })
    fs.writeFileSync(staged, want, { mode: 0o755 })
    createdDir = !fs.existsSync(dir)
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    finish()
    return false
  }
  // The bytes move into the hash directory under a `.new` name first, so the direct rename below is the one an install always tried.
  const first = `${dest}.${ownerTag()}.new`
  try {
    withRetryOnLock(() => fs.renameSync(staged, first))
  } catch {
    finish()
    return false
  }
  try {
    fs.renameSync(first, dest)
    finish()
    return true
  } catch {
    // dest is running, or a scanner still holds the file just written
  }
  // Outwait a scanner's hold on the new file while dest is still in place: renaming it succeeds only once the hold is gone, so dest goes missing for no longer than the two renames below.
  const ready = `${dest}.${ownerTag()}.new`
  try {
    withRetryOnLock(() => fs.renameSync(first, ready))
  } catch {
    discardStaged(first)
    finish()
    return false
  }
  const aside = `${dest}.${tag}.old`
  let movedAside = false
  try {
    // A running dest can be renamed but not replaced, so it is moved aside first.
    if (fs.existsSync(dest)) {
      withRetryOnLock(() => fs.renameSync(dest, aside))
      movedAside = true
    }
    withRetryOnLock(() => fs.renameSync(ready, dest))
    finish()
    return true
  } catch {
    if (movedAside && !fs.existsSync(dest)) restoreDest(aside, dest)
    discardStaged(ready)
    finish()
    return false
  }
}

/** Delete a staged copy that will not be used. A scanner holding it makes the delete fail with EPERM; the file then stays as a leftover the next install reclaims, since a failed cleanup must not turn a fallback to the Node command into a failed install. */
function discardStaged(staged: string): void {
  try {
    fs.rmSync(staged, { force: true })
  } catch {
    // reclaimed by a later install
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

const COPY_FAILED = 'its copy could not be put in place in the data directory (a scanner or another process held the file)'
const COPY_STALE = 'the data-directory copy is missing or differs from the packaged binary'
/** Failures worth one more try: a held copy, or a self-test that got no answer. An exit code or signal is the binary itself failing, which a second run repeats. */
const TRANSIENT_WHY = /could not be put in place|no answer within/

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
  let bin: string | undefined
  let why: string | undefined
  if (packaged !== undefined) {
    // A first failure that looks transient (the copy could not be put in place, or the self-test got no answer on a starved machine) is tried once more before the install settles for the Node form; a binary that ran and failed stays failed.
    for (let attempt = 1; attempt <= 2 && bin === undefined; attempt++) {
      if (attempt === 2) {
        if (why === undefined || !TRANSIENT_WHY.test(why)) break
        _selftests.clear()
      }
      why = undefined
      let candidate: string | undefined = packaged
      if (process.platform === 'win32') {
        const copy = nativeCopyPath(entryPath)
        const current = sync ? syncNativeCopy(packaged, copy) : nativeCopyCurrent(packaged, copy)
        if (current) candidate = copy
        else {
          candidate = undefined
          why = sync ? COPY_FAILED : COPY_STALE
        }
      }
      if (candidate !== undefined) {
        const test = nativeSelftest(candidate)
        if (test.ok) bin = candidate
        else why = `its self-test failed: ${test.reason ?? 'no reason given'}`
      }
    }
  } else {
    const expected = packagedNativePath(entryPath)
    if (expected !== undefined) why = `the packaged binary ${expected} is missing (a dev checkout builds it with npm run build:native)`
  }
  if (bin === undefined && sync && why !== undefined && why !== COPY_STALE) emitErr(`token-goat: wrote the Node form of the hooks, not the native hook client, because ${why}. Run \`token-goat doctor --repair\` (or install again) to retry.`)
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
  /** The hook event named by `--event`, or undefined when absent. */
  readonly event: string | undefined
  /** The bundle named by `--entry`, or undefined when absent. */
  readonly entry: string | undefined
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
  const value = (name: string): string | undefined => {
    const i = flags.indexOf(name)
    return i >= 0 ? flags[i + 1] : undefined
  }
  return { bin, harness: value('--harness'), event: value('--event'), entry: value('--entry'), wrapped: argv.slice(split + 1) }
}
