/**
 * Covers the resident-context classifier: the harness-injected context that no hook can intercept
 * but every transcript records.
 *
 * The shapes asserted here were read off real transcripts under `~/.claude/projects/<slug>/*.jsonl`
 * rather than from documentation, because none exists. Two of them are the specific things a
 * plausible-looking implementation gets wrong, so both have a dedicated test:
 *
 * - the injected-context key is `attachment`, singular. Reading `attachments` finds nothing at all
 *   and reports a clean zero, which is indistinguishable from a session that genuinely injected
 *   nothing.
 * - a compaction is `{type:'system', subtype:'compact_boundary'}`. Counting `SessionStart` hook
 *   firings instead also counts plain session resumes, which inflates the figure silently.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  LARGE_SKILL_BODY_BYTES,
  LARGE_TASK_LIST_BYTES,
  accumulateResidentLine,
  accumulateResidentLines,
  createResidentContextStats,
  formatBytes,
  formatTokenEstimate,
  lineMayCarryResidentSignal,
  readTranscriptTail,
  repeatedSkillBodyHint,
  skillNameFromBody,
  summarizeResidentContext,
  taskListPruneHint,
  type TaskListSnapshot,
} from '../src/resident_context.js'
import { estimateTokens, estimateTokensFromLength } from '../src/overflow_guard.js'

const tempFiles: string[] = []

afterEach(() => {
  while (tempFiles.length > 0) {
    const file = tempFiles.pop()
    if (file !== undefined) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Already gone.
      }
    }
  }
})

function tempTranscript(contents: string): string {
  const file = path.join(os.tmpdir(), `tg-resident-${process.pid}-${Math.random().toString(36).slice(2, 10)}.jsonl`)
  fs.writeFileSync(file, contents, 'utf8')
  tempFiles.push(file)
  return file
}

function taskItem(id: string, status: string, description: string): Record<string, unknown> {
  return { id, subject: `subject ${id}`, description, activeForm: 'doing', status, owner: 'main', blocks: [], blockedBy: [] }
}

/** A `task_reminder` line as the harness writes it, with `attachment` singular. */
function taskReminderLine(items: Array<Record<string, unknown>>, itemCount?: number): string {
  return JSON.stringify({
    type: 'attachment',
    attachment: { type: 'task_reminder', itemCount: itemCount ?? items.length, content: items },
  })
}

function fold(lines: string[]): ReturnType<typeof summarizeResidentContext> {
  return summarizeResidentContext(accumulateResidentLines(lines))
}

describe('attachment accounting', () => {
  it('reads the singular `attachment` key the harness actually writes', () => {
    const summary = fold([taskReminderLine([taskItem('1', 'completed', 'done')])])

    expect(summary.taskReminderCount).toBe(1)
    expect(summary.attachmentClasses.map((c) => c.type)).toEqual(['task_reminder'])
  })

  it('counts nothing for the plural `attachments` spelling, which is not the harness shape', () => {
    // The counterpart to the test above. Without it, an implementation reading the wrong key still
    // passes every "reports zero on an empty transcript" assertion.
    const summary = fold([
      JSON.stringify({ type: 'attachment', attachments: [{ type: 'task_reminder', itemCount: 9, content: [] }] }),
    ])

    expect(summary.taskReminderCount).toBe(0)
    expect(summary.attachmentClasses).toEqual([])
  })

  it('rolls every attachment class up by count and bytes, largest first', () => {
    const summary = fold([
      JSON.stringify({ attachment: { type: 'file', content: 'x'.repeat(500) } }),
      JSON.stringify({ attachment: { type: 'file', content: 'x'.repeat(500) } }),
      JSON.stringify({ attachment: { type: 'queued_command', prompt: 'y' } }),
    ])

    expect(summary.attachmentClasses.map((c) => [c.type, c.count])).toEqual([
      ['file', 2],
      ['queued_command', 1],
    ])
    const file = summary.attachmentClasses[0]
    expect(file?.bytes).toBeGreaterThan(1000)
    expect(summary.totalAttachmentBytes).toBe(summary.attachmentClasses.reduce((n, c) => n + c.bytes, 0))
  })

  it('labels an attachment with no type rather than dropping it', () => {
    const summary = fold([JSON.stringify({ attachment: { content: 'x' } })])

    expect(summary.attachmentClasses.map((c) => c.type)).toEqual(['unknown'])
  })
})

