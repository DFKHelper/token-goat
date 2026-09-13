/**
 * A relative `path` given to the MCP `grep` tool must be read from the same place the confinement
 * gate checked it, not from the server process's current directory.
 *
 * `confineTargets` documents the invariant this protects: "a handler must pass `targets` from this
 * function's own return value to its `run*` call, never the raw argument it validated -- the value
 * checked and the value used must be the same reference". `grep` obeyed the letter of that and
 * still leaked, because the two sides agreed on the STRING and disagreed on the BASE. The gate
 * measures `path.resolve(projectRoot, entry)`; `runGrep` handed the entry to a reader that resolves
 * against `process.cwd()`. Where projectRoot is not the cwd -- the ordinary case, since an MCP
 * client supplies it per call -- `grep(pattern, path: ["secret.txt"], projectRoot: "/safe")` was
 * gated as `/safe/secret.txt`, found absent, pinned ABSENT, and then opened `<cwd>/secret.txt`. The
 * identity pin did not save it: the pin is keyed on the gated spelling, so the read's key missed
 * and the lookup degraded to an unpinned raw read, which is the silent-miss failure the pin's own
 * comment warns about.
 *
 * Every other path-taking MCP tool was swept for the same shape at the same time -- `read`,
 * `section`, `skeleton`, `outline`, `imports`, `exports`, `symbol`, `refs`, `brief` -- and all of
 * them already anchor to the gated root. `grep` was the only one, which is why this test names it.
 *
 * PROVENANCE: CAPTURE. The canary file is created here and read back through the live MCP server
 * over an in-memory transport, so the assertion is against what the tool actually returns to a
 * client rather than against a reconstruction of it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')

const CANARY = 'CANARY_GREP_ANCHOR_XYZZY'

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('a relative grep path is read from the gated root, not the process cwd', () => {
  let projectRoot: string
  let outsideFile: string
  const relativeName = 'tg_grep_anchor_canary.txt'

  beforeEach(() => {
    invalidateConfigCache()
    projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-grep-anchor-')))
    // Deliberately beside the SERVER PROCESS's cwd, which is not the gated root. This is the file
    // an unanchored relative read reaches and a correctly anchored one does not.
    outsideFile = path.join(process.cwd(), relativeName)
    fs.writeFileSync(outsideFile, `${CANARY}\n`)
  })

  afterEach(() => {
    fs.rmSync(outsideFile, { force: true })
    fs.rmSync(projectRoot, { recursive: true, force: true })
    invalidateConfigCache()
  })

  async function grep(args: Record<string, unknown>): Promise<string> {
    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      return textOf(await client.callTool({ name: 'grep', arguments: args }))
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('does not return a file that exists only beside the cwd', async () => {
    // Calibration: the canary must actually be readable from the cwd, or an empty result below
    // would prove the fixture broken rather than the boundary held.
    expect(fs.readFileSync(outsideFile, 'utf8'), 'the canary was not written where an unanchored read would find it').toContain(CANARY)

    const text = await grep({ pattern: CANARY, path: [relativeName], projectRoot })
    expect(text, 'the relative path resolved against the server process cwd instead of the gated project root, so a file outside the workspace was read').not.toContain(CANARY)
  })

  it('still finds the same relative name when it really is inside the gated root', async () => {
    // The mirror case. A fix that simply refused every relative path would pass the test above and
    // break the tool; this one fails if the anchoring overshoots into a blanket denial.
    fs.writeFileSync(path.join(projectRoot, relativeName), `${CANARY}\n`)
    const text = await grep({ pattern: CANARY, path: [relativeName], projectRoot })
    expect(text, 'a relative path that genuinely sits under the gated root must still be searched').toContain(CANARY)
  })
})
