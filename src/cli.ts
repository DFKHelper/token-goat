import { Command } from 'commander'
import { attemptedCommandName, suggestForUnknownCommand } from './command_intent.js'
import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
// Type-only imports: erased at compile time, so referencing them here does not eagerly load mcp_server.js (and transitively the whole MCP protocol layer and zod) at CLI startup. The runtime values are lazy-imported only inside cmdMcpServe.
import type { createMcpServer as CreateMcpServerFn } from './mcp_server.js'
import type { StdioServerTransport as StdioServerTransportClass } from './mcp_stdio.js'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved, MAX_FILES_SCANNED } from './baseline.js'
import { recordStat, savedTokensFromBytes, _useRichStats } from './stats.js'
import { UNTRUSTED_TOOL_TAG, UNTRUSTED_WEB_TAG } from './injection_scan.js'
import { fenceUntrusted } from './untrusted_fence.js'
import { redactSecrets } from './secret_redact.js'
import { compileGuardedRegex } from './regex_guard.js'
import { getTrackedFiles } from './repomap.js'
import { collectWalkIndexFiles, MAX_FILES_SCANNED_FORCED } from './walk_index.js'
import { ENV_KEYS, globalDbPath, VERSION } from './constants.js'
import { getSessionId } from './session.js'
import { indexFileSync, indexFileEmbeddings, indexedPathSpellingIsStale, isEmbedFresh, isParseSkipEligible, loadRegexExtractors } from './parser.js'
import { PARSER_FINGERPRINT } from './parser_fingerprint.js'
import { embeddingsDepsAvailable, ensureEmbeddingProvenance } from './embeddings.js'
import { getDb } from './db.js'
import { pruneDeletedFiles, removeFileFromIndex } from './index_prune.js'
import { fingerprintFile } from './fingerprint.js'
import { getFileEntry } from './index_reader.js'
import { detectLanguageOfFile } from './parser_types.js'
import { isEmbeddableDocument } from './doc_embed_extract.js'
import { displaySafePath, displaySafeText, resolveIndexPath, displaySafeJson } from './paths.js'
import { resolveProjectRoot } from './project.js'
import {
  installHooks,
  isInstalled,
  uninstallHooks,
  installClaudeMd,
  uninstallClaudeMd,
  findStrayClaudeMdBlocks,
  installSkill,
  uninstallSkill,
  settingsPath,
} from './install.js'
import type { HookScope } from './install.js'
import { installCodex, isCodexInstalled, uninstallCodex } from './bridges/codex_install.js'
import { installGemini, isGeminiInstalled, uninstallGemini } from './bridges/gemini_install.js'
import { installQwen, isQwenInstalled, uninstallQwen } from './bridges/qwen_install.js'
import { installKimi, isKimiInstalled, uninstallKimi } from './bridges/kimi_install.js'
import { installPi, isPiInstalled, uninstallPi } from './bridges/pi_install.js'
import { installOpencode, isOpencodeInstalled, uninstallOpencode } from './bridges/opencode_install.js'
import { installOpenclaw, isOpenclawInstalled, uninstallOpenclaw } from './bridges/openclaw_install.js'
import { HOOKS_SCRIPT_FILE, installCopilotCli, isCopilotCliInstalled, uninstallCopilotCli } from './bridges/copilot_cli_install.js'
import { installGrok, isGrokInstalled, uninstallGrok } from './bridges/grok_install.js'
import { installVscode, otherScopeHasManagedServer, uninstallVscode, vscodeDecoderConfigured, vscodeScopeFromFlags, vscodeUsesClaudeHooks } from './bridges/vscode_install.js'
import { installCursor, isCursorInstalled, uninstallCursor } from './bridges/cursor_install.js'
import { installZed, isZedInstalled, uninstallZed } from './bridges/zed_install.js'
import { installVisualStudio, isVisualStudioInstalled, uninstallVisualStudio, visualStudioDuplicateNote, visualStudioMcpStatus, visualStudioOtherScopeHasManagedServer } from './bridges/visualstudio_install.js'
import { VSCODE_DOUBLE_FIRE_NOTE, VSCODE_PROJECT_SCOPE_COVERAGE_NOTE, VSCODE_USER_SCOPE_MIGRATED_NOTE, VSCODE_USER_SCOPE_MULTIROOT_NOTE } from './cli_doctor.js'
import {
  isWorkerRunning,
  runDetachedWorkerDaemon,
  startDetachedWorker,
  stopWorker,
  WorkerAlreadyRunningError,
} from './worker.js'
import { getBashOutput } from './bash_output_cache.js'
import { getWebOutput, getWebOutputRaw } from './web_cache.js'
// Loaded on demand inside cmdCompress, not at module scope: bash_runner pulls in the whole bash
// tool-filter registry (every language, linter, cloud and package-manager filter), which only the
// compress command ever uses. See the same reasoning for relay in cmdHook.
import {
  runSymbol,
  runRead,
  runBrief,
  runSection,
  runListSections,
  runRefs,
  runSkeleton,
  runOutline,
  type SkeletonOptions,
  runPrSlice,
  extractTranscriptText,
  extractSection,
  runSemantic,
  guardJsonRows,
} from './read_commands.js'
import { queryJson } from './json_query.js'
import {
  runExit,
  runExitText,
  noteExtraFileArgs,
  emitExtraFileArgsNote,
} from './cli_dispatch.js'
import { generateCompactHelp } from './cli_help.js'
import { registerFormatCommands } from './cli_cmd_formats.js'
import { registerAnalysisCommands } from './cli_cmd_analysis.js'
import { registerSessionCommands } from './cli_cmd_session.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { BRIDGE_CAPABILITY_MATRIX, bridgesStatusToJson, formatBridgesStatus, installVerificationNotice } from './bridges_status.js'
import type { HarnessName } from './bridges/types.js'
import { buildCommandManifest, filterCommandManifest, formatCommandManifest } from './cli_commands.js'
import { isWindows, ensureNewline, extractErrorMessage, cappedSourceBytesSaved, isUnderBlockedRoot, countNoun, decodeSource, ensureDirSync } from './util.js'
import { contentHash, extractCompactFromMarker, storeCompact, skillOutputsDir } from './skill_cache.js'
import { findProject } from './project.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { formatBytes, purgeDataDirectories } from './purge.js'
import { loadConfig, getLastConfigParseError, getLastProjectConfigParseError, lastProjectConfigLockedKeys } from './config.js'
import { applyIndexingPriority } from './process_priority.js'
import { runStats } from './cli_stats.js'
import { runDoctorAndExit, runDoctor } from './cli_doctor.js'
import { fetchDoc, getDocSections, formatSections, getSectionContent } from './gdrive.js'
import { runBenchCommand } from './cli_bench.js'
import { expandGlobs } from './cli_diagnostics.js'
export { expandGlobs }
import { compressText, createHandoff, resolveHandoff, retrieveText, CONTENT_MAX_INPUT_CHARS } from './content_store.js'
import { clipLongMatchLine } from './tool_filters/helpers.js'

/** Thrown by command handlers for a clean exit-1 with a stderr message. */
export class CliError extends Error {}

