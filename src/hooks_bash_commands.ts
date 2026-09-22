/**
 * Shell command parsing, git mutation detection, pipeline filtering, and syntax validation.
 *
 * Extracted from hooks_bash.ts to isolate pure shell-command inspection and git working-tree mutation tracking from hook I/O delivery and caching.
 */

import { statSync } from 'node:fs'

import { resolveIndexPath } from './paths.js'
import { runGit } from './util.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import {
  detectFromCommand,
  filterByName,
  hasUnquotedOperator,
  hasBareBackgroundOrNewline,
  shlexSplit,
  type ToolFilter,
} from './tool_filters/index.js'
import { isTestRunnerCommand, isBuildCommand } from './hints/lang_patterns.js'
import { RECALL_COMMAND } from './cli_recall.js'
import {
  splitShellSegments,
  extractCatFile,
  extractHeadFile,
  extractTailFile,
  extractLineRangeRead,
  extractLineRangeReadsCompound,
  isTscCommand,
} from './bash_extractors.js'
import type { HookEvent } from './hook_registry.js'

const CD_PREFIX_RE = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)[ \t]*(?:&&|;|\r?\n)\s*)+/

/** Strip one or more leading `cd <dir>` prefixes so interceptors match the actual command. */
export function stripCdPrefix(cmd: string): string {
  // Handles: `cd /path && CMD`, `cd "path with spaces" && CMD`, `cd 'path'; CMD`, and `cd /path` on its own line above CMD.
  const stripped = cmd.replace(CD_PREFIX_RE, '')
  return stripped.trim() || cmd
}

export function stripTrailingStderrRedirect(cmd: string): string {
  const stripped = cmd.replace(/\s*2>&1\s*$/, '')
  return stripped.trim() || cmd
}

export function hasTestRunScopeOrBudget(cmd: string): boolean {
  const hasTimeout = /(?:^|\s)(?:timeout(?:\.exe)?\s+\S+|--(?:test)?timeout(?:=|\s)\S+)/i.test(cmd)
  const hasSelector = /(?:\s::\S+|\s(?:-k|-t|-run|--(?:testNamePattern|last-failed|test|project))(?:=|\s)|\b(?:tests?|spec)\S*\.(?:[cm]?[jt]sx?|py|go|rs)\b|(?:^|\s)\.\/\S+)/i.test(cmd)
  return hasTimeout || hasSelector
}

export function isDirectTestRunnerCommand(cmd: string): boolean {
  return /^(?:pytest|(?:npx\s+)?(?:jest|vitest)|go\s+test|cargo\s+test)\b/i.test(cmd)
}

/**
 * Extracts each `cd <dir>` target from a leading `cd <dir> && cd <dir2> && ...` prefix, in the order stripCdPrefix consumes them. Used to resolve a relative filePath extracted from the remaining command against the directory the shell would actually land in — not this hook's own cwd — before that path is embedded in a suggested follow-up command.
 */
function extractCdPrefixDirs(rawCmd: string): string[] {
  // Must stay in step with CD_PREFIX_RE: this names the directories that one consumes, and a prefix stripped there but not extracted here resolves the file against the hook's own cwd instead of the directory the shell actually landed in.
  const prefixMatch = rawCmd.match(CD_PREFIX_RE)
  if (prefixMatch === null) return []
  const dirs: string[] = []
  const segmentPattern = /cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))[ \t]*(?:&&|;|\r?\n)/g
  let match: RegExpExecArray | null
  while ((match = segmentPattern.exec(prefixMatch[0])) !== null) {
    const dir = match[1] ?? match[2] ?? match[3]
    if (dir !== undefined) dirs.push(dir)
  }
  return dirs
}

/**
 * Resolves filePath against the directory a stripped `cd DIR && ...` prefix leaves the shell in (each cd resolved in turn — relative ones against the previous directory, starting from cwd — mirroring real shell semantics), so a hint naming filePath is resolvable from the hook's actual cwd rather than silently relative to a directory the model never navigated to. Falls back to filePath unchanged if the prefix can't be parsed into at least one directory.
 */
export function resolveCdHintPath(rawCmd: string, filePath: string, cwd: string): string {
  if (extractCdPrefixDirs(rawCmd).length === 0) return filePath
  return resolveIndexPath(filePath, cdPrefixCwd(rawCmd, cwd))
}

