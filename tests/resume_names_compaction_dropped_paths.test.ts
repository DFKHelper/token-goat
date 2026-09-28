/** The resume packet names the files the compaction summary left out. postCompactHandler already searched the summary for every path the manifest printed, but only booked the count in the stats ledger, so the model coming out of a compaction was never told which files the summary forgot: the packet listed its top files read with no sign of which ones the summary still covered. Driven end to end: a real session is saved, the real postCompactHandler reads a summary, and the real buildResumePacket (what SessionStart(compact) injects and `token-goat resume` prints) is checked. PostCompact runs before SessionStart(compact) in Claude Code, which is what lets the second read what the first wrote. */
import { parse, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { postCompactHandler } from '../src/hooks_compact.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead } from '../src/session.js'
import { saveSessionState } from '../src/session_store.js'

// The git diff section is the only part of the packet that reads the working tree; stubbed so the real repository's state cannot leak into the packet under test.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, runGit: () => ({ exitCode: 1, stdout: '', stderr: '' }) }
})

const { buildResumePacket } = await import('../src/resume.js')

// A project-shaped absolute path outside the OS temp root, which the manifest filters out as noise. Nothing reads these files: the manifest and the packet only name them.
const ROOT = `${parse(tmpdir()).root.split(sep).join('/')}tg-resume-dropped-project`
const MARK = '(not in the compaction summary)'
let seq = 0

// FORMAT-DERIVED: the PostCompact hook input, as declared by the hook-input schema in Claude Code 2.1.284's bundled binary ({hook_event_name: "PostCompact", trigger: "manual"|"auto", compact_summary: string}); the same shape tests/hooks_post_compact.test.ts uses. The Codex form has no compact_summary at all (Codex CLI 0.155.0 post-compact input, cited in postCompactHandler).
function postCompact(sessionId: string, summary: string | undefined, agentId?: string): void {
  const raw: Record<string, unknown> = { session_id: sessionId, hook_event_name: 'PostCompact', trigger: 'auto' }
  if (summary !== undefined) raw['compact_summary'] = summary
  const event: HookEvent = { eventName: 'post_compact', toolName: undefined, toolInput: {}, sessionId, agentId, raw }
  postCompactHandler(event)
}

/** A saved session that read `names` once each, under a fresh id and folder so no case sees another's state. */
function sessionThatRead(names: string[]): { sid: string; paths: string[] } {
  seq += 1
  const sid = `resume-dropped-${seq}`
  const paths = names.map((n) => `${ROOT}/run-${seq}/${n}`)
  for (const p of paths) recordFileRead(p)
  saveSessionState(sid)
  return { sid, paths }
}

function lineFor(packet: string, file: string): string | undefined {
  return packet.split('\n').find((l) => l.startsWith('- ') && l.includes(file))
}

beforeEach(() => clearModuleCaches())
afterEach(() => clearModuleCaches())

describe('resume packet after a compaction', () => {
  it('marks the files the summary left out and leaves the ones it kept unmarked', async () => {
    const { sid, paths } = sessionThatRead(['kept_one.ts', 'lost_two.ts', 'lost_three.ts'])
    // HAND-DERIVED: a summary that names one of the three files and neither of the others.
    postCompact(sid, `Worked on ${paths[0]} and fixed the parser.`)

    const packet = (await buildResumePacket(sid)) ?? ''
    expect(lineFor(packet, 'kept_one.ts')).toBeDefined()
    expect(lineFor(packet, 'kept_one.ts')).not.toContain(MARK)
    expect(lineFor(packet, 'lost_two.ts')).toContain(MARK)
    expect(lineFor(packet, 'lost_three.ts')).toContain(MARK)
  })

  it('lists a left-out file the packet would not otherwise show', async () => {
    // HAND-DERIVED: ten files read once each; the packet shows eight under Top files read, so two are named nowhere else.
    const names = Array.from({ length: 10 }, (_, i) => `many_${String(i).padStart(2, '0')}.ts`)
    const { sid } = sessionThatRead(names)
    postCompact(sid, 'A summary that names no file at all.')

    const packet = (await buildResumePacket(sid)) ?? ''
    const [listed = '', extra = ''] = packet.split('## Also not in the compaction summary')
    const marked = names.filter((n) => lineFor(listed, n)?.includes(MARK) === true)
    const extraOnly = names.filter((n) => lineFor(listed, n) === undefined && lineFor(extra, n) !== undefined)
    expect(marked).toHaveLength(8)
    expect(extraOnly).toHaveLength(2)
  })

  it('drops the list when a later compaction carries no summary to check', async () => {
    const { sid } = sessionThatRead(['gone_later.ts'])
    postCompact(sid, 'nothing named')
    expect(lineFor((await buildResumePacket(sid)) ?? '', 'gone_later.ts')).toContain(MARK)

    postCompact(sid, undefined)
    expect(lineFor((await buildResumePacket(sid)) ?? '', 'gone_later.ts')).not.toContain(MARK)
  })

  it("a subagent's compaction does not rewrite the parent's list", async () => {
    const { sid, paths } = sessionThatRead(['parent_file.ts'])
    postCompact(sid, 'nothing named')
    postCompact(sid, `the child kept ${paths[0]}`, 'child-agent-1')
    expect(lineFor((await buildResumePacket(sid)) ?? '', 'parent_file.ts')).toContain(MARK)
  })
})
