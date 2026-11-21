// A wait that leaves a process running after it ends gets a note beside the pass, never a refusal.

// HAND-DERIVED: the commands are written from the shapes the advice names (a follow-mode tail piped into a first-match grep, a fixed sleep before a read); no row runs any of them.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { tempConfigPath } from './helpers/temp-config.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, dataDir: () => _testDataDir }
})

const _testConfigPath = tempConfigPath('tg-hooks-bash-wait-advice.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-hooks-bash-wait-advice-'))

import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

function run(command: string) {
  return preBashHandler(
    makeHookEvent({
      toolName: 'Bash',
      toolInput: { command },
      sessionId: 'wait-advice-session',
      agentId: undefined,
      raw: { tool_name: 'Bash', tool_input: { command } },
    }),
  )
}

const ctx = (out: ReturnType<typeof run>): string => (out.hookType === 'context' ? out.context : '')

beforeEach(() => {
  clearModuleCaches()
})

describe('a follow-mode tail piped into a first-match grep', () => {
  it.each([
    ['tail -f /tmp/x.log | grep -m 1 ready'],
    ['tail -f /tmp/x.log | grep -m1 ready'],
    ['tail -F /tmp/x.log | grep --max-count=1 ready'],
    ['tail -n 0 -f /tmp/x.log | grep -q ready'],
    ['tail --follow /tmp/x.log | grep -q ready'],
  ])('gets the note for %s', (command) => {
    const out = run(command)
    expect(out.hookType, command).toBe('context')
    expect(ctx(out), command).toContain('follow-mode tail')
    expect(ctx(out), command).toContain("command's own completion or exit status")
  })

  it.each([
    ['tail -f /tmp/x.log'],
    ['tail -f /tmp/x.log | grep ready'],
    ['tail -n 5 /tmp/x.log | grep -m 1 ready'],
  ])('gets no note for %s', (command) => {
    const out = run(command)
    expect(out.hookType, command).toBe('pass')
  })
})

describe('a fixed sleep followed by a read in the same line', () => {
  it.each([
    ['sleep 30; cat /tmp/x.log'],
    ['sleep 5 && tail /tmp/x.log'],
    ['sleep 10; git status'],
    ['sleep 5 && token-goat bash-output --file /tmp/x.output'],
    ['sleep 5 && token-goat read src/app.ts'],
  ])(
    'gets the note for %s',
    (command) => {
      const out = run(command)
      expect(out.hookType, command).toBe('context')
      expect(ctx(out), command).toContain('fixed sleep')
      expect(ctx(out), command).toContain("command's own completion or exit status")
    },
  )

  it.each([
    ['sleep 5'],
    ['sleep 5; echo done'],
    ['cat /tmp/x.log; sleep 5'],
    ['sleep 5 && token-goat bash-output abc123'],
  ])(
    'gets no note for %s',
    (command) => {
      expect(run(command).hookType, command).toBe('pass')
    },
  )
})