export function out(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
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

function cmdRetrieve(id: string, opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; full?: boolean }): void {
  const text = retrieveText(id)
  if (text === null) throw new CliError(`no token-goat content for id: ${id}. The local cache may have expired.`)
  // retrieve is the lossless round-trip for compress-text; other commands print `recovery: token-goat retrieve <id>` promising the original bytes back, so with no narrowing flag it must stay byte-verbatim -- only opt into sibling head/tail elision once the caller explicitly asks for a slice.
  const noNarrowing = opts.head === undefined && opts.tail === undefined && opts.grep === undefined && opts.section === undefined && opts.maxMatches === undefined && opts.full !== true
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

// Parses a --limit/--top style numeric CLI flag, rejecting a non-numeric value with a clean CliError instead of letting NaN flow into a downstream SQL LIMIT bind (which SQLite rejects with an opaque "datatype mismatch" error).
export function requireInt(flag: string, raw: string): number {
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
export function requireNonNegativeInt(flag: string, raw: string): number {
  const n = requireInt(flag, raw)
  if (n < 0) {
    throw new CliError(`${flag} must be a non-negative number, got: "${raw}"`)
  }
  return n
}

export function requirePositiveInt(flag: string, raw: string): number {
  const n = requireInt(flag, raw)
  if (n <= 0) {
    throw new CliError(`${flag} must be a positive number, got: "${raw}"`)
  }
  return n
}

// --- Command handlers -------------------------------------------------------

// Thin wrapper: all orchestration (embedding search, merge, FTS fallback, formatting) lives in read_commands.ts's runSemantic so the MCP server (mcp_server.ts) can call the same logic in-process without going through the CLI/commander layer.
async function cmdSemantic(query: string | undefined, opts: { limit?: string; json?: boolean; grep?: string; excludeTests?: boolean; preflight?: boolean; warm?: boolean }): Promise<void> {
  if (!query && !opts.preflight && !opts.warm) {
    throw new CliError('missing required argument: query')
  }
  const limit = opts.limit !== undefined ? requireNonNegativeInt('--limit', opts.limit) : 20
  const { text, code } = await runSemantic(query ?? '', {
    limit,
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
    ...(opts.excludeTests === true ? { excludeTests: true } : {}),
    ...(opts.preflight === true ? { preflight: true } : {}),
    ...(opts.warm === true ? { warm: true } : {}),
  })
  // --json must always land on stdout so `| jq .` works even on a no-match/error exit -- only
  // the text-mode path routes a non-zero code to stderr (preserved byte-identical below).
  ;(opts.json === true || code === 0 ? out : err)(text)
  process.exitCode = code
}

export async function cmdIndex(
  pathArg?: string,
  opts: { walk?: boolean; dbPath?: string; force?: boolean; forceWalk?: boolean } = {},
): Promise<void> {
  // A bulk walk is long-running background work even though the user typed it: they start it and
  // go back to their editor. The daemon lowers its own priority for the same reason; doing it here
  // too is what makes "both indexing paths" true rather than only the invisible one.
  applyIndexingPriority()
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
          `indexing ${countNoun(files.length, 'file')} may take a long time and produce a large index. ` +
          `Run 'token-goat doctor' afterwards to check index size.\n`,
      )
    }
  }
  const blockedRoots = loadConfig().worker.blocked_roots
  const ixCfg = loadConfig().indexing
  // files.embed_sha records WHICH CONTENT was embedded, never WHICH STACK embedded it, so the per-file freshness gate in the loop below cannot see a model or inference-runtime change on its own: it reads a bare sha as fresh and skips the file. ensureEmbeddingProvenance owns that input and is the only thing that can re-open the decision, but its only callers were upsertChunks and searchSemantic, both downstream of that gate -- so a whole-index run after an onnxruntime major.minor upgrade printed "Skipped N unchanged file(s)" and left every vector from the previous stack in place, which is exactly what the warning that reset prints tells the user to run this command to fix. It must run here rather than inside the loop: the reset clears each affected file's embed_sha, and by the time the loop has read a file's row into `entry` that clearing is already too late to be seen. Gated on the deps being usable because backendId() cannot name a runtime that did not load, and wiping the index on the strength of an unknowable identity would be worse than the staleness it is guarding against.
  if ((loadConfig().indexing?.embeddings_enabled ?? true) && embeddingsDepsAvailable(getDb(dbPath))) {
    ensureEmbeddingProvenance(getDb(dbPath))
  }
  let indexed = 0
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
    // worker.blocked_roots (set via `token-goat project exclude`) excludes a path prefix from
    // indexing entirely -- skip before the language check so a blocked file is never touched.
    if (isUnderBlockedRoot(key, blockedRoots)) {
      // Purge rather than skip. A file indexed before its root was blocked would otherwise keep
      // its symbols, bodies and embeddings forever: a plain skip leaves the rows it wrote behind,
      // and no other pass removes them (pruning is existence-based, and an excluded file is still
      // on disk). Same treatment isParseSkipEligible already gives a file excluded by skip_dirs.
      removeFileFromIndex(getDb(dbPath), key)
      continue
    }
    // PDF/DOCX/PPTX/XLSX have no Language entry (no code symbols) so they report 'unknown', but they must still reach indexFileEmbeddings below for extracted-text embedding. The language is read from the file's head, as the walk that listed it did: a path-only check skipped every `.p`, `.w`, `.m` and `.t` a content sniff admits, so it was never indexed or counted.
    if (detectLanguageOfFile(key) === 'unknown' && !isEmbeddableDocument(key)) continue
    // indexing.skip_dirs / large_file_skip_kb: filter here, before the sha/entry work below. Without this pre-filter, indexFileSync's internal purge would run and then the unconditional indexFileEmbeddings call below would immediately re-embed a file meant to be fully excluded (origin's indexFileEmbeddings has no skip_dirs/size-cap branch).
    if (isParseSkipEligible(key, ixCfg)) {
      removeFileFromIndex(getDb(dbPath), key)
      continue
    }
    // Mirror worker.ts's makeIndexer sha gate here: a bulk `token-goat index` run previously called indexFileSync (and re-chunked/re-embedded via indexFileEmbeddings) unconditionally for every tracked file on every invocation, even ones byte-identical to what was already indexed. fingerprintFile returning null (a transient read failure/race) is treated as "not unchanged" so the file still gets a normal reindex attempt below. Parse and embed freshness are gated independently (embed_sha vs sha), matching makeIndexer, so a file whose embedding previously failed still gets re-embedded even when its parse is current. --force bypasses both freshness checks unconditionally -- e.g. after a parser.ts extraction-logic change, every already-indexed file's SHA is untouched and stale symbols/refs would otherwise never get recomputed until each file happens to be edited.
    const sha = fingerprintFile(key)
    // A git-tracked file deleted from the worktree is still listed by getTrackedFiles, so it
    // reaches this loop on every run. fingerprintFile returns null for it, indexFileSync
    // fail-softs on ENOENT without throwing, and the `indexed += 1` at the bottom of the loop
    // then counted work that never happened -- every run, forever, since deleting the file is
    // exactly what keeps it in this state. After a rename the effect was the headline symptom:
    // `Indexed 1 file into the symbol index` printed while the index had just been emptied.
    // A null sha for a file that DOES exist is a transient read failure (a lock held by an AV
    // scanner or an open editor) and still deserves the normal reindex attempt below, so the
    // existence check is what separates the two. The rows are removed by pruneDeletedFiles
    // after the loop, which is the pass that owns vanished files.
    if (sha === null && !fs.existsSync(key)) continue
    const entry = sha !== null ? getFileEntry(key, dbPath) : null
    // A case-only rename (`mv b.ts B.ts`) leaves the content byte-identical, so the sha gate below
    // would skip the file and the row would keep the old spelling indefinitely -- see
    // indexedPathSpellingIsStale. Reindexing rewrites the row under the spelling the file
    // actually has.
    const spellingStale = entry !== null && indexedPathSpellingIsStale(entry.filePath, key)
    // entry.parserSha gates on WHICH parser wrote the rows, not just whether the content moved -- see PARSER_FINGERPRINT and the same gate in worker.ts's makeIndexer. This is what makes the --force escape hatch described above unnecessary after a parser change: the mismatch reparses the file on its own.
    const parseUnchanged =
      !force && !spellingStale && sha !== null && entry?.sha === sha && entry.parserSha === PARSER_FINGERPRINT
    // isEmbedFresh (parser.ts) is the shared read side of this gate, also used by worker.ts's makeIndexer: while embeddings are config-disabled, only the `disabled:` marker for this sha counts as fresh; while enabled, a bare sha match is fresh (the file was really embedded, or was empty / permanently policy-skipped -- e.g. profile-meta.xml, an oversized salesforce_metadata file -- with nothing to embed, both terminal regardless of deps); and an `unavailable:` marker is fresh only while the optional embedding deps stay uninstalled.
    const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true
    // See isEmbedFresh: depsAvailable keeps an `unavailable:`-marked embed_sha (a file skipped only because the optional model/sqlite-vec deps were absent) treated as stale so it is re-embedded once the deps are installed, instead of looking permanently fresh.
    const depsAvailable = embeddingsEnabled && embeddingsDepsAvailable(getDb(dbPath))
    const embedUnchanged =
      !force &&
      parseUnchanged &&
      sha !== null &&
      isEmbedFresh(
        entry?.embedSha,
        sha,
        embeddingsEnabled,
        depsAvailable,
        // See isEmbedFresh: an `oversize:` marker stays fresh only while indexing.large_file_symbol_only_kb is still what it was stamped under, so raising the threshold re-embeds the files it just admitted instead of leaving them permanently skipped. 0 matches no marker (config floors this key at 1), the safe direction for a partially-mocked config.
        loadConfig().indexing?.large_file_symbol_only_kb ?? 0,
      )
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
      // indexFileSync fail-softs on ENOENT, so a file deleted during its own parse leaves nothing
      // written and throws nothing either. Counting it would reintroduce the phantom credit the
      // pre-parse guard above exists to stop, just through a narrower window.
      if (!fs.existsSync(key)) continue
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
    `Indexed ${countNoun(indexed, 'file')} into the symbol index.` +
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
    out(displaySafeJson(map, 0))
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
    // Same wording as cmdPptxText's --grep-with-no-hits path: a filter matching nothing is a
    // legitimate empty result, not an error, so this stays a plain message on exit 0.
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
    process.stderr.write(
      `token-goat: mcp-server unavailable (could not load the MCP server modules): ${String(err)}\n`,
    )
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

/**
 * Print the "how well is this bridge actually verified" caveat, if the bridge has one.
 *
 * Routed through {@link installVerificationNotice} rather than spelled out per branch: a caveat
 * enumerated at nine callsites is a caveat that goes missing from the tenth, which is precisely
 * the whitelist-drops-a-field shape that has shipped dead features from this codebase before.
 */
function printBridgeVerificationNotice(harness: HarnessName): void {
  const notice = installVerificationNotice(harness)
  if (notice !== null) out(notice)
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
  // Imported here rather than at module scope: relay.ts side-effect-imports every hook handler to
  // register them, so a top-level import made every CLI command -- `symbol`, `read`, even
  // `--version` -- parse the whole hook subsystem, the bash tool-filter registry and the HTML
  // extractor before doing anything. Only this one command needs any of it. Hooks themselves are
  // unaffected: they run through dist/token-goat-hook.mjs, which imports relay directly.
  const { relay } = await import('./relay.js')
  // relay handles its own stdin read / stdout write and never throws on a malformed/unknown event — it emits `{}` and returns.
  await relay(event)
}

