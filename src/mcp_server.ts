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

import { VERSION } from './constants.js'
import { runSymbol, runRead, runSection, runSkeleton, runOutline, runSemantic } from './read_commands.js'

/** Wraps a `{ text, code }` result from a read_commands handler into an MCP `CallToolResult`. */
function toCallToolResult(result: { text: string; code: number }): CallToolResult {
  return {
    content: [{ type: 'text', text: result.text }],
    isError: result.code !== 0,
  }
}

/** Builds the MCP server and registers all 6 surgical-read tools. Does not connect a transport. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'token-goat', version: VERSION })

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
      },
    },
    (args) => {
      const { name, limit, file, kind, json } = args
      return toCallToolResult(
        runSymbol({
          name,
          limit: limit ?? 20,
          ...(file !== undefined ? { file } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(json === true ? { json: true } : {}),
        }),
      )
    },
  )

  server.registerTool(
    'read',
    {
      description: "Read one symbol's full body, given a spec of the form file::symbol, or a line range file@N-M / file@N, or a bare file path.",
      inputSchema: {
        spec: z.string().describe('file::symbol, file@N-M, file@N, or a bare file path'),
        json: z.boolean().optional().describe('output as JSON'),
        forceRefresh: z.boolean().optional().describe('reparse file from disk before querying (ignore stale index)'),
      },
    },
    (args) => {
      const { spec, json, forceRefresh } = args
      return toCallToolResult(
        runRead({
          spec,
          ...(json === true ? { json: true } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
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
      },
    },
    (args) => {
      const { spec, json } = args
      return toCallToolResult(runSection({ spec, ...(json === true ? { json: true } : {}) }))
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
      },
    },
    (args) => {
      const { file, json, minLines, forceRefresh, stats } = args
      return toCallToolResult(
        runSkeleton({
          file,
          ...(json === true ? { json: true } : {}),
          ...(minLines !== undefined ? { minLines } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
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
      },
    },
    (args) => {
      const { file, json, minLines, forceRefresh, stats } = args
      return toCallToolResult(
        runOutline({
          file,
          ...(json === true ? { json: true } : {}),
          ...(minLines !== undefined ? { minLines } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(stats === true ? { stats: true } : {}),
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
        projectRoot: z
          .string()
          .optional()
          .describe(
            "absolute path to the workspace root to scope this search to; defaults to the MCP server process's cwd, " +
              'which is not always the actual workspace root for MCP clients -- pass this explicitly when it might differ',
          ),
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

  return server
}
