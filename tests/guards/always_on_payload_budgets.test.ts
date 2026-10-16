/** Two payloads reach the model on every session whether or not it uses token-goat: the routing gate block written into CLAUDE.md, AGENTS.md and the Copilot and VS Code instruction files, and the MCP server's `tools/list`, which a client puts in context on every request. At 2.9.30 they were 4,879 bytes and 13,029 bytes, a customer measured about 4.1k tokens of always-on cost, and each grew by accretion: a failure-shape row here, a tool there, none of them large enough to stop a change. This pins both at their exact 2.9.31 sizes, so any growth now fails a test and has to be argued for or paid for by cutting something else. Provenance: CAPTURE. The block is rendered by the real `buildGuidanceBlock` with Claude Code's markers and fallback clause, and `tools/list` is read off a live in-process server with `TOKEN_GOAT_MCP_TOOLS` unset, which is the default surface a user gets. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { buildGuidanceBlock } from '../../src/bridges/guidance_block.js'
import { createMcpServer } from '../../src/mcp_server.js'

// Measured with the bound set to 1 and the size read off the failure message: the gate block is 3,670 bytes and the default tools/list 5,293 bytes. Moved 4,879 -> 3,670 and 13,029 -> 5,293 when 2.9.31 trimmed the gate and cut the default tools to seven; raise a bound only with a new "Moved X -> Y when ..." here.
const GATE_BLOCK_MAX_BYTES = 3670
const DEFAULT_TOOLS_LIST_MAX_BYTES = 5293

const ENV_KEY = 'TOKEN_GOAT_MCP_TOOLS'
const savedEnv: string | undefined = process.env[ENV_KEY]
let closeServer: (() => Promise<void>) | undefined

afterEach(async () => {
  if (closeServer !== undefined) await closeServer()
  closeServer = undefined
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

describe('always-on payload budgets', () => {
  it('keeps the routing gate block inside its byte budget', () => {
    const block = buildGuidanceBlock({
      beginMarker: '<!-- token-goat-begin -->',
      endMarker: '<!-- token-goat-end -->',
      fallbackToolClause: "Claude Code's own Read, Grep, and Glob preference rules",
    })
    const bytes = Buffer.byteLength(block, 'utf8')
    expect(bytes, `the gate block is ${bytes} bytes, over its ${GATE_BLOCK_MAX_BYTES} budget. It is read on every session of every host; cut a row or merge two before raising this.`).toBeLessThanOrEqual(GATE_BLOCK_MAX_BYTES)
  })

  it('keeps the default tools/list inside its byte budget', async () => {
    delete process.env[ENV_KEY]
    const server = await createMcpServer()
    const client = new Client({ name: 'budget-test', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    closeServer = async () => {
      await client.close()
      await server.close()
    }
    const { tools } = await client.listTools()
    const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
    expect(tools.length, 'the default tools/list is empty; the budget below would pass on nothing').toBeGreaterThan(0)
    expect(bytes, `the default tools/list is ${bytes} bytes for ${tools.length} tools, over its ${DEFAULT_TOOLS_LIST_MAX_BYTES} budget. Every tool is paid for on every request; keep new tools opt-in through ${ENV_KEY}.`).toBeLessThanOrEqual(DEFAULT_TOOLS_LIST_MAX_BYTES)
  })
})
