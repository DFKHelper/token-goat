// Dispatch layer: command → filter selection, compound-command handling, and the `compressOutput` entry point with compression profiles. Faithful port of the Python `select_filter` / `detect_from_command` / `try_wrap_compound_segments` / `compress_output` / `filter_by_name` surface.
//
// `TOOL_FILTERS` is the ordered registry every per-tool filter joins as the batched port proceeds (test-runners, package-managers, linters, ...). Order matters: more specific filters must precede the generic package-manager handlers they overlap with — each batch documents its placement.

import type { ApplyOptions, CompressedOutput, ToolFilter } from './base.js'
import { resolveIndexPath } from '../paths.js'
import { GenericFilter } from './generic.js'
import { goTestFilter } from './go_test.js'
import { REDIRECT_TOKEN_RE, hasBareBackgroundOrNewline, resolvePackageManagerScript, shlexSplit, stripPrefixes } from './helpers.js'
import { AI_CLI_FILTERS } from './ai_clis.js'
import { BUILD_FILTERS } from './build.js'
import { CI_FILTERS } from './ci.js'
import { CLOUD_FILTERS } from './cloud.js'
import { SHELL_FILE_FILTERS } from './shell_file.js'
import { LANGUAGE_FILTERS, bunFilter } from './languages.js'
import { MISC_FILTERS, playwrightFilter, cypressFilter } from './misc.js'
import { CONTAINER_FILTERS } from './containers.js'
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
  // Batch A — test runners. Node family (jest/mocha/ava/tap, vitest) first, then the bespoke runners (pytest, go test) that need their own structural logic. No overlap with later batches; safe at the head — except `go-test`, which must precede any future `go build`/`go run` filter (both match `go`), so it is registered here ahead of the build batch.
  ...TEST_RUNNER_FILTERS,
  pytestFilter,
  goTestFilter,
  // PlaywrightFilter and CypressFilter must precede BunFilter: BunFilter also claims 'bunx', so `bunx playwright test` / `bunx cypress run` would route to BunFilter first without this ordering. Both filters have custom matches() that handle npx/pnpx/bunx with playwright/cypress as the next positional.
  playwrightFilter,
  cypressFilter,
  // BunFilter must precede the package-manager batch: NodePackageFilter also claims 'bun', and first-match wins. BunFilter's routing (test/build/run) is richer than the generic npm-family handler.
  bunFilter,
  // Batch B — package managers. NpmInstallFilter / PnpmFilter / YarnFilter must precede the general NodePackageFilter that handles `npm audit` and other subcommands. DepListFilter is last: it matches a subset of binaries already claimed by pip/uv/poetry filters, triggered only on list/freeze/tree/show/ls.
  ...PACKAGE_MANAGER_FILTERS,
  // Batch C — linters. PylintFilter precedes the generic LinterFilter (which also declares 'pylint') to ensure the structured dedup path runs for pylint output. PrettierFilter and BiomeFilter precede any future npm/npx-wrapper handler that might match 'npx prettier'. All other linters are single-binary and order only matters within the group to preserve the Python FILTERS registration precedence.
  ...LINTER_FILTERS,
  // Batch D — vcs. Git-specific filters: specific subcommands first, generic GitFilter last. GitFilter catches every remaining git subcommand not claimed by GitLogFilter, GitDiffFilter, GitStatusVerboseFilter, etc.
  ...GIT_FILTERS,
  // Batch E — build tools. CargoFilter handles all cargo subcommands internally; GoFilter must follow goTestFilter (Batch A) because both match `go`. NxFilter/TurboFilter match npx/pnpx so they must follow the package-manager batch but their own subcommand check prevents false positives.
  ...BUILD_FILTERS,
  // Batch F — containers / kubernetes. KubectlLogsFilter must precede KubectlFilter (both match `kubectl`/`k`); DockerComposeFilter must precede DockerFilter (both match `docker`). See containers.ts ordering comment.
  ...CONTAINER_FILTERS,
  // Batch G — cloud / IaC. AwsCliFilter must precede AwsFilter (both match `aws`/`aws2`; AwsCliFilter owns the CFN/S3 routing; AwsFilter is the simpler JSON-array fallback). See cloud.ts ordering comment.
  ...CLOUD_FILTERS,
  // Batch I — AI-CLI streaming assistants. GhCopilotFilter must precede GhRunLogFilter and GhFilter (all match `gh`; GhCopilotFilter only fires for `gh copilot explain/suggest`). AI_CLI_FILTERS is therefore spread BEFORE CI_FILTERS, not after — despite the general "append" convention.
  ...AI_CLI_FILTERS,
  // Batch H — CI runners, security scanners, and the keyword-based generic CI log filter. GhRunLogFilter precedes GhFilter (both match `gh`); GenericCIFilter is last (keyword-only, not binary-gated).
  ...CI_FILTERS,
  ...SHELL_FILE_FILTERS,
  // Batch K1 — language runtimes and compilers.
  ...LANGUAGE_FILTERS,
  // Batch K2 — db clients, runners, CSS-preprocessors, system-package managers, and generic catch-alls (env dump, JSON array, severity-log, tail-trunc). PlaywrightFilter and CypressFilter from this family are registered above (before BunFilter) — they are NOT included in MISC_FILTERS. TailTruncFilter (content-based, matches() always false, applied explicitly rather than auto-dispatched) should remain last in MISC_FILTERS as a matter of convention.
  ...MISC_FILTERS,
]

