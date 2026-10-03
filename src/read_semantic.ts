/** The `semantic` command: a dense embedding search fused with a BM25 keyword pass by reciprocal rank, each hit tagged with the symbol that encloses it. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadConfig } from './config.js'
import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { deliveredOutputBytes } from './delivery_cap.js'
import { emitErr } from './emit.js'
import { ORT_WEB_WASM, RUNTIME_UNAVAILABLE_ADVICE } from './embed_runtime.js'
import { searchSemantic, OVER_FETCH_FACTOR, MAX_OVER_FETCH, isAvailable as embeddingModelAvailable, embeddingBackendLoadError, type EmbeddingPreflightResult, type SearchHit } from './embeddings.js'
import { mergeNearbyHits } from './semantic_merge.js'
import { checkSemanticReadiness, foregroundDownloadDeferred, modelDownloadHeld, WARM_COMMAND } from './embed_preflight.js'
import { withExplicitDownload } from './model_download_gate.js'
import { searchEvidenceSemantically } from './evidence_cache.js'
import { isIndexEmptyForProject, emptyIndexMessage, getEmbeddingCoverage } from './index_health.js'
import { querySymbols, searchSymbolsFts } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { displaySafeJson, toDisplayPath } from './paths.js'
import { resolveProjectRoot } from './project.js'
import { recordSemanticQuery } from './semantic_distances.js'
import { guardJsonRows, guardText, largestFileSize, recordReadStat, warnIfFilesStale } from './read_commands.js'
import { previewLines } from './read_meta.js'
import { resolveProjectConfinement } from './read_spec.js'
import { ensureWorkerAlive } from './worker_lifecycle.js'
import { compileGrepMatcher, countNoun, excludeTestsHiddenNote, extractErrorMessage, grepFilteredToEmptyNotice, isTestFile } from './util.js'

// Resolves the enclosing symbol for a semantic chunk's line range, keyed off its `startLine`.
//
// Containment rule (documented per the semantic-fields task): a symbol is a candidate only if `symbol.lineStart <= chunk.startLine <= symbol.lineEnd` -- the chunk's START line must fall strictly inside the symbol's own indexed range. This deliberately does NOT use "nearest symbol by start line": a top-of-file chunk (imports/module header, before any symbol starts) would otherwise get wrongly labelled with whatever symbol happens to sit below it, even though it isn't inside that symbol at all. Chunk boundaries don't always align with symbol boundaries (embeddings.ts's chunkFile folds short boundary ranges into neighbors and can merge across gaps), so a chunk may overlap zero, one, or several symbols -- using the START line is the same "does this line belong to a definition" question `read`/`skeleton` already answer elsewhere in this file, and needs no separate end-line/overlap policy.
//
// Among all containing candidates, innermost wins: the smallest range (fewest lines) is preferred, e.g. a method chunk resolves to the method itself, not its enclosing class.
function resolveEnclosingSymbol(filePath: string, chunkStartLine: number): { name: string; kind: string; lineStart: number } | null {
  // No rootDir scope here: filePath alone already narrows to the exact file the hit came from (an absolute path from the embeddings index), so an additional project-prefix filter is redundant and, worse, can spuriously exclude the very row being looked up whenever the stored/queried root strings don't normalize identically (e.g. a symlinked or 8.3-short temp path) -- the same file_path equality check every exact-file lookup in read_commands.ts already relies on without a rootDir filter (see its `resolved` lookups). Unbounded (-1), not a finite cap: querySymbols orders by (file_path, line_start), so a per-file cap on a bare filePath query has no predicate left to combine against and silently drops every symbol past the cutoff -- a generated/data-shaped file with more flat top-level declarations than the old 100,000 cap lost its tail (confirmed with a 100,051-symbol fixture), so a hit landing in the last symbol resolved to no enclosing symbol instead of the real one. Same fix and reasoning as ALL_SYMBOLS_IN_FILE_LIMIT in graph_commands.ts.
  const symbols = querySymbols({ filePath, limit: -1 }, globalDbPath())
  let best: SymbolEntry | null = null
  for (const s of symbols) {
    if (s.lineStart <= chunkStartLine && chunkStartLine <= s.lineEnd) {
      if (best === null || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) {
        best = s
      }
    }
  }
  // lineStart is returned alongside name/kind because the fusion key below needs it: a bare name is not unique within a file (two classes can each define a same-named method), and keying on name alone silently collapses two genuinely different symbols into one Map entry, dropping one.
  return best === null ? null : { name: best.name, kind: best.kind, lineStart: best.lineStart }
}

interface SemanticOptions {
  limit?: number
  /** Project root to scope the search to. Defaults to `process.cwd()`; same field name as {@link ChangedOptions.projectRoot}. Callers whose cwd is not the workspace root (e.g. an MCP server launched by a client from an opaque directory) should pass the actual workspace root explicitly -- otherwise the search silently scopes to the wrong project (or the whole machine-wide index yields nothing under it). */
  projectRoot?: string
  /** Emit machine-readable JSON instead of the human-formatted preview blocks, matching every other surgical-read command's --json convention (symbol, skeleton, outline, refs). */
  json?: boolean
  /** Filter to hits whose FILE PATH matches this pattern (matched against the path as rendered under displayRoot, same convention as `refs --grep`). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. Applied before the `--limit` slice in both the embeddings and FTS-fallback branches. */
  grep?: string
  /** `--exclude-tests`: drop hits whose file lives in a test file (per isTestFile), matching `refs`/`callers`/`dead`'s flag of the same name. Opt-in; omitted or false leaves output byte-identical to today. Distinct from `grep`, which can only ever *select* paths -- there is no `--grep` pattern that reliably excludes tests, since a negative lookahead silently degrades to a literal substring match on the regex-compile fallback. Composes with `grep`: a hit must satisfy both. Applied before the `--limit` slice in both branches. */
  excludeTests?: boolean
  /** Run semantic embedding preflight check and exit. */
  preflight?: boolean
  /** Warm up the embedding model session in memory before query execution. */
  warm?: boolean
}

