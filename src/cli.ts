/**
 * CLI entrypoint (`token-goat ...`).
 *
 * Wires the surgical-read commands (symbol / read / section / skeleton /
 * outline / map / semantic), the hook relay, and the install / worker
 * lifecycle subcommands onto a Commander program. Every command resolves to a
 * small text payload on stdout and an exit code: 0 on success, 1 on a handled
 * error (missing symbol, unreadable file). Unexpected throws also map to 1.
 *
 * This is the TS analogue of `cli.py::main`; it targets the subset of commands
 * exercised by the TS port rather than the full Python surface.
 */

import { Command } from 'commander'
import { attemptedCommandName, suggestForUnknownCommand } from './command_intent.js'
import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
// Type-only imports: erased at compile time, so referencing them here does not eagerly load mcp_server.js (and transitively @modelcontextprotocol/sdk) at CLI startup. The runtime values are lazy-imported only inside cmdMcpServe.
import type { createMcpServer as CreateMcpServerFn } from './mcp_server.js'
import type { StdioServerTransport as StdioServerTransportClass } from '@modelcontextprotocol/sdk/server/stdio.js'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved, MAX_FILES_SCANNED } from './baseline.js'
import { formatLocalTimestamp, recordStat, _useRichStats } from './stats.js'
import { getTrackedFiles } from './repomap.js'
import { collectWalkIndexFiles, MAX_FILES_SCANNED_FORCED } from './walk_index.js'
import { ENV_KEYS, globalDbPath, VERSION } from './constants.js'
import { getSessionId } from './session.js'
import { indexFileSync, indexFileEmbeddings, isEmbedFresh, isParseSkipEligible } from './parser.js'
import { embeddingsDepsAvailable } from './embeddings.js'
import { getDb } from './db.js'
import { pruneDeletedFiles, removeFileFromIndex } from './index_prune.js'
import { fingerprintFile, fingerprintContent } from './fingerprint.js'
import { getFileEntry } from './index_reader.js'
import { detectLanguage } from './parser_types.js'
import { isEmbeddableDocument } from './doc_embed_extract.js'
import { resolveIndexPath } from './paths.js'
import { resolveProjectRoot } from './project.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { relay } from './relay.js'
import {
  installHooks,
  isInstalled,
  uninstallHooks,
  installClaudeMd,
  uninstallClaudeMd,
  findStrayClaudeMdBlocks,
  installSkill,
  uninstallSkill,
} from './install.js'
import type { HookScope } from './install.js'
import { installCodex, uninstallCodex } from './bridges/codex_install.js'
import { installGemini, uninstallGemini } from './bridges/gemini_install.js'
import { installQwen, uninstallQwen } from './bridges/qwen_install.js'
import { installPi, uninstallPi } from './bridges/pi_install.js'
import { installOpencode, uninstallOpencode } from './bridges/opencode_install.js'
import { installOpenclaw, uninstallOpenclaw } from './bridges/openclaw_install.js'
import { installCopilotCli, uninstallCopilotCli } from './bridges/copilot_cli_install.js'
import { installGrok, uninstallGrok } from './bridges/grok_install.js'
import { installVscode, uninstallVscode } from './bridges/vscode_install.js'
import {
  isWorkerRunning,
  runDetachedWorkerDaemon,
  startDetachedWorker,
  stopWorker,
  WorkerAlreadyRunningError,
} from './worker.js'
import { getBashOutput } from './bash_output_cache.js'
import { getWebOutput } from './web_cache.js'
import * as bashRunner from './bash_runner.js'
import {
  runSymbol,
  runRead,
  runBrief,
  runSection,
  runListSections,
  didYouMean,
  runRefs,
  runSkeleton,
  runOutline,
  extraFileArgsNote,
  runChanged,
  runDiff,
  runLog,
  runConfigGet,
  runExports,
  runImports,
  runFind,
  runGrep,
  runCsvProfile,
  runCsvQuery,
  runJsonOutline,
  runJsonQuery,
  runYamlOutline,
  runYamlQuery,
  runOpenApiOutline,
  runOpenApiOp,
  runZipList,
  runZipRead,
  runPrSlice,
  runSqliteSchema,
  runSqliteQuery,
  runCoverageReportGaps,
  runConflicts,

  runPdfExtractText,
  runPdfMeta,
  runPdfOutline,

  runScreenshot,
  extractTranscriptText,
  extractSection,
  findSpecSeparator,
  runSemantic,
  healStaleIndex,
  runNoteGet,
  runNoteList,
  rankSimilarNames,
  filterSimilarHeadings,
} from './read_commands.js'
import { WHOLE_FILE_NOTE_SYMBOL, resolveSymbolMatch, symbolNamesInFile, computeFileFingerprint, upsertNote } from './notes.js'
import { BRIDGE_CAPABILITY_MATRIX, bridgesStatusToJson, formatBridgesStatus } from './bridges_status.js'
import { buildCommandManifest, filterCommandManifest, formatCommandManifest } from './cli_commands.js'
import { listSheets as xlsxListSheets, headSheet as xlsxHeadSheet, rangeSheet as xlsxRangeSheet, formatXlsxRange, querySheet as xlsxQuerySheet } from './xlsx_extract.js'
import { pptxOutline, pptxSlideText, pptxNotesText, pptxTextGrep } from './pptx_extract.js'
import { docxOutline, docxText } from './docx_extract.js'
import { formatCsvTable, parseWhereSpecs } from './csv_query.js'
import { parseShareUrl, resolveLocalPath } from './sharepoint_resolve.js'
import { extractVideoChapters } from './video_chapters.js'


import { buildTranscriptOutline, formatCues, formatTimestamp, parseSliceOptions, readTranscript, sliceTranscript } from './transcript_extract.js'
import {
  runCallers,
  runCallChain,
  runImpact,
  runDead,
  runDeps,
  runTypes,
  runScope,
  runSimilar,
  runContextFor,
  runTestFor,
  runCoverageGaps,
  runArch,
  runBlame,
  runAsk,
} from './graph_commands.js'
import { contentHash, extractCompactFromMarker, extractNamedSection, formatAge, getSkillFilePath, incrementSkillHit, listOutputs, listSkills, skillOutputsDir, storeCompact, storeOutput } from './skill_cache.js'
import { buildLineDiff } from './hooks_read.js'
import { readSection, listSections } from './section_reader.js'
import { isWindows, ensureNewline, extractErrorMessage, withRetryOnLock, isUnderBlockedRoot, sleepSync } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { loadConfig, getLastConfigParseError, getLastProjectConfigParseError } from './config.js'
import { runStats } from './cli_stats.js'
import { runDoctorAndExit, runDoctor } from './cli_doctor.js'
import { fetchDoc, getDocSections, formatSections, getSectionContent } from './gdrive.js'
import {
  collectFiles,
  collectFromStdin,
  formatPack,
  scanSecrets,
  estimateBudget,
  formatBudgetText,
} from './pack.js'
import {
  extractFailures,
  formatFailuresText,
  formatFailuresJson,
  failureSignatures,
  computeFailureDelta,
  formatFailureDeltaText,
  formatFailureDeltaJson,
} from './failures.js'
import { loadFailureSnapshot, saveFailureSnapshot, DEFAULT_FAILURES_STATE_KEY } from './failures_state.js'
import { findProject } from './project.js'
import { cmdTodo, cmdTrace, cmdLogfold, cmdLockdeps, cmdNote, cmdHot, cmdRecent, cmdIgnores } from './text_commands.js'
import { runDepDocs } from './dep_docs.js'
import { cmdBashHistory, cmdWebHistory, cmdMcpHistory, cmdCleanCache, cmdPruneCache, cmdCacheAudit, cmdResume, cmdCompactHint, cmdSessionSummary, cmdCost, cmdBaseline } from './cache_session_commands.js'
import { cmdReclaimIndex } from './index_reclaim.js'
import { cmdConfig, cmdProject, cmdCompactDoc, cmdFetchImage, cmdHistory } from './config_commands.js'
import { runContextStats } from './cli_context_stats.js'
import { runBootstrapAudit } from './cli_bootstrap_audit.js'
import { runMemoryCommand } from './cli_memory.js'
import { runWasteCommand } from './cli_waste.js'
import { buildSessionOutline, formatSessionOutline, formatSessionSlice, parseTurnRange, resolveSessionTranscript, sliceSessionTurns } from './session_read.js'
import { runMcpAuditCommand } from './cli_mcp_audit.js'
import { runRecallCommand } from './cli_recall.js'
import { isRecallCacheType, type RecallCacheType } from './recall_index.js'
import { runHintStatsCommand } from './cli_hint_stats.js'
import { isHintCategory } from './hint_stats.js'
import { runStatuslineCommand } from './cli_statusline.js'
import { compressText, createHandoff, resolveHandoff, retrieveText, CONTENT_MAX_INPUT_CHARS } from './content_store.js'

/** Thrown by command handlers for a clean exit-1 with a stderr message. */
class CliError extends Error {}

function out(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function err(text: string): void {
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
    value = fs.readFileSync(file, 'utf8')
  } else {
    if (text === undefined) throw new CliError('provide text or --file')
    value = text
  }
  if (value.length > CONTENT_MAX_INPUT_CHARS) {
    throw new CliError(`text exceeds the ${CONTENT_MAX_INPUT_CHARS}-character safety limit`)
  }
  return value
}

function formatCompression(result: ReturnType<typeof compressText>): string {
  return [
    `id: ${result.id}`,
    `encoding: ${result.encoding}`,
    `original_bytes: ${result.originalBytes}`,
    `compact_bytes: ${result.compactBytes}`,
    `bytes_saved: ${result.bytesSaved}`,
    `recovery: ${result.recovery}`,
    'payload:',
    result.compact,
  ].join('\n')
}

function cmdContentCompress(text: string | undefined, opts: { file?: string }): void {
  out(formatCompression(compressText(readBoundedText(text, opts.file))))
}

function cmdRetrieve(id: string): void {
  const text = retrieveText(id)
  if (text === null) throw new CliError(`no token-goat content for id: ${id}. The local cache may have expired.`)
  out(text)
}

function cmdHandoffCreate(name: string, text: string | undefined, opts: { file?: string }): void {
  const result = createHandoff(name, readBoundedText(text, opts.file))
  out(JSON.stringify(result, null, 2))
}

function cmdHandoffResolve(name: string, opts: { full?: boolean }): void {
  const result = resolveHandoff(name, { full: opts.full === true })
  if (result === null) throw new CliError(`no local handoff named "${name}" in this project`)
  out(typeof result === 'string' ? result : formatCompression(result))
}

// Parses a --limit/--top style numeric CLI flag, rejecting a non-numeric value with a clean CliError instead of letting NaN flow into a downstream SQL LIMIT bind (which better-sqlite3 rejects with an opaque "datatype mismatch" error).
function requireInt(flag: string, raw: string): number {
  // Only accept exact integer literals (optional leading minus, followed by digits)
  if (!/^-?\d+$/.test(raw)) {
    throw new CliError(`${flag} must be a number, got: "${raw}"`)
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new CliError(`${flag} must be a number, got: "${raw}"`)
  }
  return n
}

// Same numeric parse as requireInt, plus a sign check. Every current --limit/--top flag feeds either a SQL `LIMIT ?` bind or a `.slice(0, n)` row cap, and a negative value breaks both in the opposite direction from what the flag promises: SQLite treats a negative LIMIT as "no limit" (LIMIT -1 returns every row instead of none), and `.slice(0, -1)` silently reinterprets as "everything except the last element" per JS's slice-from-the-end semantics. Zero is fine (both SQL and slice() correctly return nothing for 0), so only strictly-negative is rejected.
function requireNonNegativeInt(flag: string, raw: string): number {
  const n = requireInt(flag, raw)
  if (n < 0) {
    throw new CliError(`${flag} must be a non-negative number, got: "${raw}"`)
  }
  return n
}

function requirePositiveInt(flag: string, raw: string): number {
  const n = requireInt(flag, raw)
  if (n <= 0) {
    throw new CliError(`${flag} must be a positive number, got: "${raw}"`)
  }
  return n
}

// --- Command handlers -------------------------------------------------------

// Thin wrapper: all orchestration (embedding search, merge, FTS fallback, formatting) lives in read_commands.ts's runSemantic so the MCP server (mcp_server.ts) can call the same logic in-process without going through the CLI/commander layer.
async function cmdSemantic(query: string, opts: { limit?: string; json?: boolean }): Promise<void> {
  const limit = opts.limit !== undefined ? requireNonNegativeInt('--limit', opts.limit) : 20
  const { text, code } = await runSemantic(query, { limit, ...(opts.json === true ? { json: true } : {}) })
  // --json must always land on stdout so `| jq .` works even on a no-match/error exit -- only
  // the text-mode path routes a non-zero code to stderr (preserved byte-identical below).
  ;(opts.json === true || code === 0 ? out : err)(text)
  process.exitCode = code
}

export async function cmdIndex(
  pathArg?: string,
  opts: { walk?: boolean; dbPath?: string; force?: boolean; forceWalk?: boolean } = {},
): Promise<void> {
  const root = pathArg ?? process.cwd()
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
          `indexing ${files.length} files may take a long time and produce a large index. ` +
          `Run 'token-goat doctor' afterwards to check index size.\n`,
      )
    }
  }
  const blockedRoots = loadConfig().worker.blocked_roots
  const ixCfg = loadConfig().indexing
  let indexed = 0
  let failed = 0
  let skipped = 0
  const failureGroups = new Map<string, { example: string; count: number }>()
  // Manual `index` runs can take minutes on a real repo with nothing printed until the very end, which looks hung on a real terminal but must stay perfectly silent for pipes/CI/hook invocations that parse stdout -- reuse _useRichStats' exact TTY/NO_COLOR/CI gate (Claude Code's own terminal reports isTTY===undefined, not false) so the same rule that governs rich stats output governs this progress line. Progress is written to stderr only and throttled to ~10 repaints/sec so a large repo does not hammer the terminal with one line per file.
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
    // worker.blocked_roots (set via `token-goat project exclude`) excludes a path prefix from
    // indexing entirely -- skip before the language check so a blocked file is never touched.
    if (isUnderBlockedRoot(key, blockedRoots)) continue
    // PDF/DOCX/PPTX/XLSX have no Language entry (no code symbols) so detectLanguage reports 'unknown', but they must still reach indexFileEmbeddings below for extracted-text embedding.
    if (detectLanguage(key) === 'unknown' && !isEmbeddableDocument(key)) continue
    // indexing.skip_dirs / large_file_skip_kb: filter here, before the sha/entry work below. Without this pre-filter, indexFileSync's internal purge would run and then the unconditional indexFileEmbeddings call below would immediately re-embed a file meant to be fully excluded (origin's indexFileEmbeddings has no skip_dirs/size-cap branch).
    if (isParseSkipEligible(key, ixCfg)) {
      removeFileFromIndex(getDb(dbPath), key)
      continue
    }
    // Mirror worker.ts's makeIndexer sha gate here: a bulk `token-goat index` run previously called indexFileSync (and re-chunked/re-embedded via indexFileEmbeddings) unconditionally for every tracked file on every invocation, even ones byte-identical to what was already indexed. fingerprintFile returning null (a transient read failure/race) is treated as "not unchanged" so the file still gets a normal reindex attempt below. Parse and embed freshness are gated independently (embed_sha vs sha), matching makeIndexer, so a file whose embedding previously failed still gets re-embedded even when its parse is current. --force bypasses both freshness checks unconditionally -- e.g. after a parser.ts extraction-logic change, every already-indexed file's SHA is untouched and stale symbols/refs would otherwise never get recomputed until each file happens to be edited.
    const sha = fingerprintFile(key)
    const entry = sha !== null ? getFileEntry(key, dbPath) : null
    const parseUnchanged = !force && sha !== null && entry?.sha === sha
    // isEmbedFresh (parser.ts) is the shared read side of this gate, also used by worker.ts's makeIndexer: while embeddings are config-disabled, only the `disabled:` marker for this sha counts as fresh; while enabled, a bare sha match is fresh (the file was really embedded, or was empty / permanently policy-skipped -- e.g. profile-meta.xml, an oversized salesforce_metadata file -- with nothing to embed, both terminal regardless of deps); and an `unavailable:` marker is fresh only while the optional embedding deps stay uninstalled.
    const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true
    // See isEmbedFresh: depsAvailable keeps an `unavailable:`-marked embed_sha (a file skipped only because the optional model/sqlite-vec deps were absent) treated as stale so it is re-embedded once the deps are installed, instead of looking permanently fresh.
    const depsAvailable = embeddingsEnabled && embeddingsDepsAvailable(getDb(dbPath))
    const embedUnchanged =
      !force &&
      parseUnchanged &&
      sha !== null &&
      isEmbedFresh(entry?.embedSha, sha, embeddingsEnabled, depsAvailable)
    if (parseUnchanged && embedUnchanged) {
      skipped += 1
      continue
    }

    if (!parseUnchanged) {
      paintProgress('parsing')
      try {
        indexFileSync(key, dbPath)
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
    }
    if (!embedUnchanged) {
      paintProgress('embedding')
      // Best-effort semantic-embeddings step for the same file, run right after its syntactic parse; awaited here because this is a one-shot foreground command the caller waits on, unlike the worker's incremental drain which fires this and forgets it. Passing sha lets it stamp files.embed_sha on success, the same embed-freshness gate makeIndexer uses.
      await indexFileEmbeddings(key, dbPath, sha ?? undefined)
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
  out(
    `Indexed ${indexed} files into the symbol index.` +
      `${skipped > 0 ? ` Skipped ${skipped} unchanged file(s).` : ''}` +
      `${pruned > 0 ? ` Pruned ${pruned} deleted file(s).` : ''}` +
      `${failed > 0 ? ` Failed to index ${failed} file(s) (see stderr).` : ''}`,
  )
  // A run where every file failed and none indexed is a total indexing failure, not a
  // no-op success -- callers scripting on `$?` must be able to detect it.
  if (indexed === 0 && failed > 0) {
    process.exitCode = 1
  }
}

function cmdMap(opts: { compact?: boolean; json?: boolean }): void {
  const map = buildProjectMap(process.cwd(), { compact: opts.compact === true })
  const text = formatProjectMap(map, map.compact)
  if (opts.json === true) {
    out(JSON.stringify(map))
  } else {
    out(text)
  }
  // `map_lookup` has carried a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry
  // since the Python->TS port, but nothing ever called recordStat for it -- the `map`/`baseline`
  // dashboard bucket was permanently zero regardless of real usage (same class of gap fixed for
  // changed_lookup, see project_runchanged_missing_stat memory). The byte accounting (including the
  // recentFiles-vs-topSymbols path canonicalization needed for the dedup) lives in
  // mapLookupBytesSaved so cmdMap and the MCP `map` tool share one implementation.
  const bytesSaved = mapLookupBytesSaved(map, text)
  recordStat('map_lookup', bytesSaved, Math.round(bytesSaved / 4))
}

function cmdBridgesStatus(opts: { json?: boolean }): void {
  if (opts.json === true) {
    out(JSON.stringify(bridgesStatusToJson(BRIDGE_CAPABILITY_MATRIX)))
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
    out(JSON.stringify(manifest))
  } else if (manifest.length === 0) {
    // Same wording as cmdPptxText's --grep-with-no-hits path: a filter matching nothing is a
    // legitimate empty result, not an error, so this stays a plain message on exit 0.
    out('no matches')
  } else {
    out(formatCommandManifest(manifest))
  }
}

// Runs an MCP stdio server exposing read/symbol/section/outline/skeleton/semantic as tools. The returned promise only resolves once the underlying Server reports its connection closed (via the Protocol-level `onclose` hook, set after `connect()` so it's not clobbered by the wiring `connect()` itself does to the transport's own `onclose`) -- resolving early here would let `run()`'s caller (main.ts) return while the process still has useful work queued on stdin.
async function cmdMcpServe(): Promise<void> {
  let createMcpServer: typeof CreateMcpServerFn
  let StdioServerTransport: typeof StdioServerTransportClass
  try {
    ;({ createMcpServer } = await import('./mcp_server.js'))
    ;({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'))
  } catch (err) {
    process.stderr.write(
      `token-goat: mcp-server unavailable (install @modelcontextprotocol/sdk to use this feature): ${String(err)}\n`,
    )
    process.exitCode = 1
    return
  }
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve
  })
}

async function cmdHook(event: string, opts: { harness?: string }): Promise<void> {
  // A bridge that writes a bare command string into its host tool's config (no in-process
  // env-setting hook like pi.ts/copilot_cli.ts have) can self-identify via this flag instead —
  // same purpose as TOKEN_GOAT_HARNESS_OVERRIDE, just passed as an argv flag since there's no
  // JS relay script in the middle to set process.env directly. detectHarness() itself already
  // validates the value against KNOWN_HARNESS_NAMES and ignores anything unrecognized, so no
  // extra validation is needed here.
  if (typeof opts.harness === 'string' && opts.harness.length > 0) {
    process.env[ENV_KEYS.HARNESS_OVERRIDE] = opts.harness
  }
  // relay handles its own stdin read / stdout write and never throws on a malformed/unknown event — it emits `{}` and returns.
  await relay(event)
}

async function cmdInstall(opts: {
  project?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  pi?: boolean
  opencode?: boolean
  hermes?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  vscode?: boolean
  local?: boolean
}): Promise<void> {
  const scope: HookScope = opts.project === true ? 'project' : 'user'
  const result = installHooks(scope)
  // Report alreadyInstalled like every other harness branch below does. installHooks has always computed it; the base Claude Code path was the one caller that discarded it and claimed a fresh install on every run.
  out(
    result.alreadyInstalled
      ? `token-goat hooks (${scope}) already up to date → ${result.settingsPath}`
      : `Installed token-goat hooks (${scope}) → ${result.settingsPath}`,
  )

  // Base install (unconditional, not gated behind any --<harness> flag): the CLAUDE.md routing block and the token-goat skill, per README's "What gets installed?" table.
  const claudeMdResult = installClaudeMd()
  out(
    claudeMdResult.alreadyInstalled
      ? `CLAUDE.md block already up to date → ${claudeMdResult.path}`
      : `Updated CLAUDE.md → ${claudeMdResult.path}`,
  )

  // A block relocated into some other markdown file is invisible to install/uninstall, so the
  // write above just created a second copy. Say so rather than leaving a silent duplicate.
  for (const stray of findStrayClaudeMdBlocks()) {
    out(`WARNING: stray token-goat block in ${stray} — not managed by install/uninstall; delete it to avoid duplicate, stale guidance.`)
  }

  const skillResult = installSkill()
  out(
    skillResult.alreadyInstalled
      ? `token-goat skill already up to date → ${skillResult.path}`
      : `Installed token-goat skill → ${skillResult.path}`,
  )

  if (opts.codex === true) {
    const codexResult = installCodex()
    if (codexResult.alreadyInstalled) {
      out(`Codex CLI integration already installed → ${codexResult.configPath}`)
    } else {
      out(`Installed token-goat Codex CLI integration → ${codexResult.configPath}, ${codexResult.agentsPath}`)
    }
  }

  // --gemini is additive, exactly like --codex above.
  if (opts.gemini === true) {
    const geminiResult = installGemini()
    if (geminiResult.alreadyInstalled) {
      out(`Gemini CLI integration already installed → ${geminiResult.settingsPath}`)
    } else {
      out(`Installed token-goat Gemini CLI integration → ${geminiResult.settingsPath}`)
    }
  }

  // --qwen is additive, exactly like --gemini above.
  if (opts.qwen === true) {
    const qwenResult = installQwen()
    if (qwenResult.alreadyInstalled) {
      out(`Qwen Code integration already installed → ${qwenResult.settingsPath}`)
    } else {
      out(`Installed token-goat Qwen Code integration → ${qwenResult.settingsPath}`)
    }
  }

  // --pi is additive on both install and uninstall, exactly like --codex. --local only has meaning combined with --pi; passed alone it is silently ignored (no dedicated validation), matching this CLI's existing convention of independently-parsed boolean flags (e.g. -p/--project has no combination guard with anything else either).
  if (opts.pi === true) {
    const piResult = installPi({ local: opts.local === true })
    if (piResult.alreadyInstalled) {
      out(`pi extension already installed → ${piResult.extensionPath}`)
    } else {
      out(`Installed token-goat pi extension → ${piResult.extensionPath}`)
    }
  }

  // --openclaw is additive, exactly like --codex above.
  if (opts.openclaw === true) {
    const openclawResult = installOpenclaw()
    if (openclawResult.alreadyInstalled) {
      out(`OpenClaw integration already installed → ${openclawResult.configPath}`)
    } else {
      out(`Installed token-goat OpenClaw integration → ${openclawResult.configPath}, ${openclawResult.pluginPath}`)
    }
  }

  // --copilot is additive, exactly like --codex above.
  if (opts.copilot === true) {
    const copilotResult = installCopilotCli({ local: opts.local === true })
    if (copilotResult.alreadyInstalled) {
      out(`Copilot CLI integration already installed → ${copilotResult.configPath}`)
    } else {
      out(`Installed token-goat Copilot CLI integration → ${copilotResult.configPath}, ${copilotResult.scriptPath}, ${copilotResult.instructionsPath}`)
    }
  }

  // --opencode is additive, exactly like --pi above.
  if (opts.opencode === true) {
    const opencodeResult = installOpencode()
    if (opencodeResult.alreadyInstalled) {
      out(`opencode plugin already installed → ${opencodeResult.pluginPath}`)
    } else {
      out(`Installed token-goat opencode plugin → ${opencodeResult.pluginPath}`)
    }
  }

  // --grok is additive, exactly like --codex above.
  if (opts.grok === true) {
    const grokResult = installGrok()
    if (grokResult.alreadyInstalled) {
      out(`Grok CLI integration already installed → ${grokResult.configPath}`)
    } else {
      out(`Installed token-goat Grok CLI integration → ${grokResult.configPath}, ${grokResult.hookScriptPath}`)
    }
  }

  if (opts.vscode === true) {
    const vscodeResult = installVscode()
    out(
      vscodeResult.alreadyInstalled
        ? `VS Code MCP integration already installed → ${vscodeResult.mcpPath}`
        : `Installed token-goat VS Code MCP integration → ${vscodeResult.mcpPath}, ${vscodeResult.instructionsPath}`,
    )
  }

  // --hermes writes nothing new: Hermes delegates to `claude -p '<task>'`, which loads the same Claude Code settings.json installHooks() just wrote. There is no separate Hermes config file to patch, so this is a verification-only flag -- run the same isInstalled() check `doctor` uses and report whether the hooks Hermes will inherit are really there.
  if (opts.hermes === true) {
    out(
      isInstalled(scope)
        ? `Hermes integration verified: token-goat hooks are present in ${result.settingsPath}.`
        : `Hermes integration NOT verified: token-goat hooks are missing from ${result.settingsPath}.`,
    )
  }

  // Pre-generate compacts for all installed skills.
  try {
    const skillDir = path.join(homedir(), '.claude', 'skills')
    if (fs.existsSync(skillDir)) {
      const entries = fs.readdirSync(skillDir, { withFileTypes: true })
      const skillNames: string[] = []
      const sessionId = getSessionId()

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(skillDir, entry.name, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const body = fs.readFileSync(skillFile, 'utf-8')
          const compact = extractCompactFromMarker(body)
          if (compact === null) continue
          const sourceSha = contentHash(body)
          await storeCompact(sessionId, entry.name, compact, sourceSha)
          skillNames.push(entry.name)
        }
      }

      if (skillNames.length > 0) {
        // Write pregen.json with list of pre-generated skills.
        const dir = skillOutputsDir()
        await fs.promises.mkdir(dir, { recursive: true })
        const pregenPath = path.join(dir, 'pregen.json')
        const pregenData = { ts: Date.now(), names: skillNames }
        await fs.promises.writeFile(pregenPath, JSON.stringify(pregenData, null, 2))
        out(`Pre-generated ${skillNames.length} skill compacts.`)
      }
    }
  } catch {
    // fail-soft: install succeeded even if pre-gen fails
  }
}

