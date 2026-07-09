/**
 * Bash-output cache with cross-process disk persistence.
 *
 * Ports the bash-output dedup concept from `session.py` / `bash_cache.py`
 * (mark_bash_run / lookup_bash_entry): a command's full stdout is kept so a
 * later identical command can be served from cache, and so surgical re-reads
 * (`token-goat bash-output <id>`) can extract a slice without re-running it.
 *
 * A per-process `id -> entry` map fronts a content-addressed disk store
 * (`~/.token-goat/bash_outputs/<id>.json`). The hooks run as a fresh process per
 * tool call, so the disk layer is what lets a value cached by the post_tool_use
 * hook be recalled by a later pre_tool_use process and by the session-less CLI.
 * The in-memory map is cleared between tests via {@link registerReset}; the disk
 * store is pruned by age/count on each write.
 */

import { readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { normalizePath } from './paths.js'
import { shortFingerprint } from './fingerprint.js'
import { registerReset } from './reset.js'
import { runGit } from './util.js'
import { storeBlob, loadBlob } from './disk_cache.js'

/** Subdir under the token-goat home where bash-output blobs live. */
export const BASH_OUTPUT_SUBDIR = 'bash_outputs'

/** Metadata associated with a cached Bash output entry. */
export interface BashOutputMeta {
  readonly outputId: string
  readonly cmdSha: string
  readonly cmdPreview: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly exitCode: number | null
  readonly ts: number
  readonly truncated: boolean
}

/** A stored bash command invocation and its captured output. */
export interface BashOutputEntry {
  /** Stable id (16-hex SHA prefix of the normalized command). */
  readonly id: string
  /** The command string as run. */
  readonly command: string
  /** Captured stdout/combined output. */
  readonly output: string
  /** Process exit code. */
  readonly exitCode: number
  /** Unix-ms timestamp the entry was stored. */
  readonly storedAt: number
  /** Byte length of `output` (UTF-8). */
  readonly sizeBytes: number
  /** Optional fingerprints for validation on cache recall. */
  readonly fingerprints?: { git?: string; dir?: string; lockfile?: string; file?: string }
}

// id -> entry.
let _byId = new Map<string, BashOutputEntry>()


const COMMAND_PATTERNS: Record<string, RegExp> = {
  gitMutable: /^\s*git\s+(diff|status)\b/i,
  gitImmutable: /^\s*git\s+show\s+[0-9a-f]{40}\b/i,
  gitDiffUnscoped: /^\s*git\s+diff\b/i,
  gitDiffScoped: /\s--\s+\S/,
  dirListing: /^\s*(?:ls|eza|exa|dir|Get-ChildItem|gci)\b/i,
  depList: /^\s*(?:npm\s+(?:-\S+\s+)*(?:ls|list)\b|pip\s+(?:-\S+\s+)*(?:list|freeze)\b|uv\s+pip\s+(?:-\S+\s+)*(?:list|freeze)\b|pnpm\s+(?:-\S+\s+)*(?:list|ls)\b|yarn\s+(?:-\S+\s+)*(?:list)\b|cargo\s+(?:-\S+\s+)*tree\b|bundle\s+(?:-\S+\s+)*(?:list|show)\b|composer\s+(?:-\S+\s+)*show\b)/i,
  npmInstall: /^\s*npm\s+(?:-\S+\s+)*(?:install|ci)\b/i,
  npmAudit: /^\s*npm\s+(?:-\S+\s+)*audit\b(?!.*(?:--fix|fix)\b)/i,
  npmOutdated: /^\s*npm\s+(?:-\S+\s+)*outdated\b/i,
  envProbe: /^\s*(?:node\s+(?:-v|--version)|npm\s+(?:-v|--version)|python3?\s+(?:(?:-V)\b|--?version)|git\s+--version|uv\s+--version|go\s+version|rustc\s+--version|cargo\s+--version|java\s+--version|ruby\s+--version|gem\s+--version|php\s+--version|which\b|where\b)/i,
  npx: /^\s*npx\s+(?:--?yes\s+)?(?!.*\b(?:install|add|remove|uninstall|i|rm|update|upgrade|set|get|publish|link|ci|audit|shrinkwrap|dedupe|prune|rebuild)\b)/i,
  gitPush: /^\s*git\s+push\b/i,
  testRunner: /^\s*(?:npx\s+)?(?:pytest|vitest|jest|go\s+test)\b/i,
  lintCommand: /^\s*(?:(?:npx\s+)?eslint|(?:uv\s+run\s+)?ruff)\b/i,
  npmRunScript: /^\s*npm\s+run(?:-script)?\b/i,
  catCommand: /^\s*cat\b/i,
}

const DEP_LOCKFILES: Record<string, string[]> = {
  npm: ['package-lock.json', 'yarn.lock'],
  pip: ['requirements.txt'],
  uv: ['uv.lock', 'requirements.txt'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  cargo: ['Cargo.lock'],
  bundle: ['Gemfile.lock'],
  composer: ['composer.lock'],
}

export function isCommandOfType(cmd: string, type: keyof typeof COMMAND_PATTERNS): boolean {
  const pattern = COMMAND_PATTERNS[type]
  return pattern?.test(cmd) ?? false
}

// Backward-compat aliases for predicate functions
export const isGitMutableCommand = (cmd: string) => isCommandOfType(cmd, 'gitMutable')
export const isGitImmutableCommand = (cmd: string) => isCommandOfType(cmd, 'gitImmutable')
export const isDirListingCommand = (cmd: string) => isCommandOfType(cmd, 'dirListing')
export const isEnvProbeCommand = (cmd: string) => isCommandOfType(cmd, 'envProbe')
export const isDepListCommand = (cmd: string) => isCommandOfType(cmd, 'depList')
export const isNpmInstallCommand = (cmd: string) => isCommandOfType(cmd, 'npmInstall')
export const isNpmAuditCommand = (cmd: string) => isCommandOfType(cmd, 'npmAudit')
export const isNpmOutdatedCommand = (cmd: string) => isCommandOfType(cmd, 'npmOutdated')
export const isNpxCommand = (cmd: string) => isCommandOfType(cmd, 'npx')
export const isGitPushCommand = (cmd: string) => isCommandOfType(cmd, 'gitPush')
export const isTestRunnerCommand = (cmd: string) => isCommandOfType(cmd, 'testRunner')
export const isLintCommand = (cmd: string) => isCommandOfType(cmd, 'lintCommand')
export const isNpmRunScriptCommand = (cmd: string) => isCommandOfType(cmd, 'npmRunScript')
export const isCatCommand = (cmd: string) => isCommandOfType(cmd, 'catCommand')

export function isUnscopedGitDiff(cmd: string): boolean {
  if (!isCommandOfType(cmd, 'gitDiffUnscoped')) return false
  return !isCommandOfType(cmd, 'gitDiffScoped')
}

/**
 * Fingerprint HEAD plus uncommitted working-tree state: HEAD sha and a hash
 * of `git status --porcelain` (staged, unstaged, and untracked changes).
 * HEAD sha alone only changes on a commit, so a plain edit to a tracked file
 * -- never staged -- would otherwise leave the fingerprint unchanged and a
 * cached git-diff/-status (or test/lint) result would keep being served as
 * fresh after the tree it was computed against had already changed.
 *
 * Deliberately does NOT fold in `.git/index`'s mtime: `git status` can
 * itself refresh the index's on-disk stat cache as a side effect (with no
 * porcelain-visible change), so reading the index mtime around a `status`
 * call is racy and would self-invalidate on the very next check even though
 * nothing real changed. `git status --porcelain`'s output is the stable,
 * logical signal and already a superset of what the index mtime covered.
 */
function gitStateFingerprintSync(cwd: string): string | null {
  try {
    const headResult = runGit(['rev-parse', 'HEAD'], { cwd })
    if (headResult.exitCode !== 0) return null
    const headSha = headResult.stdout.trim()

    let statusHash = ''
    const statusResult = runGit(['status', '--porcelain'], { cwd })
    if (statusResult.exitCode === 0) {
      statusHash = shortFingerprint(statusResult.stdout)
    }

    const key = `${headSha}\x00${statusHash}`
    return shortFingerprint(key)
  } catch {
    return null
  }
}

/** Async wrapper kept for existing callers/tests that `await` this. */
export async function gitStateFingerprint(cwd: string): Promise<string | null> {
  return gitStateFingerprintSync(cwd)
}

function dirStateFingerprintSync(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return null
    return shortFingerprint(stat.mtimeMs.toString())
  } catch {
    return null
  }
}

/** Async wrapper kept for existing callers/tests that `await` this. */
export async function dirStateFingerprint(path: string): Promise<string | null> {
  return dirStateFingerprintSync(path)
}

/** Fingerprint a single file's mtime + size (used for `cat <file>`). */
function fileStateFingerprintSync(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    return shortFingerprint(`${stat.mtimeMs}\x00${stat.size}`)
  } catch {
    return null
  }
}

