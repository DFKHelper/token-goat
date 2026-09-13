/**
 * The out-of-root refusal must not describe a boundary the deployment does not have.
 *
 * It used to end "The MCP tools are confined to the workspace." There is no workspace in that
 * sense unless an operator has set `mcp.allowed_roots`, which defaults to empty: the client sends a
 * `projectRoot` on every call and the server confines that call to whatever root it was handed. So
 * the refusal is evidence that the target did not sit inside the root THAT call named -- not that
 * the tools cannot reach outside some fixed directory. An operator reading the old sentence in a
 * log would have taken the stronger reading, and the whole reason the refusal text was split by
 * reason in this release is that a message which says the wrong thing sends someone to the wrong
 * fix.
 *
 * PROVENANCE: CAPTURE. The strings asserted are read out of a live MCP `read` call over the
 * in-memory transport, not off the source of `refusalText`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { normalizePath } from '../src/paths.js'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

let base: string
let projectRoot: string
let outsideFile: string
let cleanup: (() => Promise<void>) | undefined

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refusal-')))
  projectRoot = path.join(base, 'project')
  fs.mkdirSync(projectRoot)
  outsideFile = path.join(base, 'secret.txt')
  fs.writeFileSync(outsideFile, 'CANARY_REFUSAL\n')
  invalidateConfigCache()
})

afterEach(async () => {
  if (cleanup !== undefined) await cleanup()
  cleanup = undefined
  fs.rmSync(base, { recursive: true, force: true })
  invalidateConfigCache()
})

async function refuse(): Promise<string> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  cleanup = async () => {
    await client.close()
    await server.close()
  }
  const result = await client.callTool({ name: 'read', arguments: { spec: outsideFile, projectRoot } })
  expect(result.isError, 'the out-of-root read was not refused, so there is no message to check').toBe(true)
  const text = textOf(result)
  expect(text, 'the refusal leaked the file it refused').not.toContain('CANARY_REFUSAL')
  return text
}

describe('the out-of-root refusal', () => {
  it('names the root it measured against rather than an unnamed workspace', async () => {
    const text = await refuse()
    // normalizePath rather than a hand-rolled flip: the message carries the RESOLVED root
    // (`c:/...`), and tests/guards/windows_path_fixture_normalization.test.ts exists because every
    // hand-rolled version of this in a fixture has eventually diverged from the real one. It is not
    // a self-referential fixture -- normalizePath is not the function under test here, refusalText is.
    expect(text).toContain(`is outside the project root "${normalizePath(projectRoot)}"`)
    expect(text, 'the message still claims a workspace-wide boundary').not.toContain('confined to the workspace')
  })

  it('says the root came from the caller, and points at the setting that would pin it', async () => {
    // The default is `allowed_roots: []`, so this is the state a fresh install is in.
    const text = await refuse()
    expect(text).toContain('the projectRoot it names')
    expect(text).toContain('mcp.allowed_roots')
  })

  it('still tells the caller how to turn confinement off, which is the actionable half', async () => {
    expect(await refuse()).toContain('mcp.confine_reads_to_project_root')
  })
})
