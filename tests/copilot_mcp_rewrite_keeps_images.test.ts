/** On Copilot CLI an MCP result's images do not sit in the text token-goat rewrites: copilot-sdk's convertMcpCallToolResult joins the text blocks into `textResultForLlm` and puts each image and blob resource in `binaryResultsForLlm`, and postToolUse hands the hook that whole ToolResultObject. postMcpHandler fences every MCP result, so the bridge answers every MCP call with a `modifiedResult`, which the SDK documents as replacing the tool result, and it used to carry only `{resultType, textResultForLlm}`. Both copies of the translation are driven here on the production path: the resident hook server's adapter (src/hook_adapters.ts) through the real relay, and the installed shim (src/bridges/copilot_cli.ts) spawned against the built bundle. FORMAT-DERIVED: the payload shape is Copilot's PostToolUseHookInput and ToolResultObject from @github/copilot-sdk 1.0.20's types.d.ts; the MCP name `<server>-<tool>` resolves through Copilot's on-disk tool cache as in tests/copilot_mcp_name_canonicalization.test.ts. The image bytes are HAND-DERIVED, an 8-byte PNG signature, since nothing here decodes them. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { resetCopilotMcpToolNameCache } from '../src/copilot_mcp_names.js'
import { runAdapter } from '../src/hook_adapters.js'
import { relayInProcess } from '../src/relay.js'
import { BUNDLE } from './helpers/bundle.js'

const ENV_KEYS = ['TOKEN_GOAT_HARNESS_OVERRIDE', 'COPILOT_CACHE_HOME'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const IMAGE = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
const BLOB = { type: 'resource', mimeType: 'application/pdf', data: 'JVBERi0xLjQ=', description: 'file:///report.pdf' }

let base: string

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-mcp-images-')))
  fs.mkdirSync(path.join(base, 'mcp-tools'))
  fs.writeFileSync(
    path.join(base, 'mcp-tools', 'shots.json'),
    JSON.stringify({ serverName: 'shots', updatedAt: '2026-01-01T00:00:00Z', tools: [{ name: 'take_screenshot', description: 'x', inputSchema: { type: 'object', properties: {} } }] }),
    'utf8',
  )
  process.env['COPILOT_CACHE_HOME'] = base
  resetCopilotMcpToolNameCache()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  resetCopilotMcpToolNameCache()
  fs.rmSync(base, { recursive: true, force: true })
})

function postPayload(sessionId: string, binaryResultsForLlm?: unknown[]): string {
  return JSON.stringify({
    sessionId,
    workingDirectory: base,
    toolName: 'shots-take_screenshot',
    toolArgs: '{}',
    toolResult: { resultType: 'success', textResultForLlm: 'Took a screenshot of the page', ...(binaryResultsForLlm ? { binaryResultsForLlm } : {}) },
  })
}

interface Modified {
  modifiedResult?: { resultType: string; textResultForLlm: string; binaryResultsForLlm?: unknown[] }
}

async function viaAdapter(input: string): Promise<Modified> {
  const result = await runAdapter('copilot_cli', { event: 'postToolUse', input }, { early: () => 0, relay: (event, payload, harnessWaitMs) => relayInProcess(event, payload, harnessWaitMs) })
  expect(result.exit).toBe(0)
  return JSON.parse(result.stdout) as Modified
}

function viaShim(input: string): Modified {
  const script = path.join(base, 'copilot-shim.js')
  fs.writeFileSync(script, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [script, 'postToolUse', BUNDLE], { cwd: base, input, encoding: 'utf8', timeout: 60_000 })
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout || '{}') as Modified
}

function expectFencedWithBinaries(out: Modified, binaries: unknown[] | undefined): void {
  // The fence is what makes this call a rewrite at all; without it there would be no modifiedResult to lose anything from.
  expect(out.modifiedResult?.textResultForLlm).toContain('<untrusted-tool-output>')
  expect(out.modifiedResult?.textResultForLlm).toContain('Took a screenshot of the page')
  expect(out.modifiedResult?.textResultForLlm).not.toContain(IMAGE.data)
  expect(out.modifiedResult?.binaryResultsForLlm).toEqual(binaries)
}

describe('a fenced Copilot MCP result keeps its images', () => {
  it('the resident adapter hands binaryResultsForLlm back beside the fenced text', async () => {
    expectFencedWithBinaries(await viaAdapter(postPayload('copilot-mcp-images-adapter', [IMAGE, BLOB])), [IMAGE, BLOB])
  })

  it('the installed shim does the same against the built bundle', () => {
    expectFencedWithBinaries(viaShim(postPayload('copilot-mcp-images-shim', [IMAGE, BLOB])), [IMAGE, BLOB])
  })

  it('adds no binaryResultsForLlm field to a text-only result', async () => {
    expectFencedWithBinaries(await viaAdapter(postPayload('copilot-mcp-images-text-only')), undefined)
    expect(Object.keys(viaShim(postPayload('copilot-mcp-images-text-only-shim')).modifiedResult ?? {})).toEqual(['resultType', 'textResultForLlm'])
  })
})
