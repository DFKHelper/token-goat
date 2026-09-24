/** Call-streak advisories (src/call_streak.ts) driven through the real relay and the real handlers, so what is asserted is what a harness would receive: the batch hint on serial read-only calls, the zero-hit search brake, their resets and caps, their acted-on verdicts, and a denied call that never carries either line. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_BATCH_HINTS_PER_SESSION, MAX_SEARCH_BRAKES_PER_SESSION, SERIAL_GAP_MS } from '../src/call_streak.js'
import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { isHintCategory } from '../src/hint_stats.js'
import { relayInProcess } from '../src/relay.js'
import { sessionSidecarPath } from '../src/session_store.js'

const BATCH_MARK = 'reads/searches in a row each waited a full turn'
const BRAKE_MARK = 'searches in a row found nothing'
const BRAKE_LINE = '[token-goat] 3 searches in a row found nothing. Search by meaning instead of guessing literals: `token-goat answer "<question>"` or `token-goat semantic "<description>"`.'

// CAPTURE: Claude Code, C:/Users/zelys/AppData/Local/Temp/tg_capture/events_run1.jsonl. Three Greps issued in one assistant message ran pre,post,pre,post,pre,post at these epoch ms, then the next message's Grep pre came 2,442 ms after the previous post.
const T0 = 1790231703231
const CAPTURED_BATCH = [
  { pre: T0, post: T0 + 136 },
  { pre: T0 + 140, post: T0 + 271 },
  { pre: T0 + 457, post: T0 + 576 },
] as const
const CAPTURED_NEXT_TURN = { pre: T0 + 3018, post: T0 + 3150 } as const
const SERIAL_STEP = CAPTURED_NEXT_TURN.pre - CAPTURED_BATCH[2].post
const POST_AFTER = 136

interface Ctx {
  session_id: string
  prompt_id: string
  cwd: string
}

let project: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

function newSession(): Ctx {
  seq += 1
  // CAPTURE: prompt_id from events_run1.jsonl; the session id is unique per test so no two tests share a sidecar or ledger rows.
  return { session_id: `streak-${seq}-${Math.random().toString(36).slice(2, 10)}`, prompt_id: 'a5d4b644-942c-4453-ad2e-8cb4ea1ca6cd', cwd: project }
}

function base(ctx: Ctx, hookEventName: string, toolName: string, toolUseId: string): Record<string, unknown> {
  return { session_id: ctx.session_id, cwd: ctx.cwd, prompt_id: ctx.prompt_id, permission_mode: 'bypassPermissions', hook_event_name: hookEventName, tool_name: toolName, tool_use_id: toolUseId }
}

// CAPTURE: PreToolUse Grep, events_run1.jsonl line 1 (session_id, cwd, pattern and tool_use_id substituted; transcript_path dropped).
function grepPre(ctx: Ctx, pattern: string, path = 'src'): Record<string, unknown> {
  return { ...base(ctx, 'PreToolUse', 'Grep', `toolu_${pattern}`), tool_input: { pattern, path } }
}

// CAPTURE: PostToolUse Grep, events_run1.jsonl line 2 (one file matched) and line 8 (`delta`, nothing matched: `filenames: []`, `numFiles: 0`, `totalFiles: 0`).
function grepPost(ctx: Ctx, pattern: string, numFiles: number): Record<string, unknown> {
  const filenames = numFiles === 0 ? [] : ['src\\a.ts']
  return { ...base(ctx, 'PostToolUse', 'Grep', `toolu_${pattern}`), tool_input: { pattern, path: 'src' }, tool_response: { mode: 'files_with_matches', filenames, numFiles, totalFiles: numFiles }, duration_ms: 45 }
}

// CAPTURE: PreToolUse / PostToolUse Glob, events_run1.jsonl lines 13-14: nothing matched.
function globPre(ctx: Ctx): Record<string, unknown> {
  return { ...base(ctx, 'PreToolUse', 'Glob', 'toolu_glob'), tool_input: { pattern: 'src/*.py' } }
}
function globMissPost(ctx: Ctx): Record<string, unknown> {
  return { ...base(ctx, 'PostToolUse', 'Glob', 'toolu_glob'), tool_input: { pattern: 'src/*.py' }, tool_response: { filenames: [], durationMs: 31, numFiles: 0, truncated: false, totalMatches: 0, countIsComplete: true }, duration_ms: 31 }
}

// CAPTURE: the Bash PreToolUse / PostToolUseFailure envelope is events_run1.jsonl lines 11-12 (`is_interrupt`, `duration_ms`, `error`). The command and the bare `Exit code 1` error are CAPTURE too, from a real Claude Code transcript: C--Projects-coracrea-website/e2cc87d1-b0a9-4f05-b132-40438b48d4d6.jsonl, tool_use_id toolu_0114jG1aWgk9WPyd8ym3qjAL, one of 313 bare `Exit code 1` results in the local corpus.
const GREP_MISS_COMMAND = 'grep -n "isUsableInstant(action.ts)" scripts/lib/geo-bid-modifier-action.js'
function bashPre(ctx: Ctx, command: string): Record<string, unknown> {
  return { ...base(ctx, 'PreToolUse', 'Bash', 'toolu_bash'), tool_input: { command, description: 'Search' } }
}
function bashGrepMissFailure(ctx: Ctx, command = GREP_MISS_COMMAND): Record<string, unknown> {
  return { ...base(ctx, 'PostToolUseFailure', 'Bash', 'toolu_bash'), tool_input: { command, description: 'Search' }, error: 'Exit code 1', is_interrupt: false, duration_ms: 120 }
}

// FORMAT-DERIVED: Claude Code's Edit tool_input keys (`file_path`, `old_string`, `new_string`) as src/hooks_edit.ts reads them; call_streak.ts only looks at the tool name. The file sits under the OS temp dir so the Edit post handler neither queues a reindex nor starts a worker.
function editPre(ctx: Ctx): Record<string, unknown> {
  return { ...base(ctx, 'PreToolUse', 'Edit', 'toolu_edit'), tool_input: { file_path: join(project, 'src', 'a.ts'), old_string: 'alpha', new_string: 'alpha2' } }
}
function editPost(ctx: Ctx): Record<string, unknown> {
  return { ...editPre(ctx), hook_event_name: 'PostToolUse', tool_response: { filePath: join(project, 'src', 'a.ts'), oldString: 'alpha', newString: 'alpha2' } }
}

async function at(ms: number, eventName: string, payload: Record<string, unknown>): Promise<string> {
  vi.setSystemTime(ms)
  return relayInProcess(eventName, payload)
}

/** The text a harness would show the model for one hook answer, or '' when it adds none. */
function contextOf(emitted: string): string {
  const parsed = JSON.parse(emitted) as { hookSpecificOutput?: { additionalContext?: string } }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

/** One serial Grep round trip (pre at `t`, post shortly after); returns the pre's context and the time the next serial call would start. */
async function serialGrep(ctx: Ctx, t: number, pattern: string, numFiles = 1): Promise<{ pre: string; post: string; next: number }> {
  const pre = contextOf(await at(t, 'pre_tool_use', grepPre(ctx, pattern)))
  const post = contextOf(await at(t + POST_AFTER, 'post_tool_use', grepPost(ctx, pattern, numFiles)))
  return { pre, post, next: t + POST_AFTER + SERIAL_STEP }
}

async function edit(ctx: Ctx, t: number): Promise<number> {
  await at(t, 'pre_tool_use', editPre(ctx))
  await at(t + 50, 'post_tool_use', editPost(ctx))
  return t + 50 + SERIAL_STEP
}

function emissions(ctx: Ctx, category: string): Array<{ acted_on: number | null; resolved: number; observable: number }> {
  return getDb(globalDbPath()).prepare('SELECT acted_on, resolved, observable FROM hint_emissions WHERE session_id = ? AND category = ? ORDER BY id').all(ctx.session_id, category) as Array<{ acted_on: number | null; resolved: number; observable: number }>
}

beforeEach(() => {
  // No clearModuleCaches here: it empties the hook registry that relay.ts's imports filled once, and every handler (the deny, the failure handler, the dedup note) would silently stop running. The wire forms asserted here are Claude Code's; the relay also seeds CLAUDE_CODE_SESSION_ID, which is put back afterwards.
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  project = mkdtempSync(join(tmpdir(), 'tg-call-streak-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const alpha = 1\n')
})

afterEach(() => {
  vi.useRealTimers()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(project, { recursive: true, force: true })
})

describe('call streak through the real relay (clock pinned to captured timings)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  it('the captured gaps sit on either side of the threshold', () => {
    const sameMessage = CAPTURED_BATCH.slice(1).map((c, i) => c.pre - CAPTURED_BATCH[i]!.post)
    expect(sameMessage).toEqual([4, 186])
    expect(Math.max(...sameMessage)).toBeLessThan(SERIAL_GAP_MS)
    expect(SERIAL_STEP).toBe(2442)
    expect(SERIAL_STEP).toBeGreaterThan(SERIAL_GAP_MS)
  })

  it('three serial Greps get the batch hint on the third pre, and only there', async () => {
    const ctx = newSession()
    const first = await serialGrep(ctx, T0, 'alpha')
    const second = await serialGrep(ctx, first.next, 'beta')
    const third = await serialGrep(ctx, second.next, 'gamma')
    expect([first.pre, first.post, second.pre, second.post, third.post].join('')).not.toContain(BATCH_MARK)
    expect(third.pre).toBe('[token-goat] 3 reads/searches in a row each waited a full turn. Issue independent reads and searches together in one message.')
  })

  it('replaying the captured run (three Greps in one message, then one more) never hints', async () => {
    const ctx = newSession()
    const seen: string[] = []
    for (const [i, c] of CAPTURED_BATCH.entries()) {
      seen.push(contextOf(await at(c.pre, 'pre_tool_use', grepPre(ctx, `p${i}`))))
      seen.push(contextOf(await at(c.post, 'post_tool_use', grepPost(ctx, `p${i}`, 1))))
    }
    seen.push(contextOf(await at(CAPTURED_NEXT_TURN.pre, 'pre_tool_use', grepPre(ctx, 'delta'))))
    seen.push(contextOf(await at(CAPTURED_NEXT_TURN.post, 'post_tool_use', grepPost(ctx, 'delta', 0))))
    expect(seen.join('\n')).not.toContain(BATCH_MARK)
  })

  it('a call issued while another read is still in flight counts as batched, not serial', async () => {
    const ctx = newSession()
    const t = (await serialGrep(ctx, T0, 'a')).next
    await at(t, 'pre_tool_use', grepPre(ctx, 'b'))
    // b's post has not arrived (calls run concurrently, or an async-detached post has not written yet), so c went out with b even though a's post is far behind.
    expect(contextOf(await at(t + SERIAL_STEP, 'pre_tool_use', grepPre(ctx, 'c')))).not.toContain(BATCH_MARK)
  })

  it('an Edit between serial reads starts the run over', async () => {
    const ctx = newSession()
    let t = (await serialGrep(ctx, T0, 'a')).next
    t = (await serialGrep(ctx, t, 'b')).next
    t = await edit(ctx, t)
    const afterEdit = await serialGrep(ctx, t, 'c')
    expect(afterEdit.pre).not.toContain(BATCH_MARK)
    const next = await serialGrep(ctx, afterEdit.next, 'd')
    const third = await serialGrep(ctx, next.next, 'e')
    expect(next.pre).not.toContain(BATCH_MARK)
    expect(third.pre, 'the count resumes from the Edit, so the third read after it hints').toContain(BATCH_MARK)
  })

  it('a new user prompt starts the run over', async () => {
    const ctx = newSession()
    let t = (await serialGrep(ctx, T0, 'a')).next
    t = (await serialGrep(ctx, t, 'b')).next
    const nextPrompt = { ...ctx, prompt_id: 'second-prompt' }
    expect((await serialGrep(nextPrompt, t, 'c')).pre).not.toContain(BATCH_MARK)
  })

  it('speaks once per run and at most MAX_BATCH_HINTS_PER_SESSION times per session', async () => {
    const ctx = newSession()
    let t = T0
    let shown = 0
    for (let run = 0; run < MAX_BATCH_HINTS_PER_SESSION + 1; run += 1) {
      const lines: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const r = await serialGrep(ctx, t, `r${run}c${i}`)
        lines.push(r.pre, r.post)
        t = r.next
      }
      const count = lines.filter((l) => l.includes(BATCH_MARK)).length
      expect(count, `run ${run}: one line per run at most`).toBeLessThanOrEqual(1)
      shown += count
      t = await edit(ctx, t)
    }
    expect(shown).toBe(MAX_BATCH_HINTS_PER_SESSION)
  })

  it('a denied call carries no line and does not count: the next serial read is the one that hints', async () => {
    const ctx = newSession()
    let t = (await serialGrep(ctx, T0, 'a')).next
    t = (await serialGrep(ctx, t, 'b')).next
    // HAND-DERIVED: preReadHandlerInner (src/hooks_read.ts) denies a Grep whose path is under node_modules.
    const denied = await at(t, 'pre_tool_use', grepPre(ctx, 'c', join(project, 'node_modules', 'left-pad')))
    const parsed = JSON.parse(denied) as { decision?: string; reason?: string }
    expect(parsed.decision, 'the trigger must really be a deny, or this proves nothing').toBe('block')
    expect(denied).not.toContain(BATCH_MARK)
    expect(denied).not.toContain(BRAKE_MARK)
    t += SERIAL_STEP
    expect((await serialGrep(ctx, t, 'd')).pre).toContain(BATCH_MARK)
  })

  it('Grep, Glob and a Bash grep that exits 1 (via the failure handler) make three misses and get the brake on the third', async () => {
    const ctx = newSession()
    const t = T0
    const outs: string[] = []
    outs.push(contextOf(await at(t, 'pre_tool_use', grepPre(ctx, 'delta'))))
    outs.push(contextOf(await at(t + 130, 'post_tool_use', grepPost(ctx, 'delta', 0))))
    outs.push(contextOf(await at(t + 134, 'pre_tool_use', globPre(ctx))))
    outs.push(contextOf(await at(t + 250, 'post_tool_use', globMissPost(ctx))))
    outs.push(contextOf(await at(t + 254, 'pre_tool_use', bashPre(ctx, GREP_MISS_COMMAND))))
    expect(outs.join('\n')).not.toContain(BRAKE_MARK)
    const failure = await at(t + 380, 'post_tool_use_failure', bashGrepMissFailure(ctx))
    expect(contextOf(failure)).toBe(BRAKE_LINE)
  })

  it('counts a Bash grep the pre-hook wrapped in token-goat compress, whose failure arrives carrying the wrapper', async () => {
    const ctx = newSession()
    const t = T0
    await at(t, 'pre_tool_use', grepPre(ctx, 'delta'))
    await at(t + 130, 'post_tool_use', grepPost(ctx, 'delta', 0))
    await at(t + 134, 'pre_tool_use', globPre(ctx))
    await at(t + 250, 'post_tool_use', globMissPost(ctx))
    const pre = JSON.parse(await at(t + 254, 'pre_tool_use', bashPre(ctx, GREP_MISS_COMMAND))) as { hookSpecificOutput?: { updatedInput?: { command?: string } } }
    const wrapped = pre.hookSpecificOutput?.updatedInput?.command
    expect(wrapped, 'the pre-hook must really rewrite the grep, or this proves nothing').toMatch(/^token-goat compress /)
    // FORMAT-DERIVED: the post event carries the command that ran, which is the wrapper: postBashHandler (src/hooks_bash.ts) unwraps it for the same reason. `token-goat compress` exits 1 with a bare newline on no match (dogfooded against the built bundle), which is Claude Code's bare `Exit code 1`.
    const failure = await at(t + 380, 'post_tool_use_failure', bashGrepMissFailure(ctx, wrapped))
    expect(contextOf(failure)).toBe(BRAKE_LINE)
  })

  it('a search that finds something resets the miss count', async () => {
    const ctx = newSession()
    let t = T0
    const outs: string[] = []
    for (const [pattern, hits] of [['m1', 0], ['m2', 0], ['h1', 1], ['m3', 0], ['m4', 0]] as const) {
      const r = await serialGrep(ctx, t, pattern, hits)
      outs.push(r.pre, r.post)
      t = r.next
    }
    expect(outs.join('\n')).not.toContain(BRAKE_MARK)
    expect((await serialGrep(ctx, t, 'm5', 0)).post).toContain(BRAKE_MARK)
  })

  it('a content-mode Grep that matched counts as a hit even though its numFiles is 0', async () => {
    const ctx = newSession()
    let t = (await serialGrep(ctx, T0, 'm1', 0)).next
    t = (await serialGrep(ctx, t, 'm2', 0)).next
    await at(t, 'pre_tool_use', grepPre(ctx, 'hit'))
    // FORMAT-DERIVED: Claude Code transcript `toolUseResult` for a content-mode Grep, whose `numFiles` stays 0 while `numLines` counts the matched lines.
    const contentHit = { ...base(ctx, 'PostToolUse', 'Grep', 'toolu_hit'), tool_input: { pattern: 'hit', path: 'src', output_mode: 'content' }, tool_response: { mode: 'content', numFiles: 0, filenames: [], content: 'src/a.ts:1:export const alpha = 1', numLines: 1 } }
    expect(contextOf(await at(t + POST_AFTER, 'post_tool_use', contentHit)), 'counted as a third miss').not.toContain(BRAKE_MARK)
    t += POST_AFTER + SERIAL_STEP
    expect((await serialGrep(ctx, t, 'm3', 0)).post).not.toContain(BRAKE_MARK)
  })

  it('the brake speaks at most MAX_SEARCH_BRAKES_PER_SESSION times per session', async () => {
    const ctx = newSession()
    let t = T0
    let shown = 0
    for (let streak = 0; streak < MAX_SEARCH_BRAKES_PER_SESSION + 1; streak += 1) {
      for (let i = 0; i < 4; i += 1) {
        const r = await serialGrep(ctx, t, `s${streak}m${i}`, 0)
        if (r.post.includes(BRAKE_MARK)) shown += 1
        t = r.next
      }
      t = (await serialGrep(ctx, t, `s${streak}hit`, 1)).next
    }
    expect(shown).toBe(MAX_SEARCH_BRAKES_PER_SESSION)
  })

  it('scores the batch hint acted on when the next turn batches its reads, and not when it stays serial', async () => {
    const acted = newSession()
    let t = T0
    for (const p of ['a', 'b', 'c']) t = (await serialGrep(acted, t, p)).next
    expect(emissions(acted, 'read_batch')).toEqual([{ acted_on: 0, resolved: 0, observable: 1 }])
    // CAPTURE timing: the next turn issues two Greps together, 4 ms apart.
    await at(t, 'pre_tool_use', grepPre(acted, 'd'))
    await at(t + POST_AFTER, 'post_tool_use', grepPost(acted, 'd', 1))
    await at(t + POST_AFTER + 4, 'pre_tool_use', grepPre(acted, 'e'))
    expect(emissions(acted, 'read_batch')).toEqual([{ acted_on: 1, resolved: 1, observable: 1 }])

    const ignored = newSession()
    let u = T0
    for (const p of ['a', 'b', 'c', 'd', 'e']) u = (await serialGrep(ignored, u, p)).next
    expect(emissions(ignored, 'read_batch')).toEqual([{ acted_on: 0, resolved: 1, observable: 1 }])
  })

  it('does not judge the batch hint on calls issued in the same message it was attached to', async () => {
    const ctx = newSession()
    let t = T0
    for (const p of ['a', 'b']) t = (await serialGrep(ctx, t, p)).next
    await at(t, 'pre_tool_use', grepPre(ctx, 'c'))
    await at(t + POST_AFTER, 'post_tool_use', grepPost(ctx, 'c', 1))
    // Batched with the hinted call: sent before the model could have read the hint.
    await at(t + POST_AFTER + 4, 'pre_tool_use', grepPre(ctx, 'd'))
    await at(t + POST_AFTER + 130, 'post_tool_use', grepPost(ctx, 'd', 1))
    expect(emissions(ctx, 'read_batch')).toEqual([{ acted_on: 0, resolved: 0, observable: 1 }])
    // The next turn opens with one read and batches the one after it: that turn, not d's, is the one judged.
    const next = t + POST_AFTER + 130 + SERIAL_STEP
    await at(next, 'pre_tool_use', grepPre(ctx, 'e'))
    expect(emissions(ctx, 'read_batch')).toEqual([{ acted_on: 0, resolved: 0, observable: 1 }])
    await at(next + 4, 'pre_tool_use', grepPre(ctx, 'f'))
    expect(emissions(ctx, 'read_batch')).toEqual([{ acted_on: 1, resolved: 1, observable: 1 }])
  })

  it('settles only the emitting agent\'s own batch hint, though a subagent shares its parent\'s session_id', async () => {
    const ctx = newSession()
    // FORMAT-DERIVED: `agent_id` is the payload field relay.ts buildEvent reads for a call made inside a subagent; the value is a real agentId from a CAPTURE transcript head (tests/hooks_bash.test.ts CAPTURED_TRANSCRIPT_HEAD).
    const asSubagent = (payload: Record<string, unknown>): Record<string, unknown> => ({ ...payload, agent_id: 'a2af08af400178684' })
    let t = T0
    for (const p of ['a', 'b', 'c']) t = (await serialGrep(ctx, t, p)).next
    for (const p of ['a', 'b', 'c']) {
      await at(t, 'pre_tool_use', asSubagent(grepPre(ctx, p)))
      await at(t + POST_AFTER, 'post_tool_use', asSubagent(grepPost(ctx, p, 1)))
      t += POST_AFTER + SERIAL_STEP
    }
    const pending = { acted_on: 0, resolved: 0, observable: 1 }
    expect(emissions(ctx, 'read_batch')).toEqual([pending, pending])
    // The subagent's next turn batches two Greps, so its own hint was heeded; the parent has not made a call since its hint.
    await at(t, 'pre_tool_use', asSubagent(grepPre(ctx, 'd')))
    await at(t + POST_AFTER, 'post_tool_use', asSubagent(grepPost(ctx, 'd', 1)))
    await at(t + POST_AFTER + 4, 'pre_tool_use', asSubagent(grepPre(ctx, 'e')))
    expect(emissions(ctx, 'read_batch')).toEqual([pending, { acted_on: 1, resolved: 1, observable: 1 }])
  })

  it('scores the brake acted on when the next search is token-goat answer, and not when it is another Grep', async () => {
    const acted = newSession()
    let t = T0
    for (const p of ['m1', 'm2', 'm3']) t = (await serialGrep(acted, t, p, 0)).next
    expect(emissions(acted, 'search_brake')).toEqual([{ acted_on: 0, resolved: 0, observable: 1 }])
    await at(t, 'pre_tool_use', bashPre(acted, 'token-goat answer "where is the batch hint decided"'))
    expect(emissions(acted, 'search_brake')).toEqual([{ acted_on: 1, resolved: 1, observable: 1 }])

    const ignored = newSession()
    let u = T0
    for (const p of ['m1', 'm2', 'm3', 'm4']) u = (await serialGrep(ignored, u, p, 0)).next
    expect(emissions(ignored, 'search_brake')).toEqual([{ acted_on: 0, resolved: 1, observable: 1 }])
  })

  it('logs the Grep dedup note as an unobservable grep_dedup_hint emission', async () => {
    const ctx = newSession()
    // FORMAT-DERIVED: content-mode Grep `toolUseResult` shape as above; the dedup handler counts the lines of `content`, and six clears the default grep_dedup_min_matches of 5.
    const content = Array.from({ length: 6 }, (_, i) => `src/a.ts:${i + 1}:alpha`).join('\n')
    const input = { pattern: 'alpha', path: 'src', output_mode: 'content' }
    await at(T0, 'pre_tool_use', { ...base(ctx, 'PreToolUse', 'Grep', 'toolu_d1'), tool_input: input })
    await at(T0 + POST_AFTER, 'post_tool_use', { ...base(ctx, 'PostToolUse', 'Grep', 'toolu_d1'), tool_input: input, tool_response: { mode: 'content', numFiles: 0, filenames: [], content, numLines: 6 } })
    const repeat = contextOf(await at(T0 + POST_AFTER + SERIAL_STEP, 'pre_tool_use', { ...base(ctx, 'PreToolUse', 'Grep', 'toolu_d2'), tool_input: input }))
    expect(repeat, 'the trigger must really produce the dedup note').toContain('an identical Grep for')
    expect(emissions(ctx, 'grep_dedup_hint')).toEqual([{ acted_on: 0, resolved: 1, observable: 0 }])
  })
})

