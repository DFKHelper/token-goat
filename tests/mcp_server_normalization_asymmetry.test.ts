/**
 * The MCP confinement gate must refuse a target that only looks in-root once it has been
 * normalized. Both the spelling the gate measures and the spelling the reader will use have to
 * land inside the root.
 *
 * `confineTargets` documents one half of this rule: forward the caller's argument byte-for-byte, so
 * a normalisation step in the gate cannot validate a different string than the one that gets read.
 * That stops the gate being LOOSER than the reader. The reverse was reachable and unguarded.
 * `normalizePath` rewrites the WSL mount form `/mnt/c/x` to `c:/x` on EVERY platform -- deliberately,
 * because a WSL process emits that form while running on Linux (see `shellMountToWindowsPath` in
 * src/paths.ts, whose comment states the WSL branch is unconditional for exactly that reason). On
 * POSIX, `c:/x` is a RELATIVE path. So the gate resolved `/mnt/c/Users/victim/.ssh/id_rsa` to
 * `<root>/c:/Users/victim/.ssh/id_rsa`, found it comfortably under the root, and approved it, while
 * the handler forwarded the untouched absolute original and the reader opened the real file. The
 * identity pin was no help: it was keyed on the spelling the gate had invented, so the read's own
 * key missed and the lookup degraded silently to an unpinned raw read.
 *
 * POSIX-only by construction, not by convenience: on Windows `c:/x` is drive-absolute, so the
 * rewrite is a no-op for containment there and the case cannot be built. CI runs ubuntu-latest and
 * macos-latest, so this executes on two of the three platforms.
 *
 * PROVENANCE: CAPTURE. Every call goes through the live MCP server over an in-memory transport, so
 * the assertions are on the response a client actually receives, and the rewrite the attack depends
 * on is read off `normalizePath` at run time rather than assumed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { normalizePath } = await import('../src/paths.js')

const POSIX = process.platform !== 'win32'
const CANARY = 'CANARY_MOUNT_FORM_XYZZY'

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('a target that is only in-root after normalization is refused', () => {
  let projectRoot: string

  beforeEach(() => {
    invalidateConfigCache()
    projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mountform-')))
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
    invalidateConfigCache()
  })

  it.runIf(POSIX)('refuses a WSL mount-form path that normalizes into a relative in-root one', async () => {
    // Calibration first. If normalizePath ever stops rewriting the mount form, or stops producing a
    // relative result on POSIX, this fixture no longer exercises the asymmetry and a pass below
    // would prove nothing.
    const probe = '/mnt/c/Users/victim/.ssh/id_rsa'
    const rewritten = normalizePath(probe)
    expect(rewritten, 'normalizePath no longer rewrites the WSL mount form, so this fixture is inert').not.toBe(probe)
    expect(path.isAbsolute(probe), 'the raw mount form must be absolute or the reader would not escape').toBe(true)
    expect(path.isAbsolute(rewritten), 'the rewritten form is no longer relative, so the gate would not be fooled by it').toBe(false)

    // The assertion is on the REFUSAL, not on leaked bytes, and deliberately so. Building a real
    // file under a real `/mnt/<letter>/` needs root on a CI runner, and a first draft of this test
    // that faked one under a temp directory passed with the fix reverted -- the canary sat at
    // `$TMPDIR/tg-mnt-XXX/mnt/c/secret.ts` while the attack string named the actual `/mnt/c`, so
    // nothing was there to leak and the pass proved nothing. What the gate owes here is independent
    // of whether the file happens to exist: a path that is absolute and outside the root must be
    // refused as outside it, not admitted and then merely fail to open. Those two outcomes are
    // distinguishable in the response text, which is what this asserts.
    const attack = '/mnt/c/Users/victim/.ssh/id_rsa'
    expect(path.resolve(projectRoot, attack), 'the attack path must resolve outside the root for this to be an escape at all').not.toContain(projectRoot)

    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      for (const call of [
        { name: 'outline', arguments: { file: attack, projectRoot } },
        { name: 'grep', arguments: { pattern: CANARY, path: [attack], projectRoot } },
      ]) {
        const text = textOf(await client.callTool(call))
        expect(text, `${call.name} admitted a path outside the project root because its normalized form looked in-root; it reached the read layer instead of being refused`).toContain(
          'is outside the project root',
        )
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('still admits an ordinary in-root file, so the extra check is not a blanket refusal', async () => {
    const inRoot = path.join(projectRoot, 'ok.ts')
    fs.writeFileSync(inRoot, `export const canary = '${CANARY}'\n`)
    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const text = textOf(await client.callTool({ name: 'grep', arguments: { pattern: CANARY, path: [inRoot], projectRoot } }))
      expect(text, 'a legitimate in-root absolute path was refused, so the second resolution overshot').toContain(CANARY)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