/** Compression profiles → effective line cap; `minimal` also skips progress collapse. */
const PROFILE_CAPS: Record<string, number> = { aggressive: 50, balanced: 200, minimal: 500 }

/**
 * Peel a leading `cd DIR &&`/`cd DIR ;` off `argv` so the real command lands at argv[0] for
 * matching, and shift `cwd` to DIR so package-manager script resolution (below) resolves
 * against the right `package.json`. Deliberately narrow: only a single `cd` immediately
 * followed by exactly one directory token and a top-level `&&`/`;` separator qualifies. A
 * bare `cd`, a `cd DIR` with nothing following, or a `cd` displaced from argv[0] by an earlier
 * pass-through (e.g. inside a subshell, where shlexSplit tokenizes `(cd` as one token) are left
 * untouched -- this is filter-selection routing, not general shell-grammar parsing.
 *
 * When `cwd` is `undefined` (the caller never had one), the peeled cwd stays `undefined` too:
 * peeling must not conjure a cwd that lets script resolution run somewhere it previously
 * couldn't -- callers that never pass cwd see no behaviour change beyond the peel itself.
 */
function peelLeadingCd(argv: string[], cwd: string | undefined): { argv: string[]; cwd: string | undefined } | null {
  if (argv.length < 3 || argv[0] !== 'cd') return null
  const sep = argv[2]
  if (sep !== '&&' && sep !== ';') return null
  const remainder = argv.slice(3)
  if (remainder.length === 0) return null
  const dir = argv[1]!
  return { argv: remainder, cwd: cwd === undefined ? undefined : resolveIndexPath(dir, cwd) }
}

/**
 * Return the first registered filter whose `matches(argv)` is true, or null
 * when none applies (callers should NOT wrap such commands — the subprocess
 * overhead would be pure cost). argv is prefix-stripped first so
 * `sudo time python -m pytest` resolves to the pytest filter.
 *
 * When `cwd` is supplied and `argv` is a package-manager run-script form
 * (`npm test`, `npm run build`, `yarn lint`, `pnpm run build`, `bun run
 * build`), this first tries resolving the aliased script (via the nearest
 * ancestor `package.json`) and dispatching on THAT — so `npm test` backed by
 * `"test": "vitest run"` matches the vitest filter instead of the generic
 * npm one. If resolution isn't applicable/safe or the resolved command
 * matches no filter, this falls through to the unresolved `argv` exactly as
 * before (which still lets the generic npm/pnpm/yarn/bun filter claim it).
 */