describe('task list snapshots', () => {
  it('splits items by status and measures the prunable description bytes', () => {
    const summary = fold([
      taskReminderLine([
        taskItem('1', 'completed', 'a'.repeat(100)),
        taskItem('2', 'completed', 'b'.repeat(200)),
        taskItem('3', 'in_progress', 'c'.repeat(50)),
        taskItem('4', 'pending', 'd'.repeat(25)),
      ]),
    ])

    const task = summary.latestTaskList
    expect(task).not.toBeNull()
    expect(task?.itemCount).toBe(4)
    expect(task?.completed).toBe(2)
    expect(task?.inProgress).toBe(1)
    expect(task?.pending).toBe(1)
    expect(task?.descriptionBytes).toBe(375)
    // The actionable half: what pruning completed items would actually reclaim.
    expect(task?.completedDescriptionBytes).toBe(300)
  })

  it('keeps the most recent list, not the first or the largest', () => {
    const summary = fold([
      taskReminderLine([taskItem('1', 'completed', 'x'.repeat(400)), taskItem('2', 'completed', 'x')]),
      taskReminderLine([taskItem('1', 'pending', 'y')]),
    ])

    expect(summary.taskReminderCount).toBe(2)
    expect(summary.latestTaskList?.itemCount).toBe(1)
    expect(summary.latestTaskList?.pending).toBe(1)
    // Cumulative bytes still span both injections, since both were paid for.
    expect(summary.taskReminderBytes).toBeGreaterThan(summary.latestTaskList?.bytes ?? 0)
  })

  it('prefers the walked item count when it exceeds the harness figure', () => {
    // A stale or wrong `itemCount` must not under-report a list that is demonstrably longer.
    const summary = fold([taskReminderLine([taskItem('1', 'pending', 'a'), taskItem('2', 'pending', 'b')], 1)])

    expect(summary.latestTaskList?.itemCount).toBe(2)
  })

  it('survives a task_reminder whose content is missing or the wrong type', () => {
    const summary = fold([
      JSON.stringify({ attachment: { type: 'task_reminder', itemCount: 5 } }),
      JSON.stringify({ attachment: { type: 'task_reminder', itemCount: 3, content: 'not-an-array' } }),
      JSON.stringify({ attachment: { type: 'task_reminder', content: [null, 7, { status: 'completed' }] } }),
    ])

    expect(summary.taskReminderCount).toBe(3)
    expect(summary.latestTaskList?.completed).toBe(1)
    expect(summary.latestTaskList?.descriptionBytes).toBe(0)
  })
})

describe('compaction counting', () => {
  it('counts the compact_boundary system marker', () => {
    const summary = fold([
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    ])

    expect(summary.compactionCount).toBe(2)
  })

  it('does not count a SessionStart hook firing, which also fires on a plain resume', () => {
    // The discriminating case: a session that resumed twice and never compacted must report zero.
    const summary = fold([
      JSON.stringify({ attachment: { type: 'hook_success', hookEvent: 'SessionStart', command: 'token-goat hook session_start' } }),
      JSON.stringify({ attachment: { type: 'hook_success', hookEvent: 'SessionStart', command: 'token-goat hook session_start' } }),
    ])

    expect(summary.compactionCount).toBe(0)
  })

  it('does not count another system subtype', () => {
    const summary = fold([JSON.stringify({ type: 'system', subtype: 'turn_duration' })])

    expect(summary.compactionCount).toBe(0)
  })
})

