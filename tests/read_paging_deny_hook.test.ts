/** The sequential-paging deny and notice of `preReadHandler` (hooks_read.ts, "Item 2.5"), driven through the hook entry point (`relayInProcess`) the way the harness runs it, not by calling the handler. The chain it judges is the slices already read PLUS the window being asked for now: three contiguous slices followed by a jump to a distant part of the file are not a paging chain, a third contiguous slice draws a notice, and a fourth is denied. A Read with an offset and no limit counts as the default window the line-range ledger books. Fixture provenance: the payload keys (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input` with `file_path`/`offset`/`limit`, `tool_response`) are FORMAT-DERIVED from the Claude Code hooks reference, https://code.claude.com/docs/en/hooks.md, not from our own hook_registry.ts; the Read `tool_response` mirrors tests/read_already_served_deny.test.ts. paged.ts is HAND-DERIVED: 700 generated `const vN = N` lines, no symbols that would make a window "inside a much larger symbol", sized so that no 100-line window is a whole file. The wire shapes asserted below (a deny is `decision: block` or `permissionDecision: deny`, a notice is `additionalContext`) were read off a run of the built bundle. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { relayInProcess } from '../src/relay.js'

const DENY_ONLY = 'Sequential line-range paging detected on '

let work: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

function isDeny(emitted: string): boolean {
  return /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/.test(emitted)
}

function uniq(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

function payload(phase: 'pre_tool_use' | 'post_tool_use', session: string, file: string, offset: number, limit: number | undefined): Record<string, unknown> {
  const toolInput: Record<string, unknown> = { file_path: path.join(work, file), offset }
  if (limit !== undefined) toolInput['limit'] = limit
  return {
    session_id: session,
    cwd: work,
    hook_event_name: phase === 'pre_tool_use' ? 'PreToolUse' : 'PostToolUse',
    tool_name: 'Read',
    tool_use_id: uniq('toolu'),
    tool_input: toolInput,
    ...(phase === 'post_tool_use' ? { tool_response: { content: 'ok' } } : {}),
  }
}

/** One Read as the harness runs it, returning the pre hook's wire answer. */
async function page(session: string, offset: number, limit?: number, file = 'paged.ts'): Promise<string> {
  const pre = await relayInProcess('pre_tool_use', payload('pre_tool_use', session, file, offset, limit))
  await relayInProcess('post_tool_use', payload('post_tool_use', session, file, offset, limit))
  return pre
}

beforeAll(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID', 'TOKEN_GOAT_QUIET_HOURS']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  // No quiet hours: quietContextOutput turns the notice into a pass during them, which would make the notice assertions vacuous.
  process.env['TOKEN_GOAT_QUIET_HOURS'] = ''
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-paging-'))
  const lines = Array.from({ length: 700 }, (_, i) => `const v${i + 1} = ${i + 1} // ${'p'.repeat(40)}`)
  fs.writeFileSync(path.join(work, 'paged.ts'), lines.join('\n') + '\n', 'utf8')
  fs.writeFileSync(path.join(work, 'tiny.ts'), '\n'.repeat(300), 'utf8')
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(work, { recursive: true, force: true })
})

