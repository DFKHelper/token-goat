import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_exitplanmode) for its
// side-effects, so runHook dispatches through the real production registry --
// not a test-only handler reference. buildEvent maps a Claude Code payload onto
// a HookEvent exactly as relay() does on stdin.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-exitplanmode-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `em-${path.basename(tmpHome)}`
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('ExitPlanMode plan-body deduplication hook (real runHook dispatch)', () => {
  const toolName = 'ExitPlanMode'

  function postPayload(output: string, plan?: string): Record<string, unknown> {
    const toolInput = plan === undefined ? {} : { plan }
    return { tool_name: toolName, tool_input: toolInput, session_id: sessionId, tool_response: { output, status: 'success' } }
  }

  it('rewrites a result with the "## Approved Plan:" marker to omit the plan body', async () => {
    const confirmLine = 'User has approved your plan.'
    const marker = '## Approved Plan:'
    const planBody = 'This is the plan body\nwith multiple lines\nof plan content'
    const output = `${confirmLine}\n\n${marker}\n${planBody}`

    const res = await runHook(buildEvent('post_tool_use', postPayload(output, planBody)))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).toContain(confirmLine)
      expect(res.updatedOutput).toContain(marker)
      expect(res.updatedOutput).not.toContain(planBody)
      expect(res.updatedOutput).toContain('token-goat')
      expect(res.updatedOutput).toContain('omitted')
    }
  })

  it('passes through a result without the marker unchanged', async () => {
    const output = 'User has rejected the plan.\n\nReason: too risky'
    const res = await runHook(buildEvent('post_tool_use', postPayload(output)))
    expect(res.hookType).toBe('pass')
  })

  it('passes through a result with a different marker format unchanged', async () => {
    const output = 'Plan Approved:\nsome plan body here'
    const res = await runHook(buildEvent('post_tool_use', postPayload(output)))
    expect(res.hookType).toBe('pass')
  })

  it('ignores a non-ExitPlanMode tool entirely', async () => {
    const res = await runHook(
      buildEvent('post_tool_use', {
        tool_name: 'SomethingElse',
        tool_input: {},
        tool_response: { output: '## Approved Plan:\nSome plan body' },
        session_id: sessionId,
      }),
    )
    expect(res.hookType).toBe('pass')
  })

  it('passes through on an empty/missing tool result', async () => {
    const res = await runHook(buildEvent('post_tool_use', postPayload('')))
    expect(res.hookType).toBe('pass')

    const res2 = await runHook(buildEvent('post_tool_use', { tool_name: toolName, tool_input: {}, session_id: sessionId }))
    expect(res2.hookType).toBe('pass')
  })

  it('fails open gracefully on malformed tool_response', async () => {
    const payload = {
      tool_name: toolName,
      tool_input: {},
      session_id: sessionId,
      tool_response: null,
    }
    const res = await runHook(buildEvent('post_tool_use', payload))
    expect(res.hookType).toBe('pass')
  })

  it('keeps the prefix text when rewriting (confirmation before the marker)', async () => {
    const prefix = 'User has approved your plan.\n\nHere are some notes:\n'
    const marker = '## Approved Plan:'
    const planBody = 'The actual plan proposal goes here...\nMultiple lines...'
    const output = `${prefix}${marker}\n${planBody}`

    const res = await runHook(buildEvent('post_tool_use', postPayload(output, planBody)))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).toContain(prefix.trim())
      expect(res.updatedOutput).toContain(marker)
      expect(res.updatedOutput).not.toContain(planBody)
    }
  })

  it('includes the omission pointer in the rewritten output', async () => {
    const output = '## Approved Plan:\nplan body here'
    const res = await runHook(buildEvent('post_tool_use', postPayload(output, 'plan body here')))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).toContain('token-goat')
      expect(res.updatedOutput).toContain('omitted')
      expect(res.updatedOutput).toContain('tool_input')
    }
  })

  it('handles a marker at the very start of output (no prefix)', async () => {
    const marker = '## Approved Plan:'
    const planBody = 'This is the original plan body content'
    const output = `${marker}\n${planBody}`

    const res = await runHook(buildEvent('post_tool_use', postPayload(output, planBody)))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).toContain(marker)
      expect(res.updatedOutput).not.toContain(planBody)
      expect(res.updatedOutput).toContain('omitted')
    }
  })

  it('preserves text between confirmation and marker', async () => {
    const line1 = 'User has approved your plan.'
    const middle = 'Some intermediate explanation line here.'
    const marker = '## Approved Plan:'
    const planBody = 'actual plan text'
    const output = `${line1}\n${middle}\n${marker}\n${planBody}`

    const res = await runHook(buildEvent('post_tool_use', postPayload(output, planBody)))
    expect(res.hookType).toBe('rewriteOutput')
    if (res.hookType === 'rewriteOutput') {
      expect(res.updatedOutput).toContain(line1)
      expect(res.updatedOutput).toContain(middle)
      expect(res.updatedOutput).toContain(marker)
      expect(res.updatedOutput).not.toContain(planBody)
    }
  })

  it('case-sensitively matches the marker (not "## approved plan:" or other casing)', async () => {
    const output = '## approved plan:\nPlan body here'
    const res = await runHook(buildEvent('post_tool_use', postPayload(output)))
    expect(res.hookType).toBe('pass')

    const output2 = '## APPROVED PLAN:\nPlan body here'
    const res2 = await runHook(buildEvent('post_tool_use', postPayload(output2)))
    expect(res2.hookType).toBe('pass')
  })

  it('does not truncate when tool_input has no plan field to verify correspondence against', async () => {
    // Old (buggy) behavior truncated on marker presence alone, with no attempt to
    // confirm the post-marker text actually is this call's own approved plan.
    const output = 'User has approved your plan.\n\n## Approved Plan:\nSome plan body'
    const res = await runHook(buildEvent('post_tool_use', postPayload(output)))
    expect(res.hookType).toBe('pass')
  })

  it('does not truncate when the post-marker text does not correspond to tool_input.plan', async () => {
    const output = 'User has approved your plan.\n\n## Approved Plan:\nSome completely different text than what was approved'
    const res = await runHook(
      buildEvent('post_tool_use', postPayload(output, 'The actual approved plan has entirely unrelated content')),
    )
    expect(res.hookType).toBe('pass')
  })

  it('does not truncate real content that merely quotes the marker string as an example (unanchored indexOf trap)', async () => {
    // A plan describing this very hook can contain the literal marker string as
    // example text, with no actual plan-approval echo following it. The
    // unanchored `indexOf` alone would treat that as a truncation point; the
    // correspondence check against tool_input.plan must prevent that.
    const explanation =
      'This hook looks for the "## Approved Plan:" marker in tool output and truncates everything after it, replacing it with a short pointer.'
    const output = `User has approved your plan.\n\n${explanation}`
    const res = await runHook(
      buildEvent('post_tool_use', postPayload(output, 'An unrelated plan body that does not appear in this output at all')),
    )
    expect(res.hookType).toBe('pass')
  })
})
