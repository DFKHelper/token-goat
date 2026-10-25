/** Bash-output cache with cross-process disk persistence. Ports the bash-output dedup concept from `session.py` / `bash_cache.py` (mark_bash_run / lookup_bash_entry): a command's full stdout is kept so a later identical command can be served from cache, and so surgical re-reads (`token-goat bash-output <id>`) can extract a slice without re-running it. A per-process `id -> entry` map fronts a content-addressed disk store (`~/.token-goat/bash_outputs/<id>.json`). The hooks run as a fresh process per tool call, so the disk layer is what lets a value cached by the post_tool_use hook be recalled by a later pre_tool_use process and by the session-less CLI. The in-memory map is cleared between tests via {@link registerReset}; the disk store is pruned by age/count on each write. */

import { readdirSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { normalizePath } from './paths.js'
import { shortFingerprint } from './fingerprint.js'
import { parsePorcelainZ, safeShlexSplit, skipEnvAssignments, skipGitLeadingOptions } from './git_porcelain.js'
import { registerReset } from './reset.js'
import { runGit } from './util.js'
import { storeBlob, loadBlob, isBlobStale } from './disk_cache.js'
import { isBuildCommand, isDevServerCommand, isTestRunnerCommand } from './hints/lang_patterns.js'
import { indexRecallEntry } from './recall_index.js'
import { redactSecrets } from './secret_redact.js'

/** Bound for the git calls of the state fingerprint: a stuck git must not hold the hook server, and a timeout reads as an unknown state. */
const GIT_STATE_TIMEOUT_MS = 5000

/** The git fingerprint of a repository whose state a killed git could not read: it names no state, so an entry stored under it is never served as fresh and a recall that meets it is stale (null stays for "not a repository", where nothing can change). */
const GIT_STATE_UNKNOWN = 'unknown'

/** Subdir under the token-goat home where bash-output blobs live. */
export const BASH_OUTPUT_SUBDIR = 'bash_outputs'

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
  gitDiff: /^\s*git\s+diff\b/i,
  gitImmutable: /^\s*git\s+show\s+[0-9a-f]{40}\b/i,
  gitDiffScoped: /\s--\s+\S/,
  dirListing: /^\s*(?:ls|eza|exa|dir|Get-ChildItem|gci)\b/i,
  depList: /^\s*(?:npm\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:ls|list)\b|pip\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:list|freeze)\b|uv\s+pip\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:list|freeze)\b|pnpm\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:list|ls)\b|yarn\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:list)\b|cargo\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*tree\b|bundle\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:list|show)\b|composer\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*show\b)/i,
  npmInstall: /^\s*npm\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*(?:install|ci)\b/i,
  npmAudit: /^\s*npm\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*audit\b(?!.*(?:--fix|fix)\b)/i,
  npmOutdated: /^\s*npm\s+(?:--?[a-zA-Z0-9_-]+(?:\s+|=))*outdated\b/i,
  envProbe: /^\s*(?:node\s+(?:-v|--version)|npm\s+(?:-v|--version)|python3?\s+(?:(?:-V)\b|--?version)|git\s+--version|uv\s+--version|go\s+version|rustc\s+--version|cargo\s+--version|java\s+--version|ruby\s+--version|gem\s+--version|php\s+--version|which\b|where\b)/i,
  npx: /^(?!.*\b(?:install|add|remove|uninstall|i|rm|update|upgrade|set|get|publish|link|ci|audit|shrinkwrap|dedupe|prune|rebuild)\b)\s*npx\s+(?:--?yes\s+)?/i,
  gitPush: /^\s*git\s+push\b/i,
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