// Ported from cli.ts's cmdSemantic, which used to throw a CliError (caught by the generic `guard` wrapper, which prefixes it with "token-goat: " before printing to stderr) on a no-matches miss instead of returning a code. The "token-goat: " prefix is baked into the returned text here so the CLI's output stays byte-identical to that historical path. Reciprocal Rank Fusion constant (score = sum over lists of 1/(RRF_K + rank)) -- the conventional k=60, chosen because RRF needs only each list's RANK (not its raw score), which sidesteps having to normalize dense cosine/L2 distance against BM25's unbounded score on incomparable scales.
const RRF_K = 60

// One row of runSemantic's fused dense+BM25 candidate set: dense-sourced rows carry a non-null distance and (when resolveEnclosingSymbol found a containing symbol) a name/kind pulled from that containment lookup, while FTS-sourced rows always carry the exact symbol's own name/kind and a null distance (BM25 has no notion of vector distance) -- a row present in both lists keeps its dense fields (distance, containment-derived name/kind) and simply accumulates the FTS list's rank into its score.
interface FusedSemanticHit {
  filePath: string
  startLine: number
  endLine: number
  name: string | null
  kind: string | null
  distance: number | null
  previewText: string
  rrf: number
  // Which of the two retrievals produced this row. Derivable from `distance` for the dense leg alone, but not for the lexical one: a row the dense pass found and the FTS pass also voted for keeps its dense fields and only accumulates rank into `rrf`, so before these flags a both-lists row and a dense-only row rendered identically while sorting differently. That is the whole of what a reader cannot otherwise reconstruct from the printed output.
  inDense: boolean
  inLexical: boolean
}

/** Splits dense hits on the relevance floor, returning what survives and the closest distance that did not. The rejected minimum is what lets the caller say why the half came back empty: a floor is a threshold on a continuum, so "nothing matched" and "the best thing was 0.91 against a floor of 0.9" are different facts and only the second one is actionable. Compares raw `distance` rather than the rerank's `adjustedDistance`, since the floor was measured against raw distances and the rerank's boosts and path penalties are a ranking device with no calibrated scale. */
export function applyRelevanceFloor(
  hits: readonly SearchHit[],
  floor: number,
): { kept: SearchHit[]; nearestRejected: number | null } {
  const kept: SearchHit[] = []
  let nearestRejected: number | null = null
  for (const h of hits) {
    if (h.distance <= floor) {
      kept.push(h)
    } else if (nearestRejected === null || h.distance < nearestRejected) {
      nearestRejected = h.distance
    }
  }
  return { kept, nearestRejected }
}

/** The fields every `--json` answer carries when matching on meaning took no part in it: the preflight's status, summary and required action when the embeddings are not ready, or the error the dense search raised when they were. Nothing when it ran, so a consumer reads a degraded answer the same way whether hits came back, none did, or the index is empty. */
function semanticDegradedFields(preflight: EmbeddingPreflightResult, searchSemanticError: string | null): { preflightStatus?: string; warning?: string; actionRequired?: string } {
  if (preflight.status !== 'ready') {
    return {
      preflightStatus: preflight.status,
      warning: preflight.summary,
      ...(preflight.actionRequired ? { actionRequired: preflight.actionRequired } : {}),
    }
  }
  if (searchSemanticError !== null) {
    return { preflightStatus: 'degraded', warning: `Matching on meaning failed (${searchSemanticError}); results come from keyword search alone.` }
  }
  return {}
}

