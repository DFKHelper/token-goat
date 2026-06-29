// Filter family factories: shared compression skeletons that multiple per-tool
// filters configure rather than reimplement. The first family is the Node test
// runner (Jest / Mocha / Ava / Tap, Vitest), whose output all shares the same
// shape — per-file PASS/FAIL headers, indented per-test pass ticks, collapsible
// console/stdout blocks, and a trailing summary. The Python port had these as
// separate hand-written `compress` loops; here one loop, parameterised by a few
// regexes and nouns, drives every member so the behaviour stays identical and
// the next runner is a config object, not another loop.
//
// The second family is the simple package-manager "line-drop" filter: combine
// stdout+stderr, walk lines dropping any that match a set of noise regexes
// (each with its own count note), optionally first checking a keep-regex that
// short-circuits dropping. Covers Bundler and Pub, which share this structure.

import { ToolFilter } from './base.js'
import { ERROR_SIGNAL_RE, maybeNote, squeezeBlankLines } from './helpers.js'

/** `''` for a count of 1, otherwise the plural suffix (default `'s'`). */
export function plural(n: number, suffix = 's'): string {
  return n === 1 ? '' : suffix
}

/**
 * Configuration for a Node test-runner filter (see {@link makeNodeTestRunnerFilter}).
 *
 * The five regexes classify each output line; the two nouns label the collapse
 * notes. `failuresSection` opts into Jest's `--verbose` duplicate-`Failures:`
 * block handling (Vitest has no such section).
 */
export interface NodeTestRunnerConfig {
  /** Filter name (marker + stats key), e.g. `'jest'`. */
  readonly name: string
  /** Command basenames this filter handles. */
  readonly binaries: readonly string[]
  /** File-level PASS header (e.g. `PASS src/foo.test.js` or `✓ file (12ms)`) → counted. */
  readonly passFileRe: RegExp
  /** File-level FAIL header → opens a verbatim fail block. */
  readonly failFileRe: RegExp
  /** Summary line (`Test Suites:`, `Test Files`, `Duration`, …) → always kept. */
  readonly summaryRe: RegExp
  /** Indented per-test pass tick (`✓ should …`) → counted. */
  readonly testTickRe: RegExp
  /** Output-block header (`console.log`, `stdout |`) → block collapsed to a count. */
  readonly outputHdrRe: RegExp
  /** Middle word(s) of the block-collapse note, e.g. `'console output'` or `'stdout'`. */
  readonly outputNoun: string
  /** Singular noun for the pass-file note, e.g. `'PASS file'` or `'passing file'`. */
  readonly passFileNoun: string
  /** When true, drop Jest's `--verbose` duplicate `Failures:` section. */
  readonly failuresSection?: boolean
}

// ---------------------------------------------------------------------------
// Package-manager "line-drop" family
// ---------------------------------------------------------------------------

/**
 * One noise-drop rule for {@link makePackageManagerFilter}.
 */
export interface DropRule {
  /** Lines matching this regex are dropped instead of kept. */
  readonly re: RegExp
  /**
   * A function that returns the note text given the final drop count. Called
   * only when count > 0 (via {@link maybeNote}).
   */
  readonly note: (count: number) => string
}

/**
 * Configuration for a simple line-drop package-manager filter (see
 * {@link makePackageManagerFilter}).
 */
export interface PackageManagerFilterConfig {
  /** Filter name, e.g. `'bundler'`. */
  readonly name: string
  /** Command basenames this filter handles. */
  readonly binaries: readonly string[]
  /** Optional subcommand allowlist (same semantics as {@link ToolFilter.subcommands}). */
  readonly subcommands?: readonly string[]
  /**
   * When present, lines matching this regex are always kept (before drop rules
   * are evaluated). Useful for "always keep summary lines" patterns.
   */
  readonly keepRe?: RegExp
  /**
   * Ordered drop rules. Each line is tested against these in order; the first
   * match drops the line and increments that rule's counter.
   */
  readonly dropRules: readonly DropRule[]
}

/**
 * Build a {@link ToolFilter} for a package-manager whose noise pattern is:
 * "drop lines matching these regexes, emit a count note for each, keep
 * everything else". The returned filter's `compress` method combines stdout
 * and stderr, walks lines, and emits structured notes.
 *
 * Currently used by: BundlerFilter, PubFilter.
 */