/** One-line warning for a project-scope install whose files hold absolute paths on this machine and so must not be committed for a team: VS Code runs the hooks file for everyone who opens the repository. */
// Escaped inside this helper rather than at its call sites. Both callers pass paths built from the project root, so a repository cloned into a marker-named directory puts the marker into a note token-goat speaks in its own voice; doing it in the one place covers both callers and any later one. The guard's NEUTRALIZERS lists this function for that reason, and pins the shape below so it cannot quietly stop escaping while still exempting its callers.
function projectHooksCommitNote(pathFiles: readonly string[], hooksConfigPath?: string): string {
  const shim = hooksConfigPath === undefined ? '' : ` (${displaySafePath(path.join(path.dirname(hooksConfigPath), HOOKS_SCRIPT_FILE))} is generated with them)`
  return `Note: ${pathFiles.map((p) => displaySafePath(p)).join(', ')} ${pathFiles.length === 1 ? 'holds' : 'hold'} absolute paths to node and token-goat on this machine${shim}, so do not commit them: list them in .git/info/exclude or .gitignore.`
}

/** What install --visualstudio prints after writing: Visual Studio needs two manual switches before the agent sees anything. */
export function visualStudioManualSteps(scope: 'project' | 'user'): string[] {
  return [
    'Visual Studio runs no token-goat hooks: it gets the MCP tools and the routing guidance only (no read dedup, hints, image shrink or output folding). It needs Visual Studio 2022 17.14 or later, or Visual Studio 2026, and two steps there:',
    '  1. Tools > Options: turn on "Enable custom instructions to be loaded from .github/copilot-instructions.md files and added to requests".',
    '  2. In Copilot Chat agent mode, open the Tools picker and tick the token-goat tools: new MCP tools start disabled. If Visual Studio asks whether to trust the token-goat server, it is asking because the command or its arguments changed.',
    ...(scope === 'user' ? ['The user-level instructions file is read by Visual Studio 2026; on Visual Studio 2022, run this with -p/--project to put the guidance in the solution\'s .github/copilot-instructions.md.'] : []),
  ]
}

/**
 * Whether an `install`/`uninstall` invocation should touch the base Claude Code integration:
 * the `~/.claude/settings.json` (or project `.claude/settings.json`) hooks, the user's own
 * `~/.claude/CLAUDE.md` routing block, and `~/.claude/skills/token-goat`. A bare
 * `install`/`uninstall` with no other harness flag always means Claude Code, so it runs.
 * Any *other* harness flag (`--vscode`, `--codex`, `--gemini`, ...) asks for that harness's own
 * scope only -- none of them read or write anything under `~/.claude/`, confirmed by reading
 * each bridge's install writer (e.g. `installVscode` writes only its own `mcp.json`, an
 * instructions file, and the shared `~/.copilot/hooks` file). Wanting both is what running the
 * command twice, or passing both flags in one invocation, is for -- not a silent side effect of
 * asking for one. `--hermes` is the one exception: its CLI delegates to `claude -p`, which loads
 * these same Claude Code hooks, so its branches below genuinely depend on this base having run.
 */
function wantsClaudeCodeBase(opts: {
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  opencode?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  vscode?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  hermes?: boolean
}): boolean {
  const otherHarnessRequested = [
    opts.codex,
    opts.gemini,
    opts.qwen,
    opts.kimi,
    opts.pi,
    opts.opencode,
    opts.openclaw,
    opts.copilot,
    opts.grok,
    opts.vscode,
    opts.visualstudio,
    opts.zed,
    opts.cursor,
  ].some((v) => v === true)
  return !otherHarnessRequested || opts.hermes === true
}