function cmdUninstall(opts: {
  project?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  pi?: boolean
  opencode?: boolean
  hermes?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  vscode?: boolean
  local?: boolean
}): void {
  const scope: HookScope = opts.project === true ? 'project' : 'user'
  const removed = uninstallHooks(scope)
  out(removed ? `Removed token-goat hooks (${scope}).` : `No token-goat hooks to remove (${scope}).`)

  // Base uninstall (unconditional, matching the base install above): strip
  // the CLAUDE.md block and remove the skill directory.
  const claudeMdRemoved = uninstallClaudeMd()
  out(claudeMdRemoved ? 'Removed token-goat block from CLAUDE.md.' : 'No token-goat block in CLAUDE.md to remove.')

  // Strays live in files token-goat doesn't own, so uninstall reports them rather than
  // deleting: silently editing a user's own markdown is worse than leaving a line behind.
  for (const stray of findStrayClaudeMdBlocks()) {
    out(`NOTE: a token-goat block remains in ${stray} — outside CLAUDE.md, so it was not removed. Delete it manually if unwanted.`)
  }

  const skillRemoved = uninstallSkill()
  out(skillRemoved ? 'Removed token-goat skill.' : 'No token-goat skill to remove.')

  // --codex/--gemini/--pi/--openclaw/--copilot/--opencode are each additive on both install
  // and uninstall (README: "Add --codex ... to also strip those integrations"), so they run
  // on top of the base uninstall above rather than replacing it. --local (pi, copilot) narrows
  // removal to the project-local scope only; without it, the uninstaller cleans up wherever
  // the integration actually is (global and/or local) instead of requiring the caller to
  // remember which scope it was originally installed with.
  const removals: Array<{ flag: boolean; run: () => boolean; label: string }> = [
    { flag: opts.codex === true, run: uninstallCodex, label: 'Codex CLI integration' },
    { flag: opts.gemini === true, run: uninstallGemini, label: 'Gemini CLI integration' },
    { flag: opts.qwen === true, run: uninstallQwen, label: 'Qwen Code integration' },
    { flag: opts.pi === true, run: () => (opts.local === true ? uninstallPi({ local: true }) : uninstallPi()), label: 'pi extension' },
    { flag: opts.openclaw === true, run: uninstallOpenclaw, label: 'OpenClaw integration' },
    { flag: opts.copilot === true, run: () => (opts.local === true ? uninstallCopilotCli({ local: true }) : uninstallCopilotCli()), label: 'Copilot CLI integration' },
    { flag: opts.opencode === true, run: uninstallOpencode, label: 'opencode plugin' },
    { flag: opts.grok === true, run: uninstallGrok, label: 'Grok CLI integration' },
    { flag: opts.vscode === true, run: uninstallVscode, label: 'VS Code MCP integration' },
  ]
  for (const removal of removals) {
    if (!removal.flag) continue
    const removed = removal.run()
    out(removed ? `Removed token-goat ${removal.label}.` : `No token-goat ${removal.label} to remove.`)
  }

  // --hermes removes no files: Hermes shares the Claude Code hook entries uninstallHooks() above already stripped, so this only exists for CLI symmetry with the other harness flags (README's uninstall table lists --hermes alongside the rest).
  if (opts.hermes === true) {
    out('No separate Hermes integration to remove (it shares the Claude Code hook entries).')
  }
}

function cmdWorkerStart(): void {
  if (isWorkerRunning()) {
    out('Worker already running.')
    return
  }
  // startDetachedWorker's own atomic pid-file claim (see worker.ts::claimWorkerPidFile) is the real guard against the TOCTOU race above: two near-simultaneous `worker start` invocations can both pass the isWorkerRunning() check above, but only one of them can win the exclusive pid-file create that follows, so the loser reports this cleanly instead of orphaning a second, unstoppable daemon.
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

function cmdStats(opts: { json?: boolean; windowDays?: string; homeDir?: string; full?: boolean; short?: boolean } = {}): void {
  const windowDays = opts.windowDays !== undefined ? requireNonNegativeInt('--window-days', opts.windowDays) : 30
  const statsOpts: Parameters<typeof runStats>[0] = {
    json: opts.json === true,
    windowDays,
    full: opts.full === true,
    short: opts.short === true,
  }
  if (opts.homeDir !== undefined) {
    statsOpts.homeDir = opts.homeDir
  }
  runStats(statsOpts)
}

async function cmdDoctor(opts: { context?: boolean; json?: boolean }): Promise<void> {
  const doctorOpts: { dataDir?: string; configPath?: string; context?: boolean; rootDir?: string } = {}
  if (opts.context === true) {
    doctorOpts.context = true
  }
  // Scope the Symbols check to the invoking project so an unrelated project sharing the same
  // global.db can't mask this project's own parser being broken (see checkSymbolCount's doc
  // comment). No project root found (bare directory, no git/package.json) falls back to the
  // prior unscoped whole-database behavior.
  const project = findProject(process.cwd())
  if (project !== null) {
    doctorOpts.rootDir = project.root
  }
  if (opts.json === true) {
    // --json bypasses printDoctorResults' prose entirely (no `[WARN]`-prefixed lines) and emits
    // the same DoctorResult[] runDoctor() already computes, one entry per check with its
    // ok/warn/fail status -- matching cmdCommands'/cmdBridgesStatus' plain JSON.stringify
    // convention (no envelope) rather than inventing a new shape.
    const results = runDoctor(doctorOpts.dataDir, doctorOpts.configPath, doctorOpts.rootDir)
    out(JSON.stringify(results))
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

function cmdContextStats(opts: { project?: string; json?: boolean; fix?: boolean; yes?: boolean } = {}): Promise<void> {
  return runContextStats(opts)
}

function cmdBootstrapAudit(opts: {
  project?: string
  home?: string
  followLinks?: boolean
  json?: boolean
  top?: string
  warnTokens?: string
  failTokens?: string
  warnBytes?: string
  failBytes?: string
} = {}): Promise<void> {
  return runBootstrapAudit({
    ...(opts.project === undefined ? {} : { project: opts.project }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.followLinks === undefined ? {} : { followLinks: opts.followLinks }),
    ...(opts.json === undefined ? {} : { json: opts.json }),
    ...(opts.top === undefined ? {} : { top: Number(opts.top) }),
    ...(opts.warnTokens === undefined ? {} : { warnTokens: Number(opts.warnTokens) }),
    ...(opts.failTokens === undefined ? {} : { failTokens: Number(opts.failTokens) }),
    ...(opts.warnBytes === undefined ? {} : { warnBytes: Number(opts.warnBytes) }),
    ...(opts.failBytes === undefined ? {} : { failBytes: Number(opts.failBytes) }),
  })
}

function cmdMemory(opts: { project?: string; analyze?: boolean; fix?: boolean; yes?: boolean } = {}): Promise<void> {
  return runMemoryCommand(opts)
}

function cmdWaste(opts: { project?: string; transcript?: string; json?: boolean; top?: string } = {}): Promise<void> {
  return runWasteCommand({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.transcript !== undefined ? { transcript: opts.transcript } : {}),
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
  })
}

async function cmdSessionOutline(sessionIdOrPath: string | undefined, opts: { project?: string; json?: boolean } = {}): Promise<void> {
  const transcriptPath = resolveSessionTranscript(sessionIdOrPath, opts.project !== undefined ? { project: opts.project } : {})
  if (transcriptPath === null) {
    throw new CliError(
      sessionIdOrPath !== undefined
        ? `no session transcript found for '${sessionIdOrPath}'`
        : 'no session transcript found for the current project; pass a session id or path explicitly',
    )
  }
  const turns = await buildSessionOutline(transcriptPath)
  const text = opts.json === true ? JSON.stringify({ transcriptPath, turns }) : `Transcript: ${transcriptPath}\n${formatSessionOutline(turns)}`
  out(text)
  // stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry carries a `session_outline`/`session-outline`
  // entry, but nothing ever called recordStat for it -- the dashboard bucket was permanently zero
  // regardless of real usage, the same class of gap already fixed for map_lookup/changed_lookup/
  // csv_query/brief_view (see project_runchanged_missing_stat memory). This command's own
  // description advertises itself as "instead of a raw Read", so the full transcript's on-disk
  // size is the "full source" side of the bytes-saved calculation, mirroring recordReadStat's
  // convention in read_commands.ts.
  const fullSourceBytes = sessionTranscriptSize(transcriptPath)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(text, 'utf8'))
  recordStat('session_outline', bytesSaved, Math.round(bytesSaved / 4))
}

/** Best-effort on-disk size of a session transcript file; 0 if it can't be stat'd (never blocks stat recording). */
function sessionTranscriptSize(transcriptPath: string): number {
  try {
    return fs.statSync(transcriptPath).size
  } catch {
    return 0
  }
}

async function cmdSessionSlice(
  sessionIdOrPath: string | undefined,
  opts: { project?: string; range: string; json?: boolean },
): Promise<void> {
  const transcriptPath = resolveSessionTranscript(sessionIdOrPath, opts.project !== undefined ? { project: opts.project } : {})
  if (transcriptPath === null) {
    throw new CliError(
      sessionIdOrPath !== undefined
        ? `no session transcript found for '${sessionIdOrPath}'`
        : 'no session transcript found for the current project; pass a session id or path explicitly',
    )
  }
  const { start, end } = parseTurnRange(opts.range)
  const turns = await sliceSessionTurns(transcriptPath, start, end)
  const text = opts.json === true ? JSON.stringify({ transcriptPath, turns }) : formatSessionSlice(turns)
  out(text)
  // Same registry/producer desync as cmdSessionOutline above -- see the comment there.
  const fullSourceBytes = sessionTranscriptSize(transcriptPath)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(text, 'utf8'))
  recordStat('session_slice', bytesSaved, Math.round(bytesSaved / 4))
}

function cmdMcpAudit(opts: { project?: string; json?: boolean } = {}): Promise<void> {
  return runMcpAuditCommand({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

function cmdRecall(query: string | undefined, opts: { type?: string; limit?: string; json?: boolean } = {}): void {
  let type: RecallCacheType | undefined
  if (opts.type !== undefined) {
    if (!isRecallCacheType(opts.type)) {
      throw new CliError(`--type must be one of: bash, web, mcp (got: ${opts.type})`)
    }
    type = opts.type
  }
  runRecallCommand(query, {
    ...(type !== undefined ? { type } : {}),
    ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

function cmdStatusline(opts: { json?: boolean } = {}): Promise<void> {
  return runStatuslineCommand({ ...(opts.json === true ? { json: true } : {}) })
}

function cmdHintStats(opts: { json?: boolean; reset?: boolean; markEffective?: string; markIneffective?: string } = {}): void {
  if (opts.markEffective !== undefined && !isHintCategory(opts.markEffective)) {
    throw new CliError(`--mark-effective must be one of: bash_redirect, bash_recall, read_reread_dedup, read_structural_nav, edit_reread_suggest (got: ${opts.markEffective})`)
  }
  if (opts.markIneffective !== undefined && !isHintCategory(opts.markIneffective)) {
    throw new CliError(`--mark-ineffective must be one of: bash_redirect, bash_recall, read_reread_dedup, read_structural_nav, edit_reread_suggest (got: ${opts.markIneffective})`)
  }
  runHintStatsCommand({
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.reset === true ? { reset: true } : {}),
    ...(opts.markEffective !== undefined && isHintCategory(opts.markEffective) ? { markEffective: opts.markEffective } : {}),
    ...(opts.markIneffective !== undefined && isHintCategory(opts.markIneffective) ? { markIneffective: opts.markIneffective } : {}),
  })
}

function _applyFiltersAndPrint(
  content: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; full?: boolean },
): string {
  if (opts.section !== undefined) {
    const sectionResult = extractSection(content, opts.section)
    if (sectionResult === null) {
      throw new CliError(`section '${opts.section}' not found`)
    }
    content = sectionResult.content
  }

  if (opts.grep !== undefined) {
    let pattern = opts.grep
    // Normalize pattern to handle -E or --extended-regexp prefix
    if (pattern.startsWith('-E ') || pattern.startsWith('--extended-regexp ')) {
      pattern = pattern.replace(/^(?:-E\s+|--extended-regexp\s+)/, '')
    }
    try {
      const re = new RegExp(pattern)
      content = content
        .split(/\r?\n/)
        .filter((line) => re.test(line))
        .join('\n')
    } catch {
      content = content
        .split(/\r?\n/)
        .filter((line) => line.includes(pattern))
        .join('\n')
    }
  }

  if (opts.grep !== undefined && opts.maxMatches !== undefined) {
    const cap = requireNonNegativeInt('--max-matches', opts.maxMatches)
    const matched = content === '' ? [] : content.split(/\r?\n/)
    if (matched.length > cap) {
      content = [...matched.slice(0, cap), '[token-goat: showing first ' + cap + ' of ' + matched.length + ' matching lines; raise --max-matches for more]'].join('\n')
    }
  }

  const lines = content.split(/\r?\n/)
  // --full is the only way to get the stored blob back verbatim. The blob store itself is lossless, but every render path below elides the middle past head+tail, so without this flag an elision marker pointing a reader at `mcp-output <id>` promises a full report the CLI cannot actually produce -- which is exactly what hooks_agent_spawn.ts's envelope compaction relies on. Deliberately bypasses only the elision, not --section/--grep/--max-matches above: those are explicit narrowing the caller asked for.
  if (opts.full === true) {
    const printedFull = lines.join('\n')
    out(printedFull)
    return printedFull
  }
  const headN = opts.head !== undefined ? requireNonNegativeInt('--head', opts.head) : 30
  const tailN = opts.tail !== undefined ? requireNonNegativeInt('--tail', opts.tail) : 80

  const applyElision = (lines: string[], headN: number, tailN: number): string[] => lines.length > headN + tailN + 1 ? [...lines.slice(0, headN), '...(elided)...', ...lines.slice(lines.length - tailN)] : lines

  let result = lines
  if (opts.head === undefined && opts.tail === undefined) {
    // Covers both "no filters at all" and "--grep alone" -- the latter is the single most common recall pattern this CLI's own hint text pushes users toward (bash-output/web-output --grep with no --head/--tail), and left unbounded here it could return an arbitrarily large number of matching lines with no truncation at all.
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined && opts.tail !== undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined) {
    result = lines.slice(0, headN)
  } else if (opts.tail !== undefined) {
    result = lines.slice(Math.max(0, lines.length - tailN))
  }

  const printed = result.join('\n')
  out(printed)
  return printed
}

/** Best-effort on-disk size of a file; 0 if it can't be stat'd (never blocks stat recording). */
function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function cmdBashOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; file?: string; maxMatches?: string; transcript?: boolean },
): void {
  if (opts.file !== undefined) {
    if (opts.file.includes('\0')) {
      throw new CliError('--file path contains a null byte')
    }
    if (!isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(opts.file) && process.stdin.isTTY) {
      throw new CliError('--file /dev/stdin requires piped input; redirect a file instead')
    }
    let content: string
    try {
      const st = fs.statSync(opts.file)
      if (st.isFIFO() || st.isSocket()) {
        throw new CliError(`--file '${opts.file}' is a special file (FIFO or socket) — only regular files are supported`)
      }
      content = fs.readFileSync(opts.file, 'utf-8')
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`cannot read file: ${opts.file}`)
    }
    _applyFiltersAndPrint(opts.transcript === true ? extractTranscriptText(content) : content, opts)
    return
  }

  if (id === undefined) {
    throw new CliError('provide an <id> or --file <path>')
  }

  const entry = getBashOutput(id)
  if (entry === null) {
    throw new CliError(`no cached bash output for id: ${id}. If this id is from a background task, recall its output file directly with: token-goat bash-output --file <path-to-output-file>`)
  }

  _applyFiltersAndPrint(entry.output, opts)
}

function cmdWebOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string },
): void {
  if (id === undefined) {
    throw new CliError('provide a web cache <id>')
  }
  const content = getWebOutput(id)
  if (content === null) {
    throw new CliError(`no cached web output for id: ${id}. The cache may have expired; re-run the WebFetch to repopulate it.`)
  }
  _applyFiltersAndPrint(content, opts)
}

