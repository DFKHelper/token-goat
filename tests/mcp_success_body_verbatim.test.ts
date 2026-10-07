/** An MCP tool call rewrote a successful result whole: the CLI-to-tool wording that turns `token-goat read "x"` into "the read tool again" and `--json` into "the json parameter" ran over the file's own lines too, so a source file that mentions token-goat's commands or a `--limit` flag came back altered. The rewrite now applies to failure text and to the notes token-goat appends to a success, each worded where it is built (mcp_client_text.ts forClient), and never to the body. Driven through the real MCP server over the SDK's InMemoryTransport, against a real index. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { createMcpServer } from '../src/mcp_server.js'
import { indexFileSync } from '../src/parser.js'

// HAND-DERIVED: comment lines written by hand to hold each pattern the MCP wording rewrites (a double- and a single-quoted retry command, the three flags, the cached-output narrowing phrase), inside an ordinary function long enough that `symbol` previews it and notes the rest.
const PATTERN_LINES = [
  '  // run token-goat read "src/a.ts::hold" to see it all',
  "  // or token-goat section 'docs/x.md::Intro'",
  '  // pass --json, --limit 5 or --top 3 on the command line',
  '  // Use --grep PATTERN, --section HEADING, or --tail N to narrow the cached output.',
]
const HOLD_LINES = ['export function hold(): number {', ...PATTERN_LINES, '  const a = 1', '  const b = 2', '  return a + b', '}']

// HAND-DERIVED: a function far past the cap (the loader raises the 200 asked for below to its 1000-token floor), every line holding a flag the rewrite would change, so the kept lines and the cap's own note sit in one result.
const BIG_LINES = ['export function big(): number {', ...Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i} // --json --limit`), '  return 0', '}']

const SOURCE = [...HOLD_LINES, '', ...BIG_LINES, ''].join('\n')

let dir: string

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-body-')))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'a.ts'), SOURCE)
  indexFileSync(path.join(dir, 'a.ts'), globalDbPath())
})

afterEach(() => {
  delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
  invalidateConfigCache()
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = await createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name, arguments: { ...args, projectRoot: dir } })
    const content = result.content as Array<{ type: string; text: string }>
    return { text: content.map((c) => c.text).join(''), isError: result.isError === true }
  } finally {
    await client.close()
    await server.close()
  }
}

describe('a successful MCP result carries the file body as written', () => {
  it('read returns a symbol body holding retry commands and flags byte for byte', async () => {
    const r = await call('read', { spec: 'a.ts::hold' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(HOLD_LINES.join('\n'))
  })

  it('read of the whole file returns it byte for byte', async () => {
    const r = await call('read', { spec: 'a.ts' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(SOURCE.trimEnd())
  })

  it('grep returns matching lines as written', async () => {
    const r = await call('grep', { pattern: 'token-goat', path: [path.join(dir, 'a.ts')] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(PATTERN_LINES[0]!.trim())
    expect(r.text).toContain(PATTERN_LINES[1]!.trim())
  })

  it('symbol keeps the previewed lines and still words its own full-body note for MCP', async () => {
    const r = await call('symbol', { name: 'hold' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(PATTERN_LINES.join('\n'))
    expect(r.text).toContain('full body: `the "read" tool again with a more specific spec (e.g. "a.ts::hold")`')
    expect(r.text).not.toContain('token-goat read "a.ts::hold"')
  })

  it('a capped read keeps its kept lines and still words the cap note for MCP', async () => {
    process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '200'
    invalidateConfigCache()
    const r = await call('read', { spec: 'a.ts::big' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(BIG_LINES.slice(0, 4).join('\n'))
    expect(r.text).toMatch(/\[token-goat: output capped at ~\d+ tokens/)
    expect(r.text).toContain('use the json parameter for structured access')
    expect(r.text).not.toContain('use --json for structured access')
  })
})

describe('the same wording outside an MCP call', () => {
  it('leaves a note as the CLI writes it', async () => {
    const { forClient } = await import('../src/mcp_client_text.js')
    expect(forClient('use --json for structured access')).toBe('use --json for structured access')
  })

  it('words a note for MCP inside a tool call', async () => {
    const { answeringMcpToolCall, forClient } = await import('../src/mcp_client_text.js')
    expect(answeringMcpToolCall(() => forClient('use --json for structured access'))).toBe('use the json parameter for structured access')
  })
})