describe('call streak on the shipping clock', () => {
  it('stamps the real wall clock and treats back-to-back calls as batched', async () => {
    const ctx = newSession()
    const before = Date.now()
    const outs: string[] = []
    for (const p of ['a', 'b', 'c']) {
      outs.push(contextOf(await relayInProcess('pre_tool_use', grepPre(ctx, p))))
      outs.push(contextOf(await relayInProcess('post_tool_use', grepPost(ctx, p, 1))))
    }
    const after = Date.now()
    expect(outs.join('\n')).not.toContain(BATCH_MARK)
    const target = sessionSidecarPath(ctx.session_id, '.call-streak')
    expect(target).not.toBeNull()
    const state = JSON.parse(readFileSync(target!, 'utf8')) as { lastReadPostAt: number; serialRun: number }
    expect(state.lastReadPostAt).toBeGreaterThanOrEqual(before)
    expect(state.lastReadPostAt).toBeLessThanOrEqual(after)
    expect(state.serialRun).toBe(0)
  })
})

describe('hint categories', () => {
  it('knows the two streak categories and the two dedup categories', () => {
    for (const c of ['read_batch', 'search_brake', 'grep_dedup_hint', 'glob_dedup_hint']) expect(isHintCategory(c)).toBe(true)
  })
})