// MCP results are stored in the same bash-output blob store as `mcp_<hash>`-prefixed ids (see mcp_cache.ts's storeMcpOutput), so `token-goat bash-output <id>` already resolves one — this command exists for discoverability (the id printed in a `[token-goat: compressed, full via mcp-output <id>]` label points here) and to fail clearly on a non-MCP id rather than silently serving whatever bash-output happens to be stored under it.
function cmdMcpOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string },
): void {
  if (id === undefined) {
    throw new CliError('provide an mcp-output <id>')
  }
  if (!id.startsWith('mcp_')) {
    throw new CliError(`not an mcp-output id: ${id} (expected an id starting with 'mcp_')`)
  }
  const entry = getBashOutput(id)
  if (entry === null) {
    throw new CliError(`no cached mcp output for id: ${id}. The cache may have expired; re-run the MCP tool call to repopulate it.`)
  }
  _applyFiltersAndPrint(entry.output, opts)
}

async function cmdPdfExtract(
  file: string,
  opts: { pages?: string; head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; layout?: boolean },
) {
  const text = await runPdfExtractText(file, opts.pages, opts.layout === true)
  const printed = _applyFiltersAndPrint(text, opts)
  // stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `pdf-extract`/`pdf_extract` entry
  // and nothing ever called recordStat for this command -- the dashboard bucket was permanently
  // zero regardless of real usage, the same class of gap already fixed for
  // map_lookup/changed_lookup/csv_query/gdrive_sections (see project_runchanged_missing_stat
  // memory). "Full source" is the on-disk PDF size; "emitted" is the text actually printed
  // after --pages/--head/--tail/--grep filtering, mirroring recordReadStat's convention.
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(printed, 'utf8'))
  recordStat('pdf_extract', bytesSaved, Math.round(bytesSaved / 4))
}

async function cmdPdfOutline(file: string, opts: { json?: boolean }) {
  const entries = await runPdfOutline(file)
  if (entries.length === 0) {
    if (opts.json === true) {
      out(JSON.stringify([], null, 2))
    } else {
      out('no bookmarks in this PDF; try pdf-extract')
    }
    return
  }
  const text =
    opts.json === true
      ? JSON.stringify(entries, null, 2)
      : entries.map((e) => `${'  '.repeat(e.level)}${e.title}${e.page !== null ? `  (p.${e.page})` : ''}`).join('\n')
  out(text)
  // Same registry/producer desync as cmdPdfExtract above -- see the comment there.
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(text, 'utf8'))
  recordStat('pdf_outline', bytesSaved, Math.round(bytesSaved / 4))
}

async function cmdPdfMeta(file: string, opts: { json?: boolean } = {}) {
  const meta = await runPdfMeta(file)
  const lines = [
    `Pages: ${meta.pageCount}`,
    `Title: ${meta.title ?? '(none)'}`,
    `Author: ${meta.author ?? '(none)'}`,
    `Text layer: ${meta.hasTextLayer ? 'yes' : 'no (likely scanned/image-only; pdf-extract will return little or no text)'}`,
  ]
  // The text form cannot be parsed back reliably: `Title: (none)` is indistinguishable from a PDF whose title is literally "(none)", a title or author containing a newline or a colon breaks the line-oriented `key: value` shape outright, and hasTextLayer -- the one field a caller acts on, since it decides whether pdf-extract is worth running -- is buried in a prose sentence that has to be substring-matched. JSON carries the nulls and the boolean as themselves.
  const text = opts.json === true
    ? JSON.stringify({ pageCount: meta.pageCount, title: meta.title, author: meta.author, hasTextLayer: meta.hasTextLayer }, null, 2)
    : lines.join('\n')
  out(text)
  // Same registry/producer desync as cmdPdfExtract above -- see the comment there.
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(text, 'utf8'))
  recordStat('pdf_meta', bytesSaved, Math.round(bytesSaved / 4))
}

function cmdVideoChapters(file: string) {
  const { chapters, subtitleStreams } = extractVideoChapters(file)
  const lines: string[] = []
  if (chapters.length === 0) {
    lines.push('(no chapter markers found)')
  } else {
    for (const c of chapters) {
      const title = c.title ?? `Chapter ${c.index}`
      lines.push(`${formatVideoTimestamp(c.startSeconds)} - ${formatVideoTimestamp(c.endSeconds)}  ${title}`)
    }
  }
  if (subtitleStreams.length > 0) {
    lines.push('')
    lines.push('Subtitle/caption streams:')
    for (const s of subtitleStreams) {
      const parts = [s.codec ?? 'unknown codec', s.language ?? 'unknown language', s.title ?? null].filter((p) => p !== null)
      lines.push(`  stream #${s.index}: ${parts.join(', ')}`)
    }
    lines.push('(extract a subtitle stream to .vtt/.srt with ffmpeg, then use transcript/transcript-outline on it)')
  }
  const text = lines.join('\n')
  out(text)
  // Same registry/producer desync as cmdPdfMeta/recordXlsxStat/recordDocStat above -- video-chapters
  // never called recordStat, so its dashboard bucket in `token-goat stats --full` stayed
  // permanently zero regardless of real usage (see project_runchanged_missing_stat memory).
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(text, 'utf8'))
  recordStat('video_chapters', bytesSaved, Math.round(bytesSaved / 4))
}

function formatVideoTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

function cmdSharepointResolve(url: string) {
  const parsed = parseShareUrl(url)
  const result = resolveLocalPath(parsed)
  if (result.resolvedPath !== null) {
    out(result.resolvedPath)
    return
  }
  const lines = [
    `could not resolve a local synced copy for: ${url}`,
    `tried:`,
    ...result.triedPaths.map((p) => `  ${p}`),
    result.triedPaths.length === 0
      ? '  (no OneDrive sync root found -- OneDrive may not be installed/signed in on this machine)'
      : '',
  ].filter((l) => l !== '')
  out(lines.join('\n'))
}

// stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `xlsx-*`/`xlsx_*` entries and nothing
// ever called recordStat for this family -- the dashboard buckets were permanently zero
// regardless of real usage, the same class of gap already fixed for
// map_lookup/changed_lookup/csv_query/gdrive_sections (see project_runchanged_missing_stat
// memory). "Full source" is the on-disk workbook size, mirroring recordReadStat's convention.
function recordXlsxStat(kind: string, file: string, emitted: string): void {
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(emitted, 'utf8'))
  recordStat(kind, bytesSaved, Math.round(bytesSaved / 4))
}

async function cmdXlsxSheets(file: string, opts: { json?: boolean } = {}) {
  const sheets = await xlsxListSheets(file)
  // Three sibling commands (xlsx-head, xlsx-range, xlsx-query) take a --sheet whose help text says "see xlsx-sheets", so this output exists to be fed straight back -- but the sheet name had to be copied out of a padded prose line that also carries the range and the dimensions. --json hands over the same {name, ref, rows, cols} the extractor already returns.
  const text = opts.json === true ? JSON.stringify(sheets.map((s) => ({ name: s.name, ref: s.ref, rows: s.rows, cols: s.cols })), null, 2) : sheets.map((s) => `${s.name}  ${s.ref}  (${s.rows} rows x ${s.cols} cols)`).join('\n')
  out(text)
  recordXlsxStat('xlsx_sheets', file, text)
}

async function cmdXlsxHead(file: string, opts: { sheet: string; rows?: string }) {
  const rows = opts.rows !== undefined ? requireNonNegativeInt('--rows', opts.rows) : 20
  const text = await xlsxHeadSheet(file, opts.sheet, rows)
  out(text)
  recordXlsxStat('xlsx_head', file, text)
}

async function cmdXlsxRange(file: string, opts: { sheet: string; range: string; formulas?: boolean }) {
  const result = await xlsxRangeSheet(file, opts.sheet, opts.range, opts.formulas === true)
  const text = formatXlsxRange(result)
  out(text)
  recordXlsxStat('xlsx_range', file, text)
}

async function cmdXlsxQuery(file: string, opts: { sheet: string; columns?: string; where?: string[]; head?: string }) {
  const columns = opts.columns
    ? opts.columns
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined
  const wheres = parseWhereSpecs(opts.where)
  const result = await xlsxQuerySheet(file, opts.sheet, {
    ...(columns !== undefined ? { columns } : {}),
    ...(wheres !== undefined ? { wheres } : {}),
    ...(opts.head !== undefined ? { head: requireNonNegativeInt('--head', opts.head) } : {}),
  })
  const text = formatCsvTable(result)
  out(text)
  recordXlsxStat('xlsx_query', file, text)
}

// Same registry/producer desync as recordXlsxStat above, for the pptx-*/docx-*/transcript*
// families -- see that function's comment.
function recordDocStat(kind: string, file: string, emitted: string): void {
  const fullSourceBytes = fileSizeOrZero(file)
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(emitted, 'utf8'))
  recordStat(kind, bytesSaved, Math.round(bytesSaved / 4))
}

async function cmdPptxOutline(file: string, opts: { json?: boolean }) {
  const slides = await pptxOutline(file)
  const text =
    opts.json === true
      ? JSON.stringify(slides, null, 2)
      : slides
          .map((s) => `${s.slide}. ${s.title || '(untitled)'}  [${s.bodyChars} body chars${s.hasNotes ? ', has notes' : ''}]`)
          .join('\n')
  out(text)
  recordDocStat('pptx_outline', file, text)
}

async function cmdPptxSlide(file: string, opts: { slide: string; notes?: boolean }) {
  const n = requireNonNegativeInt('--slide', opts.slide)
  const text = await pptxSlideText(file, n, opts.notes === true)
  out(text)
  recordDocStat('pptx_slide', file, text)
}

async function cmdPptxNotes(file: string, opts: { slide?: string }) {
  const n = opts.slide !== undefined ? requireNonNegativeInt('--slide', opts.slide) : undefined
  const text = await pptxNotesText(file, n)
  const printed = text.length > 0 ? text : 'no speaker notes found'
  out(printed)
  recordDocStat('pptx_notes', file, printed)
}

async function cmdPptxText(file: string, opts: { grep: string }) {
  const matches = await pptxTextGrep(file, opts.grep)
  if (matches.length === 0) {
    out('no matches')
    return
  }
  const text = matches.map((m) => `Slide ${m.slide}: ...${m.snippet}...`).join('\n')
  out(text)
  recordDocStat('pptx_text', file, text)
}

async function cmdDocxOutline(file: string, opts: { json?: boolean }) {
  const headings = await docxOutline(file)
  if (headings.length === 0) {
    if (opts.json === true) {
      out(JSON.stringify([], null, 2))
    } else {
      out('no headings found (try docx-text for full body text)')
    }
    return
  }
  const text =
    opts.json === true
      ? JSON.stringify(headings, null, 2)
      : headings.map((h) => `${'  '.repeat(h.level - 1)}${h.text}`).join('\n')
  out(text)
  recordDocStat('docx_outline', file, text)
}

async function cmdDocxText(
  file: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string },
) {
  const text = await docxText(file)
  const printed = _applyFiltersAndPrint(text, opts)
  recordDocStat('docx_text', file, printed)
}

function cmdTranscriptOutline(file: string, opts: { json?: boolean }) {
  const cues = readTranscript(file)
  if (cues.length === 0) {
    if (opts.json === true) {
      out(JSON.stringify({ durationSeconds: 0, speakers: [], markers: [] }, null, 2))
    } else {
      out('no cues found (not a valid .vtt/.srt file?)')
    }
    return
  }
  const outline = buildTranscriptOutline(cues)
  let text: string
  if (opts.json === true) {
    text = JSON.stringify(outline, null, 2)
  } else {
    const lines = [`Duration: ${formatTimestamp(outline.durationSeconds)}  (${cues.length} cues)`]
    if (outline.speakers.length > 0) {
      lines.push('', 'Speakers:', ...outline.speakers.map((s) => `  ${s.name}  (${s.cueCount} cues)`))
    }
    lines.push('', 'Markers:', ...outline.markers.map((m) => `  [${m.timestamp}] ${m.preview}`))
    text = lines.join('\n')
  }
  out(text)
  recordDocStat('transcript_outline', file, text)
}

function cmdTranscript(file: string, opts: { speaker?: string; from?: string; to?: string; grep?: string }) {
  const cues = readTranscript(file)
  const sliceOpts = parseSliceOptions(opts)
  const sliced = sliceTranscript(cues, sliceOpts)
  if (sliced.length === 0) {
    out('no cues match')
    return
  }
  const text = formatCues(sliced)
  out(text)
  recordDocStat('transcript', file, text)
}

function cmdCsvQuery(
  file: string,
  opts: { columns?: string; where?: string[]; head?: string; json?: boolean; delimiter?: string; header?: boolean },
) {
  const { header, ...rest } = opts
  process.exitCode = runCsvQuery({ file, ...rest, ...(header === false ? { noHeader: true } : {}) })
}

function cmdCsvProfile(file: string, opts: { delimiter?: string; header?: boolean }) {
  const { header, ...rest } = opts
  process.exitCode = runCsvProfile({ file, ...rest, ...(header === false ? { noHeader: true } : {}) })
}

function cmdJsonOutline(file: string, opts: { json?: boolean }) {
  process.exitCode = runJsonOutline({ file, ...opts })
}

function cmdJsonQuery(file: string, jsonPath: string, opts: { head?: string; json?: boolean }) {
  process.exitCode = runJsonQuery({ file, path: jsonPath, ...opts })
}

function cmdYamlOutline(file: string, opts: { json?: boolean }) {
  process.exitCode = runYamlOutline({ file, ...opts })
}

function cmdYamlQuery(file: string, yamlPath: string, opts: { head?: string; json?: boolean }) {
  process.exitCode = runYamlQuery({ file, path: yamlPath, ...opts })
}

function cmdOpenApiOutline(file: string, opts: { json?: boolean }) {
  process.exitCode = runOpenApiOutline({ file, ...opts })
}

function cmdOpenApiOp(file: string, operation: string, opts: { json?: boolean }) {
  process.exitCode = runOpenApiOp({ file, operation, ...opts })
}

function cmdZipList(file: string, opts: { json?: boolean }) {
  process.exitCode = runZipList({ file, ...opts })
}

function cmdZipRead(file: string, entry: string, opts: { json?: boolean }) {
  process.exitCode = runZipRead({ file, entry, ...opts })
}

function cmdPrSlice(pr: string, slice: string, opts: { repo?: string; json?: boolean }) {
  process.exitCode = runPrSlice({ pr, slice, ...opts })
}

function cmdSqliteSchema(file: string, opts: { json?: boolean }) {
  process.exitCode = runSqliteSchema({ file, ...opts })
}

function cmdSqliteQuery(file: string, sql: string, opts: { head?: string; json?: boolean }) {
  process.exitCode = runSqliteQuery({ file, sql, ...opts })
}

