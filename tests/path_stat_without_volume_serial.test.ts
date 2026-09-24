// Regression: two containment checks compared an identity taken by a path `stat` against one taken by `fstat` on an open descriptor, and on Windows those two disagree for the same file under some Node releases. libuv 1.49 and 1.50 answer a path `stat` from a fast path that leaves `dev` at 0 while `fstat` reports the volume serial, so every MCP read the confinement gate pinned was refused as "changed identity between validation and read", and `pack` skipped every file as pointing outside the project root.
//
// CAPTURE (Windows 11 10.0.26200, NTFS, one file, `fs.statSync(p, { bigint: true })` against `fs.fstatSync(fs.openSync(p, 'r'), { bigint: true })`): Node 22.16.0 (libuv 1.49.2), 23.11.0 (libuv 1.50.0) and 24.0.0 (libuv 1.50.0) each gave stat 0:554787179097211066 and fstat 1862132318:554787179097211066; Node 22.21.1 (libuv 1.51.0) gave 1862132318:554787179097211066 for both. The mock below reproduces the captured shape on any platform: a path `stat` whose `dev` is 0, an `fstat` left untouched. The inode is the same on both sides, as captured.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pathStatDropsDev = vi.hoisted(() => ({ on: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (actual.statSync as any)(...args)
      if (pathStatDropsDev.on && st !== undefined) st.dev = typeof st.dev === 'bigint' ? 0n : 0
      return st
    },
  }
})

import { createMcpServer } from '../src/mcp_server.js'
import { collectFiles, estimateBudget } from '../src/pack.js'
import { invalidateConfigCache } from '../src/config.js'

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

const MARKER = 'PATH-STAT-DEV-ZERO-MARKER'

describe('an identity check survives a path stat that reports no volume serial', () => {
  let root: string
  let close: (() => Promise<void>) | undefined
  let originalConfineReads: string | undefined

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-devzero-')))
    fs.mkdirSync(path.join(root, 'tests'))
    fs.writeFileSync(path.join(root, 'tests', 'README.md'), `# Integrity tests\n\n${MARKER}\n\n## Running\n\nrun them\n`)
    fs.writeFileSync(path.join(root, 'tests', 'Integrity.Tests.ps1'), `function Test-Integrity {\n  '${MARKER}'\n}\n`)
    // Confinement is what installs the identity pins; it is off by default and on under the restrictive security profile, which is where this surfaced.
    originalConfineReads = process.env['TOKEN_GOAT_MCP_CONFINE_READS']
    process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = '1'
    invalidateConfigCache()
    pathStatDropsDev.on = true
  })

  afterEach(async () => {
    pathStatDropsDev.on = false
    if (originalConfineReads === undefined) delete process.env['TOKEN_GOAT_MCP_CONFINE_READS']
    else process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = originalConfineReads
    invalidateConfigCache()
    if (close !== undefined) await close()
    close = undefined
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('the stub reproduces the capture: a path stat and an fstat of one file disagree on dev, agree on ino', () => {
    const p = path.join(root, 'tests', 'README.md')
    const byPath = fs.statSync(p, { bigint: true })
    const fd = fs.openSync(p, 'r')
    try {
      const byHandle = fs.fstatSync(fd, { bigint: true })
      expect(byPath.dev).toBe(0n)
      expect(byHandle.ino).toBe(byPath.ino)
    } finally {
      fs.closeSync(fd)
    }
  })

  it.each([
    ['section', { spec: 'tests/README.md::Integrity tests' }],
    ['read', { spec: 'tests/README.md' }],
    ['outline', { file: 'tests/README.md' }],
    ['read', { spec: 'tests/Integrity.Tests.ps1' }],
  ] as const)('mcp %s %j reads the file instead of refusing it as swapped', async (name, args) => {
    const connected = await connectedClient()
    close = connected.close
    const text = textOf(await connected.client.callTool({ name, arguments: { ...args, projectRoot: root } }))
    expect(text).not.toContain('changed identity')
    expect(text).not.toContain('refused')
    expect(text).toMatch(name === 'outline' ? /Integrity tests/ : new RegExp(MARKER))
  })

  it('mcp grep over a directory target is not refused', async () => {
    const connected = await connectedClient()
    close = connected.close
    const text = textOf(await connected.client.callTool({ name: 'grep', arguments: { pattern: MARKER, path: ['tests'], projectRoot: root } }))
    expect(text).not.toContain('changed identity')
    expect(text).toContain(MARKER)
  })

  it('pack collects an ordinary in-root file instead of skipping it as outside the root', () => {
    const files = ['tests/README.md', 'tests/Integrity.Tests.ps1']
    const result = collectFiles(root, files)
    expect(result.skipped.filter((s) => s.includes('outside project root'))).toEqual([])
    expect(result.files.map((f) => f.rel_path).sort()).toEqual(['tests/Integrity.Tests.ps1', 'tests/README.md'])
    expect(estimateBudget(root, files).entries).toHaveLength(2)
  })
})
