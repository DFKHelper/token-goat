import { Command } from 'commander'
import { attemptedCommandName, suggestForUnknownCommand } from './command_intent.js'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
// Type-only imports: erased at compile time, so referencing them here does not eagerly load mcp_server.js (and transitively the whole MCP protocol layer and zod) at CLI startup. The runtime values are lazy-imported only inside cmdMcpServe.
import type { createMcpServer as CreateMcpServerFn } from './mcp_server.js'
import type { StdioServerTransport as StdioServerTransportClass } from './mcp_stdio.js'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved, MAX_FILES_SCANNED } from './baseline.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { _useRichStats } from './stats_report.js'
import { UNTRUSTED_WEB_TAG } from './injection_scan.js'
import { fenceUntrusted } from './untrusted_fence.js'
import { getTrackedFiles } from './repomap.js'
import { collectWalkIndexFiles, MAX_FILES_SCANNED_FORCED } from './walk_index.js'
import { dataDir, ENV_KEYS, globalDbPath, VERSION } from './constants.js'
import { assetEmbedSha, indexFileSync, indexFileEmbeddings, indexedPathSpellingIsStale, isEmbedFresh, isParseSkipEligible, loadRegexExtractors, maxChunksEmbedSha } from './parser.js'
import { withDeclaredSkipScopeRoot } from './skip_scope.js'
import { deleteFileEmbeddings, embeddingsDepsAvailable, ensureEmbeddingProvenance } from './embeddings.js'
import { pruneUnembeddableChunks } from './embed_backfill.js'
import { foregroundDownloadDeferred, offlineEmbedNotice, WARM_COMMAND } from './embed_preflight.js'
import { rerunWithEnvProxy } from './env_proxy.js'
import { allowReadOnlyIndex, getDb } from './db.js'
import { pruneDeletedFiles, removeFileFromIndex } from './index_prune.js'
import { recordIndexedRoot } from './indexed_roots.js'
import { recordKnownRootThrottled } from './known_roots.js'
import { fingerprintFile } from './fingerprint.js'
import { getFileEntry } from './index_reader.js'
import { parserFingerprintForLanguage } from './parser_stamp.js'
import { detectLanguageOfFile } from './parser_types.js'
import { isEmbeddableDocument } from './doc_embed_extract.js'
import { displaySafeText, hostPathOfTypedPath, resolveIndexPath, displaySafeJson } from './paths.js'
import { isUnderSystemTemp, resolveProjectRoot } from './project.js'
import { runParallelSearch } from './search/search_cli.js'
import { ALL_CHANNELS, type SearchChannel } from './search/types.js'
import { embedPolicyResolver, runDetachedWorkerDaemon } from './worker.js'
import { ensureWorkerAlive, isWorkerRunning, startDetachedWorker, stopWorker, WorkerAlreadyRunningError } from './worker_lifecycle.js'
import { enqueueDirtyPathsSafe } from './hooks_index.js'
// Loaded on demand inside cmdCompress, not at module scope: bash_runner pulls in the whole bash tool-filter registry (every language, linter, cloud and package-manager filter), which only the compress command ever uses. See the same reasoning for relay in cmdHook.
import { runRead, runPrSlice } from './read_commands.js'
import { runSymbol } from './read_symbol.js'
import { namedSpecsMergeable, readSpecsMergeable } from './read_spec.js'
import { runBrief } from './read_brief.js'
import { runSection } from './read_section.js'
import { runListSections } from './read_inspect.js'
import { runSkeleton, runOutline, type SkeletonOptions } from './read_outline.js'
import { runSemantic, runSemanticMulti } from './read_semantic.js'
import { runSemanticDistances } from './semantic_distances.js'
import { runRefs } from './read_refs.js'
import {
  runExit,
  runExitText,
  noteExtraFileArgs,
  emitExtraFileArgsNote,
  requireInt,
  requireNonNegativeInt,
  requirePositiveInt,
} from './cli_dispatch.js'
import { generateCompactHelp } from './cli_help.js'
import { registerFormatCommands } from './cli_cmd_formats.js'
import { registerAnalysisCommands } from './cli_cmd_analysis.js'
import { registerSessionCommands } from './cli_cmd_session.js'
import { cmdHookServerRun, cmdHookServerStatus, cmdHookServerStop } from './cli_hook_server.js'
import { cmdInstall, cmdMcpStatus, cmdUninstall } from './cli_install.js'
import { runPayloads } from './cli_payloads.js'
import { _applyFiltersAndPrint, cmdBashOutput, cmdMcpOutput, cmdWebOutput, type RecallFilterOpts } from './cli_cached_output.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { BRIDGE_CAPABILITY_MATRIX, bridgesStatusToJson, formatBridgesStatus } from './bridges_status.js'
import { buildCommandManifest, filterCommandManifest, formatCommandManifest } from './cli_commands.js'
import { ensureNewline, extractErrorMessage, cappedSourceBytesSaved, isUnderBlockedRoot, countNoun } from './util.js'
import { findProject } from './project.js'
import { colorStdout, stripAnsiEscapes } from './render/ansi.js'
import { loadConfig, getLastConfigParseError, getLastProjectConfigParseError, lastProjectConfigLockedKeys, withConfigProjectRoot } from './config.js'
import { applyIndexingPriority } from './process_priority.js'
import { runStats } from './cli_stats.js'
import { runDoctorAndExit, runDoctorChecks } from './cli_doctor.js'
import { fetchDoc, getDocSections, formatSections, getSectionContent } from './gdrive.js'
import { runBenchCommand } from './cli_bench.js'
import { expandGlobs } from './cli_diagnostics.js'
export { expandGlobs }
import { compressText, createHandoff, resolveHandoff, retrieveText, CONTENT_MAX_INPUT_CHARS } from './content_store.js'
import { CliError, formatCommandError, formatFailedResultText, formatParseError } from './command_error.js'

// Defined in a leaf so command modules cli.ts imports can render an error the same way without importing cli.ts back; re-exported here for the many modules that already take CliError from cli.js.
export { CliError, formatCommandError }

export function out(text: string): void {
  const payload = colorStdout() ? text : stripAnsiEscapes(text)
  process.stdout.write(ensureNewline(payload))
}

export function err(text: string): void {
  process.stderr.write(ensureNewline(text))
}

function readBoundedText(text: string | undefined, file: string | undefined): string {
  if (text !== undefined && file !== undefined) throw new CliError('provide text or --file, not both')
  if (text === undefined && file === undefined) throw new CliError('provide text or --file')
  let value: string
  if (file !== undefined) {
    if (fs.statSync(file).size > CONTENT_MAX_INPUT_CHARS) {
      throw new CliError(`file exceeds the ${CONTENT_MAX_INPUT_CHARS}-byte safety limit`)
    }
    // Masked here, at intake: both stores keep this text and `retrieve` and `handoff-resolve --full` print it back verbatim, and the keyword-driven redactSecrets pass they run misses a dotenv value whose key looks harmless.
    value = redactIfDotenv(file, fs.readFileSync(file, 'utf8'))
  } else {
    if (text === undefined) throw new CliError('provide text or --file')
    value = text
  }
  if (value.length > CONTENT_MAX_INPUT_CHARS) {
    throw new CliError(`text exceeds the ${CONTENT_MAX_INPUT_CHARS}-character safety limit`)
  }
  return value
}

function formatCompression(result: ReturnType<typeof compressText>, forcePayload = false, withheldNotice = 'payload withheld: inlining it would cost more tokens than the original text; pass --payload to print it anyway'): string {
  const lines = [
    `id: ${result.id}`,
    `encoding: ${result.encoding}`,
    `original_bytes: ${result.originalBytes}`,
    `compact_bytes: ${result.compactBytes}`,
    `bytes_saved: ${result.bytesSaved}`,
    `tokens_saved: ${result.tokensSaved}`,
    `recovery: ${result.recovery}`,
  ]
  // The payload is base64url and tokenizes far worse per byte than the source text, so inlining it usually costs more tokens than it saves; print it only when it genuinely wins or the caller asked for it explicitly.
  if (!result.inlineWins && !forcePayload) {
    lines.push(withheldNotice)
    return lines.join('\n')
  }
  lines.push('payload:', result.compact)
  return lines.join('\n')
}

function cmdContentCompress(text: string | undefined, opts: { file?: string; payload?: boolean }): void {
  out(formatCompression(compressText(readBoundedText(text, opts.file)), opts.payload === true))
}

function cmdRetrieve(id: string, opts: RecallFilterOpts): void {
  const text = retrieveText(id)
  if (text === null) throw new CliError(`no token-goat content for id: ${id}. The local cache may have expired.`)
  // retrieve is the lossless round-trip for compress-text; other commands print `recovery: token-goat retrieve <id>` promising the original bytes back, so with no narrowing flag it must stay byte-verbatim -- only opt into sibling head/tail elision once the caller explicitly asks for a slice.
  const noNarrowing = opts.head === undefined && opts.tail === undefined && opts.grep === undefined && opts.section === undefined && opts.maxMatches === undefined && opts.lines === undefined && opts.context === undefined
  // Written raw, not through out() or the shared filter: both strip ANSI codes for a non-colour stdout and the filter re-joins CRLF lines with LF, so the "original bytes back" came back altered whenever the stored text had either. No trailing newline is added either, so `retrieve <id> > file` reproduces the file compress-text read.
  if (noNarrowing && opts.lineNumbers !== true) {
    process.stdout.write(text)
    return
  }
  _applyFiltersAndPrint(text, noNarrowing ? { ...opts, full: true } : opts)
}

function cmdHandoffCreate(name: string, text: string | undefined, opts: { file?: string }): void {
  const result = createHandoff(name, readBoundedText(text, opts.file))
  out(displaySafeJson(result))
}

function cmdHandoffResolve(name: string, opts: { full?: boolean }): void {
  const result = resolveHandoff(name, { full: opts.full === true })
  if (result === null) throw new CliError(`no local handoff named "${name}" in this project`)
  out(typeof result === 'string' ? result : formatCompression(result, false, 'payload withheld: inlining it would cost more tokens than the original text; pass --full to get the original text back outright'))
}

// The numeric CLI-flag validators live in cli_dispatch.ts; re-exported here because half the command modules import them from this path and half from that one, and one definition behind both spellings is what keeps the two from drifting.
export { requireInt, requireNonNegativeInt, requirePositiveInt }

// --- Command handlers -------------------------------------------------------

// Thin wrapper: all orchestration (embedding search, merge, FTS fallback, formatting) lives in read_semantic.ts's runSemantic so the MCP server (mcp_server.ts) can call the same logic in-process without going through the CLI/commander layer.
async function cmdSemantic(query: string | undefined, more: string[], opts: { limit?: string; json?: boolean; grep?: string; excludeTests?: boolean; preflight?: boolean; warm?: boolean; distances?: boolean; all?: boolean }): Promise<void> {
  if (opts.distances === true) {
    if (query !== undefined || opts.preflight === true || opts.warm === true) throw new CliError('--distances reports recorded queries and runs none; drop the query, --preflight and --warm')
    const { text, code } = runSemanticDistances({ ...(opts.all === true ? { all: true } : {}) })
    out(text)
    process.exitCode = code
    return
  }
  if (!query && !opts.preflight && !opts.warm) {
    throw new CliError('missing required argument: query')
  }
  // Rejected rather than ignored, as `symbol` rejects --grep with a name: --preflight never searches, so several queries beside it can only be a mistake.
  if (opts.preflight === true && more.length > 0) {
    throw new CliError('--preflight checks the embedding setup and runs no query; drop the queries, or drop --preflight to search')
  }
  // --warm is a download the user asked for now, so on a machine whose proxy this process's fetch would go around, the command runs again in a child that goes through it (env_proxy.ts rerunWithEnvProxy).
  if (opts.warm === true) {
    const code = rerunWithEnvProxy(spawnSync)
    if (code !== null) {
      process.exitCode = code
      return
    }
  }
  const limit = opts.limit !== undefined ? requireNonNegativeInt('--limit', opts.limit) : 20
  const semanticOpts = {
    limit,
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
    ...(opts.excludeTests === true ? { excludeTests: true } : {}),
    ...(opts.preflight === true ? { preflight: true } : {}),
    ...(opts.warm === true ? { warm: true } : {}),
  }
  const { text, code } = more.length > 0 ? await runSemanticMulti([query ?? '', ...more], semanticOpts) : await runSemantic(query ?? '', semanticOpts)
  // --json must always land on stdout so `| jq .` works even on a no-match/error exit -- only the text-mode path routes a non-zero code to stderr, as a command error.
  if (opts.json === true || code === 0) out(text)
  else err(formatFailedResultText(text))
  process.exitCode = code
}

