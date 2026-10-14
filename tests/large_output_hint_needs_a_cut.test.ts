/** The large-output advisory used to fire on any uncompressed output of 4 KB or more: `[tg] Output was 5KB uncompressed; token-goat bash-output <id> recalls it, and token-goat compress -c "..." compresses the next run.` CAPTURE (recorded sessions): 80 emissions, 0 recalls of the id and 0 compress runs, because the output had already reached the model whole and most commands never ran again. It was also outside hint tracking, so hint-stats could neither score it nor back it off. Now the recall pointer needs the harness to have cut the output, the compress suggestion needs the command to have produced a large output before in the session, and both go through hint tracking as `bash_large_output`. Fixture provenance: HAND-DERIVED. Each line is distinct letters, no digits, so neither the consecutive nor the numeric-run dedupe can fold it. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES } from '../src/delivery_cap.js'
import type { HookEvent } from '../src/hook_registry.js'
import { categoryStats, resolvePendingHintsForEvent } from '../src/hint_stats.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { makeHookEvent } from './helpers/hook-event.js'

/** A build piped to tail: the pipe keeps the pre hook from wrapping it, and a build is cached rather than run through the generic compound compressor, whose ~2,000-token cap would rewrite any output this large before the advisory is reached. Named per test, because the output cache outlives a session and a second run of one command anywhere draws the rerun delta instead. */
const build = (name: string): string => `cargo build -p ${name} 2>&1 | tail -n 400`

/** A letters-only word for `n`, so no two lines differ only in their digits. */
function word(n: number): string {
  let s = ''
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s
  return s
}

/** At least `bytes` of output in lines of about `width` chars. */
function report(bytes: number, width: number): string {
  const out: string[] = []
  for (let i = 0, size = 0; size < bytes; i++) {
    let line = `row ${word(i)}:`
    for (let j = 1; line.length < width; j++) line += ' ' + word(i * 31 + j * 7)
    out.push(line)
    size += line.length + 1
  }
  return out.join('\n') + '\n'
}

function event(sessionId: string, command: string, stdout: string, extra: Record<string, unknown> = {}): HookEvent {
  const toolResponse = { stdout, stderr: '', interrupted: false, isImage: false, ...extra }
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: toolResponse },
  })
}

const sid = (name: string): string => `large-hint-${name}-${Math.random().toString(36).slice(2)}`
const context = (r: Awaited<ReturnType<typeof postBashHandler>>): string => (r.hookType === 'context' ? r.context : '')
const PERSISTED = { persistedOutputPath: 'C:/nowhere/tool-results/abc.txt', persistedOutputSize: 5200 }

describe('the large uncompressed output advisory', () => {
  let savedHarness: string | undefined
  beforeEach(() => {
    savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
  })

  it('says nothing about a 5 KB first run, which reached the model whole', async () => {
    const s = sid('small')
    const result = await postBashHandler(event(s, build('small'), report(5 * 1024, 100)))
    expect(result.hookType).toBe('pass')
    expect(categoryStats('bash_large_output', s)).toMatchObject({ emitted: 0, pending: 0, unobservable: 0, detected: 0 })
  })

  it('points a 40 KB output, which the harness cut, at its recall id, and hint-stats scores the recall', async () => {
    const s = sid('big')
    const stdout = report(40 * 1024, 270)
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES)
    const hint = context(await postBashHandler(event(s, build('big'), stdout)))
    const id = /`token-goat bash-output ([0-9a-f]{16})` recalls it\./.exec(hint)?.[1]
    expect(id, hint).toBeDefined()
    expect(hint).not.toContain('compress -c')
    expect(categoryStats('bash_large_output', s)).toMatchObject({ pending: 1 })
    const command = `token-goat bash-output ${id} --full`
    resolvePendingHintsForEvent(
      makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: s, agentId: undefined, raw: { tool_name: 'Bash', tool_input: { command } } }),
    )
    expect(categoryStats('bash_large_output', s)).toMatchObject({ emitted: 1, actedOn: 1, pending: 0 })
  })

  it('takes a persisted result as cut whatever its size, on any harness', async () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'
    const hint = context(await postBashHandler(event(sid('persisted'), build('persisted'), report(5 * 1024, 100), PERSISTED)))
    expect(hint).toMatch(/`token-goat bash-output [0-9a-f]{16}` recalls it\./)
  })

  it('suggests compress -c once the command has produced a large output before, and only once', async () => {
    const s = sid('repeat')
    const cmd = build('repeat')
    const stdout = report(5 * 1024, 100)
    expect((await postBashHandler(event(s, cmd, stdout))).hookType).toBe('pass')
    const hint = context(await postBashHandler(event(s, cmd, stdout)))
    expect(hint).toContain(`\`token-goat compress -c "${cmd}"\` compresses the next run.`)
    expect(hint).not.toContain('bash-output')
    expect(categoryStats('bash_large_output', s)).toMatchObject({ pending: 1 })
    expect((await postBashHandler(event(s, cmd, stdout))).hookType).toBe('pass')
  })

  it('offers both when a repeated command is also cut', async () => {
    const s = sid('both')
    const cmd = build('both')
    const stdout = report(5 * 1024, 100)
    await postBashHandler(event(s, cmd, stdout))
    const hint = context(await postBashHandler(event(s, cmd, stdout, PERSISTED)))
    expect(hint).toMatch(/`token-goat bash-output [0-9a-f]{16}` recalls it, and /)
    expect(hint).toContain(`recalls it, and \`token-goat compress -c "${cmd}"\` compresses the next run.`)
  })
})
