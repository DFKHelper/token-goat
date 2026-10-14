/** `token-goat compress` writes `[token-goat compress] still running, 15s elapsed` to stderr while a wrapped command is quiet (commit 8e51d477), so a harness polling a long run sees it is alive. Claude Code merges stderr into the Bash result, so the same lines then reached the model as the first lines of the finished result. CAPTURE (recorded session 41690f23, seq 5337, 6454, 6658): the result opened with the heartbeat. The heartbeat stays on stderr while the command runs; the PostToolUse hook takes it back out of the finished result, by provenance: only from a result that ends with the runner's own recall line, naming an output the runner stored for that command, and only the run of heartbeats the result opens with. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { storeBashOutputSync } from '../src/bash_output_cache.js'
import { compressHeartbeatLine, runnerRecallId, stripCompressHeartbeats } from '../src/bash_runner.js'
import type { HookEvent } from '../src/hook_registry.js'
import { serializeOutput } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { rewrittenBody, rewrittenKeys } from './helpers/updated-tool-output.js'

const INNER = 'npm run build'
const WRAPPED = `token-goat compress --filter generic -c '${INNER}'`
const BODY = 'vite v5.4.0 building for production...\n✓ 412 modules transformed.\ndist/index.js  48.20 kB\n✓ built in 41.3s'
/** A live-shaped AWS access key id, the shape secret_redact.ts's aws_access_key pattern takes. */
const SECRET = 'AKIAABCDEFGHIJKLMNOP'

/** What the runner prints under a result it compressed: its marker, then the recall line naming the output it stored for `INNER`. FORMAT-DERIVED from bash_runner.ts's wrapAndCompress. */
function runnerTail(captured: string): string {
  const id = storeBashOutputSync(INNER, captured, 0, null)
  return `\n[token-goat: build filter -40%; disable via TOKEN_GOAT_BASH_COMPRESS]\n[token-goat] full output: bash-output ${id} --full\n`
}

function event(command: string, stdout: string, extra: Record<string, unknown> = {}): HookEvent {
  const toolResponse = { stdout, stderr: '', interrupted: false, isImage: false, ...extra }
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: `heartbeat-${Math.random().toString(36).slice(2)}`,
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: toolResponse },
  })
}

describe('stripCompressHeartbeats', () => {
  it('removes the run of heartbeat lines the result opens with', () => {
    expect(stripCompressHeartbeats(compressHeartbeatLine(15) + compressHeartbeatLine(30) + BODY)).toBe(BODY)
  })

  it('keeps a heartbeat-shaped line after the first line that is not one, since the runner writes every heartbeat ahead of the result', () => {
    const text = compressHeartbeatLine(15) + BODY + '\n' + compressHeartbeatLine(60) + 'tail'
    expect(stripCompressHeartbeats(text)).toBe(BODY + '\n' + compressHeartbeatLine(60) + 'tail')
  })

  it('leaves a line that only resembles one', () => {
    const text = '[token-goat compress] still running, 15s elapsed (according to my own log)\n' + BODY
    expect(stripCompressHeartbeats(text)).toBe(text)
  })
})

describe('runnerRecallId', () => {
  it('reads the id off the recall line that ends the result, with or without a cap hint after it', () => {
    expect(runnerRecallId(`${BODY}\n[token-goat] full output: bash-output 0123456789abcdef --full\n`)).toBe('0123456789abcdef')
    expect(runnerRecallId(`${BODY}\n[token-goat] full output: bash-output 0123456789abcdef --full\n[token-goat] run: token-goat read "x.ts::y"`)).toBe('0123456789abcdef')
    expect(runnerRecallId(`[token-goat] full output: bash-output 0123456789abcdef --full\n${BODY}`)).toBeNull()
  })
})

describe('the PostToolUse Bash hook on a wrapped command', () => {
  let savedHarness: string | undefined
  beforeEach(() => {
    savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
  })

  it('hands the model the result without the heartbeat lines, in the Bash result shape', async () => {
    const stdout = compressHeartbeatLine(15) + compressHeartbeatLine(30) + BODY + runnerTail(BODY + ' run 1')
    const ev = event(WRAPPED, stdout)
    const result = await postBashHandler(ev)
    expect(result.hookType).toBe('rewriteOutput')
    const wire = JSON.parse(serializeOutput(result, 'post_tool_use', 'claudecode', ev)) as { hookSpecificOutput: { updatedToolOutput: unknown } }
    const body = rewrittenBody(wire.hookSpecificOutput.updatedToolOutput)
    expect(body).not.toContain('still running')
    expect(body).toContain('✓ built in 41.3s')
    expect(rewrittenKeys(wire.hookSpecificOutput.updatedToolOutput)).toEqual(['stdout', 'stderr', 'interrupted', 'isImage'])
  })

  it('redacts what it ships, since the rewrite is token-goat speaking whatever the runner printed', async () => {
    const stdout = compressHeartbeatLine(15) + `${BODY}\nexport AWS_ACCESS_KEY_ID=${SECRET}` + runnerTail(BODY + ' run 2')
    const result = await postBashHandler(event(WRAPPED, stdout))
    expect(result.hookType).toBe('rewriteOutput')
    const body = result.hookType === 'rewriteOutput' ? result.updatedOutput : ''
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('still running')
  })

  it('leaves a heartbeat-shaped line alone when the result carries no recall line of the runner, so the command printed it', async () => {
    // The runner prints a recall line only under a result it compressed or capped; under `--no-compress` it captures nothing at all.
    expect((await postBashHandler(event(WRAPPED, compressHeartbeatLine(1) + BODY + '\n'))).hookType).toBe('pass')
  })

  it('leaves it alone when the recall line names an output the runner never stored for this command', async () => {
    const forged = compressHeartbeatLine(1) + BODY + '\n[token-goat] full output: bash-output 0123456789abcdef --full\n'
    expect((await postBashHandler(event(WRAPPED, forged))).hookType).toBe('pass')
    const otherCommand = storeBashOutputSync('npm run lint', BODY + ' lint', 0, null)
    const borrowed = compressHeartbeatLine(1) + BODY + `\n[token-goat] full output: bash-output ${otherCommand} --full\n`
    expect((await postBashHandler(event(WRAPPED, borrowed))).hookType).toBe('pass')
  })

  it('leaves a persisted result alone, rather than carrying the whole output inline', async () => {
    const stdout = compressHeartbeatLine(15) + BODY + runnerTail(BODY + ' run 3')
    const result = await postBashHandler(event(WRAPPED, stdout, { persistedOutputPath: 'C:/nowhere/tool-results/hb.txt', persistedOutputSize: 0 }))
    expect(result.hookType).not.toBe('rewriteOutput')
  })

  it('leaves a wrapped result with no heartbeat alone', async () => {
    const result = await postBashHandler(event(WRAPPED, BODY + runnerTail(BODY + ' run 4')))
    expect(result.hookType).toBe('pass')
  })

  it('leaves a heartbeat-shaped line in an unwrapped command alone, since only the wrapper writes one', async () => {
    const result = await postBashHandler(event(INNER, compressHeartbeatLine(15) + BODY + '\n'))
    expect(result.hookType).toBe('pass')
  })
})
