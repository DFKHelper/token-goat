/** postMcpHandler's two oversized previews, the compressed one and the recovery one, reserved a fixed 500 bytes for the fence around the preview. Escaping a body dense in markers can double it: a 60 KB MCP result of `[tg]` lines came out at 34,920 bytes with its closing tag at byte 34,896, past the 25,000 bytes at which the harness spills an MCP result and keeps only a preview, which then ends before the closing tag. Both previews now measure the framed rewrite and cut until it fits under that threshold. The returns that fence a result whole had the same gap at four times the size: a reply its server flags as an error, a repeated read-only call, and a result too large to cache all shipped the whole fenced text, 100,912 bytes for the same 60 KB. They are fitted the same way, with a note outside the closing tag that names the cached copy, or says there is none. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Importing relay registers every hook module, so runHook dispatches through the production registry.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { MCP_OVERSIZED_THRESHOLD_BYTES } from '../src/hooks_mcp.js'
import { UNTRUSTED_TOOL_TAG } from '../src/injection_scan.js'

let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HOME', 'TOKEN_GOAT_HARNESS_OVERRIDE']) saved[key] = process.env[key]
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-preview-fit-'))
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(home, { recursive: true, force: true })
})

/** PROVENANCE: the audit's input, lines of `[tg] [tg] [tg] [tg] [tg]` to at least `bytes`, each line numbered so no pass can collapse them as repeats. */
function denseLines(bytes: number): string {
  const lines: string[] = []
  let size = 0
  for (let n = 0; size < bytes; n++) {
    const line = `[tg] [tg] [tg] [tg] [tg] ${n}`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

function post(toolResponse: unknown, sessionId: string) {
  return runHook(buildEvent('post_tool_use', { tool_name: 'mcp__docs__fetch_page', tool_input: { page: 'notes' }, session_id: sessionId, tool_response: toolResponse }))
}

/** The rewrite, asserted under the spill size with its fence closed before any note token-goat appends. */
function expectFitted(result: Awaited<ReturnType<typeof post>>, label: string): string {
  expect(result.hookType, `${label}: the fixture must reach a rewrite`).toBe('rewriteOutput')
  if (result.hookType !== 'rewriteOutput') throw new Error('unreachable')
  const text = result.updatedOutput
  expect(Buffer.byteLength(text, 'utf-8'), label).toBeLessThan(MCP_OVERSIZED_THRESHOLD_BYTES)
  expect(text, label).toContain(`</${UNTRUSTED_TOOL_TAG}>`)
  expect(text, label).toContain('&#91;tg]')
  return text
}

describe('an oversized MCP result fits under the spill threshold with its fence closed', () => {
  it('a 60 KB result of deny-prefix lines', async () => {
    const text = expectFitted(await post([{ type: 'text', text: denseLines(60_000) }], `mcp-preview-${path.basename(home)}`), 'preview')
    expect(text).toContain('preview truncated by token-goat')
  })

  it('the same result flagged by its server as an error, which is never cached', async () => {
    const text = expectFitted(await post({ content: [{ type: 'text', text: denseLines(60_000) }], isError: true }, `mcp-error-${path.basename(home)}`), 'isError')
    expect(text.slice(text.lastIndexOf(`</${UNTRUSTED_TOOL_TAG}>`))).toContain('it was not cached, so the rest cannot be recalled')
  })

  it('a repeated read-only call, which points at the copy the first one cached', async () => {
    const session = `mcp-dedup-${path.basename(home)}`
    const body = [{ type: 'text', text: denseLines(60_000) }]
    expectFitted(await post(body, session), 'first call')
    const text = expectFitted(await post(body, session), 'repeat')
    const note = text.slice(text.lastIndexOf(`</${UNTRUSTED_TOOL_TAG}>`))
    expect(note).toMatch(/the cached copy of this call is \S+, and `token-goat mcp-output \S+ --head 50`/)
  })

  it('a result over the 2 MiB the cache keeps', async () => {
    const text = expectFitted(await post([{ type: 'text', text: denseLines(2 * 1024 * 1024 + 100_000) }], `mcp-huge-${path.basename(home)}`), 'over 2 MiB')
    expect(text.slice(text.lastIndexOf(`</${UNTRUSTED_TOOL_TAG}>`))).toContain('it was not cached')
  })
})
