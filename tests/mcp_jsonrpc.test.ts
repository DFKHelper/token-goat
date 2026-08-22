/**
 * Differential test for token-goat's in-house MCP server against `@modelcontextprotocol/sdk`.
 *
 * src/mcp_jsonrpc.ts replaced the SDK on the shipping path to drop 91 packages from every install
 * (see that file's header for the full reasoning). The SDK stays as a devDependency precisely so it
 * can serve as the oracle here: it is a genuinely independent implementation of the same protocol,
 * not a mock of the code under test, which is the distinction CLAUDE.md's injected-seam warning
 * turns on. Two things are checked against it, and the second is the one that matters:
 *
 * 1. A hand-written shape table, covering every zod construct mcp_server.ts actually registers.
 * 2. **The real production registrations.** `createMcpServer()` is run twice -- once normally, and
 *    once with src/mcp_jsonrpc.js substituted for a shim that forwards every `registerTool` call
 *    into the SDK's own `McpServer`. Both are then driven by the SDK's reference `Client` over its
 *    `InMemoryTransport`, and their `tools/list` results must be byte-identical. So all 18 tools,
 *    with their real descriptions and their real schemas, are compared as they actually ship. A
 *    table-only test would pass forever after someone registered a nineteenth tool using a zod
 *    construct neither implementation agrees on.
 *
 * The `$schema` identifier, the `execution.taskSupport` field and the `MCP error -32602: ` prefix
 * on tool errors are all matched to the SDK on purpose, and this test is what holds them there.
 *
 * The single deliberate divergence -- `capabilities.tools`, where the SDK claims `listChanged: true`
 * and we send `{}` -- is asserted on BOTH sides, so if the SDK ever stops claiming it, the test
 * fails and the stale comment gets found, rather than the divergence quietly disappearing.
 */
import { describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  JSONRPC_METHOD_NOT_FOUND,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcMessage,
  type McpTransport,
} from '../src/mcp_jsonrpc.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Every zod construct `src/mcp_server.ts` registers, in one table. Derived by reading the real
 * tool definitions rather than guessed: plain strings, a bounded positive integer, booleans, a
 * string array, a regex-constrained string, `.optional()` in both positions, and `.describe()` on
 * some fields but not others (an undescribed field is what catches a converter that assumes one).
 */
const SHAPE = {
  name: z.string().describe('symbol name to search for'),
  limit: z.number().int().positive().max(200).optional().describe('max results (default: 20)'),
  file: z.string().optional(),
  json: z.boolean().optional().describe('output as JSON'),
  tags: z.array(z.string()).optional().describe('tags to filter by'),
  handoff: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).describe('handoff name'),
  bare: z.string(),
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

