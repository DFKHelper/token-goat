/** Differential test for token-goat's in-house MCP server against `@modelcontextprotocol/sdk`. src/mcp_jsonrpc.ts replaced the SDK on the shipping path to drop 91 packages from every install (see that file's header for the full reasoning). The SDK stays as a devDependency precisely so it can serve as the oracle here: it is a genuinely independent implementation of the same protocol, not a mock of the code under test, which is the distinction CLAUDE.md's injected-seam warning turns on. Two things are checked against it, and the second is the one that matters: 1. A hand-written shape table, covering every zod construct mcp_server.ts actually registers. 2. **The real production registrations.** `createMcpServer()` is run twice -- once normally, and once with src/mcp_jsonrpc.js substituted for a shim that forwards every `registerTool` call into the SDK's own `McpServer`. Both are then driven by the SDK's reference `Client` over its `InMemoryTransport`, and their `tools/list` results must be byte-identical. So all 18 tools, with their real descriptions and their real schemas, are compared as they actually ship. A table-only test would pass forever after someone registered a nineteenth tool using a zod construct neither implementation agrees on. The `execution.taskSupport` field and the `MCP error -32602: ` prefix on tool errors are matched to the SDK on purpose, and this test is what holds them there. The two deliberate divergences -- `capabilities.tools`, where the SDK claims `listChanged: true` and we send `{}`, and `inputSchema.$schema`, which the SDK sends as draft-07 and we leave out -- are each asserted on BOTH sides, so if the SDK ever changes either, the test fails and the stale comment gets found, rather than the divergence quietly disappearing. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcMessage,
  type McpTransport,
} from '../src/mcp_jsonrpc.js'
import { HARNESS_DETECTION_ENV_KEYS } from './helpers/harness-env.js'
import { ALL_MCP_TOOLS_ENV } from './helpers/mcp_all_tools.js'
import { neutralizeMcpHarnessSignals } from './helpers/mcp_test_harness.js'

// These cases call tools that are opt-in by default; name them all so the server registers them.
process.env['TOKEN_GOAT_MCP_TOOLS'] = ALL_MCP_TOOLS_ENV

beforeEach(neutralizeMcpHarnessSignals)
afterEach(() => vi.unstubAllEnvs())

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every zod construct `src/mcp_server.ts` registers, in one table. Derived by reading the real tool definitions rather than guessed: plain strings, a bounded positive integer, booleans, a string array, a regex-constrained string, `.optional()` in both positions, and `.describe()` on some fields but not others (an undescribed field is what catches a converter that assumes one). */
const SHAPE = {
  name: z.string().describe('symbol name to search for'),
  limit: z.number().int().positive().max(200).optional().describe('max results (default: 20)'),
  file: z.string().optional(),
  json: z.boolean().optional().describe('output as JSON'),
  tags: z.array(z.string()).optional().describe('tags to filter by'),
  handoff: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).describe('handoff name'),
  bare: z.string(),
}

const SDK_SCHEMA_ID = 'http://json-schema.org/draft-07/schema#'

