// Filter framework base: `CompressedOutput` result type + the `ToolFilter` base class with the universal `apply()` pipeline every per-tool filter runs.
//
// Ported faithfully from the Python `bash_compress.py` `Filter` / `apply` contract. Per-tool filters (and the family factories) subclass `ToolFilter`, declare `binaries` / `subcommands`, and override `compressBody` (or `compress` for filters that handle non-zero exits structurally). The base pipeline owns normalisation, input/line/byte caps, and the trailing marker.

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  MAX_INSPECT_BYTES,
  byteLength,
  capBytes,
  combineStreams,
  compressBashOutput,
  compressionMarker,
  capLongLines,
  fallbackTruncate,
  clampKeepingEnds,
  clipWideLines,
  INPUT_MAX_LINE_CHARS,
  getMaxInputBytes,
  LONG_LINE_MAX_CHARS,
  normalise,
  pathName,
  pathStem,
  positionalArgs,
  preserveStderrOnError,
  safeDecode,
  squeezeBlankLines,
  truncateMiddleSmart,
} from './helpers.js'
import { redactSecrets } from '../secret_redact.js'
import { loadConfig } from '../config.js'
import { savedTokensFromBytes } from '../stats.js'

/**
 * Default `bash_compress.min_net_savings_bytes` floor, used when config fails
 * to load. Mirrored here (not just in config.ts's own default) because
 * {@link resolveMinNetSavingsBytes} must still return a sane value when
 * `loadConfig()` itself throws.
 */
const DEFAULT_MIN_NET_SAVINGS_BYTES = 100

/**
 * Resolve the net-benefit floor (bytesSaved minus the rewrite's own
 * notice/marker cost) a rewrite must clear to ship, from
 * `bash_compress.min_net_savings_bytes`. This is the single resolver every
 * output-rewriting hook consults — originally private to `bash_runner.ts`,
 * hoisted here so every consumer of {@link isRewriteWorthwhile} shares the
 * same config read and fallback instead of re-deriving it.
 *
 * The config key lives under `bash_compress` for historical reasons (it was
 * introduced for the Bash-output compression filter pipeline first), but the
 * question it answers — "is this net saving worth destabilising bytes that
 * could otherwise be served from the provider's cached prefix?" — applies
 * identically to every rewrite path in this codebase, so it is reused
 * wholesale rather than forked into per-path config families.
 */
export function resolveMinNetSavingsBytes(): number {
  try {
    return loadConfig().bash_compress.min_net_savings_bytes
  } catch {
    return DEFAULT_MIN_NET_SAVINGS_BYTES
  }
}

/** Inputs to {@link isRewriteWorthwhile}. */
export interface RewriteWorthwhileInput {
  /** Byte size of the content that would otherwise be shipped untouched. */
  originalBytes: number
  /** Byte size of the replacement body, EXCLUDING any notice/marker text. */
  rewrittenBytes: number
  /** Byte cost of the notice/marker text the rewrite would add. */
  noticeBytes: number
  /** Configured floor (see {@link resolveMinNetSavingsBytes}). */
  minNetSavingsBytes: number
}

/**
 * Single shared definition of "is this rewrite worth shipping", usable by any
 * call site that swaps a tool result for a smaller one plus some notice —
 * not just {@link CompressedOutput.worthApplying}'s bash-filter case. A
 * rewrite is worthwhile only when it has non-negative original bytes, a
 * strictly positive raw saving (`originalBytes - rewrittenBytes`), and that
 * saving still clears `minNetSavingsBytes` after paying for its own notice.
 */
export function isRewriteWorthwhile({
  originalBytes,
  rewrittenBytes,
  noticeBytes,
  minNetSavingsBytes,
}: RewriteWorthwhileInput): boolean {
  if (originalBytes <= 0) return false
  const bytesSaved = Math.max(0, originalBytes - rewrittenBytes)
  if (bytesSaved <= 0) return false
  return bytesSaved - noticeBytes >= minNetSavingsBytes
}