export function makePackageManagerFilter(cfg: PackageManagerFilterConfig): ToolFilter {
  return new (class extends ToolFilter {
    readonly name = cfg.name
    override readonly binaries = new Set(cfg.binaries)
    override readonly subcommands = cfg.subcommands ? new Set(cfg.subcommands) : new Set<string>()

    override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
      const merged = this.combineOutput(stdout, stderr)
      const lines = merged.split('\n')
      const kept: string[] = []
      const counts = Array.from({ length: cfg.dropRules.length }, () => 0)
      for (const line of lines) {
        if (ERROR_SIGNAL_RE.test(line)) {
          kept.push(line)
          continue
        }
        if (cfg.keepRe?.test(line)) {
          kept.push(line)
          continue
        }
        let dropped = false
        for (let i = 0; i < cfg.dropRules.length; i++) {
          if (cfg.dropRules[i]!.re.test(line)) {
            counts[i]!++
            dropped = true
            break
          }
        }
        if (!dropped) kept.push(line)
      }
      const notes: string[] = []
      for (let i = 0; i < cfg.dropRules.length; i++) {
        maybeNote(notes, counts[i]!, cfg.dropRules[i]!.note(counts[i]!))
      }
      this.emitNotes(kept, notes)
      return this.finalize(kept)
    }
  })()
}

// ---------------------------------------------------------------------------
// Node test-runner family
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Linter filter family
// ---------------------------------------------------------------------------

/**
 * Configuration for a single-binary linter filter produced by
 * {@link makeLinterFilter}. Covers linters whose output is a stream of
 * per-file violation lines, optional progress/noise to drop, and an optional
 * summary line(s) to hold until the end. Each violation is parsed by
 * `parseDiagnostic` to extract its severity and a stable rule identifier;
 * lines that do not match are passed through verbatim.
 *
 * Currently used by: SwiftLintFilter.
 */
export interface LinterFilterConfig {
  /** Filter name, e.g. `'swiftlint'`. */
  readonly name: string
  /** Command basenames this filter handles. */
  readonly binaries: readonly string[]
  /**
   * Called for each output line. Returns `{ severity, ruleId }` when the line
   * is a violation, or `null` to pass the line through unchanged.
   */
  readonly parseDiagnostic: (line: string) => { severity: string; ruleId: string } | null
  /**
   * Lines matching this regex are set aside and emitted after the per-rule
   * collapse notes (e.g. the "Done linting!" summary).
   */
  readonly summaryLast?: RegExp
  /** Lines matching this regex are counted and dropped (progress noise). */
  readonly dropRe?: RegExp
  /** Produces the note text for the dropped-lines count. */
  readonly dropLabel?: (count: number) => string
  /** Number of violations to keep per rule before collapsing. Default 3. */
  readonly keepPerRule?: number
  /**
   * Severity values that are always kept regardless of the per-rule cap
   * (e.g. `['error', 'serious']`).
   */
  readonly alwaysKeepSeverities?: readonly string[]
  /**
   * Produces the per-rule collapse note injected after the last kept violation
   * for that rule. Called with the rule ID and the number of elided violations.
   */
  readonly collapseNote?: (ruleId: string, extra: number) => string
}

/**
 * Build a {@link ToolFilter} for a linter that emits per-violation lines with
 * an extractable rule ID and severity. The factory loop: (1) drop progress noise
 * counted via `dropRe`; (2) hold summary lines via `summaryLast`; (3) parse each
 * remaining line via `parseDiagnostic`; (4) always keep lines whose severity is
 * in `alwaysKeepSeverities`; (5) keep the first `keepPerRule` violations per rule,
 * then emit a `collapseNote` for the remainder; (6) append held summary lines and
 * notes last.
 *
 * Currently used by: SwiftLintFilter.
 */
