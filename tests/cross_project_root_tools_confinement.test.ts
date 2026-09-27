/** `indexing.cross_project_symbols = false` confines index answers to the project token-goat runs from, and a root the caller names moves that confinement only into a root inside it or one `mcp.allowed_roots` lists. `symbol`, `refs` and the file-spec tools checked the root they were handed; the commands that take a root and no file path did not: `search --project` and the MCP `semantic`, `map` and symbol-mode `changed` tools answered from another project's index, source text included, even for files gone from disk. PROVENANCE: HAND-DERIVED. The two-function TypeScript file and the git history are written here; every assertion keys on the marker strings below and on the refusal wording, never on a parser output format. */
import { execFileSync } from 'node:child_process'
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
import { runParallelSearch } from '../src/search/search_cli.js'

const OWN_MARKER = 'AAA-FROM-PROJECT-A'
const OTHER_MARKER = 'BBB-CONFIDENTIAL-FROM-PROJECT-B'
const OTHER_SYMBOL = 'betaSecretForecast'
const REFUSAL = 'confines symbol lookups to it'

let rootA: string
let rootB: string
let cwdSpy: ReturnType<typeof vi.spyOn>

function seedProject(root: string, symbolName: string, marker: string): string {
  const dir = path.join(root, 'src')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'thing.ts')
  fs.writeFileSync(file, `export function ${symbolName}(): string {\n  return '${marker}'\n}\nexport function ${symbolName}Caller(): string {\n  return ${symbolName}()\n}\n`)
  indexFileSync(normalizePath(file), globalDbPath())
  return file
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
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
  rootA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-root-confine-a-')))
  rootB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-root-confine-b-')))
  seedProject(rootA, 'alphaOwnSymbol', OWN_MARKER)
  // Project B is a git repository whose second commit adds the file, so `changed HEAD~1` has something to report.
  fs.writeFileSync(path.join(rootB, 'README.md'), 'b\n')
  git(rootB, ['init'])
  git(rootB, ['add', 'README.md'])
  git(rootB, ['commit', '-m', 'init'])
  seedProject(rootB, OTHER_SYMBOL, OTHER_MARKER)
  git(rootB, ['add', 'src/thing.ts'])
  git(rootB, ['commit', '-m', 'add thing'])
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

describe('root-scoped index answers with cross_project_symbols = false and a root naming another project', () => {
  beforeEach(() => {
    // B's source now exists only in the index; its directory stays, since `semantic` refuses a root that is not a directory.
    fs.rmSync(path.join(rootB, 'src', 'thing.ts'))
  })

  it('search --project refuses the root instead of answering from its index rows', async () => {
    const { text, code } = await runParallelSearch({ query: OTHER_SYMBOL, projectRoot: rootB })
    expect(text).toContain(REFUSAL)
    expect(text).not.toContain(OTHER_MARKER)
    expect(text).not.toContain(OTHER_SYMBOL)
    expect(code).toBe(1)
  })

  it('search --project --json refuses with a JSON error', async () => {
    const { text, code } = await runParallelSearch({ query: OTHER_SYMBOL, projectRoot: rootB, json: true })
    expect((JSON.parse(text) as { error: string }).error).toContain(REFUSAL)
    expect(code).toBe(1)
  })

  it.each([
    ['semantic', 'semantic', { query: OTHER_SYMBOL }],
    ['semantic with json', 'semantic', { query: OTHER_SYMBOL, json: true }],
    ['map', 'map', {}],
  ])('the MCP %s tool refuses the root instead of answering from its index rows', async (_label, tool, args) => {
    const text = await callTool(tool, { ...args, projectRoot: rootB })
    expect(text).toContain(REFUSAL)
    expect(text).not.toContain(OTHER_MARKER)
    expect(text).not.toContain(OTHER_SYMBOL)
  })
})

describe('the MCP changed tool with cross_project_symbols = false and a root naming another project', () => {
  it('refuses the symbols of the changed files, which come from the index', async () => {
    const text = await callTool('changed', { ref: 'HEAD~1', symbolMode: true, projectRoot: rootB })
    expect(text).toContain(REFUSAL)
    expect(text).not.toContain(OTHER_SYMBOL)
  })

  it('still lists the changed files, which come from git', async () => {
    expect(await callTool('changed', { ref: 'HEAD~1', projectRoot: rootB })).toContain('src/thing.ts')
  })
})

describe('root-scoped index answers with cross_project_symbols = false where the policy allows', () => {
  it('answer for the project token-goat runs from when no root is named', async () => {
    expect(await callTool('semantic', { query: 'alphaOwnSymbol' })).toContain(OWN_MARKER)
    expect((await runParallelSearch({ query: 'alphaOwnSymbol' })).text).toContain('alphaOwnSymbol')
  })

  it('answer for another project that mcp.allowed_roots lists', async () => {
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = rootB
    invalidateConfigCache()
    expect(await callTool('semantic', { query: OTHER_SYMBOL, projectRoot: rootB })).toContain(OTHER_MARKER)
    expect(await callTool('map', { projectRoot: rootB })).toContain(OTHER_SYMBOL)
    expect(await callTool('changed', { ref: 'HEAD~1', symbolMode: true, projectRoot: rootB })).toContain(OTHER_SYMBOL)
    expect((await runParallelSearch({ query: OTHER_SYMBOL, projectRoot: rootB })).text).toContain(OTHER_SYMBOL)
  })
})
