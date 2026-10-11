/** A subagent's served-output and line-range ledgers are its own, and that isolation comes from the state key alone: every hook call loads and saves the session state under `sessionStateKey(event)`, which salts a subagent's key with its `agent_id` (hook_registry.ts). These tests drive the hook entry point (`relayInProcess`), the way the harness does, so a ledger that only looked isolated because a test called a handler twice in one process cannot pass. Fixture provenance: the payload keys (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `agent_id`, `agent_type`) are FORMAT-DERIVED from the Claude Code hooks reference, https://code.claude.com/docs/en/hooks.md, and the subagent fields `agent_id` and `agent_type` from the tg-captures C4a-013 capture of a real subagent hook payload (cited at src/hooks_agent_spawn.ts:583), not from our own hook_registry.ts; the Read `tool_response` mirrors tests/read_already_served_deny.test.ts, whose post hook stores what it reads back from disk. The files are HAND-DERIVED: generated line text sized past the shared IDENTICAL_READ_MIN_BODY_BYTES floor, asserted below rather than assumed. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { relayInProcess } from '../src/relay.js'
import { IDENTICAL_READ_MIN_BODY_BYTES } from '../src/util.js'

let home: string
let work: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

function uniq(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

function row(n: number): string {
  return `line ${n}: ledger isolation ${'q'.repeat(60)}`
}

function rows(lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(row(n))
  return out.join('\n')
}

type Phase = 'pre_tool_use' | 'post_tool_use'

function payload(phase: Phase, session: string, agent: string | undefined, toolName: string, toolInput: Record<string, unknown>, response?: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: session,
    cwd: work,
    hook_event_name: phase === 'pre_tool_use' ? 'PreToolUse' : 'PostToolUse',
    tool_name: toolName,
    tool_use_id: uniq('toolu'),
    tool_input: toolInput,
    ...(response === undefined ? {} : { tool_response: response }),
    ...(agent === undefined ? {} : { agent_id: agent, agent_type: 'general-purpose' }),
  }
}

async function readPre(session: string, agent: string | undefined, file: string, offset?: number, limit?: number): Promise<string> {
  const input: Record<string, unknown> = { file_path: path.join(work, file) }
  if (offset !== undefined) input['offset'] = offset
  if (limit !== undefined) input['limit'] = limit
  return relayInProcess('pre_tool_use', payload('pre_tool_use', session, agent, 'Read', input))
}

async function readPost(session: string, agent: string | undefined, file: string, offset?: number, limit?: number): Promise<string> {
  const input: Record<string, unknown> = { file_path: path.join(work, file) }
  if (offset !== undefined) input['offset'] = offset
  if (limit !== undefined) input['limit'] = limit
  return relayInProcess('post_tool_use', payload('post_tool_use', session, agent, 'Read', input, { content: 'ok' }))
}

/** One complete Read as the harness runs it: the pre hook, then the post hook that stores what was handed over. Returns the pre hook's answer. */
async function deliver(session: string, agent: string | undefined, file: string, offset?: number, limit?: number): Promise<string> {
  const pre = await readPre(session, agent, file, offset, limit)
  await readPost(session, agent, file, offset, limit)
  return pre
}

function bashPre(session: string, agent: string | undefined, command: string): Promise<string> {
  return relayInProcess('pre_tool_use', payload('pre_tool_use', session, agent, 'Bash', { command }))
}

function bashPost(session: string, agent: string | undefined, command: string, stdout: string): Promise<string> {
  return relayInProcess('post_tool_use', payload('post_tool_use', session, agent, 'Bash', { command }, { stdout, stderr: '', exitCode: 0 }))
}

function isDeny(emitted: string): boolean {
  return /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/.test(emitted)
}

/** The persisted session state of one (sub)agent: the main thread's is `<session>.json`, a subagent's is `<session>_agent_<digest>.json` (session_store.ts::sessionFileStem). */
function stateOf(session: string, agent: boolean): { fileLineRanges?: Array<[string, Array<[number, number]>]> } {
  const dir = path.join(home, 'sessions')
  const name = fs.readdirSync(dir).find((n) => (agent ? n.startsWith(`${session}_agent_`) : n === `${session}.json`) && n.endsWith('.json'))
  if (name === undefined) throw new Error('no state file for ' + session)
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { fileLineRanges?: Array<[string, Array<[number, number]>]> }
}

