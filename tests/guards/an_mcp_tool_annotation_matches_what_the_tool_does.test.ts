/** Guard: an MCP tool's advertised `annotations` must match what the tool actually does, not just what its config object claims. CAPTURE: the 18 tool names, their registration order, and the shape of a `tools/list` response (including that `annotations` rides on each listed tool) come from a real `createMcpServer()` connected to a `Client` over `InMemoryTransport.createLinkedPair()`, the same harness `tests/mcp_tool_allowlist.test.ts` already uses -- not from reading `src/mcp_server.ts`'s registration source. The per-tool valid-argument fixtures below are the ones that were probed against a real temp project (a git-inited directory holding `mod.ts` with `export function alphaSymbol()` and `notes.md` with `# Heading One`, `git add -A`'d) and confirmed to return a result rather than a schema-validation failure. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearModuleCaches } from '../../src/reset.js'
import { _resetDataDirCacheForTesting, dataDirForHome, tokenGoatHome } from '../../src/constants.js'
import { CONTENT_SUBDIR } from '../../src/content_store.js'
import { pinnedPopulation } from './population.js'

const { createMcpServer } = await import('../../src/mcp_server.js')

let home: string
let projectRoot: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined
let previousNoWorkerSpawn: string | undefined
let closeServer: (() => Promise<void>) | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  previousNoWorkerSpawn = process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-annotation-home-'))
  process.env['TOKEN_GOAT_HOME'] = home
  // dataDir() reads LOCALAPPDATA on win32 and XDG_DATA_HOME elsewhere; dataDirForHome computes the per-platform layout under a root, so both vars are pinned to the root that layout expects rather than to `home` itself (see tests/content_store.test.ts for the same derivation and why hardcoding one platform's path breaks the others).
  const dataRoot = dataDirForHome(home)
  const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '1'
  _resetDataDirCacheForTesting()
  clearModuleCaches()

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-annotation-project-'))
  fs.writeFileSync(path.join(projectRoot, 'mod.ts'), 'export function alphaSymbol(): number {\n  return 1\n}\n')
  fs.writeFileSync(path.join(projectRoot, 'notes.md'), '# Heading One\n\nSome text.\n')
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectRoot, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')
})

afterEach(async () => {
  if (closeServer !== undefined) {
    await closeServer()
    closeServer = undefined
  }
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  if (previousNoWorkerSpawn === undefined) delete process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
  else process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = previousNoWorkerSpawn
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

async function buildClient(): Promise<Client> {
  const server = await createMcpServer()
  const client = new Client({ name: 'annotation-guard', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  closeServer = async () => {
    await client.close()
    await server.close()
  }
  return client
}

/** Every file under the content store's subdirectory, recursively, as a sorted list of absolute paths -- used as a before/after fingerprint rather than a byte-for-byte diff, since a new file appearing (or an existing one disappearing) is what a write or an eviction looks like here. The root is `tokenGoatHome()`, which is where `storeBlob` actually writes; reading it from `dataDir()` instead -- the database's home, a different directory on every platform -- made this snapshot see nothing at all, and an oracle that can never observe a write certifies every annotation it is shown. */
function snapshotContentDir(): string[] {
  const dir = path.join(tokenGoatHome(), CONTENT_SUBDIR)
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

/** Valid arguments for each of the 18 tools registered today, per this file's header CAPTURE note. A tool added later with no entry here fails loudly in the loop below instead of being silently skipped. */
function argsFor(name: string): Record<string, unknown> | undefined {
  const table: Record<string, Record<string, unknown>> = {
    symbol: { name: 'alphaSymbol', projectRoot },
    read: { spec: 'mod.ts::alphaSymbol', projectRoot },
    section: { spec: 'notes.md::Heading One', projectRoot },
    skeleton: { file: 'mod.ts', projectRoot },
    outline: { file: 'mod.ts', projectRoot },
    semantic: { query: 'alphaSymbol', projectRoot },
    index_status: { projectRoot },
    refs: { spec: 'mod.ts::alphaSymbol', projectRoot },
    brief: { spec: 'mod.ts::alphaSymbol', projectRoot },
    map: { projectRoot },
    changed: { projectRoot },
    grep: { pattern: 'alphaSymbol', projectRoot },
    imports: { file: 'mod.ts', projectRoot },
    exports: { file: 'mod.ts', projectRoot },
    compress_text: { text: 'hello from the annotation guard' },
    retrieve_text: { id: 'tg_0000000000000000' },
    handoff_create: { name: 'probe', text: 'hello from the annotation guard', projectRoot },
    handoff_resolve: { name: 'probe', projectRoot },
  }
  return table[name]
}

describe('MCP tool annotations match tool behavior', () => {
  it('advertises a real, uniquely named tool population, so the checks below measure something', async () => {
    // Calibration, mirroring tests/mcp_tool_allowlist.test.ts: if the unfiltered server advertised one tool or none, every assertion below would pass without cutting or checking anything real.
    const client = await buildClient()
    const listed = await client.listTools()
    const names = listed.tools.map((t) => t.name)
    // Floor below the 18 registered today so an ordinary removal does not fire it, and the three named members are the ones the checks below actually turn on: one plain reader, and both writers. A count alone would keep passing if the writers were dropped and readers added in their place, which is the exact substitution that would leave the write/annotation comparison measuring nothing.
    pinnedPopulation({ what: 'tools advertised by the MCP server', items: names, floor: 15, mustIncludeExact: ['read', 'compress_text', 'handoff_create'] })
    expect(new Set(names).size, 'tools/list contains duplicate names').toBe(names.length)
  })

  it('gives every advertised tool a readOnlyHint', async () => {
    const client = await buildClient()
    const listed = await client.listTools()
    const missing = listed.tools.filter((t) => t.annotations === undefined || t.annotations['readOnlyHint'] === undefined).map((t) => t.name)
    expect(missing, `these tools advertise no readOnlyHint: ${missing.join(', ')}`).toEqual([])
  })

  it('writes to the content store from exactly the tools that declare readOnlyHint: false', async () => {
    const client = await buildClient()
    const listed = await client.listTools()
    const names = listed.tools.map((t) => t.name)
    const annotationsByName = new Map(listed.tools.map((t) => [t.name, t.annotations]))
    const declaredReadOnly = names.filter((n) => annotationsByName.get(n)?.['readOnlyHint'] === true)
    const declaredWriting = names.filter((n) => annotationsByName.get(n)?.['readOnlyHint'] === false)

    // Discover, per tool, whether calling it actually changed the content store -- independent of what its annotation claims, so this is a discriminating oracle rather than the annotation grouping testing itself. A tool call returning an error result is fine here; only a write is being measured.
    const wroteToContentStore: string[] = []
    for (const name of names) {
      const args = argsFor(name)
      if (args === undefined) {
        throw new Error(`no fixture arguments for tool "${name}" in argsFor(); add one so this guard keeps exercising every registered tool`)
      }
      const before = snapshotContentDir()
      await client.callTool({ name, arguments: args })
      const after = snapshotContentDir()
      if (before.length !== after.length || before.some((p, i) => p !== after[i])) wroteToContentStore.push(name)
    }

    // The two halves this task calls out explicitly: the read-only-annotated tools, called, produced no write; and the writing tools did.
    const readOnlyThatWrote = declaredReadOnly.filter((n) => wroteToContentStore.includes(n))
    expect(readOnlyThatWrote, `these readOnlyHint:true tools wrote to the content store: ${readOnlyThatWrote.join(', ')}`).toEqual([])
    expect(wroteToContentStore.length, 'no tool call changed the content store at all -- the snapshot is not a discriminating oracle here').toBeGreaterThan(0)

    // check 4: the observed writers are exactly the declared writers, by set equality against behavior -- not against a hardcoded list of names.
    expect([...wroteToContentStore].sort()).toEqual([...declaredWriting].sort())
  })
})
