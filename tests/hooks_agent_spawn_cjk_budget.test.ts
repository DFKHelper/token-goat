/** The subagent briefing is cut to BRIEFING_TARGET_TOKENS by estimateTokens, which now prices CJK text at 0.9 characters per token instead of 3. A project whose map is mostly CJK paths used to be priced at a third of its real size, so the briefing went out far over budget. Each host's spawn goes through the real hook registry: Claude Code `Agent`, Codex `spawn_agent` (message field), and Copilot CLI `task` with the key set of the captured toolArgs (tests/fixtures/copilot_cli_1_0_88/C4a-004-preToolUse-task.json, CAPTURE). The Claude and Codex payload shapes are FORMAT-DERIVED from tests/hooks_agent_spawn.test.ts. The map is a stand-in for what buildProjectMap prints, HAND-DERIVED: thirty paths of twelve CJK characters under an ASCII prefix. The independent budget check prices each character by hand (CJK 10 ninths of a token, anything else 3), not through the estimator it is checking. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { importSessionState } from '../src/session.js'
import { loadSessionState } from '../src/session_store.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'

const CJK = '函数名称清单查询读取输'
const PATHS = Array.from({ length: 30 }, (_, i) => `src/模块/${CJK}${String(i).padStart(2, '0')}.ts`)
const MAP = ['# Project map: cjk-app', 'Files: 30', '', '## Files', ...PATHS.map((p) => `- ${p}`)].join('\n')
const BRIEFING_TARGET_TOKENS = 550

vi.mock('../src/baseline.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, formatProjectMap: () => MAP }
})

let tmpHome = ''
let prevHome: string | undefined

beforeEach(() => {
  importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [], outstandingAgentSpawns: [] })
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-agent-cjk-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Tokens by hand: ninths of a token, CJK ideographs 10 and every other UTF-16 unit 3, over 9. */
function handTokens(text: string): number {
  let ninths = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    ninths += code >= 0x3400 && code <= 0x9fff ? 10 : 3
  }
  return ninths / 9
}

const copilotArgs = (): Record<string, unknown> => (copilotCapture('C4a-004-preToolUse-task', { proj: tmpHome })['toolArgs'] as Record<string, unknown>)

const HOSTS: ReadonlyArray<[string, () => Record<string, unknown>, string]> = [
  ['Claude Code Agent', () => ({ tool_name: 'Agent', tool_input: { prompt: 'Look at the build.', description: 'build', subagent_type: 'general-purpose' } }), 'prompt'],
  ['Codex spawn_agent', () => ({ tool_name: 'spawn_agent', tool_input: { message: 'Look at the build.', agent_type: 'worker' } }), 'message'],
  ['Copilot CLI task', () => ({ tool_name: 'task', tool_input: { ...copilotArgs(), prompt: 'Look at the build.' } }), 'prompt'],
]

describe('the subagent briefing on a project with a CJK map', () => {
  it.each(HOSTS)('%s: stays within the token budget and still lists the project paths', async (_host, payload, field) => {
    const sid = `cjk-${Math.random().toString(36).slice(2)}`
    loadSessionState(sid)
    const result = await runHook(buildEvent('pre_tool_use', { ...payload(), session_id: sid }))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType !== 'rewriteInput') return
    const text = result.updatedInput[field] as string
    const briefing = text.slice(text.indexOf('## Session briefing'))
    expect(briefing).toContain('## Session briefing')
    expect(briefing).toContain(PATHS[0]!)
    expect(briefing.length).toBeLessThan(MAP.length + 800)
    expect(handTokens(briefing)).toBeLessThanOrEqual(BRIEFING_TARGET_TOKENS)
  })
})
