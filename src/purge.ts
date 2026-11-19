/** `uninstall --purge`: delete everything token-goat has written to disk. Uninstall deliberately leaves the data directory alone, because it holds an index that took real time to build and a user who reinstalls wants it back. Offboarding a machine wants the opposite, and "remove it by hand" is not an answer an organisation can put in a runbook: there are two roots, they differ per platform, and neither is obvious. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { dataDir } from './constants.js'
import { tokenGoatHome } from './disk_cache.js'
import { fileIsAbsent } from './fingerprint.js'
import { HOOK_CONFIG_SUFFIX, readCreatedLedgerStrict } from './bridges/created_configs.js'
import { HOOKS_CONFIG_FILE } from './bridges/copilot_hooks_owners.js'
import { claudeConfigDir } from './claude_config_dir.js'
import { copilotCliUserRoot } from './copilot_home.js'
import { emitErr } from './emit.js'
import { stringLiterals } from './hook_guard.js'
import { parseNativeInvocation, splitHookCommand } from './native_hook.js'
import { foldPath } from './path_containment.js'
import { removeFileInScope } from './util.js'

export interface PurgeResult {
  /** Roots that were deleted, with the bytes each held. */
  removed: Array<{ path: string; bytes: number; partial?: boolean }>
  /** Roots that did not exist, so there was nothing to delete. */
  absent: string[]
  /** Roots that could not be deleted, with the reason. */
  failed: Array<{ path: string; reason: string }>
  /** Files kept because a host config still names them, or that cannot be ruled out, with why. */
  kept?: Array<{ path: string; reason: string }>
}

/** Recursive size in bytes, counting only regular files. Unreadable entries count as zero rather than aborting the walk. */
export function directorySize(root: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      total += directorySize(full)
      continue
    }
    if (!entry.isFile()) continue
    try {
      total += fs.statSync(full).size
    } catch {
      // A file that vanished mid-walk contributes nothing; the walk continues.
    }
  }
  return total
}

/** The roots token-goat writes to. Two, not one: the data directory holds the index, caches and logs, while the home directory holds session state and the OCR cache, and they are different places on every platform. */
export function purgeRoots(): string[] {
  // Resolved, because TOKEN_GOAT_HOME is used as spelled (forward slashes from Git Bash, a trailing separator) while dataDir() is built by path.join: unresolved, the two printed with different separators, and one directory under two spellings was purged and then reported as already gone.
  const roots = [dataDir(), tokenGoatHome()].map((root) => path.resolve(root))
  return roots.filter((root, index) => roots.findIndex((other) => foldPath(other) === foldPath(root)) === index)
}