/** Connects a client to whichever server implementation is passed in. */
async function connect(server: { connect: (t: any) => Promise<void>; close: () => Promise<void> }): Promise<{
  client: Client
  close: () => Promise<void>
}> {
  const client = new Client({ name: 'differential-test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** Registers the same three tools on either implementation, so the two are compared like for like. */
function registerFixtureTools(server: { registerTool: (n: string, d: any, h: any) => void }): void {
  server.registerTool('with_schema', { description: 'a tool with every shape', inputSchema: SHAPE }, (args: any) =>
    textResult(`ok:${String(args.name)}`),
  )
  server.registerTool('no_schema', { description: 'a tool that takes nothing' }, () => textResult('nothing'))
  server.registerTool('thrower', { description: 'a tool that throws', inputSchema: { x: z.string() } }, () => {
    throw new Error('handler exploded')
  })
}

describe('mcp_jsonrpc vs the reference SDK', () => {
  it('lists tools byte-identically for a table covering every registered zod construct', async () => {
    const mine = new McpServer({ name: 'token-goat', version: '9.9.9' })
    registerFixtureTools(mine)
    const theirs = new SdkMcpServer({ name: 'token-goat', version: '9.9.9' })
    registerFixtureTools(theirs)

    const a = await connect(mine)
    const b = await connect(theirs)
    try {
      const ours = await a.client.listTools()
      const ref = await b.client.listTools()
      expect(JSON.stringify(ours, null, 2), 'tools/list diverged from the MCP SDK for the shape table').toBe(
        JSON.stringify(ref, null, 2),
      )
      // Anti-vacuity: an implementation that listed nothing would match an oracle that listed
      // nothing, and this test would pass while guarding zero schemas.
      expect(ours.tools).toHaveLength(3)
      expect(Object.keys((ours.tools[0] as any).inputSchema.properties)).toEqual(Object.keys(SHAPE))
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('returns identical call results for success, unknown tool, bad arguments and a throwing handler', async () => {
    const mine = new McpServer({ name: 'token-goat', version: '9.9.9' })
    registerFixtureTools(mine)
    const theirs = new SdkMcpServer({ name: 'token-goat', version: '9.9.9' })
    registerFixtureTools(theirs)

    const a = await connect(mine)
    const b = await connect(theirs)
    const calls: { label: string; name: string; args: Record<string, unknown> }[] = [
      { label: 'success', name: 'with_schema', args: { name: 'alpha', handoff: 'h', bare: 'b' } },
      { label: 'argumentless tool', name: 'no_schema', args: {} },
      { label: 'unknown tool', name: 'does_not_exist', args: {} },
      { label: 'missing required argument', name: 'with_schema', args: { name: 'alpha' } },
      { label: 'wrong argument type', name: 'with_schema', args: { name: 1, handoff: 'h', bare: 'b' } },
      { label: 'out-of-range number', name: 'with_schema', args: { name: 'a', handoff: 'h', bare: 'b', limit: 0 } },
      { label: 'regex violation', name: 'with_schema', args: { name: 'a', handoff: 'not valid!', bare: 'b' } },
      { label: 'array element type', name: 'with_schema', args: { name: 'a', handoff: 'h', bare: 'b', tags: [7] } },
      { label: 'handler throws', name: 'thrower', args: { x: 'y' } },
    ]
    try {
      for (const call of calls) {
        const ours = await a.client.callTool({ name: call.name, arguments: call.args })
        const ref = await b.client.callTool({ name: call.name, arguments: call.args })
        expect(JSON.stringify(ours), `tools/call diverged from the MCP SDK for: ${call.label}`).toBe(JSON.stringify(ref))
      }
      // Anti-vacuity again: at least one of those must actually have been an error result, or the
      // loop above proves only that both implementations can say "ok".
      const bad = await a.client.callTool({ name: 'with_schema', arguments: { name: 'alpha' } })
      expect(bad.isError).toBe(true)
      expect((bad.content as any[])[0].text).toContain('Invalid arguments for tool with_schema')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('matches the SDK on serverInfo and the negotiated protocol version, and diverges only on listChanged', async () => {
    const mine = new McpServer({ name: 'token-goat', version: '9.9.9' })
    registerFixtureTools(mine)
    const theirs = new SdkMcpServer({ name: 'token-goat', version: '9.9.9' })
    registerFixtureTools(theirs)
    const a = await connect(mine)
    const b = await connect(theirs)
    try {
      expect(JSON.stringify(a.client.getServerVersion())).toBe(JSON.stringify(b.client.getServerVersion()))
      // Both sides asserted: if the SDK ever stops declaring listChanged, this fails and whoever
      // sees it can delete the divergence and its comment instead of inheriting a stale claim.
      expect(b.client.getServerCapabilities()).toEqual({ tools: { listChanged: true } })
      expect(a.client.getServerCapabilities()).toEqual({ tools: {} })
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('lists the real production tools byte-identically to the SDK building the same registrations', async () => {
    vi.resetModules()
    const { createMcpServer } = await import('../src/mcp_server.js')
    const real = await createMcpServer()
    const a = await connect(real)
    const ourList = await a.client.listTools()
    await a.close()

    // Substitute the protocol layer for a shim that forwards into the SDK, then build the very same
    // 18 tools again. `createMcpServer` reaches its McpServer through a dynamic import, so mocking
    // the module is enough -- no production code has to be refactored to be testable this way.
    vi.resetModules()
    vi.doMock('../src/mcp_jsonrpc.js', () => ({
      McpServer: class {
        readonly inner: SdkMcpServer
        constructor(info: { name: string; version: string }) {
          this.inner = new SdkMcpServer(info)
        }
        registerTool(name: string, definition: any, handler: any): void {
          this.inner.registerTool(name, definition, handler)
        }
        connect(transport: any): Promise<void> {
          return this.inner.connect(transport)
        }
        close(): Promise<void> {
          return this.inner.close()
        }
      },
    }))
    try {
      const { createMcpServer: createViaSdk } = await import('../src/mcp_server.js')
      const shimmed = await createViaSdk()
      const b = await connect(shimmed as any)
      try {
        const refList = await b.client.listTools()
        expect(
          JSON.stringify(ourList, null, 2),
          'tools/list for the real production tools diverged from the MCP SDK building the same registrations',
        ).toBe(JSON.stringify(refList, null, 2))
        // The whole point is that every shipped tool is compared, so a nineteenth one cannot slip
        // past unchecked. 18 is what ships today; raising it deliberately is fine, silently is not.
        expect(ourList.tools.length).toBe(18)
      } finally {
        await b.close()
      }
    } finally {
      vi.doUnmock('../src/mcp_jsonrpc.js')
      vi.resetModules()
    }
  }, 60_000)
})

describe('mcp_jsonrpc protocol handling', () => {
  /** A bare transport, so protocol-level behaviour can be driven without a client in the way. */
  function rawTransport(): { transport: McpTransport; sent: JsonRpcMessage[]; deliver: (m: JsonRpcMessage) => void } {
    const sent: JsonRpcMessage[] = []
    const transport: McpTransport = {
      start: () => Promise.resolve(),
      send: (message) => {
        sent.push(message)
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    }
    return { transport, sent, deliver: (m) => transport.onmessage?.(m) }
  }

  it('echoes a supported older protocol version and falls back to the latest for an unknown one', async () => {
    for (const [requested, expected] of [
      ['2024-11-05', '2024-11-05'],
      ['2025-06-18', '2025-06-18'],
      ['1999-01-01', LATEST_PROTOCOL_VERSION],
      [undefined, LATEST_PROTOCOL_VERSION],
    ] as const) {
      const { transport, sent, deliver } = rawTransport()
      const server = new McpServer({ name: 't', version: '1' })
      await server.connect(transport)
      deliver({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: requested === undefined ? {} : { protocolVersion: requested },
      })
      await Promise.resolve()
      const result = (sent[0] as any).result
      expect(result.protocolVersion, `negotiating from ${String(requested)}`).toBe(expected)
    }
    // Guards the fallback constant against drifting out of its own supported list.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION)
  })

  it('answers ping and refuses a method it does not implement', async () => {
    const { transport, sent, deliver } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    await server.connect(transport)
    deliver({ jsonrpc: '2.0', id: 1, method: 'ping' })
    deliver({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    await Promise.resolve()
    await Promise.resolve()
    expect((sent[0] as any).result).toEqual({})
    // A clean "method not found" is the contract for the surfaces we deliberately do not implement.
    // A stub that answered `resources/list` with an empty list would tell a client we have no
    // resources, which is a different and false statement.
    expect((sent[1] as any).error.code).toBe(JSONRPC_METHOD_NOT_FOUND)
    expect((sent[1] as any).error.message).toContain('resources/list')
  })

  it('never replies to a notification', async () => {
    const { transport, sent, deliver } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    await server.connect(transport)
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/whatever_is_next']) {
      deliver({ jsonrpc: '2.0', method })
    }
    await Promise.resolve()
    // The JSON-RPC spec forbids a response to a notification, so an unknown one must be dropped
    // rather than answered with "method not found".
    expect(sent).toEqual([])
  })

  it('refuses to register the same tool name twice', () => {
    const server = new McpServer({ name: 't', version: '1' })
    server.registerTool('dup', {}, () => textResult('a'))
    // Silently replacing would make a copy-pasted registration shadow the tool it duplicated, and
    // the only symptom would be one tool quietly doing another tool's work.
    expect(() => server.registerTool('dup', {}, () => textResult('b'))).toThrow(/registered twice: dup/)
  })

  it('reports the connection closing exactly once, through onclose', async () => {
    const { transport } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    let closes = 0
    server.onclose = () => {
      closes += 1
    }
    await server.connect(transport)
    transport.onclose?.()
    // `mcp-serve` resolves its top-level promise on this callback, so a missed call hangs the
    // process after the client hangs up and a double call would resolve it twice.
    expect(closes).toBe(1)
  })
})
