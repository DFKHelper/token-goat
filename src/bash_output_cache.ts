/**
 * In-memory bash-output cache with disk persistence.
 *
 * Ports the bash-output dedup concept from `session.py` / `bash_cache.py`
 * (mark_bash_run / lookup_bash_entry): a command's full stdout is kept so a
 * later identical command can be served from cache, and so surgical re-reads
 * (`token-goat bash-output <id>`) can extract a slice without re-running it.
 *
 * Storage is process-local: a single `id -> entry` map keyed by the
 * command hash. Cleared between tests via {@link registerReset}.
 * Disk persistence via sidecar JSON metadata.
 */

import * as fs from 'fs/promises'
import { resolve } from 'path'
import { normalizePath } from './paths.js'
import { fingerprintContent } from './fingerprint.js'
import { registerReset } from './reset.js'
import { runGit } from './util.js'

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
}

// id -> entry.
let _byId = new Map<string, BashOutputEntry>()
let _globsByKey = new Map<string, string>()
let _grepsByKey = new Map<string, string>()


const GIT_MUTABLE_RE = /^\s*git\s+(diff|status)\b/i
const GIT_IMMUTABLE_RE = /^\s*git\s+show\s+[0-9a-f]{40}\b/i
const GIT_DIFF_UNSCOPED_RE = /^\s*git\s+diff\b/i
const GIT_DIFF_SCOPED_RE = /\s--\s+\S/
const LS_CMD_RE = /^\s*(?:ls|eza|exa|dir|Get-ChildItem|gci)\b/i
const DEP_LIST_RE = /^\s*(?:npm\s+(?:-\S+\s+)*(?:ls|list)\b|pip\s+(?:-\S+\s+)*(?:list|freeze)\b|uv\s+pip\s+(?:-\S+\s+)*(?:list|freeze)\b|pnpm\s+(?:-\S+\s+)*(?:list|ls)\b|yarn\s+(?:-\S+\s+)*(?:list)\b|cargo\s+(?:-\S+\s+)*tree\b|bundle\s+(?:-\S+\s+)*(?:list|show)\b|composer\s+(?:-\S+\s+)*show\b)/i
const NPM_INSTALL_RE = /^\s*npm\s+(?:-\S+\s+)*(?:install|ci)\b/i
const NPM_AUDIT_RE = /^\s*npm\s+(?:-\S+\s+)*audit\b(?!.*(?:--fix|fix)\b)/i
const NPM_OUTDATED_RE = /^\s*npm\s+(?:-\S+\s+)*outdated\b/i
const ENV_PROBE_RE = /^\s*(?:node\s+(?:-v|--version)|npm\s+(?:-v|--version)|python3?\s+(?:(?:-V)\b|--?version)|git\s+--version|uv\s+--version|go\s+version|rustc\s+--version|cargo\s+--version|java\s+--version|ruby\s+--version|gem\s+--version|php\s+--version|which\b|where\b)/i
const NPX_RE = /^\s*npx\s+(?:--?yes\s+)?(?!.*\b(?:install|add|remove|uninstall|i|rm|update|upgrade|set|get|publish|link|ci|audit|shrinkwrap|dedupe|prune|rebuild)\b)/i

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

export function isGitMutableCommand(cmd: string): boolean {
  return GIT_MUTABLE_RE.test(cmd)
}

export function isGitImmutableCommand(cmd: string): boolean {
  return GIT_IMMUTABLE_RE.test(cmd)
}

export function isDirListingCommand(cmd: string): boolean {
  return LS_CMD_RE.test(cmd)
}

export function isEnvProbeCommand(cmd: string): boolean {
  return ENV_PROBE_RE.test(cmd)
}

export function isDepListCommand(cmd: string): boolean {
  return DEP_LIST_RE.test(cmd)
}

export function isNpmInstallCommand(cmd: string): boolean {
  return NPM_INSTALL_RE.test(cmd)
}

export function isNpmAuditCommand(cmd: string): boolean {
  return NPM_AUDIT_RE.test(cmd)
}

export function isNpmOutdatedCommand(cmd: string): boolean {
  return NPM_OUTDATED_RE.test(cmd)
}

export function isNpxCommand(cmd: string): boolean {
  return NPX_RE.test(cmd)
}

export function isUnscopedGitDiff(cmd: string): boolean {
  if (!GIT_DIFF_UNSCOPED_RE.test(cmd)) return false
  return !GIT_DIFF_SCOPED_RE.test(cmd)
}

