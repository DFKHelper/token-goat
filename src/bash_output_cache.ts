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

import * as fs from 'fs/promises'
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
}

// id -> entry.
let _byId = new Map<string, BashOutputEntry>()
let _globsByKey = new Map<string, string>()
let _grepsByKey = new Map<string, string>()


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

export function isUnscopedGitDiff(cmd: string): boolean {
  if (!isCommandOfType(cmd, 'gitDiffUnscoped')) return false
  return !isCommandOfType(cmd, 'gitDiffScoped')
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
    return shortFingerprint(key)
  } catch {
    return null
  }
}

export async function dirStateFingerprint(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isDirectory()) return null
    return shortFingerprint(stat.mtimeMs.toString())
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
      return shortFingerprint(content)
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

  return shortFingerprint(key)
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
  return shortFingerprint(command.trim())
}

export function globHash(pattern: string, path: string | null): string {
  const canonical = `${pattern}\x00${path || ''}`
  return shortFingerprint(canonical)
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
  return {
    id: o['id'],
    command: o['command'],
    output: o['output'],
    exitCode: o['exitCode'],
    storedAt: o['storedAt'],
    sizeBytes: o['sizeBytes'],
  }
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
  _globsByKey = new Map()
  _grepsByKey = new Map()
})
