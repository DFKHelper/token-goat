// The relay's suggestion guard (relay.ts safeSuggestions) covered a deny's message, a context hint and a rewriteOutput's out-of-band context, but not a `notice`: a user-only line that is just as likely to be pasted into a shell. It now covers a notice on a pass or a context result too. A rewriteOutput's body stays outside the guard on purpose, since it is captured tool output and the guard would rewrite a file that merely quotes a token-goat command; the second case pins that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HookRegistry from '../src/hook_registry.js'
import type { HookOutput } from '../src/types.js'

const stub = vi.hoisted(() => ({ output: { hookType: 'pass' } as HookOutput }))

vi.mock('../src/hook_registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HookRegistry>()
  return { ...actual, runHook: async () => stub.output }
})

const { relayInProcess } = await import('../src/relay.js')
const { stripUnsafeSuggestions } = await import('../src/hint_suggestion_guard.js')

// HAND-DERIVED: a suggestion whose argument holds `$(`, which double quotes do not keep literal, beside one that is safe.
const UNSAFE = 'token-goat read "a$(echo MARK).ts::foo"'
const SAFE = 'token-goat stats'
// HAND-DERIVED: a line of source a Bash command printed, which happens to show a token-goat command with a shell variable in it.
const CAPTURED = 'echo "run token-goat read "$file" to see it"\n'

// FORMAT-DERIVED: https://code.claude.com/docs/en/hooks.md, the PreToolUse and PostToolUse Bash input examples; the tool_response keys are the ones tests/hooks_real_harness_payload_shape.test.ts records off real traffic.
function payload(eventName: 'pre_tool_use' | 'post_tool_use'): Record<string, unknown> {
  const base: Record<string, unknown> = { session_id: `relay-notice-${process.pid}`, cwd: process.cwd(), permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'cat notes.sh' } }
  if (eventName === 'post_tool_use') base['tool_response'] = { stdout: CAPTURED, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return base
}

const savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']

beforeEach(() => {
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
})

afterEach(() => {
  if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
})

describe('the relay guards what token-goat writes and leaves captured output alone', () => {
  it('drops an unsafe suggestion from a notice on a pass and keeps the safe one', async () => {
    stub.output = { hookType: 'pass', notice: `Run \`${UNSAFE}\` or \`${SAFE}\`.` }
    const out = JSON.parse(await relayInProcess('pre_tool_use', payload('pre_tool_use'))) as Record<string, unknown>
    const message = String(out['systemMessage'])
    expect(message).not.toContain('MARK')
    expect(message).toContain(SAFE)
  })

  it('drops it from a notice riding on a context hint', async () => {
    stub.output = { hookType: 'context', context: 'A hint.', notice: `Run \`${UNSAFE}\`.` }
    const out = JSON.parse(await relayInProcess('pre_tool_use', payload('pre_tool_use'))) as Record<string, unknown>
    expect(String(out['systemMessage'])).not.toContain('MARK')
  })

  it('passes a rewritten tool output through as its producer built it, though the guard would edit it', async () => {
    expect(stripUnsafeSuggestions(CAPTURED)).not.toBe(CAPTURED)
    stub.output = { hookType: 'rewriteOutput', updatedOutput: CAPTURED }
    const out = JSON.parse(await relayInProcess('post_tool_use', payload('post_tool_use'))) as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } }
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toBe(CAPTURED)
  })
})
