// A `sed -n 'A,Bp'` read of lines an earlier line-range read was served is answered with "You already read lines A-B ... overlaps" only while the file still holds what it held when those lines were served. The Read tool's repeated-range check (hooks_read.ts) compares the file against what it was when the ranges were recorded and drops them once it moved; the Bash pre hook took the overlap straight off the recorded ranges, so after a change made outside the session (a formatter, a checkout, another process) a sed re-read of the changed lines was told to recall the old text from earlier output. Every call goes through relayInProcess, which loads and saves the session state around the handlers the way each real hook invocation does. Fixture provenance: the PreToolUse/PostToolUse Bash envelopes are FORMAT-DERIVED from the Claude Code hook input documentation (tests/fixtures/harness_hook_payloads.ts, row 'Bash command', CC_DOC); the Bash tool_response { stdout, stderr, interrupted, isImage, noOutputExpected } is the CAPTURE shape tests/hooks_real_harness_payload_shape.test.ts records; the ranged Read envelope is the CAPTURE shape tests/code_fold.test.ts's rangedEvent documents; the file contents, the sed commands and the outside edit are HAND-DERIVED.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { relayInProcess } from '../src/relay.js'

const LINE_COUNT = 120
const ORIGINAL = Array.from({ length: LINE_COUNT }, (_, i) => `export const v${i + 1} = ${i + 1}`)
const ALREADY_READ = /already read lines/i

let project: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  project = mkdtempSync(join(tmpdir(), 'tg-sed-reread-'))
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(project, { recursive: true, force: true })
})

function newSessionId(): string {
  seq += 1
  return `sed-reread-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

/** One Bash round trip through both hooks for a command that prints lines `start..end` of `file`, the post hook carrying those lines as they are on disk right now. Returns everything the pre hook emitted. The command names the file relative to the session's cwd: the read extractors exempt an absolute path under the temp dir (bash_extractors.ts isTempPath), so naming it whole would pass by never recording anything. */
async function shellRead(sid: string, command: string, file: string, start: number, end: number): Promise<string> {
  const base = { session_id: sid, cwd: project, permission_mode: 'default', tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${seq}_${start}_${end}_${Math.random().toString(36).slice(2, 8)}` }
  const emitted = await relayInProcess('pre_tool_use', { ...base, hook_event_name: 'PreToolUse' })
  const stdout = readFileSync(file, 'utf8').split('\n').slice(start - 1, end).join('\n') + '\n'
  await relayInProcess('post_tool_use', { ...base, hook_event_name: 'PostToolUse', tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })
  return emitted
}

const sedRead = (sid: string, file: string, start: number, end: number): Promise<string> => shellRead(sid, `sed -n '${start},${end}p' ${basename(file)}`, file, start, end)
const headRead = (sid: string, file: string, n: number): Promise<string> => shellRead(sid, `head -n ${n} ${basename(file)}`, file, 1, n)

/** One ranged Read round trip through both Read hooks. Returns the pre answer's deny reason, or null when the Read is let through. Claude Code's PreToolUse deny on the wire is { decision: 'block', reason }. */
async function rangedRead(sid: string, file: string, offset: number, limit: number): Promise<string | null> {
  const base = { session_id: sid, cwd: project, permission_mode: 'default', tool_name: 'Read', tool_input: { file_path: file, offset, limit }, tool_use_id: `toolu_read_${offset}_${limit}` }
  const pre = JSON.parse(await relayInProcess('pre_tool_use', { ...base, hook_event_name: 'PreToolUse' })) as { decision?: string; reason?: string }
  if (pre.decision === 'block') return pre.reason ?? ''
  const lines = readFileSync(file, 'utf8').split('\n')
  const window = lines.slice(offset - 1, offset - 1 + limit)
  const tool_response = { type: 'text', file: { filePath: file, content: window.join('\n'), numLines: window.length, startLine: offset, totalLines: lines.length } }
  await relayInProcess('post_tool_use', { ...base, hook_event_name: 'PostToolUse', tool_response })
  return null
}

/** An edit made outside the session: line `lineNo` is rewritten, and the mtime is moved on explicitly so the change never hides inside a coarse filesystem timestamp. */
function editOutsideSession(file: string, lineNo: number): void {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines[lineNo - 1] = `export const value${lineNo} = 'changed outside the session, and longer than before'`
  const before = statSync(file).mtimeMs
  writeFileSync(file, lines.join('\n'))
  const after = new Date(before + 5_000)
  utimesSync(file, after, after)
}

function makeFile(name: string): string {
  const file = join(project, name)
  writeFileSync(file, ORIGINAL.join('\n'))
  return file
}

describe.each(['app.ts', 'server.log'])('a sed re-read of %s', (name) => {
  it('is not told it overlaps lines already read once the file changed outside the session', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await sedRead(sid, file, 1, 20)).not.toMatch(ALREADY_READ)
    editOutsideSession(file, 5)
    expect(await sedRead(sid, file, 1, 20)).not.toMatch(ALREADY_READ)
  })

  it('is not told it overlaps lines a ranged Read served before the file changed', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await rangedRead(sid, file, 1, 20)).toBeNull()
    editOutsideSession(file, 5)
    expect(await sedRead(sid, file, 1, 20)).not.toMatch(ALREADY_READ)
  })

  it('is still told it overlaps when nothing changed (control)', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await sedRead(sid, file, 1, 20)).not.toMatch(ALREADY_READ)
    expect(await sedRead(sid, file, 1, 20)).toMatch(/already read lines 1-20 of/i)
  })
})

// Not server.log: extractHeadFile only answers for the source, doc and config extensions it lists, so a head of a .log is never recorded and its control could not pass.
describe.each(['app.ts', 'notes.txt'])('a head re-read of %s', (name) => {
  it('is not told it overlaps lines already read once the file changed outside the session', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await headRead(sid, file, 20)).not.toMatch(ALREADY_READ)
    editOutsideSession(file, 5)
    expect(await headRead(sid, file, 20)).not.toMatch(ALREADY_READ)
  })

  it('is still told it overlaps when nothing changed (control)', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await headRead(sid, file, 20)).not.toMatch(ALREADY_READ)
    expect(await headRead(sid, file, 20)).toMatch(/already read lines 1-20 of/i)
  })
})