describe('slash-expanded skill bodies', () => {
  const body = (name: string, size: number): string =>
    `Base directory for this skill: C:\\Users\\someone\\.claude\\skills\\${name}\n\n# ${name} (Claude Skill)\n\n${'x'.repeat(size)}`

  function metaLine(text: string): string {
    return JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  it('names the skill from its base directory, which is what the user types after the slash', () => {
    expect(skillNameFromBody(body('superman', 10))).toBe('superman')
  })

  it('falls back to the H1 when there is no base-directory preamble', () => {
    expect(skillNameFromBody('# LLM Council\n\nbody text')).toBe('LLM Council')
  })

  it('returns null for text that is neither', () => {
    expect(skillNameFromBody('just some prompt text with no heading')).toBeNull()
  })

  it('attributes repeated injections per skill', () => {
    const summary = fold([
      metaLine(body('superman', LARGE_SKILL_BODY_BYTES)),
      metaLine(body('superman', LARGE_SKILL_BODY_BYTES)),
      metaLine(body('council', LARGE_SKILL_BODY_BYTES)),
    ])

    // council appeared once, so it is not a repeat and is not reported.
    expect(summary.repeatedSkillBodies.map((s) => [s.skill, s.count])).toEqual([['superman', 2]])
    expect(summary.repeatedSkillBodies[0]?.bytes).toBeGreaterThan(2 * LARGE_SKILL_BODY_BYTES)
  })

  it('aggregates the Skill-tool channel with the slash-expansion channel, under one name', () => {
    // A skill body arrives two ways. Counting only slash expansion under-reported `superman` by
    // roughly 3x on a real transcript (94 invoked_skills injections against 12 isMeta ones), so a
    // repeat that spans both channels must aggregate rather than split into two labels.
    const invoked = (entries: Array<Record<string, unknown>>): string =>
      JSON.stringify({ type: 'attachment', attachment: { type: 'invoked_skills', skills: entries } })
    const content = 'S'.repeat(LARGE_SKILL_BODY_BYTES)

    const summary = fold([
      metaLine(body('superman', LARGE_SKILL_BODY_BYTES)),
      invoked([{ name: 'superman', path: '/home/u/.claude/skills/superman', content }]),
      // No `name` field: the name has to come from the last path segment, and it has to match the
      // spelling the other two channels produced or this lands as a third, separate skill.
      invoked([{ path: 'C:\\Users\\u\\.claude\\skills\\superman', content }]),
    ])

    expect(summary.repeatedSkillBodies.map((s) => [s.skill, s.count])).toEqual([['superman', 3]])
  })

  it('skips invoked_skills entries that are malformed or below the size floor', () => {
    const line = JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'invoked_skills',
        skills: [
          { name: 'small', path: '/s/small', content: 'tiny' },
          { name: 'nobody', path: '/s/nobody' },
          { path: '', content: 'X'.repeat(LARGE_SKILL_BODY_BYTES) },
          null,
        ],
      },
    })
    const bad = JSON.stringify({ type: 'attachment', attachment: { type: 'invoked_skills', skills: 'not-a-list' } })

    expect(fold([line, bad]).repeatedSkillBodies).toEqual([])
  })

  it('ignores a body below the size threshold and any non-meta user text', () => {
    const summary = fold([
      metaLine(body('tiny', 10)),
      metaLine(body('tiny', 10)),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: body('big', LARGE_SKILL_BODY_BYTES) }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: body('big', LARGE_SKILL_BODY_BYTES) }] } }),
    ])

    expect(summary.repeatedSkillBodies).toEqual([])
  })

  it('reads a message whose content is a plain string, not a block array', () => {
    const summary = fold([
      JSON.stringify({ type: 'user', isMeta: true, message: { content: body('plain', LARGE_SKILL_BODY_BYTES) } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: body('plain', LARGE_SKILL_BODY_BYTES) } }),
    ])

    expect(summary.repeatedSkillBodies.map((s) => s.skill)).toEqual(['plain'])
  })
})

