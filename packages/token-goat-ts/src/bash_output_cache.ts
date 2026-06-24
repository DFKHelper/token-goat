/**
 * In-memory bash-output cache.
 *
 * Ports the bash-output dedup concept from `session.py` / `bash_cache.py`
 * (mark_bash_run / lookup_bash_entry): a command's full stdout is kept so a
 * later identical command can be served from cache, and so surgical re-reads
 * (`token-goat bash-output <id>`) can extract a slice without re-running it.
 *
 * Storage is process-local: a single `id -> entry` map keyed by the
 * command hash. Cleared between tests via {@link registerReset}.
 */

import { fingerprintContent } from './fingerprint.js'
import { registerReset } from './reset.js'

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


/**
 * Return the stable hash for a command: 16-hex-char SHA-256 prefix of the
 * command with surrounding whitespace trimmed.
 *
 * Trimming normalizes incidental leading/trailing whitespace so the same
 * command run twice maps to the same id, matching the short-hash convention
 * used by `bash_cache.py`.
 */
export function hashCommand(command: string): string {
  return fingerprintContent(command.trim()).slice(0, 16)
}

/**
 * Store a command's `output` and `exitCode`, returning its id.
 *
 * The id is {@link hashCommand} of the command, so re-running an identical
 * command overwrites the prior entry and keeps the same id.
 */
export function storeBashOutput(command: string, output: string, exitCode: number): string {
  const id = hashCommand(command)
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
})
