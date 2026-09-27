/** `indexing.cross_project_symbols = false` confines index lookups to the project the MCP server runs from. Every MCP tool also takes a `projectRoot`, which is model-generated input, so a file-spec tool that confined to whatever root the caller named was confined to a boundary the caller chose: `read`, `brief`, `skeleton`, `outline`, `exports` and a `file:N` read all served another project's indexed content, while `symbol` and `refs` refused the same root. These drive the real tool handlers, with the other project deleted from disk where the claim is about the index, so anything they return can only have come from the machine-wide index. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { createMcpServer } from '../src/mcp_server.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'

// Fixture provenance: HAND-DERIVED. A two-function TypeScript file written below; every assertion keys on its own marker strings and on the refusal wording, never on a parser output format.
const OWN_MARKER = 'AAA-FROM-PROJECT-A'
const OTHER_MARKER = 'BBB-CONFIDENTIAL-FROM-PROJECT-B'
const REFUSAL = 'confines symbol lookups to it'

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function seedProject(root: string, symbolName: string, marker: string): void {
  const dir = path.join(root, 'src')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'thing.ts')
  fs.writeFileSync(file, `export function ${symbolName}(): string {\n  return '${marker}'\n}\nexport function ${symbolName}Caller(): string {\n  return ${symbolName}()\n}\n`)
  indexFileSync(normalizePath(file), globalDbPath())
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name, arguments: args })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((result as any).content as any[]).map((c: { text: string }) => c.text).join('\n')
  } finally {
    await client.close()
    await server.close()
  }
}

beforeEach(() => {
  rootA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-confine-a-')))
  rootB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-confine-b-')))
  seedProject(rootA, 'alphaOwnSymbol', OWN_MARKER)
  seedProject(rootB, 'betaSecretForecast', OTHER_MARKER)
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
  process.env['TOKEN_GOAT_CROSS_PROJECT_SYMBOLS'] = 'false'
  delete process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
  invalidateConfigCache()
})

afterEach(() => {
  delete process.env['TOKEN_GOAT_CROSS_PROJECT_SYMBOLS']
  delete process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
  invalidateConfigCache()
  cwdSpy.mockRestore()
  closeAllDbs()
  fs.rmSync(rootA, { recursive: true, force: true })
  fs.rmSync(rootB, { recursive: true, force: true })
})

describe('MCP file-spec tools with cross_project_symbols = false and a projectRoot naming another project', () => {
  beforeEach(() => {
    // Project B exists only in the index from here on: no filesystem read can reach it.
    fs.rmSync(rootB, { recursive: true, force: true })
  })

  it.each([
    ['read', { spec: 'src/thing.ts::betaSecretForecast' }, OTHER_MARKER],
    ['brief', { spec: 'src/thing.ts::betaSecretForecast' }, OTHER_MARKER],
    ['skeleton', { file: 'src/thing.ts' }, 'betaSecretForecast'],
    ['outline', { file: 'src/thing.ts' }, 'betaSecretForecast'],
    ['exports', { file: 'src/thing.ts' }, 'betaSecretForecast'],
  ])('%s refuses the root instead of answering from its index rows', async (tool, args, leaked) => {
    const text = await callTool(tool, { ...args, projectRoot: rootB })
    expect(text).toContain(REFUSAL)
    expect(text).not.toContain(leaked)
  })
})

describe('MCP line-number read with cross_project_symbols = false', () => {
  it('refuses a file:N read in a caller-named project outside the confining root', async () => {
    const text = await callTool('read', { spec: 'src/thing.ts:2', projectRoot: rootB })
    expect(text).toContain(REFUSAL)
    expect(text).not.toContain(OTHER_MARKER)
  })
})

describe('MCP file-spec tools with cross_project_symbols = false still answer where the policy allows', () => {
  it('serve the project the server runs from when no projectRoot is named', async () => {
    const text = await callTool('read', { spec: 'src/thing.ts::alphaOwnSymbol' })
    expect(text).toContain(OWN_MARKER)
  })

  it('serve another project that mcp.allowed_roots lists', async () => {
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = rootB
    invalidateConfigCache()
    expect(await callTool('read', { spec: 'src/thing.ts::betaSecretForecast', projectRoot: rootB })).toContain(OTHER_MARKER)
    expect(await callTool('outline', { file: 'src/thing.ts', projectRoot: rootB })).toContain('betaSecretForecast')
  })
})