function depLockfileFingerprintSync(cmd: string, cwd: string | null): string | null {
  if (!cwd) return null
  const stripped = cmd.trim()
  const firstToken = stripped.split(/\s+/)[0]?.toLowerCase() || ''
  if (!firstToken) return null
  const candidates = firstToken === 'uv' ? DEP_LOCKFILES['uv'] : DEP_LOCKFILES[firstToken]
  if (!candidates) return null

  for (const lockfile of candidates) {
    try {
      const content = readFileSync(resolve(cwd, lockfile))
      return shortFingerprint(content)
    } catch {
      continue
    }
  }
  return null
}

/** Async wrapper kept for existing callers/tests that `await` this. */
export async function depLockfileFingerprint(cmd: string, cwd: string | null): Promise<string | null> {
  return depLockfileFingerprintSync(cmd, cwd)
}

/**
 * Normalize a command string into a stable cache-key form: collapse
 * whitespace runs to a single space, convert backslashes to forward
 * slashes, strip a leading `./` and a trailing `/` from path-like tokens.
 *
 * Quote-aware: whitespace-collapsing and backslash normalization are only
 * applied to characters outside a single- or double-quoted span, tracked
 * character-by-character (same approach as `isInsideStringLiteral` in
 * text_commands.ts / pack.ts). Applying them inside quotes would mangle
 * quoted argument content -- e.g. `echo "a   b"` and `echo "a b"` are
 * genuinely different commands but would otherwise collapse to the same
 * normalized string, and a quoted regex containing a literal backslash
 * would have it silently rewritten to a slash -- both causing distinct
 * commands to collide on the same cache key.
 */
