// `confine_reads_to_project_root` stops a caller traversing OUT of the root it is given. It does
// not constrain WHICH root the caller supplies: every MCP tool takes an optional `projectRoot`,
// and MCP tool arguments are model-generated -- the same untrusted channel confinement exists to
// defend against. So a caller that names its own root is confined to a boundary it chose, which
// is no boundary at all for a deployment where MCP is the only path to the filesystem.
//
// `mcp.allowed_roots` pins that choice. It is EMPTY by default, so the shipped behaviour is
// unchanged and the documented multi-root contract (`projectRoot` exists precisely because the
// server's cwd is often not the workspace root) still holds. Non-empty, it refuses any resolved
// root outside every listed entry.
//
// The allowlist is read from the SERVER's config, not the request's resolved root -- the inverse
// of what mcp_server_confine_reads_config_scoping.test.ts pins for confine_reads_to_project_root,
// and deliberately so: a workspace may decide its own confinement, but it must not be able to
// ship a project config that authorises itself past the operator's allowlist.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
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

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('mcp allowed_roots', () => {
  let allowedRoot: string
  let otherRoot: string
  let cleanup: (() => Promise<void>) | undefined
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
    allowedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-allowroots-in-')))
    otherRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-allowroots-out-')))
    fs.writeFileSync(path.join(allowedRoot, 'inside.txt'), 'INSIDE-CONTENT\n')
    fs.writeFileSync(path.join(otherRoot, 'outside.txt'), 'OUTSIDE-CONTENT\n')
    invalidateConfigCache()
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
    else process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = originalEnv
    invalidateConfigCache()
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const d of [allowedRoot, otherRoot]) fs.rmSync(d, { recursive: true, force: true })
  })

  // The load-bearing non-breaking assertion: with no allowlist configured, an arbitrary caller-
  // supplied root is still honoured exactly as before. If this ever goes red the default stopped
  // being a no-op and the multi-root contract broke.
  it('empty allowlist (the default) leaves an arbitrary caller-supplied projectRoot working', async () => {
    delete process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
    invalidateConfigCache()
    const { client, close } = await connectedClient()
    cleanup = close
    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'OUTSIDE-CONTENT', path: [otherRoot], projectRoot: otherRoot } })
    expect(textOf(result)).not.toContain('mcp.allowed_roots')
    expect(textOf(result)).toContain('OUTSIDE-CONTENT')
  })

  it('refuses a projectRoot outside every allowed root, naming the setting that refused it', async () => {
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = allowedRoot
    invalidateConfigCache()
    const { client, close } = await connectedClient()
    cleanup = close
    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'OUTSIDE-CONTENT', path: [otherRoot], projectRoot: otherRoot } })
    expect(textOf(result)).toContain('mcp.allowed_roots')
    expect(textOf(result)).not.toContain('OUTSIDE-CONTENT')
  })

  it('allows a projectRoot that is a subdirectory of an allowed root, not just an exact match', async () => {
    const sub = path.join(allowedRoot, 'nested')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'nested.txt'), 'NESTED-CONTENT\n')
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = allowedRoot
    invalidateConfigCache()
    const { client, close } = await connectedClient()
    cleanup = close
    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'NESTED-CONTENT', path: [sub], projectRoot: sub } })
    expect(textOf(result)).not.toContain('mcp.allowed_roots')
    expect(textOf(result)).toContain('NESTED-CONTENT')
  })

  // Multi-entry parsing on this platform's own delimiter: a single-entry test would pass even if
  // the value were consumed whole without ever being split.
  it('parses a multi-entry env value on this platform delimiter, admitting a root listed second', async () => {
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = [otherRoot, allowedRoot].join(path.delimiter)
    invalidateConfigCache()
    const { client, close } = await connectedClient()
    cleanup = close
    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'INSIDE-CONTENT', path: [allowedRoot], projectRoot: allowedRoot } })
    expect(textOf(result)).not.toContain('mcp.allowed_roots')
    expect(textOf(result)).toContain('INSIDE-CONTENT')
  })
})