/** The directory a leading `cd DIR` prefix leaves the shell in, or `cwd` when there is none. Split out of resolveCdHintPath because a caller building a cache key needs the resolution unconditionally, where one building a path to display wants the original text back when there was no prefix to account for. */
export function cdPrefixCwd(rawCmd: string, cwd: string): string {
  let dir = cwd
  for (const target of extractCdPrefixDirs(rawCmd)) dir = resolveIndexPath(target, dir)
  return dir
}

/**
 * Strips a command's downstream pipeline and trailing redirections, returning the base command. Used to key the bash-output cache so that the same build/test command run with different downstream filters (`| tail -40` vs `| grep ERROR`) or redirects (`2>&1`) shares a single cache entry — mirroring how curl GET commands are keyed on their URL.
 *
 * Splits on the first top-level pipe operator (`|`), ignoring `|` inside single or double quotes and the `||` logical-OR operator, then removes trailing stream redirections (`2>&1`, `>/dev/null`, `2> file`, `&> file`, etc.).
 */
export function stripOutputPipeline(cmd: string): string {
  let inSingle = false
  let inDouble = false
  let cut = cmd.length
  let backslashes = 0
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') {
      backslashes++
      continue
    }
    // A quote is escaped only when preceded by an odd number of consecutive backslashes (\" is escaped, \\" is a literal backslash then a real quote).
    const escaped = backslashes % 2 === 1
    backslashes = 0
    if (ch === "'" && !inDouble) {
      if (!escaped) inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      if (!escaped) inDouble = !inDouble
    } else if (ch === '|' && !inSingle && !inDouble) {
      if (cmd[i + 1] === '|') {
        i++ // skip the `||` logical-OR operator; keep scanning
        continue
      }
      cut = i // first real pipe operator — base command ends here
      break
    }
  }
  let base = cmd.slice(0, cut)
  // Strip trailing stream redirections (possibly chained), honoring quotes. Mask quoted content with same-length spaces so the redirect regex cannot match characters inside a string literal (e.g. 'pytest -k "value > 0"'). String length is preserved, so slicing back to newMasked.length is exact.
  let prev: string
  do {
    prev = base
    const masked = base
      .replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => '"' + ' '.repeat(inner.length) + '"')
      .replace(/'([^']*)'/g, (_m, inner: string) => "'" + ' '.repeat(inner.length) + "'")
    const newMasked = masked.replace(/\s*(?:[0-9]*>&[0-9]+|[0-9&]*>>?\s*(?:"[^"]*"|'[^']*'|[^\s|]+))\s*$/, '')
    if (newMasked.length < masked.length) {
      base = base.slice(0, newMasked.length)
    }
  } while (base !== prev)
  return base.trim()
}

// A cache entry keyed on the base command (stripOutputPipeline) or a curl URL is intentionally shared across different downstream pipes/redirects on the same underlying command — see stripOutputPipeline's docstring. But the stored *content* is whatever that one run's pipe produced, so a differently-piped recall (`| jq '.a'` vs `| jq '.b'`) can silently serve the wrong value. Rather than break the intentional sharing (and the tests that pin it), surface the command that actually produced the cached content whenever it differs from the one being run now, so the caller can judge whether the recall still covers what they need.
export function pipelineDivergenceNote(cmd: string, entryCommand: string): string {
  if (entryCommand === cmd) return ''
  const preview = entryCommand.length > 60 ? entryCommand.slice(0, 57) + '...' : entryCommand
  return ' (cached from a differently-piped run, `' + preview + '` — verify it covers what you need before trusting it)'
}

/** Extract the command string from a Bash tool_input. */
export function extractCommand(event: HookEvent): string | undefined {
  const cmd = event.toolInput['command']
  return typeof cmd === 'string' && cmd.trim() !== '' ? cmd.trim() : undefined
}

/** Matches git subcommands that can move HEAD and rewrite working-tree file content. */
const HEAD_MOVING_GIT_RE = /^\s*git\s+(?:checkout|switch|pull|merge|rebase|reset|cherry-pick)\b/i
const PATH_SCOPED_CHECKOUT_RE = /^\s*git\s+checkout\s+(?:\S.*?\s)?--(?:\s|$)/i

export function isHeadMovingGitCommand(cmd: string): boolean {
  if (!HEAD_MOVING_GIT_RE.test(cmd)) return false
  if (PATH_SCOPED_CHECKOUT_RE.test(cmd)) return false
  return true
}

/** Subcommands where ORIG_HEAD survives multi-step operations (merge/rebase/pull). */
export const ORIG_HEAD_ELIGIBLE_GIT_RE = /^\s*git\s+(?:pull|merge|rebase)\b/i

