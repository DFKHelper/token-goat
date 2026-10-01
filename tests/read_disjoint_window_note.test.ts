import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Provenance: tool_input {file_path, offset, limit} is FORMAT-DERIVED from the Claude Code Read tool schema; the 300-line 'line N' body is HAND-DERIVED.

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

let home: string
let work: string
let file: string
let counter = 0

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(home, 'tg'),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'local'),
    APPDATA: path.join(home, 'roaming'),
    XDG_DATA_HOME: path.join(home, 'local'),
    TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode',
  }
}

function windowText(toolInput: Record<string, unknown>): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const offset = typeof toolInput.offset === 'number' ? toolInput.offset : 1
  const limit = typeof toolInput.limit === 'number' ? toolInput.limit : lines.length
  return lines.slice(offset - 1, offset - 1 + limit).join('\n')
}

function hook(event: 'pre_tool_use' | 'post_tool_use', session: string, toolInput: Record<string, unknown>): string {
  const payload: Record<string, unknown> = { tool_name: 'Read', tool_input: toolInput, session_id: session, cwd: work }
  if (event === 'post_tool_use') payload.tool_response = { type: 'text', file: { filePath: file, content: windowText(toolInput), numLines: 1 } }
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', event, '--harness', 'claudecode'], { cwd: work, env: env(), encoding: 'utf8', timeout: 30000, input: JSON.stringify(payload) })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout ?? ''
}

function sessionHintCount(): number {
  const res = spawnSync(process.execPath, [BUNDLE, 'stats', '--json', '--full', '--window-days', '0'], { cwd: work, env: env(), encoding: 'utf8', timeout: 30000 })
  const text = res.stdout ?? ''
  const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { by_kind?: Record<string, { count?: number }> }
  return parsed.by_kind?.session_hint?.count ?? 0
}

function newSession(): string {
  counter += 1
  return 'disjoint-' + counter + '-' + Date.now().toString(36)
}

function readThenRead(session: string, first: { offset: number; limit: number }, second: Record<string, unknown>): string {
  hook('pre_tool_use', session, { file_path: file, ...first })
  hook('post_tool_use', session, { file_path: file, ...first })
  return hook('pre_tool_use', session, { file_path: file, ...second })
}

describe('re-read note on a ranged Read', () => {
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-disjoint-home-'))
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-disjoint-work-'))
    file = path.join(work, 'notes.txt')
    fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n')
  })

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(work, { recursive: true, force: true })
  })

  it('emits no already-read note and books no session_hint for a window that overlaps nothing read before', () => {
    const session = newSession()
    const before = sessionHintCount()
    const out = readThenRead(session, { offset: 150, limit: 100 }, { offset: 1, limit: 100 })
    expect(out).not.toContain('already read this session')
    expect(sessionHintCount()).toBe(before)
  })

  it('keeps the note when the window overlaps one already read', () => {
    const out = readThenRead(newSession(), { offset: 150, limit: 100 }, { offset: 160, limit: 20 })
    expect(out).toContain('already read this session')
  })

  it('keeps the note when a whole-file read happened first', () => {
    const session = newSession()
    hook('pre_tool_use', session, { file_path: file, offset: 150, limit: 100 })
    hook('post_tool_use', session, { file_path: file, offset: 150, limit: 100 })
    hook('pre_tool_use', session, { file_path: file })
    // A 20-line window is under the 512-byte floor of the byte-for-byte served-lines deny, so the note path is what answers.
    hook('post_tool_use', session, { file_path: file })
    const out = hook('pre_tool_use', session, { file_path: file, offset: 1, limit: 20 })
    expect(out).toContain('already read this session')
  })
})