async function cmdSearch(
  query: string | undefined,
  more: string[],
  opts: {
    limit?: string
    channels?: string
    project?: string | boolean
    json?: boolean
    minScore?: string
  },
): Promise<void> {
  const fullQuery = [query, ...more].filter(Boolean).join(' ').trim()
  if (!fullQuery) {
    throw new CliError('missing required argument: query')
  }
  let projectRoot: string | undefined
  if (opts.project === true) {
    projectRoot = resolveProjectRoot({ project: process.cwd() })
  } else if (typeof opts.project === 'string') {
    projectRoot = resolveProjectRoot({ project: opts.project })
  }
  const limit = opts.limit !== undefined ? requirePositiveInt('--limit', opts.limit) : 20
  let channels: SearchChannel[] | undefined
  if (opts.channels) {
    const rawList = opts.channels.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
    for (const c of rawList) {
      if (!ALL_CHANNELS.includes(c as SearchChannel)) {
        throw new CliError(`Unknown search channel '${c}'. Supported channels: ${ALL_CHANNELS.join(', ')}`)
      }
    }
    channels = Array.from(new Set(rawList)) as SearchChannel[]
  }
  let minScore: number | undefined
  if (opts.minScore !== undefined) {
    const rawVal = opts.minScore.trim()
    const parsed = Number(rawVal)
    if (rawVal === '' || !Number.isFinite(parsed) || parsed < 0) {
      throw new CliError(`Invalid --min-score: '${opts.minScore}' (must be a non-negative number)`)
    }
    minScore = parsed
  }

  const { text, code } = await runParallelSearch({
    query: fullQuery,
    channels,
    limit,
    projectRoot,
    json: opts.json === true,
    minScore,
  })
  if (opts.json === true || code === 0) out(text)
  else err(formatFailedResultText(text))
  process.exitCode = code
}

/** How long `index` spends embedding in the foreground, after the first file, before it leaves the rest to the background worker. */
export const INDEX_INLINE_EMBED_BUDGET_MS = 20_000