/** Matches the HEAD reflog message a real merge/rebase/pull leaves behind. */
export const ORIG_HEAD_REFLOG_MSG_RE = /^(merge\s|rebase\s\(|pull\s)/i

/** Matches `git restore`, which rewrites paths without moving HEAD. */
const GIT_RESTORE_RE = /^\s*git\s+restore\b/i

/** `git restore --staged <file>` only rewrites the index, leaving working-tree content untouched. */
const GIT_RESTORE_STAGED_ONLY_RE = /(?:^|\s)(?:--staged|-S)(?:\s|$)/

/** Matches `git stash pop` / `git stash apply`. */
const GIT_STASH_APPLY_RE = /^\s*git\s+stash\s+(?:pop|apply)\b/i

/** Matches working-tree rewriters whose changed paths are determined by patch contents. */
const PATCH_APPLY_SEGMENT_RE = /^\s*(?:\S*[/\\])?(?:git\s+apply|patch)\b/i

/** Matches patch inspection flags without writes (`--check`, `--stat`, `--dry-run`, etc.). */
const PATCH_APPLY_INSPECT_ONLY_RE = /(?:^|\s)--(?:check|stat|numstat|summary|dry-run)(?:\s|=|$)/i

/** True for a formatter run that rewrites files in place. The file set can come from a glob, a config-driven include list, or `.` -- not parseable from the command line -- so these join the status-sweep fallback rather than growing a second, weaker path-guessing mechanism. */
function isFormatterWriteSegment(segment: string): boolean {
  return /(?:^|\s|[/\\])(?:prettier|eslint)\b/i.test(segment) && /(?:^|\s)--(?:write|fix)(?:\s|$)/i.test(segment)
}

/** Tokenize a segment argv-style, or `null` when it is not tokenizable (shlexSplit throws on an unterminated quote). */
function safeShlexSplit(segment: string): string[] | null {
  try {
    return shlexSplit(segment)
  } catch {
    return null
  }
}

/** True when `token` is the leading command of the segment, allowing for a path prefix (`/usr/bin/sed`). */
function segmentCommandIs(segment: string, name: string): boolean {
  return new RegExp('^\\s*(?:\\S*[/\\\\])?' + name + '(?:\\.exe)?\\b', 'i').test(segment)
}

/**
 * Files rewritten in place by `sed -i`, or `[]` when this segment is not an in-place sed.
 *
 * Handles the three spellings that actually appear: GNU `sed -i 's/a/b/' f`, GNU with a backup suffix `sed -i.bak ... f`, and BSD/macOS `sed -i '' 's/a/b/' f` where the empty suffix is its own argv entry. The first non-option token is the script unless `-e`/`-f` already supplied one.
 */
function extractSedInPlaceFiles(segment: string): string[] {
  if (!segmentCommandIs(segment, 'sed')) return []
  const tokens = safeShlexSplit(segment)
  if (tokens === null) return []
  const rest = tokens.slice(1)
  const inPlaceIdx = rest.findIndex((t) => t === '--in-place' || t.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(t))
  if (inPlaceIdx === -1) return []
  const files: string[] = []
  let scriptTaken = rest.some((t) => t === '-e' || t === '-f' || t.startsWith('--expression') || t.startsWith('--file'))
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (i === inPlaceIdx) {
      // BSD sed spells the no-backup form `-i ''`; the empty suffix is a separate argv entry and must not be mistaken for the script.
      if (t === '-i' && rest[i + 1] === '') i++
      continue
    }
    if (t === '-e' || t === '-f' || t === '--expression' || t === '--file') {
      i++
      continue
    }
    if (t.length > 1 && t.startsWith('-')) continue
    if (!scriptTaken) {
      scriptTaken = true
      continue
    }
    files.push(t)
  }
  return files
}

/** Files written by `tee [-a] <file>...`, or `[]` when this segment is not a tee. */
function extractTeeFiles(segment: string): string[] {
  if (!segmentCommandIs(segment, 'tee')) return []
  const tokens = safeShlexSplit(segment)
  if (tokens === null) return []
  return tokens.slice(1).filter((t) => t.length > 0 && !t.startsWith('-'))
}

