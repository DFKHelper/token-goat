/** A compaction resets the dedup state of the subagents of its session, not just the main thread's. PreCompact fires on the main thread without an `agent_id`, so the stamp landed on the parent's state file while a subagent's served-lines, line-range, CLI-read and repeat-deny state kept withholding output the model no longer had. Fixture provenance: `agent_id` and `agent_type` are FORMAT-DERIVED from the Claude Code hooks reference (HookEvent.agentId). The stamp landing on the parent key is CAPTURE (live session state files from a run with five subagent compactions: the parent carried compactedAt, the `_agent_` file carried null with fileLineRanges and fileServedOutputs still populated). big.txt is HAND-DERIVED: 200 rows of 'row N: the quick brown fox ...', each over 60 bytes so a 40-row slice clears the 512-byte elision floor. The PreCompact payload keys are FORMAT-DERIVED from the same reference. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { relayInProcess } from '../src/relay.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

const NOTICE = 'were already served verbatim in this session'
const ALREADY_RAN = 'You already ran this exact'

let home: string
let work: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

function uniq(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

function row(n: number): string {
  return `row ${n}: the quick brown fox jumps over the lazy dog ${'x'.repeat(30)}`
}

function slice(lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(row(n))
  return out.join('\n')
}

/** One hook call through the built bundle, the way the harness shim runs it. */
function hook(event: string, payload: Record<string, unknown>): string {
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', event, '--harness', 'claudecode'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: work,
    env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1' }),
  })
  return res.stdout ?? ''
}

function agentFields(agent: boolean): Record<string, unknown> {
  return agent ? { agent_id: 'a1', agent_type: 'general-purpose' } : {}
}

function postSed(session: string, agent: boolean, hi: number): string {
  const command = `sed -n 1,${hi}p big.txt`
  return hook('post_tool_use', {
    session_id: session,
    transcript_path: path.join(work, 't.jsonl'),
    cwd: work,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: uniq('toolu'),
    tool_input: { command },
    tool_response: { stdout: slice(1, hi) + '\n', stderr: '', exitCode: 0 },
    ...agentFields(agent),
  })
}

function preCompact(session: string): string {
  return hook('pre_compact', { session_id: session, transcript_path: path.join(work, 't.jsonl'), cwd: work, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' })
}

function preCli(session: string, agent: boolean, command: string): string {
  return hook('pre_tool_use', {
    session_id: session,
    transcript_path: path.join(work, 't.jsonl'),
    cwd: work,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: uniq('toolu'),
    tool_input: { command },
    ...agentFields(agent),
  })
}

/** The subagent's own state file: `<session>_agent_<digest of the agent id>.json`, the stem session_store.ts::sessionFileStem gives a `<sid>:agent:<id>` key. */
function agentStateFile(session: string): string {
  const dir = path.join(home, 'sessions')
  const hit = fs.readdirSync(dir).find((name) => name.startsWith(`${session}_agent_`) && name.endsWith('.json'))
  if (hit === undefined) throw new Error('no subagent state file for ' + session)
  return path.join(dir, hit)
}

/** A finished `token-goat read` the way the harness reports it, which is what records the CLI read. */
function postCli(session: string, agent: boolean, command: string): string {
  return hook('post_tool_use', {
    session_id: session,
    transcript_path: path.join(work, 't.jsonl'),
    cwd: work,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: uniq('toolu'),
    tool_input: { command },
    tool_response: { stdout: 'export function sym(): number {\n  return 1\n}\n', stderr: '', exitCode: 0 },
    ...agentFields(agent),
  })
}

beforeAll(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-epoch-home-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-epoch-work-'))
  fs.writeFileSync(path.join(work, 'big.txt'), slice(1, 200) + '\n', 'utf8')
  fs.writeFileSync(path.join(work, 'f.ts'), 'export function sym(): number {\n  return 1\n}\n', 'utf8')
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(work, { recursive: true, force: true })
})

describe('a compaction resets subagent dedup state (built bundle)', () => {
  it('(a) precondition: a repeated sed read as a subagent withholds the overlap', () => {
    const s = uniq('a')
    postSed(s, true, 40)
    expect(postSed(s, true, 60)).toContain(NOTICE)
  })

  it('(b) after a main-thread compaction the subagent repeat read is no longer withheld', () => {
    const s = uniq('b')
    postSed(s, true, 40)
    preCompact(s)
    expect(postSed(s, true, 60)).not.toContain(NOTICE)
  })

  it('(c) the subagent state file carries the sidecar epoch once it has loaded state after a compaction', () => {
    const s = uniq('c')
    postSed(s, true, 40)
    preCompact(s)
    const sidecar = fs.readFileSync(path.join(home, 'sessions', `${s}.compacted-at`), 'utf8').trim()
    expect(Number(sidecar)).toBeGreaterThan(0)
    postSed(s, true, 60)
    const state = JSON.parse(fs.readFileSync(agentStateFile(s), 'utf8')) as { compactedAt?: number }
    expect(String(state.compactedAt)).toBe(sidecar)
  })

  it('(d) a compaction in another session leaves the subagent still withholding', () => {
    const s = uniq('d')
    postSed(s, true, 40)
    preCompact(uniq('d-other'))
    expect(postSed(s, true, 60)).toContain(NOTICE)
  })

  it('(e) control: the main thread resets the same way', () => {
    const s = uniq('e')
    postSed(s, false, 40)
    expect(postSed(s, false, 60)).toContain(NOTICE)
    preCompact(s)
    expect(postSed(s, false, 60)).not.toContain(NOTICE)
  })

  it.each([false, true])('(f) a CLI read repeated after a compaction carries no already-ran note (agent=%s)', (agent) => {
    const s = uniq('f')
    const cmd = "token-goat read 'f.ts::sym'"
    postCli(s, agent, cmd)
    expect(preCli(s, agent, cmd)).toContain(ALREADY_RAN)
    preCompact(s)
    expect(preCli(s, agent, cmd)).not.toContain(ALREADY_RAN)
  })
})

describe('a compaction resets the repeat-deny key of a subagent (in-process relay)', () => {
  const guide = (): string => {
    const filler = 'Section prose that pads this fixture past the size floors the gated sites apply. '.repeat(20)
    return '## Install\n\n' + filler + '\n\n## Usage\n\n' + filler + '\n'
  }

  it('(g) the second deny is the short form, and the third after a compaction is full again', async () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    const guidePath = path.join(work, 'guide.md')
    fs.writeFileSync(guidePath, guide(), 'utf8')
    const s = uniq('g')
    const pre = (): Record<string, unknown> => ({ session_id: s, cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: uniq('toolu'), tool_input: { command: 'cat guide.md', description: 'Read' }, agent_id: 'a1', agent_type: 'general-purpose' })
    const reasonOf = (emitted: string): string => (JSON.parse(emitted) as { reason?: string }).reason ?? ''
    const first = reasonOf(await relayInProcess('pre_tool_use', pre()))
    const second = reasonOf(await relayInProcess('pre_tool_use', pre()))
    expect(first).toContain('`cat` loads the entire file into context.')
    expect(second).toContain('Repeat refusal of this exact call')
    await relayInProcess('pre_compact', { session_id: s, cwd: work, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' })
    const third = reasonOf(await relayInProcess('pre_tool_use', pre()))
    expect(third).toContain('`cat` loads the entire file into context.')
    expect(third).not.toContain('Repeat refusal of this exact call')
  })
})
