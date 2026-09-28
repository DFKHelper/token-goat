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

describe('reread_deny_identity', () => {
  it('books an unchanged source file denied on its third read as identical, from the stat', () => {
    // HAND-DERIVED: a one-line C# file, a source extension with no snapshot on this path (no post_tool_use ran), so only size and mtime can speak for it.
    const file = write('Same.cs', 'class Same {}\n')
    const before = identityRows().length
    pre(file)
    pre(file)
    expect(pre(file).hookType).toBe('deny')
    expect(identityRows().slice(before)).toEqual(['branch=source-count identity=identical basis=stat edited=0'])
  })

  it('books a source file whose size moved since the last read as changed', () => {
    const file = write('Grown.cs', 'class Grown {}\n')
    const before = identityRows().length
    pre(file)
    pre(file)
    fs.appendFileSync(file, 'class Added {}\n')
    // HAND-DERIVED: stamped an hour before the reads, so the mtime says nothing moved and only the size can report the change.
    const earlier = new Date(Date.now() - 3_600_000)
    fs.utimesSync(file, earlier, earlier)
    expect(pre(file).hookType).toBe('deny')
    expect(identityRows().slice(before)).toEqual(['branch=source-count identity=changed basis=stat edited=0'])
  })

  it('books a same-size rewrite after the last read as changed, from the mtime', () => {
    const file = write('Swap.cs', 'class AAAA {}\n')
    const before = identityRows().length
    pre(file)
    pre(file)
    // HAND-DERIVED: the same byte count, stamped a minute after the reads so the write is unambiguously later than either.
    fs.writeFileSync(file, 'class BBBB {}\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(file, later, later)
    expect(pre(file).hookType).toBe('deny')
    expect(identityRows().slice(before)).toEqual(['branch=source-count identity=changed basis=stat edited=0'])
  })

  it('books a markdown file edited too slightly to diff as changed, from the snapshot', () => {
    // HAND-DERIVED: a small doc whose one-word edit yields a diff larger than the file, so the diff-on-reread branch declines and the markdown deny refuses it instead.
    const file = write('notes.md', '# Notes\n\nSome content here.\n')
    const before = identityRows().length
    pre(file)
    post(file)
    fs.writeFileSync(file, '# Notes\n\nSame content here.\n')
    const out = pre(file)
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') expect(out.message).toContain('Markdown file already read this session')
    expect(identityRows().slice(before)).toEqual(['branch=doc identity=changed basis=snapshot edited=0'])
  })

  it('books nothing on a re-read that no whole-file deny refuses', () => {
    const file = write('Once.cs', 'class Once {}\n')
    const before = identityRows().length
    pre(file)
    expect(pre(file).hookType).not.toBe('deny')
    expect(identityRows().slice(before)).toEqual([])
  })
})
