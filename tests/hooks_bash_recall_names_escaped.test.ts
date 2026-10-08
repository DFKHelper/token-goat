// The cached-curl recall hint prints a name it did not write: the command that produced the cached response. It is legal on every shell and must reach the terminal escaped. The hint also offers a heading of the response, but hintTarget drops any heading displaySafeText would rewrite, so that name needs no escape of its own and a hostile heading is never offered.

// HAND-DERIVED: the command and the heading are invented to hold U+202E (bidi override, a format character); the expected spelling is displaySafeText's `‮` escape for a format character worked out from that rule, not read off the implementation's output.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { tempConfigPath } from './helpers/temp-config.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, dataDir: () => _testDataDir }
})

const _testConfigPath = tempConfigPath('tg-hooks-bash-recall-names.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-hooks-bash-recall-names-'))

import { pipelineDivergenceNote } from '../src/hooks_bash_commands.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

const RLO = String.fromCharCode(0x202e)
const FORMAT_CHARS = /\p{Cf}/u

function bashEvent(command: string, eventName?: 'post_tool_use', output?: string): HookEvent {
  return makeHookEvent({
    ...(eventName !== undefined ? { eventName } : {}),
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'recall-names-session',
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, ...(output !== undefined ? { tool_response: output } : {}) },
  })
}

beforeEach(() => {
  clearModuleCaches()
})

describe('pipelineDivergenceNote', () => {
  it('escapes a format character in the cached command it quotes', () => {
    const note = pipelineDivergenceNote('curl https://example.com/a', `curl https://example.com/a | jq ${RLO}.x`)
    expect(note).not.toMatch(FORMAT_CHARS)
    expect(note).toContain('jq \\u202e.x')
  })

  it('says nothing when the cached command is the one being run', () => {
    expect(pipelineDivergenceNote('curl https://example.com/a', 'curl https://example.com/a')).toBe('')
  })
})

describe('the cached curl recall hint', () => {
  it('escapes the cached command, and offers the heading that survives where a hostile one is dropped', async () => {
    const url = 'https://example.com/recall-names'
    const cached = `curl -s ${url} | jq ${RLO}.title`
    const body = `# Top${RLO}x\n\n## Section\n\n` + 'filler line of body text\n'.repeat(400)
    await postBashHandler(bashEvent(cached, 'post_tool_use', body))
    const result = preBashHandler(bashEvent(`curl -s ${url}`))
    expect(result.hookType, JSON.stringify(result).slice(0, 300)).toBe('context')
    if (result.hookType !== 'context') return
    expect(result.context).not.toMatch(FORMAT_CHARS)
    expect(result.context).toContain('jq \\u202e.title')
    expect(result.context).toContain('--section "Section"')
  })
})
