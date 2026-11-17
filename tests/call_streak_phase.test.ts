/** Call-streak in-flight phase (src/call_streak.ts): a read-only PreToolUse whose PostToolUse never arrives (a crashed or cancelled call) must not leave the agent "in flight" forever, and a call that is still inside the bound must keep counting as batched. Driven through the real relay with the clock pinned, so the injected time is the only time there is. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as streak from '../src/call_streak.js'
import { relayInProcess } from '../src/relay.js'

const BATCH_MARK = 'reads/searches in a row each waited a full turn'

// CAPTURE: epoch ms of the first Grep PreToolUse in C:/Users/<user>/AppData/Local/Temp/tg_capture/events_run1.jsonl, used only as a realistic starting instant.
const T0 = 1790231703231
// HAND-DERIVED: every step below is a multiple of a minute, chosen from the bound itself, never from the implementation's matcher.
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

let project: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

// CAPTURE: PreToolUse Grep envelope, events_run1.jsonl line 1 (session_id, cwd, pattern and tool_use_id substituted; transcript_path dropped).
function grepPre(sessionId: string, pattern: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd: project,
    prompt_id: 'a5d4b644-942c-4453-ad2e-8cb4ea1ca6cd',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse',
    tool_name: 'Grep',
    tool_use_id: `toolu_${pattern}`,
    tool_input: { pattern, path: 'src' },
  }
}

/** Three read-only pres, `step` ms apart, none of which is ever closed by a post: the third pre's context, which carries the batch hint only when all three counted as serial. */
async function thirdPreContext(step: number): Promise<string> {
  seq += 1
  const sessionId = `phase-${seq}-${Math.random().toString(36).slice(2, 10)}`
  let last = ''
  for (let i = 0; i < 3; i += 1) {
    vi.setSystemTime(T0 + i * step)
    last = await relayInProcess('pre_tool_use', grepPre(sessionId, `p${i}`))
  }
  return last
}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  process.env['CLAUDE_CODE_ENTRYPOINT'] = 'claude-vscode'
  project = mkdtempSync(join(tmpdir(), 'tg-call-streak-phase-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const alpha = 1\n')
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(project, { recursive: true, force: true })
})

describe('an unmatched read-only pre expires', () => {
  it('a pre whose post never came, followed a day later, counts as serial again', async () => {
    expect(await thirdPreContext(DAY)).toContain(BATCH_MARK)
  })

  it('a pre still inside the bound stays in flight, so the next call is batched with it', async () => {
    expect(await thirdPreContext(30_000)).not.toContain(BATCH_MARK)
  })

  it('the bound is generous: a false expiry costs more than a late one', () => {
    expect(streak.IN_FLIGHT_EXPIRY_MS).toBeGreaterThanOrEqual(5 * MINUTE)
  })

  it('one tick inside the bound is still in flight, one tick past it has expired', async () => {
    expect(await thirdPreContext(streak.IN_FLIGHT_EXPIRY_MS)).not.toContain(BATCH_MARK)
    expect(await thirdPreContext(streak.IN_FLIGHT_EXPIRY_MS + 1)).toContain(BATCH_MARK)
  })
})
