/** Visual Studio and JetBrains reach token-goat only through `mcp-serve`, so the row cap that prices CJK text part by part has to cut the same rows there as on the CLI. Both run the built bundle against one CJK-heavy file with overflow_guard.max_tokens at its floor. `read` has no row cap (a symbol body is one object), so the MCP tool that carries the capped rows for a file is `outline`; no MCP tool reaches capListField, which only the sqlite readers use. Provenance: the expected row count is HAND-DERIVED from the documented rates (3 characters per token for ASCII, 0.9 for CJK ideographs, as integer ninths) applied to each row's printed JSON, independent of the guard's code; the file is generated here. */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const bundle = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist', 'token-goat.mjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-cjk-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

// The row shape (name, kind, lineStart, lineEnd, docstring, parent) is what `outline --json` printed for this file when run by hand.
const BUDGET_TOKENS = 1000
const ROWS = 120
const CJK_RUN = '函数名称清单查询读取输出'

const project = path.join(scratch, 'proj')
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, 'wide.ts'), Array.from({ length: ROWS }, (_, i) => `export function ${CJK_RUN}${String(i).padStart(3, '0')}(): number {\n  return ${String(i)}\n}\n`).join('\n'))

const env: NodeJS.ProcessEnv = {
  ...process.env,
  TOKEN_GOAT_HOME: path.join(scratch, 'home'),
  XDG_DATA_HOME: path.join(scratch, 'home', 'xdg'),
  LOCALAPPDATA: path.join(scratch, 'home', 'lad'),
  USERPROFILE: path.join(scratch, 'home'),
  TOKEN_GOAT_OVERFLOW_MAX_TOKENS: String(BUDGET_TOKENS),
  TOKEN_GOAT_BASH_COMPRESS: '0',
  TOKEN_GOAT_NO_WORKER_SPAWN: '1',
}

interface Capped { items: Array<{ name: string }>; truncated: boolean; totalCount: number }

function cliOutline(): Capped {
  const res = spawnSync(process.execPath, [bundle, 'outline', 'wide.ts', '--json'], { cwd: project, env, encoding: 'utf8' })
  expect(res.status).toBe(0)
  return JSON.parse(res.stdout) as Capped
}

async function mcpOutline(): Promise<Capped> {
  const child = spawn(process.execPath, [bundle, 'mcp-serve'], { cwd: project, env, stdio: ['pipe', 'pipe', 'ignore'] })
  child.stdin.on('error', () => undefined)
  const pending = new Map<number, (m: { result?: { content?: Array<{ text?: string }> } }) => void>()
  let buf = ''
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const m = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } }
        if (m.id !== undefined) pending.get(m.id)?.(m)
      } catch {
        // not a JSON-RPC line
      }
    }
  })
  const send = (id: number, method: string, params: unknown): Promise<{ result?: { content?: Array<{ text?: string }> } }> =>
    new Promise((resolve) => {
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cjk-parity', version: '0' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const reply = await send(2, 'tools/call', { name: 'outline', arguments: { file: 'wide.ts', json: true, projectRoot: project } })
    return JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as Capped
  } finally {
    // The server's working directory is the project, which Windows will not delete while the process lives.
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill()
    await closed
  }
}

/** How many leading rows fit: a row costs its printed JSON in ninths of a token (ASCII 3, CJK 10) plus 6 for the separator, against 9 per token of budget. */
function rowsThatFit(rows: readonly unknown[]): number {
  let used = 0
  let kept = 0
  for (const row of rows) {
    let cost = 6
    for (const ch of JSON.stringify(row)) cost += ch.codePointAt(0)! >= 0x4e00 && ch.codePointAt(0)! <= 0x9fff ? 10 : 3
    if (used + cost > BUDGET_TOKENS * 9) break
    used += cost
    kept += 1
  }
  return kept
}

describe('the row cap on CJK text, CLI and MCP', () => {
  it('cuts the same rows on the CLI and through the MCP outline tool, at the count the documented rates give', async () => {
    const cli = cliOutline()
    const mcp = await mcpOutline()
    expect(cli.truncated).toBe(true)
    expect(cli.totalCount).toBe(ROWS)
    const expected = rowsThatFit(Array.from({ length: ROWS }, (_, i) => ({ name: `${CJK_RUN}${String(i).padStart(3, '0')}`, kind: 'function', lineStart: 1 + 4 * i, lineEnd: 3 + 4 * i, docstring: '', parent: '' })))
    expect(cli.items.length).toBeGreaterThan(0)
    expect(cli.items.length).toBeLessThan(ROWS)
    expect(cli.items.length).toBe(expected)
    expect(mcp.truncated).toBe(cli.truncated)
    expect(mcp.totalCount).toBe(cli.totalCount)
    expect(mcp.items.map((i) => i.name)).toEqual(cli.items.map((i) => i.name))
  }, 120_000)
})
