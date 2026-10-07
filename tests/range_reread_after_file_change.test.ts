// A ranged Read of lines the session was served before is refused as "Lines A..B of F was already read this session" only while F still holds what it held when those lines were served. hooks_read.ts checks that against a whole-file snapshot (doc and diffable-source files) or a size+mtime identity (everything else), and every later read of F rewrites both, so a read of a different window after an outside edit made them describe the edited file while the old range still stood: the original window was then refused although the model had only ever seen its old text. The same refusal had a second route: the reset hooks_read.ts makes when an overlapping re-read finds the file changed was undone by session_store.ts's merge whenever that hook call went on to record its own window, since the merge only counts a file's ranges as cleared when the key is gone. Every call here goes through relayInProcess, which loads and saves the session state around the handlers the way each real hook invocation does; an in-memory-only test cannot see the second route. Fixture provenance: the PreToolUse Read payload is FORMAT-DERIVED from the Claude Code hook input documentation (tests/fixtures/harness_hook_payloads.ts, row 'Read of a project file', CC_DOC) plus the Read tool's offset/limit keys; the ranged PostToolUse tool_response envelope { type, file: { filePath, content, numLines, startLine, totalLines } } is the CAPTURE shape tests/code_fold.test.ts's rangedEvent documents from 798 real ranged Read results; the file contents and the outside edit are HAND-DERIVED.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { relayInProcess } from '../src/relay.js'

// Short lines on purpose: a window stays under IDENTICAL_READ_MIN_BODY_BYTES (512), so the byte-for-byte served-output proof never answers and every refusal here comes from the line-range check this file is about.
const LINE_COUNT = 120
const ORIGINAL = Array.from({ length: LINE_COUNT }, (_, i) => `export const v${i + 1} = ${i + 1}`)

let project: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  project = mkdtempSync(join(tmpdir(), 'tg-range-reread-'))
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
  return `range-reread-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

function base(sid: string, hookEventName: string, file: string, offset: number, limit: number): Record<string, unknown> {
  return { session_id: sid, cwd: project, permission_mode: 'default', hook_event_name: hookEventName, tool_name: 'Read', tool_input: { file_path: file, offset, limit }, tool_use_id: `toolu_${offset}_${limit}` }
}

/** The deny reason a pre_tool_use answer carries in Claude Code's wire form ({ decision: 'block', reason }), or null when the Read is let through. */
function denyReason(emitted: string): string | null {
  const parsed = JSON.parse(emitted) as { decision?: string; reason?: string }
  return parsed.decision === 'block' ? (parsed.reason ?? '') : null
}

/** One ranged Read round trip: pre_tool_use, and when it is let through, the post_tool_use carrying the window the Read tool would deliver from disk right now. Returns the pre answer's deny reason. */
async function rangedRead(sid: string, file: string, offset: number, limit: number): Promise<string | null> {
  const reason = denyReason(await relayInProcess('pre_tool_use', base(sid, 'PreToolUse', file, offset, limit)))
  if (reason !== null) return reason
  const lines = readFileSync(file, 'utf8').split('\n')
  const window = lines.slice(offset - 1, offset - 1 + limit)
  const tool_response = { type: 'text', file: { filePath: file, content: window.join('\n'), numLines: window.length, startLine: offset, totalLines: lines.length } }
  await relayInProcess('post_tool_use', { ...base(sid, 'PostToolUse', file, offset, limit), tool_response })
  return null
}

/** An edit made outside the session (another process, the user's editor): line `lineNo` is rewritten, and the mtime is moved on explicitly so the change never hides inside a coarse filesystem timestamp. */
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

// .ts is a diffable source (serve_diff_on_reread defaults on), so the repeated-range check consults the whole-file snapshot; .log is not, so it falls back to the size+mtime identity.
describe.each(['app.ts', 'server.log'])('a repeated ranged Read of %s after an outside edit', (name) => {
  it('is let through when a different window was read after the edit', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await rangedRead(sid, file, 1, 20)).toBeNull()
    editOutsideSession(file, 5)
    expect(await rangedRead(sid, file, 60, 20)).toBeNull()
    // Lines 1..20 now hold an edited line 5 the model has never been shown.
    expect(await rangedRead(sid, file, 1, 20)).toBeNull()
  })

  it('is let through again after an overlapping re-read already found the edit', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await rangedRead(sid, file, 10, 21)).toBeNull()
    editOutsideSession(file, 12)
    // Overlaps the recorded 10..30 without covering line 12, so it is the only part of the edited file the model sees.
    expect(await rangedRead(sid, file, 15, 11)).toBeNull()
    expect(await rangedRead(sid, file, 10, 21)).toBeNull()
  })

  it('is still refused when nothing changed (control)', async () => {
    const sid = newSessionId()
    const file = makeFile(name)
    expect(await rangedRead(sid, file, 1, 20)).toBeNull()
    expect(await rangedRead(sid, file, 60, 20)).toBeNull()
    const reason = await rangedRead(sid, file, 1, 20)
    expect(reason).toContain('Lines 1..20 of this file were already read this session')
  })
})
