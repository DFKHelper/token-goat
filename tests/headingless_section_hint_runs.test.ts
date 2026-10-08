// A hint that offers a section of a file with no headings must name a command that runs: `section` exits 1 on such a file and `::HeadingName` is a name no file holds.

// HAND-DERIVED: the fixture is a markdown body with no heading line, built independently of the hint code; the hint under test is what the real post-edit and pre-read handlers printed for it, and the command in it is run through the built bundle (dist/token-goat.mjs), so the check is the exit code and the text of a real run, not the emitter's own wording.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sectionOrRangeCommand } from '../src/hint_target.js'
import { postEditHandler } from '../src/hooks_edit.js'
import { preReadHandler } from '../src/hooks_read.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { recordFileRead } from '../src/session.js'
import { normalizePath } from '../src/paths.js'
import { BUNDLE } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'

let dir: string
let seq = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-headingless-hint-'))
})

afterEach(() => {
  saveConfig(defaultConfig())
  invalidateConfigCache()
  fs.rmSync(dir, { recursive: true, force: true })
})

function headinglessNotes(): string {
  const line = 'A line of plain notes with no heading marker anywhere in it, repeated to pad the file.\n'
  return line.repeat(400)
}

/** The first backticked `token-goat ...` command in `text`. */
function firstCommand(text: string): string {
  const found = /`(token-goat [^`]+)`/.exec(text)
  if (found === null) throw new Error('no command in: ' + text)
  return found[1] ?? ''
}

/** Runs a printed `token-goat <verb> "<arg>"` command through the built bundle, taking the one quoted argument as written. */
function runPrinted(command: string): { status: number | null; stdout: string; stderr: string } {
  const m = /^token-goat (\S+) "([^"]+)"$/.exec(command)
  if (m === null) throw new Error('unexpected command shape: ' + command)
  const res = spawnSync(process.execPath, [BUNDLE, m[1] ?? '', m[2] ?? ''], { encoding: 'utf8', cwd: dir })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('the section hint for a file with no headings', () => {
  it('post-edit names a range read that runs, not ::HeadingName', () => {
    seq += 1
    const p = path.join(dir, `notes-${seq}.md`)
    fs.writeFileSync(p, headinglessNotes())
    const out = postEditHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Write', toolInput: { file_path: p }, sessionId: `headingless-edit-${seq}` }))
    expect(out.hookType).toBe('context')
    const context = out.hookType === 'context' ? out.context : ''
    expect(context).not.toContain('HeadingName')
    const command = firstCommand(context)
    expect(command).toContain('::1-80')
    const ran = runPrinted(command)
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toContain('A line of plain notes')
  })

  it('a second read of the markdown file is denied with the same runnable command', () => {
    seq += 1
    const p = path.join(dir, `reread-${seq}.md`)
    fs.writeFileSync(p, headinglessNotes())
    const cfg = defaultConfig()
    cfg.hints.protect_recent_reads = 0
    saveConfig(cfg)
    recordFileRead(normalizePath(p))
    const event = (): ReturnType<typeof makeHookEvent> => makeHookEvent({ toolName: 'Read', toolInput: { file_path: p }, sessionId: `headingless-reread-${seq}` })
    const out = preReadHandler(event())
    expect(out.hookType).toBe('deny')
    const message = out.hookType === 'deny' ? out.message : ''
    expect(message).not.toContain('HeadingName')
    const ran = runPrinted(firstCommand(message))
    expect(ran.status, ran.stderr).toBe(0)
  })

  it('a real heading still gets the section command', () => {
    expect(sectionOrRangeCommand('notes.md', { name: 'Install', real: true, slice: 'section' })).toBe('token-goat section "notes.md::Install"')
    expect(sectionOrRangeCommand('notes.md', { name: 'SectionHeading', real: false, slice: 'section' })).toBe('token-goat read "notes.md::1-80"')
  })
})