/** Is `child` the directory `parent` or inside it, by comparison form. */
function insideOrSame(parent: string, child: string): boolean {
  const rel = path.relative(foldPath(path.resolve(parent)), foldPath(path.resolve(child)))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Delete `target` (a file or directory) except for the files under it that `scan` says a config still names; each kept one goes to `kept`. Returns true when `target` itself is gone. */
function removeUnlessReferenced(
  target: string,
  nativeDir: string,
  scan: ReferenceScan,
  kept: Array<{ path: string; reason: string }>,
  failed: PurgeResult['failed'],
): boolean {
  let isDir: boolean
  try {
    isDir = fs.lstatSync(target).isDirectory()
  } catch {
    return true
  }
  if (!isDir) {
    // Only hook targets are asked about: a doubt about a config must not keep the index.
    const why = insideOrSame(nativeDir, target) ? referencedBy(target, scan) : undefined
    if (why !== undefined) {
      kept.push({ path: target, reason: why })
      return false
    }
    return tryRemove(target, { force: true }, failed)
  }
  let allGone = true
  for (const name of fs.readdirSync(target)) {
    if (!removeUnlessReferenced(path.join(target, name), nativeDir, scan, kept, failed)) allGone = false
  }
  return allGone && tryRemove(target, { recursive: true, force: true }, failed)
}

/** `rmSync`, but a refusal (a running exe, EPERM or EBUSY) goes to `failed` and answers false, not a throw. */
function tryRemove(target: string, options: fs.RmOptions, failed: PurgeResult['failed']): boolean {
  try {
    fs.rmSync(target, options)
    return true
  } catch (e) {
    failed.push({ path: target, reason: e instanceof Error ? e.message : String(e) })
    return false
  }
}

/** Deletes every root in {@link purgeRoots}, except the hook targets under `<dataDir>/native` that a host config still names, or that cannot be ruled out (an unreadable config keeps them all). Reports what went, what was already gone, what was kept and why, and what would not delete. `scan` is read before anything is deleted, because the ledger it reads lives in the directory being purged. */
export function purgeDataDirectories(scan: ReferenceScan = scanReferences()): PurgeResult {
  const kept: Array<{ path: string; reason: string }> = []
  const result: PurgeResult = { removed: [], absent: [], failed: [], kept }
  const nativeDir = path.join(path.resolve(dataDir()), 'native')
  for (const root of purgeRoots()) {
    // fileIsAbsent, not fs.existsSync: existsSync answers false for a directory it has no permission to look at, and reporting "already gone" for a root that is still there, still holding the index, is the one answer this command must never give. Anything other than a plain ENOENT now falls through to the delete, so a permission problem is reported as a failure with the reason attached rather than as a success.
    if (fileIsAbsent(root)) {
      result.absent.push(root)
      continue
    }
    const bytes = directorySize(root)
    try {
      if (insideOrSame(root, nativeDir) && referencedBy(nativeDir, scan) !== undefined) {
        // Everything but the hook targets goes; those are walked file by file so an unreferenced one still leaves.
        const keptBefore = kept.length
        const failedBefore = result.failed.length
        removeUnlessReferenced(root, nativeDir, scan, kept, result.failed)
        const left = [...kept.slice(keptBefore), ...result.failed.slice(failedBefore)]
        const partial = result.failed.length > failedBefore
        if (left.length === 0) result.removed.push({ path: root, bytes })
        else {
          const leftBytes = left.reduce((n, k) => n + directorySize(k.path), 0)
          result.removed.push({ path: root, bytes: bytes - leftBytes, ...(partial ? { partial } : {}) })
        }
      } else {
        fs.rmSync(root, { recursive: true, force: true })
        result.removed.push({ path: root, bytes })
      }
    } catch (e) {
      result.failed.push({ path: root, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

/** Human-readable size, matching the units the rest of the CLI prints. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Where each host keeps the config its hooks are registered in, in a module whose imports are leaves (no installer), so that both the installers and the hook-target guard (hook_targets.ts) can use it without an import cycle. */

/** Codex CLI's config directory: `$CODEX_HOME` when set and non-empty, else `~/.codex`. Codex itself resolves it the same way (`find_codex_home` in codex-rs/utils/home-dir/src/lib.rs, https://github.com/openai/codex), so an install that ignored the variable would write a valid config to a directory Codex never reads and every hook would silently never fire. Only an empty value counts as unset, as in Codex. */
export function codexHomeDir(): string {
  const override = process.env['CODEX_HOME']
  if (override !== undefined && override !== '') return path.resolve(override)
  return path.join(os.homedir(), '.codex')
}

/** Absolute path to `config.toml` in the Codex home. */
export function codexConfigPath(): string {
  return path.join(codexHomeDir(), 'config.toml')
}

/** Absolute path to `~/.grok/hooks/`. */
export function grokHooksDir(): string {
  return path.join(os.homedir(), '.grok', 'hooks')
}

/** Absolute path to `~/.grok/hooks/token-goat.json`, the hook config this bridge owns entirely. */
export function grokConfigPath(): string {
  return path.join(grokHooksDir(), 'token-goat.json')
}

/** Kimi's data root: `$KIMI_CODE_HOME` when set and non-blank, else `~/.kimi-code`. Resolved on every call rather than cached so tests (and a user switching roots between commands) see the current value. */
export function kimiHome(): string {
  const override = process.env['KIMI_CODE_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.kimi-code')
}

/** Absolute path to Kimi's `config.toml`. */
export function kimiConfigPath(): string {
  return path.join(kimiHome(), 'config.toml')
}

/** The Copilot CLI hook config of the user scope and of the project at `projectRoot`. */
export function copilotHookConfigPaths(projectRoot: string): string[] {
  return [path.join(copilotCliUserRoot(), 'hooks', HOOKS_CONFIG_FILE), path.join(projectRoot, '.github', 'hooks', HOOKS_CONFIG_FILE)]
}

/** Which files a hook registration still names, and the one gate every deletion of a hook target passes through. A hook target is a file a host's config runs: the native client under `<dataDir>/native/`, a shim in a host's hooks directory. Deleting one that a config still names makes that host fail on every tool call (`uv_spawn ENOENT`), so uninstall, `--purge` and shim removal all ask {@link isReferenced} first. Doubt keeps the file: an unreadable or unparseable config, an unreadable ledger or a failed scan all answer "referenced". */

/** What a scan reads. All optional: the defaults are this process's cwd and every config a host reads. */
export interface ScanOptions {
  /** The project whose configs are read besides every ledger entry's; defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Configs ignored because the caller judged them in memory (an uninstall that has stripped its entries but not yet written the file). */
  readonly skipConfigs?: readonly string[]
}

/** The configs a scan read, and why it cannot be trusted to have seen them all. */
export interface ReferenceScan {
  /** Each readable config with its text in comparison form. */
  readonly configs: ReadonlyArray<ConfigRead>
  /** One reason per config or source that exists but could not be read or parsed; any entry makes every path read as referenced. */
  readonly ambiguous: readonly string[]
}

/** A path in comparison form: separators unified and JSON's doubled backslashes collapsed, then case-folded where the filesystem is. */
function comparable(text: string): string {
  return foldPath(text.replace(/\\\\|\\/g, '/'))
}

/** Every host config that can name a hook target from this machine's user scope and the project at `cwd`. */
function hostConfigPaths(cwd: string): string[] {
  const claude = claudeConfigDir()
  return [
    path.join(claude, 'settings.json'),
    path.join(claude, 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    codexConfigPath(),
    grokConfigPath(),
    kimiConfigPath(),
    ...copilotHookConfigPaths(cwd),
  ]
}

/** One config as a scan read it: its text and the paths its token-goat hooks name, via the one parser. */
interface ConfigRead {
  readonly path: string
  readonly text: string
  readonly parsed: readonly string[]
}

/** Spelling-proof comparison paths each token-goat hook names, guarded or older form, via the one parser. */
function commandPaths(raw: string): string[] {
  const found: string[] = []
  for (const lit of stringLiterals(raw)) {
    if (!lit.includes('tg-hook') && !lit.includes('tg-guard-v')) continue
    for (const shell of ['sh', 'powershell', 'cmd'] as const) {
      const native = parseNativeInvocation(splitHookCommand(lit, shell))
      if (native === undefined) continue
      for (const w of [native.bin, native.entry, ...native.wrapped]) {
        if (w !== undefined && path.isAbsolute(w)) found.push(comparable(w))
      }
    }
  }
  return found
}

/** Read one config into `out`. A missing file names nothing; one that exists and cannot be read, or a `.json` one that does not parse, is ambiguous. */
function readConfig(file: string, out: { configs: ConfigRead[]; ambiguous: string[] }): void {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    out.ambiguous.push(`${file} could not be read (${code ?? 'unknown error'})`)
    return
  }
  if (file.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    } catch {
      out.ambiguous.push(`${file} is not valid JSON`)
    }
  }
  out.configs.push({ path: file, text: comparable(raw), parsed: commandPaths(raw) })
}

/** Read every config that can name a hook target: each host's user config, the project configs of `cwd`, and every file in the created-configs ledger (a project install records its settings file there). */
export function scanReferences(opts: ScanOptions = {}): ReferenceScan {
  const out = { configs: [] as ConfigRead[], ambiguous: [] as string[] }
  try {
    const skip = new Set((opts.skipConfigs ?? []).map((p) => foldPath(path.resolve(p))))
    const seen = new Set<string>()
    const visit = (file: string): void => {
      const key = foldPath(path.resolve(file))
      if (seen.has(key) || skip.has(key)) return
      seen.add(key)
      readConfig(path.resolve(file), out)
    }
    for (const file of hostConfigPaths(path.resolve(opts.cwd ?? process.cwd()))) visit(file)
    const ledger = readCreatedLedgerStrict()
    if (ledger.error !== undefined) out.ambiguous.push(`the created-configs ledger ${ledger.error}`)
    for (const entry of ledger.entries) {
      // A backup is a copy of a config, never a registration, and a directory holds no hook command itself.
      if (entry.includes('.bak.')) continue
      // A hook-config entry names the settings file it marks, which may be one the user created.
      const config = entry.endsWith(HOOK_CONFIG_SUFFIX) ? entry.slice(0, -HOOK_CONFIG_SUFFIX.length) : entry
      let isFile: boolean
      try {
        isFile = fs.statSync(config).isFile()
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          out.ambiguous.push(`${config} could not be examined (${code ?? 'unknown error'})`)
        }
        continue
      }
      if (isFile) visit(config)
    }
  } catch (e) {
    out.ambiguous.push(`the scan failed (${e instanceof Error ? e.message : String(e)})`)
  }
  return out
}

/** The reason `target` must be kept under `scan`, or undefined when no config names it. `target` may be a file or a directory: a directory is referenced when any config names a path inside it. */
export function referencedBy(target: string, scan: ReferenceScan): string | undefined {
  if (scan.ambiguous.length > 0) return `a config could not be checked, so it may still name it: ${scan.ambiguous[0]!}`
  const needles = new Set([comparable(path.resolve(target))])
  try {
    needles.add(comparable(fs.realpathSync.native(target)))
  } catch {
    // an absent target is matched by its spelling alone
  }
  for (const config of scan.configs) {
    for (const needle of needles) {
      const parsedNames = config.parsed.some((p) => p === needle || p.startsWith(`${needle}/`))
      if (config.text.includes(needle) || parsedNames) return `${config.path} still names it`
    }
  }
  return undefined
}

/** The reason `target` must be kept, or undefined when no config names it. One scan per call. */
export function referenceReason(target: string, opts: ScanOptions = {}): string | undefined {
  return referencedBy(target, scanReferences(opts))
}

/** True when a config still names `target`, or when that cannot be ruled out. The one question every deletion of a hook target asks. */
export function isReferenced(target: string, opts: ScanOptions = {}): boolean {
  return referenceReason(target, opts) !== undefined
}

/** Delete the hook-target file `target` unless a config still names it. Returns true only when a file was removed. A kept file is reported on stderr with the config that holds it. Scope confinement is {@link removeFileInScope}'s. */
export function removeHookTargetFile(target: string, opts: ScanOptions = {}): boolean {
  if (!fs.existsSync(target)) return false
  const why = referenceReason(target, opts)
  if (why !== undefined) {
    emitErr(`token-goat: kept ${target}: ${why}`)
    return false
  }
  return removeFileInScope(target)
}
