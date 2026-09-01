/**
 * `TOKEN_GOAT_MCP_TOOLS` trims which tools the MCP server registers.
 *
 * The cost this exists for is real and measured: every registered tool's name, description, and
 * full JSON input schema goes to the model on every request for the life of the session, and the
 * whole surface is roughly 16 KB. A harness using two lookups pays for all of it.
 *
 * The failure this file is mostly aimed at is the opposite of a leak: a filter that quietly
 * registers nothing, or registers everything while looking filtered, produces a tool list that is
 * indistinguishable from a correct one at a glance. So every case below measures the unfiltered
 * list first and compares against it, rather than asserting a hardcoded tool count that would go
 * stale the moment a tool is added -- and the equality assertions are equality, not "contains",
 * because a filter that returned every tool would satisfy "contains the ones I asked for".
 *
 * Provenance: CAPTURE. Every expected value is read from a real `tools/list` response off a live
 * in-process server, including the baseline the filtered runs are compared against. No expected
 * tool name or count is transcribed from `mcp_server.ts`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

const { createMcpServer } = await import('../src/mcp_server.js')

const ENV_KEY = 'TOKEN_GOAT_MCP_TOOLS'
/** Captured once, so a value inherited from the surrounding environment is restored rather than deleted. */
const restoreEnv: string | undefined = process.env[ENV_KEY]
let closeServer: (() => Promise<void>) | undefined

/** Names of the tools a freshly built server actually advertises, in `tools/list` order. */
async function listedToolNames(): Promise<string[]> {
  const server = await createMcpServer()
  const client = new Client({ name: 'allowlist-test', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  closeServer = async () => {
    await client.close()
    await server.close()
  }
  const listed = await client.listTools()
  return listed.tools.map((t) => t.name)
}

async function withEnv(value: string | undefined): Promise<string[]> {
  if (value === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = value
  return listedToolNames()
}

afterEach(async () => {
  if (closeServer !== undefined) {
    await closeServer()
    closeServer = undefined
  }
  if (restoreEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = restoreEnv
})

describe('TOKEN_GOAT_MCP_TOOLS', () => {
  it('advertises every tool when unset, so the cases below are cutting something real', async () => {
    // Calibration. If the unfiltered server advertised one tool, or none, every "the filter
    // removed things" assertion below would pass without the filter doing any work.
    const all = await withEnv(undefined)
    expect(all.length, 'the unfiltered server advertises fewer than 3 tools; nothing below is a meaningful cut').toBeGreaterThan(2)
    expect(new Set(all).size, 'tools/list contains duplicate names').toBe(all.length)
  })

  it('registers exactly the named tools and nothing else', async () => {
    const all = await withEnv(undefined)
    await closeServer?.()
    closeServer = undefined
    const [first, second] = all
    // Equality against a sorted pair, not `toContain`: a filter that ignored the variable entirely
    // would contain both of these and pass a containment check.
    const filtered = await withEnv(`${first},${second}`)
    expect([...filtered].sort()).toEqual([first as string, second as string].sort())
  })

  it('cannot add a tool that does not exist', async () => {
    // Deny by omission is the whole safety property: the variable selects from what is registered,
    // it never becomes a registration. A typo must shrink the surface, never widen it.
    const filtered = await withEnv('no_such_tool_at_all')
    expect(filtered).toEqual([])
  })

  it('ignores unknown names beside known ones rather than dropping the whole list', async () => {
    const all = await withEnv(undefined)
    await closeServer?.()
    closeServer = undefined
    const known = all[0] as string
    const filtered = await withEnv(`${known},definitely_not_a_tool`)
    expect(filtered).toEqual([known])
  })

  it('treats an empty value as unset rather than as a request for a dead server', async () => {
    const all = await withEnv(undefined)
    await closeServer?.()
    closeServer = undefined
    // A server with zero tools is useless, so an empty value is far more likely an unset variable
    // expanding to nothing in a shell wrapper than a deliberate ask for nothing.
    const blank = await withEnv('   ')
    expect(blank).toEqual(all)
  })

  it('trims whitespace around names, so a readable comma-space list works', async () => {
    const all = await withEnv(undefined)
    await closeServer?.()
    closeServer = undefined
    const known = all[0] as string
    const filtered = await withEnv(` ${known} , `)
    expect(filtered).toEqual([known])
  })
})
