/** Aggregated filter/rule counts for all hook types. Dynamic counts are computed from the live source arrays and update automatically when entries are added to those arrays. Hand-listed counts are the length of an entry list in this file, one entry per decision category, each carrying an anchor that tests/guards/filter_count_entries_anchor.test.ts requires to still be used in the named source file: a call, a registration or a config read on the decision path, never the declaration of a helper that stays exported after its last caller is gone. */

import { FAILURE_EXTRACTORS } from './failures.js'
import { FILTERS } from './filters.js'
import {
  BUILD_COMMAND_PATTERNS,
  MONITORING_COMMAND_PATTERNS,
  LOCK_FILE_COUNT,
  MANIFEST_FILE_COUNT,
  BUILD_DIR_COUNT,
  GENERATED_EXT_COUNT,
} from './hints/lang_patterns.js'

/** One counted decision category: its name, the repo-relative source file that implements it, and a literal that must appear in that file's code as a use (outside full-line comments, imports, export lists and the declaration of the name it starts with) for the category to still exist. */
export interface CountedEntry {
  readonly name: string
  readonly file: string
  readonly anchor: string
}

/** A hand-listed count: the entries it is the length of, and the constant name the guard quotes when an anchor goes stale. */
export interface CountedGroup {
  readonly constant: string
  readonly entries: readonly CountedEntry[]
}

/** Builds the entries of one source file from [name, anchor] pairs. */
function inFile(file: string, pairs: ReadonlyArray<readonly [string, string]>): CountedEntry[] {
  return pairs.map(([name, anchor]) => ({ name, file, anchor }))
}

// --- Dynamic (auto-updates when source arrays grow) ---

/** Universal line-pattern bash output compression rules (src/filters.ts). */
export const BASH_OUTPUT_FILTER_COUNT = FILTERS.length

/** Build-command recall patterns (src/hints/lang_patterns.ts). */
export const BUILD_RECALL_PATTERN_COUNT = BUILD_COMMAND_PATTERNS.length

/** Long-running monitoring command recall patterns (src/hints/lang_patterns.ts). */
export const MONITORING_PATTERN_COUNT = MONITORING_COMMAND_PATTERNS.length

/** File/directory path pattern entries: lock files, manifests, build dirs, generated exts. */
export const PATH_PATTERN_COUNT =
  LOCK_FILE_COUNT + MANIFEST_FILE_COUNT + BUILD_DIR_COUNT + GENERATED_EXT_COUNT

/** Test-runner failure block extractors, the size of the table extractFailures dispatches through (src/failures.ts); extractGeneric is the fallback and not counted. */
export const FAILURE_RUNNER_COUNT = FAILURE_EXTRACTORS.size

// --- Hand-listed (the entry list is the count; a typed number would drift, and the guard checks each anchor) ---

// Counting rule for every list below: one entry per distinct top-level decision category (a gate whose predicate recognizes a specific situation), not per literal return statement; phrasing variants of one computed outcome are a single entry.
const FILE_TYPE_HANDLER_ENTRIES = inFile('src/hints/file_type_handler.ts', [
  ['PDF', 'return handlePdf('],
  ['SVG', 'return handleSvg('],
  ['XML (xml, dtsx, ampkg, xaml)', 'return handleXml('],
  ['HTML', 'return handleHtml('],
  ['txt/log', 'return handleTxt('],
  ['XLSX', 'return handleXlsx('],
  ['PPTX', 'return handlePptx('],
  ['DOCX', 'return handleDocx('],
  ['office binary (ODT/ODS/OTT/ODP)', 'return handleOfficeBinary('],
  ['SQLite database', 'return handleSqlite('],
  ['Parquet', 'return handleParquet('],
  ['CSV/TSV', 'return handleCsv('],
  ['VTT/SRT transcript', 'return handleTranscript('],
  ['JSON', 'return handleJson('],
  ['YAML', 'return handleYaml('],
  ['JSONL', 'return handleJsonl('],
  ['generic large file', 'return handleGenericLarge('],
])