export function selectFilter(argv: string[], cwd?: string): ToolFilter | null {
  if (argv.length === 0) return null
  const peeled = peelLeadingCd(argv, cwd)
  const effectiveArgv = peeled !== null ? peeled.argv : argv
  const effectiveCwd = peeled !== null ? peeled.cwd : cwd
  let resolved = stripPrefixes(effectiveArgv)
  if (resolved.length === 0) {
    // Prefix-stripping consumed the whole argv (bare `env`, `env -0`); fall back to the first token so a dedicated env filter can still opt in.
    resolved = effectiveArgv.slice(0, 1)
    if (resolved.length === 0) return null
  }
  if (effectiveCwd !== undefined) {
    const scriptArgv = resolvePackageManagerScript(resolved, effectiveCwd)
    if (scriptArgv !== null) {
      const scriptResolved = stripPrefixes(scriptArgv)
      if (scriptResolved.length > 0) {
        for (const f of TOOL_FILTERS) {
          try {
            if (f.matches(scriptResolved)) return f
          } catch {
            // A filter raising during matches() must not break dispatch.
          }
        }
      }
    }
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
 * `|`, `;`, `$()`, backticks), a bare `&` (background operator), an embedded
 * newline, uses redirects, or matches no filter. The wrapper only intercepts
 * a single command, so compounds/pipelines/backgrounded/multi-line commands
 * are left untouched.
 */
export function detectFromCommand(command: string, cwd?: string): { filter: ToolFilter; argv: string[] } | null {
  if (!command || command.length > 65536) return null
  if (['&&', '||', '$(', '`'].some((op) => command.includes(op))) return null
  if (command.includes('|') || command.includes(';')) return null
  if (hasBareBackgroundOrNewline(command)) return null
  let argv: string[]
  try {
    argv = shlexSplit(command)
  } catch {
    return null
  }
  if (hasRedirect(argv)) return null
  const filter = selectFilter(argv, cwd)
  if (filter === null) return null
  return { filter, argv: stripPrefixes(argv) }
}

/**
 * Like {@link detectFromCommand} but for a single `&&`-split segment (the
 * compound guard already ran on the whole command). Still rejects `||`, `|`,
 * `;`, `$()`, and backticks inside the segment.
 */
function detectSingleSegment(segment: string, cwd?: string): { filter: ToolFilter; argv: string[] } | null {
  const seg = segment.trim()
  if (!seg || seg.length > 65536) return null
  if (['||', '$(', '`'].some((op) => seg.includes(op))) return null
  if (seg.includes('|') || seg.includes(';')) return null
  // Same guard as detectFromCommand: a bare `&` backgrounds this segment (e.g. `cd /app && npm
  // run dev &`, a common "set up then start a dev server" compound), and wrapping it would
  // reproduce the exact hang detectFromCommand's own check exists to prevent -- spawnSync's
  // piped stdio blocks on the backgrounded grandchild's inherited stdout until it exits or the
  // wrapper's timeout kills the process tree the user wanted kept running. This path lacked the
  // check entirely, not just a narrower version of it.
  if (hasBareBackgroundOrNewline(seg)) return null
  let argv: string[]
  try {
    argv = shlexSplit(seg)
  } catch {
    return null
  }
  if (hasRedirect(argv)) return null
  const filter = selectFilter(argv, cwd)
  if (filter === null) return null
  return { filter, argv: stripPrefixes(argv) }
}

/**
 * Splits `command` on top-level `&&` operators only -- i.e. `&&` that appears outside any
 * single- or double-quoted span. A naive regex split (the previous implementation) treats a
 * `&&` inside a quoted argument, like the commit message in `git commit -m "a&&b" && npm
 * test`, as a segment boundary too, corrupting it on rejoin (`a&&b` becomes `a && b`). This
 * walks the string char-by-char tracking quote state so quoted content is never split.
 */
function splitTopLevelAnd(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i] ?? ''
    if (quote !== null) {
      // Inside a double-quoted span (never single-quoted -- POSIX single quotes have no
      // escapes at all, matching maskQuotedSpans/shlexSplit's own double-vs-single asymmetry),
      // a backslash escapes the following character, so \" doesn't close the quote early. Not
      // handling this let an escaped quote flip `quote` to null one character too soon,
      // silently reabsorbing the real && boundary that followed into the same segment.
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        current += ch + command[i + 1]
        i += 2
        continue
      }
      current += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i++
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(current.trim())
      current = ''
      i += 2
      continue
    }
    current += ch
    i++
  }
  segments.push(current.trim())
  return segments
}

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
  cwd?: string,
): string | null {
  if (!command || command.includes('||') || command.includes('|') || command.includes(';')) return null
  if (command.includes('$(') || command.includes('`')) return null
  if (!command.includes('&&')) return null
  const segments = splitTopLevelAnd(command)
  if (segments.length < 2 || segments.length > 8) return null
  const wrappedSegments: string[] = []
  let anyWrapped = false
  for (const seg of segments) {
    if (!seg) return null // empty segment (e.g. trailing &&) — bail
    const detected = detectSingleSegment(seg, cwd)
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
