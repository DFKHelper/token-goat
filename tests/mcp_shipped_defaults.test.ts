/** The MCP surface as it actually ships: `mcp.confine_reads_to_project_root` is false and `mcp.allowed_roots` is empty (src/config_defaults.ts), so a caller-supplied `projectRoot` is honoured verbatim and a target outside it is served rather than refused. Every other MCP confinement test in this repo forces `TOKEN_GOAT_MCP_CONFINE_READS=1` in its setup, which is correct -- those tests are about what the gate does when it is ON -- but it leaves the shipped OFF default observed by nothing. This file is the counterweight: it sets no `TOKEN_GOAT_MCP_*` variable at all, and asserts the absence of each one as a precondition so a leaked variable from another file surfaces as a named failure instead of quietly turning this file into a duplicate of the confinement suite. */
/** PROVENANCE: FORMAT-DERIVED for the two default values, read off `src/config_defaults.ts` (`mcp.confine_reads_to_project_root: false`, `mcp.allowed_roots: []`) and re-read at run time through `loadConfig()` in the calibration block below rather than restated as literals here. HAND-DERIVED for the directory layout and canary strings, which are built by this file and contain no producer output. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache, loadConfig } = await import('../src/config.js')

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

const OUTSIDE_CANARY = 'SHIPPED-DEFAULT-OUTSIDE-CONTENT'

describe('the shipped MCP defaults, with no TOKEN_GOAT_MCP_* env forcing', () => {
  let base: string
  let projectRoot: string
  let outside: string
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shipped-defaults-')))
    projectRoot = path.join(base, 'project')
    outside = path.join(base, 'outside')
    fs.mkdirSync(projectRoot)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(projectRoot, 'inside.ts'), 'export const inside = 1\n')
    fs.writeFileSync(path.join(outside, 'secret.ts'), `export const secret = '${OUTSIDE_CANARY}'\n`)
    fs.writeFileSync(path.join(outside, 'notes.md'), `# Heading\n\n${OUTSIDE_CANARY}\n`)
    invalidateConfigCache()
  })

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    fs.rmSync(base, { recursive: true, force: true })
    invalidateConfigCache()
  })

  async function connectedClient(): Promise<Client> {
    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    cleanup = async () => {
      await client.close()
      await server.close()
    }
    return client
  }

  // Calibration, not an assertion about behaviour: it names WHICH defaults the three tests below are observing. If the owner ever flips either default, this fails first and says so, instead of the behaviour tests failing for a reason a reader has to reconstruct.
  it('ships with confinement off and no root allowlist, and nothing in this file forces either', () => {
    expect(process.env['TOKEN_GOAT_MCP_CONFINE_READS'], 'a TOKEN_GOAT_MCP_CONFINE_READS leaked into this file, so it is no longer observing the shipped default').toBeUndefined()
    expect(process.env['TOKEN_GOAT_MCP_ALLOWED_ROOTS'], 'a TOKEN_GOAT_MCP_ALLOWED_ROOTS leaked into this file, so it is no longer observing the shipped default').toBeUndefined()
    const mcp = loadConfig().mcp
    expect(mcp.confine_reads_to_project_root).toBe(false)
    expect(mcp.allowed_roots).toEqual([])
  })

  // File-reading tool, whole-file spec. This is the surface tests/mcp_server_read_confinement.test.ts covers in its ON state.
  it('read serves a file outside projectRoot', async () => {
    const client = await connectedClient()
    const result = await client.callTool({
      name: 'read',
      arguments: { spec: path.join(outside, 'secret.ts'), projectRoot },
    })
    expect(result.isError, 'the shipped default refused an out-of-root read').toBeFalsy()
    expect(textOf(result)).toContain(OUTSIDE_CANARY)
  })

  // File-reading tool, `file::heading` spec. A distinct resolution path from `read` above -- it is the specFilePart layer tests/mcp_server_spec_filepart_bypass.test.ts covers in its ON state -- so covering only `read` would leave it unobserved.
  it('section serves a heading from a file outside projectRoot', async () => {
    const client = await connectedClient()
    const result = await client.callTool({
      name: 'section',
      arguments: { spec: `${path.join(outside, 'notes.md')}::Heading`, projectRoot },
    })
    expect(result.isError, 'the shipped default refused an out-of-root section').toBeFalsy()
    expect(textOf(result)).toContain(OUTSIDE_CANARY)
  })

  // Non-file tool. `map` names no target path at all, so the only thing the shipped defaults decide for it is whether an arbitrary caller-supplied projectRoot is accepted -- which is `assertRootAllowed` returning early on an empty allowlist, a different gate from the one the two reads above exercise.
  it('map accepts an arbitrary caller-supplied projectRoot', async () => {
    const client = await connectedClient()
    const result = await client.callTool({ name: 'map', arguments: { compact: true, projectRoot } })
    expect(result.isError, 'the shipped default refused an arbitrary caller-supplied projectRoot').toBeFalsy()
    expect(textOf(result), 'a refusal naming the allowlist came back even though it ships empty').not.toContain('mcp.allowed_roots')
  })
})
