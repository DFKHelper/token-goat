/** An Edit that lands on a file whose last Read handed the model only part of it: a structural rewrite (outline, skeleton, body, comment or prose fold) or a window short of the whole file. The Edit is composed from what the model was shown, so it can land on lines the model never saw, and nothing recorded the pairing. postReadHandler now keeps the shape of each file's last Read beside the session, and postEditHandler books a zero-byte `edit_after_fold` row naming that shape and the editing tool. Driven through the real preReadHandler, postReadHandler and postEditHandler; the rows are read back out of the real stats ledger. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { postEditHandler } from '../src/hooks_edit.js'
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
  // The recent-read window waves re-reads through every deny; switched off so a re-read in these cases reaches postReadHandler only when no deny applies, the same as it would outside the window.
  vi.stubEnv('TOKEN_GOAT_PROTECT_RECENT_READS', '0')
  invalidateConfigCache()
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-edit-after-fold-')))
  seq += 1
  sid = `edit-after-fold-${process.pid}-${seq}`
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

// FORMAT-DERIVED: the Read tool's PostToolUse `tool_response` in Claude Code, {type: "text", file: {filePath, content, numLines, startLine, totalLines}}, the shape tests/hooks_read_post.test.ts and the hook-input schema in the 2.1.284 binary give it. `content` holds the delivered window only, and `startLine`/`numLines` place it within `totalLines`.
function read(file: string, window?: { offset: number; limit: number }): void {
  const toolInput: Record<string, unknown> = { file_path: file, ...(window ?? {}) }
  preReadHandler(makeHookEvent({ toolName: 'Read', toolInput, sessionId: sid }))
  const all = fs.readFileSync(file, 'utf8').split('\n')
  const start = window?.offset ?? 1
  const lines = window === undefined ? all : all.slice(start - 1, start - 1 + window.limit)
  const tool_response = { type: 'text', file: { filePath: file, content: lines.join('\n'), numLines: lines.length, startLine: start, totalLines: all.length } }
  postReadHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Read', toolInput, sessionId: sid, raw: { tool_response } }))
}

// FORMAT-DERIVED: Claude Code's Edit and Write tool inputs, {file_path, old_string, new_string} and {file_path, content}, as its hooks reference (code.claude.com/docs/en/hooks) shows them in PostToolUse input. postEditHandler reads only file_path; the rest is there so the event looks like the one a harness sends.
function edit(file: string, tool: 'Edit' | 'Write' = 'Edit'): void {
  const toolInput = tool === 'Edit' ? { file_path: file, old_string: 'x', new_string: 'y' } : { file_path: file, content: 'z' }
  postEditHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: tool, toolInput, sessionId: sid }))
}

function rows(): string[] {
  const all = getGlobalDb().prepare(`SELECT detail FROM stats WHERE kind = 'edit_after_fold' ORDER BY rowid`).all() as Array<{ detail: string | null }>
  return all.map((r) => r.detail ?? '')
}

// HAND-DERIVED: the fixture tests/fold_pointer_round_trip.test.ts folds for real: past the 8000-byte markdown threshold, three headings (under the six-heading outline floor), and one long paragraph built from a repeated sentence, so the prose fold is the rewrite that fires.
const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const FOLDABLE_MD = ['# Fixture Document', '', '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```', '', '## First Section', '', `This opening sentence stays visible. ${FILLER.repeat(3)}and the tail that folds away.`, '', '## Second Section', '', 'Short tail content.', ''].join('\n')

// HAND-DERIVED: forty numbered lines, so a ten-line window is plainly short of the file.
const FORTY_LINES = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'

describe('edit_after_fold', () => {
  it('books an Edit of a file whose last Read was folded', () => {
    const file = write('doc.md', FOLDABLE_MD)
    const before = rows().length
    const toolInput = { file_path: file }
    preReadHandler(makeHookEvent({ toolName: 'Read', toolInput, sessionId: sid }))
    // FORMAT-DERIVED: the Read tool's `cat -n` string delivery, six-wide right-aligned numbers and a tab, as tests/fold_pointer_round_trip.test.ts feeds the same fixture to the same fold.
    const numbered = FOLDABLE_MD.split('\n').map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`).join('\n')
    const out = postReadHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Read', toolInput, sessionId: sid, raw: { tool_response: numbered } }))
    expect(out.hookType === 'rewriteOutput' ? out.updatedOutput : '').toContain('rest of paragraph folded')
    edit(file)
    expect(rows().slice(before)).toEqual(['last_read=fold tool=Edit'])
  })

  it('books an Edit of a file whose last Read was a window short of the file', () => {
    const file = write('part.ts', FORTY_LINES)
    const before = rows().length
    read(file, { offset: 5, limit: 10 })
    edit(file)
    expect(rows().slice(before)).toEqual(['last_read=partial tool=Edit'])
  })

  it('books nothing when the last Read delivered the whole file', () => {
    const file = write('whole.ts', FORTY_LINES)
    const before = rows().length
    read(file)
    edit(file)
    expect(rows().slice(before)).toEqual([])
  })

  it('a whole-file Read after a partial one clears the record', () => {
    const file = write('then_whole.ts', FORTY_LINES)
    const before = rows().length
    read(file, { offset: 1, limit: 10 })
    read(file)
    edit(file)
    expect(rows().slice(before)).toEqual([])
  })

  it('a window that happens to cover the whole file is not partial', () => {
    const file = write('covered.ts', FORTY_LINES)
    const before = rows().length
    read(file, { offset: 1, limit: 2000 })
    edit(file)
    expect(rows().slice(before)).toEqual([])
  })

  it('keeps booking Edits until a Write replaces the file the model had only part of', () => {
    const file = write('rewritten.ts', FORTY_LINES)
    const before = rows().length
    read(file, { offset: 20, limit: 5 })
    edit(file)
    edit(file)
    edit(file, 'Write')
    edit(file)
    expect(rows().slice(before)).toEqual(['last_read=partial tool=Edit', 'last_read=partial tool=Edit', 'last_read=partial tool=Write'])
  })

  it("keeps a subagent's reads apart from its parent's", () => {
    const file = write('shared.ts', FORTY_LINES)
    const before = rows().length
    const toolInput = { file_path: file, offset: 1, limit: 5 }
    const lines = FORTY_LINES.split('\n')
    const tool_response = { type: 'text', file: { filePath: file, content: lines.slice(0, 5).join('\n'), numLines: 5, startLine: 1, totalLines: lines.length } }
    postReadHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Read', toolInput, sessionId: sid, agentId: 'child-1', raw: { tool_response } }))
    edit(file)
    expect(rows().slice(before)).toEqual([])
  })
})