export async function cmdIndex(
  pathArg?: string,
  opts: { walk?: boolean; dbPath?: string; force?: boolean; forceWalk?: boolean; embed?: boolean; embedBudgetMs?: number } = {},
): Promise<void> {
  // A bulk walk is long-running background work even though the user typed it: they start it and go back to their editor. The daemon lowers its own priority for the same reason; doing it here too is what makes "both indexing paths" true rather than only the invisible one.
  applyIndexingPriority()
  // A typed root can be spelled at a drive mount (`/mnt/c/x` or `/c/x` reaching a Windows process unconverted, `C:\x` under WSL). hostPathOfTypedPath opens it where this host keeps it; used as typed, the mount named a folder that does not exist here and the run reported `Indexed 0 files` as a success.
  const root = pathArg === undefined ? process.cwd() : hostPathOfTypedPath(pathArg)
  if (!fs.existsSync(root)) throw new CliError(`'${pathArg ?? root}' does not exist.`)
  const dbPath = opts.dbPath ?? globalDbPath()
  const force = opts.force === true
  const useWalk = opts.walk === true || opts.forceWalk === true
  let files = getTrackedFiles(root)
  if (files.length === 0) {
    if (!useWalk) {
      throw new CliError(
        `no tracked files found under '${root}' (is it a git repo?). ` +
          `Pass --walk or --force-walk to index a non-git folder.`,
      )
    }
    // Opt-in non-git fallback: a bounded directory walk, guarded against over-broad roots / oversized trees and stripped of .env / generated files.
    files = collectWalkIndexFiles(root, { force: opts.forceWalk === true })
    if (opts.forceWalk === true) {
      process.stderr.write(
        `token-goat: --force-walk raised the walk cap to ${MAX_FILES_SCANNED_FORCED} files; ` +
          `indexing ${countNoun(files.length, 'file')} may take a long time and produce a large index. ` +
          `Run 'token-goat doctor' afterwards to check index size.\n`,
      )
    }
  }
  const blockedRoots = loadConfig().worker.blocked_roots
  const ixCfg = loadConfig().indexing
  // The root whose segments indexing.skip_dirs is tested against: a project kept under an ancestor named `build` must not read as vendored. Spelled like the keys it is compared with.
  const walkRootKey = resolveIndexPath(root)
  // Whether a file is embedded is decided by its own project's configuration, through the rule the worker's drain applies to the same file (see embedPolicyResolver), never by the directory this command runs in: run inside a monorepo package, or given a path from elsewhere, the index and the drain stamped one file two ways and each undid the other. The other indexing keys this function reads through loadConfig() with no root are right from any root only because each is in PROJECT_LOCKED_KEYS, so no project file can set one.
  const embedPolicy = embedPolicyResolver()
  let indexed = 0
  let embedsDeferred = 0
  let embedsDeferredNoWorker = 0
  // Embedding runs at roughly ten chunks a second on the bundled WebAssembly runtime, so embedding a repository of a few thousand files inline kept this command running for hours. Once the inline embeds have used their time budget, the rest are put on the worker's dirty queue, the path `install` already uses. The first embed is not counted because it includes loading, and on a first run downloading, the model. --embed waits for every file here instead.
  const embedBudgetMs = opts.embed === true ? Number.POSITIVE_INFINITY : (opts.embedBudgetMs ?? INDEX_INLINE_EMBED_BUDGET_MS)
  let embedsInline = 0
  let embedSpentMs = 0
  let embedsBackground = 0
  // Every file left for the worker to embed, deferred or past the budget, put on its dirty queue once the walk is done.
  const leftForWorker: string[] = []
  let failed = 0
  let skipped = 0
  const failureGroups = new Map<string, { example: string; count: number }>()
  // Manual `index` runs can take minutes on a real repo with nothing printed until the very end, which looks hung on a real terminal but must stay perfectly silent for pipes/CI/hook invocations that parse stdout -- reuse _useRichStats' exact TTY/NO_COLOR/FORCE_COLOR gate so the same rule that governs rich stats output governs this progress line. Progress is written to stderr only and throttled to ~10 repaints/sec so a large repo does not hammer the terminal with one line per file.
  const showProgress = _useRichStats()
  const progressStart = Date.now()
  let lastProgressPaintAt = 0
  let lastProgressLineLen = 0
  const totalFiles = files.length
  let fileIdx = 0
  function paintProgress(phase: string): void {
    if (!showProgress) return
    const now = Date.now()
    if (now - lastProgressPaintAt < 100) return
    lastProgressPaintAt = now
    const elapsedSec = ((now - progressStart) / 1000).toFixed(1)
    const text = `${fileIdx}/${totalFiles} files -- ${phase} -- ${elapsedSec}s elapsed`
    const trailingPad = text.length < lastProgressLineLen ? ' '.repeat(lastProgressLineLen - text.length) : ''
    lastProgressLineLen = text.length
    process.stderr.write(`\r${text}${trailingPad}`)
  }
  for (const f of files) {
    fileIdx += 1
    paintProgress('scanning')
    // Key on the same canonical absolute-normalized path every reader resolves to via resolveIndexPath. getTrackedFiles returns path.join(root, rel), so a relative root (the natural `token-goat index .`) yields relative paths; normalizePath alone would store a relative key that no reader can match.
    const key = resolveIndexPath(f)
    // worker.blocked_roots (set via `token-goat project exclude`) excludes a path prefix from indexing entirely -- skip before the language check so a blocked file is never touched.
    if (isUnderBlockedRoot(key, blockedRoots)) {
      // Purge rather than skip. A file indexed before its root was blocked would otherwise keep its symbols, bodies and embeddings forever: a plain skip leaves the rows it wrote behind, and no other pass removes them (pruning is existence-based, and an excluded file is still on disk). Same treatment isParseSkipEligible already gives a file excluded by skip_dirs.
      removeFileFromIndex(getDb(dbPath), key)
      continue
    }
    // PDF/DOCX/PPTX/XLSX have no Language entry (no code symbols) so they report 'unknown', but they must still reach indexFileEmbeddings below for extracted-text embedding. The language is read from the file's head, as the walk that listed it did: a path-only check skipped every `.p`, `.w`, `.m` and `.t` a content sniff admits, so it was never indexed or counted.
    if (detectLanguageOfFile(key) === 'unknown' && !isEmbeddableDocument(key)) continue
    // indexing.skip_dirs / large_file_skip_kb: filter here, before the sha/entry work below. Without this pre-filter, indexFileSync's internal purge would run and then the unconditional indexFileEmbeddings call below would immediately re-embed a file meant to be fully excluded (origin's indexFileEmbeddings has no skip_dirs/size-cap branch).
    if (isParseSkipEligible(key, ixCfg, walkRootKey)) {
      removeFileFromIndex(getDb(dbPath), key)
      continue
    }
    // Mirror worker.ts's makeIndexer sha gate here: a bulk `token-goat index` run previously called indexFileSync (and re-chunked/re-embedded via indexFileEmbeddings) unconditionally for every tracked file on every invocation, even ones byte-identical to what was already indexed. fingerprintFile returning null (a transient read failure/race) is treated as "not unchanged" so the file still gets a normal reindex attempt below. Parse and embed freshness are gated independently (embed_sha vs sha), matching makeIndexer, so a file whose embedding previously failed still gets re-embedded even when its parse is current. --force bypasses both freshness checks unconditionally -- e.g. after a parser.ts extraction-logic change, every already-indexed file's SHA is untouched and stale symbols/refs would otherwise never get recomputed until each file happens to be edited.
    const sha = fingerprintFile(key)
    // A git-tracked file deleted from the worktree is still listed by getTrackedFiles, so it reaches this loop on every run. fingerprintFile returns null for it, indexFileSync fail-softs on ENOENT without throwing, and the `indexed += 1` at the bottom of the loop then counted work that never happened -- every run, forever, since deleting the file is exactly what keeps it in this state. After a rename the effect was the headline symptom: `Indexed 1 file into the symbol index` printed while the index had just been emptied. A null sha for a file that DOES exist is a transient read failure (a lock held by an AV scanner or an open editor) and still deserves the normal reindex attempt below, so the existence check is what separates the two. The rows are removed by pruneDeletedFiles after the loop, which is the pass that owns vanished files.
    if (sha === null && !fs.existsSync(key)) continue
    // Register the project root as sweepable before the freshness gates below can skip this file: a walk that finds everything already current still proves the project has rows worth sweeping. See recordKnownRootThrottled.
    recordKnownRootThrottled(key, dataDir(), dbPath)
    const { configRoot, embeddingsEnabled } = embedPolicy(key)
    // See isEmbedFresh: depsAvailable keeps an `unavailable:`-marked embed_sha (a file skipped only because the optional model/sqlite-vec deps were absent) treated as stale so it is re-embedded once the deps are installed, instead of looking permanently fresh.
    const depsAvailable = embeddingsEnabled && embeddingsDepsAvailable(getDb(dbPath))
    if (depsAvailable) {
      // files.embed_sha records WHICH CONTENT was embedded, never WHICH STACK embedded it, so the per-file freshness gate below cannot see a model or inference-runtime change on its own: it reads a bare sha as fresh and skips the file. ensureEmbeddingProvenance owns that input and is the only thing that can re-open the decision, but its only callers were upsertChunks and searchSemantic, both downstream of that gate -- so a whole-index run after an onnxruntime major.minor upgrade printed "Skipped N unchanged file(s)" and left every vector from the previous stack in place, which is exactly what the warning that reset prints tells the user to run this command to fix. It must run before the row read below, not beside the gate that consults the row: the reset clears each affected file's embed_sha, and once `entry` holds a row that clearing can no longer be seen. Memoized per database per process, so after the first file this costs one Set lookup. Gated on the deps being usable because backendId() cannot name a runtime that did not load, and wiping the index on the strength of an unknowable identity would be worse than the staleness it is guarding against.
      ensureEmbeddingProvenance(getDb(dbPath))
      // Chunk rows written before the asset and chunk-count gates existed carry a valid embed_sha, so the per-file freshness gate below reads every one of them as current and would leave them searchable forever. Same placement and the same reason as ensureEmbeddingProvenance directly above: it has to run before a row is read. See src/embed_backfill.ts for why this is a version-keyed sweep rather than a fingerprint bump.
      pruneUnembeddableChunks(getDb(dbPath), ixCfg.max_chunks_per_file, deleteFileEmbeddings, { asset: assetEmbedSha, maxChunks: maxChunksEmbedSha })
    }
    const entry = sha !== null ? getFileEntry(key, dbPath) : null
    // A case-only rename (`mv b.ts B.ts`) leaves the content byte-identical, so the sha gate below would skip the file and the row would keep the old spelling indefinitely -- see indexedPathSpellingIsStale. Reindexing rewrites the row under the spelling the file actually has.
    const spellingStale = entry !== null && indexedPathSpellingIsStale(entry.filePath, key)
    // entry.parserSha gates on WHICH parser wrote the rows, not just whether the content moved -- see parserFingerprintForLanguage and the same gate in worker.ts's makeIndexer. The expected stamp is the one for the language the row itself records, so a fix to one adapter reparses that language's files and leaves every other language's rows alone. This is what makes the --force escape hatch described above unnecessary after a parser change: the mismatch reparses the file on its own.
    const parseUnchanged =
      !force &&
      !spellingStale &&
      sha !== null &&
      entry?.sha === sha &&
      entry.parserSha === parserFingerprintForLanguage(entry.language)
    // isEmbedFresh (parser.ts) is the shared read side of this gate, also used by worker.ts's makeIndexer: while embeddings are config-disabled, only the `disabled:` marker for this sha counts as fresh; while enabled, a bare sha match is fresh (the file was really embedded, or was empty / permanently policy-skipped -- e.g. profile-meta.xml, an oversized salesforce_metadata file -- with nothing to embed, both terminal regardless of deps); and an `unavailable:` marker is fresh only while the optional embedding deps stay uninstalled. Embed freshness is decided on its own inputs, never on parseUnchanged: files.parser_sha answers "which extractor wrote the symbol rows", which carries no information about whether the stored vectors match this content, so conjoining it made a parser-stamp bump re-embed the whole index (measured: a stamp-only reparse of 300 unchanged files cost 94% of indexing them from nothing) and made writeParseResult's embedShaToCarry dead for the waste it exists to prevent. isEmbedFresh already answers false for a new file (no stored embed_sha) and for moved content (the stored sha no longer matches), so the sha coupling was redundant -- except for spellingStale, which is kept by name: a case-only rename leaves the content byte-identical, so isEmbedFresh would say fresh, but `chunks` rows are keyed by file_path and would keep the old spelling forever.
    const embedFreshFor = (embedSha: string | undefined): boolean =>
      !force &&
      !spellingStale &&
      sha !== null &&
      isEmbedFresh(
        embedSha,
        sha,
        embeddingsEnabled,
        depsAvailable,
        // See isEmbedFresh: an `oversize:` marker stays fresh only while indexing.large_file_symbol_only_kb is still what it was stamped under, so raising the threshold re-embeds the files it just admitted instead of leaving them permanently skipped. 0 matches no marker (config floors this key at 1), the safe direction for a partially-mocked config.
        loadConfig().indexing?.large_file_symbol_only_kb ?? 0,
        // Same reasoning and same 0 fallback for the chunk-count marker.
        loadConfig().indexing?.max_chunks_per_file ?? 0,
      )
    const embedUnchanged = embedFreshFor(entry?.embedSha)
    if (parseUnchanged && embedUnchanged) {
      skipped += 1
      continue
    }

    if (!parseUnchanged) {
      paintProgress('parsing')
      try {
        withDeclaredSkipScopeRoot(walkRootKey, () => indexFileSync(key, dbPath))
      } catch (e) {
        // A single locked/permission-denied file (AV scan, open editor, OneDrive sync -- all common on Windows) must not abort the rest of a bulk walk. indexFileSync itself only fail-softs on ENOENT (the file vanished between discovery and read, a benign race) and rethrows everything else so callers can report it -- worker.ts's makeIndexer already catches and logs that per-file via an INDEX_FAILED sentinel, but this foreground loop had no try/catch at all, so the same rethrow aborted the whole command uncaught.
        failed += 1
        const message = extractErrorMessage(e)
        const group = failureGroups.get(message)
        if (group !== undefined) {
          group.count += 1
        } else {
          failureGroups.set(message, { example: key, count: 1 })
        }
        continue
      }
      // indexFileSync fail-softs on ENOENT, so a file deleted during its own parse leaves nothing written and throws nothing either. Counting it would reintroduce the phantom credit the pre-parse guard above exists to stop, just through a narrower window.
      if (!fs.existsSync(key)) continue
    }
    // Re-read the stamp the parse above just wrote rather than trusting the one captured before it: writeParseResult clears the carried embed_sha when a reparse moved this file's embedding boundaries (see embeddingBoundariesMoved), and `embedUnchanged` was computed from the pre-parse row. Without this the re-embed is deferred to whatever run happens next, so a single `token-goat index` after an adapter change leaves the file's vectors cut on boundaries that no longer exist.
    const embedFresh = parseUnchanged ? embedUnchanged : embedFreshFor(getFileEntry(key, dbPath)?.embedSha)
    // The worker's dirty queue and its backlog sweep both pass over a path under the OS temp dir (see isUnderSystemTemp), so a file there that this run leaves unembedded stays out of `semantic` for good. Such a file is embedded here whatever the budget, and when only the worker could download the model it is reported without promising that the worker will embed it.
    const workerWillEmbed = !embedFresh && depsAvailable && !isUnderSystemTemp(key)
    // A model that is not on this machine and cannot be fetched now (offline, the last download failed recently, or this process would go around the machine's proxy to get it) makes every embed below fail the same way, one file at a time. Skipping leaves embed_sha unset, so the worker, or the next run, embeds the file once the download succeeds. Only a file that would really download is deferred: with embeddings off, or the embedding packages absent, the call below writes the terminal marker that keeps the file from being retried, and that needs no download.
    if (!embedFresh && depsAvailable && foregroundDownloadDeferred()) {
      if (workerWillEmbed) {
        embedsDeferred += 1
        leftForWorker.push(key)
      } else {
        embedsDeferredNoWorker += 1
      }
    } else if (workerWillEmbed && embedsInline > 0 && embedSpentMs >= embedBudgetMs) {
      // Left with embed_sha unset and handed to the worker below. Only a file that would really embed is handed over: with embeddings off or their packages absent, the call below writes a terminal marker in no time and must still run.
      embedsBackground += 1
      leftForWorker.push(key)
    } else if (!embedFresh) {
      paintProgress('embedding')
      const embedStart = Date.now()
      // Best-effort semantic-embeddings step for the same file, run right after its syntactic parse; awaited here because this is a one-shot foreground command the caller waits on, unlike the worker's incremental drain which fires this and forgets it. Passing sha lets it stamp files.embed_sha on success, the same embed-freshness gate makeIndexer uses. It reads `embeddings_enabled` with no root to pass, as its first synchronous statement, so the file's own project is the one loadConfig() resolves for that stretch, as in worker.ts's embedFileSerialized.
      await withConfigProjectRoot(configRoot, () => indexFileEmbeddings(key, dbPath, sha ?? undefined))
      if (depsAvailable) {
        if (embedsInline > 0) embedSpentMs += Date.now() - embedStart
        embedsInline += 1
      }
    }
    indexed += 1
  }
  // Clear the progress line before any further stderr writes (failure summaries below) or the final stdout summary, so nothing is left overwritten or trailing on the terminal.
  if (showProgress && lastProgressLineLen > 0) {
    process.stderr.write(`\r${' '.repeat(lastProgressLineLen)}\r`)
  }
  for (const [message, group] of failureGroups) {
    err(
      `token-goat: index: failed to index '${group.example}': ${message}` +
        (group.count > 1 ? ` (and ${group.count - 1} other file(s))` : ''),
    )
  }
  const pruned = pruneDeletedFiles(resolveIndexPath(root), dbPath)
  // What session start and install read as "this project is indexed": the symbols this walk wrote cannot say it, because the edit hook writes symbols for single files too.
  recordIndexedRoot(root, dbPath)
  out(
    `Indexed ${countNoun(indexed, 'file')} into the symbol index.` +
      `${skipped > 0 ? ` Skipped ${skipped} unchanged file(s).` : ''}` +
      `${pruned > 0 ? ` Pruned ${pruned} deleted file(s).` : ''}` +
      `${failed > 0 ? ` Failed to index ${failed} file(s) (see stderr).` : ''}`,
  )
  // The files left without an embed go on the worker's dirty queue, which wakes a worker that is running and starts one that is not; the worker is also the process whose downloads go through the proxy. Leaving them to its backlog sweep was not enough: the sweep walks the index once per worker start, so a worker an earlier hook started had finished that walk before this run began, and the files stayed out of `semantic` until it next restarted.
  if (leftForWorker.length > 0) enqueueDirtyPathsSafe(leftForWorker, { alreadyResolved: true })
  if (embedsDeferred > 0) {
    ensureWorkerAlive()
    const offlineNotice = offlineEmbedNotice(countNoun(embedsDeferred, 'file'), root)
    if (offlineNotice !== null) err(offlineNotice)
    else err(`token-goat: index: ${countNoun(embedsDeferred, 'file')} not embedded yet: the embedding model is not downloaded. The background worker downloads it and embeds them; to do it now, run \`${WARM_COMMAND}\` and then \`token-goat index\` again.`)
  }
  if (embedsDeferredNoWorker > 0) {
    const files = countNoun(embedsDeferredNoWorker, 'file')
    err(offlineEmbedNotice(files, root) ?? `token-goat: index: ${files} not embedded: the embedding model is not downloaded, and the background worker does not embed files under the system temp directory. To embed them, run \`${WARM_COMMAND}\` and then \`token-goat index\` again.`)
  }
  if (embedsBackground > 0) {
    ensureWorkerAlive()
    err(`token-goat: index: ${countNoun(embedsBackground, 'file')} left for the background worker to embed; \`semantic\` uses keyword search for them until it finishes. To embed them here instead, run \`token-goat index --embed\`.`)
  }
  // A run where every file failed and none indexed is a total indexing failure, not a no-op success -- callers scripting on `$?` must be able to detect it.
  if (indexed === 0 && failed > 0) {
    process.exitCode = 1
  }
}