function cmdCoverageReportGaps(file: string, opts: { file?: string; json?: boolean }) {
  process.exitCode = runCoverageReportGaps({
    file,
    ...(opts.file !== undefined ? { fileFilter: opts.file } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

function cmdConflicts(targetPath: string | undefined, opts: { json?: boolean; summary?: boolean }) {
  process.exitCode = runConflicts({
    ...(targetPath !== undefined ? { path: targetPath } : {}),
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.summary === true ? { summary: true } : {}),
  })
}

async function cmdScreenshot(
  url: string,
  destPath: string,
  opts: { executablePath?: string; width?: string; height?: string; fullPage?: boolean },
) {
  out(await runScreenshot(url, destPath, opts))
}

/**
 * Adapter for read_commands `run*` handlers, which print their own output and
 * return an exit code (0 ok, 1 handled error) rather than throwing a CliError.
 * Maps the return code onto `process.exitCode`; an unexpected throw still maps
 * to a stderr line + exit 1, matching the `guard` contract.
 */
function runExit(fn: () => number): void {
  try {
    process.exitCode = fn()
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

/**
 * Same adapter as `runExit`, but for the `run*` handlers that return `{ text, code }`
 * instead of printing directly. Writes `text` to stdout on success (code 0) or stderr
 * otherwise, then maps `code` onto `process.exitCode` — preserving which stream each
 * handler's message goes to (these handlers only ever write to one stream per call).
 */
function runExitText(fn: () => { text: string; code: number }): void {
  try {
    const { text, code } = fn()
    ;(code === 0 ? out : err)(text)
    process.exitCode = code
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

/**
 * `outline`/`skeleton`/`exports`/`imports` each take a single file, but nothing stopped a caller
 * from passing several space-separated ones -- commander bound the first and dropped the rest in
 * silence, so an agent could believe it had seen files it never got. These two helpers surface the
 * dropped arguments and name the comma-separated form that actually reads them all. The extras are
 * still not read (that would change what the invocation returns); the note just makes the drop
 * visible. `noteExtraFileArgs` prepends to a `{text, code}` result, `emitExtraFileArgsNote` prints
 * ahead of an emit-directly command.
 */
function noteExtraFileArgs(
  command: string,
  first: string,
  extras: string[] | undefined,
  fn: () => { text: string; code: number },
): { text: string; code: number } {
  const result = fn()
  if (extras === undefined || extras.length === 0) return result
  return { text: `${extraFileArgsNote(command, first, extras)}\n${result.text}`, code: result.code }
}

function emitExtraFileArgsNote(command: string, first: string, extras: string[] | undefined): void {
  if (extras === undefined || extras.length === 0) return
  out(extraFileArgsNote(command, first, extras))
}

// Sets process.exitCode to the wrapped command's exit code (NOT via `guard`, which forces 0 on success — compress must propagate the real code so shell chaining still sees the original failure/success signal).
function cmdCompress(opts: {
  cmd: string
  filter?: string
  timeout?: string
  compress?: boolean
  profile?: string
  maxTokens?: string
}): void {
  try {
    if (opts.compress === false) {
      // Commander maps `--no-compress` to `opts.compress === false`.
      process.exitCode = bashRunner.runRaw(opts.cmd, parseTimeout(opts.timeout))
      return
    }
    const maxTokens = opts.maxTokens !== undefined ? requireNonNegativeInt('--max-tokens', opts.maxTokens) : 0
    process.exitCode = bashRunner.run(opts.cmd, {
      filterName: opts.filter,
      timeout: parseTimeout(opts.timeout),
      maxTokens,
      ...(opts.profile !== undefined ? { compressionProfile: opts.profile } : {}),
    })
  } catch (e) {
    err(`token-goat: ${extractErrorMessage(e)}`)
    process.exitCode = 1
  }
}

/** Resolve the --timeout flag (seconds): 0/absent/invalid → the built-in default. */
function parseTimeout(raw: string | undefined): number {
  const sec = raw ? parseInt(raw, 10) : 0
  return Number.isFinite(sec) && sec > 0 ? sec : bashRunner.DEFAULT_TIMEOUT_SECONDS
}

async function cmdSkillBody(name: string, opts: { compact?: boolean }): Promise<void> {
  const filePath = await getSkillFilePath(name)
  if (filePath === null) {
    throw new CliError(`skill '${name}' not found`)
  }

  const body = fs.readFileSync(filePath, 'utf-8')
  if (opts.compact === true) {
    out(extractCompactFromMarker(body) ?? body)
  } else {
    out(body)
  }
  // Increment hit count for skill recall tracking.
  await incrementSkillHit(name)
}

async function cmdSkillCompact(name: string | undefined, opts: { path?: string; all?: boolean }): Promise<void> {
  const sessionId = getSessionId()

  if (opts.all === true) {
    // Regenerate compacts for all skills, skipping fresh ones.
    const skills = await listSkills(sessionId)
    let regenerated = 0
    let skipped = 0
    for (const skill of skills) {
      const filePath = await getSkillFilePath(skill.name)
      if (!filePath) continue
      const body = fs.readFileSync(filePath, 'utf-8')
      const compact = extractCompactFromMarker(body)
      if (compact === null) continue
      const sourceSha = contentHash(body)
      if (skill.compactStale === false) {
        skipped++
      } else {
        await storeCompact(sessionId, skill.name, compact, sourceSha)
        regenerated++
      }
    }
    out(`Regenerated ${regenerated}, skipped ${skipped} (fresh), total ${skills.length}.`)
    return
  }

  let body: string
  let cacheName: string
  let sourcePath: string

  if (opts.path !== undefined && opts.path !== '') {
    if (!opts.path.trim()) {
      throw new CliError('--path cannot be empty')
    }
    // --path bypasses name resolution: read the body straight from the given file. The cache key is the explicit name when supplied, else the parent directory name (a skill lives in ~/.claude/skills/<name>/SKILL.md, so its parent dir is its name).
    if (!fs.existsSync(opts.path)) {
      throw new CliError(`skill file not found: ${opts.path}`)
    }
    try {
      body = fs.readFileSync(opts.path, 'utf-8')
    } catch (e) {
      // TOCTOU: the file can vanish between the existsSync check above and this read (race, or a symlink target disappearing). Re-throw as the same friendly CliError the existsSync guard exists to produce, rather than letting a raw ENOENT reach the user.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CliError(`skill file not found: ${opts.path}`)
      }
      throw new CliError(`failed to read skill file '${opts.path}': ${extractErrorMessage(e)}`)
    }
    cacheName = name ?? path.basename(path.dirname(path.resolve(opts.path)))
    sourcePath = path.resolve(opts.path)
  } else {
    if (name === undefined || !name.trim()) {
      throw new CliError('skill-compact requires a <name> or --path <file>')
    }
    const filePath = await getSkillFilePath(name)
    if (filePath === null) {
      throw new CliError(`skill '${name}' not found`)
    }
    body = fs.readFileSync(filePath, 'utf-8')
    cacheName = name
    sourcePath = filePath
  }

  // Persist the body (writes the meta that skill-list surfaces) and the compact slice, so a skill compacted straight from disk is both listable and recallable cross-session, exactly like one loaded via the Skill hook.
  await storeOutput(sessionId, cacheName, body, { sourcePath })
  const compact = extractCompactFromMarker(body)
  if (compact === null) {
    out(`Skill '${cacheName}' has no COMPACT_END marker — nothing to compact.`)
    return
  }
  const sourceSha = contentHash(body)
  await storeCompact(sessionId, cacheName, compact, sourceSha)
  out(`Cached compact for skill '${cacheName}'.`)
}

/** How many skills a `--session-id` filter hid, for use when the filtered view came back empty. Reporting a filtered-to-nothing view as "nothing cached" is the same mistake `refs --exclude-tests` made: it turns "you asked the wrong question" into "there is no answer", and the caller stops looking. Returns 0 when no filter was given, and only ever runs the extra directory scan once the filtered result is already empty, so the populated path pays nothing. */
async function countSkillsHiddenBySession(sessionId: string | undefined): Promise<number> {
  if (sessionId === undefined) return 0
  return (await listSkills()).length
}

async function cmdSkillList(opts: { json?: boolean; sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  if (opts.json === true) {
    const json = skills.map((s) => ({
      name: s.name,
      skill_name: s.name,
      body_bytes: s.bodyLen,
      compact_bytes: s.compactLen,
      has_marker: s.hasMarker,
      compact_stale: s.compactStale,
      hit_count: s.hitCount,
      age_ms: s.ageMs,
    }))
    out(JSON.stringify(json, null, 2))
  } else {
    // Human table format with columns: name, body, compact, marker, hit count, age, stale/fresh/no-compact.
    const lines = skills.map((s) => {
      const bodyKb = (s.bodyLen / 1024).toFixed(1)
      const compactKb = s.compactLen > 0 ? (s.compactLen / 1024).toFixed(1) : '-'
      const marker = s.hasMarker ? 'yes' : 'no'
      const staleStatus = s.compactLen === 0 ? '[no-compact]' : (s.compactStale === true ? '[stale]' : s.compactStale === false ? '[fresh]' : '[unknown]')
      const age = formatAge(s.ageMs)
      return `${s.name.padEnd(25)} ${bodyKb.padStart(6)}K  ${compactKb.padStart(6)}K  ${marker}  ${s.hitCount.toString().padStart(3)}  ${age.padStart(3)}  ${staleStatus}`
    })
    const header = `${'Name'.padEnd(25)} ${'Body'.padStart(6)}  ${'Compact'.padStart(6)}  Marker  Hits  Age  Status`
    // A bare header with no rows is indistinguishable from a rendering failure or a lookup against
    // the wrong cache root. Say the cache is empty, matching how `stats` reports its own empty
    // store, so the caller knows nothing is wrong and there is simply nothing cached.
    if (skills.length === 0) {
      const hidden = await countSkillsHiddenBySession(opts.sessionId)
      if (hidden > 0) {
        out(`No skills cached for session '${opts.sessionId}' (${hidden} cached under other sessions).`)
        return
      }
      out('No skills cached yet.')
      return
    }
    out([header, ...lines].join('\n'))
  }
}

async function cmdSkillSize(opts: { sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  let totalBody = 0
  let totalCompact = 0
  for (const skill of skills) {
    totalBody += skill.bodyLen
    totalCompact += skill.compactLen
  }
  const lines = [
    `# token-goat skill cache (${skills.length} skills)`,
    `Body:    ${totalBody} bytes`,
    `Compact: ${totalCompact} bytes`,
  ]
  // A zero-count report under a --session-id filter describes the cache as empty when it is merely filtered, so name what the filter hid. Without a filter this is always 0 and the report is byte-identical to before.
  const hiddenBySession = skills.length === 0 ? await countSkillsHiddenBySession(opts.sessionId) : 0
  if (hiddenBySession > 0) {
    lines.push(`(${hiddenBySession} cached under other sessions, hidden by --session-id ${opts.sessionId})`)
  }

  // Add per-skill table. Skip the heading entirely when there are no rows: a heading followed by nothing reads as truncated output rather than as an empty cache.
  if (skills.length > 0) {
    lines.push('')
    lines.push('## Per-skill breakdown')
  }
  for (const skill of skills) {
    const bodyKb = (skill.bodyLen / 1024).toFixed(1)
    const compactKb = skill.compactLen > 0 ? (skill.compactLen / 1024).toFixed(1) : '-'
    lines.push(`  ${skill.name.padEnd(25)} body: ${bodyKb.padStart(6)}K  compact: ${compactKb.padStart(6)}K`)
  }

  // Add recommendations for skills without compacts and over ~1500 tokens (6000 bytes).
  const noCompactLargeSkills = skills.filter((s) => s.compactLen === 0 && s.bodyLen > 6000)
  if (noCompactLargeSkills.length > 0) {
    lines.push('')
    lines.push('## Recommendations')
    for (const skill of noCompactLargeSkills) {
      const estimatedTokens = Math.floor(skill.bodyLen / 4)
      lines.push(`  ${skill.name}: add <!-- COMPACT_END --> marker (body ~${estimatedTokens}tok, no compact slice)`)
    }
  }

  out(lines.join('\n'))
}

async function cmdSkillHistory(opts: { json?: boolean }): Promise<void> {
  const metas = (await listOutputs())
    .map((m) => ({ outputId: m.outputId, skillName: m.skillName, bytes: m.bodyBytes, truncated: m.truncated, ts: m.ts }))
    .sort((a, b) => b.ts - a.ts)

  if (opts.json === true) {
    const json = metas.map((m) => ({
      output_id: m.outputId,
      skill_name: m.skillName,
      bytes: m.bytes,
      truncated: m.truncated,
      timestamp: m.ts,
    }))
    out(JSON.stringify(json, null, 2))
  } else {
    const lines = metas.map((m) => {
      const timeStr = formatLocalTimestamp(new Date(m.ts))
      const truncMarker = m.truncated ? ' [truncated]' : ''
      return `${m.outputId.padEnd(40)} ${m.skillName.padEnd(25)} ${m.bytes.toString().padStart(8)} bytes  ${timeStr}${truncMarker}`
    })
    const header = `${'Output ID'.padEnd(40)} ${'Skill'.padEnd(25)} ${'Bytes'.padStart(8)}  Timestamp`
    // A bare header with no rows is indistinguishable from a rendering failure or a lookup against the wrong cache root, the same gap `skill-list` closed above and `skill-diff` closed with its own no-versions message. Say the store is empty.
    if (metas.length === 0) {
      out('No cached skill versions yet.')
      return
    }
    out([header, ...lines].join('\n'))
  }
}

async function cmdSkillDiff(name: string): Promise<void> {
  if (!name || !name.trim()) {
    throw new CliError('skill-diff requires a <name>')
  }
  const dir = skillOutputsDir()
  const versions = (await listOutputs())
    .filter((m) => m.skillName === name)
    .sort((a, b) => b.ts - a.ts)

  if (versions.length === 0) {
    out(`no cached versions of '${name}'`)
    return
  }
  if (versions.length < 2) {
    out(`only one cached version of '${name}'`)
    return
  }

  const newer = versions[0]!
  const older = versions[1]!
  const newerBody = await fs.promises.readFile(path.resolve(dir, `${newer.outputId}.txt`), 'utf-8').catch(() => null)
  const olderBody = await fs.promises.readFile(path.resolve(dir, `${older.outputId}.txt`), 'utf-8').catch(() => null)
  if (newerBody === null || olderBody === null) {
    // listOutputs() above genuinely found >=2 versions -- a body read failing here (unlike the
    // versions.length < 2 case above) means one was evicted by a concurrent storeOutput()/
    // prune-cache run in the gap between that list and this read (pruneSkillOutputs runs
    // synchronously on every storeOutput() call and independently via `prune-cache`, neither
    // coordinated with this read), not that only one version ever existed. Say so distinctly
    // instead of reusing the "only one cached version" text, which would be actively false here.
    out(`a cached version of '${name}' was evicted while diffing -- try again`)
    return
  }
  const diff = buildLineDiff(olderBody, newerBody, name)
  out(diff)
}

async function cmdSkillSection(nameHeading: string, headingArg?: string): Promise<void> {
  if (!nameHeading) {
    throw new CliError('skill-section requires "<name>::<heading>" or <name> <heading>')
  }
  let skillName: string
  let heading: string
  if (headingArg) {
    skillName = nameHeading
    heading = headingArg
  } else {
    const sepIdx = findSpecSeparator(nameHeading)
    if (sepIdx === -1) {
      throw new CliError('skill-section requires "<name>::<heading>" format or <name> <heading> arguments')
    }
    skillName = nameHeading.slice(0, sepIdx)
    heading = nameHeading.slice(sepIdx + 2)
  }

  const filePath = await getSkillFilePath(skillName)
  if (!filePath) {
    throw new CliError(`skill '${skillName}' not found`)
  }
  const body = fs.readFileSync(filePath, 'utf-8')
  const extracted = extractNamedSection(body, heading)
  if (!extracted) {
    process.exitCode = 1
    return
  }
  out(extracted)
}

function atomicWriteBuffer(dest: string, data: Buffer): void {
  try {
    if (fs.statSync(dest).isDirectory()) {
      const e = Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${dest}'`), { code: 'EISDIR', path: dest }) as NodeJS.ErrnoException
      throw e
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  // Place tmp in same directory as dest so rename is always same-device (avoids EXDEV); include random suffix to eliminate PID-reuse collisions.
  const rnd = Math.random().toString(36).slice(2, 8)
  const tmp = path.join(path.dirname(path.resolve(dest)), `.tmp.${process.pid}.${rnd}`)
  try {
    // mode 0o600 applies on POSIX only; on Windows Node.js ignores it and the tmp file inherits the default ACL.
    fs.writeFileSync(tmp, data, { mode: 0o600 })
    // Preserve dest's existing file mode (e.g. the exec bit on a committed script) across the rewrite -- see atomicWriteCore in util.ts for the same fix and full rationale. A brand-new dest has no mode to inherit, so the tmp file keeps its 0o600 default.
    try {
      const destMode = fs.statSync(dest).mode
      fs.chmodSync(tmp, destMode)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    // Retries the rename on the same transient Windows lock errno (EPERM/EBUSY/ETXTBSY) that atomicWriteCore retries, so a briefly-locked destination behaves the same way here as it does for every other atomic write path in the codebase.
    withRetryOnLock(() => {
      try {
        fs.renameSync(tmp, dest)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          // copyFileSync is non-atomic; EXDEV should not occur normally (tmp is same-dir) but can appear on overlay/bind-mount filesystems.
          fs.copyFileSync(tmp, dest)
          try { fs.unlinkSync(tmp) } catch (ue) {
            process.stderr.write(`token-goat write-file: warning: could not remove temp file ${tmp}: ${(ue as NodeJS.ErrnoException).message}\n`)
          }
          return
        }
        throw e
      }
    })
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore cleanup failure */ }
    throw e
  }
}


function mapFsError(e: unknown, src?: string, dest?: string, srcLabel = 'source'): never {
  const fe = e as NodeJS.ErrnoException
  if (fe.code === 'ENOENT') {
    const errPath = fe.path ?? ''
    const isSource = src !== undefined && path.resolve(errPath) === path.resolve(src)
    if (isSource) throw new CliError(`${srcLabel} file not found: ${src}`)
    // Always show the destination directory, never the internal .tmp path
    const destDir = dest ? path.dirname(path.resolve(dest)) : path.dirname(path.resolve(errPath || '.'))
    throw new CliError(`destination directory does not exist: ${destDir}`)
  }
  if (fe.code === 'ENOTDIR') {
    if (src !== undefined && dest === undefined) {
      throw new CliError(`source path contains a file where a directory was expected: ${src}`)
    }
    throw new CliError(`destination path contains a file where a directory was expected: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EISDIR') {
    const errPath = fe.path ?? ''
    // Windows: readFileSync on a directory yields e.path===undefined (atomicWriteBuffer always sets e.path=dest); empty errPath with a src arg means the source was the directory.
    const isSource = src !== undefined && (errPath === '' || path.resolve(errPath) === path.resolve(src))
    if (isSource) throw new CliError(`source is a directory, not a file: ${src}`)
    throw new CliError(`destination is a directory, not a file: ${dest ?? (errPath || '(unknown)')}`)
  }
  if (fe.code === 'EACCES' || fe.code === 'EPERM') {
    if (src !== undefined && dest === undefined) {
      throw new CliError(`permission denied reading: ${src}`)
    }
    throw new CliError(`permission denied writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EROFS') {
    throw new CliError(`filesystem is read-only: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENOSPC') {
    throw new CliError(`no space left on device writing to: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ELOOP') {
    throw new CliError(`too many levels of symbolic links resolving: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'ENAMETOOLONG') {
    throw new CliError(`path is too long: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EMFILE' || fe.code === 'ENFILE') {
    throw new CliError(`too many open files; close other processes or raise the file-descriptor limit and retry`)
  }
  if (fe.code === 'ETXTBSY') {
    throw new CliError(`file is in use by a running process: ${dest ?? fe.path ?? ''}`)
  }
  if (fe.code === 'EDQUOT') {
    throw new CliError(`disk quota exceeded writing to: ${dest ?? fe.path ?? ''}`)
  }
  throw e
}

// Windows reserved device names — writes to these are silently discarded or misrouted.
const WIN_RESERVED = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
  'CONIN$','CONOUT$',
])

function validateWritablePath(dest: string, label: string): void {
  if (!dest || !dest.trim()) {
    throw new CliError(`${label} path cannot be empty`)
  }
  if (dest.includes('\0')) {
    throw new CliError(`${label} path contains a null byte`)
  }
  if (isWindows()) {
    const base = path.basename(dest)
    const stem = base.replace(/\.[^.]*$/, '').toUpperCase()
    if (WIN_RESERVED.has(stem)) {
      throw new CliError(`${label} '${base}' is a reserved Windows device name`)
    }
    if (base.endsWith('.') || base.endsWith(' ')) {
      throw new CliError(`${label} filename '${base}' ends with '${base.slice(-1)}' — Windows NTFS silently strips trailing dots and spaces, which would clobber a different file`)
    }
  }
}

function parseMaxStdinMB(): number {
  const raw = process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512'
  const maxMB = parseInt(raw, 10)
  if (!Number.isFinite(maxMB) || maxMB <= 0) {
    throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${raw}'`)
  }
  return maxMB
}

/** Shared validation + raw read for readTextFileBounded and cmdReplace's target-file read. Returns the file's exact bytes, unmodified — callers that need text decode it themselves. */
function readFileBoundedRaw(filePath: string, label: string, allowStdIn = false): Buffer {
  if (!filePath || !filePath.trim()) {
    throw new CliError(`${label} path cannot be empty`)
  }
  if (filePath.includes('\0')) {
    throw new CliError(`${label} path contains a null byte`)
  }
  if (!allowStdIn && !isWindows() && /^\/dev\/(stdin|fd\/0)$|^\/proc\/self\/fd\/0$/.test(filePath) && process.stdin.isTTY) {
    const altLabel = label.endsWith('-from') ? label.replace('-from', '-b64') : 'a regular file path'
    throw new CliError(`${label} ${filePath} requires piped input; use ${altLabel} for interactive use`)
  }
  try {
    const st = fs.statSync(filePath)
    if (st.isFIFO() || st.isSocket()) {
      throw new CliError(`${label} '${filePath}' is a special file (FIFO or socket) — only regular files are supported`)
    }
    const maxBytes = parseMaxStdinMB() * 1024 * 1024
    if (st.size > maxBytes) {
      throw new CliError(`${label} '${filePath}' exceeds size limit (${Math.round(st.size / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`)
    }
    return fs.readFileSync(filePath)
  } catch (e) {
    if (e instanceof CliError) throw e
    mapFsError(e, filePath, undefined, label)
  }
}

function decodeBase64Buffer(payload: string, label: string): Buffer {
  const normalized = payload.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (payload !== '' && normalized === '') {
    throw new CliError(`${label} payload contains only whitespace — likely a shell expansion error; pass an empty string explicitly for a zero-byte file`)
  }
  const maxBytes = parseMaxStdinMB() * 1024 * 1024
  const decodedSize = Math.floor((normalized.replace(/=+$/, '').length * 3) / 4)
  if (decodedSize > maxBytes) {
    throw new CliError(`${label} payload would decode to ${Math.round(decodedSize / 1024 / 1024)} MB which exceeds size limit; set TOKEN_GOAT_MAX_STDIN_MB to override`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new CliError(`${label} payload contains non-base64 characters — check for shell expansion of $VAR or backticks`)
  }
  if (normalized.replace(/=+$/, '').length % 4 === 1) {
    throw new CliError(`${label} payload length is invalid (trailing single base64 character cannot decode to any bytes — payload is likely truncated)`)
  }
  return Buffer.from(normalized, 'base64')
}

/**
 * Handles `token-goat note-add <file> [--symbol NAME] --content-from <path>|--content-b64 <b64>`:
 * writes (or overwrites) a free-text architecture note attached to a file, or to one specific
 * indexed symbol within it, alongside a fingerprint of exactly what the note currently
 * describes -- the resolved symbol's body text, or a digest of the file's whole top-level
 * symbol manifest for a file-scoped note. That fingerprint is the staleness anchor
 * `token-goat note-list --stale-only` compares against the live index later (see notes.ts's
 * isNoteStale) -- this command only ever captures the baseline, never decides staleness.
 *
 * A write like insert-section/replace, not a surgical read, so it follows their convention:
 * throw CliError on failure, print a confirmation via out() on success, wired through guard().
 */
function cmdNoteAdd(file: string, opts: { symbol?: string; contentFrom?: string; contentB64?: string }): void {
  if (!file || !file.trim()) {
    throw new CliError('file path cannot be empty')
  }

  const usingFrom = opts.contentFrom !== undefined
  const usingB64 = opts.contentB64 !== undefined
  if (usingFrom && usingB64) {
    throw new CliError('cannot mix --content-from with --content-b64')
  }
  if (!usingFrom && !usingB64) {
    throw new CliError('must provide either --content-from or --content-b64')
  }
  const contentBytes = usingFrom
    ? readFileBoundedRaw(opts.contentFrom!, '--content-from')
    : decodeBase64Buffer(opts.contentB64!, '--content-b64')
  if (contentBytes.length === 0) {
    throw new CliError('note content cannot be empty')
  }
  // Note content is stored/rendered as Markdown text, so a byte sequence that is not valid UTF-8
  // would silently decode to U+FFFD replacement characters below -- reject it explicitly instead,
  // same boundary-validation stance section.ts/insert-section take for text content.
  if (Buffer.compare(Buffer.from(contentBytes.toString('utf8'), 'utf8'), contentBytes) !== 0) {
    throw new CliError('note content must be valid UTF-8 text')
  }

  const resolvedPath = resolveIndexPath(file)
  if (!fs.existsSync(resolvedPath)) {
    throw new CliError(`File not found: '${resolvedPath}'`)
  }
  // Self-heal before resolving/fingerprinting so a note attached moments after an edit
  // fingerprints the CURRENT code, not a stale pre-edit index snapshot -- same pattern
  // runSymbol/runSection/runOutline already use via read_commands.ts's own healStaleIndex.
  healStaleIndex(resolvedPath)

  let symbol = WHOLE_FILE_NOTE_SYMBOL
  let fingerprint: string
  if (opts.symbol !== undefined) {
    const match = resolveSymbolMatch(resolvedPath, opts.symbol)
    if (match === null) {
      const messages = [`No symbol named '${opts.symbol}' is indexed in '${file}'`]
      const allNames = symbolNamesInFile(resolvedPath)
      // Rank by similarity to the query before suggesting, the same way the read-side miss paths do -- passing the raw list meant a query resembling nothing printed every symbol in the file under "Did you mean", which reads as a guess list rather than a suggestion. When ranking leaves nothing, point at the command that lists them instead, reusing runSection's wording verbatim.
      const available = rankSimilarNames(allNames, opts.symbol)
      if (available.length > 0) messages.push(didYouMean(available))
      else if (allNames.length > 0) messages.push(`Try: token-goat outline ${file}`)
      throw new CliError(messages.join('\n'))
    }
    symbol = opts.symbol
    fingerprint = fingerprintContent(match.body)
  } else {
    fingerprint = computeFileFingerprint(resolvedPath)
  }

  upsertNote(resolvedPath, symbol, contentBytes.toString('utf8'), fingerprint)
  const target = opts.symbol !== undefined ? `${file}::${opts.symbol}` : file
  out(`Note saved: ${target} (fingerprint ${fingerprint.slice(0, 12)})`)
  recordStat('note_write')
}
function cmdWriteFile(dest: string, opts: { from?: string; b64?: string }): Promise<void> | void {
  validateWritablePath(dest, 'destination')
  if (opts.from !== undefined && opts.b64 !== undefined) {
    throw new CliError('cannot use --from and --b64 together')
  }
  if (opts.from !== undefined) {
    const buf = readFileBoundedRaw(opts.from, '--from')
    try {
      atomicWriteBuffer(dest, buf)
    } catch (e) {
      mapFsError(e, opts.from, dest)
    }
    enqueueDirtyPathSafe(dest)
    return
  }
  if (opts.b64 !== undefined) {
    const buf = decodeBase64Buffer(opts.b64, '--b64')
    try {
      atomicWriteBuffer(dest, buf)
    } catch (e) {
      mapFsError(e, undefined, dest)
    }
    enqueueDirtyPathSafe(dest)
    return
  }
  if (process.stdin.isTTY) {
    throw new CliError('stdin mode requires piped input; use --b64 or --from for interactive use')
  }
  const maxMB = parseInt(process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? '512', 10)
  if (!Number.isFinite(maxMB) || maxMB <= 0) {
    throw new CliError(`TOKEN_GOAT_MAX_STDIN_MB must be a positive integer; got '${process.env['TOKEN_GOAT_MAX_STDIN_MB'] ?? ''}'`)
  }
  const maxBytes = maxMB * 1024 * 1024
  return new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        if (!settled) {
          settled = true
          cleanup()
          process.stdin.destroy()
          reject(new CliError(`stdin input exceeds size limit (${Math.round(maxBytes / 1024 / 1024)} MB); set TOKEN_GOAT_MAX_STDIN_MB to override`))
        }
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      try { atomicWriteBuffer(dest, Buffer.concat(chunks)); enqueueDirtyPathSafe(dest); resolve() }
      catch (e) { try { mapFsError(e, undefined, dest) } catch (e2) { reject(e2) } }
    }
    const onError = (e: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try { mapFsError(e, undefined, dest) } catch (e2) { reject(e2) }
    }
    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

/** Diagnoses a zero-match --old-from/--old-b64 lookup for the common near-miss cause: the same content is present in the file but differs from oldText only by a trailing newline or by CRLF-vs-LF line endings. Returns a message suffix to fold into the error, or undefined if no such near match exists. Diagnostic only — it never changes what gets matched or written. */
function diagnoseNearMiss(targetText: string, oldText: string): string | undefined {
  // oldText carries a trailing newline the file doesn't have at that exact position (e.g. a snippet file saved with an added final newline).
  const oldWithoutTrailingNewline = oldText.replace(/\r?\n$/, '')
  if (oldWithoutTrailingNewline !== oldText && oldWithoutTrailingNewline !== '' && targetText.includes(oldWithoutTrailingNewline)) {
    return `a near-match exists that differs only by a trailing newline — --old-from/--old-b64 has a trailing newline that is not present at that point in the file; check the exact content`
  }

  // Whole-snippet CRLF vs LF mismatch — check both directions symmetrically.
  const normalize = (s: string) => s.replace(/\r\n/g, '\n')
  const normalizedOld = normalize(oldText)
  const normalizedTarget = normalize(targetText)

  if (targetText !== oldText && normalizedTarget.includes(normalizedOld) && !targetText.includes(oldText)) {
    // Determine which direction the mismatch is
    if (oldText.includes('\r\n') && !targetText.includes('\r\n')) {
      return `a near-match exists that differs only by line endings — --old-from/--old-b64 uses CRLF but the file uses LF at that location; check the exact content`
    }
    if (oldText.includes('\n') && !oldText.includes('\r\n') && targetText.includes('\r\n')) {
      return `a near-match exists that differs only by line endings — --old-from/--old-b64 uses LF but the file uses CRLF at that location; check the exact content`
    }
  }

  return undefined
}

/** Detects whether `buf` predominantly uses CRLF or LF line endings, by counting each. */
function detectDominantEol(buf: Buffer): '\r\n' | '\n' {
  let crlf = 0
  let lfOnly = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) crlf++
      else lfOnly++
    }
  }
  return crlf > lfOnly ? '\r\n' : '\n'
}

/**
 * Converts `source`'s line endings to `eol`. Operates on raw bytes (never decodes to a
 * string): CR (0x0D) and LF (0x0A) can only appear as standalone single-byte characters in
 * valid UTF-8, never as a multi-byte sequence's continuation byte, so rewriting them
 * byte-by-byte is safe even on non-UTF-8 content — preserving the same byte-exactness
 * guarantee as the rest of `cmdReplace`.
 */
function convertEolTo(source: Buffer, eol: '\r\n' | '\n'): Buffer {
  const CR = 0x0d
  const LF = 0x0a
  const collapsed: number[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] === CR && source[i + 1] === LF) continue
    collapsed.push(source[i]!)
  }
  if (eol === '\n') return Buffer.from(collapsed)
  const expanded: number[] = []
  for (const b of collapsed) {
    if (b === LF) expanded.push(CR, LF)
    else expanded.push(b)
  }
  return Buffer.from(expanded)
}

/** Converts `source`'s line endings to match `reference`'s dominant line ending. */
function normalizeEolToMatch(source: Buffer, reference: Buffer): Buffer {
  return convertEolTo(source, detectDominantEol(reference))
}

/**
 * Collapses `buf`'s CRLF sequences down to LF, returning the collapsed bytes alongside a
 * map from each collapsed-byte index back to the original byte offset it came from (plus a
 * trailing sentinel entry at `buf.length`, so a half-open `[origStart[i], origStart[i+len])`
 * range recovers the exact original byte span a collapsed-space match of length `len`
 * starting at `i` corresponds to). Byte-level, not string-level, for the same non-UTF-8
 * safety reason as `convertEolTo`.
 */
function buildEolCollapsedView(buf: Buffer): { collapsed: Buffer; origStart: number[] } {
  const CR = 0x0d
  const LF = 0x0a
  const bytes: number[] = []
  const origStart: number[] = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] === CR && buf[i + 1] === LF) {
      bytes.push(LF)
      origStart.push(i)
      i += 2
    } else {
      bytes.push(buf[i]!)
      origStart.push(i)
      i += 1
    }
  }
  origStart.push(buf.length)
  return { collapsed: Buffer.from(bytes), origStart }
}

/**
 * Finds every place `old` occurs in `target` once both are EOL-collapsed (CRLF and LF treated
 * as equivalent), and maps each hit back to the real byte span in `target` — which may be
 * longer or shorter than `old.length` since the matched region can use a different EOL style
 * than `old` itself. This is how `cmdReplace` turns a "differs only by line endings" near-miss
 * into an actual fix instead of just diagnosing it.
 */
function findEolCollapsedMatches(target: Buffer, old: Buffer): { start: number; end: number }[] {
  const { collapsed: oldCollapsed } = buildEolCollapsedView(old)
  if (oldCollapsed.length === 0) return []
  const { collapsed: targetCollapsed, origStart } = buildEolCollapsedView(target)
  const spans: { start: number; end: number }[] = []
  let cursor = 0
  while ((cursor = targetCollapsed.indexOf(oldCollapsed, cursor)) !== -1) {
    spans.push({ start: origStart[cursor]!, end: origStart[cursor + oldCollapsed.length]! })
    cursor += oldCollapsed.length
  }
  return spans
}

/**
 * Detects the EOL style actually used within `span` of `buf` — "at that location" rather than
 * file-wide — so a healed replacement matches its immediate surroundings instead of the file's
 * overall dominant convention. Falls back to `wholeFileFallback`'s dominant EOL when `span`
 * itself contains no line break to judge from (e.g. a single-line match).
 */
function localEolStyle(buf: Buffer, span: { start: number; end: number }, wholeFileFallback: Buffer): '\r\n' | '\n' {
  const slice = buf.subarray(span.start, span.end)
  let crlf = 0
  let lfOnly = 0
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0x0a) {
      if (i > 0 && slice[i - 1] === 0x0d) crlf++
      else lfOnly++
    }
  }
  if (crlf === 0 && lfOnly === 0) return detectDominantEol(wholeFileFallback)
  return crlf > lfOnly ? '\r\n' : '\n'
}

/**
 * Shared write path for `cmdReplace`'s two success branches (byte-exact and EOL-healed):
 * re-checks the optimistic-concurrency guard, writes atomically, and enqueues the dirty-reindex
 * queue entry. Throws on a concurrent-modification or write failure; the caller prints its own
 * success message afterward since the two branches word it differently.
 */
function writeReplacedBuffer(file: string, replacedBuf: Buffer, preWriteStat: fs.Stats | undefined): void {
  if (preWriteStat !== undefined) {
    // Test-only seam: widens the read->re-stat window so a regression test can deterministically force a concurrent modification to land inside it, instead of relying on OS timing jitter. No-op unless a test explicitly sets this env var; never set in normal operation.
    const testDelayMs = Number(process.env['TOKEN_GOAT_TEST_REPLACE_DELAY_MS'] ?? '')
    if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
      // Deterministic readiness signal for the regression test: emitted only under the same test-only env var, right as the delay window opens, so the test can land its concurrent write inside the window instead of guessing at CLI startup latency.
      process.stderr.write('TOKEN_GOAT_TEST_REPLACE_DELAY_READY\n')
      sleepSync(testDelayMs)
    }
    let preRenameStat: fs.Stats | undefined
    try {
      preRenameStat = fs.statSync(file)
    } catch {
      // Vanished between the read and the write -- let atomicWriteBuffer surface the real error.
    }
    if (preRenameStat !== undefined && (preRenameStat.mtimeMs !== preWriteStat.mtimeMs || preRenameStat.size !== preWriteStat.size)) {
      throw new CliError(`${file} changed on disk while replace was running -- the file was modified concurrently, so the replace was NOT applied. Retry the replace.`)
    }
  }
  try {
    atomicWriteBuffer(file, replacedBuf)
  } catch (e) {
    mapFsError(e, undefined, file)
  }
  enqueueDirtyPathSafe(file)
}