/** Git's leading options (`-C <path>`, `-c k=v`, `--git-dir=...`) sit between `git` and the subcommand, and environment assignments (`FOO=1 git ...`) sit before `git`, so the git-keyed types match their subcommand word here instead of the literal `git <sub>` prefix. `operand` is the token right after the subcommand. `runDir` is only used for the directory result; the classifiers pass `''`. Null when the command is not a literal `git` invocation or does not tokenize. */
function parseGitInvocation(cmd: string, runDir: string): { subcommand: string | undefined; operand: string | undefined; dir: string } | null {
  const tokens = safeShlexSplit(cmd)
  if (tokens === null) return null
  const head = skipEnvAssignments(tokens)
  if (!/^git$/i.test(tokens[head] ?? '')) return null
  const { index, dir } = skipGitLeadingOptions(tokens, head + 1, runDir)
  return { subcommand: tokens[index], operand: tokens[index + 1], dir }
}

/** The subcommand word each git-keyed type matches once git's leading options are skipped. A type absent here, or a command that does not tokenize, falls back to its COMMAND_PATTERNS regex. */
const GIT_SUBCOMMAND_PATTERNS: Partial<Record<keyof typeof COMMAND_PATTERNS, RegExp>> = {
  gitMutable: /^(?:diff|status)\b/i,
  gitDiff: /^diff\b/i,
  gitPush: /^push\b/i,
}

/** A full object name as `git show` takes it: 40 hex digits, optionally followed by `:path` or a revision suffix, but not by more hex. */
const GIT_FULL_OBJECT_NAME_RE = /^[0-9a-f]{40}(?![0-9a-z_])/i

export function isCommandOfType(cmd: string, type: keyof typeof COMMAND_PATTERNS): boolean {
  const subcommandPattern = GIT_SUBCOMMAND_PATTERNS[type]
  if (subcommandPattern) {
    const invocation = parseGitInvocation(cmd, '')
    if (invocation) return subcommandPattern.test(invocation.subcommand ?? '')
  }
  if (type === 'gitImmutable') {
    const invocation = parseGitInvocation(cmd, '')
    if (invocation) return invocation.subcommand === 'show' && GIT_FULL_OBJECT_NAME_RE.test(invocation.operand ?? '')
  }
  const pattern = COMMAND_PATTERNS[type]
  return pattern?.test(cmd) ?? false
}

