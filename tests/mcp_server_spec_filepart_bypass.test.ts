// Regression: `specFilePart` (the confinement gate's notion of "the file part of a spec")
// disagreed with the execution layer's own parsing, on two separate axes, letting an in-root
// prefix validate a call whose ACTUAL file target resolved outside the project root.
//
//   1. `@` stripping: specFilePart stripped everything after the LAST `@` unconditionally, but
//      only `parseLineRange`'s exact trailing-numeric-range syntax (`/^(.+)@(\d+)(?:-(\d+))?$/`)
//      makes runRead treat an `@` as a range separator. `inside@../../../outside/secret` has no
//      trailing digits, so parseLineRange declines and runRead reads the whole literal string as
//      a bare file path -- but specFilePart still chopped it down to `inside` and validated that
//      instead, admitting a call whose real target left the root.
//   2. `::` splitting: specFilePart split on the FIRST `::` (`spec.indexOf('::')`), but both
//      runRead's `parseReadSpec` and runSection use `findSpecSeparator`, which is a
//      `lastIndexOf('::')`. A spec with two `::` occurrences -- `a::../../b::Heading` -- validated
//      only `a` while the execution layer actually read `a::../../b`.
//
// The fix makes specFilePart call read_commands.ts's real `parseLineRange` and
// `findSpecSeparator` instead of restating their grammar, so the two layers can't drift again.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createMcpServer } from '../src/mcp_server.js'

const SECRET = 'SECRET-MARKER-DO-NOT-LEAK'
const IN_ROOT = 'IN-ROOT-MARKER'

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

describe('mcp confinement: specFilePart must agree with the execution layer', () => {
  let root: string
  let outside: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const dir of [root, outside]) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDirs(): void {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-fp-root-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-fp-outside-'))
    fs.writeFileSync(path.join(outside, 'secret'), `${SECRET}\n`)
    fs.writeFileSync(path.join(root, 'inside.txt'), `${IN_ROOT} line1\n${IN_ROOT} line2\n`)
  }

  // ---- Bypass 1: `@` stripped even though parseLineRange would decline the whole spec ------

  it('read: refuses a spec whose in-root-looking `@` prefix is not a real line-range separator', async () => {
    makeDirs()
    // "inside@../../../<outside-basename>/secret" has no trailing digits after the `@`, so
    // parseLineRange declines and runRead reads the literal string as a bare file path. Path
    // resolution only collapses a segment that is EXACTLY "..", so "inside@.." is one literal
    // (non-existent) directory name, not an up-move -- the first ".." after it cancels that
    // push back to root, and the second climbs one level above root to root's parent, where
    // `outside` lives as a sibling temp dir. Pre-fix, specFilePart's unconditional last-`@`
    // strip validated only "inside" and admitted the call; the actual read escaped the root.
    const spec = `inside@../../../${path.basename(outside)}/secret`
    // Sanity: this spec really does resolve outside root when read literally, proving the
    // exploit shape (not just an inert string the fix would refuse for unrelated reasons).
    expect(fs.existsSync(path.resolve(root, spec))).toBe(true)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the project root')
    expect(textOf(result)).not.toContain(SECRET)
  })

  // ---- Bypass 2: `::` split on the FIRST occurrence instead of the LAST --------------------

  it('section: refuses a spec whose in-root-looking prefix before the FIRST `::` differs from the real file (before the LAST `::`)', async () => {
    makeDirs()
    // Two `::` occurrences: pre-fix specFilePart split on the FIRST (validating just "inside"),
    // but findSpecSeparator (lastIndexOf) -- what runSection actually uses -- splits on the
    // LAST, so the real file part is "inside::../../../<outside-basename>/secret" (same
    // literal-segment-then-two-real-".." shape as the `@` case above).
    const spec = `inside::../../../${path.basename(outside)}/secret::Heading`

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'section', arguments: { spec, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the project root')
    expect(textOf(result)).not.toContain(SECRET)
  })

  // ---- Positive case: a legitimate range spec must still work -----------------------------

  it('read: a genuine in-root file@N-M line range still works', async () => {
    makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: 'inside.txt@1-1', projectRoot: root } })
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain(`${IN_ROOT} line1`)
    expect(text).not.toContain(`${IN_ROOT} line2`)
  })
})