async function cmdInstall(opts: {
  project?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  opencode?: boolean
  hermes?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  vscode?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  local?: boolean
  user?: boolean
}): Promise<void> {
  // --user is the opt-out from the one harness whose scope default is inverted (see
  // vscodeScopeFromFlags). Passing both scope flags is a contradiction, not a precedence puzzle.
  if (opts.project === true && opts.user === true) {
    throw new Error('install takes either -p/--project or --user, not both.')
  }
  // Imported here, not at module scope, for the same startup-cost reason cmdHook does it: relay.ts side-effect-imports every hook handler module to populate the registry toolMatcherFor (hook_registry.ts) narrows PreToolUse/PostToolUse matchers against. Without this, installHooks below narrows against whichever two hook modules cli.ts happens to import for unrelated commands (hooks_index.ts, hooks_read.ts), silently dropping every other tool's hooks (Bash, Write, Edit, Glob, WebFetch, WebSearch, Agent, Skill, ...) from a fresh install, and downgrading an existing catch-all install to that same narrow set on a repeat run -- confirmed against the real built binary, which wrote "^Read$|^Grep$" for PreToolUse and "^Read$" for PostToolUse before this fix.
  await import('./relay.js')
  const scope: HookScope = opts.project === true ? 'project' : 'user'

  // Base install: the Claude Code hooks, the CLAUDE.md routing block, and the token-goat skill,
  // per README's "What gets installed?" table -- gated behind wantsClaudeCodeBase (see its doc
  // comment) so a scoped harness flag like --vscode never silently rewrites a Claude Code file
  // it does not need.
  if (wantsClaudeCodeBase(opts)) {
    const result = installHooks(scope)
    // Report alreadyInstalled like every other harness branch below does. installHooks has always computed it; the base Claude Code path was the one caller that discarded it and claimed a fresh install on every run.
    out(
      result.alreadyInstalled
        ? `token-goat hooks (${scope}) already up to date → ${result.settingsPath}`
        : `Installed token-goat hooks (${scope}) → ${result.settingsPath}`,
    )

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
  }

  if (opts.codex === true) {
    const codexResult = installCodex()
    if (codexResult.alreadyInstalled) {
      out(`Codex CLI integration already installed → ${codexResult.configPath}`)
    } else {
      out(`Installed token-goat Codex CLI integration → ${codexResult.configPath}, ${codexResult.agentsPath}`)
    }
    printBridgeVerificationNotice('codex')
  }

  // --gemini is additive, exactly like --codex above.
  if (opts.gemini === true) {
    const geminiResult = installGemini()
    if (geminiResult.alreadyInstalled) {
      out(`Gemini CLI integration already installed → ${geminiResult.settingsPath}`)
    } else {
      out(`Installed token-goat Gemini CLI integration → ${geminiResult.settingsPath}`)
    }
    printBridgeVerificationNotice('gemini')
  }

  // --qwen is additive, exactly like --gemini above.
  if (opts.qwen === true) {
    const qwenResult = installQwen()
    if (qwenResult.alreadyInstalled) {
      out(`Qwen Code integration already installed → ${qwenResult.settingsPath}`)
    } else {
      out(`Installed token-goat Qwen Code integration → ${qwenResult.settingsPath}`)
    }
    printBridgeVerificationNotice('qwen')
  }

  // --kimi is additive, exactly like --qwen above.
  if (opts.kimi === true) {
    const kimiResult = installKimi()
    if (kimiResult.alreadyInstalled) {
      out(`Kimi Code integration already installed → ${kimiResult.configPath}`)
    } else {
      out(`Installed token-goat Kimi Code integration → ${kimiResult.configPath}, ${kimiResult.hookScriptPath}, ${kimiResult.agentsPath}, ${kimiResult.skillPath}`)
    }
    printBridgeVerificationNotice('kimi')
  }

  // --pi is additive on both install and uninstall, exactly like --codex. --local only has meaning combined with --pi; passed alone it is silently ignored (no dedicated validation), matching this CLI's existing convention of independently-parsed boolean flags (e.g. -p/--project has no combination guard with anything else either).
  if (opts.pi === true) {
    const piResult = installPi({ local: opts.local === true })
    if (piResult.alreadyInstalled) {
      out(`pi extension already installed → ${piResult.extensionPath}`)
    } else {
      out(`Installed token-goat pi extension → ${piResult.extensionPath}`)
    }
    printBridgeVerificationNotice('pi')
  }

  // --openclaw is additive, exactly like --codex above.
  if (opts.openclaw === true) {
    const openclawResult = installOpenclaw()
    if (openclawResult.alreadyInstalled) {
      out(`OpenClaw integration already installed → ${openclawResult.configPath}`)
    } else {
      out(`Installed token-goat OpenClaw integration → ${openclawResult.configPath}, ${openclawResult.pluginPath}`)
    }
    printBridgeVerificationNotice('openclaw')
  }

  // --copilot is additive, exactly like --codex above.
  if (opts.copilot === true) {
    const copilotResult = installCopilotCli({ local: opts.local === true })
    if (copilotResult.alreadyInstalled) {
      out(`Copilot CLI integration already installed → ${copilotResult.configPath}`)
    } else {
      out(`Installed token-goat Copilot CLI integration → ${copilotResult.configPath}, ${copilotResult.scriptPath}, ${copilotResult.instructionsPath}`)
    }
    if (opts.local === true) out(projectHooksCommitNote([copilotResult.configPath], copilotResult.configPath))
    printBridgeVerificationNotice('copilot_cli')
  }

  // --opencode is additive, exactly like --pi above.
  if (opts.opencode === true) {
    const opencodeResult = installOpencode()
    if (opencodeResult.alreadyInstalled) {
      out(`opencode plugin already installed → ${opencodeResult.pluginPath}`)
    } else {
      out(`Installed token-goat opencode plugin → ${opencodeResult.pluginPath}`)
    }
    printBridgeVerificationNotice('opencode')
  }

  // --grok is additive, exactly like --codex above.
  if (opts.grok === true) {
    const grokResult = installGrok()
    if (grokResult.alreadyInstalled) {
      out(`Grok CLI integration already installed → ${grokResult.configPath}`)
    } else {
      out(`Installed token-goat Grok CLI integration → ${grokResult.configPath}, ${grokResult.hookScriptPath}`)
    }
    printBridgeVerificationNotice('grok')
  }

  if (opts.vscode === true) {
    const vscodeResult = installVscode(vscodeScopeFromFlags(opts))
    if (vscodeResult.migratedFromUserScope) out(VSCODE_USER_SCOPE_MIGRATED_NOTE)
    out(
      vscodeResult.alreadyInstalled
        ? `VS Code MCP integration (${vscodeResult.scope} scope) already installed → ${displaySafePath(vscodeResult.mcpPath)}`
        : `Installed token-goat VS Code MCP integration and agent hooks (${vscodeResult.scope} scope) → ${displaySafePath(vscodeResult.mcpPath)}, ${displaySafePath(vscodeResult.hooksConfigPath)}, ${displaySafePath(vscodeResult.instructionsPath)}`,
    )
    if (vscodeResult.scope === 'project') {
      out(projectHooksCommitNote([vscodeResult.mcpPath, vscodeResult.hooksConfigPath], vscodeResult.hooksConfigPath))
      out(VSCODE_PROJECT_SCOPE_COVERAGE_NOTE)
    } else {
      out(VSCODE_USER_SCOPE_MULTIROOT_NOTE)
    }
    if (vscodeUsesClaudeHooks()) out(VSCODE_DOUBLE_FIRE_NOTE)
  }

  if (opts.visualstudio === true) {
    const vsResult = installVisualStudio({ project: opts.project === true })
    out(
      vsResult.alreadyInstalled
        ? `Visual Studio MCP integration (${vsResult.scope} scope) already installed → ${displaySafePath(vsResult.mcpPath)}`
        : `Installed token-goat Visual Studio MCP integration (${vsResult.scope} scope) → ${displaySafePath(vsResult.mcpPath)}, ${displaySafePath(vsResult.instructionsPath)}`,
    )
    if (vsResult.scope === 'project') out(projectHooksCommitNote([vsResult.mcpPath]))
    for (const line of visualStudioManualSteps(vsResult.scope)) out(line)
  }

  // --zed is additive and user-scope only: Zed's context_servers has no documented project-local
  // equivalent to VS Code's .vscode/mcp.json, so -p/--project has no effect here.
  if (opts.zed === true) {
    const zedResult = installZed()
    out(
      zedResult.alreadyInstalled
        ? `Zed MCP context-server integration already installed → ${displaySafePath(zedResult.settingsPath)}`
        : `Installed token-goat Zed MCP context-server integration → ${displaySafePath(zedResult.settingsPath)}, ${displaySafePath(zedResult.shimPath)}`,
    )
  }

  // Cursor imports Claude Code's hooks from ~/.claude/settings.json by default (confirmed against
  // the installed 3.19.7 bundle), so token-goat never writes ~/.cursor/hooks.json -- see
  // src/bridges/cursor_install.ts's header. This registers the MCP server only.
  if (opts.cursor === true) {
    const cursorResult = installCursor({ project: opts.project === true })
    out(
      cursorResult.alreadyInstalled
        ? `Cursor MCP integration (${cursorResult.scope} scope) already installed → ${displaySafePath(cursorResult.mcpPath)}`
        : `Installed token-goat Cursor MCP integration (${cursorResult.scope} scope) → ${displaySafePath(cursorResult.mcpPath)}. Cursor runs no token-goat hooks written by this installer: if you have also run "token-goat install" for Claude Code, Cursor already imports those hooks automatically from ~/.claude/settings.json.`,
    )
    if (cursorResult.scope === 'project') out(projectHooksCommitNote([cursorResult.mcpPath]))
  }

  // Visual Studio reads the solution's .mcp.json and .vscode/mcp.json both, so project-scope
  // installs for the two hosts overlap there. --vscode is project scope unless --user says
  // otherwise, so it reaches this overlap without -p now; --visualstudio still needs -p.
  if (((opts.vscode === true && opts.user !== true) || (opts.visualstudio === true && opts.project === true))) {
    const duplicateNote = visualStudioDuplicateNote()
    if (duplicateNote !== null) out(duplicateNote)
  }

  // --hermes writes nothing new: Hermes delegates to `claude -p '<task>'`, which loads the same Claude Code settings.json installHooks() just wrote (forced above by wantsClaudeCodeBase, since --hermes genuinely depends on it). There is no separate Hermes config file to patch, so this is a verification-only flag -- run the same isInstalled() check `doctor` uses and report whether the hooks Hermes will inherit are really there.
  if (opts.hermes === true) {
    out(
      isInstalled(scope)
        ? `Hermes integration verified: token-goat hooks are present in ${settingsPath(scope)}.`
        : `Hermes integration NOT verified: token-goat hooks are missing from ${settingsPath(scope)}.`,
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
        ensureDirSync(dir)
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

// Backs the VS Code extension's ensureDecoderSetup check -- shelled out to rather than
// reimplemented in the extension, so the extension and installVscode share one path
// resolver (vscodeDecoderConfigured) and can never drift on where mcp.json lives or what
// key name it looks for. --project checks the workspace `.vscode/mcp.json` too (via
// process.cwd(), set by --cwd above), matching install/uninstall's --project convention.
// --visualstudio answers the same question for the Visual Studio `.mcp.json` files.
function cmdMcpStatus(opts: { vscode?: boolean; visualstudio?: boolean; project?: boolean }): void {
  if ((opts.vscode === true) === (opts.visualstudio === true)) {
    throw new Error('mcp-status needs exactly one of --vscode or --visualstudio')
  }
  const scope = opts.project === true ? { projectRoot: process.cwd() } : {}
  out(displaySafeJson(opts.vscode === true ? vscodeDecoderConfigured(scope) : visualStudioMcpStatus(scope), 0))
}

function cmdUninstall(opts: {
  project?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  opencode?: boolean
  hermes?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  vscode?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  local?: boolean
  user?: boolean
  purge?: boolean
}): void {
  if (opts.project === true && opts.user === true) {
    throw new Error('uninstall takes either -p/--project or --user, not both.')
  }
  const scope: HookScope = opts.project === true ? 'project' : 'user'

  // Base uninstall, mirroring the base install's wantsClaudeCodeBase gate: strip the Claude Code
  // hooks, the CLAUDE.md block, and the skill directory only when this invocation actually means
  // Claude Code (bare uninstall, or --hermes, which shares its hook entries). A scoped
  // `uninstall --vscode` must not also silently strip the caller's Claude Code integration.
  if (wantsClaudeCodeBase(opts)) {
    const removed = uninstallHooks(scope)
    out(removed ? `Removed token-goat hooks (${scope}).` : `No token-goat hooks to remove (${scope}).`)

    const claudeMdRemoved = uninstallClaudeMd()
    out(claudeMdRemoved ? 'Removed token-goat block from CLAUDE.md.' : 'No token-goat block in CLAUDE.md to remove.')

    // Strays live in files token-goat doesn't own, so uninstall reports them rather than
    // deleting: silently editing a user's own markdown is worse than leaving a line behind.
    for (const stray of findStrayClaudeMdBlocks()) {
      out(`NOTE: a token-goat block remains in ${stray} — outside CLAUDE.md, so it was not removed. Delete it manually if unwanted.`)
    }

    const skillRemoved = uninstallSkill()
    out(skillRemoved ? 'Removed token-goat skill.' : 'No token-goat skill to remove.')
  }

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
    { flag: opts.kimi === true, run: uninstallKimi, label: 'Kimi Code integration' },
    { flag: opts.pi === true, run: () => (opts.local === true ? uninstallPi({ local: true }) : uninstallPi()), label: 'pi extension' },
    { flag: opts.openclaw === true, run: uninstallOpenclaw, label: 'OpenClaw integration' },
    { flag: opts.copilot === true, run: () => (opts.local === true ? uninstallCopilotCli({ local: true }) : uninstallCopilotCli()), label: 'Copilot CLI integration' },
    { flag: opts.opencode === true, run: uninstallOpencode, label: 'opencode plugin' },
    { flag: opts.grok === true, run: uninstallGrok, label: 'Grok CLI integration' },
    { flag: opts.vscode === true, run: () => uninstallVscode(vscodeScopeFromFlags(opts)), label: 'VS Code MCP integration' },
    { flag: opts.visualstudio === true, run: () => uninstallVisualStudio({ project: opts.project === true }), label: 'Visual Studio MCP integration' },
    { flag: opts.zed === true, run: uninstallZed, label: 'Zed MCP context-server integration' },
    { flag: opts.cursor === true, run: () => uninstallCursor({ project: opts.project === true }), label: 'Cursor MCP integration' },
  ]
  for (const removal of removals) {
    if (!removal.flag) continue
    const removed = removal.run()
    out(removed ? `Removed token-goat ${removal.label}.` : `No token-goat ${removal.label} to remove.`)
  }

  // An integration whose flag was not passed is left wired and, before this, was left silent: a
  // plain `token-goat uninstall` printed three "Removed" lines while a Codex or Copilot hook still
  // pointed at the binary about to be deleted. That is the offboarding case, and a Copilot
  // preToolUse hook whose target is gone fails closed on every call. So each one that is still
  // present is named here with the exact command that removes it, following the same
  // report-rather-than-delete rule the stray CLAUDE.md blocks above already use: uninstall does not
  // silently undo an integration the caller did not ask about.
  for (const leftover of leftoverIntegrations(opts)) {
    out(`NOTE: the token-goat ${leftover.label} is still installed. Run "token-goat uninstall ${leftover.flag}" to remove it.`)
  }

  // Cross-scope warning, mirroring installVscode's cross-scope guard (see
  // otherScopeHasManagedServer): uninstall only ever touches the requested scope's
  // mcp.json, so a server registered in the OTHER scope survives silently -- e.g. a
  // project-scope install from before the project->user default flip, uninstalled with
  // a bare `token-goat uninstall --vscode` (which now defaults to user scope). Warn
  // rather than refuse: uninstall is best-effort cleanup (it already reports-not-deletes
  // stray CLAUDE.md blocks above), and refusing here would block a caller who legitimately
  // only wants to strip the requested scope.
  if (opts.vscode === true && otherScopeHasManagedServer(vscodeScopeFromFlags(opts))) {
    const otherScope = opts.user === true ? 'project' : 'user'
    out(`NOTE: token-goat is still registered in VS Code ${otherScope} scope. Run "token-goat uninstall --vscode${otherScope === 'user' ? ' --user' : ''}" to remove it too.`)
  }

  if (opts.visualstudio === true && visualStudioOtherScopeHasManagedServer({ project: opts.project === true })) {
    const otherScope = opts.project === true ? 'user' : 'project'
    out(`NOTE: token-goat is still registered in Visual Studio ${otherScope} scope. Run "token-goat uninstall --visualstudio${otherScope === 'project' ? ' --project' : ''}" to remove it too.`)
  }

  // --hermes removes no files: Hermes shares the Claude Code hook entries uninstallHooks() above already stripped, so this only exists for CLI symmetry with the other harness flags (README's uninstall table lists --hermes alongside the rest).
  if (opts.hermes === true) {
    out('No separate Hermes integration to remove (it shares the Claude Code hook entries).')
  }

  if (opts.purge === true) runPurge()
}

/**
 * The destructive half of uninstall, opt-in behind --purge. Refuses while the worker is alive:
 * it would rewrite the pid file and re-open the database under the directory being deleted, so
 * the purge would report success over a directory that grows back.
 */
/** An integration still on disk whose removal flag the caller did not pass, so uninstall can name it rather than leave it wired in silence. */
interface LeftoverIntegration {
  flag: string
  label: string
}

/**
 * Detects, never removes. Each entry pairs the flag that was not passed with a detector that reads
 * the harness's own config, so a caller who only ever installed the Claude Code hooks sees nothing.
 */
export function leftoverIntegrations(opts: {
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  openclaw?: boolean
  copilot?: boolean
  opencode?: boolean
  grok?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
}): LeftoverIntegration[] {
  const candidates: Array<{ skipped: boolean; present: () => boolean; flag: string; label: string }> = [
    { skipped: opts.codex !== true, present: isCodexInstalled, flag: '--codex', label: 'Codex CLI integration' },
    { skipped: opts.gemini !== true, present: isGeminiInstalled, flag: '--gemini', label: 'Gemini CLI integration' },
    { skipped: opts.qwen !== true, present: isQwenInstalled, flag: '--qwen', label: 'Qwen Code integration' },
    { skipped: opts.kimi !== true, present: isKimiInstalled, flag: '--kimi', label: 'Kimi Code integration' },
    { skipped: opts.pi !== true, present: () => isPiInstalled() || isPiInstalled({ local: true }), flag: '--pi', label: 'pi extension' },
    { skipped: opts.openclaw !== true, present: isOpenclawInstalled, flag: '--openclaw', label: 'OpenClaw integration' },
    {
      skipped: opts.copilot !== true,
      present: () => isCopilotCliInstalled() || isCopilotCliInstalled({ local: true }),
      flag: '--copilot',
      label: 'Copilot CLI integration',
    },
    { skipped: opts.opencode !== true, present: isOpencodeInstalled, flag: '--opencode', label: 'opencode plugin' },
    { skipped: opts.grok !== true, present: isGrokInstalled, flag: '--grok', label: 'Grok CLI integration' },
    {
      skipped: opts.visualstudio !== true,
      present: () => isVisualStudioInstalled() || isVisualStudioInstalled({ project: true }),
      flag: '--visualstudio',
      label: 'Visual Studio MCP integration',
    },
    { skipped: opts.zed !== true, present: isZedInstalled, flag: '--zed', label: 'Zed MCP context-server integration' },
    {
      skipped: opts.cursor !== true,
      present: () => isCursorInstalled() || isCursorInstalled({ project: true }),
      flag: '--cursor',
      label: 'Cursor MCP integration',
    },
  ]
  const found: LeftoverIntegration[] = []
  for (const candidate of candidates) {
    if (!candidate.skipped) continue
    // A detector reads someone else's config file; a malformed one must not abort the uninstall.
    try {
      if (candidate.present()) found.push({ flag: candidate.flag, label: candidate.label })
    } catch {
      // Unreadable config: cannot claim it is installed, and cannot claim it is not. Stay quiet.
    }
  }
  return found
}

function runPurge(): void {
  if (isWorkerRunning()) {
    err('token-goat: the background worker is running, so --purge would delete files it is about to rewrite. Run "token-goat worker stop" first.')
    return
  }
  const result = purgeDataDirectories()
  for (const root of result.absent) out(`Nothing to purge at ${displaySafePath(root)}.`)
  for (const removed of result.removed) out(`Purged ${displaySafePath(removed.path)} (${formatBytes(removed.bytes)} reclaimed).`)
  // The reason is an OS error string, which quotes the offending path back inside it.
  for (const failure of result.failed) err(`token-goat: could not purge ${displaySafePath(failure.path)}: ${displaySafeText(failure.reason)}`)
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

function cmdStats(opts: { json?: boolean; windowDays?: string; homeDir?: string; full?: boolean; short?: boolean; methodology?: boolean; hooks?: boolean } = {}): void {
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

async function cmdDoctor(opts: { context?: boolean; json?: boolean; repair?: boolean; fix?: boolean }): Promise<void> {
  const doctorOpts: { dataDir?: string; configPath?: string; context?: boolean; rootDir?: string; repair?: boolean } = {}
  if (opts.context === true) {
    doctorOpts.context = true
  }
  if (opts.repair === true || opts.fix === true) {
    doctorOpts.repair = true
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

export function _applyFiltersAndPrint(
  content: string,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; full?: boolean },
  fenceByProvenance = false,
  fenceTag: string = UNTRUSTED_WEB_TAG,
): string {
  // Fetched-page recall only. The injection scan is documented as unconditional for fetched
  // pages, and a `web-output <id>` recall puts that same attacker-written text in front of the
  // model -- but only the WebFetch post-hook fenced it, so the copy served from the cache came
  // back bare. Scanning here rather than at store time means the fence wraps exactly what the
  // caller sees, so a --grep/--head slice that keeps the payload is fenced and one that drops it
  // is not. Recall of cached Bash and MCP output is scanned too, under a tag naming tool output rather
  // than a fetched page. Neither is a page token-goat fetched, but both carry text written by a
  // third party -- a dependency's build or test output, a remote MCP server's result -- and the
  // recall channel put it in front of the model unmarked. The fence is decided by provenance --
  // `fenceByProvenance` -- and not by whether the scan matched: it used to appear only on a positive
  // hit, which meant any payload the eight deliberately-narrow regexes miss was emitted bare. The
  // scan now only decides whether the notice names pattern(s) and whether a stat is recorded.
  const emit = (text: string): string => {
    if (!fenceByProvenance || text === '') {
      out(text)
      return text
    }
    // fenceByProvenance true means this is third-party content (a fetched page, a recalled cache entry, a document the caller only named rather than authored), the same population the injection fence covers -- redact before fencing so a credential pasted into a PDF, a leaked token in a recalled build log, or a signed URL in a doc does not reach the model raw. Idempotent on content already redacted at write time (bash/web/mcp caches), matching the defense-in-depth pass disk_cache.ts's storeBlob already applies on top of a caller's own redaction.
    const redacted = redactSecrets(text).text
    const fenced = fenceUntrusted(redacted, fenceTag)
    out(fenced)
    return fenced
  }
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
    // Guarded, not just compiled: a pattern that backtracks unboundedly cannot be interrupted, and
    // this filter runs over cached command output a line at a time. A refused pattern takes the
    // same literal-substring path an uncompilable one already takes.
    const guarded = compileGuardedRegex(pattern)
    if (guarded.ok) {
      const re = guarded.re
      content = content
        .split(/\r?\n/)
        .filter((line) => re.test(line))
        .map((line) => clipLongMatchLine(line, pattern))
        .join('\n')
    } else {
      content = content
        .split(/\r?\n/)
        .filter((line) => line.includes(pattern))
        .map((line) => clipLongMatchLine(line, pattern))
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

  const rawLines = content.split(/\r?\n/)
  // --full is the only way to get the stored blob back verbatim. The blob store itself is lossless, but every render path below elides the middle past head+tail, so without this flag an elision marker pointing a reader at `mcp-output <id>` promises a full report the CLI cannot actually produce -- which is exactly what hooks_agent_spawn.ts's envelope compaction relies on. Deliberately bypasses only the elision, not --section/--grep/--max-matches above: those are explicit narrowing the caller asked for.
  if (opts.full === true) {
    return emit(rawLines.join('\n'))
  }
  // Text that ends in a newline splits into a trailing "" that is not a line of output. Counting
  // it made `--tail N` return N-1 real lines (`--tail 1` returned nothing at all) and made the
  // default elision drop the last line of every long capture. `--full` above keeps the raw split
  // so the verbatim blob is unchanged.
  const lines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  const headN = opts.head !== undefined ? requireNonNegativeInt('--head', opts.head) : 30
  const tailN = opts.tail !== undefined ? requireNonNegativeInt('--tail', opts.tail) : 80

  const applyElision = (lines: string[], headN: number, tailN: number): string[] => lines.length > headN + tailN + 1 ? [...lines.slice(0, headN), '...(elided)...', ...lines.slice(lines.length - tailN)] : lines

  /**
   * Say on stderr how much of the body an explicit --head/--tail dropped.
   *
   * The two-sided paths above leave a `...(elided)...` marker in the body, so a reader can see the
   * middle went missing. The one-sided branches left nothing at all: `web-output <id> --head 3`
   * against a 60-line body returned three lines inside a content fence that looked exactly like a
   * complete short document. Asking for three lines tells the caller how many they get; it does not
   * tell them whether the body held three or sixty thousand, which is the number that decides
   * whether to look again.
   *
   * stderr rather than stdout because stdout here is fenced untrusted content -- a token-goat line
   * inside the fence would read as part of the payload it is describing.
   */
  const noteLineCap = (which: 'first' | 'last', flag: 'head' | 'tail', shown: number, total: number): void => {
    if (shown >= total) return
    process.stderr.write(`Showing ${which} ${shown} of ${total} lines (raise --${flag}, or --full for the whole body).\n`)
  }

  let result = lines
  if (opts.head === undefined && opts.tail === undefined) {
    // Covers both "no filters at all" and "--grep alone" -- the latter is the single most common recall pattern this CLI's own hint text pushes users toward (bash-output/web-output --grep with no --head/--tail), and left unbounded here it could return an arbitrarily large number of matching lines with no truncation at all.
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined && opts.tail !== undefined) {
    result = applyElision(lines, headN, tailN)
  } else if (opts.head !== undefined) {
    result = lines.slice(0, headN)
    noteLineCap('first', 'head', result.length, lines.length)
  } else if (opts.tail !== undefined) {
    result = lines.slice(Math.max(0, lines.length - tailN))
    noteLineCap('last', 'tail', result.length, lines.length)
  }

  return emit(result.join('\n'))
}

function cmdBashOutput(
  id: string | undefined,
  opts: {
    head?: string
    tail?: string
    grep?: string
    section?: string
    file?: string
    maxMatches?: string
    transcript?: boolean
    verifyLastWrite?: string | boolean
    strict?: boolean
  },
): void {
  const parseVerifyThreshold = (optVal: string | boolean | undefined): number | undefined => {
    if (optVal === undefined || optVal === false) return undefined
    if (typeof optVal === 'string' && optVal.trim() !== '' && !isNaN(Number(optVal))) {
      const parsed = Number(optVal)
      return parsed >= 0 ? parsed : 60
    }
    return 60
  }

  const verifyThresholdSec = parseVerifyThreshold(opts.verifyLastWrite)

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
      if (verifyThresholdSec !== undefined) {
        const ageSec = Math.round((Date.now() - st.mtimeMs) / 1000)
        if (ageSec > verifyThresholdSec) {
          const msg = `stale write: '${opts.file}' was modified ${ageSec}s ago (threshold: ${verifyThresholdSec}s). Terminal command may have silently failed or no-op'd.`
          if (opts.strict === true) {
            throw new CliError(msg)
          }
          process.stderr.write(`[tg: stale-write] ${msg}\n`)
        }
      }
      // `bash-output --file` is a general "show me this file's text" recall path, so a caller can
      // point it straight at a .env. Its values are secret by the file's nature; redact them here
      // the same way every other read path does. See dotenv_redact.ts.
      content = redactIfDotenv(opts.file, decodeSource(fs.readFileSync(opts.file)))
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`cannot read file: ${opts.file}`)
    }
    _applyFiltersAndPrint(opts.transcript === true ? extractTranscriptText(content) : content, opts, true, UNTRUSTED_TOOL_TAG)
    return
  }

  if (id === undefined) {
    throw new CliError('provide an <id> or --file <path>')
  }

  const entry = getBashOutput(id)
  if (entry === null) {
    throw new CliError(`no cached bash output for id: ${id}. If this id is from a background task, recall its output file directly with: token-goat bash-output --file <path-to-output-file>`)
  }

  if (verifyThresholdSec !== undefined) {
    const ageSec = Math.round((Date.now() - entry.storedAt) / 1000)
    if (ageSec > verifyThresholdSec) {
      const msg = `stale write: cached output '${id}' was recorded ${ageSec}s ago (threshold: ${verifyThresholdSec}s). Terminal command may have silently failed or not re-run.`
      if (opts.strict === true) {
        throw new CliError(msg)
      }
      process.stderr.write(`[tg: stale-write] ${msg}\n`)
    }
  }

  _applyFiltersAndPrint(entry.output, opts, true, UNTRUSTED_TOOL_TAG)
}

function cmdWebOutput(
  id: string | undefined,
  opts: { head?: string; tail?: string; grep?: string; section?: string; maxMatches?: string; raw?: boolean },
): void {
  if (id === undefined) {
    throw new CliError('provide a web cache <id>')
  }
  // --raw recovers the body as actually fetched, before hooks_fetch.ts's extractCleanText cleaning pass, so a selector/script tag/embedded JSON blob lost from the default cleaned text is still recoverable without re-fetching. Falls back to the cleaned content when no separate raw copy was stored (cleaning never ran for this entry), which is already the raw body in that case.
  const content = opts.raw === true ? getWebOutputRaw(id) : getWebOutput(id)
  if (content === null) {
    throw new CliError(`no cached web output for id: ${id}. The cache may have expired; re-run the WebFetch to repopulate it.`)
  }
  _applyFiltersAndPrint(content, opts, true)
}

function extractJsonFromMcpOutput(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const cleaned = trimmed
      .replace(/^\[token-goat:[^\]]+\]\r?\n?/i, '')
      .replace(/^<untrusted-tool-output[^>]*>\r?\n?/i, '')
      .replace(/\r?\n?<\/untrusted-tool-output>$/i, '')
      .trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      const blockMatch = /```(?:json)?\r?\n([\s\S]*?)```/.exec(trimmed)
      if (blockMatch && blockMatch[1]) {
        try {
          return JSON.parse(blockMatch[1].trim())
        } catch {
          // ignore fallback
        }
      }
      throw new CliError('content is not valid JSON for --json-query')
    }
  }
}