/** The directory a git-state fingerprint is read from for `cmd` run in `cwd`: the repository a leading `git -C <path>` names, else `cwd`. */
function gitRunDirOf(cmd: string, cwd: string): string {
  return parseGitInvocation(cmd, cwd)?.dir ?? cwd
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
export const isLintCommand = (cmd: string) => isCommandOfType(cmd, 'lintCommand')
export const isNpmRunScriptCommand = (cmd: string) => isCommandOfType(cmd, 'npmRunScript')
export const isCatCommand = (cmd: string) => isCommandOfType(cmd, 'catCommand')

/** A `git status` or `git diff --stat` scoped to a specific path (`... -- <path>`) is byte-identical on every rerun until either HEAD changes or the working tree changes — exactly the condition the `gitMutable` fingerprint (HEAD sha, `git status --porcelain`, and the stat of each path it lists, see gitStateFingerprintSync below) already invalidates on. `git diff` without `--stat` is excluded: a full unified diff can legitimately grow/shrink in ways a byte-exact recall would misrepresent as unchanged, so only the compact `--stat` summary form is considered cacheable here. Plain `git status` (no `--stat` flag exists for it) is always eligible once scoped. */
export function isScopedGitStatusOrDiffStatCommand(cmd: string): boolean {
  if (!isCommandOfType(cmd, 'gitMutable')) return false
  if (!isCommandOfType(cmd, 'gitDiffScoped')) return false
  if (isCommandOfType(cmd, 'gitDiff') && !/--stat\b/.test(cmd)) return false
  return true
}

/** Most changed paths whose stat {@link statusPathStats} folds in; past this the status listing alone stands for the rest, so a tree with a huge unignored folder costs a bounded number of stat calls per check. */
const STATUS_STAT_CAP = 2000

/** `path:mtimeMs:size` (or `path:-` once gone) for each path a `git status --porcelain -z` listing names, resolved against the repository root since porcelain paths always are. The listing says which files differ from HEAD, not what they hold now: a second edit to an already-modified file, or a new file beside another in an untracked folder, leaves it byte-identical. A rename's original path is not stat'd: it is gone, and the listing already names it. */
function statusPathStats(root: string, porcelainZ: string): string {
  const out: string[] = []
  for (const { path: rel } of parsePorcelainZ(porcelainZ).slice(0, STATUS_STAT_CAP)) {
    const st = statSync(resolve(root, rel), { throwIfNoEntry: false })
    out.push(st ? `${rel}:${st.mtimeMs}:${st.size}` : `${rel}:-`)
  }
  return out.join('\x00')
}

/** Fingerprint HEAD plus uncommitted working-tree state: HEAD sha, `git status --porcelain` with every untracked file listed by name, and the mtime and size of each listed path (see {@link statusPathStats}). HEAD sha alone only changes on a commit, so a plain edit to a tracked file -- never staged -- would otherwise leave the fingerprint unchanged and a cached git-diff/-status (or test/lint) result would keep being served as fresh after the tree it was computed against had already changed. Deliberately does NOT fold in `.git/index`'s mtime: `git status` can itself refresh the index's on-disk stat cache as a side effect (with no porcelain-visible change), so reading the index mtime around a `status` call is racy and would self-invalidate on the very next check even though nothing real changed. `git status --porcelain`'s output is the stable, logical signal and already a superset of what the index mtime covered. */
function gitStateFingerprintSync(cwd: string): string | null {
  try {
    const headResult = runGit(['rev-parse', '--show-toplevel', 'HEAD'], { cwd, timeoutMs: GIT_STATE_TIMEOUT_MS })
    if (headResult.unfinished) return GIT_STATE_UNKNOWN
    if (headResult.exitCode !== 0) return null
    const [root = '', headSha = ''] = headResult.stdout.trim().split(/\r?\n/)

    let statusHash = ''
    const statusResult = runGit(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd, timeoutMs: GIT_STATE_TIMEOUT_MS })
    if (statusResult.unfinished) return GIT_STATE_UNKNOWN
    if (statusResult.exitCode === 0) {
      statusHash = shortFingerprint(`${statusResult.stdout}\x00${statusPathStats(root, statusResult.stdout)}`)
    }

    const key = `${headSha}\x00${statusHash}`
    return shortFingerprint(key)
  } catch {
    return null
  }
}

/** Directories at/under this many entries are fingerprinted by their entry-name listing (exact, immune to the same-mtime-tick race a fast successive write/rm inside the dir can trigger); larger directories fall back to mtime to avoid a full readdir on every staleness check. */
const DIR_FINGERPRINT_LISTING_CAP_ENTRIES = 10_000

function dirStateFingerprintSync(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return null
    const entries = readdirSync(path)
    if (entries.length <= DIR_FINGERPRINT_LISTING_CAP_ENTRIES) {
      return shortFingerprint(entries.slice().sort().join('\x00'))
    }
    return shortFingerprint(stat.mtimeMs.toString())
  } catch {
    return null
  }
}

/** Files at/under this size are fingerprinted by content hash (exact, immune to the same-mtime-tick/same-size race a fast successive write can trigger); larger files fall back to mtime+size to avoid a full read on every staleness check. */
const FILE_FINGERPRINT_CONTENT_CAP_BYTES = 2 * 1024 * 1024

