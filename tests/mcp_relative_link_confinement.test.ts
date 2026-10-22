/** A RELATIVE spec that names an in-root symlink or junction pointing outside the project root is refused under confinement, as its absolute spelling already was. Provenance: HAND-DERIVED. The spellings are the ones a security audit of the built bundle reproduced as leaking (`sl.txt`, `./sl.txt`, `jn/o.txt`, `sl.json`); the marker text is written by this file into a directory it creates outside the root, so no matcher of ours supplies it. The links are real filesystem links made by this file. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { createMcpServer } from '../src/mcp_server.js'
import { ALL_MCP_TOOLS_ENV } from './helpers/mcp_all_tools.js'

// The refusal is the same text for every tool, so the cases below can call opt-in tools too.
process.env['TOKEN_GOAT_MCP_TOOLS'] = ALL_MCP_TOOLS_ENV

const MARKER = 'OUTSIDE_TEXT_SECRET'
const JSON_MARKER = 'OUTSIDE_JSON_SECRET'

/** Capability probe, not a platform guess: a file symlink is unprivileged on POSIX and EPERM on a Windows host without Developer Mode. */
function canCreateFileSymlinks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rel-link-probe-'))
  try {
    fs.writeFileSync(path.join(probe, 'target'), 'x')
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

/** A junction on Windows (unprivileged), a plain directory symlink elsewhere. */
function canCreateDirLinks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rel-dirlink-probe-'))
  try {
    fs.mkdirSync(path.join(probe, 'target'))
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

const FILE_LINKS = canCreateFileSymlinks()
const DIR_LINKS = canCreateDirLinks()

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
  return ((result as any).content as any[]).map((c) => c.text as string).join('\n')
}

const ENV_KEYS = ['TOKEN_GOAT_MCP_CONFINE_READS', 'TOKEN_GOAT_MCP_ALLOWED_ROOTS', 'CLAUDE_CONFIG_DIR'] as const

describe('mcp confinement: a relative spelling of an in-root link that points outside the root', () => {
  let tmp: string
  let proj: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rel-link-')))
    proj = path.join(tmp, 'proj')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(proj)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'o.txt'), `${MARKER}\nline2\n`)
    fs.writeFileSync(path.join(outside, 'o.json'), `{"outside":"${JSON_MARKER}"}\n`)
    fs.writeFileSync(path.join(proj, 'in.txt'), 'INSIDE_OK\nline2\n')
    if (FILE_LINKS) {
      fs.symlinkSync(path.join(outside, 'o.txt'), path.join(proj, 'sl.txt'), 'file')
      fs.symlinkSync(path.join(outside, 'o.json'), path.join(proj, 'sl.json'), 'file')
    }
    if (DIR_LINKS) fs.symlinkSync(outside, path.join(proj, 'jn'), 'junction')
    // Standard auxiliary roots hang off this directory; none of the relative names exists beneath it, which is the condition the defect needs.
    process.env['CLAUDE_CONFIG_DIR'] = path.join(tmp, 'claude-home')
    process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = '1'
    delete process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS']
    invalidateConfigCache()
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    invalidateConfigCache()
    // rmSync removes a link without following it, so the outside directory is removed by its own entry.
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const { client, close } = await connectedClient()
    try {
      return textOf(await client.callTool({ name, arguments: { ...args, projectRoot: proj } }))
    } finally {
      await close()
    }
  }

  function expectRefused(text: string): void {
    expect(text, 'the outside file content leaked').not.toContain(MARKER)
    expect(text, 'the outside file content leaked').not.toContain(JSON_MARKER)
    expect(text).toMatch(/outside the project root/)
  }

  // FIRST row, deliberately: the exact reported shape. A bare relative name, a symlink inside the root, a target outside it.
  it.skipIf(!FILE_LINKS)('read refuses a bare relative spec naming an in-root symlink to an outside file', async () => {
    expectRefused(await call('read', { spec: 'sl.txt' }))
  })

  it.skipIf(!FILE_LINKS)('read refuses the ./ spelling of the same symlink', async () => {
    expectRefused(await call('read', { spec: './sl.txt' }))
  })

  it.skipIf(!DIR_LINKS)('read refuses a relative spec that passes through an in-root junction to an outside file', async () => {
    expectRefused(await call('read', { spec: 'jn/o.txt' }))
  })

  it.skipIf(!FILE_LINKS)('read refuses a relative symlink to an outside document, which takes the document route', async () => {
    expectRefused(await call('read', { spec: 'sl.json' }))
  })

  it.skipIf(!FILE_LINKS)('read refuses a relative symlink with a line-range suffix', async () => {
    expectRefused(await call('read', { spec: 'sl.txt@1-2' }))
  })

  it.skipIf(!FILE_LINKS)('section, outline and skeleton refuse the relative symlink too', async () => {
    expectRefused(await call('section', { spec: 'sl.txt::Heading' }))
    expectRefused(await call('outline', { file: 'sl.json' }))
    expectRefused(await call('skeleton', { file: 'sl.txt' }))
  })

  it.skipIf(!FILE_LINKS)('a root named in mcp.allowed_roots does not admit the relative symlink either', async () => {
    const extra = path.join(tmp, 'extra-root')
    fs.mkdirSync(extra)
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = [proj, extra].join(path.delimiter)
    invalidateConfigCache()
    expectRefused(await call('read', { spec: 'sl.txt' }))
  })

  it('still reads an in-root relative file', async () => {
    const text = await call('read', { spec: 'in.txt' })
    expect(text).toContain('INSIDE_OK')
    expect(text).not.toMatch(/outside the project root/)
  })

  it('still reads a relative spec that sits under a root named in mcp.allowed_roots', async () => {
    const extra = path.join(tmp, 'extra-root')
    fs.mkdirSync(extra)
    fs.writeFileSync(path.join(extra, 'ok.txt'), 'ALLOWED_ROOT_OK\n')
    process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'] = [proj, extra].join(path.delimiter)
    invalidateConfigCache()
    expect(await call('read', { spec: '../extra-root/ok.txt' })).toContain('ALLOWED_ROOT_OK')
  })
})