// MCP results are stored in the same bash-output blob store as `mcp_<hash>`-prefixed ids (see mcp_cache.ts's storeMcpOutput), so `token-goat bash-output <id>` already resolves one — this command exists for discoverability (the id printed in a `[token-goat: compressed, full via mcp-output <id>]` label points here) and to fail clearly on a non-MCP id rather than silently serving whatever bash-output happens to be stored under it.
function cmdMcpOutput(
  id: string | undefined,
  opts: {
    head?: string
    tail?: string
    grep?: string
    section?: string
    maxMatches?: string
    full?: boolean
    jsonQuery?: string
    file?: string
    json?: boolean
  },
): void {
  let content: string
  if (opts.file !== undefined) {
    if (opts.file.includes('\0')) {
      throw new CliError('--file path contains a null byte')
    }
    if (!fs.existsSync(opts.file)) {
      throw new CliError(`file not found: ${opts.file}`)
    }
    try {
      const st = fs.statSync(opts.file)
      if (st.isFIFO() || st.isSocket()) {
        throw new CliError(`--file '${opts.file}' is a special file (FIFO or socket) — only regular files are supported`)
      }
      content = decodeSource(fs.readFileSync(opts.file))
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`cannot read file: ${opts.file}`)
    }
  } else if (id !== undefined) {
    if (!id.startsWith('mcp_')) {
      throw new CliError(`not an mcp-output id: ${id} (expected an id starting with 'mcp_')`)
    }
    const entry = getBashOutput(id)
    if (entry === null) {
      throw new CliError(`no cached mcp output for id: ${id}. The cache may have expired; re-run the MCP tool call to repopulate it.`)
    }
    content = entry.output
  } else {
    throw new CliError('provide an mcp-output <id> or --file <path>')
  }

  if (opts.jsonQuery !== undefined) {
    const data = extractJsonFromMcpOutput(content)
    let head: number | undefined
    if (opts.head !== undefined) {
      head = requireNonNegativeInt('--head', opts.head)
    }
    const queryResult = queryJson(data, opts.jsonQuery)

    const { head: _omittedHead, ...restOpts } = opts
    const printOpts = { ...restOpts, full: true }

    if (!queryResult.fanned) {
      const val = queryResult.items[0]
      const formatted = opts.json === true ? displaySafeJson(val, 0) : displaySafeJson(val)
      _applyFiltersAndPrint(formatted, printOpts, true, UNTRUSTED_TOOL_TAG)
      return
    }

    const totalCount = queryResult.items.length
    const limited = head !== undefined ? queryResult.items.slice(0, head) : queryResult.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const capped = guardJsonRows(limited)
      const jsonText = displaySafeJson(
        { items: capped.items, truncated: capped.truncated || headTruncated || queryResult.truncated, totalCount },
        0,
      )
      _applyFiltersAndPrint(jsonText, printOpts, true, UNTRUSTED_TOOL_TAG)
    } else {
      const lines = limited.map((item) => displaySafeJson(item, 0))
      if (headTruncated) {
        lines.push(`...(${totalCount - limited.length} more items elided; use --head to see more)`)
      }
      if (queryResult.truncated) {
        lines.push(`...(the search stopped early at this tool's traversal limit; these are not necessarily all the matches. Narrow the path to search less of the document.)`)
      }
      _applyFiltersAndPrint(lines.join('\n'), printOpts, true, UNTRUSTED_TOOL_TAG)
    }
    return
  }

  _applyFiltersAndPrint(content, opts, true, UNTRUSTED_TOOL_TAG)
}

