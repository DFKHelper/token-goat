/**
 * MCP (Model Context Protocol) stdio server exposing token-goat's surgical-read commands as
 * tools, so any MCP-aware harness (VS Code, Copilot CLI, etc.) can call them in-process instead
 * of shelling out to `token-goat <cmd>`.
 *
 * Every tool handler mirroring a CLI command is a thin adapter over the same `run*`/`runSemantic`
 * functions the CLI commands in `cli.ts` call — no logic is duplicated, so a fix or format change
 * to a surgical-read command applies to both surfaces automatically. The one exception is
 * `index_status`, which has no CLI counterpart by design: it answers a question only an MCP client
 * needs to ask (is an empty result "no match" or "index not ready?"), since CLI users have the
 * hook layer and `doctor`/`stats` for the same signal.
 */

import * as fs from 'fs'
import * as path from 'path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved } from './baseline.js'
import { VERSION, dataDir, globalDbPath } from './constants.js'
import {
  runSymbol,
  runRead,
  runSection,
  runSkeleton,
  runOutline,
  runSemantic,
  runRefs,
  runBrief,
  runChanged,
  runGrep,
  runImports,
  runExports,
  findSpecSeparator,
  parseLineRange,
} from './read_commands.js'
import { recordStat } from './stats.js'
import {
  compressText,
  type CompressionResult,
  createHandoff,
  resolveHandoff,
  retrieveText,
  CONTENT_MAX_INPUT_CHARS,
} from './content_store.js'
import { resolveProjectRoot } from './project.js'
import { getProjectIndexCounts } from './index_health.js'
import { getDirtyPathsFor, isWorkerRunning } from './worker.js'
import { getDb } from './db.js'
import { embeddingsDepsAvailable } from './embeddings.js'
import { loadConfig } from './config.js'
import { extractErrorMessage } from './util.js'
import { normalizePath } from './paths.js'

// The read_commands.ts handlers below are shared verbatim with the CLI (see the file-level
// doc comment), so their error/ambiguity/overflow text is written for a shell caller: literal
// `token-goat <cmd> "..."` retry commands and `--flag`-style CLI switches. An MCP client has no
// shell and no CLI flags -- only this tool's own JSON params -- so a model driving an MCP
// client would either try to shell out (which fails) or get stuck. Rewrite those CLI-only
// affordances into MCP-appropriate guidance (re-call this tool with an adjusted parameter)
// before wrapping the text into a CallToolResult, without touching read_commands.ts/
// overflow_guard.ts's CLI-facing text at all -- the CLI's own output stays unchanged.
const TOKEN_GOAT_RETRY_RE = /token-goat (\w[\w-]*) "([^"]+)"/g

// Upper bounds for the MCP tools' numeric params, matching the `.max(CONTENT_MAX_INPUT_CHARS)`
// convention `compress_text` already uses. The `run*` handlers apply no upper clamp of their own
// (`limit`/`top` go straight into a SQL LIMIT, `maxLines` into a `.slice`), so an unbounded value
// there is mostly a no-op cap rather than an allocation; `context` is the one that genuinely
// amplifies, since every extra line is emitted per match.
const MCP_MAX_LIMIT = 1000
const MCP_MAX_CONTEXT_LINES = 50
const MCP_MAX_OUTPUT_LINES = 10_000

/** cmd -> the MCP tool param name that literal retry command's quoted argument maps to. */
const RETRY_PARAM_BY_COMMAND: Record<string, string> = {
  read: 'spec',
  section: 'spec',
  symbol: 'name',
  skeleton: 'file',
  outline: 'file',
}

/** Rewrites CLI-only affordances (shell retry commands, `--flag` switches) in `text` into MCP tool-call guidance. No-op on text that contains neither. */
function mcpFriendlyText(text: string): string {
  let out = text.replace(TOKEN_GOAT_RETRY_RE, (_match, cmd: string, arg: string) => {
    const param = RETRY_PARAM_BY_COMMAND[cmd] ?? 'parameter'
    return `the "${cmd}" tool again with a more specific ${param} (e.g. "${arg}")`
  })
  out = out.replace(/--json\b/g, 'the json parameter')
  out = out.replace(/--limit\b/g, 'the limit parameter')
  out = out.replace(/--top\b/g, 'the top parameter')
  out = out.replace(/--grep PATTERN, --section HEADING, or --tail N/g, 'a narrower query')
  return out
}

