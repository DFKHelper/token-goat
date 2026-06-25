/**
 * Read-replacement: return surgical hints instead of full files.
 *
 * Ports Python's read_replacement.py: checks whether a file should be replaced
 * with a token-goat command suggestion (e.g., `token-goat read file.py::symbol`)
 * instead of reading the whole file.
 */

const _LOG = {
  warn: (msg: string, ...args: unknown[]) => console.warn(`[read_replacement] ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => console.debug(`[read_replacement] ${msg}`, ...args),
}

/**
 * Options for buildPreReadReplacement.
 */
export interface BuildPreReadReplacementOpts {
  /** Maximum file size (bytes) before suggesting surgical reads. */
  maxFileBytes?: number
}

/**
 * Result when a file should be replaced with a surgical hint.
 */
export interface PreReadReplacement {
  hint: string
}

/**
 * Build a surgical read hint for a file.
 *
 * Checks whether a file path should be replaced with a surgical command suggestion
 * (e.g., `token-goat read file.py::symbol` instead of reading the whole file).
 *
 * Returns a hint if the file path suggests a large or complex file, null otherwise.
 * The actual file size check is deferred to the caller who has that information from
 * the Read tool input (e.g., `file_size` field).
 */
export function buildPreReadReplacement(
  filePath: string | undefined,
  _sessionId?: string,
  _opts?: BuildPreReadReplacementOpts
): PreReadReplacement | null {
  if (!filePath || filePath.trim() === '') {
    return null
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || ''

  if (['py', 'ts', 'js', 'tsx', 'jsx', 'md', 'txt'].includes(ext)) {
    const hint = buildSurgicalReadHint(filePath)
    if (hint) {
      return { hint }
    }
  }

  return null
}

/**
 * Build a surgical read command hint for a file.
 *
 * Suggests `token-goat read` with symbol or section lookup for common file types.
 */
function buildSurgicalReadHint(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''

  const baseMsg = 'This file is large. Use surgical reads:'

  if (['py', 'ts', 'js', 'tsx', 'jsx'].includes(ext)) {
    return (
      baseMsg +
      `\n  token-goat read "${filePath}::symbol_name" — extract one function/class\n` +
      `  token-goat section "${filePath}::Heading" — extract one section`
    )
  }

  if (['md', 'txt'].includes(ext)) {
    return baseMsg + `\n  token-goat section "${filePath}::Heading" — extract one section`
  }

  return baseMsg + `\n  token-goat read "${filePath}::symbol_name" — extract one symbol`
}
