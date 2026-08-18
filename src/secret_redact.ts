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
 * All patterns are single-pass, non-backtracking (fixed-width, bounded, or a
 * single unbounded negated-class quantifier with no nesting or overlap) so a
 * redaction pass over arbitrarily large cached blobs stays linear in input
 * size — no ReDoS risk.
 */

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  // Anthropic keys share OpenAI's "sk-" prefix but are more specific
  // ("sk-ant-"), so they're matched first — the generic OpenAI pattern's
  // negative lookahead below is defense in depth, not the sole guard.
  ['anthropic_api_key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  // Modern (post-2024, now the default) OpenAI project keys: "sk-proj-" followed by a long
  // base64url-ish body that legitimately contains '-' and '_' -- the generic pattern below
  // deliberately excludes those characters (hyphenated prose would false-fire), so this needs
  // its own entry with the more specific prefix matched first, like sk-ant- above.
  ['openai_project_key', /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ['openai_api_key', /sk-(?!ant-|proj-)[A-Za-z0-9]{20,}/g],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/g],
  // Fine-grained PATs ("github_pat_...") are matched before the classic gh[oprsu]_ pattern so
  // the full token is always consumed as one match -- a fine-grained token's own body can
  // contain '_' and could otherwise partially match the classic pattern.
  ['github_token', /github_pat_[A-Za-z0-9_]{22,}/g],
  ['github_token', /gh[oprsu]_[A-Za-z0-9]{36,}/g],
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]+/g],
  // Matches the full block (BEGIN marker through its matching END marker), not just the
  // header -- the actual secret material is the base64 body between them, so redacting only
  // the header line would leave the key bytes themselves fully readable in the cached blob.
  // The lazy [\s\S]*? is bounded by the very next END marker (private key blocks don't nest),
  // so this stays linear in practice despite the lazy quantifier.
  ['private_key_block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  // Redacts only the token itself, not the "Authorization: Bearer " prefix -- the lookbehind
  // anchors on the header name and scheme so the surrounding request-log line stays readable,
  // matching how AWS_ACCESS_KEY_ID=... above keeps its own prefix intact.
  ['auth_bearer_token', /(?<=Authorization:\s*Bearer\s)[A-Za-z0-9\-._~+/]{10,}=*/gi],
  ['auth_basic_token', /(?<=Authorization:\s*Basic\s)[A-Za-z0-9+/]{6,}=*/gi],
  // JWTs have no distinctive prefix of their own, but the base64url encoding of the smallest
  // realistic header ('{"alg":' or similar) always starts with "eyJ", so that's the practical
  // anchor here -- each of the three dot-separated segments requires a minimum length to avoid
  // matching a short, coincidentally dotted token.
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['npm_token', /npm_[A-Za-z0-9]{36}/g],
  // rk_live_ (restricted keys) share the sk_live_/sk_test_ secret-key shape and risk level, so
  // one pattern covers all three rather than adding a near-duplicate entry.
  ['stripe_key', /(?:sk_live_|sk_test_|rk_live_)[A-Za-z0-9]{20,}/g],
  ['google_api_key', /AIza[A-Za-z0-9_-]{35}/g],
  // Presigned-url signatures: AWS SigV4 (X-Amz-Signature), Google Cloud Storage
  // (X-Goog-Signature), and Azure blob SAS (sig). These are bearer credentials in query-string
  // clothing -- anyone holding the whole url can read or write the object until it expires, and
  // none of the prefix-anchored patterns above match them because the signature is a bare hex or
  // base64 blob with no distinctive prefix of its own. The '[?&]' anchor and the 16-char floor
  // are what make the short, generic 'sig' name safe to key on: a prose or code mention of "sig"
  // never sits directly after a query separator followed by that much opaque token.
  ['presigned_signature', /(?<=[?&](?:X-Amz-Signature|X-Goog-Signature|sig)=)[A-Za-z0-9%+/=_-]{16,}/gi],
  // Generic key=value assignments in .env-file and connection-string/query-string shape. The
  // lookbehind again redacts only the value, and the value's character class deliberately
  // excludes whitespace, '&', ';', '#', quote characters, and '[' ']' ':' -- that exclusion is
  // what stops this from swallowing the rest of the line (a trailing comment or the next
  // key=value pair) or the remainder of a query string past the matched parameter, which is
  // exactly the kind of over-eager match this module's own design note above warns broad
  // heuristics produce. The '[' ']' ':' exclusion also matters because this pattern runs last: an
  // earlier pattern's own "OPENAI_API_KEY=[REDACTED:openai_project_key]" replacement text
  // contains "API_KEY=" too, and without excluding those characters this pattern would re-match
  // and double-redact its own placeholder. The length has a lower bound only (no upper bound):
  // capping it at 64 used to leave the tail of any longer secret unredacted in plain text, which
  // is worse than no redaction because it looks handled. A single negated-class quantifier like
  // this cannot backtrack catastrophically -- there is no nested or overlapping quantifier for
  // the engine to explore multiple ways of matching, so removing the upper bound does not
  // introduce a ReDoS risk.
  // The keyword may be a prefix of a longer key name rather than the whole of it, so the
  // trailing identifier class below is load-bearing: without it the lookbehind required the
  // keyword to sit immediately before the separator, and AWS_SECRET_ACCESS_KEY=,
  // SECRET_KEY=, and DB_PASSWORD_HASH= all passed through in full. That class matches
  // identifier characters only, so prose that merely mentions a keyword still never reaches
  // a separator and stays unredacted. api[_-]?key covers the apikey and api-key spellings too.
  ['generic_secret_assignment', /(?<=(?:password|passwd|secret|api[_-]?key)[a-z0-9_-]*\s*[:=]\s*)[^\s&;#'"[\]:]{4,}/gi],
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