function fileStateFingerprintSync(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    if (stat.size <= FILE_FINGERPRINT_CONTENT_CAP_BYTES) {
      return shortFingerprint(readFileSync(path))
    }
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

/** Normalize a command string into a stable cache-key form: collapse whitespace runs to a single space, convert backslashes to forward slashes, strip a leading `./` and a trailing `/` from path-like tokens. Quote-aware: whitespace-collapsing and backslash normalization are only applied to characters outside a single- or double-quoted span, tracked character-by-character (same approach as `isInsideStringLiteral` in text_commands.ts / pack.ts). Applying them inside quotes would mangle quoted argument content -- e.g. `echo "a   b"` and `echo "a b"` are genuinely different commands but would otherwise collapse to the same normalized string, and a quoted regex containing a literal backslash would have it silently rewritten to a slash -- both causing distinct commands to collide on the same cache key. */
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

/** Return the stable hash for a command: 16-hex-char SHA-256 prefix of the normalized command with cwd scoping. The async {@link commandHash} below is the long-standing public name and stays; this is the same body, exposed synchronously for callers that must finish the write before their (very short-lived) hook process exits. Every fingerprint helper it reaches for is already a `*Sync` one, so nothing is lost by dropping the promise. */
export function commandHashSync(command: string, cwd: string | null = null, gitState: () => string | null = () => (cwd ? gitStateFingerprintSync(gitRunDirOf(command, cwd)) : null)): string {
  const normalized = normalizeCommandForCacheKey(command)
  let key = cwd ? `${normalizePath(cwd)}\x00${normalized}` : normalized

  if (cwd && isGitMutableCommand(command)) {
    const fp = gitState()
    if (fp) key = `${key}\x00git:${fp}`
  }

  if (cwd && isDirListingCommand(command)) {
    const target = extractFirstPathArg(command, cwd, cwd)
    if (target) {
      const fp = dirStateFingerprintSync(target)
      if (fp) key = `${key}\x00dir:${fp}`
    }
  }

  if (isDepListCommand(command)) {
    const fp = depLockfileFingerprintSync(command, cwd)
    if (fp) key = `${key}\x00lockfile:${fp}`
  }

  // npm audit/outdated output depends on the resolved lockfile exactly like npm install does (both isNpmAuditCommand and isNpmOutdatedCommand's patterns existed with zero call sites until this wiring), so a cached result must key-scope on it too -- otherwise `npm install` adding a vulnerable package would never invalidate a previously cached `npm audit` result.
  if (cwd && (isNpmInstallCommand(command) || isNpmAuditCommand(command) || isNpmOutdatedCommand(command))) {
    const fp = depLockfileFingerprintSync(command, cwd)
    if (fp) key = `${key}\x00npm-install:${fp}`
  }

  return shortFingerprint(key)
}

/** Promise-returning alias for {@link commandHashSync}, kept for existing callers. */
export function commandHash(command: string, cwd: string | null = null): Promise<string> {
  return Promise.resolve(commandHashSync(command, cwd))
}

/** Blob id for one invocation's output: {@link commandHashSync} folded together with the output bytes. The command hash alone collapses every run of one command in one cwd onto a single id, so a later run with different output overwrote the body an already-emitted `bash-output <id> --full` notice described and that notice silently started resolving to text it never named. Folding the output in gives each distinct body its own id, so an older notice keeps resolving to the body it described; {@link storeBashOutputSync} still leaves the command hash resolvable as a lookup key for callers that only know the command. */
export function bashOutputIdSync(command: string, output: string, cwd: string | null = null): string {
  return outputIdFromCommandHash(commandHashSync(command, cwd), output)
}

/** The id {@link bashOutputIdSync} derives, for a caller that already holds the command hash. */
function outputIdFromCommandHash(commandKey: string, output: string): string {
  return shortFingerprint(`${commandKey}\x00${output}`)
}

/** Compute current git/dir/lockfile/file state fingerprints for `command` run in `cwd`. Stored on a {@link BashOutputEntry} at write time (`storeBashOutput`) and recomputed at cache-recall time ({@link isBashEntryStale}) so a cached entry whose underlying source state has since changed is not served as if it were still fresh. - `git`: git-mutable commands (`git diff`/`git status`), `git push`, and any command whose output depends on the whole working tree -- test runners (the {@link isTestRunnerCommand} the failing-test advisory in hooks_bash_post.ts stores a run under, bare `npm test`/`yarn test`/`pnpm test` included), linters (eslint/ruff), the dev servers and bundlers the monitoring list recalls ({@link isDevServerCommand}), and `npm run <script>` -- since {@link gitStateFingerprintSync} already captures staged/unstaged/untracked changes anywhere in the tree. - `dir`: directory-listing commands, scoped to the listed directory's entry-name listing. - `lockfile`: dependency-list/install/audit/outdated commands, scoped to the resolved lockfile's content. - `file`: `cat <file>`, scoped to that one file's mtime + size. */
export function computeBashFingerprints(command: string, cwd: string | null, gitState: () => string | null = () => (cwd ? gitStateFingerprintSync(gitRunDirOf(command, cwd)) : null)): { git?: string; dir?: string; lockfile?: string; file?: string } | undefined {
  const fingerprints: { git?: string; dir?: string; lockfile?: string; file?: string } = {}

  if (
    cwd &&
    (isGitMutableCommand(command) ||
      isGitPushCommand(command) ||
      isTestRunnerCommand(command) ||
      isLintCommand(command) ||
      isBuildCommand(command) ||
      isDevServerCommand(command) ||
      isNpmRunScriptCommand(command))
  ) {
    const fp = gitState()
    if (fp) fingerprints.git = fp
  }

  if (cwd && isDirListingCommand(command)) {
    const target = extractFirstPathArg(command, cwd, cwd)
    if (target) {
      const fp = dirStateFingerprintSync(target)
      if (fp) fingerprints.dir = fp
    }
  }

  if (isDepListCommand(command) || (cwd && (isNpmInstallCommand(command) || isNpmAuditCommand(command) || isNpmOutdatedCommand(command)))) {
    const fp = depLockfileFingerprintSync(command, cwd)
    if (fp) fingerprints.lockfile = fp
  }

  if (cwd && isCatCommand(command)) {
    const target = extractFirstPathArg(command, cwd, null)
    if (target) {
      const fp = fileStateFingerprintSync(target)
      if (fp) fingerprints.file = fp
    }
  }

  return Object.keys(fingerprints).length > 0 ? fingerprints : undefined
}

/** True when `entry`'s stored fingerprints no longer match the current git/dir/lockfile state for `command` run in `cwd` — i.e. the underlying source changed since the output was cached, so it must not be recalled as fresh. An entry with no stored fingerprints (a command that doesn't fingerprint anything, or an entry written before this field existed) is never considered stale. */
export function isBashEntryStale(entry: BashOutputEntry, command: string, cwd: string | null): boolean {
  const stored = entry.fingerprints
  if (!stored) return false
  const current = computeBashFingerprints(command, cwd)
  if (stored.git !== undefined && (stored.git === GIT_STATE_UNKNOWN || stored.git !== current?.git)) return true
  if (stored.dir !== undefined && stored.dir !== current?.dir) return true
  if (stored.lockfile !== undefined && stored.lockfile !== current?.lockfile) return true
  if (stored.file !== undefined && stored.file !== current?.file) return true
  return false
}

/** Split a command string into argv-like tokens, quote-aware: whitespace inside a single- or double-quoted span does not split a token, and the surrounding quote characters are stripped from the result. Used by {@link extractFirstPathArg} so a quoted path with a space (e.g. `cat "release notes.txt"`) resolves to the real path instead of a garbage partial token like `"release`. */
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

/** First non-flag argument of `cmd`, resolved against `cwd`. `fallback` is returned when no such argument exists -- `ls`'s implicit target is the cwd itself, while `cat` with no file argument reads stdin and has no sensible default target. */
function extractFirstPathArg(cmd: string, cwd: string, fallback: string | null): string | null {
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
  return fallback
}

/** A line that looks like it reports a problem: generic error/failure/warning marker, not tied to any specific test-runner or linter's output format. */
const ISSUE_LINE_PATTERN = /\b(?:error|fail(?:ed|ure)?|warning)\b/i

/** A generic, structural summary of the difference between a repeat command's cached prior output and its fresh output — folds a large rerun diff (test runner, linter, build tool, ...) into a short delta instead of repeating the full new output. Comparison is exact-line-match only; there is no tool-specific parsing of any particular runner's summary format. When the prior output contains at least one line matching a generic error/failure/warning marker ({@link ISSUE_LINE_PATTERN}), reports how many of those exact lines are no longer present verbatim in the new output ("resolved") against how many such lines remain in the new output. This is a conservative approximation — it counts exact line matches, not causally "the same issue" — but requires no knowledge of any specific tool's format. Otherwise (no issue-shaped lines to track) falls back to a plain line-count delta. Returns null when the two outputs are byte-identical (nothing to summarize). */
export function summarizeOutputDelta(oldOutput: string, newOutput: string): string | null {
  if (oldOutput === newOutput) return null
  const oldLines = oldOutput.split('\n')
  const newLines = newOutput.split('\n')
  const oldIssueLines = oldLines.filter((l) => ISSUE_LINE_PATTERN.test(l))
  if (oldIssueLines.length > 0) {
    const newIssueLines = newLines.filter((l) => ISSUE_LINE_PATTERN.test(l))
    const priorTotal = oldIssueLines.length
    // Multiset (count-aware) matching, not a Set membership check: a Set collapses repeated identical issue lines (e.g. the same "error: foo.ts:10 unexpected token" reported N times by a linter across N files) into one entry, so `.has(l)` reports true as long as ANY one instance survives -- silently undercounting `resolved` (every duplicate instance that actually disappeared gets counted as "still present" just because a sibling duplicate remains) whenever a repeat command's issue output contains any duplicate line. Consuming one available count per old-line match, rather than checking Set membership, correctly credits each individually-resolved duplicate instance.
    const availableCounts = new Map<string, number>()
    for (const l of newIssueLines) availableCounts.set(l, (availableCounts.get(l) ?? 0) + 1)
    let resolved = 0
    for (const l of oldIssueLines) {
      const avail = availableCounts.get(l) ?? 0
      if (avail > 0) {
        availableCounts.set(l, avail - 1)
      } else {
        resolved++
      }
    }
    const remaining = newIssueLines.length
    return `[token-goat: delta] ${resolved} of ${priorTotal} prior issues resolved; remaining: ${remaining}`
  }
  return `[token-goat: delta] output changed: ${oldLines.length} -> ${newLines.length} lines`
}

/** Store a command's `output` and `exitCode`, returning its id. The id is {@link bashOutputIdSync}, which folds the output into the command hash, so re-running the same command with different output stores a new entry beside the old one rather than overwriting it -- a recall pointer already handed to the model keeps resolving to the body it described. A redirect blob at the plain {@link commandHash} is refreshed to point at the newest entry, so callers that know only the command (cross-run delta folding, `token-goat waste`) still resolve the latest through {@link getBashOutput}. */
export function storeBashOutputSync(command: string, output: string, exitCode: number, cwd: string | null = null): string {
  // The git state costs two git spawns and is the same for the command hash and the fingerprints below, so it is read once, and only if one of them asks for it.
  let gitState: { value: string | null } | null = null
  const gitStateOnce = (): string | null => (gitState ??= { value: cwd ? gitStateFingerprintSync(gitRunDirOf(command, cwd)) : null }).value
  const commandKey = commandHashSync(command, cwd, gitStateOnce)
  const id = outputIdFromCommandHash(commandKey, output)
  const fingerprints = computeBashFingerprints(command, cwd, gitStateOnce)
  // Redact once and reuse everywhere -- storeBlob() applies its own defense-in-depth redaction pass to the JSON it writes to disk, but the in-memory _byId cache and the recall index write below both bypassed that pass entirely (served/indexed raw output), leaking secrets via same-process reads and `token-goat recall`/FTS search. Redacting here keeps disk, in-memory, and the recall index all consistent.
  const redactedOutput = redactSecrets(output).text
  // The command line itself can carry a secret too (e.g. `curl -H "Authorization: Bearer sk-ant-..."`), not just its output. storeBlob()'s whole-JSON redaction pass would strip it from the on-disk blob's `command` field, but the in-memory `entry.command` below and the recall index write both bypassed that pass entirely for the command text specifically -- only the output half of this same fix was ever applied. Redacting here closes that gap the same way the output redaction above already did.
  const redactedCommand = redactSecrets(command).text
  const entry: BashOutputEntry = {
    id,
    command: redactedCommand,
    output: redactedOutput,
    exitCode,
    storedAt: Date.now(),
    sizeBytes: Buffer.byteLength(redactedOutput, 'utf-8'),
    ...(fingerprints ? { fingerprints } : {}),
  }
  _byId.set(id, entry)
  _byId.set(commandKey, entry)
  // Persist so a later, separate hook process (and the CLI) can recall it.
  storeBlob(BASH_OUTPUT_SUBDIR, id, entry)
  // The redirect carries no body of its own, so refreshing it costs a few dozen bytes and never displaces a cached output under the subdir's byte budget.
  if (commandKey !== id) storeBlob(BASH_OUTPUT_SUBDIR, commandKey, { latestId: id } satisfies BashOutputRedirect)
  // Keep the cross-cache recall index (`token-goat recall`) current -- see recall_index.ts.
  indexRecallEntry('bash', id, redactedCommand, `${redactedCommand}\n${redactedOutput}`, entry.storedAt)
  return id
}

/** A blob that names the newest entry for one command hash instead of holding a body itself. See {@link storeBashOutputSync}. */
interface BashOutputRedirect {
  latestId: string
}

/** The redirect target in an untrusted parsed-JSON blob, or null when the blob is not a redirect. */
function coerceBashRedirect(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const latest = (raw as Record<string, unknown>)['latestId']
  return typeof latest === 'string' && latest.length > 0 ? latest : null
}

/** Promise-returning alias for {@link storeBashOutputSync}, kept for existing callers. */
export function storeBashOutput(command: string, output: string, exitCode: number, cwd: string | null = null): Promise<string> {
  return Promise.resolve(storeBashOutputSync(command, output, exitCode, cwd))
}

/** Coerce an untrusted parsed-JSON value into a {@link BashOutputEntry}, or null when any required field is missing or the wrong type. */
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

/** Return the entry for `id`, or null if not present. Falls back to the disk store on an in-memory miss so a value cached by an earlier hook process (or run) resolves; a disk hit is cached in-process. Returns null if the disk entry is older than DEFAULT_MAX_AGE_MS (stale cache) -- pruneBlobs only evicts stale entries when a *new* value is stored to the same subdir, so a quiet period with no new bash-cache writes would otherwise leave an arbitrarily old entry servable, matching the read-time TTL check web_cache.ts's getWebOutput already applies. */
export function getBashOutput(id: string): BashOutputEntry | null {
  const hit = _byId.get(id)
  if (hit !== undefined) return hit

  if (isBlobStale(BASH_OUTPUT_SUBDIR, id)) return null

  const raw = loadBlob(BASH_OUTPUT_SUBDIR, id)
  // A redirect stands where a command hash used to address the body directly, so a caller holding only the command still reaches the newest entry. Followed exactly once, never as a chain: only storeBashOutputSync writes redirects and it always points them at a content-addressed id, which holds an entry.
  const target = coerceBashRedirect(raw)
  if (target !== null) {
    if (isBlobStale(BASH_OUTPUT_SUBDIR, target)) return null
    const latest = coerceBashEntry(loadBlob(BASH_OUTPUT_SUBDIR, target))
    if (latest === null) return null
    _byId.set(target, latest)
    _byId.set(id, latest)
    return latest
  }

  const entry = coerceBashEntry(raw)
  if (entry === null) return null
  _byId.set(id, entry)
  return entry
}

registerReset(() => {
  _byId = new Map()

}, { perRequest: true })