export function makeLinterFilter(cfg: LinterFilterConfig): ToolFilter {
  const keepPerRule = cfg.keepPerRule ?? 3
  const alwaysKeep = new Set(cfg.alwaysKeepSeverities ?? [])

  return new (class extends ToolFilter {
    readonly name = cfg.name
    override readonly binaries = new Set(cfg.binaries)

    override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
      const merged = this.combineOutput(stdout, stderr)
      const lines = merged.split('\n')
      const kept: string[] = []
      const summaryLines: string[] = []
      const ruleCounts = new Map<string, number>()
      let droppedProgress = 0

      for (const line of lines) {
        if (cfg.summaryLast?.test(line)) {
          summaryLines.push(line)
          continue
        }
        if (cfg.dropRe?.test(line)) {
          droppedProgress++
          continue
        }
        const parsed = cfg.parseDiagnostic(line)
        if (!parsed) {
          kept.push(line)
          continue
        }
        const { severity, ruleId } = parsed
        if (alwaysKeep.has(severity)) {
          kept.push(line)
          continue
        }
        const count = (ruleCounts.get(ruleId) ?? 0) + 1
        ruleCounts.set(ruleId, count)
        if (count <= keepPerRule) {
          kept.push(line)
        } else if (count === keepPerRule + 1 && cfg.collapseNote) {
          // Placeholder replaced after we know the final count
          kept.push(`__COLLAPSE__${ruleId}__`)
        }
      }

      // Resolve placeholders now that all counts are final
      const final: string[] = []
      for (const line of kept) {
        if (line.startsWith('__COLLAPSE__') && line.endsWith('__')) {
          const ruleId = line.slice('__COLLAPSE__'.length, -2)
          const total = ruleCounts.get(ruleId) ?? keepPerRule + 1
          const extra = total - keepPerRule
          if (extra > 0 && cfg.collapseNote) {
            final.push(cfg.collapseNote(ruleId, extra))
          }
        } else {
          final.push(line)
        }
      }

      final.push(...summaryLines)

      const notes: string[] = []
      if (droppedProgress && cfg.dropLabel) {
        notes.push(cfg.dropLabel(droppedProgress))
      }
      this.emitNotes(final, notes)
      return squeezeBlankLines(final.join('\n'))
    }
  })()
}

/**
 * Build a {@link ToolFilter} for a Node test runner from `cfg`. The returned
 * filter overrides `compress` directly (test runners exit non-zero on failures,
 * so the base error-passthrough must stay off — FAIL blocks are preserved by the
 * loop, not dumped raw).
 *
 * The loop is a faithful port of the Python `JestFilter` / `VitestFilter`
 * `compress` methods, unified: file PASS headers and per-test ticks collapse to
 * counts, FAIL blocks pass through verbatim until a blank line, summary lines
 * are always kept, and console/stdout blocks collapse to a single count line.
 * All state is per-call (locals), so a single shared instance is concurrency-safe.
 */
export function makeNodeTestRunnerFilter(cfg: NodeTestRunnerConfig): ToolFilter {
  return new (class extends ToolFilter {
    readonly name = cfg.name
    override readonly binaries = new Set(cfg.binaries)

    override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
      const merged = this.combineOutput(stdout, stderr)
      const lines = merged.split('\n')
      const kept: string[] = []
      let passFile = 0
      let tick = 0
      let inFail = false
      let blockLines = 0
      let inBlock = false
      let inFailuresSection = false
      let failuresDropped = 0

      const flush = (): void => {
        if (blockLines) {
          kept.push(`  [token-goat: collapsed ${blockLines} ${cfg.outputNoun} line${plural(blockLines)}]`)
        }
        blockLines = 0
        inBlock = false
      }

      for (const line of lines) {
        // Jest --verbose duplicate "Failures:" section: drop the header and its
        // repeated failure bodies (already shown inline); a summary line ends it.
        if (cfg.failuresSection) {
          if (line.trim() === 'Failures:') {
            flush()
            inFail = false
            inFailuresSection = true
            failuresDropped += 1
            continue
          }
          if (inFailuresSection) {
            if (cfg.summaryRe.test(line)) {
              inFailuresSection = false
              kept.push(line)
            } else {
              failuresDropped += 1
            }
            continue
          }
        }

        // File-level PASS header (outside a fail block) → count, drop.
        if (cfg.passFileRe.test(line) && !inFail) {
          flush()
          passFile += 1
          continue
        }
        // File-level FAIL header → open a verbatim fail block.
        if (cfg.failFileRe.test(line)) {
          flush()
          inFail = true
          kept.push(line)
          continue
        }
        // Summary lines are always kept (and end any open output block).
        if (cfg.summaryRe.test(line)) {
          flush()
          kept.push(line)
          continue
        }
        // Blank line ends a fail block.
        if (!line.trim() && inFail) {
          inFail = false
          kept.push(line)
          continue
        }
        // Inside a fail block: pass everything through verbatim.
        if (inFail) {
          kept.push(line)
          continue
        }
        // Output-block header (console.* / stdout |) → start collapsing.
        if (cfg.outputHdrRe.test(line)) {
          flush()
          inBlock = true
          blockLines = 1
          continue
        }
        if (inBlock) {
          const stripped = line.trim()
          // A blank or non-indented line ends the block; flush then re-handle it.
          if (!stripped || (line.length > 0 && !/^\s/.test(line))) {
            flush()
            // fall through to classify this line normally
          } else {
            blockLines += 1
            continue
          }
        }
        // Indented per-test pass tick → count, drop.
        if (cfg.testTickRe.test(line)) {
          tick += 1
          continue
        }
        kept.push(line)
      }

      flush()
      const notes: string[] = []
      maybeNote(notes, passFile, `collapsed ${passFile} ${cfg.passFileNoun}${plural(passFile)}`)
      maybeNote(notes, tick, `collapsed ${tick} passing tick${plural(tick)}`)
      if (failuresDropped) {
        notes.push(
          `collapsed ${failuresDropped} line${plural(failuresDropped)} from duplicate 'Failures:' section (already shown inline)`,
        )
      }
      this.emitNotes(kept, notes)
      return this.finalize(kept)
    }
  })()
}