const BASH_INTERCEPTOR_ENTRIES = inFile('src/hooks_bash.ts', [
  ['unbounded filesystem-root walk deny', 'detectUnboundedWalk('],
  ['MSYS double-backslash deny/repair', 'msysDamagesCommand('],
  ['unbalanced shell quoting/heredoc warning', 'warn_unbalanced_shell_quoting'],
  ['tasks output recall', 'extractTasksOutput('],
  ['tool-results file hint', 'extractToolResultsFile('],
  ['find', 'extractFindCommand('],
  ['directory listing (incl. ls-pipe)', 'extractDirectoryListing('],
  ['for-loop wc -l probe', 'extractForLoopWcL('],
  ['terminal XML parsing', 'extractTerminalXmlParsing('],
  ['sed/awk line range', 'extractLineRangeRead('],
  ['Get-Content -Tail', 'extractGetContentTail('],
  ['Get-Content | Select-Object -First', 'extractGetContentSelectFirst('],
  ['Get-Content -TotalCount', 'extractGetContentHead('],
  ['cat | jq', 'extractCatJsonPipe('],
  ['ConvertFrom-Json pipeline', 'extractPowerShellJsonPipeline('],
  ['cat / cat with flags', 'extractCatFile('],
  ['cat multi-file', 'extractCatFilesMulti('],
  ['PowerShell-wrapped Get-Content', 'extractPowerShellWrappedGetContent('],
  ['cat via WSL', 'extractWslCatFile('],
  ['python open()/heredoc', 'extractPythonFileRead('],
  ['tail / tail -c', 'extractTailFile('],
  ['head', 'extractHeadFile('],
  ['node readFileSync/require', 'extractNodeFileRead('],
  ['[IO.File] read', 'extractPowerShellFileMethodRead('],
  ['structural index rewrite', 'detectStructuralIndexRewrite('],
  ['grep | grep chain', 'extractGrepPipeChain('],
  ['markdown heading grep', 'extractMarkdownHeadingGrep('],
  ['rg symbol search', 'extractRgSymbolSearch('],
  ['rg structural search', 'extractRgStructuralSearch('],
  ['monitoring-command recall', 'getMonitoringRecallHint('],
  ['curl -o download dedup', 'extractCurlDownload('],
  ['curl GET cache', 'isCurlGetCommand('],
  ['gh api GET recall', 'isReadOnlyGhApi('],
  ['scoped git status/diff --stat recall', 'isScopedGitStatusOrDiffStatCommand('],
  ['CLI surgical-read dedup', 'extractTgSurgicalRead('],
  ['test-runner no-scope advisory', 'hasTestRunScopeOrBudget('],
  ['cached-run recall', 'recallWorthShowing('],
  ['compress-wrap rewrite', 'maybeCompressRewrite('],
])

const READ_HOOK_ENTRIES = inFile('src/hooks_read.ts', [
  ['read-range lock (and its evasion lock, one message)', 'getReadRangeDenials('],
  ['verified cross-session evidence hint', 'findVerifiedFileEvidence('],
  ['node_modules deny', 'isNodeModulesPath('],
  ['lock-file deny', 'isLockFile('],
  ['.tsbuildinfo deny', "'.tsbuildinfo'"],
  ['build-dir/generated-file deny', 'isInBuildDir('],
  ['package-manifest hint', 'buildPackageManifestHint('],
  ['tsconfig re-read', 'isTsConfigFile('],
  ['manifest re-read', 'isManifestFile('],
  ['skill-file stale-compact advisory', 'detectSkillFile('],
  ['stable-doc compact serving', 'stable_doc_compacts'],
  ['notebook output stripping', 'isNotebook'],
  ['markdown large-file intercept', 'MARKDOWN_SIZE_THRESHOLD'],
  ['.improve-state re-read denial', 'improve-state-'],
  ['content.json spill re-read denial', "'content.json'"],
  ['.env re-read denial', '.env('],
  ['session-artifact re-read dedup', 'isSessionArtifactFile('],
  ['session-artifact first-read size gate', 'TASK_OUTPUT_DENY_BYTES'],
  ['doc-file auto-diff on re-read', 'isDocDiffable'],
  ['cross-session read dedup', 'scanCrossSessionManifests('],
  ['truncated-read redirect', 'truncated_read_min_lines'],
  ['markdown 2nd-read deny', 'fullReads >= 1 && /'],
  ['count-based source-file deny', 'fullReads >= 2 && !fileAlreadyDenied'],
  ['size/count-based generic re-read deny', 'reread_deny_min_bytes'],
  ['large-file deny/hint gate', 'size >= LARGE_FILE_BYTES'],
  ['universal file-type handler catch-all', 'dispatchFileTypeHandler('],
  ['first-read symbol policy (three sites, one entry)', 'evaluateFirstReadSymbolPolicy('],
  ['already-served proof deny', 'alreadyServedOutputId('],
  ['contained-range deny', 'denyRangeReread'],
  ['sequential-paging deny', 'isSequentialChain'],
  ['structured json/html re-read deny', 'rereadBytes >= 8192'],
  ['subagent markdown first-read deny (opt-in)', 'subagent_markdown_first_read_deny'],
  ['already-read note', 'pagingNote'],
  ['pre-read nudge', 'isXmlNudge'],
])

