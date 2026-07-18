/**
 * Defense-in-depth secret redaction for {@link file://./disk_cache.ts}'s
 * `storeBlob()` choke point.
 *
 * token-goat persists a lot of tool output to disk (bash-output, web-output,
 * and mcp-output caches, all funneling through `storeBlob()`). If a cached
 * tool result happens to contain a real credential (an API key echoed by a
 * misconfigured script, a token pasted into a bash command's output), it
 * would otherwise sit in plaintext under `~/.token-goat` indefinitely. This
 * module scans the JSON-serialized blob text for a small set of
 * high-confidence secret patterns and replaces each match with a fixed-width
 * placeholder before it ever reaches disk.
 *
 * Deliberately a small, high-confidence pattern set rather than an
 * exhaustive one: broad heuristics (generic "api_key=..." key/value pairs,
 * high-entropy hex/base64 blobs, bare AWS secret-access-key strings with no
 * anchoring prefix) false-fire constantly on normal code, JSON, and log
 * output, and a redaction pass that mangles ordinary content is worse for a
 * caching layer than one that misses an unusual credential format. Each
 * pattern here has a distinctive, low-collision prefix or block marker.
 *
 * `src/pack.ts` has its own `SECRET_PATTERNS` list, but it exists for a
 * different purpose (scanning project files for `token-goat pack`'s
 * report-only secret warning) and is deliberately noisier — it includes
 * generic "api_key=", "password=", and database-URL patterns that are fine
 * for a human-reviewed report but too false-positive-prone to blindly mangle
 * cached tool output. That list is also module-private. This module keeps a
 * separate, narrower set tuned for automatic in-place redaction.
 *
 * All patterns are single-pass, non-backtracking (fixed-width or bounded
 * character classes, no nested quantifiers) so a redaction pass over
 * arbitrarily large cached blobs stays linear in input size — no ReDoS risk.
 */

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  // Anthropic keys share OpenAI's "sk-" prefix but are more specific
  // ("sk-ant-"), so they're matched first — the generic OpenAI pattern's
  // negative lookahead below is defense in depth, not the sole guard.
  ['anthropic_api_key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_api_key', /sk-(?!ant-)[A-Za-z0-9]{20,}/g],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/g],
  ['github_token', /gh[oprsu]_[A-Za-z0-9]{36,}/g],
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]+/g],
  // Matches the full block (BEGIN marker through its matching END marker), not just the
  // header -- the actual secret material is the base64 body between them, so redacting only
  // the header line would leave the key bytes themselves fully readable in the cached blob.
  // The lazy [\s\S]*? is bounded by the very next END marker (private key blocks don't nest),
  // so this stays linear in practice despite the lazy quantifier.
  ['private_key_block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
]

export interface RedactResult {
  /** Text with every detected secret replaced by a `[REDACTED:<kind>]` placeholder. */
  text: string
  /** Number of secrets redacted (0 when the input had none). */
  count: number
}

/**
 * Scan `text` for high-confidence secret patterns and replace each match
 * with `[REDACTED:<kind>]`. Never partially reveals a matched secret.
 *
 * Pure and synchronous — callers decide how to handle a thrown error (regex
 * engine failures are not expected in practice given the patterns above, but
 * this function does not swallow them itself; see `storeBlob()` for the
 * fail-safe wrapping applied at the actual disk-write choke point).
 */
export function redactSecrets(text: string): RedactResult {
  let count = 0
  let out = text
  for (const [kind, pattern] of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      count++
      return `[REDACTED:${kind}]`
    })
  }
  return { text: out, count }
}