/**
 * Result of running a {@link ToolFilter} over a captured command output.
 *
 * `text` is the compressed body (no trailing newline — the wrapper adds one).
 * `originalBytes` is `stdout + stderr` size post-decode / pre-filter, so
 * `percentSaved` reflects the true reduction the model sees.
 */
/** Token savings for a byte delta credited by a bash-output compression filter: delegates to {@link savedTokensFromBytes} (bytes/4, stats.ts's single pricing constant) rather than defining its own divisor. This used to divide by 3 (the `estimateTokensFromLength` overflow-guard estimator's ratio, deliberately conservative-high for a budget check, which is the wrong direction for a credit -- see the comment on `savedTokensFromBytes`), which booked every `bash_compress:*` kind roughly a third richer than every sibling kind in the same summed column. Exported so a caller that must recompute the figure against a different byte delta -- notably a delta capped at the harness delivery cap, see `deliveredOutputBytes` in src/delivery_cap.ts -- prices it by the same rule rather than deriving a second one that can drift. */
export function compressedTokensSaved(bytesSaved: number): number {
  return bytesSaved <= 0 ? 0 : Math.max(1, savedTokensFromBytes(bytesSaved))
}

export class CompressedOutput {
  constructor(
    readonly text: string,
    readonly originalBytes: number,
    readonly compressedBytes: number,
    readonly filterName: string,
    readonly exitCode = 0,
    readonly notes: string[] = [],
  ) {}

  /** Non-negative byte savings (`original - compressed`, clamped at 0). */
  get bytesSaved(): number {
    return Math.max(0, this.originalBytes - this.compressedBytes)
  }

  /** Estimated token savings, matching `compressedTokensSaved` (bytes/4, the codebase-wide pricing constant). */
  get tokensSaved(): number {
    return compressedTokensSaved(this.bytesSaved)
  }

  /** Reduction as a percentage of the original size (0 when no input). */
  get percentSaved(): number {
    if (this.originalBytes <= 0) return 0
    return (100 * this.bytesSaved) / this.originalBytes
  }

  /**
   * Byte cost of the trailing marker {@link withMarker} would append for this
   * result's filter name and percentage. The marker is not free — a rewrite
   * whose `bytesSaved` doesn't even cover its own marker is strictly worse
   * than doing nothing.
   */
  get markerBytes(): number {
    return byteLength(compressionMarker(this.filterName, this.percentSaved))
  }

  /**
   * Net savings after subtracting the marker's own byte cost — the true
   * benefit of shipping the rewrite instead of the untouched original.
   */
  get netSavingsBytes(): number {
    return this.bytesSaved - this.markerBytes
  }

  /**
   * Single definition of "is this rewrite worth shipping". `minNetSavingsBytes`
   * is the configured floor (`bash_compress.min_net_savings_bytes`) below
   * which a rewrite is considered too trivial to justify destabilising the
   * bytes (breaks provider prefix caching) for — every consumer that chooses
   * between the compressed body and the original output must go through this,
   * not re-derive its own `bytesSaved > 0` check.
   */
  worthApplying(minNetSavingsBytes: number): boolean {
    return isRewriteWorthwhile({
      originalBytes: this.originalBytes,
      rewrittenBytes: this.compressedBytes,
      noticeBytes: this.markerBytes,
      minNetSavingsBytes,
    })
  }

  /**
   * `text` with the trailing compression-summary marker appended. Skipped
   * entirely when the rewrite doesn't clear `minNetSavingsBytes` (default 0,
   * i.e. the marker must at least pay for itself) so raw output never carries
   * a marker for a trivial or net-negative rewrite.
   */
  withMarker(minNetSavingsBytes = 0): string {
    if (!this.worthApplying(minNetSavingsBytes)) return this.text
    return this.text + compressionMarker(this.filterName, this.percentSaved)
  }
}