const GREP_HOOK_ENTRIES = inFile('src/hooks_grep.ts', [
  ['single-file structural search hint', 'extractGrepStructuralSearch('],
  ['repeat-search dedup recall', 'preGrepDedupHandler('],
  ['content-mode path-fold rewrite', 'foldGrepContentHandler('],
])

const GLOB_HOOK_ENTRIES = inFile('src/hooks_glob.ts', [
  ['broad catch-all glob hint', 'isBroadCatchAllGlob('],
  ['repeat-glob dedup recall', 'preGlobDedupHandler('],
])

const WEB_FETCH_HOOK_ENTRIES = inFile('src/hooks_fetch.ts', [
  ['webfetch allow/deny URL policy', 'webFetchPolicyUrls('],
  ['repeat-fetch recall', 'getWebOutput('],
  ['untrusted-page fence with injection scan', 'fenceWithMatches('],
  ['secret redaction of the fetched body', 'redactSecrets('],
  ['HTML body clean-text compression', 'extractCleanText('],
])

const WEB_SEARCH_HOOK_ENTRIES = inFile('src/hooks_websearch.ts', [
  ['repeat-search dedup deny', 'getMcpOutput('],
  ['untrusted-result fence with injection scan', 'fenceWithMatches('],
  ['secret redaction of the search result', 'redactSecrets('],
])

const AGENT_SPAWN_HOOK_ENTRIES = inFile('src/hooks_agent_spawn.ts', [
  ['scoped-spawn deny', 'buildScopedSpawnDeny('],
  ['near-duplicate outstanding spawn advisory', 'findDuplicateOutstandingPrompt('],
  ['subagent briefing injection', 'buildSubagentBriefing('],
  ['unrestricted-spawn advisory', 'buildUnrestrictedSpawnAdvisory('],
  ['subagent report fenced-block compaction', 'planReportCompaction('],
])

const IMAGE_HOOK_ENTRIES = [
  ...inFile('src/image_shrink.ts', [['Read-tool image shrink', 'loadingHiddenRuleCheck(preReadImageHandler)']]),
  ...inFile('src/hooks_browser_image.ts', [
    ['browser/MCP screenshot image shrink', 'shrinkImageBlock('],
    ['browser tab-context dedup', 'dedupTabContext('],
  ]),
  ...inFile('src/hooks_screenshot.ts', [['screenshot-without-destination deny', 'hasDestinationPath(']]),
]

