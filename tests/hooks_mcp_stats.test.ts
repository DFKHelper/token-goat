import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Pure spy, deliberately NOT calling through: recordStat's real implementation writes to
// dataDir()/global.db, which is memoized per vitest worker process and is NOT isolated by
// TOKEN_GOAT_HOME, so calling through would write machine-wide rows from a unit test.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, recordStat: vi.fn() }
})

// Importing relay registers every hook module (including hooks_mcp) for its side-effects, so
// runHook dispatches through the real production registry rather than a handler reference this
// test imported itself -- the shipping path, not an injected seam.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { recordStat } from '../src/stats.js'
import { PER_FILE_COUNTERFACTUAL_CEILING } from '../src/util.js'

const READ_ONLY_TOOL = 'mcp__plugin_github_github__search_issues'

let tmpHome: string
let prevHome: string | undefined
let prevCompressFlag: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  prevCompressFlag = process.env['TOKEN_GOAT_MCP_COMPRESS']
  delete process.env['TOKEN_GOAT_MCP_COMPRESS']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-stats-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `mcpstats-${path.basename(tmpHome)}`
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  if (prevCompressFlag === undefined) delete process.env['TOKEN_GOAT_MCP_COMPRESS']
  else process.env['TOKEN_GOAT_MCP_COMPRESS'] = prevCompressFlag
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function statCalls(kind: string): unknown[][] {
  return vi.mocked(recordStat).mock.calls.filter((c) => c[0] === kind) as unknown[][]
}

function homogeneousRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    title: `issue number ${i}`,
    state: 'open',
    url: `https://github.com/o/r/issues/${i}`,
  }))
}

describe('MCP savings stats (real runHook dispatch)', () => {
  it('records mcp:compress for exactly the delta between the original result and the string it actually emitted', async () => {
    const rows = homogeneousRows(200)
    const resultText = JSON.stringify(rows)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: { query: 'is:issue stats-compress' },
        session_id: sessionId,
        tool_response: resultText,
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType !== 'rewriteOutput') return

    // Independent oracle: measured on the literal emitted artifact (notice line included) and on
    // the literal input, never re-derived from the handler's own notice/redaction arithmetic.
    const expectedSaved =
      Buffer.byteLength(resultText, 'utf-8') - Buffer.byteLength(result.updatedOutput, 'utf-8')
    expect(expectedSaved).toBeGreaterThan(0)

    const calls = statCalls('mcp:compress')
    expect(calls.length).toBe(1)
    expect(calls[0]?.[1]).toBe(expectedSaved)
    expect(calls[0]?.[2]).toBe(Math.round(expectedSaved / 4))
  })

  it('records no mcp:compress when the result is below the compression size floor', async () => {
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: { query: 'is:issue stats-small' },
        session_id: sessionId,
        tool_response: JSON.stringify(homogeneousRows(3)),
      }),
    )
    expect(result.hookType).toBe('pass')
    expect(statCalls('mcp:compress').length).toBe(0)
  })

  it('records mcp:recall for the cached result the dedup deny stopped from arriving again', async () => {
    const toolInput = { query: 'is:issue stats-recall' }
    // Prose, so the generic compressor declines and the post hook only stores -- keeping this
    // test about the deny credit alone, with no mcp:compress row in the same ledger.
    const resultText = 'plain prose result body. '.repeat(200)
    expect(Buffer.byteLength(resultText, 'utf-8')).toBeLessThan(PER_FILE_COUNTERFACTUAL_CEILING)

    const post = await runHook(
      buildEvent('post_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: resultText,
      }),
    )
    expect(post.hookType).toBe('pass')
    vi.mocked(recordStat).mockClear()

    const pre = await runHook(
      buildEvent('pre_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: toolInput,
        session_id: sessionId,
      }),
    )
    expect(pre.hookType).toBe('deny')

    const calls = statCalls('mcp:recall')
    expect(calls.length).toBe(1)
    // The cached body carries no secret, so the stored (redacted) copy is byte-identical to the
    // result text this test handed the post hook -- measured here, not read back out of the cache.
    expect(calls[0]?.[1]).toBe(Buffer.byteLength(resultText, 'utf-8'))
    expect(calls[0]?.[2]).toBe(Math.round(Buffer.byteLength(resultText, 'utf-8') / 4))
  })

  it('caps the mcp:recall deny credit at PER_FILE_COUNTERFACTUAL_CEILING', async () => {
    const toolInput = { query: 'is:issue stats-recall-huge' }
    const resultText = 'plain prose result body. '.repeat(8000)
    const rawBytes = Buffer.byteLength(resultText, 'utf-8')
    expect(rawBytes).toBeGreaterThan(PER_FILE_COUNTERFACTUAL_CEILING)

    await runHook(
      buildEvent('post_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: resultText,
      }),
    )
    vi.mocked(recordStat).mockClear()

    const pre = await runHook(
      buildEvent('pre_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: toolInput,
        session_id: sessionId,
      }),
    )
    expect(pre.hookType).toBe('deny')

    const calls = statCalls('mcp:recall')
    expect(calls.length).toBe(1)
    expect(calls[0]?.[1]).toBe(PER_FILE_COUNTERFACTUAL_CEILING)
    expect(calls[0]?.[1]).not.toBe(rawBytes)
  })

  it('records no mcp:recall when there is nothing cached to recall', async () => {
    const pre = await runHook(
      buildEvent('pre_tool_use', {
        tool_name: READ_ONLY_TOOL,
        tool_input: { query: 'is:issue never-seen-before' },
        session_id: sessionId,
      }),
    )
    expect(pre.hookType).toBe('pass')
    expect(statCalls('mcp:recall').length).toBe(0)
  })
})
