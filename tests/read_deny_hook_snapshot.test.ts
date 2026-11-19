// The Read hooks store no snapshot and inject nothing of their own for a path the host's Read rules deny.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionStateKey } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { loadSnapshotDiff } from '../src/hooks_read_slice.js'
import { normalizePath } from '../src/paths.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { recordFileRead } from '../src/session.js'
import { load as snapshotLoad, store as snapshotStore } from '../src/snapshots.js'
import { makeHookEvent } from './helpers/hook-event.js'

const dirs: string[] = []
let savedProject: string | undefined
let sid = 0

beforeEach(() => {
  savedProject = process.env['CLAUDE_PROJECT_DIR']
  resetReadDenyCache()
})

afterEach(() => {
  if (savedProject === undefined) delete process.env['CLAUDE_PROJECT_DIR']
  else process.env['CLAUDE_PROJECT_DIR'] = savedProject
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  resetReadDenyCache()
})

/** A project whose settings deny `secrets/**` or hold `settingsBody`, with docs in secrets/ and open/. */
function project(settingsBody?: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rdhook-')))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, '.claude'))
  const body = settingsBody ?? JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } })
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), body)
  for (const sub of ['secrets', 'open']) {
    fs.mkdirSync(path.join(dir, sub))
    fs.writeFileSync(path.join(dir, sub, 'doc.md'), '# Doc\n\nHIDDENBODYX line one.\n')
  }
  process.env['CLAUDE_PROJECT_DIR'] = dir
  return dir
}

function post(dir: string, file: string): ReturnType<typeof postReadHandler> {
  return postReadHandler(
    makeHookEvent({
      eventName: 'post_tool_use',
      toolInput: { file_path: file },
      sessionId: `rdhook-${process.pid}-${sid}`,
      raw: { cwd: dir, tool_response: fs.readFileSync(file, 'utf8') },
    }),
  )
}

const keyOf = (): string => sessionStateKey(makeHookEvent({ sessionId: `rdhook-${process.pid}-${sid}` }))

beforeEach(() => {
  sid += 1
})

describe('post-read snapshot', () => {
  it('stores a snapshot for an allowed doc (control)', () => {
    const dir = project()
    const file = path.join(dir, 'open', 'doc.md')
    post(dir, file)
    expect(snapshotLoad(keyOf(), normalizePath(file))).not.toBeNull()
  })

  it('stores nothing for a denied doc', () => {
    const dir = project()
    const file = path.join(dir, 'secrets', 'doc.md')
    expect(post(dir, file).hookType).toBe('pass')
    expect(snapshotLoad(keyOf(), normalizePath(file))).toBeNull()
  })

  it('stores nothing and does not throw when the settings cannot be read', () => {
    const dir = project('{ not json')
    const file = path.join(dir, 'open', 'doc.md')
    expect(() => post(dir, file)).not.toThrow()
    expect(snapshotLoad(keyOf(), normalizePath(file))).toBeNull()
  })
})

describe('a diff built from a stored snapshot', () => {
  it('is none for a denied path even when a snapshot of it exists', () => {
    const dir = project()
    const file = path.join(dir, 'secrets', 'doc.md')
    snapshotStore(keyOf(), normalizePath(file), Buffer.from('# Doc\n\nolder text\n'))
    expect(loadSnapshotDiff(keyOf(), normalizePath(file), 'doc.md').kind).toBe('none')
  })

  it('is served for an allowed path with a snapshot (control)', () => {
    const dir = project()
    const file = path.join(dir, 'open', 'doc.md')
    snapshotStore(keyOf(), normalizePath(file), Buffer.from('# Doc\n\nolder text\n'))
    expect(loadSnapshotDiff(keyOf(), normalizePath(file), 'doc.md').kind).toBe('diff')
  })
})

describe('pre-read', () => {
  it('passes through a denied doc re-read without a diff or text, and does not throw', () => {
    const dir = project()
    const file = path.join(dir, 'secrets', 'doc.md')
    snapshotStore(keyOf(), normalizePath(file), Buffer.from('# Doc\n\nolder text\n'))
    recordFileRead(normalizePath(file))
    const out = preReadHandler(
      makeHookEvent({
        toolInput: { file_path: file },
        sessionId: `rdhook-${process.pid}-${sid}`,
        raw: { cwd: dir },
      }),
    )
    expect(out.hookType).toBe('pass')
    expect(JSON.stringify(out)).not.toContain('HIDDENBODYX')
  })

  it('passes through with unreadable settings and does not throw', () => {
    const dir = project('{ not json')
    const file = path.join(dir, 'open', 'doc.md')
    expect(() =>
      preReadHandler(
        makeHookEvent({
          toolInput: { file_path: file },
          sessionId: `rdhook-${process.pid}-${sid}`,
          raw: { cwd: dir },
        }),
      ),
    ).not.toThrow()
  })
})