/** Every hand-listed entry list, for tests/guards/filter_count_entries_anchor.test.ts. */
export const COUNTED_GROUPS: readonly CountedGroup[] = [
  { constant: 'FILE_TYPE_HANDLER_COUNT', entries: FILE_TYPE_HANDLER_ENTRIES },
  { constant: 'BASH_INTERCEPTOR_COUNT', entries: BASH_INTERCEPTOR_ENTRIES },
  { constant: 'READ_HOOK_CONDITION_COUNT', entries: READ_HOOK_ENTRIES },
  { constant: 'GREP_HOOK_COUNT', entries: GREP_HOOK_ENTRIES },
  { constant: 'GLOB_HOOK_COUNT', entries: GLOB_HOOK_ENTRIES },
  { constant: 'WEB_FETCH_HOOK_COUNT', entries: WEB_FETCH_HOOK_ENTRIES },
  { constant: 'WEB_SEARCH_HOOK_COUNT', entries: WEB_SEARCH_HOOK_ENTRIES },
  { constant: 'AGENT_SPAWN_HOOK_COUNT', entries: AGENT_SPAWN_HOOK_ENTRIES },
  { constant: 'IMAGE_HOOK_COUNT', entries: IMAGE_HOOK_ENTRIES },
]

/** File type intercept handlers, one per branch of dispatchFileTypeHandler plus its generic catch-all (src/hints/file_type_handler.ts). */
export const FILE_TYPE_HANDLER_COUNT = FILE_TYPE_HANDLER_ENTRIES.length

/** Pre-bash interceptors, one per decision category in preBashHandlerInner (src/hooks_bash.ts). */
export const BASH_INTERCEPTOR_COUNT = BASH_INTERCEPTOR_ENTRIES.length

/** Distinct deny/context decision paths in the pre-read hook, one per category in preReadHandlerInner (src/hooks_read.ts). */
export const READ_HOOK_CONDITION_COUNT = READ_HOOK_ENTRIES.length

/** Grep tool hooks: structural-search hint, repeat-search recall, content-mode path fold (src/hooks_grep.ts). */
export const GREP_HOOK_COUNT = GREP_HOOK_ENTRIES.length

/** Glob tool hooks: broad catch-all glob hint, repeat-glob recall (src/hooks_glob.ts). */
export const GLOB_HOOK_COUNT = GLOB_HOOK_ENTRIES.length

/** WebFetch hooks: URL policy, repeat-fetch recall, page fence, secret redaction, HTML compression (src/hooks_fetch.ts). */
export const WEB_FETCH_HOOK_COUNT = WEB_FETCH_HOOK_ENTRIES.length

/** WebSearch hooks: repeat-search deny, result fence, secret redaction (src/hooks_websearch.ts). */
export const WEB_SEARCH_HOOK_COUNT = WEB_SEARCH_HOOK_ENTRIES.length

/** Agent-spawn hooks: scoped-spawn deny, duplicate-spawn advisory, briefing injection, unrestricted-spawn advisory, report compaction (src/hooks_agent_spawn.ts). */
export const AGENT_SPAWN_HOOK_COUNT = AGENT_SPAWN_HOOK_ENTRIES.length

/** Image hooks: Read-tool shrink, browser screenshot shrink, tab-context dedup, screenshot destination deny (src/image_shrink.ts, src/hooks_browser_image.ts, src/hooks_screenshot.ts). */
export const IMAGE_HOOK_COUNT = IMAGE_HOOK_ENTRIES.length

// --- Total ---

/** Sum of all filter/rule/pattern counts across every hook type. The dynamic counts and FAILURE_RUNNER_COUNT update with their source tables; every other term is the length of a hand-listed entry list above and needs an entry added when its module gains a handler. */
export const TOTAL_FILTER_COUNT =
  BASH_OUTPUT_FILTER_COUNT +
  BUILD_RECALL_PATTERN_COUNT +
  MONITORING_PATTERN_COUNT +
  PATH_PATTERN_COUNT +
  FAILURE_RUNNER_COUNT +
  FILE_TYPE_HANDLER_COUNT +
  BASH_INTERCEPTOR_COUNT +
  READ_HOOK_CONDITION_COUNT +
  GREP_HOOK_COUNT +
  GLOB_HOOK_COUNT +
  WEB_FETCH_HOOK_COUNT +
  WEB_SEARCH_HOOK_COUNT +
  AGENT_SPAWN_HOOK_COUNT +
  IMAGE_HOOK_COUNT