function cmdMap(opts: { compact?: boolean; json?: boolean }): void {
  const map = buildProjectMap(process.cwd(), { compact: opts.compact === true })
  const text = formatProjectMap(map, map.compact)
  if (opts.json === true) {
    out(displaySafeJson(map, 0))
  } else {
    out(text)
  }
  // `map_lookup` has carried a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry since the Python->TS port, but nothing ever called recordStat for it -- the `map`/`baseline` dashboard bucket was permanently zero regardless of real usage (same class of gap fixed for changed_lookup, see project_runchanged_missing_stat memory). The byte accounting (including the recentFiles-vs-topSymbols path canonicalization needed for the dedup) lives in mapLookupBytesSaved so cmdMap and the MCP `map` tool share one implementation.
  const bytesSaved = mapLookupBytesSaved(map, text)
  recordStat('map_lookup', bytesSaved, savedTokensFromBytes(bytesSaved))
}

function cmdBridgesStatus(opts: { json?: boolean }): void {
  if (opts.json === true) {
    out(displaySafeJson(bridgesStatusToJson(BRIDGE_CAPABILITY_MATRIX), 0))
  } else {
    out(formatBridgesStatus(BRIDGE_CAPABILITY_MATRIX))
  }
}

function cmdCommands(opts: { json?: boolean; grep?: string }): void {
  let manifest = buildCommandManifest(buildProgram())
  if (opts.grep !== undefined) {
    manifest = filterCommandManifest(manifest, opts.grep)
  }
  if (opts.json === true) {
    out(displaySafeJson(manifest, 0))
  } else if (manifest.length === 0) {
    // Same wording as cmdPptxText's --grep-with-no-hits path: a filter matching nothing is a legitimate empty result, not an error, so this stays a plain message on exit 0.
    out('no matches')
  } else {
    out(formatCommandManifest(manifest))
  }
}

// Runs an MCP stdio server exposing read/symbol/section/outline/skeleton/semantic as tools. The returned promise only resolves once the server reports its connection closed (via `onclose`, set after `connect()` so it's not clobbered by the wiring `connect()` itself does to the transport's own `onclose`) -- resolving early here would let `run()`'s caller (main.ts) return while the process still has useful work queued on stdin.
async function cmdMcpServe(): Promise<void> {
  let createMcpServer: typeof CreateMcpServerFn
  let StdioServerTransport: typeof StdioServerTransportClass
  // Both modules are token-goat's own and are inlined into the bundle, so unlike the days when this loaded an optional third-party SDK there is no "not installed" case left. The guard stays because a dynamic import can still fail on a truncated or partially written install, and a bare rejection here would surface as an unhandled crash rather than a command that reports what went wrong.
  try {
    ;({ createMcpServer } = await import('./mcp_server.js'))
    ;({ StdioServerTransport } = await import('./mcp_stdio.js'))
  } catch (err) {
    process.stderr.write(formatCommandError(`mcp-server unavailable (could not load the MCP server modules): ${String(err)}`) + '\n')
    process.exitCode = 1
    return
  }
  const server = await createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    server.onclose = resolve
  })
}

async function cmdHook(event: string, opts: { harness?: string }): Promise<void> {
  // A bridge that writes a bare command string into its host tool's config (no in-process env-setting hook like pi.ts/copilot_cli.ts have) can self-identify via this flag instead — same purpose as TOKEN_GOAT_HARNESS_OVERRIDE, just passed as an argv flag since there's no JS relay script in the middle to set process.env directly. detectHarness() itself already validates the value against KNOWN_HARNESS_NAMES and ignores anything unrecognized, so no extra validation is needed here.
  if (typeof opts.harness === 'string' && opts.harness.length > 0) {
    process.env[ENV_KEYS.HARNESS_OVERRIDE] = opts.harness
  }
  // Imported here rather than at module scope: relay.ts side-effect-imports every hook handler to register them, so a top-level import made every CLI command -- `symbol`, `read`, even `--version` -- parse the whole hook subsystem, the bash tool-filter registry and the HTML extractor before doing anything. Only this one command needs any of it. Hooks themselves are unaffected: they run through dist/token-goat-hook.mjs, which imports relay directly.
  const { relay } = await import('./relay.js')
  // relay handles its own stdin read / stdout write and never throws on a malformed/unknown event — it emits `{}` and returns.
  await relay(event)
}

function cmdWorkerStart(): void {
  if (isWorkerRunning()) {
    out('Worker already running.')
    return
  }
  // startDetachedWorker's own atomic pid-file claim (see worker_lifecycle.ts::claimWorkerPidFile) is the real guard against the TOCTOU race above: two near-simultaneous `worker start` invocations can both pass the isWorkerRunning() check above, but only one of them can win the exclusive pid-file create that follows, so the loser reports this cleanly instead of orphaning a second, unstoppable daemon.
  try {
    const pid = startDetachedWorker()
    out(`Worker started (pid ${pid}).`)
  } catch (e) {
    if (e instanceof WorkerAlreadyRunningError) {
      out('Worker already running.')
      return
    }
    throw e
  }
}

function cmdWorkerStop(): void {
  const stopped = stopWorker()
  out(stopped ? 'Worker stopped.' : 'No running worker.')
}

function cmdWorkerStatus(): void {
  out(isWorkerRunning() ? 'Worker is running.' : 'Worker is not running.')
}

function cmdStats(opts: { json?: boolean; windowDays?: string; homeDir?: string; full?: boolean; short?: boolean; methodology?: boolean; hooks?: boolean; payloads?: boolean } = {}): void {
  if (opts.payloads === true) {
    runPayloads(opts.json === true)
    return
  }
  const windowDays = opts.windowDays !== undefined ? requireNonNegativeInt('--window-days', opts.windowDays) : 30
  const statsOpts: Parameters<typeof runStats>[0] = {
    json: opts.json === true,
    windowDays,
    full: opts.full === true,
    short: opts.short === true,
    methodology: opts.methodology === true,
    hooks: opts.hooks === true,
  }
  if (opts.homeDir !== undefined) {
    statsOpts.homeDir = opts.homeDir
  }
  runStats(statsOpts)
}

async function cmdDoctor(opts: { context?: boolean; json?: boolean; repair?: boolean; fix?: boolean; probe?: string }): Promise<void> {
  if (opts.probe !== undefined) {
    // Loaded on demand: a probe spawns a whole harness, and nothing else in doctor needs this module.
    const { PROBE_COMMANDS, formatProbeReport, isProbeHarness, probePassed, runProbe } = await import('./doctor_probe.js')
    const harness = opts.probe.trim().toLowerCase()
    if (!isProbeHarness(harness)) {
      throw new CliError(`no headless probe for '${opts.probe}'; supported: ${Object.keys(PROBE_COMMANDS).join(', ')}`)
    }
    const report = runProbe(harness)
    out(opts.json === true ? displaySafeJson(report, 0) : formatProbeReport(report))
    if (!probePassed(report)) throw new CliError('doctor probe failed')
    return
  }
  const doctorOpts: { dataDir?: string; configPath?: string; context?: boolean; rootDir?: string; repair?: boolean } = {}
  if (opts.context === true) {
    doctorOpts.context = true
  }
  if (opts.repair === true || opts.fix === true) {
    // A repair downloads what is missing, now, so it runs again through the machine's proxy as `semantic --warm` does.
    const code = rerunWithEnvProxy(spawnSync)
    if (code !== null) {
      process.exitCode = code
      return
    }
    doctorOpts.repair = true
  }
  // Scope the Symbols check to the invoking project so an unrelated project sharing the same global.db can't mask this project's own parser being broken (see checkSymbolCount's doc comment). No project root found (bare directory, no git/package.json) falls back to the prior unscoped whole-database behavior.
  const project = findProject(process.cwd())
  if (project !== null) {
    doctorOpts.rootDir = project.root
  }
  if (opts.json === true) {
    // --json bypasses printDoctorResults' prose entirely (no `[WARN]`-prefixed lines) and emits the same DoctorResult[] runDoctorChecks() computes, one entry per check with its ok/warn/fail status -- matching cmdCommands'/cmdBridgesStatus' plain JSON.stringify convention (no envelope) rather than inventing a new shape.
    const results = await runDoctorChecks(doctorOpts.dataDir, doctorOpts.configPath, doctorOpts.rootDir)
    out(displaySafeJson(results, 0))
    if (results.some((r) => r.status === 'fail')) {
      throw new CliError('doctor checks failed')
    }
    return
  }
  const code = await runDoctorAndExit(doctorOpts)
  if (code !== 0) {
    throw new CliError('doctor checks failed')
  }
}

export { fileSizeOrZero } from './cli_office.js'
export { fenceFileText, fenceFileFieldIfMatched } from './untrusted_fence.js'
export { cmdPdfExtract, cmdPdfLocate, cmdPdfOutline, cmdPdfMeta } from './cli_office.js'
export {
  cmdDocxOutline,
  cmdDocxTables,
  cmdDocxText,
  cmdPptxNotes,
  cmdPptxOutline,
  cmdPptxSlide,
  cmdPptxText,
  cmdSharepointResolve,
  cmdTranscript,
  cmdTranscriptOutline,
  cmdVideoChapters,
  cmdXlsxColumns,
  cmdXlsxHead,
  cmdXlsxQuery,
  cmdXlsxRange,
  cmdXlsxSheets,
} from './cli_office.js'
export {
  cmdCsvProfile,
  cmdCsvQuery,
  cmdHtmlLint,
  cmdHtmlOutline,
  cmdHtmlQuery,
  cmdJsonOutline,
  cmdJsonQuery,
  cmdOpenApiOp,
  cmdOpenApiOutline,
  cmdXmlOutline,
  cmdXmlQuery,
  cmdYamlOutline,
  cmdYamlQuery,
  cmdZipList,
  cmdZipRead,
} from './cli_structured.js'
export {
  cmdSqliteTables,
  cmdSqliteSchema,
  cmdSqliteQuery,
  cmdImageMeta,
  cmdImageText,
  fenceOcrText,
} from './cli_cmd_formats.js'
export {
  cmdSessionSchema,
  cmdDescribe,
} from './session_store_schema.js'

function cmdPrSlice(pr: string, slice: string, opts: { repo?: string; json?: boolean }) {
  process.exitCode = runPrSlice({ pr, slice, ...opts })
}