/** The SDK's `tools/list` with the one field this server deliberately leaves out: every `inputSchema.$schema`. Asserts the SDK still sends draft-07's identifier on every tool that has arguments, and that ours sends none, so the divergence is held from both sides and cannot vanish unnoticed. */
function withoutSchemaIds(ours: { tools: any[] }, ref: { tools: any[] }): { tools: any[] } {
  for (const t of ours.tools) expect(t.inputSchema.$schema, `${t.name} advertises a $schema`).toBeUndefined()
  const withArgs = ref.tools.filter((t) => Object.keys(t.inputSchema.properties ?? {}).length > 0)
  expect(withArgs.length, 'no SDK tool has arguments, so this compares no schema').toBeGreaterThan(0)
  for (const t of withArgs) expect(t.inputSchema.$schema, `the SDK stopped sending draft-07 for ${t.name}`).toBe(SDK_SCHEMA_ID)
  // Spread first and replace after, so `inputSchema` keeps its key position and the byte comparison still holds.
  return {
    ...ref,
    tools: ref.tools.map((t) => {
      const { $schema: _dialect, ...schema } = t.inputSchema
      return { ...t, inputSchema: schema }
    }),
  }
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
  // One tool carries annotations and one carries none, so the comparison covers both what an advertised hint looks like on the wire and that an unadvertised one is absent rather than an empty object.
  server.registerTool('with_schema', { description: 'a tool with every shape', inputSchema: SHAPE, annotations: { title: 'Every shape', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, (args: any) =>
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
      const ref = withoutSchemaIds(ours, await b.client.listTools())
      expect(JSON.stringify(ours, null, 2), 'tools/list diverged from the MCP SDK for the shape table').toBe(
        JSON.stringify(ref, null, 2),
      )
      // Anti-vacuity: an implementation that listed nothing would match an oracle that listed nothing, and this test would pass while guarding zero schemas.
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
      // Anti-vacuity again: at least one of those must actually have been an error result, or the loop above proves only that both implementations can say "ok".
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
      // Both sides asserted: if the SDK ever stops declaring listChanged, this fails and whoever sees it can delete the divergence and its comment instead of inheriting a stale claim.
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

    // Substitute the protocol layer for a shim that forwards into the SDK, then build the very same 18 tools again. `createMcpServer` reaches its McpServer through a dynamic import, so mocking the module is enough -- no production code has to be refactored to be testable this way.
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
        const refList = withoutSchemaIds(ourList, await b.client.listTools())
        expect(
          JSON.stringify(ourList, null, 2),
          'tools/list for the real production tools diverged from the MCP SDK building the same registrations',
        ).toBe(JSON.stringify(refList, null, 2))
        // The whole point is that every shipped tool is compared, so a nineteenth one cannot slip past unchecked. 18 is what ships today; raising it deliberately is fine, silently is not.
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
  function rawTransport(): {
    transport: McpTransport
    sent: JsonRpcMessage[]
    deliver: (m: JsonRpcMessage) => void
    whenSent: (count: number) => Promise<void>
  } {
    const sent: JsonRpcMessage[] = []
    const waiters: { count: number; resolve: () => void }[] = []
    const transport: McpTransport = {
      start: () => Promise.resolve(),
      send: (message) => {
        sent.push(message)
        for (const waiter of waiters) if (sent.length >= waiter.count) waiter.resolve()
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    }
    // Resolves once `count` replies have reached the transport, so a row waits on the event it asserts on and not on a guessed number of microtask turns.
    const whenSent = (count: number): Promise<void> =>
      sent.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))
    return { transport, sent, deliver: (m) => transport.onmessage?.(m), whenSent }
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

  it('disables tools when initialize identifies a hooks-enabled harness or client', async () => {
    const detections = [
      { label: 'Copilot client name', clientName: 'GitHub Copilot CLI' },
      { label: 'Claude client name', clientName: 'Claude Code' },
      {
        label: 'Copilot harness',
        clientName: 'generic-test-client',
        env: { name: 'TOKEN_GOAT_HARNESS_OVERRIDE', value: 'copilot_cli' },
      },
      {
        label: 'Claude harness',
        clientName: 'generic-test-client',
        env: { name: 'TOKEN_GOAT_HARNESS_OVERRIDE', value: 'claudecode' },
      },
      {
        label: 'COPILOT_HOME',
        clientName: 'generic-test-client',
        env: { name: 'COPILOT_HOME', value: 'C:\\copilot' },
      },
      {
        label: 'Claude Code session',
        clientName: 'generic-test-client',
        env: { name: 'CLAUDE_CODE_SESSION_ID', value: 'session' },
      },
      {
        label: 'Claude Code terminal',
        clientName: 'generic-test-client',
        env: { name: 'TERM_PROGRAM', value: 'claude-code' },
      },
    ]

    for (const detection of detections) {
      neutralizeMcpHarnessSignals()
      // The suite setup sets the opt-out to 1 for every test, so the gate row must unset it to see the gate close.
      vi.stubEnv('TOKEN_GOAT_MCP_WITH_HOOKS', undefined)
      if (detection.env !== undefined) vi.stubEnv(detection.env.name, detection.env.value)

      const { transport, sent, deliver, whenSent } = rawTransport()
      const server = new McpServer({ name: 't', version: '1' })
      const handler = vi.fn(() => textResult('should not run'))
      server.registerTool('hidden', {}, handler)
      await server.connect(transport)
      deliver({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: detection.clientName, version: '1' } },
      })
      deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      deliver({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hidden' } })
      await whenSent(3)

      expect(sent, detection.label).toHaveLength(3)
      expect((sent[1] as any).result.tools, detection.label).toEqual([])
      expect((sent[2] as any).result, detection.label).toEqual({
        content: [
          {
            type: 'text',
            text: 'token-goat MCP tools are disabled because hooks are available for this harness; set TOKEN_GOAT_MCP_WITH_HOOKS=1 to keep them on',
          },
        ],
        isError: true,
      })
      expect(handler, detection.label).not.toHaveBeenCalled()
      await server.close()
    }
  })

  it('keeps tools on under a hooks-enabled harness when TOKEN_GOAT_MCP_WITH_HOOKS opts out', async () => {
    // Provenance: HAND-DERIVED. The harness override and client name are the same hooks signals the gate test above uses; the opt-out value is the documented `1`.
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    vi.stubEnv('TOKEN_GOAT_MCP_WITH_HOOKS', '1')
    const { transport, sent, deliver, whenSent } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    server.registerTool('visible', {}, () => textResult('ran'))
    await server.connect(transport)
    try {
      deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Claude Code', version: '1' } } })
      deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      deliver({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'visible' } })
      await whenSent(3)
      expect((sent[1] as any).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['visible'])
      expect((sent[2] as any).result).toEqual({ content: [{ type: 'text', text: 'ran' }], isError: false })
    } finally {
      await server.close()
    }
  })

  it('keeps tools disabled when a later initialize carries no hooks signal, since the first one latched hooks on', async () => {
    // Provenance: HAND-DERIVED. The claudecode and generic overrides are the same harness signals the gate test above uses; the unset opt-out is what the suite setup would otherwise set to 1.
    vi.stubEnv('TOKEN_GOAT_MCP_WITH_HOOKS', undefined)
    const { transport, sent, deliver, whenSent } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    server.registerTool('hidden', {}, () => textResult('should not run'))
    await server.connect(transport)
    try {
      vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
      deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Claude Code', version: '1' } } })
      await whenSent(1)
      vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'generic')
      deliver({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { clientInfo: { name: 'generic', version: '1' } } })
      deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
      await whenSent(3)
      expect((sent[2] as any).result.tools).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('decides hooks-present from the real signals in both directions: absent serves, present refuses, the suite default serves', async () => {
    // Provenance: FORMAT-DERIVED from src/mcp_jsonrpc.ts::hooksDisableMcpTools (the signals it reads) and src/bridges/registry.ts::detectHarness; the CI refusal text is CAPTURE from the first red CI run of this suite (every mcp_* file read 'token-goat MCP tools are disabled because hooks are available for this harness'). No callback is injected: the server runs the shipping decision.
    const session = async (): Promise<{ tools: string[]; callError: boolean }> => {
      const { transport, sent, deliver, whenSent } = rawTransport()
      const server = new McpServer({ name: 't', version: '1' })
      server.registerTool('probe', {}, () => textResult('ran'))
      await server.connect(transport)
      try {
        deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'generic-test-client', version: '1' } } })
        deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        deliver({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe' } })
        await whenSent(3)
        return {
          tools: (sent[1] as any).result.tools.map((tool: { name: string }) => tool.name),
          callError: (sent[2] as any).result.isError === true,
        }
      } finally {
        await server.close()
      }
    }

    // The suite default: the setup file pins the harness to claudecode and the opt-out to 1, and no row stubs anything. The shipped CI failure was this session refusing.
    vi.unstubAllEnvs()
    expect(await session(), 'suite default env').toEqual({ tools: ['probe'], callError: false })

    // Absent: no harness signal of any kind and no opt-out, which is a host without hooks.
    for (const key of HARNESS_DETECTION_ENV_KEYS) vi.stubEnv(key, undefined)
    vi.stubEnv('COPILOT_HOME', undefined)
    vi.stubEnv('TOKEN_GOAT_MCP_WITH_HOOKS', undefined)
    expect(await session(), 'no hooks signal').toEqual({ tools: ['probe'], callError: false })

    // Present: the same bare environment plus one real hooks signal, each of which must close the gate.
    for (const [name, value] of [
      ['TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode'],
      ['TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli'],
      ['CLAUDE_CODE_SESSION_ID', 'session'],
      ['TERM_PROGRAM', 'claude-code'],
      ['COPILOT_HOME', 'C:\\copilot'],
    ] as const) {
      vi.stubEnv(name, value)
      expect(await session(), `${name}=${value}`).toEqual({ tools: [], callError: true })
      vi.stubEnv(name, undefined)
    }
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
    // A clean "method not found" is the contract for the surfaces we deliberately do not implement. A stub that answered `resources/list` with an empty list would tell a client we have no resources, which is a different and false statement.
    expect((sent[1] as any).error.code).toBe(JSONRPC_METHOD_NOT_FOUND)
    expect((sent[1] as any).error.message).toContain('resources/list')
  })

  it('answers a message that is not a JSON object with -32600 and no id, and keeps serving', async () => {
    const { transport, sent, deliver } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    await server.connect(transport)
    // Provenance: HAND-DERIVED from JSON-RPC 2.0 section 5 (an unreadable id is answered with -32600), section 4.2 (a batch is an Array), and the MCP schema's JSONRPCError (id optional, never null; the SDK's own parse of a reply rejects a null). The values are the four lines the bug report sent to the real `mcp-serve`: null, 42, "x", [].
    for (const raw of [null, 42, 'x', []]) deliver(raw as unknown as JsonRpcMessage)
    deliver({ jsonrpc: '2.0', id: 9, method: 'ping' })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(sent).toHaveLength(5)
    for (const reply of sent.slice(0, 4)) {
      expect('id' in (reply as object)).toBe(false)
      expect((reply as any).error.code).toBe(JSONRPC_INVALID_REQUEST)
    }
    expect(sent[4]).toEqual({ jsonrpc: '2.0', id: 9, result: {} })
  })

  it('never replies to a notification', async () => {
    const { transport, sent, deliver } = rawTransport()
    const server = new McpServer({ name: 't', version: '1' })
    await server.connect(transport)
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/whatever_is_next']) {
      deliver({ jsonrpc: '2.0', method })
    }
    await Promise.resolve()
    // The JSON-RPC spec forbids a response to a notification, so an unknown one must be dropped rather than answered with "method not found".
    expect(sent).toEqual([])
  })

  it('refuses to register the same tool name twice', () => {
    const server = new McpServer({ name: 't', version: '1' })
    server.registerTool('dup', {}, () => textResult('a'))
    // Silently replacing would make a copy-pasted registration shadow the tool it duplicated, and the only symptom would be one tool quietly doing another tool's work.
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
    // `mcp-serve` resolves its top-level promise on this callback, so a missed call hangs the process after the client hangs up and a double call would resolve it twice.
    expect(closes).toBe(1)
  })
})