export { fenceFileText, fenceFileFieldIfMatched, fileSizeOrZero } from './cli_office.js'
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
    quietSuccess?: boolean
    native?: boolean
  } = {},
): Promise<void> {
  try {
    let command = opts.cmd
    if (Array.isArray(commandArgs) && commandArgs.length > 0) {
      command = command ? [command, ...commandArgs].join(' ') : commandArgs.join(' ')
    }
    if (opts.cmdB64 !== undefined) {
      command = Buffer.from(opts.cmdB64, 'base64').toString('utf8')
    }
    if (!command || command.trim() === '') {
      err(`token-goat: either command arguments, -c/--cmd, or --cmd-b64 is required`)
      process.exitCode = 1
      return
    }
    const bashRunner = await import('./bash_runner.js')
    if (opts.compress === false) {
      // Commander maps `--no-compress` to `opts.compress === false`.
      process.exitCode = bashRunner.runRaw(command, parseTimeout(opts.timeout, bashRunner.DEFAULT_TIMEOUT_SECONDS))
      return
    }
    const maxTokens = opts.maxTokens !== undefined ? requireNonNegativeInt('--max-tokens', opts.maxTokens) : 0
    process.exitCode = await bashRunner.run(command, {
      filterName: opts.filter,
      timeout: parseTimeout(opts.timeout, bashRunner.DEFAULT_TIMEOUT_SECONDS),
      maxTokens,
      ...(opts.profile !== undefined ? { compressionProfile: opts.profile } : {}),
      ...(opts.quietSuccess === true ? { quietSuccess: true } : {}),
      ...(opts.native === true ? { nativeShell: true } : {}),
    })
  } catch (e) {
    err(`token-goat: ${displaySafeText(extractErrorMessage(e))}`)
    process.exitCode = 1
  }
}