/** Targets of `>` / `>>` output redirection in one segment. `2>&1`-style fd duplications name no file and are excluded by the target pattern. */
function extractRedirectTargets(segment: string): string[] {
  const targets: string[] = []
  const re = /(?:^|\s)[0-9]?>>?\s*("[^"]*"|'[^']*'|[^\s|&<>]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment)) !== null) {
    const raw = m[1]!
    targets.push(raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") ? raw.slice(1, -1) : raw)
  }
  return targets
}

/** Pathspecs named on a `git restore` command line: everything after `--`, or every non-option token once `-s`/`--source`'s separate value is skipped. */
function extractGitRestorePathspecs(cmd: string): string[] {
  const m = /^\s*git\s+restore\b(.*)$/i.exec(cmd)
  if (m === null) return []
  const tokens = safeShlexSplit(m[1] ?? '')
  if (tokens === null) return []
  const dashDash = tokens.indexOf('--')
  if (dashDash !== -1) return tokens.slice(dashDash + 1)
  const specs: string[] = []
  let skipNext = false
  for (const t of tokens) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (t === '-s' || t === '--source') {
      skipNext = true
      continue
    }
    if (t.startsWith('-')) continue
    specs.push(t)
  }
  return specs
}

/** The repo top-level for `gitDir`, falling back to `gitDir` itself outside a repo. `git diff`/`status --porcelain`/`ls-files --full-name` all report paths relative to this, never to the invoking directory, so a monorepo subpackage cwd must not be used as the resolution base. */
export function gitRepoRoot(gitDir: string): string {
  const toplevel = runGit(['rev-parse', '--show-toplevel'], { cwd: gitDir, timeoutMs: 5000 })
  return toplevel.exitCode === 0 && toplevel.stdout.trim() !== '' ? toplevel.stdout.trim() : gitDir
}

/** Expand `git restore` pathspecs (which may be `.`, a directory, or a glob) into the concrete tracked files git itself matches, repo-root-relative. */
function expandGitPathspecs(specs: string[], gitDir: string): string[] {
  if (specs.length === 0) return []
  const listed = runGit(['ls-files', '--full-name', '--', ...specs], { cwd: gitDir, timeoutMs: 5000 })
  if (listed.exitCode !== 0) return []
  const repoRoot = gitRepoRoot(gitDir)
  return listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((rel) => resolveIndexPath(rel, repoRoot))
}

/** Every path git currently reports as changed or untracked, absolute. The fallback for rewrites whose file set is not on the command line (stash apply/pop, patch application, formatter runs). */
function workingTreeStatusPaths(gitDir: string): string[] {
  const status = runGit(['status', '--porcelain'], { cwd: gitDir, timeoutMs: 5000 })
  if (status.exitCode !== 0) return []
  const repoRoot = gitRepoRoot(gitDir)
  const out: string[] = []
  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue
    let rel = line.slice(3).trim()
    if (rel.length === 0) continue
    // A rename entry reads `old -> new`; only the destination exists on disk to be indexed.
    const arrow = rel.lastIndexOf(' -> ')
    if (arrow !== -1) rel = rel.slice(arrow + 4)
    // Porcelain v1 C-quotes a path containing special characters; the quoted form is JSON-compatible enough to unescape directly, and an unparseable one is better skipped than enqueued as a literal-backslash path that matches nothing.
    if (rel.startsWith('"')) {
      try {
        rel = JSON.parse(rel) as string
      } catch {
        continue
      }
    }
    out.push(resolveIndexPath(rel, repoRoot))
  }
  return out
}

/**
 * Enqueue one rewritten path, filtering the shapes that must never reach the queue: a discard sink, a directory, and anything not actually on disk (a redirect whose target never materialized, or a path parsed out of a command that ran somewhere else). A path under the OS temp dir is refused by enqueueDirtyPathSafe itself, for this detector and the git-mutation one alike.
 */
function enqueueRewrittenPath(absPath: string): void {
  if (/(?:^|[/\\])(?:NUL|nul)$/.test(absPath) || absPath.replace(/\\/g, '/').endsWith('/dev/null')) return
  try {
    if (!statSync(absPath).isFile()) return
  } catch {
    return
  }
  enqueueDirtyPathSafe(absPath, { alreadyResolved: true })
}

