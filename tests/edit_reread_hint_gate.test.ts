/** The post-edit "re-read a specific section" hint fired 50 times in the recorded corpus (32 after a Write, 18 after an Edit) and was followed 0 times. After a Write the model has just supplied every byte of the file and Claude Code already tells it the file state is current, so the hint can save nothing there; after an Edit of a small file a whole re-read costs less than the hint line. Its scoring hid all of this: the category was booked as complied with whenever no re-read followed, so hint-stats read 50 ignored hints as 50 successes and never retired it. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { resolvePendingHintsForEvent } from '../src/hint_stats.js'
import type { HookEvent } from '../src/hook_registry.js'
import { postEditHandler } from '../src/hooks_edit.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-edit-reread-gate-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function nonce(): string {
  return `erg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function editEvent(toolName: string, sessionId: string, file: string): HookEvent {
  return { eventName: 'post_tool_use', toolName, toolInput: { file_path: file }, sessionId, agentId: undefined, raw: { cwd: dir } }
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

function rowsFor(sessionId: string): Array<{ category: string; displayed: number; resolved: number; acted_on: number | null }> {
  return getDb(globalDbPath())
    .prepare('SELECT category, displayed, resolved, acted_on FROM hint_emissions WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Array<{ category: string; displayed: number; resolved: number; acted_on: number | null }>
}

/** A markdown file with real headings, `bytes` long or a little over. */
function markdownFile(name: string, bytes: number): string {
  const file = path.join(dir, name)
  const section = '## Section\n\n' + 'A paragraph of ordinary prose that pads the document out to size.\n'.repeat(20)
  fs.writeFileSync(file, '# Title\n\n' + section.repeat(Math.ceil(bytes / section.length)), 'utf8')
  return file
}

describe('post-edit section re-read hint', () => {
  it('the large fixture is over the re-read size the hint now gates on, and the small one is under it', () => {
    const threshold = loadConfig().hints.reread_deny_min_bytes
    expect(threshold).toBeGreaterThan(512)
    expect(fs.statSync(markdownFile('large.md', threshold + 4096)).size).toBeGreaterThan(threshold)
    expect(fs.statSync(markdownFile('small.md', 2048)).size).toBeLessThan(threshold)
  })

  it('a Write of a large markdown file emits nothing and books no detection', () => {
    const file = markdownFile('written.md', loadConfig().hints.reread_deny_min_bytes + 4096)
    const session = nonce()
    expect(postEditHandler(editEvent('Write', session, file)).hookType).toBe('pass')
    expect(rowsFor(session)).toEqual([])
  })

  it('an Edit of a small markdown file emits nothing', () => {
    const file = markdownFile('small.md', 2048)
    expect(fs.statSync(file).size).toBeGreaterThan(loadConfig().hints.min_session_hint_savings_bytes)
    const session = nonce()
    expect(postEditHandler(editEvent('Edit', session, file)).hookType).toBe('pass')
    expect(rowsFor(session).filter((r) => r.displayed === 1)).toEqual([])
  })

  it('an Edit of a large markdown file still emits the hint', () => {
    const file = markdownFile('large.md', loadConfig().hints.reread_deny_min_bytes + 4096)
    const session = nonce()
    const out = postEditHandler(editEvent('Edit', session, file))
    expect(out.hookType).toBe('context')
    const context = out.hookType === 'context' ? out.context : ''
    expect(context).toContain('token-goat section')
    expect(context).toContain('large.md')
  })

  it('scores the hint on the named command being run, not on the re-read being absent', () => {
    // Two files: the hint is shown once per file per compaction epoch, so a second Edit of the same one passes.
    const size = loadConfig().hints.reread_deny_min_bytes + 4096

    const ignored = nonce()
    expect(postEditHandler(editEvent('Edit', ignored, markdownFile('ignored.md', size))).hookType).toBe('context')
    for (let i = 0; i < 8; i++) resolvePendingHintsForEvent(bashEvent(ignored, `echo idle-${i}`))
    expect(rowsFor(ignored)).toEqual([{ category: 'edit_reread_suggest', displayed: 1, resolved: 1, acted_on: 0 }])

    const followed = nonce()
    const out = postEditHandler(editEvent('Edit', followed, markdownFile('followed.md', size)))
    const command = /`(token-goat [^`]+)`/.exec(out.hookType === 'context' ? out.context : '')?.[1]
    expect(command).toBeDefined()
    resolvePendingHintsForEvent(bashEvent(followed, command ?? ''))
    expect(rowsFor(followed)).toEqual([{ category: 'edit_reread_suggest', displayed: 1, resolved: 1, acted_on: 1 }])
  })
})