/** Resolve the --timeout flag (seconds): 0/absent/invalid → the built-in default. */
function parseTimeout(raw: string | undefined, fallbackSeconds: number): number {
  const sec = raw ? parseInt(raw, 10) : 0
  return Number.isFinite(sec) && sec > 0 ? sec : fallbackSeconds
}

export * from './cli_skills.js'
export * from './cli_file_ops.js'

async function cmdGdriveSections(fileId: string, opts: { heading?: string; fresh?: boolean }): Promise<void> {
  // An organisation that does not use Google Drive can switch the integration off entirely, which
  // refuses here before any file id is validated or any connection is opened, and also stops the
  // installed agent guidance from naming the command at all.
  if (!loadConfig().gdrive.enabled) {
    throw new CliError('gdrive-sections is disabled by gdrive.enabled = false in this install')
  }
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
  // A Google Doc is authorable by anyone who can edit the shared file, exactly like a fetched web
  // page -- scan and fence it the same way `_applyFiltersAndPrint` does for WebFetch/web-output,
  // under the same UNTRUSTED_WEB_TAG (this doc *is* fetched over HTTP, via performHttpFetch in
  // gdrive.ts). Inlined rather than routed through `_applyFiltersAndPrint` because that helper's
  // default head/tail elision would silently truncate output this command has always emitted in
  // full; `emitted` is used unmodified below except when a match is found.
  const toEmit = fenceUntrusted(emitted, UNTRUSTED_WEB_TAG)
  out(toEmit)
  // stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `gdrive-sections`/`gdrive_sections`
  // entry and nothing ever called recordStat for this command -- the dashboard bucket was
  // permanently zero regardless of real usage, the same class of gap already fixed for
  // map_lookup/changed_lookup/csv_query/brief_view/session_outline/session_slice (see
  // project_runchanged_missing_stat memory).
  const bytesSaved = cappedSourceBytesSaved(fullSourceBytes, Buffer.byteLength(toEmit, 'utf8'))
  recordStat('gdrive_sections', bytesSaved, savedTokensFromBytes(bytesSaved))
}

// --- Program assembly -------------------------------------------------------

/** Build the Commander program. Exported so tests can introspect/parse it. */
/** Generate a compact grouped help text for the top-level command. */
/**
 * Commander's own `helpInformation` for the top-level program, captured before
 * `buildProgram` shadows it with the compact grouped index. `help --full` calls
 * this to emit the long per-command listing the compact index replaces; without
 * it the long form is unreachable, since the override is an own property that
 * hides the prototype method for every later caller.
 */
let originalHelpInformation: (() => string) | null = null

