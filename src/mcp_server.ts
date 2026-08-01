/**
 * MCP (Model Context Protocol) stdio server exposing token-goat's surgical-read commands as
 * tools, so any MCP-aware harness (VS Code, Copilot CLI, etc.) can call them in-process instead
 * of shelling out to `token-goat <cmd>`.
 *
 * Every tool handler here is a thin adapter over the same `run*`/`runSemantic` functions the CLI
 * commands in `cli.ts` call — no logic is duplicated, so a fix or format change to a surgical-read
 * command applies to both surfaces automatically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved } from './baseline.js'
import { VERSION } from './constants.js'
import {
  runSymbol,
  runRead,
  runSection,
  runSkeleton,
  runOutline,
  runSemantic,
  runRefs,
  runChanged,
  runGrep,
  runImports,
  runExports,
} from './read_commands.js'
import { recordStat } from './stats.js'

// The read_commands.ts handlers below are shared verbatim with the CLI (see the file-level
// doc comment), so their error/ambiguity/overflow text is written for a shell caller: literal
// `token-goat <cmd> "..."` retry commands and `--flag`-style CLI switches. An MCP client has no
// shell and no CLI flags -- only this tool's own JSON params -- so a model driving an MCP
// client would either try to shell out (which fails) or get stuck. Rewrite those CLI-only
// affordances into MCP-appropriate guidance (re-call this tool with an adjusted parameter)
// before wrapping the text into a CallToolResult, without touching read_commands.ts/
// overflow_guard.ts's CLI-facing text at all -- the CLI's own output stays unchanged.
const TOKEN_GOAT_RETRY_RE = /token-goat (\w[\w-]*) "([^"]+)"/g

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

/** Builds the MCP server and registers all 12 surgical-read tools. Does not connect a transport. */
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
        limit: z.number().int().positive().optional().describe('max results (default: 20)'),
        file: z.string().optional().describe('restrict to one file'),
        kind: z.string().optional().describe('restrict to one kind (function, class, ...)'),
        json: z.boolean().optional().describe('output as JSON'),
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { name, limit, file, kind, json, projectRoot } = args
      return toCallToolResult(
        runSymbol({
          name,
          limit: limit ?? 20,
          ...(file !== undefined ? { file } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(json === true ? { json: true } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
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
        projectRoot: projectRootField,
      },
    },
    (args) => {
      const { spec, json, forceRefresh, projectRoot } = args
      return toCallToolResult(
        runRead({
          spec,
          ...(json === true ? { json: true } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
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
      return toCallToolResult(
        runSkeleton({
          file,
          ...(json === true ? { json: true } : {}),
          ...(minLines !== undefined ? { minLines } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
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
      return toCallToolResult(
        runOutline({
          file,
          ...(json === true ? { json: true } : {}),
          ...(minLines !== undefined ? { minLines } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
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
        limit: z.number().int().positive().optional().describe('max results (default: 20)'),
        projectRoot: makeProjectRootField('search'),
      },
    },
    async (args) => {
      const { query, limit, projectRoot } = args
      return toCallToolResult(
        await runSemantic(query, {
          ...(limit !== undefined ? { limit } : {}),
          ...(projectRoot !== undefined ? { projectRoot } : {}),
        }),
      )
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
        limit: z.number().int().positive().optional().describe('max results'),
        top: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'for a high-fanout symbol, group references by file (count only) and show only the top N files by reference count instead of a per-line dump',
          ),
        json: z.boolean().optional().describe('output as JSON'),
      },
    },
    (args) => {
      const { spec, callers, limit, top, json } = args
      return toCallToolResultFromExitCode(() =>
        runRefs({
          spec,
          ...(callers === true ? { callers: true } : {}),
          ...(json === true ? { json: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(top !== undefined ? { top } : {}),
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
      const map = buildProjectMap(projectRoot ?? process.cwd(), { compact: compact === true })
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
          ...(projectRoot !== undefined ? { projectRoot } : {}),
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
        maxLines: z.number().int().positive().optional().describe('max matching lines to print'),
        json: z.boolean().optional().describe('output as JSON'),
        recursive: z.boolean().optional().describe('descend into subdirectories (default: true)'),
        context: z.number().int().nonnegative().optional().describe('lines of context to show before and after each match'),
      },
    },
    (args) => {
      const { pattern, path: searchPath, maxLines, json, recursive, context } = args
      return toCallToolResultFromExitCode(() =>
        runGrep({
          pattern,
          ...(searchPath !== undefined && searchPath.length > 0 ? { path: searchPath } : {}),
          ...(json === true ? { json: true } : {}),
          ...(maxLines !== undefined ? { maxLines } : {}),
          ...(recursive === false ? { recursive: false } : {}),
          ...(context !== undefined ? { context } : {}),
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
      },
    },
    (args) => {
      const { file, json } = args
      return toCallToolResultFromExitCode(() => runImports({ file, ...(json === true ? { json: true } : {}) }))
    },
  )

  server.registerTool(
    'exports',
    {
      description: 'List exported (public) symbols in a file.',
      inputSchema: {
        file: z.string().describe('file path'),
        json: z.boolean().optional().describe('output as JSON'),
      },
    },
    (args) => {
      const { file, json } = args
      return toCallToolResultFromExitCode(() => runExports({ file, ...(json === true ? { json: true } : {}) }))
    },
  )

  return server
}