/**
 * Enqueue every file rewritten by a working-tree mutation that does NOT move HEAD, so the index does not silently keep serving pre-mutation symbols.
 *
 * The sibling {@link isHeadMovingGitCommand} block covers the reflog-diffable git commands. This covers the rest: `git restore` and `git stash pop|apply` (git, but HEAD never moves, so no reflog base exists) and the plain shell in-place writes that never touch git at all -- `sed -i`, `>`/`>>` redirection, `tee`, `git apply`, `patch`, `prettier --write`, `eslint --fix`. None of these go through Claude Code's Edit tool, so none of them reached `queue/dirty.txt` before.
 *
 * Paths that ARE on the command line are taken from it; the rest fall back to the working-tree status sweep rather than a second guessing mechanism.
 */
export function enqueueNonHeadMovingRewrites(cmd: string, rawCmd: string, cwd: string): void {
  // A stripped `cd sub && sed -i ... f` prefix means `f` is relative to `sub`, not to the hook's cwd -- resolving it against cwd would produce a path that is not on disk and silently enqueue nothing.
  const atCwd = (f: string): string => resolveIndexPath(resolveCdHintPath(rawCmd, f, cwd), cwd)
  const paths: string[] = []
  let needsStatusSweep = GIT_STASH_APPLY_RE.test(cmd)
  if (GIT_RESTORE_RE.test(cmd) && !GIT_RESTORE_STAGED_ONLY_RE.test(cmd)) {
    paths.push(...expandGitPathspecs(extractGitRestorePathspecs(cmd), cwd))
  }
  for (const segment of splitShellSegments(cmd)) {
    if (PATCH_APPLY_SEGMENT_RE.test(segment) && !PATCH_APPLY_INSPECT_ONLY_RE.test(segment)) needsStatusSweep = true
    if (isFormatterWriteSegment(segment)) needsStatusSweep = true
    for (const f of extractSedInPlaceFiles(segment)) paths.push(atCwd(f))
    for (const f of extractTeeFiles(segment)) paths.push(atCwd(f))
    for (const f of extractRedirectTargets(segment)) paths.push(atCwd(f))
  }
  if (needsStatusSweep) paths.push(...workingTreeStatusPaths(cwd))
  for (const p of paths) enqueueRewrittenPath(p)
}

const PIPELINE_PASSTHROUGH_HEADS = new Set(['head', 'tail', 'cat', 'tee', 'less', 'more'])

const CI_FILTER_NAMES = /^(?:generic-ci|jest|vitest|pytest|go_test|cargo_test|cargo|go|make|cmake|gradle|maven|dotnet|turbo|nx|lerna|webpack|eslint|ruff|clippy|flake8|mypy|prettier|tsc)$/

function isCiBuildTestSegment(cleaned: string, cwd: string | null): boolean {
  if (isTestRunnerCommand(cleaned) || isBuildCommand(cleaned) || isTscCommand(cleaned)) return true
  if (/^\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|ci|guards)\b/i.test(cleaned)) return true
  if (/^\s*(cargo|go|dotnet|make|gradle|mvn|pytest|vitest|jest|eslint|ruff)\b/i.test(cleaned)) return true
  const detected = detectFromCommand(cleaned, cwd ?? undefined)
  if (detected !== null && CI_FILTER_NAMES.test(detected.filter.name)) return true
  return false
}

