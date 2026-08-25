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
 * All patterns are single-pass and non-backtracking: fixed-width, bounded, or a
 * single negated-class quantifier whose alternatives are disjoint, so nothing here
 * has a nested or overlapping quantifier for the engine to explore two ways.
 *
 * Every quantifier inside a lookbehind is bounded, which is a stronger requirement
 * than the rest of the pattern needs and is not decoration. A variable-length
 * lookbehind is re-evaluated at each start position, so an unbounded run inside one
 * turns the pass quadratic even though no single match backtracks: the generic
 * assignment pattern below once held `\s*` around its separator, and the literal
 * input `'password' + ' '.repeat(n) + '=!'` took 108 ms at n=20000 and 1726 ms at
 * n=80000 -- four times the work for twice the input, on a path that runs over every
 * command output before it reaches the model. Bounding the run made the same input
 * 0.5 ms and 1.9 ms. Keep quantifiers inside a lookbehind bounded.
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
  // xapp- is Slack's app-level token (Socket Mode), a bearer credential in its own right that
  // the xox[baprs]- prefix does not cover. It gets its own entry rather than joining the
  // alternation above because it needs the full segmented shape (xapp-<ver>-<app id>-<digits>-
  // <hex>) to be safe: a bare /xapp-[A-Za-z0-9-]+/ redacted ordinary identifiers like
  // "xapp-config" and the css class "xapp-container", mangling normal source. The xox* prefixes
  // are distinctive enough on their own; "xapp-" is not.
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]+/g],
  ['slack_token', /xapp-\d-[A-Za-z0-9]{6,}-\d{8,}-[A-Za-z0-9]{16,}/g],
  // Matches the full block (BEGIN marker through its matching END marker), not just the
  // header -- the actual secret material is the base64 body between them, so redacting only
  // the header line would leave the key bytes themselves fully readable in the cached blob.
  // The body is lazy and additionally refuses to cross a following BEGIN marker. Both halves
  // matter. The laziness bounds a successful match at the very next END marker; the negative
  // lookahead bounds a *failing* one, because a BEGIN with no END of its own would otherwise
  // scan to end-of-input, and a blob full of such markers made the pass quadratic -- 6 ms, 20 ms
  // and 78 ms for 2000, 4000 and 8000 of them, four times the work for twice the input, the same
  // shape as the lookbehind incident described above. Private key blocks do not nest, so
  // refusing to cross a BEGIN costs nothing in correctness.
  // The algorithm and ` BLOCK` groups are backreferenced in the END marker rather than repeated,
  // so a BEGIN only ever pairs with its own END spelling. Written as two independent optional
  // groups, `BEGIN PGP PRIVATE KEY` would happily close on a distant `END RSA PRIVATE KEY BLOCK`
  // and redact everything in between. A non-participating group backreferences as the empty
  // string in JS, which is exactly what the unprefixed `BEGIN PRIVATE KEY` form needs.
  // The algorithm list covers every armored private-key header openssl, ssh-keygen and gpg
  // actually emit, not just the ones a first draft happened to think of. ENCRYPTED is the
  // PKCS#8 passphrase-protected form (`openssl genpkey -aes256`, `ssh-keygen -m PKCS8`) and is
  // the most common shape of all; DSA is legacy but still written verbatim; PGP carries the
  // ` BLOCK` suffix, which is why that suffix is optional here. All three used to fall through
  // to disk in full. An encrypted key is still key material: the passphrase can be attacked
  // offline once the bytes are cached, so it is redacted like any other.
  // PuTTY `.ppk` files are deliberately not matched. They have no END marker -- the private
  // section is a `Private-Lines: N` count followed by exactly N base64 lines -- so bounding a
  // match would take a stateful parse rather than a regex, on a path that runs over every
  // command output. A regex guess at where the body ends is exactly the over-eager match this
  // module's header warns against.
  ['private_key_block', /-----BEGIN (RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----(?:(?!-----BEGIN )[\s\S])*?-----END \1PRIVATE KEY\2-----/g],
  // Redacts only the token itself, not the "Authorization: Bearer " prefix -- the lookbehind
  // anchors on the header name and scheme so the surrounding request-log line stays readable,
  // matching how AWS_ACCESS_KEY_ID=... above keeps its own prefix intact.
  // The optional quotes on either side of the colon are what let this see a header carried in
  // JSON rather than in raw wire format. Without them the lookbehind demanded the colon sit
  // directly against the header name and the scheme directly against the space, so a body like
  // {"Authorization": "Bearer <token>"} -- the shape any logged fetch or MCP result arrives in
  // -- matched nothing and the token was cached verbatim.
  // `token` is the second scheme spelling in wide use -- it is what curl and gh examples pass for
  // GitHub and many other APIs -- and an opaque value behind it carries exactly the same authority
  // as one behind `Bearer`. The trailing gap is `{1,8}` rather than a single space for the same
  // reason every other gap in this lookbehind already is: a hand-aligned or reformatted header
  // ("Authorization:  Bearer  <token>") is ordinary, and demanding exactly one space there made
  // this the one position in the pattern that a second space defeated.
  ['auth_bearer_token', /(?<=Authorization["']?[ \t]{0,8}:[ \t]{0,8}["']?[ \t]{0,8}(?:Bearer|token)[ \t]{1,8})[A-Za-z0-9\-._~+/]{10,}=*/gi],
  ['auth_basic_token', /(?<=Authorization["']?[ \t]{0,8}:[ \t]{0,8}["']?[ \t]{0,8}Basic[ \t])[A-Za-z0-9+/]{6,}=*/gi],
  // JWTs have no distinctive prefix of their own, but the base64url encoding of the smallest
  // realistic header ('{"alg":' or similar) always starts with "eyJ", so that's the practical
  // anchor here -- each of the three dot-separated segments requires a minimum length to avoid
  // matching a short, coincidentally dotted token.
  //
  // The trailing `={0,2}` on each segment is what makes a padded token match. Base64url as the JWT
  // spec defines it drops the `=` padding, but producers that reach for a plain base64 encoder
  // emit it anyway, and a `=` in the header or payload segment used to defeat the match outright:
  // not a partial redaction, but none at all, so the entire token was printed. `=` cannot appear
  // anywhere except the end of a segment, since it is not one of the characters the segment body
  // allows, so accepting it here cannot widen the match onto anything else.
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]{10,}={0,2}/g],
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
  // A password inside a connection url. `postgres://user:hunter2@db.internal` carries the
  // credential in the authority section, where there is no `key=value` separator for the
  // generic pattern below to anchor on, so a DATABASE_URL echoed by a failing migration or a
  // psql error went through untouched. The anchors are what keep this narrow: a scheme's `://`,
  // a userinfo segment, the colon, and a following `@`. `http://host:8080/path` has no `@` and
  // is left alone; so is any url without credentials.
  ['url_credentials', /(?<=:\/\/[^\s:@/]{1,64}:)[^\s:@/]{1,256}(?=@)/g],
  // Azure storage account connection strings (`DefaultEndpointsProtocol=https;AccountName=...;
  // AccountKey=<base64>==;EndpointSuffix=core.windows.net`) carry a full read/write key to the
  // account in the AccountKey field, and none of the generic patterns above catch it:
  // generic_secret_assignment's keyword list (password|passwd|secret|api[_-]?key|
  // access[_-]?token|refresh[_-]?token|id[_-]?token) has nothing that matches "AccountKey", and
  // an unanchored base64-shape pattern was deliberately rejected -- this module's header already
  // warns that a bare high-entropy-blob heuristic false-fires on ordinary code, JSON and log
  // output, and an 88-char base64 value is exactly the shape a hash, a compiled asset digest or a
  // generated id can also take. Anchoring on the literal `AccountKey=` field name instead keeps
  // the match specific to this one connection-string field. The value class is base64 proper
  // (letters, digits, `+`, `/`, trailing `=` padding) and none of those characters include `;`, so
  // the match terminates on its own at the `;` that starts the next `Name=` field -- unlike
  // generic_secret_assignment's separator characters (`& ; # , :`), which double as ordinary
  // credential characters and need a lookahead to tell the two roles apart, `;` is never valid
  // base64 and needs no such lookahead here. The lookbehind keeps `AccountKey=` itself in the
  // output, matching auth_bearer_token and presigned_signature above, so
  // `;EndpointSuffix=core.windows.net` after it stays fully readable too.
  // `SharedAccessKey` is the same credential one Azure service over: Service Bus, Event Hubs and
  // Relay spell it that way (`Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;
  // SharedAccessKey=<base64>`) and it carries the same authority over that namespace that
  // AccountKey does over a storage account. `SharedAccessKeyName` is a plain identifier rather
  // than a secret, and never matches: the separator in the lookbehind sits directly against the
  // key name, so the `Name` in between stops it dead.
  // The separator is spelled the way auth_bearer_token above spells its own, for the same reasons
  // that comment records having learned the hard way. Optional quotes on either side of it, so
  // the JSON and YAML forms a logged MCP result or api response actually arrives in are matched
  // rather than stopped dead at the opening quote. A bounded gap rather than exactly one space,
  // so a hand-aligned or reformatted `AccountKey = ...` in an appsettings file is not the single
  // variant that defeats the whole pattern. Case-insensitive for the same reason
  // presigned_signature is. The leading word boundary is what keeps the widened name from
  // reaching into the middle of a longer identifier such as `myaccountkey=`.
  ['azure_storage_key', /(?<=\b(?:AccountKey|SharedAccessKey)["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)[A-Za-z0-9+/]{40,}=*/gi],
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
  // Quotes are permitted around the separator, but never inside the value class. A quoted value
  // is the ordinary way secrets are written -- .env files, JSON, YAML, TOML all quote by default
  // -- and the lookbehind used to stop dead at the opening quote, so `API_KEY="..."` passed
  // through in full while the bare `API_KEY=...` was caught. The closing quote of the key name
  // blocked it from the other side too, which is what kept every JSON body unredacted. Keeping
  // quotes out of the value class is still what stops the match running past the closing quote.
  // The keyword may be a prefix of a longer key name rather than the whole of it, so the
  // trailing identifier class below is load-bearing: without it the lookbehind required the
  // keyword to sit immediately before the separator, and AWS_SECRET_ACCESS_KEY=,
  // SECRET_KEY=, and DB_PASSWORD_HASH= all passed through in full. That class matches
  // identifier characters only, so prose that merely mentions a keyword still never reaches
  // a separator and stays unredacted. api[_-]?key covers the apikey and api-key spellings too.
  // `& ; # , :` play two incompatible roles. They separate one field from the next (a query
  // string, a cookie header, an inline env list), and they are also perfectly ordinary credential
  // characters. Rejecting them outright got the first role right and the second badly wrong: the
  // match stopped at the first one and left everything after it in plain text, so
  // `password=corr&horse&battery` redacted four characters and printed the rest, and
  // `DB_PASSWORD=Aa1:xyz` matched nothing at all because the run before the `:` was under the
  // four-character floor. A tail left sitting in the open is the outcome this module's header
  // calls worse than no redaction, because it reads as handled.
  //
  // So the separator role is decided by what follows rather than assumed: one of these characters
  // ends the value only when the next thing along is another `name=` / `name:` pair, which is what
  // an actual field separator is always followed by. `,OTHER=public` and `; other=1` still end it;
  // the `&` in the middle of a passphrase does not. Whitespace, quotes and brackets are unchanged
  // -- they end a value unconditionally, which is also what keeps this pattern from re-matching
  // the `[REDACTED:...]` placeholder it just wrote.
  ['generic_secret_assignment', /(?<=(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)[a-z0-9_-]{0,64}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)(?:\\[^\n]|[^\s\\&;#,:'"[\]{}]|[&;#,:](?![ \t]*[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[:=])){4,}/gi],
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
/**
 * Count the `[REDACTED:<kind>]` placeholders present in `text`.
 *
 * `redactSecrets().count` answers "how many secrets were in the input"; this answers "how many are
 * gone from THIS string" -- and for the `secret_redacted` stat the second is the honest number,
 * because handlers rarely emit the whole redacted text. A poll-diff handler emits a suffix slice,
 * the approved-plan handler emits a truncated prefix, and several branches replace the output with
 * a notice entirely. In each of those, a secret outside the emitted region was removed by slicing,
 * truncation, or replacement -- not by redaction -- so crediting the input count would report a
 * protection that some other mechanism had already provided.
 *
 * Counting the emitted text also makes the number correct by construction for a branch nobody has
 * written yet, which a hand-computed count at each emit site is not.
 *
 * Known false positive, in the over-reporting direction: text that already contained a literal
 * `[REDACTED:foo]` before redaction ran counts as one. That is accepted rather than defended
 * against -- distinguishing them would mean diffing against the pre-redaction string, which
 * reintroduces exactly the slice-alignment problem this exists to avoid.
 */
export function countRedactionPlaceholders(text: string): number {
  return text.match(/\[REDACTED:[a-z0-9_]+\]/g)?.length ?? 0
}

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