// Bounds the cost of the closest-match scan below (worst case targetLines * windowSize
// comparisons) so a huge file paired with a huge snippet can't turn a failed replace into a
// multi-second stall -- past this, skip the fallback hint rather than block.
const MAX_CLOSEST_MATCH_COMPARISONS = 2_000_000

/**
 * Best-effort fallback for `cmdReplace`'s "old string not found" error when it's not a
 * CRLF/trailing-newline near-match either: slides a window the size of `oldText` (in lines)
 * across `targetText` and returns the window with the most exact line matches, so the caller
 * gets a concrete line number and region to diff against instead of a bare "not found" —
 * mirroring the "Did you mean" pattern `section` already has for unresolvable headings.
 * Returns undefined when no informative window exists (e.g. oldText longer than the file) or
 * the scan would exceed the cost bound above.
 */
function findClosestLineWindow(targetText: string, oldText: string): { lineStart: number; region: string } | undefined {
  const targetLines = targetText.split('\n')
  const oldLines = oldText.split('\n')
  const windowSize = oldLines.length
  if (windowSize === 0 || windowSize > targetLines.length) return undefined
  if ((targetLines.length - windowSize + 1) * windowSize > MAX_CLOSEST_MATCH_COMPARISONS) return undefined

  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i <= targetLines.length - windowSize; i++) {
    let score = 0
    for (let j = 0; j < windowSize; j++) {
      if (targetLines[i + j] === oldLines[j]) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  if (bestIdx === -1) return undefined
  return { lineStart: bestIdx + 1, region: targetLines.slice(bestIdx, bestIdx + windowSize).join('\n') }
}

function cmdReplace(file: string, opts: { oldFrom?: string; newFrom?: string; oldB64?: string; newB64?: string; all?: boolean; normalizeNewlines?: boolean }): void {
  validateWritablePath(file, 'target file')

  const targetBuf = readFileBoundedRaw(file, 'target file', true)
  // Optimistic-concurrency guard: the snippet match above only protects the matched region -- a concurrent write to any OTHER part of the file between this read and the final rename would otherwise be silently lost (atomicWriteBuffer rewrites the whole file, last-writer-wins). Best-effort, not a lock: a race between the re-stat below and the rename itself is accepted residual risk, consistent with this codebase's other lock patterns.
  let preWriteStat: fs.Stats | undefined
  try {
    preWriteStat = fs.statSync(file)
  } catch {
    // If the file vanished between the read above and now, let the write path surface its own error.
  }
  const usingFrom = opts.oldFrom !== undefined || opts.newFrom !== undefined
  const usingB64 = opts.oldB64 !== undefined || opts.newB64 !== undefined

  if (usingFrom && usingB64) {
    throw new CliError('cannot mix --old-from/--new-from with --old-b64/--new-b64')
  }
  if (!usingFrom && !usingB64) {
    throw new CliError('must provide either --old-from/--new-from or --old-b64/--new-b64')
  }
  if (usingFrom) {
    if (opts.oldFrom === undefined || opts.newFrom === undefined) {
      throw new CliError('must pass both --old-from and --new-from together')
    }
  } else {
    if (opts.oldB64 === undefined || opts.newB64 === undefined) {
      throw new CliError('must pass both --old-b64 and --new-b64 together')
    }
  }

  const oldBytes = usingFrom
    ? readFileBoundedRaw(opts.oldFrom!, '--old-from')
    : decodeBase64Buffer(opts.oldB64!, '--old-b64')
  const newBytes = usingFrom
    ? readFileBoundedRaw(opts.newFrom!, '--new-from')
    : decodeBase64Buffer(opts.newB64!, '--new-b64')

  // Opt-in: convert the caller-supplied old/new text's line endings to match the target
  // file's dominant one before matching. Off by default so byte-exact matching (this
  // command's core guarantee -- see the no-UTF-8-decode note below) never silently changes
  // what's matched without the caller asking for it; this is purely for the extremely common
  // case of an agent's intermediate snippet defaulting to CRLF (or LF) while the target file
  // uses the other, which would otherwise always require a manual round-trip to fix.
  const normalizedOldBytes = opts.normalizeNewlines === true ? normalizeEolToMatch(oldBytes, targetBuf) : oldBytes
  const normalizedNewBytes = opts.normalizeNewlines === true ? normalizeEolToMatch(newBytes, targetBuf) : newBytes

  if (normalizedOldBytes.length === 0) {
    throw new CliError('old string cannot be empty')
  }

  // Byte-exact match/replace: the target file (and the --old-from/--new-from/--old-b64/--new-b64 inputs themselves) may contain bytes that are not valid UTF-8. Decoding any of them to a string and re-encoding would silently replace every such byte with U+FFFD (ef bf bd) on write. Reading and matching everything as raw Buffers leaves every byte — valid UTF-8 or not — untouched.

  const matches: number[] = []
  let cursor = 0
  while ((cursor = targetBuf.indexOf(normalizedOldBytes, cursor)) !== -1) {
    matches.push(cursor)
    cursor += normalizedOldBytes.length
  }
  const occurrences = matches.length

  if (occurrences === 0) {
    // Auto-heal: the exact byte match failed, but if a match exists once CRLF/LF differences
    // are collapsed away — and that match is unique — perform the replacement instead of just
    // diagnosing it, writing the new text back in the file's EOL style at that location so the
    // file is never left with mixed endings.
    const eolMatches = findEolCollapsedMatches(targetBuf, normalizedOldBytes)
    if (eolMatches.length === 1) {
      const span = eolMatches[0]!
      const healedNewBytes = convertEolTo(normalizedNewBytes, localEolStyle(targetBuf, span, targetBuf))
      const healedBuf = Buffer.concat([targetBuf.subarray(0, span.start), healedNewBytes, targetBuf.subarray(span.end)])
      writeReplacedBuffer(file, healedBuf, preWriteStat)
      out(`replaced 1 occurrence in ${file} (line-ending normalized to match the file at that location)`)
      return
    }
    if (eolMatches.length > 1) {
      throw new CliError(
        `old string not found in ${file} — ${eolMatches.length} near-matches exist that differ only by line endings; provide a more specific match`,
      )
    }
    // Diagnostic only: decoding lossily here is fine — it only shapes the human-readable near-miss
    // hint and never feeds back into what gets matched or written.
    const nearMiss = diagnoseNearMiss(targetBuf.toString('utf8'), normalizedOldBytes.toString('utf8'))
    if (nearMiss !== undefined) {
      throw new CliError(`old string not found in ${file} — ${nearMiss}`)
    }
    // Neither an exact match nor a CRLF/trailing-newline near-match — fall back to a
    // best-effort closest-matching-region hint so the caller can self-correct without a
    // separate re-fetch round-trip, mirroring the "Did you mean" pattern `section` already
    // has for unresolvable headings.
    const closest = findClosestLineWindow(targetBuf.toString('utf8'), normalizedOldBytes.toString('utf8'))
    if (closest !== undefined) {
      const diff = buildLineDiff(closest.region, normalizedOldBytes.toString('utf8'), file)
      throw new CliError(
        `old string not found in ${file} — closest match at line ${closest.lineStart} (showing: what's actually there vs. what --old-from/--old-b64 searched for):\n${diff}`,
      )
    }
    throw new CliError(`old string not found in ${file}`)
  }
  if (occurrences > 1 && !opts.all) {
    throw new CliError(`old string appears ${occurrences} times in ${file} — pass --all to replace every occurrence, or provide a more specific match`)
  }

  const parts: Buffer[] = []
  let prevEnd = 0
  for (const pos of matches) {
    parts.push(targetBuf.subarray(prevEnd, pos))
    parts.push(normalizedNewBytes)
    prevEnd = pos + normalizedOldBytes.length
  }
  parts.push(targetBuf.subarray(prevEnd))
  const replacedBuf = Buffer.concat(parts)

  writeReplacedBuffer(file, replacedBuf, preWriteStat)
  out(`replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${file}`)
}

/**
 * Handles `token-goat insert-section <file> --after <heading>`: inserts new content
 * immediately after a matched section's last line, resolved the same way `section`/`replace`
 * resolve headings (exact, normalized, or an unambiguous prefix — see resolveHeaderPos in
 * section_reader.ts). Exists because every real-world use of `replace` for an
 * append-to-a-running-log edit (e.g. adding the next "## Lesson N" to a lessons-learned doc)
 * requires reproducing the *exact current trailing bytes* of the previous entry as the match
 * anchor — which goes stale the moment an earlier edit in the same session already changed
 * that trailing text. Resolving by heading instead of by byte-anchor removes that staleness
 * window entirely.
 *
 * Unlike `replace`, which stays byte-buffer-only so it never has to assume valid UTF-8,
 * `insert-section` inherently requires text/heading matching (like `section` itself already
 * does) — so this command does assume the target is valid UTF-8 text.
 */
function cmdInsertSection(file: string, opts: { after: string; contentFrom?: string; contentB64?: string }): void {
  validateWritablePath(file, 'target file')

  const usingFrom = opts.contentFrom !== undefined
  const usingB64 = opts.contentB64 !== undefined
  if (usingFrom && usingB64) {
    throw new CliError('cannot mix --content-from with --content-b64')
  }
  if (!usingFrom && !usingB64) {
    throw new CliError('must provide either --content-from or --content-b64')
  }
  const contentBytes = usingFrom
    ? readFileBoundedRaw(opts.contentFrom!, '--content-from')
    : decodeBase64Buffer(opts.contentB64!, '--content-b64')
  if (contentBytes.length === 0) {
    throw new CliError('content to insert cannot be empty')
  }

  // Optimistic-concurrency guard, same pattern as cmdReplace: the section-boundary lookup
  // below only protects the matched region -- a concurrent write elsewhere in the file
  // between this stat and the final rename would otherwise be silently lost.
  let preWriteStat: fs.Stats | undefined
  try {
    preWriteStat = fs.statSync(file)
  } catch {
    // If the file vanished between now and the write below, let the write path surface its own error.
  }

  const result = readSection(file, opts.after)
  if (result === null) {
    const allHeadings = listSections(file)
    const messages = [`Section '${opts.after}' not found in '${file}'`]
    // Same reasoning as the note-add miss above: rank before suggesting, and fall through to the listing command when ranking leaves nothing, rather than dumping every heading in the file.
    const available = filterSimilarHeadings(allHeadings, opts.after)
    if (available.length > 0) messages.push(didYouMean(available))
    else if (allHeadings.length > 0) messages.push(`Try: token-goat outline ${file}`)
    throw new CliError(messages.join('\n'))
  }

  let rawText: string
  try {
    rawText = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    mapFsError(e, undefined, file)
  }
  if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1)

  const eol = detectDominantEol(Buffer.from(rawText, 'utf8'))
  // Collapse to LF-only for splicing (avoids ever joining an already-CRLF-terminated line with
  // another CRLF, which would double the CR), then re-expand once at the end if needed.
  // Collapsing/expanding CRLF<->LF changes no line count or position, so result.lineEnd (an
  // index computed by section_reader.ts against the *un*-collapsed text.split('\n')) still
  // points at the identical line here.
  const lfLines = rawText.replace(/\r\n/g, '\n').split('\n')
  const insertAt = result.lineEnd

  const insertedLines = contentBytes.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  if (insertedLines.length > 0 && insertedLines[insertedLines.length - 1] === '') insertedLines.pop()

  const mergedLfText = [...lfLines.slice(0, insertAt), ...insertedLines, ...lfLines.slice(insertAt)].join('\n')
  const mergedText = eol === '\n' ? mergedLfText : mergedLfText.replace(/\n/g, '\r\n')

  if (preWriteStat !== undefined) {
    let preRenameStat: fs.Stats | undefined
    try {
      preRenameStat = fs.statSync(file)
    } catch {
      // Vanished between the read and the write -- let atomicWriteBuffer surface the real error.
    }
    if (preRenameStat !== undefined && (preRenameStat.mtimeMs !== preWriteStat.mtimeMs || preRenameStat.size !== preWriteStat.size)) {
      throw new CliError(`${file} changed on disk while insert-section was running -- the file was modified concurrently, so the insert was NOT applied. Retry.`)
    }
  }

  try {
    atomicWriteBuffer(file, Buffer.from(mergedText, 'utf8'))
  } catch (e) {
    mapFsError(e, undefined, file)
  }
  enqueueDirtyPathSafe(file)
  const redirectNote = result.redirectedFrom !== undefined ? ` (redirected from: '${result.redirectedFrom}')` : ''
  out(`inserted after '${result.heading}'${redirectNote} in ${file}`)
}