export function normalizeCommandForCacheKey(cmd: string): string {
  const trimmed = cmd.trim()
  const tokens: string[] = []
  let current = ''
  let quoteChar: string | null = null

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (quoteChar !== null) {
      // Inside an open quote: copy verbatim, including whitespace and backslashes.
      current += ch
      if (ch === quoteChar) quoteChar = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch
      current += ch
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    current += ch === '\\' ? '/' : ch
  }
  flush()

  const normalized_tokens = tokens.map(token => {
    if (token.startsWith('-') || ['&&', '||', '|', '>', '>>', ';', '&'].includes(token)) {
      return token
    }
    if (token.startsWith('./') && !token.startsWith('../')) {
      token = token.slice(2)
    }
    if (token.endsWith('/') && token !== '/') {
      token = token.slice(0, -1)
    }
    return token || '.'
  })
  return normalized_tokens.join(' ')
}

/**
 * Return the stable hash for a command: 16-hex-char SHA-256 prefix of the
 * normalized command with cwd scoping.
 */
export async function commandHash(command: string, cwd: string | null = null): Promise<string> {
  const normalized = normalizeCommandForCacheKey(command)
  let key = cwd ? `${normalizePath(cwd)}\x00${normalized}` : normalized

  if (cwd && isGitMutableCommand(command)) {
    const fp = gitStateFingerprintSync(cwd)
    if (fp) key = `${key}\x00git:${fp}`
  }

  if (cwd && isDirListingCommand(command)) {
    const target = extractLsTarget(command, cwd)
    if (target) {
      const fp = dirStateFingerprintSync(target)
      if (fp) key = `${key}\x00dir:${fp}`
    }
  }

  if (isDepListCommand(command)) {
    const fp = depLockfileFingerprintSync(command, cwd)
    if (fp) key = `${key}\x00lockfile:${fp}`
  }

  if (cwd && isNpmInstallCommand(command)) {
    const fp = depLockfileFingerprintSync(command, cwd)
    if (fp) key = `${key}\x00npm-install:${fp}`
  }

  return shortFingerprint(key)
}