export function buildProgram(): Command {
  const program = new Command()
  program
    .name('token-goat')
    .description('Surgical token-reduction companion for AI coding agents')
    .version(VERSION, '-v, --version', 'print the token-goat version')
    // Lets a caller (e.g. the VS Code extension) convey a project root explicitly
    // instead of setting the spawned process's own working directory to it -- an
    // attacker-controlled workspace should never be the cwd a shell/launcher resolves
    // a binary name against, but commands that key off process.cwd() for project
    // resolution still need a way to be told where that root is.
    .option('--cwd <path>', 'run as if invoked from this directory (overrides the real working directory)')
    // Lets a caller print a disclosure line ahead of the command's own output without composing
    // two commands through a shell operator -- a rewritten command (see detectStructuralIndexRewrite
    // in bash_structural_index.ts) needs to say what it substituted, and every shell parses one
    // command with a global flag identically, where `echo ... &&` does not (no `&&` in PowerShell
    // 5.1 at all).
    .option('--notice <text>', 'print this line to stdout before the command\'s own output')

  // Applied via a preAction hook (not inside `guard` below) so --cwd works for every
  // command, not only the ones wrapped in `guard` -- the surgical-read commands (symbol,
  // read, scope, ...) call runExit/runExitText directly and never go through guard, so a
  // chdir living only inside guard silently no-ops for them. This hook fires before any
  // command's action handler, guard-wrapped or not, and before anything resolves the
  // project root or loads config.
  program.hook('preAction', (thisCommand) => {
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
        // The parser quotes the offending line of the file back, so this banner carries file bytes in a line prefixed with token-goat's own name.
        err(`token-goat: config.toml failed to parse (${displaySafeText(parseErr)}); using defaults — run \`token-goat config validate\` for details`)
      }
      // Same distinction as above, for the optional per-project .token-goat.toml override --
      // it fails open (global-only config still loads), but a corrupt project file should not
      // look identical to "no project override" for every command.
      const projectParseErr = getLastProjectConfigParseError()
      if (projectParseErr !== null) {
        // Same, and worse: a project override arrives with the repository, so these bytes are third-party on every clone. This banner prints before every command.
        err(`token-goat: .token-goat.toml failed to parse (${displaySafeText(projectParseErr)}); ignoring project override`)
      }
      // A per-project file arrives with the repository, so it may not set the security controls
      // an administrator configures once. Say which settings were ignored: silently dropping
      // them would leave a legitimate author wondering why the file had no effect.
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
        const msg = extractErrorMessage(e)
        err(`token-goat: ${displaySafeText(msg)}`)
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
    .option('--stats', 'add per-result reference count and doc-coverage flag (project-wide count per NAME, not per definition site -- same-named symbols across files share a count)')
    .action((name: string | undefined, more: string[], opts: { limit?: string; file?: string; kind?: string; project?: string | boolean; json?: boolean; grep?: string; excludeTests?: boolean; stats?: boolean }) => {
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
      "read one symbol's full body (spec: file::symbol; disambiguate a name shared by several classes with file::Parent.symbol; a trailing @LINE anchor -- file::symbol@LINE, or combined as file::Parent.symbol@LINE -- picks out a specific candidate by its exact starting line, for the case a Parent qualifier can't reach (e.g. a top-level definition); comma-separated file::a,b for a merged multi-symbol view, or a::x,b::y to merge symbols across several files)",
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
          { noun: 'spec' },
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
        emitExtraFileArgsNote('brief', spec, more, { noun: 'spec' })
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
    .option('--grep <pattern>', 'with --list, filter headings to this regex (literal substring if it is not valid regex)')
    .action((spec: string, more: string[], opts: { json?: boolean; list?: boolean; grep?: string }) =>
      opts.list === true
        ? runExit(() => {
            // --list reads a plain file and has no comma form, so name no suggestion here.
            emitExtraFileArgsNote('section --list', spec, more, { mergeable: false })
            return runListSections({ file: spec, ...(opts.json === true ? { json: true } : {}), ...(opts.grep !== undefined ? { grep: opts.grep } : {}) })
          })
        : runExitText(() =>
            noteExtraFileArgs('section', spec, more, () => runSection({ spec, ...(opts.json === true ? { json: true } : {}) }), { noun: 'spec' }),
          ),
    )

  program
    .command('semantic [query]')
    .description('semantic search (falls back to full-text search)')
    .option('-l, --limit <n>', 'max results')
    .option('-j, --json', 'output as JSON')
    .option('--grep <pattern>', 'filter to hits whose file path matches this regex (literal substring if it is not valid regex); matched against the path as rendered')
    .option('--exclude-tests', 'hide hits whose file is a test file (opt-in; default output is unchanged)')
    .option('--preflight', 'run semantic embedding preflight check and exit')
    .option('--warm', 'warm up the embedding model session in memory')
    .action(guard(cmdSemantic))

  // `skeleton` and `outline` are the same command over the same options (see OutlineOptions, which
  // is an alias of SkeletonOptions) and differ only in which renderer they hand the file to. They
  // were registered by two blocks identical line for line apart from the name, description and
  // callee, so a flag added to one silently did not exist on the other. Registered in the original
  // order, so `--help` still lists skeleton before outline.
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
        emitExtraFileArgsNote('refs', spec, more, { noun: 'spec' })
        return runRefs({
          spec,
          ...(opts.callers === true ? { callers: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.limit !== undefined ? { limit: requireNonNegativeInt('--limit', opts.limit) } : {}),
          ...(opts.top !== undefined ? { top: requireNonNegativeInt('--top', opts.top) } : {}),
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
      runExitText(() =>
        runBenchCommand({
          corpus: opts.corpus ?? path.join('tests', 'fixtures', 'bench'),
          ...(opts.tsv !== undefined ? { tsv: opts.tsv } : {}),
          ...(opts.validate === true ? { validate: true } : {}),
          ...(opts.json === true ? { json: true } : {}),
        }),
      ),
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
    .option('--user', 'with --vscode, install into user scope instead of this project (every project at once, but nothing past the first folder of a multi-root workspace)')
    .option('--codex', 'also patch Codex CLI (~/.codex/config.toml, ~/.codex/AGENTS.md)')
    .option('--gemini', 'also patch Gemini CLI (~/.gemini/settings.json)')
    .option('--qwen', 'also patch Qwen Code (~/.qwen/settings.json)')
    .option('--kimi', 'also register a Kimi Code hook config, shim, instructions block and skill ($KIMI_CODE_HOME or ~/.kimi-code: config.toml, hooks/token-goat-shim.js, AGENTS.md, skills/token-goat/SKILL.md)')
    .option('--pi', 'also drop a pi (pi-coding-agent) extension (~/.pi/agent/extensions/token-goat.ts)')
    .option('--opencode', 'also drop an opencode plugin (~/.config/opencode/plugins/token-goat.ts, %APPDATA%\\opencode\\plugins\\token-goat.ts on Windows)')
    .option('--hermes', 'verify token-goat hooks are present for Hermes Agent (writes nothing new)')
    .option('--openclaw', 'also register an OpenClaw plugin (~/.openclaw/openclaw.json, ~/.openclaw/plugins/token-goat.ts)')
    .option('--copilot', 'also register a Copilot CLI hook config and routing block (~/.copilot/hooks/token-goat.json, ~/.copilot/hooks/token-goat-shim.js, ~/.copilot/copilot-instructions.md; with --local, <project>/.github/hooks/token-goat.json, <project>/.github/hooks/token-goat-shim.js, <project>/.github/copilot-instructions.md)')
    .option('--grok', 'also register a Grok CLI (xAI Grok Build) hook config (~/.grok/hooks/token-goat.json, ~/.grok/hooks/token-goat-shim.js)')
    .option('--vscode', 'also configure a VS Code MCP server (the workspace .vscode/mcp.json by default; --user for the user-profile mcp.json) and Copilot routing guidance')
    .option('--visualstudio', 'also configure a Visual Studio (2022 17.14+ / 2026) Copilot MCP server and routing guidance, no hooks (%USERPROFILE%\\.mcp.json and %USERPROFILE%\\copilot-instructions.md; -p/--project for <project>/.mcp.json and <project>/.github/copilot-instructions.md)')
    .option('--zed', 'also register token-goat as a Zed MCP context server (%APPDATA%\\Zed\\settings.json on Windows, ~/.config/zed/settings.json elsewhere, plus a generated shim script); Zed has no hooks API, so this is user scope only, no -p/--project support')
    .option('--cursor', 'also register a Cursor MCP server (~/.cursor/mcp.json by default; -p/--project for <project>/.cursor/mcp.json); writes no Cursor hooks config -- Cursor already imports the Claude Code hooks "token-goat install" writes to ~/.claude/settings.json')
    .option('--local', 'with --pi, install the project-local extension (<project>/.pi/extensions/token-goat.ts) instead of the global one')
    .action(guard(cmdInstall))

  program
    .command('uninstall')
    .description('remove token-goat hooks from Claude Code settings')
    .option('-p, --project', 'uninstall from project scope instead of user scope')
    .option('--user', 'with --vscode, remove the user-scope install instead of this project one')
    .option('--codex', 'also strip the Codex CLI integration (~/.codex/config.toml, ~/.codex/AGENTS.md)')
    .option('--gemini', 'also strip the Gemini CLI integration (~/.gemini/settings.json)')
    .option('--qwen', 'also strip the Qwen Code integration (~/.qwen/settings.json)')
    .option('--kimi', 'also strip the Kimi Code integration (config.toml hooks, hooks/token-goat-shim.js, the AGENTS.md block and skills/token-goat under $KIMI_CODE_HOME or ~/.kimi-code)')
    .option('--pi', 'also remove the pi (pi-coding-agent) extension')
    .option('--opencode', 'also remove the opencode plugin')
    .option('--hermes', 'no-op verification flag for symmetry with install (removes no files)')
    .option('--openclaw', 'also remove the OpenClaw plugin and config entry')
    .option('--copilot', 'also remove the Copilot CLI hook config and shim script, and strip the token-goat block from ~/.copilot/copilot-instructions.md (or <project>/.github/copilot-instructions.md with --local)')
    .option('--grok', 'also remove the Grok CLI hook config and shim script')
    .option('--vscode', 'also remove the VS Code MCP server (project scope by default; --user for the user-profile one) and routing guidance')
    .option('--visualstudio', 'also remove the Visual Studio MCP server entry and routing guidance (user scope by default; -p/--project for the project one)')
    .option('--zed', 'also remove the Zed MCP context server entry and its generated shim script')
    .option('--cursor', 'also remove the Cursor MCP server entry (user scope by default; -p/--project for the project one)')
    .option('--local', 'with --pi, remove the project-local extension instead of the global one')
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

  program
    .command('stats')
    .description('show session statistics (bare = totals only; --full for the breakdown)')
    .option('-j, --json', 'output as JSON')
    .option('--full', 'show the full breakdown (by source, by command, by day)')
    .option('--short', 'force the rich short KPI view even when stdout is not a TTY (e.g. piped)')
    .option('--methodology', 'explain local savings estimates and their billing limits')
    .option('--hooks', 'show the per-event/per-harness hook latency breakdown (median/p95/slowest/last-seen)')
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
    .option('--cmd-b64 <payload>', 'the shell command as a base64-encoded string (preserves quotes, backslashes, and symbols across platforms)')
    .option('-f, --filter <name>', 'filter name (auto-detected from the command when omitted)')
    .option('--timeout <seconds>', 'wall-clock timeout in seconds (0 = built-in default)')
    .option('--no-compress', 'stream output raw without compression (debug the wrapper)')
    .option('--profile <name>', 'compression profile: aggressive | balanced | minimal')
    .option('--max-tokens <n>', 'post-compress token cap (0 = no cap)')
    .option('-q, --quiet-success', 'on exit code 0, emit only [tg: ok] summary and store full output for recall via bash-output')
    .option('--native', 'use native platform shell (e.g. cmd.exe on Windows) instead of bash, preserving Windows path backslashes')
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
          const argv: string[] = [process.argv[0] ?? 'node', process.argv[1] ?? 'token-goat', cmd, '--help']
          program.parse(argv)
        } else {
          out(generateCompactHelp())
        }
      }),
    )

  // Replace default help with compact grouped summary
  program.helpOption('-h, --help', 'display help for command')
  // Override helpInformation (which formatHelp calls) to use compact grouped output.
  // Capture the prototype implementation first: the assignment below is an own
  // property that shadows it permanently, so `help --full` has no other way back
  // to the long listing.
  originalHelpInformation = (
    program as unknown as { helpInformation(): string }
  ).helpInformation.bind(program)
  ;(program as unknown as { helpInformation(): string }).helpInformation = () => generateCompactHelp()

  return program
}

/** Applies commander's exitOverride to a command and, recursively, every subcommand under it. */
export function applyExitOverride(command: Command): void {
  command.exitOverride()
  for (const sub of command.commands) applyExitOverride(sub)
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
  // `--batch-serve <token>`: serve many invocations from this one already-started process. Same
  // argv[2]-only interception as --worker-daemon above, and for the same reason -- commander has
  // no such option, so it would reject it before the server ever started. See batch_serve.ts.
  if (argv[2] === '--batch-serve' && typeof argv[3] === 'string') {
    const { serveBatch } = await import('./batch_serve.js')
    serveBatch(argv[3], (a) => run(a))
    return
  }
  // Any command that reads or indexes a file can reach a synchronous parse, and the regex language adapters live behind a dynamic import so the hook path never compiles them (see loadRegexExtractors). Load them once here rather than at each of the call sites below it.
  await loadRegexExtractors()
  const program = buildProgram()
  // Commander's exitOverride lets us catch its internal exits (help, version, unknown command)
  // instead of letting it call process.exit() mid-flush.
  //
  // Applied to every subcommand, not just the program. Commander copies the exit callback to a
  // subcommand when that subcommand is CREATED (copyInheritedSettings, called from .command()), and
  // buildProgram() has already created all of them by the time this runs -- so they each inherited
  // "no callback" and `token-goat <subcommand> --help` called process.exit() for real, which is
  // exactly what main.ts's docblock says this binary must never do, because an exit mid-flush can
  // truncate output already written to a pipe.
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
    err(`token-goat: ${displaySafeText(msg)}`)
    process.exitCode = 1
  }
}