describe('lineMayCarryResidentSignal', () => {
  it('keeps each of the three signal shapes, in the compact spelling the harness writes', () => {
    expect(lineMayCarryResidentSignal(taskReminderLine([]))).toBe(true)
    expect(lineMayCarryResidentSignal(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))).toBe(true)
    expect(lineMayCarryResidentSignal(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } }))).toBe(true)
  })

  it('keeps an isMeta line whose writer put whitespace after the key', () => {
    // `isMeta` is the one signal matched on a key rather than a value, so it is the one whose
    // spelling depends on the serializer. Tying the filter to `"isMeta":true` would make a
    // reformatted transcript drop every skill body silently -- nothing fails, the hint just
    // stops firing. Both spellings must survive the filter and reach the real `=== true` check.
    const spaced = '{"type": "user", "isMeta": true, "message": {"content": "x"}}'
    const compact = '{"type":"user","isMeta":true,"message":{"content":"x"}}'

    expect(lineMayCarryResidentSignal(spaced)).toBe(true)
    expect(lineMayCarryResidentSignal(compact)).toBe(true)
    // And the filter stays a prefilter: it admits the candidate, it does not decide the answer.
    expect(lineMayCarryResidentSignal('{"type":"user","isMeta":false}')).toBe(true)
    const body = 'B'.repeat(LARGE_SKILL_BODY_BYTES)
    const notMeta = JSON.stringify({ type: 'user', isMeta: false, message: { content: body } })
    expect(fold([notMeta]).repeatedSkillBodies).toEqual([])
  })

  it('rejects the ordinary traffic that dominates a transcript', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the answer.' }] },
    })
    const toolResult = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }] },
    })

    expect(lineMayCarryResidentSignal(assistant)).toBe(false)
    expect(lineMayCarryResidentSignal(toolResult)).toBe(false)
  })

  it('filters out nothing that the unfiltered fold would have counted', () => {
    // The filter is an optimisation, so its only real obligation is to be lossless for the two
    // signals the hook path consumes. Folding with and without it must agree.
    const lines = [
      taskReminderLine([taskItem('1', 'completed', 'a'.repeat(80))]),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'noise' }] } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    ]

    const all = fold(lines)
    const filtered = fold(lines.filter(lineMayCarryResidentSignal))

    expect(filtered.compactionCount).toBe(all.compactionCount)
    expect(filtered.latestTaskList).toEqual(all.latestTaskList)
  })
})

describe('readTranscriptTail', () => {
  it('returns every line when the file is smaller than the cap', () => {
    const file = tempTranscript('{"a":1}\n{"a":2}\n')

    expect(readTranscriptTail(file).filter((l) => l.trim() !== '')).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('drops the leading partial line when the window starts mid-file', () => {
    const file = tempTranscript('{"first":"aaaaaaaaaaaaaaaaaaaa"}\n{"second":2}\n')

    // A cap that lands inside the first line: the fragment it produces is not valid JSON and would
    // also misreport the size of the record it came from, so it must not be returned.
    const lines = readTranscriptTail(file, 20).filter((l) => l.trim() !== '')

    // Asserted as an exact list, not as "does not contain 'first'": the fragment this window
    // actually produces is the tail of that line (`aaa"}`), which never held the word `first`, so a
    // substring check passes whether or not the fragment was dropped.
    expect(lines).toEqual(['{"second":2}'])
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('returns nothing for a missing path, an empty file, or a directory', () => {
    expect(readTranscriptTail(path.join(os.tmpdir(), 'tg-resident-does-not-exist.jsonl'))).toEqual([])
    expect(readTranscriptTail(tempTranscript('')).filter((l) => l.trim() !== '')).toEqual([])
    expect(readTranscriptTail(os.tmpdir())).toEqual([])
  })

  it('reads the newest task list from the tail of a transcript with plenty of noise ahead of it', () => {
    const noise = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] } }),
    ).join('\n')
    const file = tempTranscript(`${noise}\n${taskReminderLine([taskItem('1', 'completed', 'z'.repeat(60))])}\n`)

    const summary = fold(readTranscriptTail(file).filter(lineMayCarryResidentSignal))

    expect(summary.latestTaskList?.completed).toBe(1)
  })
})