// ---------------------------------------------------------------------------
// AI-CLI streaming assistant filter family
// ---------------------------------------------------------------------------

/** A single rule for counting and collapsing a class of lines. */
export interface AiCliCountedRule {
  /**
   * Regex to match against each line. Exactly one of `re` or `res` must be set.
   * When `res` is set, any regex in the array matching the line increments the
   * shared counter (OpenCode tool-call + tool-result share one counter this way).
   */
  re?: RegExp
  res?: RegExp[]
  /**
   * Where the count summary goes:
   *   'prepend' — emit a full `[token-goat: …]` line BEFORE the kept body.
   *   'append'  — emit a full `[token-goat: …]` line AFTER the kept body.
   *   'note'    — add inner text to the trailing `[token-goat: A; B; C]` note.
   *
   * For 'prepend'/'append' the `note` fn must return the complete
   * `[token-goat: …]` string.  For 'note' it returns only the inner text
   * (emitNotes wraps it).
   */
  position: 'prepend' | 'append' | 'note'
  /** Produce the note/line text. `lastLine` supplied only when `keepLast` is true. */
  note: (count: number, lastLine?: string) => string
  /** When true, track the last matching line and pass it to `note`. */
  keepLast?: boolean
}

/** Track the last line matching a regex and emit its value as a trailing note. */
export interface AiCliKeepLastRule {
  re: RegExp
  /** Produce the trailing note text from the last-seen stripped line. */
  note: (value: string) => string
}

/** Configuration for {@link makeAiCliFilter}. */
export interface AiCliFilterConfig {
  name: string
  binaries: string[]
  /**
   * When set, keep matching lines unconditionally BEFORE any drop rules.
   * Used for Cline's "wants to execute" confirmation lines.
   */
  alwaysKeepRe?: RegExp
  /** Lines matching any entry are silently dropped; count accumulates in dropped_noise. */
  dropRules: RegExp[]
  /** Counting rules — each independently counts one class of lines. */
  countedRules?: AiCliCountedRule[]
  /** Keep-last rules — each tracks the last matching line and emits it as a trailing note. */
  keepLastRules?: AiCliKeepLastRule[]
  /** Produce the trailing note text for the dropped_noise tally. Omit to suppress. */
  droppedNoiseNote?: (n: number) => string
  /**
   * When provided, completely replaces the default `matches()` implementation
   * (binary-stem check + optional subcommand check). The function receives the
   * full prefix-stripped argv.
   */
  customMatches?: (argv: string[]) => boolean
}

/**
 * Factory for AI-CLI streaming assistant filters. All 10+ AI-CLI tools share
 * the same compression skeleton: drop spinner/banner/boilerplate noise, count
 * and collapse progress lines, keep the last value seen for token-usage / cost
 * / context metrics, and emit everything as a compact trailing note.
 *
 * The bespoke CodexExecFilter (different structural algorithm) is not built
 * with this factory.
 */
