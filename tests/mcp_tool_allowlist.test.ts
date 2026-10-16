/** `TOKEN_GOAT_MCP_TOOLS` chooses which tools the MCP server registers, and when it is unset the server registers only the core DEFAULT_MCP_TOOLS. The cost this exists for is real and measured: every registered tool's name, description, and full JSON input schema goes to the model on every request for the life of the session, and all eighteen are 13,029 bytes of `tools/list`. A harness using two lookups pays for all of it. The failure this file is mostly aimed at is the opposite of a leak: a filter that quietly registers nothing, or registers everything while looking filtered, produces a tool list that is indistinguishable from a correct one at a glance. So the equality assertions are equality, not "contains", because a filter that returned every tool would satisfy "contains the ones I asked for". Provenance: CAPTURE for every list read off a live in-process `tools/list`; HAND-DERIVED for the pinned default core, which is the 2.9.31 release decision and not read from the implementation. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { ALL_MCP_TOOLS, ALL_MCP_TOOLS_ENV } from './helpers/mcp_all_tools.js'

const { createMcpServer, DEFAULT_MCP_TOOLS } = await import('../src/mcp_server.js')

const ENV_KEY = 'TOKEN_GOAT_MCP_TOOLS'
/** Every tool the default list leaves out, derived so a tool added to the server or dropped from the default is covered without editing this file. */
const OPT_IN_TOOLS: readonly string[] = ALL_MCP_TOOLS.filter((t) => !DEFAULT_MCP_TOOLS.includes(t))
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
  it('advertises every tool under the all-tools value, so the cases below are cutting something real', async () => {
    // Calibration. If the full server advertised one tool, or none, every "the filter removed things" assertion below would pass without the filter doing any work.
    const all = await withEnv(ALL_MCP_TOOLS_ENV)
    expect(all.length, 'the full server advertises fewer than 3 tools; nothing below is a meaningful cut').toBeGreaterThan(2)
    expect(new Set(all).size, 'tools/list contains duplicate names').toBe(all.length)
    expect([...all].sort()).toEqual([...ALL_MCP_TOOLS].sort())
  })

  it('advertises only the core lookups when unset', async () => {
    // HAND-DERIVED, pinned literally: widening the default is a release decision that must change this line, not drift in through DEFAULT_MCP_TOOLS.
    const unset = await withEnv(undefined)
    expect([...unset].sort()).toEqual(['outline', 'read', 'refs', 'retrieve_text', 'section', 'semantic', 'symbol'])
    expect([...unset].sort()).toEqual([...DEFAULT_MCP_TOOLS].sort())
  })

  it('has eleven opt-in tools, so the each-case below leaves none of the eighteen out', () => {
    expect(OPT_IN_TOOLS).toHaveLength(11)
    expect([...OPT_IN_TOOLS].sort()).toEqual(['brief', 'changed', 'compress_text', 'exports', 'grep', 'handoff_create', 'handoff_resolve', 'imports', 'index_status', 'map', 'skeleton'])
  })

  it.each(OPT_IN_TOOLS)(
    'does not advertise the opt-in tool %s by default, and does once it is named',
    async (tool) => {
      expect(await withEnv(undefined)).not.toContain(tool)
      await closeServer?.()
      closeServer = undefined
      expect(await withEnv(tool)).toEqual([tool])
    },
  )

  // HAND-DERIVED: a temp project holding one file with a canary line. The grep tool finds that line when it is listed; the same call must come back refused, with the canary absent, when it is not, which separates "not registered" from "registered and silent".
  it('refuses a tools/call for a tool the list leaves out, and does not run it', async () => {
    const canary = 'ALLOWLIST_CALL_CANARY_QX7'
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-allowlist-call-')))
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), `${canary}\n`)
      const call = async (): Promise<string> => {
        const server = await createMcpServer()
        const client = new Client({ name: 'allowlist-call', version: '0.0.1' })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        closeServer = async () => {
          await client.close()
          await server.close()
        }
        const result = await client.callTool({ name: 'grep', arguments: { pattern: canary, path: ['a.txt'], projectRoot: root } })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ((result as any).content as any[])[0].text as string
      }

      process.env[ENV_KEY] = 'grep'
      expect(await call(), 'calibration: with grep listed the canary must be found, or the refusal below proves nothing').toContain(canary)
      await closeServer?.()
      closeServer = undefined

      delete process.env[ENV_KEY]
      const refused = await call()
      expect(refused).toContain('Tool grep not found')
      expect(refused, 'an unlisted tool ran: its result reached the client').not.toContain(canary)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces the default with an explicit list instead of adding to it', async () => {
    // A user who already set a list keeps exactly that list: the core tools are not appended behind their back.
    const filtered = await withEnv('grep')
    expect(filtered).toEqual(['grep'])
  })

  it('registers exactly the named tools and nothing else', async () => {
    const all = await withEnv(ALL_MCP_TOOLS_ENV)
    await closeServer?.()
    closeServer = undefined
    const [first, second] = all
    // Equality against a sorted pair, not `toContain`: a filter that ignored the variable entirely would contain both of these and pass a containment check.
    const filtered = await withEnv(`${first},${second}`)
    expect([...filtered].sort()).toEqual([first as string, second as string].sort())
  })

  it('cannot add a tool that does not exist', async () => {
    // Deny by omission is the whole safety property: the variable selects from what is registered, it never becomes a registration. A typo must shrink the surface, never widen it.
    const filtered = await withEnv('no_such_tool_at_all')
    expect(filtered).toEqual([])
  })

  it('ignores unknown names beside known ones rather than dropping the whole list', async () => {
    const filtered = await withEnv('symbol,definitely_not_a_tool')
    expect(filtered).toEqual(['symbol'])
  })

  it('treats an empty value as unset rather than as a request for a dead server', async () => {
    const unset = await withEnv(undefined)
    await closeServer?.()
    closeServer = undefined
    // A server with zero tools is useless, so an empty value is far more likely an unset variable expanding to nothing in a shell wrapper than a deliberate ask for nothing.
    const blank = await withEnv('   ')
    expect(blank).toEqual(unset)
  })

  it('trims whitespace around names, so a readable comma-space list works', async () => {
    const filtered = await withEnv(' symbol , ')
    expect(filtered).toEqual(['symbol'])
  })
})