describe('sequential paging deny through the pre-read hook', () => {
  it('denies the fourth contiguous slice, with the deny-only wording', async () => {
    const s = uniq('chain')
    await page(s, 1, 100)
    await page(s, 101, 100)
    await page(s, 201, 100)
    const fourth = await page(s, 301, 100)
    expect(isDeny(fourth)).toBe(true)
    expect(fourth).toContain(DENY_ONLY)
    expect(fourth).toContain('(4 slices read)')
  })

  it('only notes the third contiguous slice, without denying it', async () => {
    const s = uniq('note-chain')
    await page(s, 1, 100)
    await page(s, 101, 100)
    const third = await page(s, 201, 100)
    expect(isDeny(third)).toBe(false)
    expect(third).toContain('Sequential line-range paging detected (3 slices read)')
  })

  it('does not deny a distant jump after three contiguous slices', async () => {
    const s = uniq('jump')
    await page(s, 1, 100)
    await page(s, 101, 100)
    await page(s, 201, 100)
    const jump = await page(s, 601, 50)
    expect(isDeny(jump)).toBe(false)
    expect(jump).not.toContain(DENY_ONLY)
  })

  it('persists the range lock after a paging deny without post_tool_use', async () => {
    const s = uniq('locked-no-post')
    await page(s, 1, 100)
    await page(s, 101, 100)
    await page(s, 201, 100)
    const denied = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 301, 100))
    expect(isDeny(denied)).toBe(true)
    expect(denied).toContain(DENY_ONLY)
    expect(denied).toContain('token-goat read')
    expect(denied).not.toContain('explore agent')
    const shifted = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 306, 90))
    expect(isDeny(shifted)).toBe(true)
    expect(shifted).toContain('Line-range reads of this file are locked')
    expect(shifted).toContain('Do not retry with a different range.')
    const jump = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 601, 50))
    expect(isDeny(jump)).toBe(true)
    expect(jump).toContain('Line-range reads of this file are locked')
    for (let attempt = 0; attempt < 4; attempt++) {
      const retry = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 601, 50))
      expect(isDeny(retry)).toBe(true)
      expect(retry).toContain('Line-range reads of this file are locked')
    }
  })

  it('does not add the paging note to a distant jump after two contiguous slices', async () => {
    const s = uniq('note-jump')
    await page(s, 1, 100)
    await page(s, 101, 100)
    expect(await page(s, 601, 50)).not.toContain('Sequential line-range paging detected')
  })

  it('locks incremental same-anchor creep through the real hook path', async () => {
    const s = uniq('creep')
    expect(isDeny(await page(s, 1, 1))).toBe(false)
    const creep = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 1, 2))
    expect(isDeny(creep)).toBe(true)
    expect(creep).toContain('Line-range reads of this file are locked')
    const jump = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 601, 10))
    expect(isDeny(jump)).toBe(true)
  })

  it('allows three substantial same-anchor windows and locks the fourth through the relay', async () => {
    const s = uniq('expansion')
    for (const end of [40, 70, 100]) expect(isDeny(await page(s, 1, end))).toBe(false)
    const fourth = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 1, 130))
    expect(isDeny(fourth)).toBe(true)
    expect(fourth).toContain('Line-range reads of this file are locked')
  })

  it('locks a second-window backward overlap hunt through the relay', async () => {
    const s = uniq('overlap')
    expect(isDeny(await page(s, 415, 31))).toBe(false)
    const hunt = await relayInProcess('pre_tool_use', payload('pre_tool_use', s, 'paged.ts', 410, 16))
    expect(isDeny(hunt)).toBe(true)
    expect(hunt).toContain('Line-range reads of this file are locked')
  })

  it('notes the third and denies the fourth slice of a chain read by offset alone', async () => {
    // A Read with an offset and no limit is booked as the default window of 101 lines, so offsets 10, 90, 170, 250 are a contiguous chain. tiny.ts is 300 empty lines, under IDENTICAL_READ_MIN_BODY_BYTES, so the already-served check, which would otherwise withhold every offset-only read after the first (each returns the file to its end), has nothing recorded to match.
    const s = uniq('offset-only')
    await page(s, 10, undefined, 'tiny.ts')
    await page(s, 90, undefined, 'tiny.ts')
    const third = await page(s, 170, undefined, 'tiny.ts')
    expect(isDeny(third)).toBe(false)
    expect(third).toContain('Sequential line-range paging detected (3 slices read)')
    const fourth = await page(s, 250, undefined, 'tiny.ts')
    expect(isDeny(fourth)).toBe(true)
    expect(fourth).toContain(DENY_ONLY)
  })
})