export function makeAiCliFilter(cfg: AiCliFilterConfig): ToolFilter {
  return new (class extends ToolFilter {
    readonly name = cfg.name
    override readonly binaries = new Set(cfg.binaries)
    override readonly errorPassthrough = true

    override matches(argv: string[]): boolean {
      if (cfg.customMatches) return cfg.customMatches(argv)
      return super.matches(argv)
    }

    override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
      const merged = this.combineOutput(stdout, stderr)
      const lines = merged.split('\n')
      const kept: string[] = []
      let droppedNoise = 0

      const rules = cfg.countedRules ?? []
      const counts = rules.map(() => ({ count: 0, lastLine: undefined as string | undefined }))
      const klRules = cfg.keepLastRules ?? []
      const klValues: (string | undefined)[] = klRules.map(() => undefined)

      for (const line of lines) {
        if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
        if (cfg.alwaysKeepRe?.test(line)) { kept.push(line); continue }

        let dropped = false
        for (const re of cfg.dropRules) {
          if (re.test(line)) { droppedNoise++; dropped = true; break }
        }
        if (dropped) continue

        let counted = false
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]!
          const matched = rule.res ? rule.res.some((r) => r.test(line)) : rule.re!.test(line)
          if (matched) {
            counts[i]!.count++
            if (rule.keepLast) counts[i]!.lastLine = line.trim()
            counted = true
            break
          }
        }
        if (counted) continue

        let kl = false
        for (let i = 0; i < klRules.length; i++) {
          if (klRules[i]!.re.test(line)) { klValues[i] = line.trim(); kl = true; break }
        }
        if (kl) continue

        kept.push(line)
      }

      const out: string[] = []
      for (let i = 0; i < rules.length; i++) {
        if (rules[i]!.position === 'prepend' && counts[i]!.count > 0) {
          out.push(rules[i]!.note(counts[i]!.count, counts[i]!.lastLine))
        }
      }
      out.push(...kept)
      for (let i = 0; i < rules.length; i++) {
        if (rules[i]!.position === 'append' && counts[i]!.count > 0) {
          out.push(rules[i]!.note(counts[i]!.count, counts[i]!.lastLine))
        }
      }

      const notes: string[] = []
      for (let i = 0; i < rules.length; i++) {
        if (rules[i]!.position === 'note' && counts[i]!.count > 0) {
          notes.push(rules[i]!.note(counts[i]!.count, counts[i]!.lastLine))
        }
      }
      for (let i = 0; i < klRules.length; i++) {
        const v = klValues[i]
        if (v !== undefined) notes.push(klRules[i]!.note(v))
      }
      if (droppedNoise > 0 && cfg.droppedNoiseNote) {
        notes.push(cfg.droppedNoiseNote(droppedNoise))
      }
      this.emitNotes(out, notes)
      return this.finalize(out)
    }
  })()
}

// ---------------------------------------------------------------------------
// Language-runtime filter family (Batch K1)
// ---------------------------------------------------------------------------

/**
 * A single deduplication rule for {@link makeLanguageFilter}.
 *
 * Lines matching `re` are deduplicated: up to `maxPerKey` (default 3)
 * occurrences of each distinct `line.slice(0, keyLen)` key are kept verbatim;
 * additional occurrences are silently elided and counted. The total elided
 * count is emitted as a trailing `[token-goat: …]` inner note via `note`.
 */
export interface LangDedupeRule {
  /** Matches lines subject to deduplication (e.g. WARNING: lines). */
  re: RegExp
  /** Max occurrences of the same key kept verbatim. Default 3. */
  maxPerKey?: number
  /** Character count used as the dedup key. Default 40. */
  keyLen?: number
  /** Trailing note inner text for the total elided count. */
  note: (count: number) => string
}

/**
 * Configuration for {@link makeLanguageFilter}.
 *
 * Filters configured here share the same loop skeleton: merge stdout+stderr,
 * walk lines applying always-keep → count-rules → dedup-rules → drop-rules,
 * then assemble prepend-notes + kept body + append/trailing notes.
 *
 * Reuses {@link AiCliCountedRule} for count-and-drop rules so the same
 * `position: 'prepend' | 'append' | 'note'` convention applies.
 */
export interface LanguageFilterConfig {
  name: string
  binaries: string[]
  subcommands?: string[]
  /** When true, pass raw combined error on non-zero exit (same as ToolFilter.errorPassthrough). */
  errorPassthrough?: boolean
  /** Override the default binary-stem + subcommand match check. */
  customMatches?: (argv: string[]) => boolean
  /** Lines matching this re are always kept, checked before all other rules. */
  alwaysKeepRe?: RegExp
  /** Count-and-drop rules; reuse {@link AiCliCountedRule} with prepend/append/note positions. */
  countedRules?: AiCliCountedRule[]
  /** Dedup rules applied after count rules. */
  dedupeRules?: LangDedupeRule[]
  /** Lines matching any drop rule are silently dropped; count goes to droppedNoiseNote. */
  dropRules?: RegExp[]
  /** Trailing note for the total silently-dropped count; omit to suppress. */
  droppedNoiseNote?: (n: number) => string
}