export async function runSemantic(query: string, opts: SemanticOptions): Promise<{ text: string; code: number }> {
  // Same reasoning as runSymbol in read_symbol.ts: a limit of 0 (or negative) would silently query for zero results instead of surfacing a clear "you asked for nothing" error.
  if (opts.limit !== undefined && opts.limit <= 0) {
    const message = `--limit must be a positive number, got: ${opts.limit}`
    if (opts.json === true) {
      return { text: displaySafeJson({ error: message }), code: 1 }
    }
    return { text: message, code: 1 }
  }

  const n = opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : 20

  // A caller-supplied projectRoot must be an absolute, existing directory -- otherwise searchSemantic silently finds nothing under the bogus root and this function falls back to the (now project-scoped) FTS search using that same bogus root, which also finds nothing, and the caller gets a plain "no matches" instead of a clear signal that the scope they asked for doesn't exist. Fail loudly instead of silently widening/losing scope.
  if (opts.projectRoot !== undefined) {
    if (!path.isAbsolute(opts.projectRoot) || !fs.existsSync(opts.projectRoot) || !fs.statSync(opts.projectRoot).isDirectory()) {
      const message = `token-goat: projectRoot must be an absolute, existing directory, got '${opts.projectRoot}'`
      if (opts.json === true) {
        return { text: displaySafeJson({ error: message }), code: 1 }
      }
      return { text: message, code: 1 }
    }
  }
  // Both halves of the search read the machine-wide index, so a caller-named root outside what indexing.cross_project_symbols = false admits is refused the way `symbol` refuses it, rather than searched.
  const projectDenial = resolveProjectConfinement(opts.projectRoot).denial
  if (projectDenial !== null) {
    return { text: opts.json === true ? displaySafeJson({ error: projectDenial }) : projectDenial, code: 1 }
  }
  const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
  let projectCoverage: { indexedFiles: number; embeddedFiles: number } | undefined
  try {
    projectCoverage = getEmbeddingCoverage(globalDbPath(), rootDir)
  } catch {
    // DB or project root not yet initialized
  }

  // `--warm` is the user asking for the model now, so it downloads through a hold a failed background try left behind (model_download_gate.ts).
  const readiness = (): Promise<EmbeddingPreflightResult> => {
    const check = (): Promise<EmbeddingPreflightResult> =>
      checkSemanticReadiness({
        ...(opts.warm !== undefined ? { warm: opts.warm } : {}),
        projectRoot: rootDir,
        ...(projectCoverage !== undefined ? { coverage: projectCoverage } : {}),
      })
    return opts.warm === true ? withExplicitDownload(check) : check()
  }

  // `--warm` with no query is the foreground warm-up command: it loads the model and reports readiness the way `--preflight` does, rather than searching for ''.
  if (opts.preflight === true || (opts.warm === true && query === '')) {
    const preflight = await readiness()
    if (opts.json === true) {
      return { text: displaySafeJson(preflight), code: preflight.status === 'ready' ? 0 : 1 }
    }
    const lines = [
      `Semantic embedding status: ${preflight.status.toUpperCase()}`,
      `  Summary: ${preflight.summary}`,
      `  Config (indexing.embeddings_enabled): ${preflight.configEnabled ? 'enabled' : 'disabled'}`,
      `  ONNX runtime (${preflight.runtime}): ${preflight.runtimeAvailable ? `available (${preflight.runtimeVersion})` : 'unavailable'}`,
      ...(preflight.runtimeBinaryPresent === null
        ? []
        : [`  Runtime binary (${ORT_WEB_WASM.name}, ~14 MB): ${preflight.runtimeBinaryPresent ? 'downloaded' : 'not downloaded yet, fetched once on first use'}`]),
      `  Model files (~35 MB): ${preflight.modelFilesPresent ? 'present' : 'missing'}`,
      `  In-memory session: ${preflight.modelWarmed ? 'ready / warmed' : 'not loaded'}`,
      `  Project coverage: ${preflight.embeddedFiles}/${countNoun(preflight.indexedFiles, 'file')} (${preflight.coveragePercent}%)`,
    ]
    if (preflight.actionRequired) {
      lines.push(`  Action: ${preflight.actionRequired}`)
    }
    return { text: lines.join('\n'), code: preflight.status === 'ready' ? 0 : 1 }
  }

  // Preflight check surfaces broken or degraded embeddings before a query is attempted.
  const preflight = await readiness()

  // Same flag that gates embedding at index time (parser.ts, worker.ts) must also gate it here at query time, or TOKEN_GOAT_EMBEDDINGS_ENABLED=0 -- read by every other embedding-adjacent path in this codebase, including memory_prune.ts's tryEmbeddingClusters -- does nothing for `semantic`: embeddingModelAvailable() below only checks whether the optional onnxruntime-node runtime is installed, not whether the user opted out, so a disabled-but-installed runtime would still call searchSemantic, which calls embedTexts, which downloads the ~34 MB model on a cold cache regardless of this setting. Checked once here so both the availability warning below and the searchSemantic call are skipped together.
  const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true

  if (embeddingsEnabled && !embeddingModelAvailable()) {
    console.warn(
      `Matching on meaning is off (${embeddingBackendLoadError()?.message ?? 'the inference runtime could not start'}); these results come from keyword search alone. ${RUNTIME_UNAVAILABLE_ADVICE}`,
    )
  } else if (!embeddingsEnabled) {
    console.warn(
      'Matching on meaning is off (indexing.embeddings_enabled / TOKEN_GOAT_EMBEDDINGS_ENABLED is disabled); these results come from keyword search alone.',
    )
  } else if (preflight.status !== 'ready') {
    console.warn(
      `Matching on meaning is degraded (${preflight.summary}); these results come from keyword search alone.${preflight.actionRequired ? ` Action: ${preflight.actionRequired}` : ''}`,
    )
  }
  const overFetchForMerge = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  // The dense half is best-effort, and this catch is the whole of what makes that true. The package being absent is handled inside searchSemantic (it returns no hits), but the model files are a separate thing that can be missing on their own: the runtime installs fine and then the weights cannot be fetched -- offline mode, no cache yet, a network failure, a digest that does not match. That throws out of embedTexts, and before this catch it escaped runSemantic entirely, so `semantic` exited non-zero with nothing on stdout at the exact moment it was supposed to degrade to keyword search. Same treatment as the absent package: say what is missing, then carry on with the BM25 pass below, which is the half that still works.
  let rawHits: SearchHit[] = []
  let searchSemanticError: string | null = null
  // A held download (see modelDownloadHeld) would only fail again, and the warning above already says why and how to fix it. A download this process would make around the machine's proxy is left to the worker (see foregroundDownloadDeferred), which is started if it is not running, since that is where the download now happens.
  const deferred = embeddingsEnabled && foregroundDownloadDeferred()
  if (deferred && !modelDownloadHeld()) {
    ensureWorkerAlive()
    console.warn(`The embedding model is not downloaded yet. This process would go around the proxy in HTTPS_PROXY to fetch it, so the background worker downloads it through the proxy instead; these results come from keyword search alone until then. To download it now, run \`${WARM_COMMAND}\`.`)
  }
  if (embeddingsEnabled && !deferred) {
    try {
      rawHits = await searchSemantic(
        getDb(globalDbPath()),
        query,
        overFetchForMerge,
        undefined,
        undefined,
        rootDir,
      )
    } catch (e) {
      searchSemanticError = extractErrorMessage(e)
      if (preflight.status === 'ready') {
        console.warn(
          `Matching on meaning is off (${searchSemanticError}); these results come from keyword search alone.`,
        )
      }
    }
  }

  // Relevance floor, applied here rather than inside the scan -- see the max_distance comment on SemanticConfig for why the scan's own bound is the wrong place for it. Reading the nearest rejected distance before filtering is the whole point of the diagnostic below: without it, a floor set too tight for a given corpus removes real answers and says nothing, which is the silent-recall-loss shape this command already had one instance of (an empty dense half only warns when the project is partly unembedded, so on a fully embedded project it warned about nothing at all).
  let floorNearestRejected: number | null = null
  if (rawHits.length > 0) {
    const floor = loadConfig().semantic.max_distance
    const { kept, nearestRejected } = applyRelevanceFloor(rawHits, floor)
    floorNearestRejected = nearestRejected
    // Only when the floor emptied the half outright: trimming a weak tail off a list that still has its best hit is the floor working as intended, and saying so on every ordinary search would be noise.
    if (kept.length === 0 && nearestRejected !== null) {
      console.warn(
        `Matching on meaning found nothing within ${floor} (closest was ${nearestRejected.toFixed(3)}); ` +
          `these results come from keyword search alone. Raise semantic.max_distance to see weaker matches.`,
      )
    }
    rawHits = kept
  }
  // Nearest-neighbour search always returns something, so a page of noise prints exactly like a page of answers; the floor above is left loose on purpose and cannot say so. Measured on the floor's survivors, and only when there are any: an empty dense half already has its own warning.
  const closestDense = rawHits.reduce<number | null>((best, h) => (best === null || h.distance < best ? h.distance : best), null)
  const weakDistance = loadConfig().semantic.weak_distance
  const weakClosestDistance = closestDense !== null && closestDense > weakDistance ? closestDense : null
  // A query with no dense answer because the model was not ready says nothing about distances, so only a returned hit or a ready, error-free pass is recorded.
  if (closestDense !== null || (preflight.status === 'ready' && !searchSemanticError)) {
    recordSemanticQuery({ projectRoot: rootDir, closestDistance: closestDense, floorRejectedMin: floorNearestRejected, weak: weakClosestDistance !== null })
  }

  // The dense half contributing nothing is the moment this search is most misleading, because the BM25 pass below still answers and the output looks like a complete result. It is also the only moment worth paying for the coverage query, so it is gated here rather than run every call: with hits, the reader has evidence embeddings are working; with none, they have no way to tell "nothing in your code is similar" from "almost none of your code was ever embedded". Warn only when the model itself is available and didn't fail with an error, since those branches already explain that case. floorNearestRejected guards this: when the floor is what emptied the half, it has already said so with the concrete distance, and following that with a coverage hypothesis would offer a second explanation for something already explained.
  if (
    rawHits.length === 0 &&
    floorNearestRejected === null &&
    embeddingModelAvailable() &&
    preflight.status === 'ready' &&
    !searchSemanticError
  ) {
    try {
      // Config read and coverage query both inside the try: this whole block is a diagnostic aid, and a diagnostic that can throw is worse than no diagnostic -- it would turn a search that otherwise answered into a crash.
      const enabled = loadConfig().indexing.embeddings_enabled
      const { indexedFiles, embeddedFiles } = enabled
        ? getEmbeddingCoverage(globalDbPath(), rootDir)
        : { indexedFiles: 0, embeddedFiles: 0 }
      if (indexedFiles > 0 && embeddedFiles < indexedFiles) {
        console.warn(
          `Matching on meaning found nothing, and only ${embeddedFiles} of ${indexedFiles} indexed file(s) in this ` +
            `project have embeddings — these results come from keyword search alone. Run 'token-goat doctor' for why.`,
        )
      }
    } catch {
      // Coverage is a diagnostic aid, never a reason to fail a search that otherwise works.
    }
  }
  const mergedHits = mergeNearbyHits(rawHits)
  // BM25 full-text search over symbol names/bodies/docstrings, over-fetched for the same reason as the dense side above: searchSymbolsFts caps at the DB level via its own SQL LIMIT, so a post-hoc filter (--grep/--exclude-tests) or a post-hoc fusion rank on an already-`n`-capped result would silently under-represent this list relative to the dense one -- always called now (previously gated behind the dense branch returning zero hits), reusing the same OVER_FETCH_FACTOR/MAX_OVER_FETCH ratio the dense branch already uses.
  const overFetchFts = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  const ftsRows = searchSymbolsFts(query, overFetchFts, undefined, rootDir)

  // Fuse both candidate lists with Reciprocal Rank Fusion -- a row is keyed by its enclosing symbol (filePath + name + the symbol's own lineStart) when one is known, since that is the only identity both a dense chunk and a BM25 symbol row can genuinely share; the lineStart component matters because name alone is not unique within a file (e.g. a same-named method on two different classes), and dropping it would silently collapse two distinct symbols into one fused row. A dense hit with no resolvable enclosing symbol falls back to filePath + start line, which an FTS row (always symbol-backed) can never collide with, so it simply stays its own row.
  const fused = new Map<string, FusedSemanticHit>()
  mergedHits.forEach((h, denseRank) => {
    const enclosing = resolveEnclosingSymbol(h.filePath, h.startLine)
    const key = enclosing !== null ? `${h.filePath}::${enclosing.name}@${enclosing.lineStart}` : `${h.filePath}::L${h.startLine}`
    // A long symbol is several chunks, and the list is best-first, so the first chunk to claim a symbol is its best: a later one taking the row would report a worse range at a worse rank.
    if (fused.has(key)) return
    fused.set(key, {
      filePath: h.filePath,
      startLine: h.startLine,
      endLine: h.endLine,
      name: enclosing?.name ?? null,
      kind: enclosing?.kind ?? null,
      distance: h.distance,
      previewText: h.text,
      rrf: 1 / (RRF_K + denseRank),
      inDense: true,
      inLexical: false,
    })
  })
  ftsRows.forEach((s, ftsRank) => {
    const key = `${s.filePath}::${s.name}@${s.lineStart}`
    const existing = fused.get(key)
    if (existing !== undefined) {
      // Already present from the dense pass -- keep its dense-sourced fields (distance, containment-derived name/kind) and just add this list's rank contribution to the score.
      existing.rrf += 1 / (RRF_K + ftsRank)
      existing.inLexical = true
    } else {
      fused.set(key, {
        filePath: s.filePath,
        startLine: s.lineStart,
        endLine: s.lineEnd,
        name: s.name,
        kind: s.kind,
        distance: null,
        previewText: s.body,
        rrf: 1 / (RRF_K + ftsRank),
        inDense: false,
        inLexical: true,
      })
    }
  })
  // Map insertion order (JS Map iterates in insertion order) puts every dense-pass row ahead of any FTS-only row it didn't merge with, so a stable sort's tie-break (identical RRF score, e.g. both lists' rank-0) prefers the dense-backed row -- deliberate, since a dense hit is a direct answer to the query's semantics while a tied BM25-only row only matched a shared term.
  const fusedHits = Array.from(fused.values()).sort((a, b) => b.rrf - a.rrf)

  // --grep narrows on the FILE PATH AS RENDERED (toDisplayPath), matching `refs --grep`'s convention -- an anchored `^src/` must match what the human/JSON output actually shows, not the stored absolute path; applied here, between fusion and slice, so `--limit 20 --grep '^src/'` returns 20 src/ hits rather than however many of the top-20 *unfiltered* hits happen to live under src/ -- the "filter must precede slice" trap this repo has hit before. --exclude-tests rides the same seam for the same reason: filtering after the slice would return however many of the top-`n` hits happen not to be tests, rather than `n` non-test hits -- it is checked against the STORED path (isTestFile), not the rendered one, because whether a file is a test is a property of the file itself, not of how it is displayed.
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const preFilterCount = fusedHits.length
  const keepHit = (h: { filePath: string }): boolean => {
    if (opts.excludeTests === true && isTestFile(h.filePath)) return false
    return matchesGrep === undefined || matchesGrep(toDisplayPath(rootDir, h.filePath))
  }
  const anyFilter = matchesGrep !== undefined || opts.excludeTests === true
  const filteredHits = anyFilter ? fusedHits.filter(keepHit) : fusedHits
  // Counted on the grep-surviving set, so the number reported by the --exclude-tests notice is "tests hidden among the hits you actually asked for", not tests hidden repo-wide.
  const suppressedTotal = opts.excludeTests === true
    ? fusedHits.filter((h) => (matchesGrep === undefined || matchesGrep(toDisplayPath(rootDir, h.filePath))) && isTestFile(h.filePath)).length
    : 0
  // Measured before the slice. `guardJsonRows` below counts whatever array it is handed, so running it on the already-sliced list made `totalCount` report the number of survivors and `truncated` describe only the overflow guard: `--limit 2` on a 6-match query answered `totalCount: 2, truncated: false`, which is a wrong number rather than a missing one.
  const eligibleCount = filteredHits.length
  const hits = filteredHits.slice(0, n)
  // Both candidate lists are over-fetched to a bound (OVER_FETCH_FACTOR/MAX_OVER_FETCH). When a list came back AT its bound the fused set may itself be clipped, so `eligibleCount` is a floor rather than a total, and the wording below has to say so rather than name a number it cannot stand behind.
  const candidatesClipped = rawHits.length >= overFetchForMerge || ftsRows.length >= overFetchFts

  // Which list(s) actually contributed a candidate decides the reported `source` -- 'hybrid' only when both lists had at least one raw hit (even if they didn't fuse into the same row), never 'embeddings' silently standing in for a result that is partly BM25.
  const hadDense = mergedHits.length > 0
  const hadFts = ftsRows.length > 0
  const source = hadDense && hadFts ? 'hybrid' : hadDense ? 'embeddings' : 'fts'

  // Same multi-file self-heal-and-warn as runAsk/refs above -- `semantic` fuses hits across however many distinct files matched, none of which the caller named as a single spec.
  warnIfFilesStale(hits.map((h) => h.filePath), 'semantic')

  if (hits.length > 0) {
    if (opts.json === true) {
      // `filePath` rewritten to the same root-relative spelling the human blocks below render (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, matching outline/skeleton/refs --json. `rank`, `rrf` and `retrieval` are what make the ordering reproducible: `distance` is the dense leg's own score and does not explain the order, since the list is sorted by the fused rrf total and an FTS-only row has no distance at all. A consumer given distance alone can only conclude the results are mis-sorted.
      const items = hits.map((h, i) => ({
        filePath: toDisplayPath(rootDir, h.filePath),
        name: h.name,
        kind: h.kind,
        startLine: h.startLine,
        endLine: h.endLine,
        rank: i + 1,
        rrf: h.rrf,
        retrieval: h.inDense && h.inLexical ? 'both' : h.inDense ? 'dense' : 'lexical',
        distance: h.distance,
        preview: previewLines(h.previewText, 3),
      }))
      // Same {items, truncated, totalCount} envelope guardJsonRows returns for symbol/refs/skeleton/outline's --json mode (see the comment at the grep --json call site) -- a bare {source, items} payload would silently hand a JSON consumer fewer hits than actually matched with no way to tell "capped by the overflow guard" apart from "there just weren't more", and would let `--limit 500 --json` emit an unbounded payload.
      const capped = guardJsonRows(items)
      // Two independent losses -- the --limit slice above and the overflow guard inside guardJsonRows -- so `truncated` is the OR of both, and `totalCount` is the count before either ran. `totalCountIsFloor` is set only when the candidate over-fetch was itself at its bound, so a consumer can tell an exact total from a lower bound instead of being handed a number that quietly means different things on different runs.
      const limitTruncated = hits.length < eligibleCount
      const text = displaySafeJson({
        source,
        ...capped,
        truncated: capped.truncated || limitTruncated,
        totalCount: eligibleCount,
        ...(candidatesClipped ? { totalCountIsFloor: true } : {}),
        ...(weakClosestDistance !== null ? { lowConfidence: { closestDistance: weakClosestDistance, threshold: weakDistance } } : {}),
        ...semanticDegradedFields(preflight, searchSemanticError),
      })
      recordReadStat('semantic_search', largestFileSize(hits.map((h) => h.filePath)), text, query)
      return { text, code: 0 }
    }
    // A dense-sourced row (distance !== null) renders the distance-annotated block the embeddings branch always used, including the "— inside NAME (KIND)" containment suffix when resolved; an FTS-only row (distance === null, always symbol-backed) renders the plain "name (kind) — path" header the FTS fallback always used, with no "distance" or "inside" wording, since it IS the symbol, not a chunk found to be inside one.
    const blocks = hits.map((h, i) => {
      // The rank prefix is the fix for a list whose printed numbers do not explain its order: rows are sorted by the fused rrf total, so a dense row at distance 0.850 legitimately outranks one at 0.776 when the keyword pass voted for the first as well, and without the position that reads as a sorting bug. `+keyword` marks exactly those rows, and `keyword` marks a row the dense pass never returned -- which is why it carries no distance to print. A dense-only row stays byte-identical to what it always rendered, so the common case costs nothing extra.
      const mark = h.inDense && h.inLexical ? ', +keyword' : ''
      if (h.distance !== null) {
        const suffix = h.name !== null ? ` — inside ${h.name} (${h.kind})` : ''
        return `# ${i + 1}. ${toDisplayPath(rootDir, h.filePath)}:${h.startLine}-${h.endLine} (distance ${h.distance.toFixed(3)}${mark})${suffix}\n${previewLines(h.previewText, 3)}`
      }
      return `# ${i + 1}. ${h.name} (${h.kind}) — ${toDisplayPath(rootDir, h.filePath)}:${h.startLine}-${h.endLine} (keyword)\n${previewLines(h.previewText, 3)}`
    })
    const text = guardText(blocks.join('\n\n'), 'semantic')
    // stderr rather than appended to `text`: this function returns its text to callers that route it to stdout (and to the MCP server in-process), so a notice folded into the payload would become part of the search result itself.
    if (hits.length < eligibleCount) {
      emitErr(`Showing ${hits.length} of ${candidatesClipped ? 'at least ' : ''}${countNoun(eligibleCount, 'match', 'matches')} (raise --limit to see the rest).`)
    }
    // Names the query because a multi-query call prints every block's stderr ahead of the blocks themselves.
    if (weakClosestDistance !== null) {
      console.warn(
        `Matching on meaning found nothing close for '${query}' (closest was ${weakClosestDistance.toFixed(3)}, weak above ${weakDistance}); these results may be unrelated. ` +
          `For a known name try token-goat symbol --grep <pattern> or rg, or rephrase the query.`,
      )
    }
    recordReadStat('semantic_search', largestFileSize(hits.map((h) => h.filePath)), text, query)
    return { text, code: 0 }
  }

  // Total number of fused hits that existed BEFORE --grep was applied -- used to distinguish "--grep matched none of the N hits that do exist" (this is a real store that a filter emptied out) from a genuinely empty index/search, per this repo's filtered-store convention (dead/refs/exports/imports all draw this same distinction).
  if (matchesGrep !== undefined && preFilterCount > 0) {
    const notice = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'match', 'matches')
    if (opts.json === true) {
      const payload = { source: 'fts', items: [], truncated: false, totalCount: 0, grepFilteredToEmpty: true, hint: notice.trim() }
      return { text: displaySafeJson(payload), code: 0 }
    }
    return { text: `token-goat: ${notice.trim()}`, code: 0 }
  }
  // Same distinction one flag over: "--exclude-tests hid every hit there was" is a filtered store, not an empty one, so it exits 0 with a notice naming the count instead of the exit-1 "no matches" below -- checked after --grep so a run with both flags reports the narrower grep story first, matching runRefs's ordering.
  if (opts.excludeTests === true && suppressedTotal > 0) {
    const notice = `no non-test matches for '${query}' (${excludeTestsHiddenNote(suppressedTotal)})`
    if (opts.json === true) {
      const payload = { source: 'fts', items: [], truncated: false, totalCount: 0, excludeTestsFilteredToEmpty: true, hint: notice }
      return { text: displaySafeJson(payload), code: 0 }
    }
    return { text: `token-goat: ${notice}`, code: 0 }
  }
  // Evidence is a project-scoped fallback, not a replacement for source-index matches: its entries are redacted historical observations and carry no source line contract. Only consult it after both source retrieval paths miss and when no source-specific filter was requested.
  if (!anyFilter) {
    const evidenceHits = await searchEvidenceSemantically(rootDir, query, n)
    if (evidenceHits.length > 0) {
      // What this hit avoids is re-reading the cached entries in full, so the saving is measured against their whole text: the preview below is what gets emitted, and recordReadStat subtracts it. Each entry is recalled by its own shell command, so each is priced at what the harness would have delivered of it.
      const evidenceFullBytes = evidenceHits.reduce((sum, entry) => sum + deliveredOutputBytes(Buffer.byteLength(entry.text, 'utf8')), 0)
      if (opts.json === true) {
        const items = evidenceHits.map((entry) => ({
          source: toDisplayPath(rootDir, entry.source),
          representation: entry.representation,
          preview: previewLines(entry.text, 3),
          cachedAt: entry.createdAt,
        }))
        const capped = guardJsonRows(items)
        const text = displaySafeJson({ source: 'workspace-evidence', ...capped })
        recordReadStat('semantic_search', evidenceFullBytes, text, query)
        return { text, code: 0 }
      }
      const text = guardText(
        evidenceHits
          .map((entry) => `# cached ${entry.representation} evidence — ${toDisplayPath(rootDir, entry.source)}\n${previewLines(entry.text, 3)}`)
          .join('\n\n'),
        'semantic',
      )
      recordReadStat('semantic_search', evidenceFullBytes, text, query)
      return { text, code: 0 }
    }
  }
  // Only paid after both the dense search and the BM25 search already came back empty.
  const indexEmpty = isIndexEmptyForProject(globalDbPath(), rootDir)
  if (opts.json === true) {
    // A dedicated field, never prose folded into an existing string field -- same "add a field, don't rewrite an existing one" convention doctor's own {status, message} shape follows, and consistent with this payload's own {source, items, truncated, totalCount} envelope.
    let symFound = false
    const trimmedQuery = query.trim()
    const isIdentifier = /^[A-Za-z0-9_.:-]+$/.test(trimmedQuery)
    if (!indexEmpty && isIdentifier) {
      try {
        const symMatches = querySymbols({ name: trimmedQuery, rootDir, limit: 1 })
        if (symMatches.length > 0) {
          symFound = true
        }
      } catch {
        // Ignore DB errors during symbol lookup fallback
      }
    }
    const payload = indexEmpty
      ? {
          source: 'fts',
          items: [],
          truncated: false,
          totalCount: 0,
          indexEmpty: true,
          hint: emptyIndexMessage(rootDir),
          ...semanticDegradedFields(preflight, searchSemanticError),
        }
      : {
          source: 'fts',
          items: [],
          truncated: false,
          totalCount: 0,
          ...semanticDegradedFields(preflight, searchSemanticError),
          ...(!indexEmpty && isIdentifier
            ? {
                symbolSuggestion: `token-goat symbol "${trimmedQuery}"`,
                ...(symFound ? { indexedSymbolFound: true } : {}),
              }
            : {}),
        }
    const text = displaySafeJson(payload)
    return { text, code: 1 }
  }
  let text = indexEmpty
    ? `token-goat: no matches for '${query}'\n${emptyIndexMessage(rootDir)}`
    : `token-goat: no matches for '${query}'`
  const trimmedQuery = query.trim()
  const isIdentifier = /^[A-Za-z0-9_.:-]+$/.test(trimmedQuery)
  if (!indexEmpty && isIdentifier) {
    let symFound = false
    try {
      const symMatches = querySymbols({ name: trimmedQuery, rootDir, limit: 1 })
      if (symMatches.length > 0) {
        symFound = true
      }
    } catch {
      // Ignore DB errors during symbol lookup fallback
    }
    if (symFound) {
      text += `\n(note: '${trimmedQuery}' is an indexed symbol name; use: token-goat symbol "${trimmedQuery}")`
    } else {
      text += `\nTry: token-goat symbol "${trimmedQuery}"`
    }
  }
  if (preflight.status !== 'ready') {
    text += `\n(note: semantic indexing is degraded [${preflight.status}]: ${preflight.summary}${preflight.actionRequired ? ` — ${preflight.actionRequired}` : ''})`
  } else if (searchSemanticError !== null) {
    text += `\n(note: semantic matching degraded: ${searchSemanticError}; results come from keyword search alone)`
  }
  return { text, code: 1 }
}

/** `semantic "a" "b" ...`: one runSemantic call per query in argument order, each block headed by its query, or in JSON an array of `{ query, ...what a single-query call returns }`. Sequential in one process, so the embedding extractor and config the first query loads serve the rest; `warm` goes to the first call only, since each warm loads the model afresh. Exits 0 when any query answered, as runReadMulti does. */
export async function runSemanticMulti(queries: readonly string[], opts: SemanticOptions): Promise<{ text: string; code: number }> {
  const laterOpts: SemanticOptions = { ...opts }
  delete laterOpts.warm
  const blocks: string[] = []
  const entries: unknown[] = []
  let anyOk = false
  for (const [i, query] of queries.entries()) {
    const sub = await runSemantic(query, i === 0 ? opts : laterOpts)
    if (sub.code === 0) anyOk = true
    if (opts.json === true) {
      // Every JSON return from runSemantic is a displaySafeJson object, so it nests as real JSON rather than an embedded string.
      entries.push({ query, ...(JSON.parse(sub.text) as Record<string, unknown>) })
      continue
    }
    blocks.push(`'${query}':\n${sub.text}`)
  }
  return { text: opts.json === true ? displaySafeJson(entries) : blocks.join('\n\n'), code: anyOk ? 0 : 1 }
}
