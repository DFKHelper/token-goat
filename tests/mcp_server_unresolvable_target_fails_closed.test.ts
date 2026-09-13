/**
 * The MCP confinement gate must refuse a target whose real location it cannot determine.
 *
 * `checkWithinProjectRoot` (src/mcp_server.ts) compares the realpath of the target against the
 * realpath of the root. The helper behind both sides used to be `try { realpathSync.native(p) }
 * catch { return p }`, so when the call threw, the comparison silently degraded to a LEXICAL
 * prefix test and any path that merely LOOKED like it sat under the root was admitted and opened.
 * That is fail-OPEN on a confinement boundary, and it is the same defect `src/path_containment.ts`
 * documents as removed from `isInsideRoot`. The two boundaries were failing in opposite
 * directions, and only one of them had a test naming which direction was intended. This is that
 * test for the other one.
 *
 * The ENOENT half is asserted too, because it is what a naive "fail closed on any errno" fix
 * breaks: an MCP client may legitimately name a file that does not exist, and that must come back
 * as an ordinary read failure rather than a confinement refusal. `confineTargets` writes an
 * `ABSENT_PIN` for precisely that case.
 *
 * PROVENANCE: HAND-DERIVED. The symlink cycle is built here and its errno is read off the live OS
 * at run time rather than assumed, so the test reports which errno it actually exercised and
 * refuses to pass if the platform resolved the cycle instead.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CAN_SYMLINK } from './helpers/can-symlink.js'

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

// The refusal an unresolvable target draws is deliberately NOT the ordinary out-of-root wording:
// both are final refusals, but one names a traversal attempt and the other names a broken path, and
// an operator reading the wrong one goes looking for an attack instead of a symlink loop.
const REFUSAL = 'could not be resolved to a real location'
/** The ordinary out-of-root wording, asserted absent so the two refusals cannot silently merge. */
const OUT_OF_ROOT = 'is outside the project root. The MCP tools are confined to the workspace.'

describe('the MCP confinement gate fails closed on a target it cannot resolve', () => {
  let projectRoot: string
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(() => {
    projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-unresolvable-')))
    invalidateConfigCache()
  })

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    fs.rmSync(projectRoot, { recursive: true, force: true })
    invalidateConfigCache()
  })

  it.runIf(CAN_SYMLINK)('refuses a path inside the root whose realpath cannot be determined', async () => {
    // A two-link cycle. Both ends are LEXICALLY under the root, so a lexical prefix test admits
    // them, and `realpathSync.native` cannot answer for either.
    const loopA = path.join(projectRoot, 'loopA.ts')
    const loopB = path.join(projectRoot, 'loopB.ts')
    fs.symlinkSync(loopB, loopA, 'file')
    fs.symlinkSync(loopA, loopB, 'file')

    const errno = ((): string => {
      try {
        fs.realpathSync.native(loopA)
        return 'RESOLVED'
      } catch (err) {
        return (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      }
    })()
    // Calibration. If the platform resolves the cycle, or reports it as mere absence, this fixture
    // is not exercising the branch under test and a pass below would prove nothing.
    expect(errno, 'the symlink cycle resolved, so this fixture no longer produces an unresolvable path').not.toBe('RESOLVED')
    expect(errno, 'the cycle reports as absent, which is the lexical branch this test is deliberately not about').not.toBe('ENOENT')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: loopA, projectRoot } })
    expect(result.isError, `a target whose realpath is ${errno} must be refused, not compared lexically`).toBe(true)
    expect(textOf(result)).toContain(REFUSAL)
    expect(textOf(result), 'an unresolvable path was reported as a traversal attempt, which points the reader at the wrong cause').not.toContain(OUT_OF_ROOT)
  })

  it('still admits a file that simply does not exist yet, so absence is not treated as unresolvable', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    const absent = path.join(projectRoot, 'not_created_yet.ts')
    const result = await client.callTool({ name: 'read', arguments: { spec: absent, projectRoot } })
    // It fails -- there is nothing to read -- but it must NOT fail as a confinement refusal.
    expect(textOf(result), 'an absent in-root file was reported as unresolvable, so ENOENT is no longer taking the lexical branch').not.toContain(REFUSAL)
    expect(textOf(result), 'an absent in-root file was reported as outside the root').not.toContain(OUT_OF_ROOT)
    // The positive half. Both assertions above are negative, so on their own they are satisfied by
    // any unrelated failure -- a renamed tool, a server that never started, confinement switched
    // off, a reworded refusal. These pin that what came back is the ordinary read failure it should
    // be, naming the file that was asked for.
    expect(result.isError, 'reading a file that does not exist must still fail').toBe(true)
    expect(textOf(result), 'the failure did not name the absent path, so it is not the ordinary read failure this case is about').toContain(path.basename(absent))
  })
})