function rangesFor(state: { fileLineRanges?: Array<[string, Array<[number, number]>]> }, file: string): Array<[number, number]> {
  const needle = file.toLowerCase()
  return (state.fileLineRanges ?? []).filter(([key]) => key.toLowerCase().endsWith(needle)).flatMap(([, r]) => r)
}

beforeAll(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  const configured = process.env['TOKEN_GOAT_HOME']
  if (configured === undefined || configured === '') throw new Error('tests/setup/isolate-home.ts must have pointed TOKEN_GOAT_HOME at a temp directory')
  home = configured
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ledger-iso-'))
  fs.writeFileSync(path.join(work, 'iso.ts'), rows(0, 39) + '\n', 'utf8')
  fs.writeFileSync(path.join(work, 'edit.ts'), rows(0, 39) + '\n', 'utf8')
  fs.writeFileSync(path.join(work, 'bash.ts'), rows(0, 39) + '\n', 'utf8')
  expect(fs.statSync(path.join(work, 'iso.ts')).size).toBeGreaterThan(IDENTICAL_READ_MIN_BODY_BYTES)
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(work, { recursive: true, force: true })
})

describe('subagent read ledgers through the hook entry point', () => {
  it('keeps the parent, each subagent, and a sibling subagent apart, and still denies a repeat within one of them', async () => {
    const s = uniq('iso')
    // The parent was served lines 1..10.
    await deliver(s, undefined, 'iso.ts', 1, 10)
    expect(isDeny(await readPre(s, undefined, 'iso.ts', 1, 10))).toBe(true)

    // A subagent never saw the parent's context, so its first read of the same window is not a repeat.
    expect(isDeny(await deliver(s, 'worker-1', 'iso.ts', 1, 10))).toBe(false)
    // ...but its second one is.
    expect(isDeny(await readPre(s, 'worker-1', 'iso.ts', 1, 10))).toBe(true)

    // A sibling has a ledger of its own.
    expect(isDeny(await readPre(s, 'worker-2', 'iso.ts', 1, 10))).toBe(false)
  })

  it('drops a subagent\'s own line ranges when that subagent edits the file', async () => {
    const s = uniq('edit')
    await deliver(s, 'worker-1', 'edit.ts', 1, 10)
    expect(rangesFor(stateOf(s, true), 'edit.ts')).toEqual([[1, 10]])

    const file = path.join(work, 'edit.ts')
    fs.writeFileSync(file, rows(0, 39).replace('line 3:', 'line 3 edited:') + '\n', 'utf8')
    await relayInProcess('post_tool_use', payload('post_tool_use', s, 'worker-1', 'Edit', { file_path: file, old_string: 'line 3:', new_string: 'line 3 edited:' }, { filePath: file, success: true }))

    expect(rangesFor(stateOf(s, true), 'edit.ts')).toEqual([])
  })

  it('keeps the session-wide cap of 32 served shell outputs for a subagent, not the per-file cap of 8', async () => {
    const s = uniq('generic')
    for (let n = 0; n < 12; n++) {
      const command = `./report-${n}`
      const body = Array.from({ length: 30 }, (_, i) => `report ${n} entry ${i}: ${'z'.repeat(40)}`).join('\n') + '\n'
      await bashPost(s, 'worker-1', command, body)
    }
    const dir = path.join(home, 'sessions')
    const name = fs.readdirSync(dir).find((n) => n.startsWith(`${s}_agent_`) && n.endsWith('.json'))
    if (name === undefined) throw new Error('no subagent state file')
    const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { fileServedOutputs?: Array<[string, string[]]> }
    const generic = (state.fileServedOutputs ?? []).find(([key]) => key.includes('<bash-generic-served>'))
    expect(generic?.[1].length).toBe(12)
  })

  it('remembers the lines a subagent\'s own shell read showed, for its next sed read of them', async () => {
    const s = uniq('bash')
    // `head -n N` is recorded by the post hook alone (recordBashFileReadsForSessionCache), so this is the path where the range is written after the fact.
    await bashPost(s, 'worker-1', 'head -n 20 bash.ts', rows(0, 19) + '\n')

    const sed = 'sed -n 1,20p bash.ts'
    expect(await bashPre(s, 'worker-1', sed)).toContain('already')
    // A sibling subagent never saw those lines.
    expect(await bashPre(s, 'worker-2', sed)).not.toContain('already')
  })
})
