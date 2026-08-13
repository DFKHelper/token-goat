// Regression: the `section` MCP tool's confinement gate validates and pins a target against
// `root` (the git-toplevel-resolved projectRoot from resolveToolRoot), but the actual disk read
// was passing the RAW, unresolved `projectRoot` argument straight to `runSection` instead of
// `root` -- every other file-reading tool (read/skeleton/outline/refs/brief/grep/imports/exports)
// passes `projectRoot: root`, only `section` passed `...(projectRoot !== undefined ? { projectRoot } : {})`.
//
// The divergence bites whenever a caller passes a projectRoot that is a strict subdirectory of a
// git repo (an ordinary monorepo/subpackage call): resolveToolRoot walks up to the git toplevel to
// compute `root`, so the gate validates and pins a path resolved against the (broader) toplevel,
// while the buggy execution layer resolves the same relative spec against the (narrower, raw)
// subdirectory -- an entirely different, never-validated, never-pinned file on disk. That breaks
// the TOCTOU identity-pin invariant this gate exists to enforce and can serve content the gate
// never approved.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createMcpServer } from '../src/mcp_server.js'

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer()
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

const IN_ROOT = 'IN-ROOT-SECTION-MARKER'
const NEVER_VALIDATED = 'NEVER-VALIDATED-SUBDIR-SECRET'

describe('mcp section tool: execution base must equal the gate-validated base', () => {
  let repoRoot: string
  let subDir: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    if (repoRoot !== undefined) fs.rmSync(repoRoot, { recursive: true, force: true })
  })

  it('section: a relative spec is resolved against the gate-validated root, not the raw subdirectory projectRoot', async () => {
    // A real git repo, with a subdirectory as the caller-supplied projectRoot -- this is what
    // makes resolveToolRoot's git-toplevel walk diverge from the raw argument.
    repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-bypass-')))
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot })
    subDir = path.join(repoRoot, 'packages', 'app')
    fs.mkdirSync(subDir, { recursive: true })

    // Same relative filename in both locations: the gate validates and pins the copy directly
    // under repoRoot (the resolved root); a bug in section reads the copy under the subdirectory
    // instead, which the gate never inspected at all.
    fs.writeFileSync(path.join(repoRoot, 'notes.md'), `# Heading\n\n${IN_ROOT}\n`)
    fs.writeFileSync(path.join(subDir, 'notes.md'), `# Heading\n\n${NEVER_VALIDATED}\n`)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({
      name: 'section',
      arguments: { spec: 'notes.md::Heading', projectRoot: subDir },
    })
    const text = textOf(result)
    // The gate validated and pinned repoRoot/notes.md (IN_ROOT). If execution reads a different,
    // never-validated file instead (packages/app/notes.md), the pin's identity contract is
    // defeated and content the gate never approved is served.
    expect(text).not.toContain(NEVER_VALIDATED)
    expect(text).toContain(IN_ROOT)
  })
})
