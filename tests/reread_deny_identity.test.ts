/** The whole-file re-read denies in preReadHandler decide from a read count alone: "already read this session" fires whether or not the file still holds what that read delivered. Each of them now books a zero-byte `reread_deny_identity` row saying which branch fired and whether the refused file was identical to or changed from the session's last read, proven by the snapshot postReadHandler keeps when there is one and by size and mtime when there is not. Driven through the real preReadHandler and postReadHandler; the rows are read back out of the real stats ledger. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { invalidateConfigCache } from '../src/config.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { clearModuleCaches } from '../src/reset.js'
import { getGlobalDb } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

let dir: string
let sid: string
let seq = 0

beforeEach(() => {
  clearModuleCaches()
  // The four most recently read files are waved through every deny; these cases each read a single file, so the window would hide every branch under test.
  vi.stubEnv('TOKEN_GOAT_PROTECT_RECENT_READS', '0')
  invalidateConfigCache()
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-identity-')))
  seq += 1
  sid = `deny-identity-${process.pid}-${seq}`
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  fs.rmSync(dir, { recursive: true, force: true })
})

const pre = (file: string): ReturnType<typeof preReadHandler> =>
  preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId: sid }))

// FORMAT-DERIVED: the Read tool's PostToolUse `tool_response` in Claude Code, {type: "text", file: {filePath, content, numLines, startLine, totalLines}}, the shape tests/hooks_read_post.test.ts and the hook-input schema in the 2.1.284 binary give it.
function post(file: string): void {
  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n').length
  const event: HookEvent = makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: file },
    sessionId: sid,
    raw: { tool_response: { type: 'text', file: { filePath: file, content, numLines: lines, startLine: 1, totalLines: lines } } },
  })
  postReadHandler(event)
}

function identityRows(): string[] {
  const rows = getGlobalDb().prepare(`SELECT detail FROM stats WHERE kind = 'reread_deny_identity' ORDER BY rowid`).all() as Array<{ detail: string | null }>
  return rows.map((r) => r.detail ?? '')
}

function write(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

// HAND-DERIVED: on Windows a file's mtime can run a few ms ahead of Date.now(), so a file written an instant before its first read could look changed; an hour back precedes the read on any host and load, and a later write keeps its natural mtime.
function backdate(file: string): void {
  const earlier = new Date(Date.now() - 3_600_000)
  fs.utimesSync(file, earlier, earlier)
}

describe('reread_deny_identity', () => {
  it('books an unchanged source file denied on its third read as identical, from the stat', () => {
    // HAND-DERIVED: a one-line C# file, a source extension with no snapshot on this path (no post_tool_use ran), so only size and mtime can speak for it.
    const file = write('Same.cs', 'class Same {}\n')
    backdate(file)
    const before = identityRows().length
    pre(file)
    pre(file)
    expect(pre(file).hookType).toBe('deny')
    expect(identityRows().slice(before)).toEqual(['branch=source-count identity=identical basis=stat edited=0'])
  })

  it('reads a source file whose size moved since the last read through, booking no deny', () => {
    const file = write('Grown.cs', 'class Grown {}\n')
    const before = identityRows().length
    pre(file)
    pre(file)
    fs.appendFileSync(file, 'class Added {}\n')
    // HAND-DERIVED: stamped an hour before the reads, so the mtime says nothing moved and only the size can report the change.
    const earlier = new Date(Date.now() - 3_600_000)
    fs.utimesSync(file, earlier, earlier)
    // A changed file is never refused: the model's last read is stale, so the Read goes through and no deny row is booked.
    expect(pre(file).hookType).not.toBe('deny')
    expect(identityRows().slice(before)).toEqual([])
  })

  it('reads a same-size rewrite after the last read through, from the mtime, booking no deny', () => {
    const file = write('Swap.cs', 'class AAAA {}\n')
    const before = identityRows().length
    pre(file)
    pre(file)
    // HAND-DERIVED: the same byte count, stamped a minute after the reads so the write is unambiguously later than either.
    fs.writeFileSync(file, 'class BBBB {}\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(file, later, later)
    // A changed file is never refused: the model's last read is stale, so the Read goes through and no deny row is booked.
    expect(pre(file).hookType).not.toBe('deny')
    expect(identityRows().slice(before)).toEqual([])
  })

  it('reads a markdown file edited too slightly to diff through, from the snapshot, booking no deny', () => {
    // HAND-DERIVED: a small doc whose one-word edit yields a diff larger than the file, so the diff-on-reread branch declines and the changed file must then be read through, not refused by the markdown deny.
    const file = write('notes.md', '# Notes\n\nSome content here.\n')
    const before = identityRows().length
    pre(file)
    post(file)
    fs.writeFileSync(file, '# Notes\n\nSame content here.\n')
    expect(pre(file).hookType).not.toBe('deny')
    expect(identityRows().slice(before)).toEqual([])
  })

  it('reads a tasks output that grew below the diff floor through, and still refuses an unchanged re-read', () => {
    // HAND-DERIVED: a background task's output file (tasks/<id>.output) gaining one line while the task runs; no post_tool_use ran, so no snapshot exists and the size alone speaks for it.
    const file = path.join(dir, 'tasks', 'abc123.output')
    fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, 'line one\n')
    backdate(file)
    pre(file)
    expect(pre(file).hookType).toBe('deny')
    fs.appendFileSync(file, 'line two\n')
    expect(pre(file).hookType).not.toBe('deny')
  })

  it('lets a session artifact truncated on its last read through once it changed, and still refuses it unchanged', () => {
    // HAND-DERIVED: a tasks output delivered with the harness's partial-view notice, so it counts as truncated; the truncated deny must hold only while the file is unchanged. The notice is the head of the CAPTURE in tests/hooks_read.test.ts::HARNESS_TRUNCATION_NOTICE.
    const file = path.join(dir, 'tasks', 'trunc1.output')
    fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, 'line one\n')
    backdate(file)
    postReadHandler(
      makeHookEvent({
        eventName: 'post_tool_use',
        toolName: 'Read',
        toolInput: { file_path: file },
        sessionId: sid,
        raw: { tool_response: '[Truncated: PARTIAL view — probe.text: showing lines 1-529 of 1601 total (64247 tokens, cap 25000). Call Read with offset=530 limit=529 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]\nline one\n' },
      }),
    )
    const unchanged = pre(file)
    expect(unchanged.hookType).toBe('deny')
    if (unchanged.hookType === 'deny') expect(unchanged.message).toContain('truncated on last read')
    fs.appendFileSync(file, 'line two\n')
    expect(pre(file).hookType).not.toBe('deny')
  })

  it('reads an improve-state file that changed through, and still refuses an unchanged re-read', () => {
    // HAND-DERIVED: an orchestrator state file another process rewrites between reads.
    const file = write('.improve-state-run.json', '{"step":1}\n')
    backdate(file)
    pre(file)
    expect(pre(file).hookType).toBe('deny')
    fs.writeFileSync(file, '{"step":2,"more":true}\n')
    expect(pre(file).hookType).not.toBe('deny')
  })

  // HAND-DERIVED: the stat fallback compares the file system's mtime with Date.now() at the read. Measured on Windows (node 24.12.0, 3000 writes each followed by a Date.now() read): the stamp ran from 7 ms ahead to 10 ms behind that read, so an mtime within a tick of the read orders nothing. Date is frozen here so the read time is exact and the skew is the one number under test.
  describe('mtime next to the read time', () => {
    const readAt = (): number => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const t = Date.now()
      vi.setSystemTime(t)
      return t
    }
    const stamp = (file: string, at: number): void => {
      fs.utimesSync(file, new Date(at), new Date(at))
    }

    it('reads a same-size rewrite through when the file system stamped it before the read', () => {
      const t = readAt()
      const file = write('.improve-state-lag.json', '{"step":1}\n')
      stamp(file, t - 3_600_000)
      pre(file)
      fs.writeFileSync(file, '{"step":2}\n')
      // The write came after the read, but the file system's clock was 5 ms behind Date.now(), so the stamp sits before the read.
      stamp(file, t - 5)
      expect(pre(file).hookType).not.toBe('deny')
    })

    it('reads a file through when the file system stamped it after the read that found it unchanged', () => {
      const t = readAt()
      const file = write('.improve-state-lead.json', '{"step":1}\n')
      stamp(file, t + 5)
      pre(file)
      expect(pre(file).hookType).not.toBe('deny')
    })

    it('refuses a re-read only once the stamp is a whole tick older than the read', () => {
      const t = readAt()
      const older = write('.improve-state-older.json', '{"step":1}\n')
      // HAND-DERIVED: TIMESTAMP_TICK_SEC is 2 (src/fingerprint.ts), so 2000 ms before the read proves nothing was written since and 1999 ms does not.
      stamp(older, t - 2_000)
      pre(older)
      expect(pre(older).hookType).toBe('deny')
      const nearer = write('.improve-state-nearer.json', '{"step":1}\n')
      stamp(nearer, t - 1_999)
      pre(nearer)
      expect(pre(nearer).hookType).not.toBe('deny')
    })
  })

  it('reads a markdown file empty at its first read and filled since through', () => {
    // HAND-DERIVED: a file created empty, read, then filled by another process.
    const file = write('filled.md', '')
    pre(file)
    fs.writeFileSync(file, '# Filled\n\nSome content that arrived later.\n')
    expect(pre(file).hookType).not.toBe('deny')
  })

  it('books nothing on a re-read that no whole-file deny refuses', () => {
    const file = write('Once.cs', 'class Once {}\n')
    const before = identityRows().length
    pre(file)
    expect(pre(file).hookType).not.toBe('deny')
    expect(identityRows().slice(before)).toEqual([])
  })
})
