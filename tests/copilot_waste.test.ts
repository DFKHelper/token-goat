import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCopilotWasteReport,
  findLatestCopilotSession,
  splitInjectedBlocks,
} from '../src/copilot_waste.js'

/** One events.jsonl line. Shape copied from a real Copilot 1.0.80 log, not invented. */
function ev(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, id: `e-${type}`, timestamp: 1, data })
}

function userMessage(content: string, transformedContent: string): string {
  return ev('user.message', { content, transformedContent })
}

describe('splitInjectedBlocks', () => {
  it('labels a system_reminder by its first inner tag, so distinct reminders do not collapse into one bucket', () => {
    const blocks = splitInjectedBlocks(
      '<system_reminder>\n<sql_tables>Available tables: todos</sql_tables>\n</system_reminder>',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['reminder:sql_tables'])
  })

  it('labels a reminder with no inner tag as reminder:text rather than dropping it', () => {
    const blocks = splitInjectedBlocks('<system_reminder>\nplain guidance\n</system_reminder>')
    expect(blocks.map((b) => b.kind)).toEqual(['reminder:text'])
  })

  it('counts only tagged blocks, never the user prose between them', () => {
    // The user's own words are the one part of the prompt that is not overhead. Counting them
    // would inflate every future "injected bytes" number by the length of the conversation.
    const blocks = splitInjectedBlocks(
      '<current_datetime>2026-08-23T01:22:27.150-05:00</current_datetime>\n\nreply with just the word pong\n\n<system_reminder>\n<sql_tables>t</sql_tables>\n</system_reminder>',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['current_datetime', 'reminder:sql_tables'])
    expect(blocks.some((b) => b.body.includes('reply with just the word pong'))).toBe(false)
  })
})

describe('buildCopilotWasteReport', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-cpwaste-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeLog(lines: string[]): string {
    const sessionDir = join(dir, 'session-state', 'sess-1')
    mkdirSync(sessionDir, { recursive: true })
    const p = join(sessionDir, 'events.jsonl')
    writeFileSync(p, `${lines.join('\n')}\n`, 'utf-8')
    return p
  }

  it('reports Copilot\'s own token split rather than an estimate of it', () => {
    const p = writeLog([
      ev('session.shutdown', {
        systemTokens: 6569,
        toolDefinitionsTokens: 7268,
        conversationTokens: 111,
        currentTokens: 13951,
      }),
    ])
    expect(buildCopilotWasteReport(p).tokens).toEqual({
      systemTokens: 6569,
      toolDefinitionsTokens: 7268,
      conversationTokens: 111,
      currentTokens: 13951,
    })
  })

  it('takes the last shutdown split, since a resumed session writes several and only the final one is current', () => {
    const p = writeLog([
      ev('session.shutdown', { systemTokens: 1, toolDefinitionsTokens: 1, conversationTokens: 1, currentTokens: 3 }),
      ev('session.resume', {}),
      ev('session.shutdown', { systemTokens: 9, toolDefinitionsTokens: 9, conversationTokens: 9, currentTokens: 27 }),
    ])
    expect(buildCopilotWasteReport(p).tokens?.systemTokens).toBe(9)
  })

  it('leaves tokens null when the session never shut down, instead of reporting zeros as a real split', () => {
    // Zeros would render as a 0-token system prompt, which reads as "no overhead" -- the exact
    // opposite of the truth for a session still running.
    const p = writeLog([userMessage('hi', '<current_datetime>t</current_datetime>')])
    expect(buildCopilotWasteReport(p).tokens).toBeNull()
  })

  it('counts a byte-identical reminder re-sent on a later turn as repeat bytes', () => {
    const reminder = '<system_reminder>\n<sql_tables>Available tables: todos</sql_tables>\n</system_reminder>'
    const p = writeLog([
      userMessage('one', `<current_datetime>a</current_datetime>\n\none\n\n${reminder}`),
      userMessage('two', `<current_datetime>b</current_datetime>\n\ntwo\n\n${reminder}`),
    ])
    const report = buildCopilotWasteReport(p)
    const sql = report.blocks.find((b) => b.kind === 'reminder:sql_tables')
    expect(sql).toBeDefined()
    expect(sql?.count).toBe(2)
    expect(sql?.repeatCount).toBe(1)
    expect(sql?.repeatBytes).toBe(Buffer.byteLength(reminder, 'utf-8'))
  })

  it('does not count a changed reminder as a repeat, even though its kind is unchanged', () => {
    // The kind is the bucket, but the payload is what decides repetition. Hashing the kind
    // instead of the body would report a growing todo list as pure waste.
    const p = writeLog([
      userMessage('one', '<system_reminder>\n<sql_tables>todos</sql_tables>\n</system_reminder>'),
      userMessage('two', '<system_reminder>\n<sql_tables>todos, inbox</sql_tables>\n</system_reminder>'),
    ])
    const sql = buildCopilotWasteReport(p).blocks.find((b) => b.kind === 'reminder:sql_tables')
    expect(sql?.count).toBe(2)
    expect(sql?.repeatBytes).toBe(0)
  })

  it('keeps hook records out of the injected-block ledger and reports them as unbilled instead', () => {
    // This is the Copilot analogue of Claude Code's hook_success attachments: the largest event
    // type on disk in an instrumented session, and zero model-visible bytes. Counting it as
    // context would make an instrumented session look like the worst offender.
    const hookLine = ev('hook.end', { hookName: 'token-goat', output: { additionalContext: 'x'.repeat(500) } })
    const p = writeLog([hookLine, userMessage('one', '<system_reminder>\n<sql_tables>t</sql_tables>\n</system_reminder>')])
    const report = buildCopilotWasteReport(p)
    expect(report.blocks.every((b) => !b.kind.includes('hook'))).toBe(true)
    expect(report.hookRecordBytes).toBe(Buffer.byteLength(hookLine, 'utf-8'))
  })

  it('reads a compaction summary out of session.compaction_complete, the channel Copilot has no hook for', () => {
    const p = writeLog([
      ev('session.compaction_complete', {
        trigger: 'auto',
        summaryContent: 'a summary of the session',
        preCompactionTokens: 90000,
        postCompactionTokens: 12000,
      }),
    ])
    expect(buildCopilotWasteReport(p).compactions).toEqual([
      { trigger: 'auto', summaryBytes: 24, preTokens: 90000, postTokens: 12000 },
    ])
  })

  it('skips a malformed trailing line instead of aborting, since a live session is mid-flush', () => {
    const p = writeLog([
      ev('session.shutdown', { systemTokens: 5, toolDefinitionsTokens: 5, conversationTokens: 5, currentTokens: 15 }),
      '{"type":"user.message","data":{"transformed',
    ])
    expect(buildCopilotWasteReport(p).tokens?.systemTokens).toBe(5)
  })
})