/**
 * Compute current git/dir/lockfile/file state fingerprints for `command` run
 * in `cwd`. Stored on a {@link BashOutputEntry} at write time
 * (`storeBashOutput`) and recomputed at cache-recall time
 * ({@link isBashEntryStale}) so a cached entry whose underlying source state
 * has since changed is not served as if it were still fresh.
 *
 * - `git`: git-mutable commands (`git diff`/`git status`), `git push`, and
 *   any command whose output depends on the whole working tree -- test
 *   runners (pytest/vitest/jest/go test), linters (eslint/ruff), and
 *   `npm run <script>` -- since {@link gitStateFingerprintSync} already
 *   captures staged/unstaged/untracked changes anywhere in the tree.
 * - `dir`: directory-listing commands, scoped to the listed directory's mtime.
 * - `lockfile`: dependency-list/install commands, scoped to the resolved
 *   lockfile's content.
 * - `file`: `cat <file>`, scoped to that one file's mtime + size.
 */
export function computeBashFingerprints(command: string, cwd: string | null): { git?: string; dir?: string; lockfile?: string; file?: string } | undefined {
  const fingerprints: { git?: string; dir?: string; lockfile?: string; file?: string } = {}

  if (
    cwd &&
    (isGitMutableCommand(command) ||
      isGitPushCommand(command) ||
      isTestRunnerCommand(command) ||
      isLintCommand(command) ||
      isNpmRunScriptCommand(command))
  ) {
    const fp = gitStateFingerprintSync(cwd)
    if (fp) fingerprints.git = fp
  }

  if (cwd && isDirListingCommand(command)) {
    const target = extractLsTarget(command, cwd)
    if (target) {
      const fp = dirStateFingerprintSync(target)
      if (fp) fingerprints.dir = fp
    }
  }

  if (isDepListCommand(command) || (cwd && isNpmInstallCommand(command))) {
    const fp = depLockfileFingerprintSync(command, cwd)
    if (fp) fingerprints.lockfile = fp
  }

  if (cwd && isCatCommand(command)) {
    const target = extractCatTarget(command, cwd)
    if (target) {
      const fp = fileStateFingerprintSync(target)
      if (fp) fingerprints.file = fp
    }
  }

  return Object.keys(fingerprints).length > 0 ? fingerprints : undefined
}

/**
 * True when `entry`'s stored fingerprints no longer match the current
 * git/dir/lockfile state for `command` run in `cwd` — i.e. the underlying
 * source changed since the output was cached, so it must not be recalled as
 * fresh. An entry with no stored fingerprints (a command that doesn't
 * fingerprint anything, or an entry written before this field existed) is
 * never considered stale.
 */
export function isBashEntryStale(entry: BashOutputEntry, command: string, cwd: string | null): boolean {
  const stored = entry.fingerprints
  if (!stored) return false
  const current = computeBashFingerprints(command, cwd)
  if (stored.git !== undefined && stored.git !== current?.git) return true
  if (stored.dir !== undefined && stored.dir !== current?.dir) return true
  if (stored.lockfile !== undefined && stored.lockfile !== current?.lockfile) return true
  if (stored.file !== undefined && stored.file !== current?.file) return true
  return false
}

/**
 * Split a command string into argv-like tokens, quote-aware: whitespace inside a single- or
 * double-quoted span does not split a token, and the surrounding quote characters are stripped
 * from the result. Used by {@link extractLsTarget}/{@link extractCatTarget} so a quoted path
 * with a space (e.g. `cat "release notes.txt"`) resolves to the real path instead of a garbage
 * partial token like `"release`.
 */
function tokenizeShellArgs(cmd: string): string[] {
  const trimmed = cmd.trim()
  const tokens: string[] = []
  let current = ''
  let quoteChar: string | null = null
  let hasToken = false

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (quoteChar !== null) {
      if (ch === quoteChar) {
        quoteChar = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) tokens.push(current)
  return tokens
}

function extractLsTarget(cmd: string, cwd: string): string | null {
  const tokens = tokenizeShellArgs(cmd)
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.startsWith('-')) {
      if (!token.startsWith('/')) {
        return resolve(cwd, token)
      }
      return token
    }
  }
  return cwd
}