// Sets process.exitCode to the wrapped command's exit code (NOT via `guard`, which forces 0 on success — compress must propagate the real code so shell chaining still sees the original failure/success signal).
async function cmdCompress(
  commandArgs: string[] | undefined,
  opts: {
    cmd?: string
    cmdB64?: string
    filter?: string
    timeout?: string
    compress?: boolean
    profile?: string
    maxTokens?: string
    capHintB64?: string
    quietSuccess?: boolean
    native?: boolean
    shell?: string
    stdin?: boolean
  } = {},
): Promise<void> {
  const usedBase64 = opts.cmdB64 !== undefined
  try {
    let command: string | undefined
    for (let depth = 0; depth < 5; depth++) {
      if (opts.cmdB64 !== undefined) {
        command = Buffer.from(opts.cmdB64, 'base64').toString('utf8')
        delete opts.cmdB64
      } else {
        command = opts.cmd
        if (Array.isArray(commandArgs) && commandArgs.length > 0) {
          command = command ? [command, ...commandArgs].join(' ') : commandArgs.join(' ')
        }
      }
      if (!usedBase64 || !command || !/^\s*(?:token-goat|tg)\s+(?:compress|bash|run)(?:\s|$)/.test(command)) break

      // Reuse the CLI grammar so aliases, positional commands and runner options survive unwrapping without starting another token-goat process.
      const { shlexSplit } = await import('./tool_filters/helpers.js')
      const nested = buildProgram()
      applyExitOverride(nested)
      let parsedArgs: string[] = []
      let parsedOpts: Record<string, unknown> = {}
      nested.commands.find((sub) => sub.name() === 'compress')!.action((args: string[], innerOpts: Record<string, unknown>) => {
        parsedArgs = args
        parsedOpts = innerOpts
      })
      delete opts.cmd
      await nested.parseAsync(shlexSplit(command).slice(1), { from: 'user' })
      commandArgs = parsedArgs
      opts = { ...opts, ...parsedOpts } as typeof opts
    }
    if (!command || command.trim() === '') {
      err(formatCommandError('either command arguments, -c/--cmd, or --cmd-b64 is required'))
      process.exitCode = 1
      return
    }
    const bashRunner = await import('./bash_runner.js')
    if (opts.compress === false) {
      // Commander maps `--no-compress` to `opts.compress === false`.
      process.exitCode = bashRunner.runRaw(
        command,
        parseTimeout(opts.timeout, bashRunner.DEFAULT_TIMEOUT_SECONDS),
        opts.native,
        opts.shell,
      )
      return
    }
    const maxTokens = opts.maxTokens !== undefined ? requireNonNegativeInt('--max-tokens', opts.maxTokens) : 0
    process.exitCode = await bashRunner.run(command, {
      filterName: opts.filter,
      timeout: parseTimeout(opts.timeout, bashRunner.DEFAULT_TIMEOUT_SECONDS),
      maxTokens,
      ...(opts.capHintB64 !== undefined ? { capHint: Buffer.from(opts.capHintB64, 'base64').toString('utf8') } : {}),
      ...(opts.profile !== undefined ? { compressionProfile: opts.profile } : {}),
      ...(opts.quietSuccess === true ? { quietSuccess: true } : {}),
      ...(opts.native === true ? { nativeShell: true } : {}),
      ...(opts.shell !== undefined ? { shellType: opts.shell } : {}),
      ...(opts.stdin === true ? { rawStdin: true } : {}),
    })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
      process.exitCode = 0
      return
    }
    err(formatCommandError(e))
    process.exitCode = 1
  } finally {
    if (usedBase64 && process.exitCode !== undefined && process.exitCode !== 0) {
      err('[tg: note] Command failed when invoked via --cmd-b64. If an LLM generated this base64 string, tokenization bit-drift may have corrupted characters or file paths. Always pass plain shell commands directly.')
    }
  }
}

// setTimeout's delay is a signed 32-bit millisecond count and larger values fire immediately, so the largest safe whole-second value is floor(2147483647 / 1000).
const MAX_TIMEOUT_SECONDS = 2147483

/** Resolve the --timeout flag (seconds), rounded up to whole seconds and clamped to the setTimeout limit: 0/absent/invalid → the built-in default. parseFloat, not parseInt, because hooks_bash.ts renders a large configured number as '1e+21', which parseInt reads as 1. */
export function parseTimeout(raw: string | undefined, fallbackSeconds: number): number {
  const sec = raw ? parseFloat(raw) : 0
  return sec > 0 ? Math.min(Math.ceil(sec), MAX_TIMEOUT_SECONDS) : fallbackSeconds
}

export * from './cli_skills.js'
export * from './cli_file_ops.js'

async function cmdGdriveSections(fileId: string, opts: { heading?: string; fresh?: boolean }): Promise<void> {
  // An organisation that does not use Google Drive can switch the integration off entirely, which refuses here before any file id is validated or any connection is opened, and also stops the installed agent guidance from naming the command at all.
  if (!loadConfig().gdrive.enabled) {
    throw new CliError('gdrive-sections is disabled by gdrive.enabled = false in this install')
  }
  const fetchOpts = { fresh: opts.fresh === true }
  // Fetch the whole doc once up front (honoring --fresh) so its raw byte size is available as the "full source" side of the bytes-saved calculation below, mirroring cmdSessionOutline/ cmdSessionSlice's convention. fetchDoc() always writes its result to the on-disk web-output cache before returning, so the getSectionContent/getDocSections calls below can safely pass `fresh: false` -- they read through to the entry this call just (re)populated, guaranteeing exactly one network fetch even with --fresh, instead of two.
  const text = await fetchDoc(fileId, fetchOpts)
  const fullSourceBytes = Buffer.byteLength(text, 'utf8')
  let emitted: string
  if (opts.heading !== undefined) {
    const content = await getSectionContent(fileId, opts.heading, { fresh: false })
    if (content === null) {
      throw new CliError(`section '${opts.heading}' not found in document ${fileId}`)
    }
    emitted = `# ${opts.heading}\n${content}`
  } else {
    const sections = await getDocSections(fileId, { fresh: false })
    emitted = formatSections(sections)
  }
  // A Google Doc is authorable by anyone who can edit the shared file, exactly like a fetched web page -- scan and fence it the same way `_applyFiltersAndPrint` does for WebFetch/web-output, under the same UNTRUSTED_WEB_TAG (this doc *is* fetched over HTTP, via performHttpFetch in gdrive.ts). Inlined rather than routed through `_applyFiltersAndPrint` because that helper's default head/tail elision would silently truncate output this command has always emitted in full; `emitted` is used unmodified below except when a match is found.
  const toEmit = fenceUntrusted(emitted, UNTRUSTED_WEB_TAG)
  out(toEmit)
  // stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `gdrive-sections`/`gdrive_sections` entry and nothing ever called recordStat for this command -- the dashboard bucket was permanently zero regardless of real usage, the same class of gap already fixed for map_lookup/changed_lookup/csv_query/brief_view/session_outline/session_slice (see project_runchanged_missing_stat memory).
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(toEmit, 'utf8'))
  recordStat('gdrive_sections', bytesSaved, savedTokensFromBytes(bytesSaved))
}

// --- Program assembly -------------------------------------------------------

/** Commands that only query the index, so they may answer through a read-only connection when the index cannot be written (a read-only sandbox, a write-denied data directory): see db.ts's allowReadOnlyIndex. A command that writes the index as part of its job (index, worker, doctor, note, hook, mcp-serve, ...) must never be listed, because a writer given the read-only handle fails at its first write instead of at the open. */
const READ_ONLY_INDEX_COMMANDS: ReadonlySet<string> = new Set([
  'symbol', 'read', 'brief', 'section', 'semantic', 'search', 'skeleton', 'outline', 'refs', 'answer', 'ask', 'map',
  'exports', 'imports', 'find', 'locate', 'callers', 'call-chain', 'impact', 'dead', 'deps', 'types', 'scope',
  'similar', 'context-for', 'test-for',
])

/** Commander's own `helpInformation` for the top-level program, captured before `buildProgram` shadows it with the compact grouped index. `help --full` calls this to emit the long per-command listing the compact index replaces; without it the long form is unreachable, since the override is an own property that hides the prototype method for every later caller. */
let originalHelpInformation: (() => string) | null = null