async function cmdGdriveSections(fileId: string, opts: { heading?: string; fresh?: boolean }): Promise<void> {
  const fetchOpts = { fresh: opts.fresh === true }
  // Fetch the whole doc once up front (honoring --fresh) so its raw byte size is available as
  // the "full source" side of the bytes-saved calculation below, mirroring cmdSessionOutline/
  // cmdSessionSlice's convention. fetchDoc() always writes its result to the on-disk web-output
  // cache before returning, so the getSectionContent/getDocSections calls below can safely pass
  // `fresh: false` -- they read through to the entry this call just (re)populated, guaranteeing
  // exactly one network fetch even with --fresh, instead of two.
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
  out(emitted)
  // stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `gdrive-sections`/`gdrive_sections`
  // entry and nothing ever called recordStat for this command -- the dashboard bucket was
  // permanently zero regardless of real usage, the same class of gap already fixed for
  // map_lookup/changed_lookup/csv_query/brief_view/session_outline/session_slice (see
  // project_runchanged_missing_stat memory).
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(emitted, 'utf8'))
  recordStat('gdrive_sections', bytesSaved, Math.round(bytesSaved / 4))
}

/**
 * Expand glob patterns in a list of path strings using fs.globSync when available (Node 22+).
 * Literal paths are passed through unchanged. Exported for regression coverage (see
 * cli_expandglobs_large_match.test.ts); not part of the public CLI surface. `globFnOverride`
 * lets a test substitute a fake glob match array (e.g. a huge one, to exercise the
 * large-match-set path below) without writing real files to disk; production callers never
 * pass it, so the real `fs.globSync` is always used.
 */
export function expandGlobs(
  root: string,
  patterns: string[],
  globFnOverride?: (pattern: string, opts: { cwd: string }) => string[],
): string[] {
  const out: string[] = []
  const globFn =
    globFnOverride ??
    ((fs as unknown as Record<string, unknown>)['globSync'] as
      | ((pattern: string, opts: { cwd: string }) => string[])
      | undefined)
  for (const p of patterns) {
    if (globFn !== undefined && (p.includes('*') || p.includes('?') || p.includes('{'))) {
      try {
        const hits = globFn(p, { cwd: root })
        // Plain loop instead of out.push(...array): spreading a large glob match set (e.g.
        // `**/*` on a big project) as call arguments blows the engine's call-stack limit well
        // within realistic file counts (RangeError: Maximum call stack size exceeded), which
        // this function's own try/catch then silently swallows as "not a valid glob, fall
        // through to literal path" -- turning a huge, legitimate match set into zero matched
        // files instead of throwing or reporting the real count.
        for (const h of hits) out.push(path.isAbsolute(h) ? h : path.join(root, h))
        continue
      } catch {
        // fall through to literal path
      }
    }
    out.push(path.isAbsolute(p) ? p : path.join(root, p))
  }
  return out
}

/** Reads .tokengoatignore from the project root and returns its non-blank, non-comment lines as glob patterns. Returns undefined if the file doesn't exist. */
function readIgnoreFile(root: string): string[] | undefined {
  const ignorePath = path.join(root, '.tokengoatignore')
  let raw: string
  try {
    raw = fs.readFileSync(ignorePath, 'utf8')
  } catch {
    return undefined
  }
  const patterns = raw
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0 && !ln.startsWith('#'))
  return patterns.length > 0 ? patterns : undefined
}