describe('fail-soft parsing', () => {
  it('never throws on malformed input and reports zero', () => {
    const acc = createResidentContextStats()

    expect(() => {
      accumulateResidentLine(acc, null, 0)
      accumulateResidentLine(acc, 'a string', 5)
      accumulateResidentLine(acc, 42, 2)
      accumulateResidentLine(acc, { attachment: 'not-an-object' }, 10)
      accumulateResidentLine(acc, { attachment: null }, 10)
      accumulateResidentLine(acc, { isMeta: true, type: 'user', message: null }, 10)
    }).not.toThrow()

    const summary = summarizeResidentContext(acc)
    expect(summary.attachmentClasses).toEqual([])
    expect(summary.taskReminderCount).toBe(0)
    expect(summary.compactionCount).toBe(0)
  })

  it('skips unparseable and blank lines rather than failing the whole fold', () => {
    const summary = fold(['', '   ', 'not json at all', '{"broken":', taskReminderLine([taskItem('1', 'completed', 'a')])])

    expect(summary.taskReminderCount).toBe(1)
  })
})

describe('hint text', () => {
  const bigList: TaskListSnapshot = {
    bytes: 215_000,
    itemCount: 284,
    completed: 240,
    inProgress: 9,
    pending: 35,
    descriptionBytes: 190_000,
    completedDescriptionBytes: 160_000,
  }

  it('names the size, the completed share, and the tool that can act on it', () => {
    const hint = taskListPruneHint(bigList)

    expect(hint).not.toBeNull()
    expect(hint).toContain('240 of 284')
    expect(hint).toContain('TaskUpdate')
    // Advisory, never auto-acting: a shared list may hold another agent's items.
    expect(hint).toContain('ownership')
  })

  it('says nothing for a list below the size threshold', () => {
    expect(taskListPruneHint({ ...bigList, bytes: LARGE_TASK_LIST_BYTES - 1 })).toBeNull()
  })

  it('says nothing when there is nothing completed to prune', () => {
    // A large list that is all pending work is not waste; the advice would be wrong.
    expect(taskListPruneHint({ ...bigList, completed: 0, completedDescriptionBytes: 0 })).toBeNull()
  })

  it('says nothing when there is no list at all', () => {
    expect(taskListPruneHint(null)).toBeNull()
  })

  it('names the skill, the repeat count, and a way to reread one part', () => {
    const hint = repeatedSkillBodyHint([{ skill: 'superman', count: 12, bytes: 903_168 }])

    expect(hint).toContain('`superman`')
    expect(hint).toContain('12 times')
    expect(hint).toContain('token-goat skill-section superman')
  })

  it('says nothing for a single injection or an empty list', () => {
    expect(repeatedSkillBodyHint([{ skill: 'superman', count: 1, bytes: 903_168 }])).toBeNull()
    expect(repeatedSkillBodyHint([])).toBeNull()
  })
})

describe('formatting and the shared token ratio', () => {
  it('scales byte labels across the three magnitudes these numbers span', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(21_800)).toBe('21 KB')
    expect(formatBytes(126_900_000)).toBe('121.0 MB')
  })

  it('rounds token estimates to a magnitude, which is the honest precision for an estimate', () => {
    expect(formatTokenEstimate(999)).toBe('999')
    expect(formatTokenEstimate(52_000)).toBe('52K')
  })

  it('estimates a length at the documented ~3 chars/token ratio', () => {
    // Pinned to concrete values rather than only cross-checked against estimateTokens: that function
    // now delegates here, so comparing the two can never fail -- a changed ratio moves both sides at
    // once. Only fixed expectations actually hold the ratio.
    expect(estimateTokensFromLength(0)).toBe(1)
    expect(estimateTokensFromLength(3)).toBe(2)
    expect(estimateTokensFromLength(3000)).toBe(1001)
    // Negative and fractional lengths cannot produce a nonsense estimate.
    expect(estimateTokensFromLength(-5)).toBe(1)
  })

  it('agrees with estimating from a string of that length, for any future re-implementation', () => {
    // Guards the delegation itself: if either side ever grows its own arithmetic, the same content
    // would be priced differently depending on which caller asked.
    for (const size of [0, 1, 3, 500, 21_800]) {
      expect(estimateTokensFromLength(size)).toBe(estimateTokens('x'.repeat(size)))
    }
  })
})