export function pipelineShapeFilter(cmd: string, cwd: string | null): { filter: ToolFilter; argv: string[] } | null {
  if (hasUnquotedOperator(cmd, ['&&', '||', ';'])) {
    // For compound command chains (e.g. `npm run build && npm run typecheck`), route recognized build/test/lint commands to generic-ci.
    const forSplit = cmd.replace(/\s2>(?:&1|\/dev\/null)/g, '')
    if (hasBareBackgroundOrNewline(forSplit)) return null
    const segments = splitShellSegments(forSplit)
    if (segments.length >= 2) {
      let recognizedCiCount = 0
      for (const segment of segments) {
        const cleaned = stripOutputPipeline(segment.trim())
        if (cleaned.length === 0) continue
        if (isCiBuildTestSegment(cleaned, cwd)) {
          recognizedCiCount++
        }
      }
      if (recognizedCiCount > 0) {
        const ci = filterByName('generic-ci')
        // A chain of several commands has no single argv to speak for it, so this branch keeps the empty one the caller used to pass unconditionally. generic-ci reads none.
        return ci === null ? null : { filter: ci, argv: [] }
      }
    }
    return null
  }
  // splitShellSegments breaks on a bare `&`, so an fd duplication shears mid-token: `npx vitest run 2>&1 | tail -40` would arrive as ['npx vitest run 2>', '1', 'tail -40'] and the `1` remnant would read as an unknown stage, falling the single most common test-run spelling back to generic. Strip the redirect first, exactly as extractLineRangeReadsCompound already does for the same splitter. Only the segment walk uses this: stripOutputPipeline below parses the unsplit command and removes trailing redirections itself.
  const forSplit = cmd.replace(/\s2>(?:&1|\/dev\/null)/g, '')
  // The line above checks three separators; splitShellSegments recognizes five, and the two it adds are a bare `&` and a newline. That gap let `a | head -20\nb` past the mixture guard while the splitter still saw the trailing command as a pass-through stage, so the first command's family filter ran over a second, unrelated command's bytes -- the exact over-collapse this function exists to refuse, and invisible because dropping the wanted lines improves the ratio. The check is asked about the same string the splitter parses, after the redirect strip rather than before it, so a legitimate `2>&1` is not read as the bare `&` it contains.
  if (hasBareBackgroundOrNewline(forSplit)) return null
  const segments = splitShellSegments(forSplit)
  if (segments.length < 2) return null
  for (const segment of segments.slice(1)) {
    const head = safeShlexSplit(segment)?.[0]
    if (head === undefined) return null
    // Compare on the bare binary name so an absolute or ./-relative spelling of `head` still reads as a pass-through.
    if (!PIPELINE_PASSTHROUGH_HEADS.has(head.replace(/^.*[/\\]/, ''))) return null
  }
  // The first stage with its trailing redirections removed. detectFromCommand refuses anything carrying an unquoted operator, so it has to be asked about that stage alone rather than the whole pipeline.
  const detected = detectFromCommand(stripOutputPipeline(cmd), cwd ?? undefined)
  // The argv travels with the filter rather than being recomputed (or, as it was, dropped for an empty array at the call site). Every argv-reading behaviour in every filter was dead on this path: grep's single-file attribution saw no file to attribute to, so `rg -n pat one-file.ts | cat` reported "0 file(s)" and discarded all 38 matching lines, and grep's files-only/count-only passthrough, its match-window clipping, and the subcommand and target extraction in the cargo/gh/make filters were all reading an empty argv too. This is the same drift dispatchArgv exists to prevent one layer up, so the value is carried, never re-derived.
  return detected === null ? null : { filter: detected.filter, argv: detected.argv }
}

/** True when the first pipeline stage of `cmd` is a `token-goat bash-output|web-output|mcp-output <id> --full` recall. That command's output is already the model's own earlier full delivery, so it must never be recompressed into a new, smaller pointer -- e.g. `token-goat bash-output <id> --full | head -300` capping a 16,959-byte recall down to a fresh 7,468-byte one. */
export function isFullRecallCommand(cmd: string): boolean {
  const forSplit = cmd.replace(/\s2>(?:&1|\/dev\/null)/g, '')
  if (hasBareBackgroundOrNewline(forSplit)) return false
  const first = splitShellSegments(forSplit)[0]
  if (first === undefined || !segmentCommandIs(first, 'token-goat')) return false
  const tokens = safeShlexSplit(stripOutputPipeline(first))
  if (tokens === null) return false
  return Object.values(RECALL_COMMAND).includes(tokens[1] ?? '') && tokens.includes('--full')
}

/**
 * The file read by a pure file read, or null when `cmd` is not one.
 */
export function pureFileReadPath(cmd: string): string | null {
  const single = extractCatFile(cmd)?.filePath ?? extractHeadFile(cmd)?.filePath ?? extractTailFile(cmd)?.filePath ?? extractLineRangeRead(cmd)?.filePath
  if (single !== undefined) return single
  return singleFileCompoundReadPath(cmd)
}

/** The one file a compound read covers, or null when it covers none or several. Paging a file is normally written as several ranges of it in one command with an `echo` between them, which is one read of one file however many segments it takes; a command touching two files has no single per-file record to be filed under, and merging them under either would let a read of one answer for the other. */
function singleFileCompoundReadPath(cmd: string): string | null {
  const reads = extractLineRangeReadsCompound(cmd)
  if (reads === null || reads.length !== 1) return null
  return reads[0]?.filePath ?? null
}

/**
 * The file line number each delivered line carries, or null when the command alone does not say.
 */
