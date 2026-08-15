// Regression: the `semantic` MCP tool's description promises "Scoped to projectRoot if given."
// But a caller passing a relative or nonexistent projectRoot (e.g. "token-goat" instead of an
// absolute path) used to silently fall through: searchSemantic found nothing under the bogus
// root, runSemantic fell back to the (now project-scoped) FTS search using that same bogus
// root, which also found nothing under it -- or worse, before searchSymbolsFts was scoped at
// all, fell back to an UNSCOPED search that leaked hits from every other indexed project. Either
// way the tool returned `isError: false` with output that had nothing to do with the requested
// scope, silently breaking its own documented contract instead of surfacing the bad input.
//
// runSemantic must now validate that a given projectRoot is an absolute, existing directory and
// return an error result (isError: true via toCallToolResult's code!==0 mapping) instead.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { runSemantic } from '../src/read_commands.js'
import { createMcpServer } from '../src/mcp_server.js'

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

describe('runSemantic projectRoot validation (unit)', () => {
  it('returns a non-zero code for a relative projectRoot', async () => {
    const result = await runSemantic('anything', { projectRoot: 'token-goat' })
    expect(result.code).not.toBe(0)
    expect(result.text).toContain('token-goat')
  })

  it('returns a non-zero code for an absolute but nonexistent projectRoot', async () => {
    const bogus = path.join(os.tmpdir(), '__tg_definitely_does_not_exist_9k2__')
    expect(fs.existsSync(bogus)).toBe(false)
    const result = await runSemantic('anything', { projectRoot: bogus })
    expect(result.code).not.toBe(0)
  })

  it('returns a non-zero code when projectRoot points at a file, not a directory', async () => {
    const file = path.join(os.tmpdir(), `tg-sem-validate-file-${process.pid}.txt`)
    fs.writeFileSync(file, 'not a directory')
    try {
      const result = await runSemantic('anything', { projectRoot: file })
      expect(result.code).not.toBe(0)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it('succeeds (or at least does not fail on scope validation) for a real absolute directory', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sem-validate-real-'))
    try {
      const result = await runSemantic('anything', { projectRoot: real })
      // No embeddings/FTS hits expected for an empty scratch dir -- the point here is only that
      // validation itself doesn't reject a legitimate absolute, existing directory.
      expect(result.text).not.toContain('must be an absolute, existing directory')
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
    }
  })
})

describe('mcp semantic tool rejects a bad projectRoot (live JSON-RPC call)', () => {
  it('returns isError: true for a relative projectRoot', async () => {
    const { client, close } = await connectedClient()
    try {
      const result = await client.callTool({ name: 'semantic', arguments: { query: 'anything', projectRoot: 'token-goat' } })
      expect(result.isError).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = (result.content as any[])[0]
      expect(block.text).toContain('token-goat')
    } finally {
      await close()
    }
  })

  it('returns isError: true for an absolute but nonexistent projectRoot', async () => {
    const { client, close } = await connectedClient()
    try {
      const bogus = path.join(os.tmpdir(), '__tg_definitely_does_not_exist_9k2__')
      const result = await client.callTool({ name: 'semantic', arguments: { query: 'anything', projectRoot: bogus } })
      expect(result.isError).toBe(true)
    } finally {
      await close()
    }
  })
})