describe('findLatestCopilotSession', () => {
  let root: string
  let prev: string | undefined

  beforeEach(() => {
    prev = process.env['COPILOT_HOME']
    root = mkdtempSync(join(tmpdir(), 'tg-cphome-'))
    process.env['COPILOT_HOME'] = root
  })

  afterEach(() => {
    if (prev === undefined) delete process.env['COPILOT_HOME']
    else process.env['COPILOT_HOME'] = prev
    rmSync(root, { recursive: true, force: true })
  })

  function session(id: string, mtimeSec: number): string {
    const d = join(root, 'session-state', id)
    mkdirSync(d, { recursive: true })
    const p = join(d, 'events.jsonl')
    writeFileSync(p, '', 'utf-8')
    utimesSync(p, mtimeSec, mtimeSec)
    return p
  }

  it('returns null when there is no session-state directory at all', () => {
    expect(findLatestCopilotSession()).toBeNull()
  })

  it('picks the most recently modified session', () => {
    session('old', 1_000_000)
    const newer = session('new', 2_000_000)
    expect(findLatestCopilotSession()).toBe(newer)
  })

  it('skips a session directory that has no events.jsonl rather than returning its path', () => {
    // Real sessions in this state exist: Copilot creates the directory at start and one on this
    // machine never got an events file. Returning it would make the command fail on a stat.
    mkdirSync(join(root, 'session-state', 'started-only'), { recursive: true })
    const real = session('real', 1_500_000)
    expect(findLatestCopilotSession()).toBe(real)
  })

  it('honors COPILOT_HOME, since ignoring it points the report at a directory Copilot never writes', () => {
    const p = session('only', 1_000_000)
    expect(findLatestCopilotSession()).toBe(p)
    expect(p.startsWith(root)).toBe(true)
  })
})