/**
 * Factory for compiler/interpreter language filters. All members in the
 * "shared loop" group share the same skeleton: merge output, walk lines with
 * always-keep / count-drop / dedup / drop rules, then assemble
 * prepend-notes + body + trailing-notes. Members with genuinely unique
 * multi-mode routing (BunFilter, DenoFilter, etc.) are implemented as
 * bespoke classes; this factory covers ErlangFilter, CrystalFilter,
 * HaskellFilter, ElmFilter, JuliaFilter, and PowerShellFilter.
 */
export function makeLanguageFilter(cfg: LanguageFilterConfig): ToolFilter {
  return new (class extends ToolFilter {
    readonly name = cfg.name
    override readonly binaries = new Set(cfg.binaries)
    override readonly subcommands = new Set(cfg.subcommands ?? [])
    override readonly errorPassthrough = cfg.errorPassthrough ?? false

    override matches(argv: string[]): boolean {
      if (cfg.customMatches) return cfg.customMatches(argv)
      return super.matches(argv)
    }

    override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
      const merged = this.combineOutput(stdout, stderr)
      const lines = merged.split('\n')
      const kept: string[] = []
      let droppedNoise = 0

      const rules = cfg.countedRules ?? []
      const counts = rules.map(() => ({ count: 0, lastLine: undefined as string | undefined }))
      const dRules = cfg.dedupeRules ?? []
      const dState = dRules.map(() => ({ elided: 0, seen: new Map<string, number>() }))

      for (const line of lines) {
        // 1. Always-keep check (error signals + filter-specific keep patterns).
        if (cfg.alwaysKeepRe?.test(line)) { kept.push(line); continue }

        // 2. Count-and-drop rules (prepend / append / note positions).
        let counted = false
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]!
          const hit = rule.res ? rule.res.some((r) => r.test(line)) : (rule.re?.test(line) ?? false)
          if (hit) {
            counts[i]!.count++
            if (rule.keepLast) counts[i]!.lastLine = line.trim()
            counted = true
            break
          }
        }
        if (counted) continue

        // 3. Dedup rules.
        let deduped = false
        for (let i = 0; i < dRules.length; i++) {
          if (dRules[i]!.re.test(line)) {
            const key = line.slice(0, dRules[i]!.keyLen ?? 40)
            const ds = dState[i]!
            const seen = (ds.seen.get(key) ?? 0) + 1
            ds.seen.set(key, seen)
            if (seen <= (dRules[i]!.maxPerKey ?? 3)) kept.push(line)
            else ds.elided++
            deduped = true
            break
          }
        }
        if (deduped) continue

        // 4. Drop rules (silent; accumulate droppedNoise for optional note).
        if (cfg.dropRules?.some((re) => re.test(line))) { droppedNoise++; continue }

        // 5. Default: keep.
        kept.push(line)
      }

      // Assemble: prepend notes → kept body → append notes.
      const out: string[] = []
      for (let i = 0; i < rules.length; i++) {
        if (rules[i]!.position === 'prepend' && counts[i]!.count > 0)
          out.push(rules[i]!.note(counts[i]!.count, counts[i]!.lastLine))
      }
      out.push(...kept)
      for (let i = 0; i < rules.length; i++) {
        if (rules[i]!.position === 'append' && counts[i]!.count > 0)
          out.push(rules[i]!.note(counts[i]!.count, counts[i]!.lastLine))
      }

      // Trailing notes.
      const notes: string[] = []
      for (let i = 0; i < rules.length; i++) {
        if (rules[i]!.position === 'note' && counts[i]!.count > 0)
          notes.push(rules[i]!.note(counts[i]!.count, counts[i]!.lastLine))
      }
      for (let i = 0; i < dRules.length; i++) {
        if (dState[i]!.elided > 0) notes.push(dRules[i]!.note(dState[i]!.elided))
      }
      if (droppedNoise > 0 && cfg.droppedNoiseNote) notes.push(cfg.droppedNoiseNote(droppedNoise))
      this.emitNotes(out, notes)
      return this.finalize(out)
    }
  })()
}