/**
 * What {@link ToolFilter.apply} knows about the input that its {@link ToolFilter.compress} cannot work out for itself.
 *
 * Exists for one honesty problem. A filter that reports a total about the *input* (grep's match count is the clear case: the count is the answer, not a description of what the filter did) computes it from whatever survived the pre-filter clamp, and then prints it as a fact. On a 985,533-byte grep of 9,000 matching lines the delivered line read `grep: 4685 matches across 40 file(s)`. Optional and defaulted, so the eighty-odd existing `compress` overrides that do not report input totals need no change: a TypeScript override may take fewer parameters than it implements.
 */
export interface CompressContext {
  /** True when the clamp dropped part of the input, so any count derived from it is a lower bound rather than a total. */
  readonly inputTruncated?: boolean
}

/** Options accepted by {@link ToolFilter.apply}. */
export interface ApplyOptions {
  maxLines?: number
  maxBytes?: number
  skipProgress?: boolean
}

/**
 * Per-tool output compressor. Subclasses declare the command `binaries` they
 * accept (matched against the resolved argv stem after prefix stripping) and
 * implement {@link compressBody} to produce the compressed body. The base
 * {@link apply} handles ANSI / progress normalisation, input/line/byte caps,
 * and the trailing compression marker.
 *
 * Set {@link errorPassthrough} to `true` to short-circuit to the raw combined
 * output when the command exits non-zero with non-empty stderr — replacing the
 * `_preserve_stderr_on_error` preamble many filters used to duplicate.
 */
export abstract class ToolFilter {
  /** Stable filter identifier (e.g. `"pytest"`), used in the marker + stats. */
  abstract readonly name: string
  /** Command basenames this filter handles (lowercased stems). */
  readonly binaries: ReadonlySet<string> = new Set()
  /** Optional subcommand gate; matched against the first 3 positional args. */
  readonly subcommands: ReadonlySet<string> = new Set()
  /** When true, pass raw error output through on non-zero exit. */
  readonly errorPassthrough: boolean = false