/** Build the Commander program. Exported so tests can introspect/parse it. */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('token-goat')
    .description('Surgical token-reduction companion for AI coding agents')
    .version(VERSION, '-v, --version', 'print the token-goat version')
    // Lets a caller (e.g. the VS Code extension) convey a project root explicitly instead of setting the spawned process's own working directory to it -- an attacker-controlled workspace should never be the cwd a shell/launcher resolves a binary name against, but commands that key off process.cwd() for project resolution still need a way to be told where that root is.
    .option('--cwd <path>', 'run as if invoked from this directory (overrides the real working directory)')
    // Lets a caller print a disclosure line ahead of the command's own output without composing two commands through a shell operator -- a rewritten command (see detectStructuralIndexRewrite in bash_structural_index.ts) needs to say what it substituted, and every shell parses one command with a global flag identically, where `echo ... &&` does not (no `&&` in PowerShell 5.1 at all).
    .option('--notice <text>', 'print this line to stdout before the command\'s own output')

  // Applied via a preAction hook (not inside `guard` below) so --cwd works for every command, not only the ones wrapped in `guard` -- the surgical-read commands (symbol, read, scope, ...) call runExit/runExitText directly and never go through guard, so a chdir living only inside guard silently no-ops for them. This hook fires before any command's action handler, guard-wrapped or not, and before anything resolves the project root or loads config.
  program.hook('preAction', (thisCommand, actionCommand) => {
    if (actionCommand.parent === program && READ_ONLY_INDEX_COMMANDS.has(actionCommand.name())) {
      allowReadOnlyIndex(() => err('token-goat: the index database cannot be written here, so this run reads it without writing: no stats are recorded and changed files are not reindexed.'))
    }
    const opts = thisCommand.opts<{ cwd?: string; notice?: string }>()
    const cwdOverride = opts.cwd
    if (cwdOverride !== undefined) {
      try {
        process.chdir(cwdOverride)
      } catch (e) {
        throw new Error(`--cwd ${cwdOverride}: ${extractErrorMessage(e)}`, { cause: e })
      }
    }
    if (opts.notice !== undefined) out(opts.notice)
  })

  // Each action wraps the (possibly sync) handler so any thrown CliError or unexpected error maps to a stderr line + exit code 1, and success to 0. A handler that already set process.exitCode itself (a deliberate non-zero exit without throwing) is left alone -- only the still-undefined default gets the success fallback.
  const guard =
    (fn: (...a: never[]) => void | Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      process.exitCode = undefined
      // loadConfig() silently falls back to defaults on a config.toml parse failure, same as when the file is simply missing -- surface the distinction here, once per invocation, so a corrupt config doesn't look identical to "no config yet" for every command.
      loadConfig()
      const parseErr = getLastConfigParseError()
      if (parseErr !== null) {
        // The parser quotes the offending line of the file back, so this banner carries file bytes in a line prefixed with token-goat's own name.
        err(`token-goat: config.toml failed to parse (${displaySafeText(parseErr)}); using defaults — run \`token-goat config validate\` for details`)
      }
      // Same distinction as above, for the optional per-project .token-goat.toml override -- it fails open (global-only config still loads), but a corrupt project file should not look identical to "no project override" for every command.
      const projectParseErr = getLastProjectConfigParseError()
      if (projectParseErr !== null) {
        // Same, and worse: a project override arrives with the repository, so these bytes are third-party on every clone. This banner prints before every command.
        err(`token-goat: .token-goat.toml failed to parse (${displaySafeText(projectParseErr)}); ignoring project override`)
      }
      // A per-project file arrives with the repository, so it may not set the security controls an administrator configures once. Say which settings were ignored: silently dropping them would leave a legitimate author wondering why the file had no effect.
      const lockedKeys = lastProjectConfigLockedKeys()
      if (lockedKeys.length > 0) {
        err(
          `token-goat: .token-goat.toml may not set ${displaySafeText(lockedKeys.join(', '))}; ` +
            'these are security settings and come from the global config or the environment only',
        )
      }
      try {
        await fn(...(args as never[]))
        if (process.exitCode === undefined) {
          process.exitCode = 0
        }
      } catch (e) {
        err(formatCommandError(e))
        process.exitCode = 1
      }
    }

  program
    .command('symbol [name] [more...]')
    .description('search for a symbol by name, or project-wide by --grep name pattern')
    .option('-l, --limit <n>', 'max results')
    .option('-f, --file <path>', 'restrict to one file')
    .option('-k, --kind <kind>', 'restrict to one kind (function, class, ...)')
    .option('-p, --project [path]', 'scope search to one project root instead of the global index (defaults to cwd)')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'only show symbols whose name matches this regex (literal substring if it is not valid regex); cannot be combined with <name>')
    .option('--exclude-tests', 'hide symbols defined in a test file (opt-in; default output is unchanged)')
    .option('--exclude-vendored', 'hide symbols defined under a dependency or build directory the indexer skips (node_modules, dist, site-packages, ...) (opt-in; default output is unchanged)')
    .option('--stats', 'add per-result reference count and doc-coverage flag (project-wide count per NAME, not per definition site -- same-named symbols across files share a count)')
    .action((name: string | undefined, more: string[], opts: { limit?: string; file?: string; kind?: string; project?: string | boolean; json?: boolean; grep?: string; excludeTests?: boolean; excludeVendored?: boolean; stats?: boolean }) => {
      let projectRoot: string | undefined
      if (opts.project === true) {
        projectRoot = resolveProjectRoot({ project: process.cwd() })
      } else if (typeof opts.project === 'string') {
        projectRoot = resolveProjectRoot({ project: opts.project })
      }
      return runExitText(() =>
        noteExtraFileArgs(
          'symbol',
          name ?? '',
          more,
          () =>
            runSymbol({
              ...(name !== undefined ? { name } : {}),
              limit: opts.limit !== undefined ? requireNonNegativeInt('--limit', opts.limit) : 20,
              ...(opts.file !== undefined ? { file: opts.file } : {}),
              ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
              ...(projectRoot !== undefined ? { projectRoot } : {}),
              ...(opts.json === true ? { json: true } : {}),
              ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
              ...(opts.excludeTests === true ? { excludeTests: true } : {}),
              ...(opts.excludeVendored === true ? { excludeVendored: true } : {}),
              ...(opts.stats === true ? { stats: true } : {}),
            }),
          // `symbol` searches one name; there is no comma form that would search several.
          { noun: 'spec', mergeable: false },
        ),
      )
    })

  program
    .command('read <spec> [more...]')
    .description(
      "read one symbol's full body (spec: file::symbol; disambiguate a name shared by several classes with file::Parent.symbol; a trailing @LINE anchor -- file::symbol@LINE, or combined as file::Parent.symbol@LINE -- picks out a specific candidate by its exact starting line, for the case a Parent qualifier can't reach (e.g. a top-level definition); comma-separated file::a,b for a merged multi-symbol view, or a::x,b::y to merge symbols across several files; file:LINE or file:START-END resolves a line number to the region enclosing it -- the symbol, the file preamble, or the gap between two symbols -- while file@START-END serves those raw lines)",
    )
    .option('-j, --json', 'output as JSON')
    .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
    .option('--stats', 'add per-symbol reference count and doc-coverage flag')
    .action((spec: string, more: string[], opts: { json?: boolean; forceRefresh?: boolean; stats?: boolean }) =>
      runExitText(() =>
        noteExtraFileArgs(
          'read',
          spec,
          more,
          () =>
            runRead({
              spec,
              ...(opts.json === true ? { json: true } : {}),
              ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
              ...(opts.stats === true ? { stats: true } : {}),
            }),
          // Whether the comma form the note names would actually run depends on the specs themselves, not on the command: `read` merges `::` specs and nothing else.
          { noun: 'spec', mergeable: readSpecsMergeable([spec, ...more]) },
        ),
      ),
    )

  program
    .command('brief <spec> [more...]')
    .description(
      'symbol body + callers + containing doc section in one call (spec: file::symbol; also accepts the file::symbol@LINE anchor form documented under `read`; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported)',
    )
    .option('-j, --json', 'output as JSON')
    .option('--limit <n>', 'max callers to show (default: 20)')
    .option('-C, --context <n>', 'lines of call-site source to show before and after each caller (default 0)')
    .option('--exclude-tests', 'hide callers whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'only show callers whose enclosing symbol name matches this regex (literal substring if it is not valid regex)')
    .action((spec: string, more: string[], opts: { json?: boolean; limit?: string; context?: string; excludeTests?: boolean; grep?: string }) =>
      runExit(() => {
        emitExtraFileArgsNote('brief', spec, more, { noun: 'spec', mergeable: namedSpecsMergeable([spec, ...more]) })
        return runBrief({
          spec,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        })
      }),
    )

  program
    .command('section <spec> [more...]')
    .description(
      'read one section from a file (spec: file::heading, or file::<unambiguous heading prefix> — e.g. "Lesson 16" resolves a longer unique heading; comma-separated file::A,B for a merged multi-heading view), or list all sections with --list',
    )
    .option('-j, --json', 'output as JSON')
    .option('--list', 'list all section headings in the file instead of reading one')
    .option('--grep <pattern>', 'with --list, filter headings to this regex; otherwise keep only the matching body lines of each section under their nearest sub-heading (literal substring if it is not valid regex)')
    .option('--max-lines <n>', 'limit returned section content to at most N lines from the top')
    .option('--head <n>', 'alias for --max-lines')
    .action((spec: string, more: string[], opts: { json?: boolean; list?: boolean; grep?: string; maxLines?: string; head?: string }) => {
      const maxLinesRaw = opts.maxLines ?? opts.head
      const maxLines = maxLinesRaw !== undefined ? requireNonNegativeInt('--max-lines', maxLinesRaw) : undefined
      return opts.list === true
        ? runExit(() => {
            // --list reads a plain file and has no comma form, so name no suggestion here.
            emitExtraFileArgsNote('section --list', spec, more, { mergeable: false })
            return runListSections({ file: spec, ...(opts.json === true ? { json: true } : {}), ...(opts.grep !== undefined ? { grep: opts.grep } : {}) })
          })
        : runExitText(() =>
            noteExtraFileArgs(
              'section',
              spec,
              more,
              () =>
                runSection({
                  spec,
                  ...(opts.json === true ? { json: true } : {}),
                  ...(maxLines !== undefined ? { maxLines } : {}),
                  ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
                }),
              { noun: 'spec', mergeable: namedSpecsMergeable([spec, ...more]) },
            ),
          )
    })

  program
    .command('semantic [query] [more...]')
    .description('semantic search (falls back to full-text search); several queries run in one call, one headed block per query')
    .option('-l, --limit <n>', 'max results')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'filter to hits whose file path matches this regex (literal substring if it is not valid regex); matched against the path as rendered')
    .option('--exclude-tests', 'hide hits whose file is a test file (opt-in; default output is unchanged)')
    .option('--preflight', 'run semantic embedding preflight check and exit')
    .option('--warm', 'warm up the embedding model session in memory')
    .option('--distances', 'report the closest-distance spread of recorded semantic queries (no query text is stored) and the current weak_distance')
    .option('--all', 'with --distances: every project instead of the current one')
    .action(guard(cmdSemantic))

  program
    .command('search [query] [more...]')
    .description('parallel multi-angle search fusing symbol, heading, text, and semantic channels concurrently via reciprocal rank fusion')
    .option('-l, --limit <n>', 'max results (default: 20)')
    .option('-c, --channels <list>', 'comma-separated channels to query (symbol,heading,text,semantic)')
    .option('-p, --project [path]', 'scope search to one project root instead of the global index (defaults to cwd)')
    .option('-j, --json', 'output as JSON')
    .option('--min-score <score>', 'minimum reciprocal rank fusion score threshold')
    .action(guard(cmdSearch))

  // `skeleton` and `outline` are the same command over the same options (see OutlineOptions, which is an alias of SkeletonOptions) and differ only in which renderer they hand the file to. They were registered by two blocks identical line for line apart from the name, description and callee, so a flag added to one silently did not exist on the other. Registered in the original order, so `--help` still lists skeleton before outline.
  const registerSymbolListing = (
    name: string,
    description: string,
    run: (opts: SkeletonOptions) => { text: string; code: number },
  ): void => {
    program
      .command(`${name} <file> [more...]`)
      .description(description)
      .option('-j, --json', 'output as JSON')
      .option('--min-lines <n>', 'only show symbols at least N lines long')
      .option('--grep <pattern>', 'only show symbols whose name matches this regex (literal substring if it is not valid regex)')
      .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
      .option('--stats', 'add per-symbol reference count and doc-coverage flag')
      .action(
        (file: string, more: string[], opts: { json?: boolean; minLines?: string; grep?: string; forceRefresh?: boolean; stats?: boolean }) =>
          runExitText(() =>
            noteExtraFileArgs(name, file, more, () =>
              run({
                file,
                ...(opts.json === true ? { json: true } : {}),
                ...(opts.minLines !== undefined ? { minLines: requireNonNegativeInt('--min-lines', opts.minLines) } : {}),
                ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
                ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
                ...(opts.stats === true ? { stats: true } : {}),
              }),
            ),
          ),
      )
  }

  registerSymbolListing(
    'skeleton',
    'list all symbols in a file without bodies (also accepts a comma-separated file list "a,b,c" for one headed block per file)',
    runSkeleton,
  )
  registerSymbolListing(
    'outline',
    'list symbols with line ranges and docstrings (also accepts a comma-separated file list "a,b,c" for one headed block per file)',
    runOutline,
  )

  program
    .command('refs <spec> [more...]')
    .description('find references to one or more symbols (spec: file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported). For an unambiguous TypeScript symbol, automatically type-resolves candidates via the TypeScript compiler API to drop same-named-different-symbol false positives; falls back to name-based matching when that is not possible.')
    .option('--callers', 'group references by their enclosing caller symbol')
    .option('-l, --limit <n>', 'max results')
    .option(
      '--top <n>',
      'for a high-fanout symbol, group references by file (count only) and show only the top N files by reference count instead of a per-line dump',
    )
    .option('-C, --context <n>', 'lines of call-site source to show before and after each reference (default 0)')
    .option('-j, --json', 'output as JSON')
    .option('--exclude-tests', 'hide references whose call site lives in a test file (opt-in; default output is unchanged)')
    .option('--grep <pattern>', 'filter to references whose call-site file path matches this regex (falls back to a literal substring match when the pattern does not compile); matched against the path as rendered, so ^src/ matches what you see in every form -- drops test/vendored hits from a wide-fanout symbol')
    .action((spec: string, more: string[], opts: { callers?: boolean; limit?: string; top?: string; context?: string; json?: boolean; excludeTests?: boolean; grep?: string }) =>
      runExit(() => {
        emitExtraFileArgsNote('refs', spec, more, { noun: 'spec', mergeable: namedSpecsMergeable([spec, ...more]) })
        return runRefs({
          spec,
          ...(opts.callers === true ? { callers: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.top !== undefined ? { top: requirePositiveInt('--top', opts.top) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
          ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
        })
      }),
    )

  program
    .command('index [path]')
    .description('parse all git-tracked files and (re)build the symbol index')
    .option('--walk', 'if not a git repo, index a bounded directory walk instead (skips .env / generated / oversized trees)')
    .option('--force', 'bypass the SHA-freshness cache and reindex every tracked file, even byte-identical ones (e.g. after a parser upgrade changes what gets extracted)')
    .option('--force-walk', `index a non-git folder via --walk and raise its ${MAX_FILES_SCANNED} source-file refusal to ${MAX_FILES_SCANNED_FORCED} (slow; produces a large index)`)
    .option('--embed', `embed every file before returning; without it, files still waiting after ${INDEX_INLINE_EMBED_BUDGET_MS / 1000} s of embedding are left to the background worker`)
    .action(guard(cmdIndex))

  program
    .command('map')
    .description('project overview')
    .option('-c, --compact', 'compact, low-token summary')
    .option('--json', 'emit the project map as JSON instead of text')
    .action(guard(cmdMap))

  program
    .command('bridges-status')
    .description('hook-event parity matrix across every AI-harness bridge (read-only static analysis, never invokes a real harness binary)')
    .option('--json', 'emit the matrix as JSON instead of text')
    .action(guard(cmdBridgesStatus))

  program
    .command('commands')
    .description('machine-readable manifest of every registered command, its options, and its arguments')
    .option('--json', 'emit the manifest as JSON instead of text')
    .option('--grep <pattern>', 'filter to commands whose name, description, or aliases match this regex')
    .action(guard(cmdCommands))

  program
    .command('mcp-serve')
    .description('run token-goat as an MCP stdio server exposing surgical reads and local compression/handoff tools')
    .action(guard(cmdMcpServe))

  program
    .command('bench')
    .description('replay a corpus of captured command output through the compressors; prints the byte savings ratio and a fidelity check, and exits 1 when a must-keep line was dropped')
    .option('--corpus <dir>', 'corpus directory (default: tests/fixtures/bench, relative to the working directory)')
    .option('--tsv <path>', 'append one result row, keyed by the current commit, creating the file and its header if absent')
    .option('--validate', 'score the corpus with control filters instead: proves the ratio has a floor and the fidelity guard can actually fail')
    .option('-j, --json', 'output as JSON')
    .action((opts: { corpus?: string; tsv?: string; validate?: boolean; json?: boolean }) =>
      // A report graded by its exit code, not an error message: it goes to stdout whether or not a check failed, the way doctor's does.
      runExit(() => {
        const { text, code } = runBenchCommand({
          corpus: opts.corpus ?? path.join('tests', 'fixtures', 'bench'),
          ...(opts.tsv !== undefined ? { tsv: opts.tsv } : {}),
          ...(opts.validate === true ? { validate: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        })
        out(text)
        return code
      }),
    )

  program
    .command('compress-text [text]')
    .description('compress arbitrary local text and print an opaque recovery ID plus compact payload')
    .option('--file <path>', 'read text from a local file instead of the argument')
    .option('--payload', 'always print the compact payload, even when inlining it costs more tokens than the original text')
    .action(guard(cmdContentCompress))

  program
    .command('retrieve <id>')
    .description('retrieve original text previously stored by token-goat compress')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the retrieved text')
    .option('--full', 'print the entire retrieved text with no head/tail elision (default behaviour when no other flag is given)')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .action(guard(cmdRetrieve))

  program
    .command('handoff-create <name> [text]')
    .description('create a project-local named compressed handoff')
    .option('--file <path>', 'read handoff text from a local file instead of the argument')
    .action(guard(cmdHandoffCreate))

  program
    .command('handoff-resolve <name>')
    .description('resolve a project-local handoff compactly, or return it in full')
    .option('--full', 'return the full handoff text')
    .action(guard(cmdHandoffResolve))

  program
    .command('hook <event>')
    .description('hook relay entrypoint (reads JSON on stdin)')
    .option('--harness <name>', 'override harness detection for this invocation (sets TOKEN_GOAT_HARNESS_OVERRIDE)')
    .action(guard(cmdHook))

  program
    .command('install')
    .description('install hooks into Claude Code settings, or with harness flags into those harnesses instead')
    .option('-p, --project', 'install into project scope instead of user scope')
    .option('--user', 'with --vscode, install into user scope instead of this project (every project at once, but nothing past the first folder of a multi-root workspace)')
    .option('--codex', 'patch Codex CLI (~/.codex/config.toml, ~/.codex/AGENTS.md)')
    .option('--gemini', 'patch Gemini CLI (~/.gemini/settings.json)')
    .option('--qwen', 'patch Qwen Code (~/.qwen/settings.json)')
    .option('--kimi', 'register a Kimi Code hook config, shim, instructions block and skill ($KIMI_CODE_HOME or ~/.kimi-code: config.toml, hooks/token-goat-shim.cjs, AGENTS.md, skills/token-goat/SKILL.md)')
    .option('--pi', 'drop a pi (pi-coding-agent) extension (~/.pi/agent/extensions/token-goat.ts)')
    .option('--opencode', 'drop an opencode plugin (~/.config/opencode/plugins/token-goat.ts, or under $XDG_CONFIG_HOME when set)')
    .option('--hermes', 'verify token-goat hooks are present for Hermes Agent (writes nothing new)')
    .option('--openclaw', 'register an OpenClaw plugin (~/.openclaw/openclaw.json, ~/.openclaw/plugins/token-goat.ts)')
    .option('--copilot', 'register a Copilot CLI hook config and routing block (~/.copilot/hooks/token-goat.json, ~/.copilot/hooks/token-goat-shim.cjs, ~/.copilot/copilot-instructions.md; with --local or -p/--project, <project>/.github/hooks/token-goat.json, <project>/.github/hooks/token-goat-shim.cjs, <project>/.github/copilot-instructions.md)')
    .option('--grok', 'register a Grok CLI (xAI Grok Build) hook config (~/.grok/hooks/token-goat.json, ~/.grok/hooks/token-goat-shim.cjs)')
    .option('--antigravity', 'register an Antigravity CLI (agy) plugin (~/.gemini/config/plugins/token-goat/: plugin.json, hooks.json, and token-goat-hook.cmd on Windows)')
    .option('--vscode', 'configure a VS Code MCP server (the workspace .vscode/mcp.json by default; --user for the user-profile mcp.json) and Copilot routing guidance')
    .option('--visualstudio', 'configure a Visual Studio (2022 17.14+ / 2026) Copilot MCP server and routing guidance, no hooks (%USERPROFILE%\\.mcp.json and %USERPROFILE%\\copilot-instructions.md; -p/--project for <project>/.mcp.json and <project>/.github/copilot-instructions.md)')
    .option('--zed', 'register token-goat as a Zed MCP context server (%APPDATA%\\Zed\\settings.json on Windows, ~/.config/zed/settings.json elsewhere, plus a generated shim script); Zed has no hooks API, so this is user scope only, no -p/--project support')
    .option('--cursor', 'register a Cursor MCP server (~/.cursor/mcp.json by default; -p/--project for <project>/.cursor/mcp.json); writes no Cursor hooks config -- Cursor already imports the Claude Code hooks `token-goat install` writes to ~/.claude/settings.json')
    .option('--jetbrains', 'configure a JetBrains Suite (WebStorm, IntelliJ, PyCharm, Rider) MCP server and Copilot routing guidance')
    .option('--neovim', 'install Neovim Lua integration module (<project>/.nvim/token-goat.lua, or user plugin dir)')
    .option('--detect', 'inspect the current workspace and detect all IDEs and coding agent ecosystems')
    .option('--auto', 'automatically install token-goat across all detected developer ecosystems')
    .option('--all', 'install token-goat across all supported IDE and coding agent environments')
    .option('--local', 'with --pi or --copilot, install the project-local config instead of the global one (<project>/.pi/extensions/token-goat.ts, <project>/.github/hooks/token-goat.json); the same as -p/--project')
    .option('--no-index', 'do not queue the project in the current directory for its first index (TOKEN_GOAT_INSTALL_INDEX=0 does the same)')
    .action(guard(cmdInstall))

  program
    .command('uninstall')
    .description('remove token-goat hooks from Claude Code settings, or with harness flags from those harnesses instead')
    .option('-p, --project', 'uninstall from project scope instead of user scope')
    .option('--user', 'with --vscode, remove the user-scope install instead of this project one')
    .option('--codex', 'strip the Codex CLI integration (~/.codex/config.toml, ~/.codex/AGENTS.md)')
    .option('--gemini', 'strip the Gemini CLI integration (~/.gemini/settings.json)')
    .option('--qwen', 'strip the Qwen Code integration (~/.qwen/settings.json)')
    .option('--kimi', 'strip the Kimi Code integration (config.toml hooks, hooks/token-goat-shim.cjs, the AGENTS.md block and skills/token-goat under $KIMI_CODE_HOME or ~/.kimi-code)')
    .option('--pi', 'remove the pi (pi-coding-agent) extension')
    .option('--opencode', 'remove the opencode plugin')
    .option('--hermes', 'no-op verification flag for symmetry with install (removes no files)')
    .option('--openclaw', 'remove the OpenClaw plugin and config entry')
    .option('--copilot', 'remove the Copilot CLI hook config and shim script, and strip the token-goat block from ~/.copilot/copilot-instructions.md (or <project>/.github/copilot-instructions.md with --local or -p/--project)')
    .option('--grok', 'remove the Grok CLI hook config and shim script')
    .option('--antigravity', 'remove the Antigravity CLI (agy) plugin (~/.gemini/config/plugins/token-goat/)')
    .option('--vscode', 'remove the VS Code MCP server (project scope by default; --user for the user-profile one) and routing guidance')
    .option('--visualstudio', 'remove the Visual Studio MCP server entry and routing guidance (user scope by default; -p/--project for the project one)')
    .option('--zed', 'remove the Zed MCP context server entry and its generated shim script')
    .option('--cursor', 'remove the Cursor MCP server entry (user scope by default; -p/--project for the project one)')
    .option('--jetbrains', 'remove the JetBrains MCP server entry and Copilot routing guidance')
    .option('--neovim', 'remove the Neovim Lua integration module')
    .option('--all', 'uninstall token-goat across all supported environments')
    .option('--local', 'with --pi or --copilot, remove the project-local config instead of the global one; the same as -p/--project')
    .option('--purge', 'also delete the data directories (index, caches, session state, logs); refuses while the worker is running')
    .action(guard(cmdUninstall))

  program
    .command('mcp-status')
    .description('check whether an MCP integration is already configured (used by the VS Code extension)')
    .option('--vscode', 'check VS Code mcp.json (user scope, plus workspace scope with --project)')
    .option('--visualstudio', 'check the Visual Studio %USERPROFILE%\\.mcp.json (plus the project .mcp.json with --project)')
    .option('-p, --project', 'also check the project file: .vscode/mcp.json for --vscode, .mcp.json for --visualstudio (relative to --cwd or the real cwd)')
    .action(guard(cmdMcpStatus))

  const worker = program.command('worker').description('background indexer lifecycle')
  worker.command('start').description('start the background indexer').action(guard(cmdWorkerStart))
  worker.command('stop').description('stop the background indexer').action(guard(cmdWorkerStop))
  worker.command('status').description('check if the indexer is running').action(guard(cmdWorkerStatus))

  const hookServer = program.command('hook-server').description('resident processes that answer hook calls and read-only commands without starting Node for each one')
  hookServer.command('run', { hidden: true }).description('serve one slot (started automatically by the first hook call)').option('--slot <n>', 'which slot to serve', '0').action(guard(cmdHookServerRun))
  hookServer.command('status').description('list the running hook servers').option('-j, --json', 'output as JSON').action(guard(cmdHookServerStatus))
  hookServer.command('stop').description('stop every running hook server (the next hook call starts a fresh one)').action(guard(cmdHookServerStop))

  program
    .command('stats')
    .description('show session statistics (bare = totals only; --full for the breakdown)')
    .option('-j, --json', 'output as JSON')
    .option('--full', 'show the full breakdown (by source, by command, by day)')
    .option('--short', 'force the rich short KPI view even when stdout is not a TTY (e.g. piped)')
    .option('--methodology', 'explain local savings estimates and their billing limits')
    .option('--hooks', 'show the per-event/per-harness hook latency breakdown (median/p95/slowest/last-seen)')
    .option('--payloads', "show what token-goat adds to every session's context, and whether the files each note names were read again")
    .option('--window-days <days>', 'days to include (0 = all time)', '30')
    .option('--home-dir <path>', 'home directory (for testing)')
    .action(guard(cmdStats))

  program
    .command('doctor')
    .description('diagnose token-goat health')
    .option('--context', 'include context footprint analysis')
    .option('--json', 'emit check results as JSON instead of text')
    .option('--repair', 'automatically repair fixable issues (permissive settings, missing semantics models)')
    .option('--fix', 'alias for --repair')
    .option('--probe <harness>', 'run one real prompt through a harness (claudecode, codex, copilot_cli) and check that token-goat\'s context hooks reach the model')
    .action(guard(cmdDoctor))

  program
    .command('bash-output [id]')
    .description('retrieve cached bash output by ID or file')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the output')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .option('--file <path>', 'read from raw output file instead of cache')
    .option('--transcript', 'parse the --file as a JSONL agent transcript: keep assistant text blocks in order before filtering')
    .option('--verify-last-write [seconds]', 'verify the file or cache entry was written within [seconds] (default: 60s) to catch stale/no-op terminal output')
    .option('--strict', 'exit non-zero when --verify-last-write detects stale output')
    .action(guard(cmdBashOutput))

  program
    .command('web-output [id]')
    .description('retrieve a cached WebFetch response body by ID')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the response')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .option('--raw', 'return the body as actually fetched, before extractCleanText cleaning, instead of the default cleaned text')
    .action(guard(cmdWebOutput))

  program
    .command('mcp-output [id]')
    .description('retrieve a cached MCP tool result by ID (the id an MCP post_tool_use hook cached, or a `[token-goat: compressed, full via mcp-output <id>]` label points here)')
    .option('--head <n>', 'show first N lines (or first N items with --json-query)')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the result')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--lines <a-b>', 'print exactly lines A-B (1-based, inclusive) with no elision, e.g. 395-405; with --section, the numbers -n prints')
    .option('-n, --line-numbers', 'prefix every printed line with its line number (N:text)')
    .option('--context <n>', 'with --grep, also show N lines around each match')
    .option('--json-query <path>', 'query JSON content using a dot/bracket path expression (e.g. "issues[*].key")')
    .option('--file <path>', 'read and query an on-disk tool spill file (e.g. content.json) instead of cache')
    .option('--json', 'emit query results as structured JSON envelope')
    .action(guard(cmdMcpOutput))

  program
    .command('pr-slice <pr> <slice>')
    .description(
      'one slice of a GitHub PR (files / one file\'s diff / review comments / description) via `gh` instead of a full `gh pr view`/`gh pr diff` dump\n\n' +
        'pr is a PR number or URL. slice is one of: files (changed files with +/- counts), ' +
        "diff:<path> (one file's diff hunk), comments (review comments), description (title/body/metadata)",
    )
    .option('--repo <owner/repo>', "target repo (default: resolved from the current directory's git remote 'origin')")
    .option('--json', 'emit the slice as JSON instead of text')
    .action(guard(cmdPrSlice))

  registerFormatCommands(program, guard)
  registerAnalysisCommands(program, guard)
  registerSessionCommands(program, guard)
  program
    .command('gdrive-sections <file-id>')
    .description('fetch and list sections from a public Google Doc')
    .option('--heading <name>', 'get content of one named section')
    .option('--fresh', 'skip the on-disk cache and force a live fetch')
    .action(guard(cmdGdriveSections))

  program
    .command('compress [command...]')
    .alias('bash')
    .alias('run')
    .description('run a shell command (under a POSIX shell / bash) and emit a compressed view of its output')
    .allowUnknownOption(true)
    .option('-c, --cmd <command>', 'the shell command to run, as one string (use / for paths across platforms)')
    .option('--cmd-b64 <payload>', 'internal hook use only: base64-encoded command generated programmatically by token-goat hooks. Agents and interactive users must NOT use this flag manually (pass plain shell commands instead; LLMs cannot reliably synthesize base64 without character corruption)')
    .option('--shell <type>', 'shell interpreter to run under: bash | pwsh | powershell | native')
    .option('-f, --filter <name>', 'filter name (auto-detected from the command when omitted)')
    .option('--timeout <seconds>', 'wall-clock timeout in seconds (0 = built-in default)')
    .option('--no-compress', 'stream output raw without compression (debug the wrapper)')
    .option('--profile <name>', 'compression profile: aggressive | balanced | minimal')
    .option('--max-tokens <n>', 'post-compress token cap (0 = no cap)')
    .option('--cap-hint-b64 <payload>', 'base64 text printed after the output when --max-tokens cut it (the Bash hook sets it to the narrower read command)')
    .option('-q, --quiet-success', 'on exit code 0, emit only [tg: ok] summary and store full output for recall via bash-output')
    .option('--native', 'use native platform shell (e.g. cmd.exe on Windows) instead of bash, preserving Windows path backslashes')
    .option('--stdin', 'pipe standard input to the wrapped command')
    .action(cmdCompress)

  program
    .command('upgrade')
    .alias('update')
    .description('check for updates and upgrade token-goat to the latest version')
    .option('--check', 'check whether an update is available without installing')
    .option('-j, --json', 'emit version check status as JSON')
    .action((opts: { check?: boolean; json?: boolean }) =>
      guard(async () => {
        const { cmdUpgrade } = await import('./cli_upgrade.js')
        await cmdUpgrade(opts, () => cmdInstall({}))
      })(),
    )

  program
    .command('version')
    .description('print the token-goat version')
    .action(
      guard(() => {
        out(VERSION)
      }),
    )

  program
    .command('help [command]')
    .description('show help for a command')
    .option('--full', 'show full original help instead of compact summary')
    .action(
      guard((cmd?: string, opts?: unknown) => {
        const options = opts as Record<string, boolean | undefined> | undefined
        if (options?.['full'] && !cmd) {
          out(originalHelpInformation ? originalHelpInformation() : generateCompactHelp())
          return
        }
        if (cmd) {
          // Resolved before parsing, because commander answers `<unknown> --help` by printing the top-level help rather than by complaining: the caller asked about one command and silently got the list of all of them. Pre-existing behaviour exited 1 without ever saying why, which is the half of it worth keeping.
          const known = program.commands.some((sub) => sub.name() === cmd || sub.aliases().includes(cmd))
          if (!known) {
            err(formatCommandError(`unknown command '${displaySafeText(cmd)}'. Run 'token-goat commands --grep <pattern>' to search the list.`))
            process.exitCode = 1
            return
          }
          const argv: string[] = [process.argv[0] ?? 'node', process.argv[1] ?? 'token-goat', cmd, '--help']
          try {
            program.parse(argv)
          } catch (e) {
            // `applyExitOverride` arms every subcommand, so `<cmd> --help` reports itself by throwing rather than by exiting -- and commander has already written the help text to stdout by the time it does. Letting that reach the action wrapper turned the success into `token-goat: (outputHelp)` on stderr and exit 1 for every `help <command>` there is, including the spelling the compact help's own closing tip recommends. Any other code is a real failure and still propagates.
            const code = (e as { code?: string }).code
            if (code !== 'commander.help' && code !== 'commander.helpDisplayed') throw e
          }
        } else {
          out(generateCompactHelp())
        }
      }),
    )

  // Replace default help with compact grouped summary
  program.helpOption('-h, --help', 'display help for command')
  // Override helpInformation (which formatHelp calls) to use compact grouped output. Capture the prototype implementation first: the assignment below is an own property that shadows it permanently, so `help --full` has no other way back to the long listing.
  originalHelpInformation = (
    program as unknown as { helpInformation(): string }
  ).helpInformation.bind(program)
  ;(program as unknown as { helpInformation(): string }).helpInformation = () => generateCompactHelp()

  return program
}

/** Applies commander's exitOverride to a command and, recursively, every subcommand under it, along with the `token-goat:` rendering of its parse errors (formatParseError). */
export function applyExitOverride(command: Command): void {
  command.exitOverride()
  command.configureOutput({ outputError: (str, write) => write(formatParseError(str)) })
  for (const sub of command.commands) applyExitOverride(sub)
}

/** Parse `argv` and dispatch. Sets `process.exitCode`; callers (main.ts) should let the process exit naturally so buffered stdout flushes first. */
export async function run(argv: string[] = process.argv): Promise<void> {
  // `--worker-daemon` is how startDetachedWorker's spawned child is invoked (see worker_lifecycle.ts::startDetachedWorker): `spawn(node, [thisModule, '--worker-daemon'])`, i.e. always argv[2]. It is not a registered commander option or command anywhere in buildProgram, so it must be intercepted here, before parseAsync ever sees argv -- otherwise commander rejects it as an unknown option and the freshly-spawned daemon child exits immediately, silently disabling the entire detached background-indexing feature (`token-goat worker start`). Checking only argv[2] (rather than "anywhere in argv") avoids hijacking an unrelated command that merely carries that literal string as one of its own arguments, e.g. `token-goat grep -- --worker-daemon`.
  if (argv[2] === '--worker-daemon') {
    runDetachedWorkerDaemon()
    return
  }
  // `--batch-serve <token>`: serve many invocations from this one already-started process. Same argv[2]-only interception as --worker-daemon above, and for the same reason -- commander has no such option, so it would reject it before the server ever started. See batch_serve.ts.
  if (argv[2] === '--batch-serve' && typeof argv[3] === 'string') {
    const { serveBatch } = await import('./batch_serve.js')
    serveBatch(argv[3], (a) => run(a))
    return
  }
  // Any command that reads or indexes a file can reach a synchronous parse, and the regex language adapters live behind a dynamic import so the hook path never compiles them (see loadRegexExtractors). Load them once here rather than at each of the call sites below it.
  await loadRegexExtractors()
  const program = buildProgram()
  // Commander's exitOverride lets us catch its internal exits (help, version, unknown command) instead of letting it call process.exit() mid-flush. Applied to every subcommand, not just the program. Commander copies the exit callback to a subcommand when that subcommand is CREATED (copyInheritedSettings, called from .command()), and buildProgram() has already created all of them by the time this runs -- so they each inherited "no callback" and `token-goat <subcommand> --help` called process.exit() for real, which is exactly what main.ts's docblock says this binary must never do, because an exit mid-flush can truncate output already written to a pipe.
  applyExitOverride(program)
  try {
    await program.parseAsync(argv)
  } catch (e) {
    // Help / version requests throw with these codes and are not errors.
    const code = (e as { code?: string }).code
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
      process.exitCode = 0
      return
    }
    if (typeof code === 'string' && code.startsWith('commander.')) {
      // Every commander error (unknown command or option, missing argument, excess arguments) has already been written to stderr by commander, so printing it again as a token-goat error doubled every parse failure. Its "(Did you mean X?)" is edit distance over the registered names, which misfires on a conceptual miss rather than a typo -- `search` resolves to `arch`. Append an intent-based pointer for the handful of names a caller reaches for when they know what they want but not what it is called; commander's own line is left exactly as it was.
      if (code === 'commander.unknownCommand') {
        const attempted = attemptedCommandName(argv)
        const hint = attempted === null ? null : suggestForUnknownCommand(attempted)
        if (hint !== null) err(`Looking for that? Try ${hint}.`)
      }
      process.exitCode = 1
      return
    }
    err(formatCommandError(e))
    process.exitCode = 1
  }
}