/** Wraps a `{ text, code }` result from a read_commands handler into an MCP `CallToolResult`. */
function toCallToolResult(result: { text: string; code: number }): CallToolResult {
  return {
    content: [{ type: 'text', text: mcpFriendlyText(result.text) }],
    isError: result.code !== 0,
  }
}

// VS Code Chat has no hook layer, so this tool is its entire compression surface: return the base64url payload only when inlining it is genuinely cheaper in tokens than the original text, otherwise the "compression" tool would inflate the very context it claims to shrink.
function compressionPayload(result: CompressionResult): Record<string, unknown> {
  if (result.inlineWins) return { ...result }
  const { compact: _compact, ...rest } = result
  return { ...rest, payloadWithheld: 'inlining the compact payload would cost more tokens than the original text; use the recovery command to retrieve it' }
}

function toRawCallToolResult(result: { text: string; code: number }): CallToolResult {
  return {
    content: [{ type: 'text', text: result.text }],
    isError: result.code !== 0,
  }
}

/**
 * Captures everything written to `process.stdout`/`process.stderr` during `fn()`, in call order,
 * restoring the original write functions before returning (even if `fn` throws).
 *
 * `runRefs`/`runChanged`/`runGrep`/`runImports`/`runExports` -- unlike the `{ text, code }`-
 * returning handlers `toCallToolResult` adapts above -- print their own output via
 * `emit()`/`emitErr()` (raw `process.stdout`/`process.stderr` writes) and return only an exit
 * code, matching what their CLI callers (`runExit` in cli.ts) expect. An MCP stdio server speaks
 * JSON-RPC over that SAME stdout stream, so letting one of them write raw text straight to the
 * real `process.stdout` here would corrupt every in-flight MCP message, not just this tool's
 * response -- this capture is what stands in for that missing return value, without touching
 * read_commands.ts's printing behavior (which the CLI still depends on byte-for-byte).
 */
function captureOutput(fn: () => number): { code: number; text: string } {
  const chunks: string[] = []
  const record = (chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : typeof maybeCb === 'function' ? maybeCb : undefined
    if (typeof callback === 'function') callback()
    return true
  }
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = record as typeof process.stdout.write
  process.stderr.write = record as typeof process.stderr.write
  try {
    const code = fn()
    return { code, text: chunks.join('') }
  } finally {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
  }
}

/**
 * Adapts a `run*` handler that prints its own output and returns only an exit code (see
 * {@link captureOutput}) into the same `CallToolResult` shape {@link toCallToolResult} produces
 * for the `{ text, code }`-returning handlers.
 */
function toCallToolResultFromExitCode(fn: () => number): CallToolResult {
  const { code, text } = captureOutput(fn)
  return toCallToolResult({ text, code })
}

/**
 * Filesystem admission gate for the MCP read tools.
 *
 * The CLI is deliberately unconfined -- `token-goat read /etc/passwd` is a legitimate thing for a
 * human at a shell to do -- but the MCP tools are thin adapters over the same `run*` functions, so
 * without this an MCP client inherits unrestricted filesystem read through them. Enforced here, in
 * the MCP layer only; `read_commands.ts` is shared with the CLI and is left alone.
 *
 * Defense in depth, not a closed hole: a caller that can reach these tools can usually also call
 * its harness's own read tool. This narrows one specific sink, it does not sandbox the agent.
 */
function realPathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/** Case-folded on Windows, where the same directory has many valid spellings and a case-sensitive compare would reject legitimate in-root reads. */
function forCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * CONFINEMENT INVARIANT: the base the gate resolves a relative target against MUST be the exact
 * base the execution layer resolves it against.
 *
 * Every tool handler resolves the root exactly ONCE, here, and then uses that single absolute
 * value for BOTH the {@link rejectOutsideRoot} check and the `projectRoot` option handed to the
 * `run*` handler. Resolving a second time inside the gate (as this file used to) let the two
 * bases diverge: the gate validated `<projectRoot>/x` while the read resolved `<server cwd>/x`,
 * so confinement was only sound when the server process's cwd happened to equal the project
 * root. `resolveProjectRoot` also walks up to the git toplevel, so even an explicitly supplied
 * `projectRoot` pointing at a subdirectory of a repo resolves to a different base than the raw
 * value -- one resolution site is the only way to guarantee the two agree.
 */
function resolveToolRoot(projectRoot: string | undefined): string {
  return resolveProjectRoot(projectRoot !== undefined ? { project: projectRoot } : {})
}

/**
 * True when `target` resolves inside `resolvedRoot`, which must already be the absolute root
 * produced by {@link resolveToolRoot} -- see the invariant documented there.
 *
 * Both sides go through `fs.realpathSync` first: a path that normalises inside the root but
 * resolves through a symlink to somewhere outside it is the classic bypass, so the REAL path is
 * compared against the REAL root, not the nominal one.
 */
function isWithinProjectRoot(target: string, resolvedRoot: string): boolean {
  const root = forCompare(normalizePath(realPathOrSelf(resolvedRoot)))
  // Relative targets resolve against the project root, not the server process's cwd -- that is what the read_commands handlers themselves do with the same projectRoot this gate was handed, so resolving against cwd here would reject a legitimate relative spec whose read would have succeeded.
  const abs = path.resolve(resolvedRoot, normalizePath(target))
  const real = forCompare(normalizePath(realPathOrSelf(abs)))
  return real === root || real.startsWith(root.endsWith('/') ? root : root + '/')
}

/**
 * The file portion of one `read`/`section` spec: `file::symbol`, `file@N-M`, or a bare path.
 *
 * Reuses read_commands.ts's own {@link parseLineRange} and {@link findSpecSeparator} instead of
 * restating their grammar here, so this gate's notion of "the file part" agrees with the
 * execution layer's by construction. Two hand-kept-in-sync regexes previously drifted apart on
 * both syntaxes they cover: an `@` suffix that parseLineRange would decline (no trailing digits,
 * a `::` in the prefix, or a literal file that happens to contain `@`) was still stripped here,
 * validating a shorter in-root prefix while runRead resolved the untouched, longer, possibly
 * out-of-root spec; and a spec with two `::` occurrences split on the FIRST one here but the
 * LAST one in findSpecSeparator (used by both runRead and runSection), so `a::../../b::c` was
 * validated as `a` while `a::../../b` was actually read. When in doubt, this returns the more
 * inclusive (longer) string, never a shortened prefix -- see parseLineRange/findSpecSeparator
 * for the precedence (`@`-range checked first, matching runRead's own check order).
 */
function specFilePart(spec: string): string {
  const range = parseLineRange(spec)
  if (range !== null) return range.file
  const colonIdx = findSpecSeparator(spec)
  return colonIdx === -1 ? spec : spec.slice(0, colonIdx)
}

/**
 * Returns a refusal result when any of `targets` lies outside `resolvedRoot` (which must be the
 * {@link resolveToolRoot} output the same handler passes on to its `run*` call), else null.
 *
 * Comma-separated multi-file specs are checked part by part: one out-of-root member must reject
 * the whole call, or the confinement is trivially bypassed by appending an in-root path.
 */
function rejectOutsideRoot(targets: readonly string[], resolvedRoot: string, splitCommas = true): CallToolResult | null {
  if (!loadConfig(resolvedRoot).mcp.confine_reads_to_project_root) return null
  for (const raw of targets) {
    for (const part of splitCommas ? raw.split(',') : [raw]) {
      const file = specFilePart(part).trim()
      if (file === '') continue
      if (!isWithinProjectRoot(file, resolvedRoot)) {
        return toCallToolResult({
          text:
            `refused: "${file}" is outside the project root. The MCP tools are confined to the workspace. ` +
            'Set mcp.confine_reads_to_project_root = false (or TOKEN_GOAT_MCP_CONFINE_READS=0) to allow cross-root reads.',
          code: 1,
        })
      }
    }
  }
  return null
}