function cmdPack(
  patterns: string[] | undefined,
  opts: {
    format?: string
    lineNumbers?: boolean
    instructionFile?: string
    output?: string
    ignore?: boolean
    stripComments?: boolean
    scanSecrets?: boolean
    budget?: string
  },
): void {
  const root = process.cwd()
  const style = opts.format === 'xml' ? 'xml' : opts.format === 'text' ? 'plain' : 'markdown'
  const ignorePatterns = opts.ignore !== false ? readIgnoreFile(root) : undefined
  const collectOpts = {
    ...(opts.stripComments === true ? { do_strip_comments: true as const } : {}),
    ...(ignorePatterns !== undefined ? { ignore_patterns: ignorePatterns } : {}),
  }
  const patternList = patterns ?? []
  const expandedList = patternList.length > 0 ? expandGlobs(root, patternList) : []
  if (patternList.length > 0 && expandedList.length === 0) {
    throw new CliError(`no files matched: ${patternList.join(' ')}`)
  }
  const result =
    expandedList.length > 0
      ? collectFiles(root, expandedList, collectOpts)
      : collectFromStdin(root, collectOpts)
  if (opts.budget !== undefined) {
    const budgetN = requireInt('--budget', opts.budget)
    if (result.total_tokens > budgetN) {
      err(`token-goat: pack: token count ${result.total_tokens} exceeds budget ${budgetN}`)
      process.exitCode = 3
      return
    }
  }
  if (opts.scanSecrets === true) {
    const hits = scanSecrets(result.files)
    if (hits.length > 0) {
      for (const hit of hits) {
        err(`token-goat: secret in ${hit.rel_path}:${hit.line}: ${hit.kind}`)
      }
      process.exitCode = 2
      return
    }
  }
  let instruction: string | undefined
  if (opts.instructionFile !== undefined) {
    instruction = fs.readFileSync(opts.instructionFile, 'utf8')
  }
  const formatted = formatPack(result, style, {
    ...(opts.lineNumbers === true ? { line_numbers: true } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
  })
  if (opts.output !== undefined) {
    fs.writeFileSync(opts.output, formatted, 'utf8')
  } else {
    out(formatted)
  }
}

function cmdTokens(
  patterns: string[] | undefined,
  opts: { tree?: boolean; top?: string; asc?: boolean; json?: boolean },
): void {
  const root = process.cwd()
  const result = estimateBudget(root, expandGlobs(root, patterns ?? []))
  let entries = [...result.entries]
  if (opts.asc === true) entries.reverse()
  if (opts.top !== undefined) entries = entries.slice(0, requireNonNegativeInt('--top', opts.top))
  if (opts.json === true) {
    out(JSON.stringify({ entries, total_tokens: result.total_tokens, total_lines: result.total_lines }, null, 2))
    return
  }
  if (opts.tree === true) {
    const dirs = new Map<string, typeof entries>()
    for (const e of entries) {
      const dir = path.dirname(e.rel_path)
      if (!dirs.has(dir)) dirs.set(dir, [])
      dirs.get(dir)!.push(e)
    }
    const lines: string[] = []
    for (const [dir, dirEntries] of dirs) {
      const dirTokens = dirEntries.reduce((s, e) => s + e.tokens, 0)
      const pct = result.total_tokens > 0 ? Math.round((dirTokens / result.total_tokens) * 100) : 0
      lines.push(`${dir}/ (${dirTokens} tokens, ${pct}%)`)
      for (const e of dirEntries) {
        lines.push(`  ${path.basename(e.rel_path).padEnd(30)}  ${String(e.tokens).padStart(8)} tokens`)
      }
    }
    out(lines.join('\n'))
    return
  }
  if (entries.length === 0) {
    out('No files matched.')
    return
  }
  // Reduce instead of Math.max(...array): spreading a large project's file list as call
  // arguments blows the engine's call-stack limit (RangeError) well within realistic file
  // counts -- mirrors the same fix in pack.ts's formatBudgetText.
  const colW = entries.reduce((max, e) => Math.max(max, e.rel_path.length), 4)
  const lines = [
    `${'File'.padEnd(colW)}  ${'~Tokens'.padStart(8)}  ${'Lines'.padStart(6)}`,
    `${'-'.repeat(colW)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`,
  ]
  for (const e of entries) {
    lines.push(`${e.rel_path.padEnd(colW)}  ${String(e.tokens).padStart(8)}  ${String(e.lines).padStart(6)}`)
  }
  out(lines.join('\n'))
}

function cmdBudget(
  patterns: string[],
  opts: { context?: string; json?: boolean },
): void {
  const root = process.cwd()
  const result = estimateBudget(root, expandGlobs(root, patterns))
  if (opts.json === true) {
    out(JSON.stringify(result, null, 2))
  } else {
    // Falls back to the configured context.model_window_tokens (in thousands, matching
    // --context's own units) so the % line shows up without requiring --context on every call.
    const contextK = opts.context !== undefined
      ? requirePositiveInt('--context', opts.context)
      : Math.round(loadConfig().context.model_window_tokens / 1000)
    out(formatBudgetText(result, contextK))
  }
}

function cmdFailures(
  src: string | undefined,
  opts: { runner?: string; json?: boolean; delta?: boolean; key?: string },
): void {
  const text = src !== undefined ? fs.readFileSync(src, 'utf8') : fs.readFileSync(0, 'utf8')
  const result = extractFailures(text, opts.runner !== undefined ? { runner: opts.runner } : {})

  if (opts.delta !== true) {
    out(opts.json === true ? formatFailuresJson(result) : formatFailuresText(result))
    return
  }

  // --delta needs a project identity to scope the persisted baseline to (see
  // failures_state.ts's module doc for why project hash + an explicit --key, not a
  // (sessionId, bash_id) pair, is the right key here).
  const project = findProject(process.cwd())
  if (project === null) {
    throw new Error('token-goat failures --delta requires a project root (git repo, package.json, etc.) from cwd to scope the saved baseline')
  }
  const key = opts.key ?? DEFAULT_FAILURES_STATE_KEY
  const signatures = failureSignatures(result)
  const prior = loadFailureSnapshot(project.hash, key)
  const delta = computeFailureDelta(prior?.signatures ?? null, signatures)
  saveFailureSnapshot(project.hash, key, { signatures, runner: result.runner, storedAt: Date.now() })
  out(opts.json === true ? formatFailureDeltaJson(delta, result.runner) : formatFailureDeltaText(delta, result.runner))
}
// --- Program assembly -------------------------------------------------------

/** Build the Commander program. Exported so tests can introspect/parse it. */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('token-goat')
    .description('Surgical token-reduction companion for AI coding agents')
    .version(VERSION, '-v, --version', 'print the token-goat version')

  // Each action wraps the (possibly sync) handler so any thrown CliError or unexpected error maps to a stderr line + exit code 1, and success to 0.
  // A handler that already set process.exitCode itself (a deliberate non-zero exit without throwing) is left alone -- only the still-undefined default gets the success fallback.
  const guard =
    (fn: (...a: never[]) => void | Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      process.exitCode = undefined
      // loadConfig() silently falls back to defaults on a config.toml parse failure, same as when the file is simply missing -- surface the distinction here, once per invocation, so a corrupt config doesn't look identical to "no config yet" for every command.
      loadConfig()
      const parseErr = getLastConfigParseError()
      if (parseErr !== null) {
        err(`token-goat: config.toml failed to parse (${parseErr}); using defaults — run \`token-goat config validate\` for details`)
      }
      // Same distinction as above, for the optional per-project .token-goat.toml override --
      // it fails open (global-only config still loads), but a corrupt project file should not
      // look identical to "no project override" for every command.
      const projectParseErr = getLastProjectConfigParseError()
      if (projectParseErr !== null) {
        err(`token-goat: .token-goat.toml failed to parse (${projectParseErr}); ignoring project override`)
      }
      try {
        await fn(...(args as never[]))
        if (process.exitCode === undefined) {
          process.exitCode = 0
        }
      } catch (e) {
        const msg = extractErrorMessage(e)
        err(`token-goat: ${msg}`)
        process.exitCode = 1
      }
    }

  program
    .command('symbol <name>')
    .description('search for a symbol by name')
    .option('-l, --limit <n>', 'max results')
    .option('-f, --file <path>', 'restrict to one file')
    .option('-k, --kind <kind>', 'restrict to one kind (function, class, ...)')
    .option('-p, --project [path]', 'scope search to one project root instead of the global index (defaults to cwd)')
    .option('-j, --json', 'output as JSON')
    .action((name: string, opts: { limit?: string; file?: string; kind?: string; project?: string | boolean; json?: boolean }) => {
      let projectRoot: string | undefined
      if (opts.project === true) {
        projectRoot = resolveProjectRoot({ project: process.cwd() })
      } else if (typeof opts.project === 'string') {
        projectRoot = resolveProjectRoot({ project: opts.project })
      }
      return runExitText(() =>
        runSymbol({
          name,
          limit: opts.limit !== undefined ? requireNonNegativeInt('--limit', opts.limit) : 20,
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      )
    })

  program
    .command('read <spec>')
    .description(
      "read one symbol's full body (spec: file::symbol; disambiguate a name shared by several classes with file::Parent.symbol; a trailing @LINE anchor -- file::symbol@LINE, or combined as file::Parent.symbol@LINE -- picks out a specific candidate by its exact starting line, for the case a Parent qualifier can't reach (e.g. a top-level definition); comma-separated file::a,b for a merged multi-symbol view, or a::x,b::y to merge symbols across several files)",
    )
    .option('-j, --json', 'output as JSON')
    .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
    .option('--stats', 'add per-symbol reference count and doc-coverage flag')
    .action((spec: string, opts: { json?: boolean; forceRefresh?: boolean; stats?: boolean }) =>
      runExitText(() =>
        runRead({
          spec,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
          ...(opts.stats === true ? { stats: true } : {}),
        }),
      ),
    )

  program
    .command('brief <spec>')
    .description(
      'symbol body + callers + containing doc section in one call (spec: file::symbol; also accepts the file::symbol@LINE anchor form documented under `read`; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported)',
    )
    .option('-j, --json', 'output as JSON')
    .option('--limit <n>', 'max callers to show (default: 20)')
    .option('-C, --context <n>', 'lines of call-site source to show before and after each caller (default 0)')
    .action((spec: string, opts: { json?: boolean; limit?: string; context?: string }) =>
      runExit(() =>
        runBrief({
          spec,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
        }),
      ),
    )

  program
    .command('section <spec>')
    .description(
      'read one section from a file (spec: file::heading, or file::<unambiguous heading prefix> — e.g. "Lesson 16" resolves a longer unique heading; comma-separated file::A,B for a merged multi-heading view), or list all sections with --list',
    )
    .option('-j, --json', 'output as JSON')
    .option('--list', 'list all section headings in the file instead of reading one')
    .action((spec: string, opts: { json?: boolean; list?: boolean }) =>
      opts.list === true
        ? runExit(() => runListSections({ file: spec, ...(opts.json === true ? { json: true } : {}) }))
        : runExitText(() => runSection({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('semantic <query>')
    .description('semantic search (falls back to full-text search)')
    .option('-l, --limit <n>', 'max results')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdSemantic))

  program
    .command('skeleton <file> [more...]')
    .description('list all symbols in a file without bodies (also accepts a comma-separated file list "a,b,c" for one headed block per file)')
    .option('-j, --json', 'output as JSON')
    .option('--min-lines <n>', 'only show symbols at least N lines long')
    .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
    .option('--stats', 'add per-symbol reference count and doc-coverage flag')
    .action(
      (file: string, more: string[], opts: { json?: boolean; minLines?: string; forceRefresh?: boolean; stats?: boolean }) =>
        runExitText(() =>
          noteExtraFileArgs('skeleton', file, more, () =>
            runSkeleton({
              file,
              ...(opts.json === true ? { json: true } : {}),
              ...(opts.minLines !== undefined ? { minLines: requireNonNegativeInt('--min-lines', opts.minLines) } : {}),
              ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
              ...(opts.stats === true ? { stats: true } : {}),
            }),
          ),
        ),
    )

  program
    .command('outline <file> [more...]')
    .description('list symbols with line ranges and docstrings (also accepts a comma-separated file list "a,b,c" for one headed block per file)')
    .option('-j, --json', 'output as JSON')
    .option('--min-lines <n>', 'only show symbols at least N lines long')
    .option('--force-refresh', 'reparse file from disk before querying (ignore stale index)')
    .option('--stats', 'add per-symbol reference count and doc-coverage flag')
    .action(
      (file: string, more: string[], opts: { json?: boolean; minLines?: string; forceRefresh?: boolean; stats?: boolean }) =>
        runExitText(() =>
          noteExtraFileArgs('outline', file, more, () =>
            runOutline({
              file,
              ...(opts.json === true ? { json: true } : {}),
              ...(opts.minLines !== undefined ? { minLines: requireNonNegativeInt('--min-lines', opts.minLines) } : {}),
              ...(opts.forceRefresh === true ? { forceRefresh: true } : {}),
              ...(opts.stats === true ? { stats: true } : {}),
            }),
          ),
        ),
    )

  program
    .command('refs <spec>')
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
    .action((spec: string, opts: { callers?: boolean; limit?: string; top?: string; context?: string; json?: boolean; excludeTests?: boolean }) =>
      runExit(() =>
        runRefs({
          spec,
          ...(opts.callers === true ? { callers: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
        }),
      ),
    )

  program
    .command('index [path]')
    .description('parse all git-tracked files and (re)build the symbol index')
    .option('--walk', 'if not a git repo, index a bounded directory walk instead (skips .env / generated / oversized trees)')
    .option('--force', 'bypass the SHA-freshness cache and reindex every tracked file, even byte-identical ones (e.g. after a parser upgrade changes what gets extracted)')
    .option('--force-walk', `index a non-git folder via --walk and raise its ${MAX_FILES_SCANNED} source-file refusal to ${MAX_FILES_SCANNED_FORCED} (slow; produces a large index)`)
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
    .command('compress-text [text]')
    .description('compress arbitrary local text and print an opaque recovery ID plus compact payload')
    .option('--file <path>', 'read text from a local file instead of the argument')
    .action(guard(cmdContentCompress))

  program
    .command('retrieve <id>')
    .description('retrieve original text previously stored by token-goat compress')
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
    .description('install hooks into Claude Code settings')
    .option('-p, --project', 'install into project scope instead of user scope')
    .option('--codex', 'also patch Codex CLI (~/.codex/config.toml, ~/.codex/AGENTS.md)')
    .option('--gemini', 'also patch Gemini CLI (~/.gemini/settings.json)')
    .option('--qwen', 'also patch Qwen Code (~/.qwen/settings.json)')
    .option('--pi', 'also drop a pi (pi-coding-agent) extension (~/.pi/agent/extensions/token-goat.ts)')
    .option('--opencode', 'also drop an opencode plugin (~/.config/opencode/plugins/token-goat.ts, %APPDATA%\\opencode\\plugins\\token-goat.ts on Windows)')
    .option('--hermes', 'verify token-goat hooks are present for Hermes Agent (writes nothing new)')
    .option('--openclaw', 'also register an OpenClaw plugin (~/.openclaw/openclaw.json, ~/.openclaw/plugins/token-goat.ts)')
    .option('--copilot', 'also register a Copilot CLI hook config and routing block (~/.copilot/hooks/token-goat.json, ~/.copilot/hooks/token-goat-shim.js, ~/.copilot/copilot-instructions.md; with --local, <project>/.github/hooks/token-goat.json, <project>/.github/hooks/token-goat-shim.js, <project>/.github/copilot-instructions.md)')
    .option('--grok', 'also register a Grok CLI (xAI Grok Build) hook config (~/.grok/hooks/token-goat.json, ~/.grok/hooks/token-goat-shim.js)')
    .option('--vscode', 'also configure the project-local VS Code MCP server and Copilot routing guidance')
    .option('--local', 'with --pi, install the project-local extension (<project>/.pi/extensions/token-goat.ts) instead of the global one')
    .action(guard(cmdInstall))

  program
    .command('uninstall')
    .description('remove token-goat hooks from Claude Code settings')
    .option('-p, --project', 'uninstall from project scope instead of user scope')
    .option('--codex', 'also strip the Codex CLI integration (~/.codex/config.toml, ~/.codex/AGENTS.md)')
    .option('--gemini', 'also strip the Gemini CLI integration (~/.gemini/settings.json)')
    .option('--qwen', 'also strip the Qwen Code integration (~/.qwen/settings.json)')
    .option('--pi', 'also remove the pi (pi-coding-agent) extension')
    .option('--opencode', 'also remove the opencode plugin')
    .option('--hermes', 'no-op verification flag for symmetry with install (removes no files)')
    .option('--openclaw', 'also remove the OpenClaw plugin and config entry')
    .option('--copilot', 'also remove the Copilot CLI hook config and shim script, and strip the token-goat block from ~/.copilot/copilot-instructions.md (or <project>/.github/copilot-instructions.md with --local)')
    .option('--grok', 'also remove the Grok CLI hook config and shim script')
    .option('--vscode', 'also remove the project-local VS Code MCP server and routing guidance')
    .option('--local', 'with --pi, remove the project-local extension instead of the global one')
    .action(guard(cmdUninstall))

  const worker = program.command('worker').description('background indexer lifecycle')
  worker.command('start').description('start the background indexer').action(guard(cmdWorkerStart))
  worker.command('stop').description('stop the background indexer').action(guard(cmdWorkerStop))
  worker.command('status').description('check if the indexer is running').action(guard(cmdWorkerStatus))

  program
    .command('stats')
    .description('show session statistics (bare = totals only; --full for the breakdown)')
    .option('-j, --json', 'output as JSON')
    .option('--full', 'show the full breakdown (by source, by command, by day)')
    .option('--short', 'force the rich short KPI view even when stdout is not a TTY (e.g. piped)')
    .option('--window-days <days>', 'days to include (0 = all time)', '30')
    .option('--home-dir <path>', 'home directory (for testing)')
    .action(guard(cmdStats))

  program
    .command('doctor')
    .description('diagnose token-goat health')
    .option('--context', 'include context footprint analysis')
    .option('--json', 'emit check results as JSON instead of text')
    .action(guard(cmdDoctor))
  program
    .command('context-stats')
    .description('show context statistics')
    .option('--project <path>', 'project root to analyze')
    .option('-j, --json', 'output as JSON')
    .option('--fix', 'apply automatic fixes (confirm-gated; shows a diff before writing)')
    .option('-y, --yes', 'with --fix, apply without prompting (non-interactive / scripted use)')
    .action(guard(cmdContextStats))

  program
    .command('bootstrap-audit')
    .description('audit Claude Code startup-context contributors without reading prompt bodies')
    .option('--project <path>', 'project root to analyze')
    .option('--home <path>', 'home directory override (for CI/testing)')
    .option('--follow-links', 'follow external symlink/junction roots and direct children')
    .option('-j, --json', 'output as JSON')
    .option('--top <n>', 'largest metadata entries to show (default 10)', '10')
    .option('--warn-tokens <n>', 'warn when total estimated startup tokens exceed n')
    .option('--fail-tokens <n>', 'fail when total estimated startup tokens exceed n')
    .option('--warn-bytes <n>', 'warn when agent/skill metadata bytes exceed n')
    .option('--fail-bytes <n>', 'fail when agent/skill metadata bytes exceed n')
    .action(guard(cmdBootstrapAudit))

  program
    .command('memory')
    .description('analyze CLAUDE.md files for duplicate/overlapping content (--fix to apply safe mechanical fixes)')
    .option('--project <path>', 'project root to analyze')
    .option('--analyze', 'report-only analysis (default)')
    .option('--fix', 'remove exact-duplicate lines (confirm-gated; shows a diff before writing)')
    .option('--yes', 'apply --fix changes without prompting (non-interactive)')
    .action(guard(cmdMemory))

  program
    .command('waste')
    .description('session spend-ledger: token cost per tool/file from the current Claude Code session transcript, plus waste signals')
    .option('--project <path>', 'project root to analyze')
    .option('--transcript <path>', 'explicit transcript JSONL path (default: most-recently-modified transcript for this project)')
    .option('--top <n>', 'number of top expensive tool calls to show (default: 10)')
    .option('--json', 'output JSON')
    .action(guard(cmdWaste))

  program
    .command('session-outline [session-id-or-path]')
    .description('turn-by-turn structure (role, preview, tool calls, approx size) of a Claude Code session JSONL transcript, instead of a raw Read; defaults to the current project\'s most recent session')
    .option('--project <path>', 'project root to resolve the session transcript against')
    .option('--json', 'output JSON')
    .action(guard(cmdSessionOutline))

  program
    .command('session-slice [session-id-or-path]')
    .description('full content of one turn range from a Claude Code session JSONL transcript (see session-outline for turn numbers), instead of a raw Read')
    .requiredOption('--range <spec>', 'turn range, e.g. 5-9 or 12 (see session-outline for turn numbers)')
    .option('--project <path>', 'project root to resolve the session transcript against')
    .option('--json', 'output JSON')
    .action(guard(cmdSessionSlice))

  program
    .command('mcp-audit')
    .description('MCP server schema cost-vs-usage report: estimate per-server token cost from cached tool calls')
    .option('--project <path>', 'project root to analyze')
    .option('--json', 'output JSON')
    .action(guard(cmdMcpAudit))

  program
    .command('recall [query]')
    .description('search across every cached bash-output, web-output, and mcp-output entry (full-text); with no query, list them newest-first')
    .option('--type <type>', 'filter to one cache type: bash, web, or mcp')
    .option('--limit <n>', 'max results to return (default: 10)')
    .option('--json', 'output JSON')
    .action(guard(cmdRecall))

  program
    .command('hint-stats')
    .description('per-category efficacy report for token-goat\'s discretionary hint hooks (emitted/acted-on/suppression)')
    .option('--json', 'output JSON')
    .option('--reset', 'clear all tracked emissions and manual marks')
    .option('--mark-effective <category>', 'record a manual "effective" vote for a hint category')
    .option('--mark-ineffective <category>', 'record a manual "ineffective" vote for a hint category')
    .action(guard(cmdHintStats))

  program
    .command('statusline')
    .description('render one line of terminal status text from a harness statusline payload on stdin (Claude Code statusLine.command)')
    .option('--json', 'emit the underlying data as JSON instead of a rendered line (debug)')
    .action(guard(cmdStatusline))

  program
    .command('bash-output [id]')
    .description('retrieve cached bash output by ID or file')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the output')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .option('--file <path>', 'read from raw output file instead of cache')
    .option('--transcript', 'parse the --file as a JSONL agent transcript: keep assistant text blocks in order before filtering')
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
    .action(guard(cmdWebOutput))

  program
    .command('mcp-output [id]')
    .description('retrieve a cached MCP tool result by ID (the id an MCP post_tool_use hook cached, or a `[token-goat: compressed, full via mcp-output <id>]` label points here)')
    .option('--head <n>', 'show first N lines')
    .option('--tail <n>', 'show last N lines')
    .option('--grep <pattern>', 'filter lines matching regex')
    .option('--max-matches <n>', 'cap --grep output to the first N matching lines')
    .option('--section <heading>', 'extract a specific section from the result')
    .option('--full', 'print the entire cached entry with no head/tail elision')
    .action(guard(cmdMcpOutput))

  program
    .command('exports <file> [more...]')
    .description('list exported (public) symbols in a file (also accepts a comma-separated file list "a,b,c" for one headed block per file)')
    .option('-j, --json', 'output as JSON')
    .action((file: string, more: string[], opts: { json?: boolean }) =>
      runExit(() => {
        emitExtraFileArgsNote('exports', file, more)
        return runExports({ file, ...(opts.json === true ? { json: true } : {}) })
      }),
    )

  program
    .command('imports <file> [more...]')
    .description('list the modules a file imports (also accepts a comma-separated file list "a,b,c" for one headed block per file)')
    .option('-j, --json', 'output as JSON')
    .action((file: string, more: string[], opts: { json?: boolean }) =>
      runExit(() => {
        emitExtraFileArgsNote('imports', file, more)
        return runImports({ file, ...(opts.json === true ? { json: true } : {}) })
      }),
    )

  program
    .command('find <pattern>')
    .description('find files containing a symbol matching a pattern')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results')
    .action((pattern: string, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runFind({
          pattern,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('grep <pattern> [paths...]')
    .description('regex search over files, caching nothing (session-aware grep)')
    .option('-j, --json', 'output as JSON')
    .option('--max-lines <n>', 'max matching lines to print')
    .option('--no-recursive', 'do not descend into subdirectories')
    .option('-C, --context <n>', 'lines of context to show before and after each match')
    .option('--symbol', 'annotate each hit with its enclosing symbol (name and kind)')
    .action((pattern: string, paths: string[] | undefined, opts: { json?: boolean; maxLines?: string; recursive?: boolean; context?: string; symbol?: boolean }) =>
      runExit(() =>
        runGrep({
          pattern,
          ...(paths !== undefined && paths.length > 0 ? { path: paths } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.maxLines !== undefined ? { maxLines: requirePositiveInt('--max-lines', opts.maxLines) } : {}),
          ...(opts.recursive === false ? { recursive: false } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.symbol === true ? { symbol: true } : {}),
        }),
      ),
    )

  program
    .command('skill-body <name>')
    .description("retrieve a skill's cached body")
    .option('-c, --compact', 'print compact slice instead of full body')
    .action(guard(cmdSkillBody))

  program
    .command('skill-compact [name]')
    .description('regenerate and cache compact slice for a skill')
    .option('--path <file>', 'read the skill body from this file instead of resolving by name')
    .option('--all', 'regenerate compacts for all skills, skipping fresh ones')
    .action(guard(cmdSkillCompact))

  program
    .command('skill-list')
    .description('list all cached skills with token counts')
    .option('-j, --json', 'output as JSON')
    .option('--session-id <id>', 'filter by session')
    .action(guard(cmdSkillList))

  program
    .command('skill-size')
    .description('show body/compact token counts per skill')
    .option('--session-id <id>', 'filter by session')
    .action(guard(cmdSkillSize))

  program
    .command('skill-history')
    .description('list cached skill versions newest-first')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdSkillHistory))

  program
    .command('skill-diff <name>')
    .description('show diff between two cached versions of a skill')
    .action(guard(cmdSkillDiff))

  program
    .command('skill-section <nameHeading> [headingArg]')
    .description('extract a named section from a skill')
    .action(guard(cmdSkillSection))

  program
    .command('callers <symbol>')
    .description('find all callers of a symbol, resolved to their enclosing function (accepts file::symbol to disambiguate which same-named definition is meant)')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max references to scan')
    .option('-C, --context <n>', 'lines of call-site source to show before and after each caller (default 0)')
    .option('--exclude-tests', 'hide callers whose call site lives in a test file (opt-in; default output is unchanged)')
    .action((symbol: string, opts: { json?: boolean; limit?: string; context?: string; excludeTests?: boolean }) =>
      runExit(() =>
        runCallers({
          symbol,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.context !== undefined ? { context: requireNonNegativeInt('--context', opts.context) } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
        }),
      ),
    )

  program
    .command('call-chain <symbol>')
    .description('transitive callers up toward entry points (BFS, cycle-safe; accepts file::symbol to disambiguate which same-named definition is meant)')
    .option('-d, --depth <n>', 'max BFS depth (default 8)')
    .option('-j, --json', 'output as JSON')
    .action((symbol: string, opts: { depth?: string; json?: boolean }) =>
      runExit(() =>
        runCallChain({
          symbol,
          ...(opts.depth !== undefined ? { depth: requireInt('--depth', opts.depth) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('impact <symbol>')
    .description('transitive set of callers impacted by a change (with hop depth; accepts file::symbol to disambiguate which same-named definition is meant)')
    .option('--top <n>', 'limit output to top N results')
    .option('-j, --json', 'output as JSON')
    .action((symbol: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runImpact({
          symbol,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('dead')
    .description('symbols with zero references (default kind: function)')
    .option('-k, --kind <kind>', 'symbol kind to check (function, method, class, ...)')
    .option('--include-private', 'include _-prefixed names')
    .option('--top <n>', 'limit output to top N results')
    .option('-j, --json', 'output as JSON')
    .option('--exclude-tests', 'hide dead symbols defined in a test file (opt-in; default output is unchanged)')
    .action((opts: { kind?: string; includePrivate?: boolean; top?: string; json?: boolean; excludeTests?: boolean }) =>
      runExit(() =>
        runDead({
          ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts.includePrivate === true ? { includePrivate: true } : {}),
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.excludeTests === true ? { excludeTests: true } : {}),
        }),
      ),
    )

  program
    .command('deps <file>')
    .description('one-level imports: resolves relative imports to project files, groups others as external')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runDeps({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('types [file]')
    .description('type-like declarations (type, interface, enum, struct, trait, and Python type classes)')
    .option('-j, --json', 'output as JSON')
    .option('-l, --limit <n>', 'max results per kind')
    .action((file: string | undefined, opts: { json?: boolean; limit?: string }) =>
      runExit(() =>
        runTypes({
          ...(file !== undefined ? { file } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
        }),
      ),
    )

  program
    .command('scope <fileColonLine>')
    .description('list symbols enclosing a file:line position, innermost first')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runScope({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('similar <spec>')
    .description('find symbols similar to a given "file::symbol" anchor using FTS (also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('--top <n>', 'max results (default 10)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runSimilar({
          spec,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('context-for <task>')
    .description('suggest token-goat read commands for symbols relevant to a task')
    .option('--top <n>', 'max results (default 12)')
    .option('--budget <n>', 'stop when estimated tokens exceed budget')
    .option('-j, --json', 'output as JSON')
    .action((task: string, opts: { top?: string; budget?: string; json?: boolean }) =>
      runExit(() =>
        runContextFor({
          task,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.budget !== undefined ? { budget: requireInt('--budget', opts.budget) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('test-for <file>')
    .description('list test files that reference symbols defined in a source file')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { json?: boolean }) =>
      runExit(() => runTestFor({ file, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('coverage-gaps')
    .description('functions and methods with no references in test files')
    .option('--top <n>', 'limit output to top N results (default 50)')
    .option('--include-private', 'include _-prefixed symbols')
    .option('-j, --json', 'output as JSON')
    .action((opts: { top?: string; includePrivate?: boolean; json?: boolean }) =>
      runExit(() =>
        runCoverageGaps({
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.includePrivate === true ? { includePrivate: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('arch')
    .description('internal import graph analysis: hubs, entry points, cycles')
    .option('--top <n>', 'limit hubs and entry points to top N (default 10)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runArch({
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('blame <spec>')
    .description('git blame for the line range of a symbol ("file::symbol"; also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, opts: { json?: boolean }) =>
      runExit(() => runBlame({ spec, ...(opts.json === true ? { json: true } : {}) })),
    )

  program
    .command('ask <question>')
    .description('(experimental) find relevant code context; synthesize with an LLM if TOKEN_GOAT_ASK_BACKEND is set')
    .option('--top <n>', 'max FTS hits to surface (default 8)')
    .option('-j, --json', 'output as JSON')
    .action((question: string, opts: { top?: string; json?: boolean }) =>
      runExit(() =>
        runAsk({
          question,
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('pack [patterns...]')
    .description('bundle matched files into a single LLM-ready output (Markdown, XML, or plain text)')
    .option('--format <style>', 'output style: md (default), xml, or text', 'md')
    .option('--line-numbers', 'prefix each line with its line number')
    .option('--instruction-file <path>', 'append a task prompt from a file')
    .option('--output <path>', 'write output to a file instead of stdout')
    .option('--no-ignore', 'bypass .tokengoatignore patterns')
    .option('--strip-comments', 'remove language-appropriate comments before packing')
    .option('--scan-secrets', 'scan for credentials; exit 2 if any are found')
    .option('--budget <n>', 'exit 3 if the estimated token count exceeds n')
    .action(guard(cmdPack))

  program
    .command('tokens [patterns...]')
    .description('per-file token footprint table, sorted largest-first')
    .option('--tree', 'group by directory with subtotals and percentage of total')
    .option('--top <n>', 'limit to the N biggest files')
    .option('--asc', 'reverse order (ascending)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdTokens))

  program
    .command('budget <patterns...>')
    .description('estimate the total token cost of a file set')
    .option('--context <n>', 'context window in thousands of tokens (shows % fill)')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdBudget))

  program
    .command('failures [src]')
    .description('extract failing test blocks from test runner output (pytest, Jest, Go, Cargo)')
    .option('--runner <name>', 'runner hint: pytest, jest, go, or cargo')
    .option('--delta', 'compare against the previously saved failure set for this project (see --key) and report only newly-failing/newly-fixed tests, with still-failing tests as a count')
    .option('--key <name>', 'scope the --delta baseline to a named suite (default: "default"); use distinct keys to track multiple independent suites in the same project')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdFailures))

  program
    .command('todo [patterns...]')
    .description('scan source files for TODO/FIXME/HACK/XXX/NOTE markers')
    .option('--group <by>', 'group output by file or kind (default: file)')
    .option('--kinds <csv>', 'comma-separated marker kinds to include (default: TODO,FIXME,HACK,XXX,NOTE)')
    .option('-j, --json', 'output as JSON')
    .action((patterns: string[], opts: { group?: string; kinds?: string; json?: boolean }) =>
      guard(() => cmdTodo(patterns, opts))(),
    )

  program
    .command('trace [src]')
    .description('condense a Python traceback to project frames only')
    .option('--keep <n>', 'keep last N project frames (default: all)')
    .option('--bodies', 'resolve each frame to its enclosing symbol and include the full body inline')
    .option('-j, --json', 'output as JSON')
    .action((src: string | undefined, opts: { keep?: string; bodies?: boolean; json?: boolean }) =>
      guard(() => cmdTrace(src, opts))(),
    )

  program
    .command('logfold [src]')
    .description('apply log-noise filters then fold consecutive duplicate lines')
    .option('--tail <n>', 'only process the last N lines of input')
    .option('--no-normalize', 'skip volatile-token normalization (still applies filters and folds)')
    .option('--fold-repeats', 'also fold non-consecutive duplicate lines, attributing the total count to the first occurrence')
    .option('-j, --json', 'output as JSON')
    .action(
      (src: string | undefined, opts: { tail?: string; normalize?: boolean; foldRepeats?: boolean; json?: boolean }) =>
        guard(() =>
          cmdLogfold(src, { tail: opts.tail, noNormalize: opts.normalize === false, foldRepeats: opts.foldRepeats, json: opts.json }),
        )(),
    )

  program
    .command('lockdeps [path]')
    .description('summarize a dependency lockfile (auto-detects package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, uv.lock, Pipfile.lock, Cargo.lock, requirements*.txt)')
    .option('-j, --json', 'output as JSON')
    .option('--package <name>', 'query one package only: its resolved version, direct dependencies, and which direct project dependencies depend on it (npm lockfiles only expose the dependency graph)')
    .action((filePath: string | undefined, opts: { json?: boolean; package?: string }) =>
      guard(() => cmdLockdeps(filePath, opts))(),
    )

  program
    .command('dep-docs <package>')
    .description(
      "extract one installed npm package's README, package.json metadata, and (if resolvable) a compact .d.ts signature outline instead of grepping node_modules",
    )
    .option('-j, --json', 'output as JSON')
    .option('--project <path>', 'project root to resolve node_modules against (defaults to cwd)')
    .action((packageName: string, opts: { json?: boolean; project?: string }) =>
      runExitText(() =>
        runDepDocs({
          packageName,
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.project !== undefined ? { projectRoot: opts.project } : {}),
        }),
      ),
    )

  program
    .command('note <action> [key] [value]')
    .description('per-project key-value notes (actions: set, get, unset, list, clear)')
    .option('-j, --json', 'output as JSON (list action only)')
    .action((action: string, key: string | undefined, value: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdNote(action, key, value, opts))(),
    )

  program
    .command('hot')
    .description('show most-read files across all sessions (current session: use `recent`)')
    .option('-l, --limit <n>', 'max results (default: 20)')
    .option('--project', 'filter to files under the current project root')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; project?: boolean; json?: boolean }) =>
      guard(() => cmdHot(opts))(),
    )

  program
    .command('recent [n]')
    .description('show N most-recently read/edited files in the current session (cross-session: use `hot`)')
    .option('-j, --json', 'output as JSON')
    .action((n: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdRecent(n, opts))(),
    )

  program
    .command('ignores')
    .description('report active file-exclusion settings (walk mode, built-ins, blocked_roots, exclude_tests)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) =>
      guard(() => cmdIgnores(opts))(),
    )


  program
    .command('bash-history')
    .description('list cached bash output entries, newest first')
    .option('-l, --limit <n>', 'max results (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdBashHistory(opts))())

  program
    .command('web-history')
    .description('list cached web-fetch output entries, newest first')
    .option('-l, --limit <n>', 'max results (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdWebHistory(opts))())

  program
    .command('mcp-history')
    .description('list cached MCP tool result entries, newest first')
    .option('-l, --limit <n>', 'max results (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdMcpHistory(opts))())

  program
    .command('reclaim-index')
    .description('shrink an oversized symbol index: VACUUM, or --rebuild to drop derived rows so the next index run re-derives them')
    .option('--rebuild', 'also drop all derived rows (files/symbols/refs/chunks) so the next `token-goat index` reparses from scratch under current parser rules')
    .option('--db-path <path>', 'index database to reclaim (default: the global index)')
    .option('--force', 'proceed even if the worker daemon appears to be running')
    .option('-j, --json', 'output as JSON')
    .action((opts: { rebuild?: boolean; dbPath?: string; json?: boolean; force?: boolean }) =>
      guard(() => cmdReclaimIndex(opts))(),
    )

  program
    .command('clean-cache')
    .description('prune all cache subdirs to default retention limits (200 entries, 24 h)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) => guard(() => cmdCleanCache(opts))())

  program
    .command('prune-cache')
    .description('evict cache entries older than --max-age-hours or beyond --max-count (caller-specified bounds)')
    .option('--max-count <n>', 'max entries to keep per subdir (default: 200)')
    .option('--max-age-hours <h>', 'max age in hours to keep (default: 24)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { maxCount?: string; maxAgeHours?: string; json?: boolean }) => guard(() => cmdPruneCache(opts))())

  program
    .command('cache-audit')
    .description('check settings.json hook installation and env-var gates that defeat token-goat caching')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) => guard(() => cmdCacheAudit(opts))())

  program
    .command('resume <session-id>')
    .description('print a recovery context packet for the given session id')
    .option('-j, --json', 'output as JSON')
    .action((sessionId: string, opts: { json?: boolean }) => guard(() => cmdResume({ sessionId, ...opts }))())

  program
    .command('compact-hint')
    .description('show compact manifest info and context pressure (reuses compact.ts — does not rebuild the manifest)')
    .option('--session-id <id>', 'session id to inspect (default: latest)')
    .option('--trigger <mode>', 'set to "auto" to preview autocompact budget')
    .option('-j, --json', 'output as JSON')
    .action((opts: { sessionId?: string; trigger?: string; json?: boolean }) => guard(() => cmdCompactHint(opts))())

  program
    .command('session-summary')
    .description('one-screen summary of the latest cached session: file counts, top files, session id')
    .option('-j, --json', 'output as JSON')
    .action((opts: { json?: boolean }) => guard(() => cmdSessionSummary(opts))())

  program
    .command('cost')
    .description('tokens-saved / cost breakdown (thin framing over stats; --session narrows to current session)')
    .option('--session', 'show session-level file stats only')
    .option('-j, --json', 'output as JSON')
    .action((opts: { session?: boolean; json?: boolean }) => guard(() => cmdCost(opts))())

  program
    .command('baseline')
    .description('emit the project baseline map (file count, languages, top symbols, recent files)')
    .option('--subagent', 'emit terser compact variant for subagent context')
    .option('--suggest-mem', 'also scan CLAUDE.md/AGENTS.md for preference-shaped bullets and suggest `mem import --from-md` (advisory only; never invokes mem)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { subagent?: boolean; json?: boolean; suggestMem?: boolean }) => guard(() => cmdBaseline(opts))())

  program
    .command('config <action> [key] [value]')
    .description('manage token-goat config (list|get|set|validate). Operates on the token-goat config.toml, not a project config file.')
    .option('-j, --json', 'output as JSON')
    .action((action: string, key: string | undefined, value: string | undefined, opts: { json?: boolean }) =>
      guard(() => cmdConfig({ action, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('project <action> [path]')
    .description('manage indexed project roots (list|exclude|prune). list = active project + blocked roots; exclude <path> = add to block list; prune = remove stale entries.')
    .option('-j, --json', 'output as JSON')
    .option('--dry-run', 'with prune, preview removals without touching the config file')
    .action((action: string, pathArg: string | undefined, opts: { json?: boolean; dryRun?: boolean }) =>
      guard(() =>
        cmdProject({
          action,
          ...(pathArg !== undefined ? { pathArg } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        }),
      )())

  program
    .command('compact-doc <path>')
    .description('build/refresh an extractive compact sidecar for a document; pre_read serves it in place of the full file when fresh. --heading is a legacy mode that extracts one section via a `<!-- COMPACT_END -->` marker instead.')
    .option('--heading <heading>', 'legacy mode: compact only the named section (COMPACT_END marker)')
    .option('--force', 'rebuild the sidecar even if a fresh one already exists')
    .option('--sentences <n>', 'sentences to keep per section (default: 2)')
    .option('--show', 'print the sidecar content to stdout')
    .option('-j, --json', 'output as JSON')
    .action((filePath: string, opts: { heading?: string; json?: boolean; force?: boolean; sentences?: string; show?: boolean }) =>
      guard(() => cmdCompactDoc({
        filePath,
        ...(opts.heading !== undefined ? { heading: opts.heading } : {}),
        ...(opts.json === true ? { json: true } : {}),
        ...(opts.force === true ? { force: true } : {}),
        ...(opts.sentences !== undefined ? { sentences: opts.sentences } : {}),
        ...(opts.show === true ? { show: true } : {}),
      }))())

  program
    .command('fetch-image <url>')
    .description('fetch an image URL and shrink it (saves to --out path or a temp file)')
    .option('--out <path>', 'output file path')
    .option('-j, --json', 'output as JSON')
    .action((url: string, opts: { out?: string; json?: boolean }) =>
      guard(() => cmdFetchImage({ url, ...(opts.out !== undefined ? { out: opts.out } : {}), ...(opts.json === true ? { json: true } : {}) }))())

  program
    .command('history')
    .description('show recent session history: bash commands and web fetches (current-session or recent cache)')
    .option('--limit <n>', 'max entries to show (default: 30)')
    .option('-j, --json', 'output as JSON')
    .action((opts: { limit?: string; json?: boolean }) => guard(() => cmdHistory(opts))())

  program
    .command('changed [ref]')
    .description('list files or symbols changed since a git ref')
    .option('--since <ref>', 'git ref to compare against (default: HEAD~5)')
    .option('--symbol', 'list symbols instead of files')
    .option('-j, --json', 'output as JSON')
    .action((ref: string | undefined, opts: { since?: string; symbol?: boolean; json?: boolean }) =>
      runExit(() =>
        runChanged({
          ref: opts.since ?? ref ?? 'HEAD~5',
          ...(opts.symbol === true ? { symbolMode: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('diff <spec> [ref]')
    .description('show only the git diff hunk(s) that fall within one symbol\'s line range, e.g. `token-goat diff "file.ts::myFn" HEAD~3..HEAD` (also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, ref: string | undefined, opts: { json?: boolean }) =>
      runExit(() =>
        runDiff({
          spec,
          ...(ref !== undefined ? { ref } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('log <spec> [ref]')
    .description('show git commit history scoped to one symbol\'s line range, e.g. `token-goat log "file.ts::myFn" HEAD~10` (also accepts the file::symbol@LINE anchor form documented under `read`)')
    .option('--max-count <n>', 'maximum number of commits to show (default 20)')
    .option('-j, --json', 'output as JSON')
    .action((spec: string, ref: string | undefined, opts: { maxCount?: string; json?: boolean }) =>
      runExit(() =>
        runLog({
          spec,
          ...(ref !== undefined ? { ref } : {}),
          ...(opts.maxCount !== undefined ? { maxCount: requireNonNegativeInt('--max-count', opts.maxCount) } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('config-get <file> <key>')
    .description('read one value from a config file (TOML/JSON/YAML/INI)')
    .action((file: string, key: string) => runExit(() => runConfigGet({ file, key })))

  program
    .command('pdf-extract <file>')
    .description('extract plain text from a PDF (optionally --pages N or N-M) instead of a raw Read')
    .option('--pages <spec>', 'page range to extract, e.g. 1-5 or 3 (default: all pages)')
    .option('--layout', 'heuristic column-aware reading-order reconstruction from text-item coordinates (imperfect on rotated/overlapping text)')
    .option('--head <n>', 'show only the first N lines')
    .option('--tail <n>', 'show only the last N lines')
    .option('--grep <pattern>', 'filter to lines matching this regex')
    .option('--section <heading>', 'extract one markdown section by heading')
    .option('--max-matches <n>', 'cap the number of --grep matches shown')
    .action(guard(cmdPdfExtract))

  program
    .command('pdf-outline <file>')
    .description('list a PDF\'s bookmark/outline tree with page numbers instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPdfOutline))

  program
    .command('pdf-meta <file>')
    .description('page count, title/author, and whether a PDF has an extractable text layer')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPdfMeta))

  program
    .command('sharepoint-resolve <shareUrl>')
    .description('best-effort resolve a SharePoint/OneDrive sharing URL to a local synced file path (no network call)')
    .action(guard(cmdSharepointResolve))

  program
    .command('video-chapters <file>')
    .description('list a video\'s embedded chapter markers and subtitle streams via ffprobe, instead of downloading/transcoding it')
    .action(guard(cmdVideoChapters))

  program
    .command('xlsx-sheets <file>')
    .description('list sheet names + used range/dimensions in an Excel workbook instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdXlsxSheets))

  program
    .command('xlsx-head <file>')
    .description('preview the header + first N rows of one sheet instead of a raw Read')
    .requiredOption('--sheet <name>', 'sheet name (see xlsx-sheets)')
    .option('--rows <n>', 'number of data rows to show (default 20)')
    .action(guard(cmdXlsxHead))

  program
    .command('xlsx-range <file>')
    .description('extract one cell range (e.g. A1:D50) from a sheet instead of a raw Read')
    .requiredOption('--sheet <name>', 'sheet name (see xlsx-sheets)')
    .requiredOption('--range <a1-notation>', 'cell range, e.g. A1:D50')
    .option('--formulas', 'show formulas instead of computed values where present')
    .action(guard(cmdXlsxRange))

  program
    .command('xlsx-query <file>')
    .description('project columns / filter rows from one sheet instead of a raw Read')
    .requiredOption('--sheet <name>', 'sheet name (see xlsx-sheets)')
    .option('--columns <a,b,c>', 'comma-separated columns to project (default: all)')
    .option(
      '--where <spec>',
      'filter, repeatable (ANDed): col=value, col!=value, col>value, col<value, col~=regex',
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option('--head <n>', 'max rows to show')
    .action(guard(cmdXlsxQuery))

  program
    .command('pptx-outline <file>')
    .description('per-slide title + body size + notes flag instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdPptxOutline))

  program
    .command('pptx-slide <file>')
    .description('full text of one slide instead of a raw Read')
    .requiredOption('--slide <n>', 'slide number (see pptx-outline)')
    .option('--notes', 'include this slide\'s speaker notes')
    .action(guard(cmdPptxSlide))

  program
    .command('pptx-notes <file>')
    .description('speaker notes for one slide, or all slides, instead of a raw Read')
    .option('--slide <n>', 'slide number (default: all slides)')
    .action(guard(cmdPptxNotes))

  program
    .command('pptx-text <file>')
    .description('find slides whose text matches a pattern instead of a raw Read')
    .requiredOption('--grep <pattern>', 'regex to search slide text for')
    .action(guard(cmdPptxText))

  program
    .command('docx-outline <file>')
    .description('heading tree of a Word document instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdDocxOutline))

  program
    .command('docx-text <file>')
    .description('full body text of a Word document instead of a raw Read')
    .option('--head <n>', 'show only the first N lines')
    .option('--tail <n>', 'show only the last N lines')
    .option('--grep <pattern>', 'filter to lines matching this regex')
    .option('--section <heading>', 'extract one markdown section by heading')
    .option('--max-matches <n>', 'cap the number of --grep matches shown')
    .action(guard(cmdDocxText))

  program
    .command('transcript-outline <file>')
    .description('speaker list, duration, and time-bucketed markers for a WebVTT/SRT transcript instead of a raw Read')
    .option('-j, --json', 'output as JSON')
    .action(guard(cmdTranscriptOutline))

  program
    .command('transcript <file>')
    .description('slice a WebVTT/SRT transcript by speaker/time range/pattern instead of a raw Read')
    .option('--speaker <name>', 'only cues from this speaker')
    .option('--from <hh:mm:ss>', 'only cues starting at or after this time')
    .option('--to <hh:mm:ss>', 'only cues starting at or before this time')
    .option('--grep <pattern>', 'only cues whose text matches this regex')
    .action(guard(cmdTranscript))

  program
    .command('csv-query <file>')
    .description('project columns / filter rows from a CSV instead of a raw Read')
    .option('--columns <cols>', 'comma-separated column names to include (default: all)')
    .option(
      '--where <spec>',
      'filter, repeatable (ANDed): col=value, col!=value, col>value, col<value, col~=regex',
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option('--head <n>', 'limit to the first N matching rows')
    .option('--json', 'emit rows as a JSON array of objects instead of CSV')
    .option('--delimiter <char>', 'field delimiter (default: ,)')
    .option('--no-header', 'treat the first row as data, not a header (columns become col1, col2, ...)')
    .action(guard(cmdCsvQuery))

  program
    .command('csv-profile <file>')
    .description('per-column type/null/distinct/range summary of a CSV instead of a raw Read')
    .option('--delimiter <char>', 'field delimiter (default: ,)')
    .option('--no-header', 'treat the first row as data, not a header (columns become col1, col2, ...)')
    .action(guard(cmdCsvProfile))

  program
    .command('json-outline <file>')
    .description('structural summary of a JSON document (array shape / object key types) instead of a raw Read')
    .option('--json', 'emit the outline as JSON instead of text')
    .action(guard(cmdJsonOutline))

  program
    .command('json-query <file> <path>')
    .description(
      "extract one value or a projected/filtered subset from a JSON document by dot-path instead of a raw Read\n\n" +
        "path grammar: dot-separated keys with optional bracket segments -- [n] index, [*] wildcard " +
        '(projects every element/value), [field=value] filter (keeps array elements whose field ' +
        "stringifies to value). Examples: data.items[3].name, items[*].id, items[status=active]",
    )
    .option('--head <n>', 'limit a projected/filtered result to the first N items')
    .option('--json', 'emit the result as JSON instead of text')
    .action(guard(cmdJsonQuery))

  program
    .command('yaml-outline <file>')
    .description('structural summary of a YAML document (array shape / object key types) instead of a raw Read -- multi-document streams (---separated) outline as an array of documents')
    .option('--json', 'emit the outline as JSON instead of text')
    .action(guard(cmdYamlOutline))

  program
    .command('yaml-query <file> <path>')
    .description(
      "extract one value or a projected/filtered subset from a YAML document by dot-path instead of a raw Read (same grammar as json-query)\n\n" +
        "path grammar: dot-separated keys with optional bracket segments -- [n] index, [*] wildcard " +
        '(projects every element/value), [field=value] filter (keeps array elements whose field ' +
        "stringifies to value). Examples: spec.containers[0].image, items[*].name, items[kind=Service]",
    )
    .option('--head <n>', 'limit a projected/filtered result to the first N items')
    .option('--json', 'emit the result as JSON instead of text')
    .action(guard(cmdYamlQuery))

  program
    .command('openapi-outline <file>')
    .description('per-operation listing (method, path, operationId, summary, tags) of an OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML) instead of a raw Read')
    .option('--json', 'emit the operation list as JSON instead of text')
    .action(guard(cmdOpenApiOutline))

  program
    .command('openapi-op <file> <operation>')
    .description(
      'full detail (parameters, request body schema, response schemas, description) for exactly one OpenAPI operation instead of a raw Read\n\n' +
        "operation may be an operationId (exact match) or a \"METHOD path\" spec, e.g. \"GET /users/{id}\"",
    )
    .option('--json', 'emit the operation detail as JSON instead of text')
    .action(guard(cmdOpenApiOp))

  program
    .command('zip-list <archive>')
    .description(
      'entry paths and sizes inside a zip-format archive (.zip/.jar/.whl/.vsix/.nupkg are all zip containers under the hood) ' +
        'instead of a raw Read or an unzip -l shell-out',
    )
    .option('--json', 'emit the entry list as JSON instead of text')
    .action(guard(cmdZipList))

  program
    .command('zip-read <archive> <entry>')
    .description(
      "extract and print exactly one entry's text content from a zip-format archive by its in-archive path instead of extracting the whole archive to disk",
    )
    .option('--json', 'emit the entry content as JSON instead of text')
    .action(guard(cmdZipRead))

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

  program
    .command('sqlite-schema <file>')
    .description('tables/views, columns, indexes, foreign keys, and row counts of a SQLite database instead of a raw Read')
    .option('--json', 'emit the schema as JSON instead of text')
    .action(guard(cmdSqliteSchema))

  program
    .command('sqlite-query <file> <sql>')
    .description('run a read-only SELECT against a SQLite database instead of a raw Read or shelling out to sqlite3 -- rejects any non-SELECT statement')
    .option('--head <n>', 'limit to the first N returned rows')
    .option('--json', 'emit rows as a JSON array of objects instead of a table')
    .action(guard(cmdSqliteQuery))

  program
    .command('coverage-report-gaps <file>')
    .description(
      'uncovered lines/functions/branches from a code-coverage report instead of a raw Read\n\n' +
        'supports LCOV .info text and Istanbul/nyc JSON (coverage-final.json for per-line/function/branch detail, ' +
        'coverage-summary.json for file-level aggregate counts only); format is auto-detected from content, not the filename',
    )
    .option('--file <path>', "narrow to one source file's gaps (matched exact or as a path suffix against the report's own file keys)")
    .option('--json', 'emit the gap report as JSON instead of text')
    .action(guard(cmdCoverageReportGaps))

  program
    .command('conflicts [path]')
    .description(
      'unresolved git merge-conflict markers (<<<<<<< / ||||||| / ======= / >>>>>>>, two-way or diff3 three-way) instead of a raw Read or grep\n\n' +
        'path may be a single file, a directory (scanned recursively), or omitted entirely (scans the whole project from the current directory); ' +
        'only files with at least one conflict region or malformed-marker warning are reported',
    )
    .option('--summary', 'line ranges and ours/base/theirs labels only, omitting the conflict content')
    .option('--json', 'emit the results as JSON instead of text')
    .action(guard(cmdConflicts))

  program
    .command('screenshot <url> <destPath>')
    .description('capture a local headless-browser screenshot, shrunk the same way local image reads are')
    .option('--executable-path <path>', 'Chrome/Chromium executable to launch (overrides config/auto-detect)')
    .option('--width <n>', 'viewport width in pixels (default: 1280)')
    .option('--height <n>', 'viewport height in pixels (default: 800)')
    .option('--full-page', 'capture the full scrollable page instead of just the viewport')
    .action(guard(cmdScreenshot))

  program
    .command('write-file <dest>')
    .description('write exact bytes to a file — handles backticks, quotes, $vars, CRLF without escaping\n\nModes: --b64 PAYLOAD (base64), --from SOURCE (copy file), or piped stdin')
    .option('--from <source>', 'copy bytes from this source file instead of stdin/base64')
    .option('--b64 <payload>', 'decode base64 payload and write to dest')
    .action(guard(cmdWriteFile))

  program
    .command('replace <file>')
    .description('replace one string in a file; supply old/new text via --old-from/--new-from or --old-b64/--new-b64, and use --all to replace every occurrence')
    .option('--old-from <source>', 'read the old text from this source file')
    .option('--new-from <source>', 'read the new text from this source file')
    .option('--old-b64 <payload>', 'base64 payload for the old text')
    .option('--new-b64 <payload>', 'base64 payload for the new text')
    .option('--all', 'replace every occurrence instead of requiring a unique match')
    .option(
      '--normalize-newlines',
      'convert the old/new text\'s line endings (CRLF/LF) to match the target file\'s dominant line ending before matching, instead of requiring a byte-exact line-ending match',
    )
    .action(guard(cmdReplace))

  program
    .command('insert-section <file>')
    .description(
      'insert content immediately after a matched section (spec resolved the same way as `section`: exact heading, or an unambiguous prefix), avoiding a stale byte-exact anchor for append-to-a-running-log edits',
    )
    .requiredOption('--after <heading>', 'heading text (or unambiguous prefix) to insert after')
    .option('--content-from <source>', 'read the content to insert from this source file')
    .option('--content-b64 <payload>', 'base64 payload for the content to insert')
    .action(guard(cmdInsertSection))

  program
    .command('note-add <file>')
    .description(
      'attach a free-text architecture note to a file, or to one specific indexed symbol within it (--symbol NAME), fingerprinting what the note describes so `note-list --stale-only` can flag it once the code changes',
    )
    .option('--symbol <name>', 'attach the note to one indexed symbol in the file instead of the whole file')
    .option('--content-from <source>', 'read the note content (Markdown) from this source file')
    .option('--content-b64 <payload>', 'base64 payload for the note content')
    .action(guard(cmdNoteAdd))

  program
    .command('note-get <file>')
    .description('read back the note attached to a file, or to one indexed symbol within it (--symbol NAME); flags whether it has gone stale since it was written')
    .option('--symbol <name>', 'read the note attached to this indexed symbol instead of the whole-file note')
    .option('-j, --json', 'output as JSON')
    .action((file: string, opts: { symbol?: string; json?: boolean }) =>
      runExitText(() =>
        runNoteGet({
          file,
          ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('note-list')
    .description('list every recorded architecture note; --stale-only shows just the notes whose attached file/symbol changed since they were written')
    .option('--stale-only', 'only list notes whose fingerprint no longer matches the current index')
    .option('-j, --json', 'output as JSON')
    .action((opts: { staleOnly?: boolean; json?: boolean }) =>
      runExitText(() =>
        runNoteList({
          ...(opts.staleOnly === true ? { staleOnly: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
    )

  program
    .command('gdrive-sections <file-id>')
    .description('fetch and list sections from a public Google Doc')
    .option('--heading <name>', 'get content of one named section')
    .option('--fresh', 'skip the on-disk cache and force a live fetch')
    .action(guard(cmdGdriveSections))

  program
    .command('compress')
    .alias('bash')
    .alias('run')
    .description('run a shell command and emit a compressed view of its output')
    .requiredOption('-c, --cmd <command>', 'the shell command to run, as one string')
    .option('-f, --filter <name>', 'filter name (auto-detected from the command when omitted)')
    .option('--timeout <seconds>', 'wall-clock timeout in seconds (0 = built-in default)')
    .option('--no-compress', 'stream output raw without compression (debug the wrapper)')
    .option('--profile <name>', 'compression profile: aggressive | balanced | minimal')
    .option('--max-tokens <n>', 'post-compress token cap (0 = no cap)')
    .action(cmdCompress)

  program
    .command('version')
    .description('print the token-goat version')
    .action(
      guard(() => {
        out(VERSION)
      }),
    )

  return program
}

/**
 * Parse `argv` and dispatch. Sets `process.exitCode`; callers (main.ts) should
 * let the process exit naturally so buffered stdout flushes first.
 */
export async function run(argv: string[] = process.argv): Promise<void> {
  // `--worker-daemon` is how startDetachedWorker's spawned child is invoked (see worker.ts): `spawn(node, [thisModule, '--worker-daemon'])`, i.e. always argv[2]. It is not a registered commander option or command anywhere in buildProgram, so it must be intercepted here, before parseAsync ever sees argv -- otherwise commander rejects it as an unknown option and the freshly-spawned daemon child exits immediately, silently disabling the entire detached background-indexing feature (`token-goat worker start`). Checking only argv[2] (rather than "anywhere in argv") avoids hijacking an unrelated command that merely carries that literal string as one of its own arguments, e.g. `token-goat grep -- --worker-daemon`.
  if (argv[2] === '--worker-daemon') {
    runDetachedWorkerDaemon()
    return
  }
  const program = buildProgram()
  // Commander's exitOverride lets us catch its internal exits (help, version, unknown command) instead of letting it call process.exit() mid-flush.
  program.exitOverride()
  try {
    await program.parseAsync(argv)
  } catch (e) {
    // Help / version requests throw with these codes and are not errors.
    const code = (e as { code?: string }).code
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') {
      process.exitCode = 0
      return
    }
    if (code === 'commander.unknownCommand' || code === 'commander.missingArgument') {
      // Commander already wrote its diagnostic to stderr. Its "(Did you mean X?)" is edit distance over the registered names, which misfires on a conceptual miss rather than a typo -- `search` resolves to `arch`. Append an intent-based pointer for the handful of names a caller reaches for when they know what they want but not what it is called; commander's own line is left exactly as it was.
      if (code === 'commander.unknownCommand') {
        const attempted = attemptedCommandName(argv)
        const hint = attempted === null ? null : suggestForUnknownCommand(attempted)
        if (hint !== null) err(`Looking for that? Try ${hint}.`)
      }
      process.exitCode = 1
      return
    }
    const msg = extractErrorMessage(e)
    err(`token-goat: ${msg}`)
    process.exitCode = 1
  }
}