export async function gitStateFingerprint(cwd: string): Promise<string | null> {
  try {
    const headResult = runGit(['rev-parse', 'HEAD'], { cwd })
    if (headResult.exitCode !== 0) return null
    const headSha = headResult.stdout.trim()

    let indexMtime = ''
    try {
      const stat = await fs.stat(resolve(cwd, '.git', 'index'))
      indexMtime = stat.mtimeMs.toString()
    } catch {
      // index file may not exist yet
    }

    const key = `${headSha}\x00${indexMtime}`
    return fingerprintContent(key).slice(0, 16)
  } catch {
    return null
  }
}

export async function dirStateFingerprint(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isDirectory()) return null
    return fingerprintContent(stat.mtimeMs.toString()).slice(0, 16)
  } catch {
    return null
  }
}

export async function depLockfileFingerprint(cmd: string, cwd: string | null): Promise<string | null> {
  if (!cwd) return null
  const stripped = cmd.trim()
  const firstToken = stripped.split(/\s+/)[0]?.toLowerCase() || ''
  if (!firstToken) return null
  const candidates = firstToken === 'uv' ? DEP_LOCKFILES['uv'] : DEP_LOCKFILES[firstToken]
  if (!candidates) return null

  for (const lockfile of candidates) {
    try {
      const content = await fs.readFile(resolve(cwd, lockfile))
      return fingerprintContent(content).slice(0, 16)
    } catch {
      continue
    }
  }
  return null
}

export function normalizeCommandForCacheKey(cmd: string): string {
  let normalized = cmd.trim()
  normalized = normalized.replace(/\s+/g, ' ')
  normalized = normalized.replace(/\\/g, '/')

  const tokens = normalized.split(' ')
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
    const fp = await gitStateFingerprint(cwd)
    if (fp) key = `${key}\x00git:${fp}`
  }

  if (cwd && isDirListingCommand(command)) {
    const target = extractLsTarget(command, cwd)
    if (target) {
      const fp = await dirStateFingerprint(target)
      if (fp) key = `${key}\x00dir:${fp}`
    }
  }

  if (isDepListCommand(command)) {
    const fp = await depLockfileFingerprint(command, cwd)
    if (fp) key = `${key}\x00lockfile:${fp}`
  }

  if (cwd && isNpmInstallCommand(command)) {
    const fp = await depLockfileFingerprint(command, cwd)
    if (fp) key = `${key}\x00npm-install:${fp}`
  }

  return fingerprintContent(key).slice(0, 16)
}

function extractLsTarget(cmd: string, cwd: string): string | null {
  const tokens = cmd.trim().split(/\s+/)
  for (let i = 1; i < tokens.length; i++) {
    if (!tokens[i]!.startsWith('-')) {
      return tokens[i]!
    }
  }
  return cwd
}

/**
 * Legacy hash function for backwards compatibility. Returns 16-hex hash of
 * command with surrounding whitespace trimmed (no cwd scoping).
 */
export function hashCommand(command: string): string {
  return fingerprintContent(command.trim()).slice(0, 16)
}

export function globHash(pattern: string, path: string | null): string {
  const canonical = `${pattern}\x00${path || ''}`
  return fingerprintContent(canonical).slice(0, 16)
}

export function storeGlobResult(sessionId: string, pattern: string, path: string | null, resultText: string): string {
  const hash = globHash(pattern, path)
  const key = `${sessionId}:${hash}`
  _globsByKey.set(key, resultText)
  return hash
}

export function getBashGlobResult(sessionId: string, pattern: string, path: string | null): string | null {
  const hash = globHash(pattern, path)
  const key = `${sessionId}:${hash}`
  return _globsByKey.get(key) ?? null
}

/**
 * Store a command's `output` and `exitCode`, returning its id.
 *
 * The id is {@link commandHash} of the command, so re-running an identical
 * command overwrites the prior entry and keeps the same id.
 */
export async function storeBashOutput(command: string, output: string, exitCode: number, cwd: string | null = null): Promise<string> {
  const id = await commandHash(command, cwd)
  const entry: BashOutputEntry = {
    id,
    command,
    output,
    exitCode,
    storedAt: Date.now(),
    sizeBytes: Buffer.byteLength(output, 'utf-8'),
  }
  _byId.set(id, entry)
  return id
}

/** Return the entry for `id`, or null if not present. */
export function getBashOutput(id: string): BashOutputEntry | null {
  return _byId.get(id) ?? null
}

/**
 * Return the entry whose command hashes to `commandHash`, or null.
 *
 * Since the entry id is itself the command hash, this resolves via the
 * command-hash index and then the id map.
 */
export function getBashOutputByCommandHash(commandHash: string): BashOutputEntry | null {
  return _byId.get(commandHash) ?? null
}

registerReset(() => {
  _byId = new Map()
  _globsByKey = new Map()
  _grepsByKey = new Map()
})