export function deliveredLineNumbers(cmd: string, lineCount: number): Array<number | null> | null {
  const ranged = extractLineRangeRead(cmd)
  if (ranged !== null) {
    const nums: number[] = []
    for (const [lo, hi] of ranged.ranges) for (let n = lo; n <= hi; n++) nums.push(n)
    if (nums.length === 0) return null
    while (nums.length < lineCount) nums.push((nums[nums.length - 1] ?? 0) + 1)
    return nums
  }
  if (extractCatFile(cmd) !== null || extractHeadFile(cmd) !== null) return Array.from({ length: lineCount }, (_, i) => i + 1)
  // A compound read interleaves its ranges with whatever the segments between them printed, and an `echo` can emit any number of lines, so no row can be tied to a file line with certainty. The notice falls back to a count, and the search, which is on text alone, is unaffected.
  if (singleFileCompoundReadPath(cmd) !== null) return Array.from({ length: lineCount }, () => null)
  return null
}

const WHOLE_FILE_DUMP_RE = /^(?:(?:cat|type|Get-Content|gc)|(?:head|tail)[ \t]+-n[ \t]+\d+)[ \t]+(?:"([A-Za-z0-9._\-/\\:+@ ]+)"|'([A-Za-z0-9._\-/\\:+@ ]+)'|([A-Za-z0-9._\-/\\:+@]+))(?:[ \t]+2>(?:&1|\/dev\/null))?[ \t]*$/i

/**
 * True when `cmd` has the shape of a bare whole-file dump AND names the file {@link pureFileReadPath} already extracted from it.
 */
export function isWholeFileDump(cmd: string, extractedPath: string): boolean {
  const m = WHOLE_FILE_DUMP_RE.exec(cmd)
  if (m === null) return false
  const shaped = m[1] ?? m[2] ?? m[3]
  return shaped !== undefined && shaped === extractedPath
}

/**
 * Unwrap a `token-goat compress -c "<cmd>"` wrapper command to find the underlying command being executed. Used by the post-hook to key the bash output cache on the original command — identical to the hash the pre-hook computed before the rewrite. Returns null for any non-wrapper command.
 */
