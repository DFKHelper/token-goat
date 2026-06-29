// Dispatch layer: command → filter selection, compound-command handling, and
// the `compressOutput` entry point with compression profiles. Faithful port of
// the Python `select_filter` / `detect_from_command` / `try_wrap_compound_segments`
// / `compress_output` / `filter_by_name` surface.
//
// `TOOL_FILTERS` is the ordered registry every per-tool filter joins as the
// batched port proceeds (test-runners, package-managers, linters, ...). Order
// matters: more specific filters must precede the generic package-manager
// handlers they overlap with — each batch documents its placement.

import type { ApplyOptions, CompressedOutput, ToolFilter } from './base.js'
import { GenericFilter } from './generic.js'
import { goTestFilter } from './go_test.js'
import { REDIRECT_TOKEN_RE, shlexSplit, stripPrefixes } from './helpers.js'
import { BUILD_FILTERS } from './build.js'
import { GIT_FILTERS } from './git.js'
import { LINTER_FILTERS } from './linters.js'
import { PACKAGE_MANAGER_FILTERS } from './package_managers.js'
import { pytestFilter } from './pytest.js'
import { TEST_RUNNER_FILTERS } from './test_runners.js'

/**
 * Ordered per-tool filter registry. Filled batch by batch; `selectFilter`
 * returns null (and the hook leaves the command unwrapped) for anything no entry
 * matches. Order matters: more specific filters must precede the generic
 * package-manager handlers they overlap with — each batch documents its placement.
 */
export const TOOL_FILTERS: ToolFilter[] = [
  // Batch A — test runners. Node family (jest/mocha/ava/tap, vitest) first, then
  // the bespoke runners (pytest, go test) that need their own structural logic.
  // No overlap with later batches; safe at the head — except `go-test`, which
  // must precede any future `go build`/`go run` filter (both match `go`), so it
  // is registered here ahead of the build batch.
  ...TEST_RUNNER_FILTERS,
  pytestFilter,
  goTestFilter,
  // Batch B — package managers. NpmInstallFilter / PnpmFilter / YarnFilter must
  // precede the general NodePackageFilter that handles `npm audit` and other
  // subcommands. DepListFilter is last: it matches a subset of binaries already
  // claimed by pip/uv/poetry filters, triggered only on list/freeze/tree/show/ls.
  ...PACKAGE_MANAGER_FILTERS,
  // Batch C — linters. PylintFilter precedes the generic LinterFilter (which also
  // declares 'pylint') to ensure the structured dedup path runs for pylint output.
  // PrettierFilter and BiomeFilter precede any future npm/npx-wrapper handler that
  // might match 'npx prettier'. All other linters are single-binary and order only
  // matters within the group to preserve the Python FILTERS registration precedence.
  ...LINTER_FILTERS,
  // Batch D — vcs. Git-specific filters: specific subcommands first, generic
  // GitFilter last.  GitFilter catches every remaining git subcommand not
  // claimed by GitLogFilter, GitDiffFilter, GitStatusVerboseFilter, etc.
  ...GIT_FILTERS,
  // Batch E — build tools. CargoFilter handles all cargo subcommands internally;
  // GoFilter must follow goTestFilter (Batch A) because both match `go`.
  // NxFilter/TurboFilter match npx/pnpx so they must follow the package-manager
  // batch but their own subcommand check prevents false positives.
  ...BUILD_FILTERS,
  // Batches append here: containers ·
  // cloud/iac · ci · ai-clis · shell/file · lang.
]

/** Compression profiles → effective line cap; `minimal` also skips progress collapse. */
const PROFILE_CAPS: Record<string, number> = { aggressive: 50, balanced: 200, minimal: 500 }

/**
 * Return the first registered filter whose `matches(argv)` is true, or null
 * when none applies (callers should NOT wrap such commands — the subprocess
 * overhead would be pure cost). argv is prefix-stripped first so
 * `sudo time python -m pytest` resolves to the pytest filter.
 */
export function selectFilter(argv: string[]): ToolFilter | null {
  if (argv.length === 0) return null
  let resolved = stripPrefixes(argv)
  if (resolved.length === 0) {
    // Prefix-stripping consumed the whole argv (bare `env`, `env -0`); fall
    // back to the first token so a dedicated env filter can still opt in.
    resolved = argv.slice(0, 1)
    if (resolved.length === 0) return null
  }
  for (const f of TOOL_FILTERS) {
    try {
      if (f.matches(resolved)) return f
    } catch {
      // A filter raising during matches() must not break dispatch.
    }
  }
  return null
}

/** True when any argv token is a bare shell redirect (`>`, `2>`, `>>`, `<`, ...). */
function hasRedirect(argv: string[]): boolean {
  return argv.some((tok) => REDIRECT_TOKEN_RE.test(tok))
}