  /**
   * Return true when this filter should run for `argv`. Checks `binaries`
   * against the lowercased stem (and full name, for dot-in-name binaries like
   * `py.test`) of `argv[0]`; when `subcommands` is non-empty, requires one in
   * the first three positional args.
   */
  matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const first = argv[0]!
    const stem = pathStem(first).toLowerCase()
    const name = pathName(first).toLowerCase()
    if (!this.binaries.has(stem) && !this.binaries.has(name)) return false
    if (this.subcommands.size === 0) return true
    return positionalArgs(argv.slice(1))
      .slice(0, 3)
      .some((tok) => this.subcommands.has(tok))
  }

  /** Combine stdout/stderr with a `---` separator when both are present. */
  protected combineOutput(stdout: string, stderr: string): string {
    return combineStreams(stdout, stderr)
  }

  /** Append a `[token-goat: <joined notes>]` summary line to `kept`. */
  protected emitNotes(kept: string[], notes: string[], prefix = 'token-goat: '): void {
    if (notes.length) kept.push(`[${prefix}${notes.join('; ')}]`)
  }

  /** Join `kept` with newlines and squeeze runs of blank lines. */
  protected finalize(kept: string[]): string {
    return squeezeBlankLines(kept.join('\n'))
  }

  /**
   * Hook applied to each stream right after {@link normalise}. Identity by
   * default; the git filter family overrides it to strip CRLF warnings. Keeps
   * `apply` free of per-family name checks.
   */
  protected postNormalise(text: string): string {
    return text
  }

  /**
   * Template: when {@link errorPassthrough} is set, return the raw combined
   * error output on non-zero exit before delegating to {@link compressBody}.
   * Filters that handle errors structurally (pytest, cargo) override this
   * directly and leave `errorPassthrough` false.
   */
  compress(stdout: string, stderr: string, exitCode: number, argv: string[], ctx: CompressContext = {}): string {
    if (this.errorPassthrough) {
      const err = preserveStderrOnError(stdout, stderr, exitCode)
      if (err !== null) return err
    }
    return this.compressBody(stdout, stderr, exitCode, argv, ctx)
  }

  /**
   * Inner compression logic, called after the error-passthrough guard.
   * Default is a passthrough that joins the two streams — useful when the only
   * compression is the ANSI / progress strip `apply` already performed.
   */
  protected compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[], _ctx: CompressContext = {}): string {
    if (stderr && stdout) return `${stdout.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}`
    return stdout || stderr
  }

  /**
   * Top-level entry: sanitise → input cap → normalise → compress → line/byte
   * cap → wrap in {@link CompressedOutput}. Faithful port of the Python
   * `apply` 10-step pipeline. Errors from {@link compress} fall back to a
   * truncated view so the agent always sees something.
   */
  apply(stdout: string, stderr: string, exitCode: number, argv: string[], opts: ApplyOptions = {}): CompressedOutput {
    const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    const skipProgress = opts.skipProgress ?? false

    // Step 1: sanitise — strip null bytes.
    let so = safeDecode(stdout)
    let se = safeDecode(stderr)

    // Step 1.5: redact BEFORE any truncator/clipper/capper below ever sees the text. Every
    // truncator in this pipeline (clampKeepingEnds, clipWideLines, capLongLines,
    // truncateMiddleSmart, capBytes) can cut a real credential mid-value; if that happens before
    // redaction runs, the surviving fragment can fall under a pattern's minimum-length floor (e.g.
    // sk-ant- needs 20+ trailing chars) and the regex that would have caught the whole key no
    // longer recognises the piece that's left, so it ships raw. Redacting the full, untruncated
    // stream first means every truncator downstream only ever cuts placeholder text
    // (`[REDACTED:...]`), never secret bytes. This also means the byte-accounting below (soBytes/
    // seBytes, used as "what the command really produced" for compression-ratio reporting) is
    // computed on the redacted text -- consistent with every other cache in this repo
    // (bash_output_cache.ts, mcp_cache.ts) sizing off the redacted output rather than the raw
    // pre-redaction bytes.
    let redactedCount = 0
    const earlySo = redactSecrets(so)
    const earlySe = redactSecrets(se)
    so = earlySo.text
    se = earlySe.text
    redactedCount += earlySo.count + earlySe.count

    // Step 2: pre-filter input cap, applied per-stream before normalisation so even normalisation stays O(capped_bytes).
    const maxInput = getMaxInputBytes()
    const notes: string[] = []
    // Captured before clamping: step 3 prices the reduction against what the command really produced, so a clamp that discards the middle must not also shrink the denominator.
    const soBytes = Buffer.from(so, 'utf8')
    const seBytes = Buffer.from(se, 'utf8')
    const soClamped = clampKeepingEnds(so, maxInput)
    const seClamped = clampKeepingEnds(se, maxInput)
    if (soClamped !== null) {
      so = soClamped
      notes.push(`input over ${Math.floor(maxInput / 1024)}KB: kept both ends (TOKEN_GOAT_FILTER_MAX_BYTES)`)
    }
    if (seClamped !== null) {
      se = seClamped
      if (!notes.some((n) => n.includes('kept both ends'))) {
        notes.push(`stderr over ${Math.floor(maxInput / 1024)}KB: kept both ends (TOKEN_GOAT_FILTER_MAX_BYTES)`)
      }
    }

    // Step 2b: bound every line's width before normalisation or any per-tool filter regex runs. The byte clamp above bounds a stream, not a line, and the filter regexes are line-oriented with polynomial backtracking suppressed on the premise that a line is short. Nothing enforced that premise.
    const soClipped = clipWideLines(so)
    const seClipped = clipWideLines(se)
    if (soClipped !== so || seClipped !== se) {
      so = soClipped
      se = seClipped
      notes.push(`clipped line(s) wider than ${INPUT_MAX_LINE_CHARS} chars`)
    }

    // Step 3: original byte count from pre-truncation byte arrays.
    const originalBytes = soBytes.length + seBytes.length

    // Step 4: early-return on empty input.
    if (!so.trim() && !se.trim()) {
      const text = notes.length ? `[${notes.join('; ')}]\n` : ''
      return new CompressedOutput(text, originalBytes, byteLength(text), this.name, exitCode, notes)
    }

    let body: string
    try {
      // Byte count of the (already truncated) pre-normalisation streams, so the
      // "did normalisation itself help" check below isn't credited for size
      // reduction that truncation alone already produced.
      const preNormBytes = byteLength(so) + byteLength(se)
      const normOut = this.postNormalise(normalise(so, { skipProgress }))
      const normErr = this.postNormalise(normalise(se, { skipProgress }))
      const normBytes = byteLength(normOut) + byteLength(normErr)

      // Step 6a: normalisation alone achieved ≥40% reduction — skip the expensive per-tool filter and use simple dedupe.
      if (preNormBytes > 0 && normBytes <= preNormBytes * 0.6) {
        body = compressBashOutput(normOut, normErr)
        notes.push('early-exit: normalisation alone sufficient')
      } else if (normBytes > MAX_INSPECT_BYTES) {
        // Step 6b: runaway log — head/tail truncate rather than per-line scan.
        notes.push(`input exceeded inspect budget (${Math.floor(MAX_INSPECT_BYTES / 1024)} KiB); fell back to truncation`)
        body = fallbackTruncate(normOut, normErr, maxLines)
      } else {
        // Step 7: structural compression.
        body = this.compress(normOut, normErr, exitCode, argv, { inputTruncated: soClamped !== null || seClamped !== null })
      }
    } catch (exc) {
      const kind = exc instanceof Error ? exc.constructor.name : 'Error'
      notes.push(`${this.name} filter raised ${kind}; truncated raw`)
      const fbOut = this.postNormalise(normalise(so, { skipProgress }))
      const fbErr = this.postNormalise(normalise(se, { skipProgress }))
      body = fallbackTruncate(fbOut, fbErr, maxLines)
    }

    // Step 7.5: per-line cap. Step 8 below counts lines and step 9 measures the whole body, so a single enormous line passed both and shipped at full length: the grep filter grew its own centred clip for exactly that reason, and every other filter still had nothing. Applied here, once, for all of them rather than per filter. Idempotent, so grep's already-clipped lines are left as they are.
    body = capLongLines(body.split('\n'), LONG_LINE_MAX_CHARS).join('\n')
    // Step 8: line cap (error-preserving).
    const lines = body.split('\n')
    if (lines.length > maxLines) body = truncateMiddleSmart(lines, maxLines).join('\n')
    // Step 9: byte cap (backstop for pathological lines).
    body = capBytes(body, maxBytes)
    // Step 9.5: defense-in-depth secret redaction, re-run on the final body. The primary pass now
    // runs at Step 1.5, before any truncator in this pipeline can cut a credential below a
    // pattern's recognition floor (see the comment there); EnvFilter's ENV_KEEP_PREFIXES
    // intentionally keeps AWS_/GITHUB_/GITLAB_/AZURE_/GOOGLE_/TF_/PULUMI_-prefixed vars for
    // debugging context, which also keeps any real AWS_ACCESS_KEY_ID/GITHUB_TOKEN/etc. value
    // verbatim until redacted. This second pass is normally a no-op (redactSecrets is idempotent)
    // but stays in place as a choke point for any redaction-shaped text a per-tool filter's own
    // `compress()` might introduce after Step 1.5 already ran.
    const redacted = redactSecrets(body)
    body = redacted.text
    redactedCount += redacted.count
    if (redactedCount > 0) notes.push(`redacted ${redactedCount} secret-shaped value(s)`)
    // Step 10: prepend notes.
    if (notes.length) body = `[${notes.join('; ')}]\n${body}`

    return new CompressedOutput(body, originalBytes, byteLength(body), this.name, exitCode, notes)
  }
}