/** Builds the MCP server and registers every tool listed in tests/mcp_server.test.ts's TOOL_NAMES, which is asserted against a live listTools() call. Does not connect a transport. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'token-goat', version: VERSION })

  const makeProjectRootField = (verb: string) =>
    z
      .string()
      .optional()
      .describe(
        `absolute path to the workspace root to scope this ${verb} to; defaults to the MCP server process's cwd, ` +
          'which is not always the actual workspace root for MCP clients -- pass this explicitly when it might differ',
      )
  const projectRootField = makeProjectRootField('lookup')

  server.registerTool(
    'symbol',
    {
      description: 'Search for a symbol by name across the indexed project.',
      inputSchema: {
        name: z.string().describe('symbol name to search for'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max results (default: 20)'),
        file: z.string().optional().describe('restrict to one file'),
        kind: z.string().optional().describe('restrict to one kind (function, class, ...)'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { name, limit, file, kind, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      if (file !== undefined) {
        const refused = rejectOutsideRoot([file], root)
        if (refused) return refused
      }
      return toCallToolResult(
        runSymbol({
          name,
          limit: limit ?? 20,
          ...(file !== undefined ? { file } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(json === true ? { json: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'read',
    {
      description:
        "Read one symbol's full body, given a spec of the form file::symbol, or a line range file@N-M / file@N, or a bare file path. " +
        'Pass a comma-separated spec (file::a,b) to fetch several symbols\' bodies from one file in a single call.',
      inputSchema: {
        spec: z.string().describe('file::symbol, file@N-M, file@N, a bare file path, or comma-separated file::a,b for a merged multi-symbol view'),
        json: z.boolean().optional().describe('output as JSON'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
        stats: z.boolean().optional().describe('add per-symbol reference count and doc-coverage flag'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { spec, json, forceRefresh, stats, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([spec], root)
      if (refused) return refused
      return toCallToolResult(
        runRead({
          spec,
          ...(json === true ? { json: true } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'section',
    {
      description: 'Read one section from a file, given a spec of the form file::Heading.',
      inputSchema: {
        spec: z.string().describe('file::Heading'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { spec, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([spec], root)
      if (refused) return refused
      return toCallToolResult(
        runSection({
          spec,
          ...(json === true ? { json: true } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        }),
      )
    },
  )

  server.registerTool(
    'skeleton',
    {
      description: 'List all symbols in a file without bodies (name, kind, line range).',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        minLines: z.number().int().optional().describe('only show symbols at least N lines long'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
        stats: z.boolean().optional().describe('add per-symbol reference count and doc-coverage flag'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { file, json, minLines, forceRefresh, stats, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([file], root)
      if (refused) return refused
      return toCallToolResult(
        runSkeleton({
          file,
          ...(json === true ? { json: true } : {}),
          ...(minLines !== undefined ? { minLines } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'outline',
    {
      description: 'List symbols in a file with line ranges and docstrings.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        minLines: z.number().int().optional().describe('only show symbols at least N lines long'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
        stats: z.boolean().optional().describe('add per-symbol reference count and doc-coverage flag'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { file, json, minLines, forceRefresh, stats, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([file], root)
      if (refused) return refused
      return toCallToolResult(
        runOutline({
          file,
          ...(json === true ? { json: true } : {}),
          ...(minLines !== undefined ? { minLines } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'semantic',
    {
      description:
        'Semantic search over the indexed project (falls back to full-text search when no embedding index is available). ' +
        'Scoped to projectRoot if given, else the MCP server process\'s own cwd -- which may not be the actual workspace ' +
        'root for a client that launched the server from elsewhere, so pass projectRoot explicitly when in doubt.',
      inputSchema: {
        query: z.string().describe('natural-language search query'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max results (default: 20)'),
        grep: z.string().optional().describe('filter to hits whose file path matches this regex (literal substring if it does not compile as regex); matched against the path as rendered, same convention as refs --grep'),
        excludeTests: z.boolean().optional().describe('hide hits whose file is a test file (opt-in; default output is unchanged)'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: makeProjectRootField('search'),
      },
    },
    async (args) => {
      const { query, limit, grep, excludeTests, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      return toCallToolResult(
        await runSemantic(query, {
          ...(limit !== undefined ? { limit } : {}),
          ...(grep !== undefined ? { grep } : {}),
          ...(excludeTests === true ? { excludeTests: true } : {}),
          ...(json === true ? { json: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'index_status',
    {
      description:
        'Report whether the index for a project can be trusted right now: whether it has ever been indexed at all, ' +
        'current file/symbol counts, dirty-reindex-queue depth, whether the background worker is alive, and whether ' +
        'embeddings are available (semantic silently degrades to full-text search without them). Call this after an ' +
        'unexpectedly empty result from another token-goat tool (symbol/read/semantic/refs/brief/...) to tell apart ' +
        '"no match" from "the index is not ready yet" -- an MCP-only client has no hook layer to warn about this on ' +
        'its own, so an empty tool result and a stale/unindexed project look identical without this check.',
      inputSchema: {
        projectRoot: makeProjectRootField('check'),
      },
    },
    (args) => {
      const { projectRoot } = args
      const rootDir = resolveToolRoot(projectRoot)
      const dbPath = globalDbPath()
      const databaseExists = fs.existsSync(dbPath)

      let fileCount = 0
      let symbolCount = 0
      let queryError: string | undefined
      if (databaseExists) {
        try {
          const counts = getProjectIndexCounts(dbPath, rootDir)
          fileCount = counts.fileCount
          symbolCount = counts.symbolCount
        } catch (err) {
          queryError = extractErrorMessage(err)
        }
      }

      const resolvedDataDir = dataDir()
      const dirtyQueueDepth = getDirtyPathsFor(resolvedDataDir).length
      const workerAlive = isWorkerRunning(resolvedDataDir)

      let embeddingsAvailable = false
      if (databaseExists && queryError === undefined) {
        try {
          embeddingsAvailable = embeddingsDepsAvailable(getDb(dbPath))
        } catch {
          embeddingsAvailable = false
        }
      }
      const embeddingsEnabled = loadConfig(rootDir).indexing?.embeddings_enabled ?? true

      const status = {
        projectRoot: rootDir,
        databaseExists,
        indexedForProject: fileCount > 0,
        fileCount,
        symbolCount,
        ...(queryError !== undefined ? { queryError } : {}),
        dirtyQueueDepth,
        workerAlive,
        embeddingsEnabled,
        embeddingsAvailable,
      }
      return toCallToolResult({ text: JSON.stringify(status, null, 2), code: 0 })
    },
  )

  server.registerTool(
    'refs',
    {
      description:
        'Find references to one or more symbols (spec: file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view). ' +
        'For an unambiguous TypeScript symbol, automatically type-resolves candidates via the TypeScript compiler API to drop same-named-different-symbol ' +
        'false positives; falls back to name-based matching when that is not possible.',
      inputSchema: {
        spec: z.string().describe('file::symbol, symbol, or comma-separated a,b,c / file::a,b for a merged multi-symbol view'),
        callers: z.boolean().optional().describe('group references by their enclosing caller symbol'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max results'),
        top: z
          .number()
          .int()
          .positive()
          .max(MCP_MAX_LIMIT)
          .optional()
          .describe(
            'for a high-fanout symbol, group references by file (count only) and show only the top N files by reference count instead of a per-line dump',
          ),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { spec, callers, limit, top, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([spec], root)
      if (refused) return refused
      return toCallToolResultFromExitCode(() =>
        runRefs({
          spec,
          ...(callers === true ? { callers: true } : {}),
          ...(json === true ? { json: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(top !== undefined ? { top } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'brief',
    {
      description:
        'One-shot symbol orientation: signature, location, token count, body, callers, and containing doc section, in a single call ' +
        '(spec: file::symbol; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported -- ' +
        'unlike refs, a bare symbol name with no file is not accepted). ' +
        'Prefer this over separate read + refs calls when the goal is to understand a symbol, not just fetch its source: it folds the ' +
        'work of read (body) and refs --callers (call sites) into one result, at a fraction of the combined round-trip cost.',
      inputSchema: {
        spec: z
          .string()
          .describe('file::symbol; comma-separated file::a,b for a merged multi-symbol view; cross-file a.ts::x,b.ts::y is also supported'),
        limit: z.number().int().positive().max(MCP_MAX_LIMIT).optional().describe('max callers to show (default: 20)'),
        json: z.boolean().optional().describe('output as JSON'),
        context: z.number().int().nonnegative().max(MCP_MAX_CONTEXT_LINES).optional().describe('lines of call-site source to show before and after each caller (default 0)'),
        excludeTests: z.boolean().optional().describe('hide callers whose call site lives in a test file (opt-in; default output is unchanged)'),
        projectRoot: makeProjectRootField('orient'),
      },
    },
    (args) => {
      const { spec, limit, json, context, excludeTests, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([spec], root)
      if (refused) return refused
      return toCallToolResultFromExitCode(() =>
        runBrief({
          spec,
          ...(json === true ? { json: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(excludeTests === true ? { excludeTests: true } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'map',
    {
      description: 'Project overview: file count, languages, headline symbols, and recently modified files.',
      inputSchema: {
        compact: z.boolean().optional().describe('compact, low-token summary'),
        projectRoot: makeProjectRootField('overview'),
      },
    },
    (args) => {
      const { compact, projectRoot } = args
      const map = buildProjectMap(resolveToolRoot(projectRoot), { compact: compact === true })
      const text = formatProjectMap(map, map.compact)
      // buildProjectMap/formatProjectMap don't self-report the way the run*() handlers above do, so
      // this replicates cmdMap's stat-recording wiring in cli.ts (see project_runchanged_missing_stat
      // / map_lookup) locally rather than importing cmdMap itself, since cmdMap also owns
      // process.exitCode/stdout side effects this tool must not perform. The byte accounting -- and
      // the recentFiles-vs-topSymbols path canonicalization the dedup depends on, which stays correct
      // even when projectRoot differs from this server process's cwd -- lives in mapLookupBytesSaved,
      // shared with cmdMap so the two accountings cannot drift.
      const bytesSaved = mapLookupBytesSaved(map, text)
      recordStat('map_lookup', bytesSaved, Math.round(bytesSaved / 4))
      return toCallToolResult({ text, code: 0 })
    },
  )

  server.registerTool(
    'changed',
    {
      description: 'List files or symbols changed since a git ref.',
      inputSchema: {
        ref: z.string().optional().describe('git ref to compare against (default: HEAD~5)'),
        symbolMode: z.boolean().optional().describe('list symbols instead of files'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { ref, symbolMode, json, projectRoot } = args
      return toCallToolResultFromExitCode(() =>
        runChanged({
          ...(ref !== undefined ? { ref } : {}),
          ...(symbolMode === true ? { symbolMode: true } : {}),
          ...(json === true ? { json: true } : {}),
          projectRoot: resolveToolRoot(projectRoot),
        }),
      )
    },
  )

  server.registerTool(
    'grep',
    {
      description: 'Regex search over files, caching nothing (session-aware grep).',
      inputSchema: {
        pattern: z.string().describe('regex pattern to search for'),
        path: z.array(z.string()).optional().describe('files or directories to search; defaults to this server process\'s cwd'),
        maxLines: z.number().int().positive().max(MCP_MAX_OUTPUT_LINES).optional().describe('max matching lines to print'),
        json: z.boolean().optional().describe('output as JSON'),
        recursive: z.boolean().optional().describe('descend into subdirectories (default: true)'),
        context: z.number().int().nonnegative().max(MCP_MAX_CONTEXT_LINES).optional().describe('lines of context to show before and after each match'),
        // runGrep takes no projectRoot of its own (its `path` array is its scope), so this field only names the root the confinement check is made against -- without it, a search rooted anywhere but the server process's cwd is refused.
        projectRoot: makeProjectRootField('search'),
      },
    },
    (args) => {
      const { pattern, path: searchPath, maxLines, json, recursive, context, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      // grep's `path` elements are whole files/directories, never `file::symbol` specs, so each is checked verbatim -- no comma splitting, since a comma can be a legitimate filename character.
      // An omitted `path` still runs the gate (against the resolved root itself, which trivially
      // passes): short-circuiting to `null` here used to skip confinement entirely, and runGrep
      // then defaulted to `process.cwd()`, so omitting `path` searched the server process's own
      // cwd unconfined. The same root is passed on as GrepOptions.projectRoot so the default
      // search scope IS the gated root -- see the invariant on resolveToolRoot.
      const refused = rejectOutsideRoot(searchPath === undefined ? [root] : searchPath, root, false)
      if (refused) return refused
      return toCallToolResultFromExitCode(() =>
        runGrep({
          pattern,
          ...(searchPath !== undefined && searchPath.length > 0 ? { path: searchPath } : {}),
          ...(json === true ? { json: true } : {}),
          ...(maxLines !== undefined ? { maxLines } : {}),
          ...(recursive === false ? { recursive: false } : {}),
          ...(context !== undefined ? { context } : {}),
          projectRoot: root,
        }),
      )
    },
  )

  server.registerTool(
    'imports',
    {
      description: 'List the modules a file imports.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { file, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([file], root)
      if (refused) return refused
      return toCallToolResultFromExitCode(() =>
        runImports({ file, ...(json === true ? { json: true } : {}), projectRoot: root }),
      )
    },
  )

  server.registerTool(
    'exports',
    {
      description: 'List exported (public) symbols in a file.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { file, json, projectRoot } = args
      const root = resolveToolRoot(projectRoot)
      const refused = rejectOutsideRoot([file], root)
      if (refused) return refused
      return toCallToolResultFromExitCode(() =>
        runExports({ file, ...(json === true ? { json: true } : {}), projectRoot: root }),
      )
    },
  )

  server.registerTool(
    'compress_text',
    {
      description: 'Compress arbitrary local text, persist it in the bounded local cache, and return an opaque recovery ID plus metadata.',
      inputSchema: {
        text: z.string().max(CONTENT_MAX_INPUT_CHARS).describe('text to compress'),
      },
    },
    (args) => toCallToolResult({ text: JSON.stringify(compressionPayload(compressText(args.text)), null, 2), code: 0 }),
  )

  server.registerTool(
    'retrieve_text',
    {
      description: 'Retrieve original text from a token-goat compression ID.',
      inputSchema: {
        id: z.string().regex(/^tg_[0-9a-f]{16}$/).describe('opaque token-goat content ID'),
      },
    },
    (args) => {
      const text = retrieveText(args.id)
      return text === null
        ? toCallToolResult({ text: `no token-goat content for id: ${args.id}`, code: 1 })
        : toRawCallToolResult({ text, code: 0 })
    },
  )

  server.registerTool(
    'handoff_create',
    {
      description: 'Create a bounded, project-local named compressed handoff for another agent.',
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).describe('handoff name'),
        text: z.string().max(CONTENT_MAX_INPUT_CHARS).describe('handoff text'),
        projectRoot: makeProjectRootField('scope'),
      },
    },
    (args) =>
      toCallToolResult({
        text: JSON.stringify(createHandoff(args.name, args.text, resolveToolRoot(args.projectRoot)), null, 2),
        code: 0,
      }),
  )

  server.registerTool(
    'handoff_resolve',
    {
      description: 'Resolve a project-local handoff compactly or in full. MCP does not intercept built-in file reads.',
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).describe('handoff name'),
        full: z.boolean().optional().describe('return full text instead of a compact payload'),
        projectRoot: makeProjectRootField('scope'),
      },
    },
    (args) => {
      const result = resolveHandoff(args.name, {
        projectRoot: resolveToolRoot(args.projectRoot),
        ...(args.full === true ? { full: true } : {}),
      })
      return result === null
        ? toCallToolResult({ text: `no local handoff named "${args.name}" in this project`, code: 1 })
        : typeof result === 'string'
          ? toRawCallToolResult({ text: result, code: 0 })
          : toCallToolResult({ text: JSON.stringify(compressionPayload(result), null, 2), code: 0 })
    },
  )

  return server
}
