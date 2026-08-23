/**
 * `waste` accounts for harness-injected context off the same pass it already makes.
 *
 * The injected classes -- task lists, slash-expanded skill bodies, compaction boundaries -- arrive
 * on transcript lines that carry no `message` field, and `parseTranscript` skips those on its first
 * gate. That is precisely why this cost went unreported: the parser walked straight past it. These
 * tests pin that the accounting happens on the existing walk, that it lands in the report, and that
 * it does not disturb the tool-call ledger it shares a loop with.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildWasteReport, parseTranscript } from '../src/waste.js'

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-waste-resident-'))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeTranscript(lines: unknown[]): string {
  const file = path.join(tempDir, 'session.jsonl')
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  return file
}

function taskReminderLine(completed: number, pending: number, descriptionSize: number): unknown {
  const items = [
    ...Array.from({ length: completed }, (_, i) => ({ id: `c${i}`, description: 'd'.repeat(descriptionSize), status: 'completed' })),
    ...Array.from({ length: pending }, (_, i) => ({ id: `p${i}`, description: 'p'.repeat(descriptionSize), status: 'pending' })),
  ]
  return { type: 'attachment', attachment: { type: 'task_reminder', itemCount: items.length, content: items } }
}

function toolUseLine(id: string, name: string, input: unknown): unknown {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

function toolResultLine(toolUseId: string, text: string): unknown {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }
}

describe('parseTranscript accounts for injected context on its existing pass', () => {
  it('counts attachment lines, which carry no `message` and are skipped by the tool-call parser', () => {
    const transcript = writeTranscript([
      taskReminderLine(3, 1, 100),
      { type: 'system', subtype: 'compact_boundary' },
      { attachment: { type: 'file', content: 'x'.repeat(400) } },
    ])

    const { calls, resident } = parseTranscript(transcript)

    // Nothing here is a tool call, so the pre-existing ledger is correctly empty ...
    expect(calls).toEqual([])
    // ... and yet the pass saw all of it.
    expect(resident.taskReminderCount).toBe(1)
    expect(resident.compactionCount).toBe(1)
    expect(resident.latestTaskList?.completed).toBe(3)
    expect([...resident.attachmentsByType.keys()].sort()).toEqual(['file', 'task_reminder'])
  })

  it('does not disturb the tool-call ledger it shares a loop with', () => {
    const withInjections = writeTranscript([
      toolUseLine('t1', 'Read', { file_path: '/repo/foo.ts' }),
      taskReminderLine(3, 1, 100),
      toolResultLine('t1', 'file contents here'),
      { type: 'system', subtype: 'compact_boundary' },
    ])

    const { calls, resultTextById, resident } = parseTranscript(withInjections)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ seq: 0, id: 't1', name: 'Read', filePath: '/repo/foo.ts' })
    expect(resultTextById.get('t1')).toBe('file contents here')
    expect(resident.taskReminderCount).toBe(1)
  })
})

describe('buildWasteReport surfaces the injected-context summary', () => {
  it('carries the task list, compactions and attachment classes into the report', async () => {
    const transcript = writeTranscript([
      taskReminderLine(40, 4, 900),
      taskReminderLine(41, 3, 900),
      { type: 'system', subtype: 'compact_boundary' },
    ])

    const report = await buildWasteReport(transcript)

    expect(report.residentContext.taskReminderCount).toBe(2)
    expect(report.residentContext.compactionCount).toBe(1)
    // The newest list is the one still worth acting on.
    expect(report.residentContext.latestTaskList?.completed).toBe(41)
    expect(report.residentContext.totalAttachmentBytes).toBeGreaterThan(0)
  })

  it('reports empty rather than absent for a transcript with no injected context', async () => {
    const transcript = writeTranscript([toolUseLine('t1', 'Read', { file_path: '/repo/foo.ts' }), toolResultLine('t1', 'body')])

    const report = await buildWasteReport(transcript)

    expect(report.residentContext.attachmentClasses).toEqual([])
    expect(report.residentContext.latestTaskList).toBeNull()
    expect(report.residentContext.repeatedSkillBodies).toEqual([])
    expect(report.residentContext.compactionCount).toBe(0)
  })
})
