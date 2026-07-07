// Filter framework base: `CompressedOutput` result type + the `ToolFilter` base class with the universal `apply()` pipeline every per-tool filter runs.
//
// Ported faithfully from the Python `bash_compress.py` `Filter` / `apply` contract. Per-tool filters (and the family factories) subclass `ToolFilter`, declare `binaries` / `subcommands`, and override `compressBody` (or `compress` for filters that handle non-zero exits structurally). The base pipeline owns normalisation, input/line/byte caps, and the trailing marker.

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  MAX_INSPECT_BYTES,
  byteLength,
  capBytes,
  compressBashOutput,
  compressionMarker,
  fallbackTruncate,
  getMaxInputBytes,
  normalise,
  pathName,
  pathStem,
  positionalArgs,
  preserveStderrOnError,
  safeDecode,
  shlexSplit,
  squeezeBlankLines,
  stripPrefixes,
  truncateMiddleSmart,
} from './helpers.js'

/**
 * Result of running a {@link ToolFilter} over a captured command output.
 *
 * `text` is the compressed body (no trailing newline — the wrapper adds one).
 * `originalBytes` is `stdout + stderr` size post-decode / pre-filter, so
 * `percentSaved` reflects the true reduction the model sees.
 */
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

  /** Estimated token savings (`n // 3 + 1`, matching `estimateTokens`). */
  get tokensSaved(): number {
    const n = this.bytesSaved
    return n <= 0 ? 0 : Math.max(1, Math.floor(n / 3) + 1)
  }

  /** Reduction as a percentage of the original size (0 when no input). */
  get percentSaved(): number {
    if (this.originalBytes <= 0) return 0
    return (100 * this.bytesSaved) / this.originalBytes
  }

  /**
   * `text` with the trailing compression-summary marker appended. Skipped
   * entirely on a no-op (savings ≤ 0) so raw output never carries a marker.
   */
  withMarker(): string {
    if (this.bytesSaved <= 0 || this.originalBytes <= 0) return this.text
    return this.text + compressionMarker(this.filterName, this.percentSaved)
  }
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

  /** Detect whether this filter applies to the raw command string. */
  detectFromCommand(cmd: string): boolean {
    try {
      if (!cmd || cmd.length > 65536) return false
      const resolved = stripPrefixes(shlexSplit(cmd))
      if (resolved.length === 0) return false
      return this.matches(resolved)
    } catch {
      return false
    }
  }

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
    if (stderr.trim() && stdout.trim()) return `${stdout.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}`
    return stdout.trim() ? stdout.replace(/\s+$/, '') : stderr.replace(/\s+$/, '')
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
  compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    if (this.errorPassthrough) {
      const err = preserveStderrOnError(stdout, stderr, exitCode)
      if (err !== null) return err
    }
    return this.compressBody(stdout, stderr, exitCode, argv)
  }

  /**
   * Inner compression logic, called after the error-passthrough guard.
   * Default is a passthrough that joins the two streams — useful when the only
   * compression is the ANSI / progress strip `apply` already performed.
   */
  protected compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
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

    // Step 2: pre-filter input cap, applied per-stream before normalisation so even normalisation stays O(capped_bytes).
    const maxInput = getMaxInputBytes()
    const notes: string[] = []
    const soBytes = Buffer.from(so, 'utf8')
    const seBytes = Buffer.from(se, 'utf8')
    if (soBytes.length > maxInput) {
      so = soBytes.subarray(0, maxInput).toString('utf8')
      notes.push(`input truncated at ${Math.floor(maxInput / 1024)}KB (TOKEN_GOAT_FILTER_MAX_BYTES)`)
    }
    if (seBytes.length > maxInput) {
      se = seBytes.subarray(0, maxInput).toString('utf8')
      if (!notes.some((n) => n.includes('input truncated'))) {
        notes.push(`stderr truncated at ${Math.floor(maxInput / 1024)}KB (TOKEN_GOAT_FILTER_MAX_BYTES)`)
      }
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
        body = this.compress(normOut, normErr, exitCode, argv)
      }
    } catch (exc) {
      const kind = exc instanceof Error ? exc.constructor.name : 'Error'
      notes.push(`${this.name} filter raised ${kind}; truncated raw`)
      const fbOut = this.postNormalise(normalise(so, { skipProgress }))
      const fbErr = this.postNormalise(normalise(se, { skipProgress }))
      body = fallbackTruncate(fbOut, fbErr, maxLines)
    }

    // Step 8: line cap (error-preserving).
    const lines = body.split('\n')
    if (lines.length > maxLines) body = truncateMiddleSmart(lines, maxLines).join('\n')
    // Step 9: byte cap (backstop for pathological lines).
    body = capBytes(body, maxBytes)
    // Step 10: prepend notes.
    if (notes.length) body = `[${notes.join('; ')}]\n${body}`

    return new CompressedOutput(body, originalBytes, byteLength(body), this.name, exitCode, notes)
  }
}