export function unwrapCompressCommand(executed: string): string | null {
  const t = executed.trim()
  if (!/^(?:token-goat|tg)\s+compress\b/.test(t)) return null
  let argv: string[]
  try {
    argv = shlexSplit(t)
  } catch {
    return null
  }
  for (let i = 0; i + 1 < argv.length; i++) {
    const tok = argv[i]
    if (tok === '-c' || tok === '--cmd') return argv[i + 1] ?? null
    if (tok === '--cmd-b64') {
      try {
        return Buffer.from(argv[i + 1] ?? '', 'base64').toString('utf8')
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Detect unbalanced shell quoting or unterminated heredocs in a bash command. Returns a human-readable reason string if a clear syntax error is found, or null if the command appears syntactically valid.
 *
 * Conservative approach: only flags unambiguous errors. Better to miss a false negative (let a broken command run and fail naturally) than to false-positive on valid constructs like `git commit -m "don't do that"` (single quote in double quotes).
 */
export function detectUnbalancedShellSyntax(cmd: string): string | null {
  let inSingle = false
  let inDouble = false
  let i = 0

  // State machine: track whether we're inside single or double quotes
  while (i < cmd.length) {
    const ch = cmd[i]

    if (inSingle) {
      // Inside single quotes: only ' can toggle the state (no escaping possible)
      if (ch === "'") {
        inSingle = false
      }
      i++
      continue
    }

    if (inDouble) {
      // Inside double quotes: " toggles unless it's escaped with \
      if (ch === '\\' && i + 1 < cmd.length) {
        // Skip the next character (it's escaped)
        i += 2
        continue
      }
      if (ch === '"') {
        inDouble = false
      }
      i++
      continue
    }

    // Bare code (outside quotes)

    // Backslash-escapes the next character (real bash semantics outside a string): a `\"` or `\'` here is a literal character, not a quote open — skip both without toggling any quote state.
    if (ch === '\\' && i + 1 < cmd.length) {
      i += 2
      continue
    }

    // Arithmetic expansion `$(( ... ))`: skip the whole span as opaque (tracking nested parens) so a shift operator like `<<`/`>>` inside it is never mistaken for a heredoc redirect.
    if (ch === '$' && cmd[i + 1] === '(' && cmd[i + 2] === '(') {
      let depth = 2
      let j = i + 3
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === '(') depth++
        else if (cmd[j] === ')') depth--
        j++
      }
      i = j
      continue
    }

    // ANSI-C quoting `$'...'`: unlike a plain `'...'` string, a backslash here escapes the next character, so `$'it\'s'` is one complete string, not an opening quote followed by stray text. Reading it with the plain-single-quote rule below closed the string at the escaped apostrophe, left the real closing quote to open a second string that never closed, and reported "an unclosed single quote" on a command that was perfectly valid -- telling the model to abandon it for the Write tool. Skipped as one opaque span, like `$(( ... ))` above.
    if (ch === '$' && cmd[i + 1] === "'") {
      let j = i + 2
      let closed = false
      while (j < cmd.length) {
        if (cmd[j] === '\\') {
          j += 2
          continue
        }
        if (cmd[j] === "'") {
          j++
          closed = true
          break
        }
        j++
      }
      // A `$'` that never closes is still a genuinely unclosed single quote, and is reported as one rather than silently swallowed.
      if (!closed) {
        inSingle = true
        break
      }
      i = j
      continue
    }

    // A `#` that starts a word (preceded by whitespace, or at the very start of the command) opens a real shell comment running to end of line — quote-like characters in it (e.g. an apostrophe in "don't") are literal text, not shell syntax.
    if (ch === '#' && (i === 0 || /\s/.test(cmd[i - 1] ?? ''))) {
      const nl = cmd.indexOf('\n', i)
      i = nl === -1 ? cmd.length : nl + 1
      continue
    }

    if (ch === "'") {
      inSingle = true
      i++
      continue
    }

    if (ch === '"') {
      inDouble = true
      i++
      continue
    }

    // Check for heredoc syntax: <<[-~]?WORD or <<[-~]?'WORD' or <<[-~]?"WORD"
    if (ch === '<' && i + 1 < cmd.length && cmd[i + 1] === '<') {
      // Check for here-string (<<<) and skip it as bare code
      if (i + 2 < cmd.length && cmd[i + 2] === '<') {
        i += 3
        continue
      }
      let j = i + 2
      // Optional - or ~ modifier for indented heredoc
      let hasIndentModifier = false
      if (j < cmd.length && (cmd[j] === '-' || cmd[j] === '~')) {
        hasIndentModifier = true
        j++
      }
      // Skip whitespace
      while (j < cmd.length && cmd[j] === ' ') {
        j++
      }
      if (j < cmd.length) {
        // Check for optional quotes around the delimiter
        let delimStart = j
        if (cmd[j] === '"' || cmd[j] === "'") {
          delimStart = j + 1
          // Find closing quote
          const quoteChar = cmd[j]
          let delimEnd = delimStart
          while (delimEnd < cmd.length && cmd[delimEnd] !== quoteChar) {
            delimEnd++
          }
          if (delimEnd >= cmd.length) {
            // Unclosed quote in heredoc opener — that's already a syntax error
            return 'an unclosed quote in a heredoc opener'
          }
          j = delimEnd + 1
        } else {
          // Unquoted delimiter: continue until space, newline, or special char
          let delimEnd = delimStart
          while (delimEnd < cmd.length && /\w/.test(cmd.charAt(delimEnd))) {
            delimEnd++
          }
          j = delimEnd
        }
        // Extract the delimiter word
        const delimiter = cmd.slice(delimStart, j).replace(/["']/g, '')
        if (delimiter) {
          // Scan line-by-line from the end of the opener to find the terminator, tracking exact offsets so a match lets us skip the whole heredoc body. The body is literal shell text, not shell syntax — a stray apostrophe in prose like "it's" must not be rescanned as a quote delimiter.
          let scanPos = j
          let terminatorEnd = -1
          while (scanPos <= cmd.length) {
            const nl = cmd.indexOf('\n', scanPos)
            const lineEnd = nl === -1 ? cmd.length : nl
            let line = cmd.slice(scanPos, lineEnd)
            // Strip trailing backslash-r (CRLF line ending) to match closing delimiter
            if (line.endsWith('\r')) {
              line = line.slice(0, -1)
            }
            const isMatch = hasIndentModifier ? line.trim() === delimiter : line === delimiter
            if (isMatch) {
              terminatorEnd = nl === -1 ? cmd.length : nl + 1
              break
            }
            if (nl === -1) break
            scanPos = nl + 1
          }
          if (terminatorEnd === -1) {
            return `an unterminated heredoc (${delimiter} never appears on its own line)`
          }
          // Skip past the entire heredoc body before resuming the scan.
          i = terminatorEnd
          continue
        }
      }
    }

    i++
  }

  // Final check: unbalanced quotes
  if (inSingle) {
    return 'an unclosed single quote'
  }
  if (inDouble) {
    return 'an unclosed double quote'
  }

  return null
}
