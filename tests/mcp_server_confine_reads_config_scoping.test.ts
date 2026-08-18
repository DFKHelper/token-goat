// Regression: `rejectOutsideRoot` (src/mcp_server.ts) read the `confine_reads_to_project_root`
// setting via `loadConfig()` with NO argument, so it fell back to `resolveConfigProjectRoot()` --
// the server process's own cwd -- even though the request's resolved `projectRoot` was already
// available as a parameter. A `.token-goat.toml` sitting in the server's cwd with
// `confine_reads_to_project_root = false` therefore switched confinement off for a DIFFERENT
// workspace, one whose own config still held the secure default. The security decision for
// workspace A was read from workspace B's config.
//
// tests/mcp_server_root_divergence.test.ts covers the EXECUTION base (which directory a relative
// path resolves against); this file covers the CONFIG base (which .token-goat.toml the gate's
// on/off decision itself is read from) -- a distinct divergence, same root cause shape.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as IndexReaderModule from '../src/index_reader.js'

const querySymbolsMock = vi.fn()

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return {
    ...actual,
    querySymbols: (...args: Parameters<typeof actual.querySymbols>) => querySymbolsMock(...args),
  }
})

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')

const SECRET = 'SECRET-MARKER-DO-NOT-LEAK'

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

describe('mcp confine_reads_to_project_root: gate must read the REQUEST projectRoot config, not the server cwd config', () => {
  let projectRoot: string
  let serverCwd: string
  let outsideDir: string
  let originalCwd: string
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    querySymbolsMock.mockReturnValue([])
    originalCwd = process.cwd()
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfgscope-root-')))
    serverCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfgscope-cwd-')))
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfgscope-outside-')))
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), `${SECRET}\n`)
    invalidateConfigCache()
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const dir of [projectRoot, serverCwd, outsideDir]) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    invalidateConfigCache()
  })

  it('confinement stays ON for projectRoot even when the server cwd has its own config disabling it', async () => {
    // The server cwd's config would legitimately disable confinement -- for THAT workspace.
    // projectRoot has no override, so it keeps the secure default (confine = true).
    fs.writeFileSync(path.join(serverCwd, '.token-goat.toml'), 'mcp.confine_reads_to_project_root = false\n')
    process.chdir(serverCwd)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'read',
      arguments: { spec: path.join(outsideDir, 'secret.txt'), projectRoot },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('is outside the project root. The MCP tools are confined to the workspace.')
    expect(textOf(result)).not.toContain(SECRET)
  })

  // This test previously asserted the opposite: that the request projectRoot's own
  // .token-goat.toml could turn confinement off. That is now blocked, deliberately. A per-project
  // file arrives with the repository, so honouring it here meant any cloned project could hand the
  // MCP server the whole filesystem. `mcp` is one of the sections a project file may not set
  // (PROJECT_LOCKED_SECTIONS in src/config.ts). The setting itself still works: it comes from the
  // global config or TOKEN_GOAT_MCP_CONFINE_READS, neither of which a repository can write.
  it('ignores a request projectRoot that tries to turn confinement off from its own config file', async () => {
    fs.writeFileSync(path.join(projectRoot, '.token-goat.toml'), 'mcp.confine_reads_to_project_root = false\n')
    process.chdir(serverCwd)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'read',
      arguments: { spec: path.join(outsideDir, 'secret.txt'), projectRoot },
    })
    expect(textOf(result)).toContain('is outside the project root. The MCP tools are confined to the workspace.')
    expect(textOf(result)).not.toContain(SECRET)
  })

  it('still turns confinement off from the environment, which a repository cannot write', async () => {
    const prev = process.env['TOKEN_GOAT_MCP_CONFINE_READS']
    process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = '0'
    process.chdir(serverCwd)
    try {
      const { client, close } = await connectedClient()
      cleanup = close

      const result = await client.callTool({
        name: 'read',
        arguments: { spec: path.join(outsideDir, 'secret.txt'), projectRoot },
      })
      expect(textOf(result)).toContain(SECRET)
    } finally {
      if (prev === undefined) delete process.env['TOKEN_GOAT_MCP_CONFINE_READS']
      else process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = prev
    }
  })
})