/**
 * Parse a shell command string and return `{ filter, argv }`, or null when the
 * command is empty/oversized, contains unquoted control operators (`&&`, `||`,
 * `|`, `;`, `$()`, backticks), uses redirects, or matches no filter. The
 * wrapper only intercepts a single command, so compounds/pipelines are left
 * untouched.
 */
export function detectFromCommand(command: string): { filter: ToolFilter; argv: string[] } | null {
  if (!command || command.length > 65536) return null
  if (['&&', '||', '$(', '`'].some((op) => command.includes(op))) return null
  if (command.includes('|') || command.includes(';')) return null
  let argv: string[]
  try {
    argv = shlexSplit(command)
  } catch {
    return null
  }
  if (hasRedirect(argv)) return null
  const filter = selectFilter(argv)
  if (filter === null) return null
  return { filter, argv: stripPrefixes(argv) }
}

/**
 * Like {@link detectFromCommand} but for a single `&&`-split segment (the
 * compound guard already ran on the whole command). Still rejects `||`, `|`,
 * `;`, `$()`, and backticks inside the segment.
 */
function detectSingleSegment(segment: string): { filter: ToolFilter; argv: string[] } | null {
  const seg = segment.trim()
  if (!seg || seg.length > 65536) return null
  if (['||', '$(', '`'].some((op) => seg.includes(op))) return null
  if (seg.includes('|') || seg.includes(';')) return null
  let argv: string[]
  try {
    argv = shlexSplit(seg)
  } catch {
    return null
  }
  if (hasRedirect(argv)) return null
  const filter = selectFilter(argv)
  if (filter === null) return null
  return { filter, argv: stripPrefixes(argv) }
}

const COMPOUND_AND_RE = /\s*&&\s*/

/**
 * Wrap each `&&`-joined segment of a compound command independently, so a
 * command like `git diff && git log --oneline -5` still executes in full but
 * each recognised segment's output lands compressed. `wrapperArgs(filterName,
 * segment)` returns the rewritten segment, or null to leave it unchanged.
 * Returns the rewritten compound when ≥1 segment was wrapped, else null.
 */
export function tryWrapCompoundSegments(
  command: string,
  wrapperArgs: (filterName: string, segment: string) => string | null,
): string | null {
  if (!command || command.includes('||') || command.includes('|') || command.includes(';')) return null
  if (command.includes('$(') || command.includes('`')) return null
  if (!command.includes('&&')) return null
  const segments = command.split(COMPOUND_AND_RE).map((s) => s.trim())
  if (segments.length < 2 || segments.length > 8) return null
  const wrappedSegments: string[] = []
  let anyWrapped = false
  for (const seg of segments) {
    if (!seg) return null // empty segment (e.g. trailing &&) — bail
    const detected = detectSingleSegment(seg)
    if (detected !== null) {
      const wrapped = wrapperArgs(detected.filter.name, seg)
      if (wrapped !== null) {
        wrappedSegments.push(wrapped)
        anyWrapped = true
        continue
      }
    }
    wrappedSegments.push(seg)
  }
  if (!anyWrapped) return null
  return wrappedSegments.join(' && ')
}

/** Options for {@link compressOutput}. */
export interface CompressOptions {
  maxLines?: number
  maxBytes?: number
  compressionProfile?: string
}

/**
 * Canonical wrapper entry point: run `filter` over the captured output and
 * return a {@link CompressedOutput}. Always succeeds (the filter's own
 * `apply` catches exceptions and falls back to truncation). The profile sets
 * the effective line cap; an explicit tighter `maxLines` still wins.
 */
export function compressOutput(
  filter: ToolFilter,
  stdout: string,
  stderr: string,
  exitCode: number,
  argv: string[],
  opts: CompressOptions = {},
): CompressedOutput {
  const profile = opts.compressionProfile ?? 'balanced'
  const maxLines = opts.maxLines ?? 1000
  let effectiveMaxLines = PROFILE_CAPS[profile] ?? 200
  if (maxLines < effectiveMaxLines) effectiveMaxLines = maxLines
  const skipProgress = profile === 'minimal'
  const applyOpts: ApplyOptions = { maxLines: effectiveMaxLines, skipProgress }
  if (opts.maxBytes !== undefined) applyOpts.maxBytes = opts.maxBytes
  return filter.apply(stdout, stderr, exitCode, argv, applyOpts)
}

/**
 * Look up a registered filter by name. `"generic"` resolves to a fresh
 * {@link GenericFilter} (the explicit opt-in fallback, not in `TOOL_FILTERS`).
 * Returns null for unknown names; the wrapper then falls back to
 * {@link selectFilter}.
 */
export function filterByName(name: string): ToolFilter | null {
  if (name === 'generic') return new GenericFilter()
  for (const f of TOOL_FILTERS) if (f.name === name) return f
  return null
}