/** Same shape as {@link extractLsTarget}, but `cat` with no file argument (reads stdin) has no sensible default target. */
function extractCatTarget(cmd: string, cwd: string): string | null {
  const tokens = tokenizeShellArgs(cmd)
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.startsWith('-')) {
      if (!token.startsWith('/')) {
        return resolve(cwd, token)
      }
      return token
    }
  }
  return null
}

/**
 * Legacy hash function for backwards compatibility. Returns 16-hex hash of
 * command with surrounding whitespace trimmed (no cwd scoping).
 */
export function hashCommand(command: string): string {
  return shortFingerprint(command.trim())
}

export function globHash(pattern: string, path: string | null): string {
  const canonical = `${pattern}\x00${path || ''}`
  return shortFingerprint(canonical)
}


/**
 * Store a command's `output` and `exitCode`, returning its id.
 *
 * The id is {@link commandHash} of the command, so re-running an identical
 * command overwrites the prior entry and keeps the same id.
 */
export async function storeBashOutput(command: string, output: string, exitCode: number, cwd: string | null = null): Promise<string> {
  const id = await commandHash(command, cwd)
  const fingerprints = computeBashFingerprints(command, cwd)
  const entry: BashOutputEntry = {
    id,
    command,
    output,
    exitCode,
    storedAt: Date.now(),
    sizeBytes: Buffer.byteLength(output, 'utf-8'),
    ...(fingerprints ? { fingerprints } : {}),
  }
  _byId.set(id, entry)
  // Persist so a later, separate hook process (and the CLI) can recall it.
  storeBlob(BASH_OUTPUT_SUBDIR, id, entry)
  return id
}

/** Coerce an untrusted parsed-JSON value into a {@link BashOutputEntry}, or null
 * when any required field is missing or the wrong type. */
function coerceBashEntry(raw: unknown): BashOutputEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (
    typeof o['id'] !== 'string' ||
    typeof o['command'] !== 'string' ||
    typeof o['output'] !== 'string' ||
    typeof o['exitCode'] !== 'number' ||
    typeof o['storedAt'] !== 'number' ||
    typeof o['sizeBytes'] !== 'number'
  ) {
    return null
  }
  const entry: BashOutputEntry = {
    id: o['id'],
    command: o['command'],
    output: o['output'],
    exitCode: o['exitCode'],
    storedAt: o['storedAt'],
    sizeBytes: o['sizeBytes'],
  }
  const rawFingerprints = o['fingerprints']
  if (rawFingerprints !== null && typeof rawFingerprints === 'object') {
    const f = rawFingerprints as Record<string, unknown>
    const fingerprints: { git?: string; dir?: string; lockfile?: string; file?: string } = {}
    if (typeof f['git'] === 'string') fingerprints.git = f['git']
    if (typeof f['dir'] === 'string') fingerprints.dir = f['dir']
    if (typeof f['lockfile'] === 'string') fingerprints.lockfile = f['lockfile']
    if (typeof f['file'] === 'string') fingerprints.file = f['file']
    if (Object.keys(fingerprints).length > 0) return { ...entry, fingerprints }
  }
  return entry
}

/**
 * Return the entry for `id`, or null if not present.
 *
 * Falls back to the disk store on an in-memory miss so a value cached by an
 * earlier hook process (or run) resolves; a disk hit is cached in-process.
 */
export function getBashOutput(id: string): BashOutputEntry | null {
  const hit = _byId.get(id)
  if (hit !== undefined) return hit
  const entry = coerceBashEntry(loadBlob(BASH_OUTPUT_SUBDIR, id))
  if (entry === null) return null
  _byId.set(id, entry)
  return entry
}

/**
 * Return the entry whose command hashes to `commandHash`, or null.
 *
 * Since the entry id is itself the command hash, this resolves via the
 * command-hash index and then the id map.
 */
export function getBashOutputByCommandHash(commandHash: string): BashOutputEntry | null {
  return getBashOutput(commandHash)
}

registerReset(() => {
  _byId = new Map()

})
