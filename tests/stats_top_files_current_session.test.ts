/** Regression: `token-goat stats` listed whichever session file was newest on disk, so run inside session A it showed files only session B had read. With CLAUDE_CODE_SESSION_ID set it now ranks that session's own blob merged with its salted subagent siblings, and the newest-file scan is labelled as not necessarily this session. Fixture provenance: HAND-DERIVED. Session blobs are written as plain JSON with explicit mtimes (A older, B newer) and read counts chosen by this test; the sibling filename comes from the writer's own `sessionFileStem`, so the test cannot drift from the writer's spelling. The e2e case spawns the built bundle. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MOST_RECENT_SESSION_HEADING, renderTopFilesForSession, renderTopSessionFilesFromDisk } from '../src/cli_stats.js'
import { sessionsDir } from '../src/sessions_dir.js'
import { sessionFileStem } from '../src/session_store.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

const PRIOR_TOKEN_GOAT_HOME = process.env.TOKEN_GOAT_HOME
let home: string

/** Write a session blob reading `filePath` `count` times, with the given mtime (seconds since epoch). */
function writeBlob(sessionKey: string, filePath: string, count: number, mtimeSec: number): void {
  fs.mkdirSync(sessionsDir(), { recursive: true })
  const p = path.join(sessionsDir(), `${sessionFileStem(sessionKey)}.json`)
  const entry = { path: filePath, readCount: count, lastReadAt: mtimeSec * 1000, wasEdited: false, sizeBytes: 10 }
  fs.writeFileSync(p, JSON.stringify({ files: [entry], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }))
  fs.utimesSync(p, mtimeSec, mtimeSec)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-topfiles-session-'))
  process.env.TOKEN_GOAT_HOME = home
  writeBlob('session-A', '/proj/a.ts', 3, 1_000_000)
  writeBlob('session-A:agent:sub1', '/proj/c.ts', 2, 1_000_500)
  writeBlob('session-B', '/proj/b.ts', 4, 2_000_000)
})

afterEach(() => {
  if (PRIOR_TOKEN_GOAT_HOME === undefined) delete process.env.TOKEN_GOAT_HOME
  else process.env.TOKEN_GOAT_HOME = PRIOR_TOKEN_GOAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

describe('stats top-files is scoped to the current session', () => {
  it('lists the named session and its subagent sibling, never a newer unrelated session', () => {
    const out = renderTopFilesForSession('session-A')
    expect(out).toContain('Top files this session:')
    expect(out).toContain('a.ts')
    expect(out).toContain('c.ts')
    expect(out).not.toContain('b.ts')
  })

  it('sums reads of one path across the session and its sibling', () => {
    writeBlob('session-A:agent:sub2', '/proj/a.ts', 2, 1_000_600)
    expect(renderTopFilesForSession('session-A')).toMatch(/5x {2}a\.ts/)
  })

  it('shows nothing for a session with no reads rather than borrowing another', () => {
    expect(renderTopFilesForSession('session-empty')).toBe('')
  })

  it('labels the newest-file fallback as not necessarily this session', () => {
    const out = renderTopSessionFilesFromDisk(5)
    expect(out).toContain(MOST_RECENT_SESSION_HEADING)
    expect(out).toContain('b.ts')
  })

  it('built bundle: session id set shows only that session, unset shows the labelled fallback', () => {
    const base = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home })
    const scoped = runBundle(['stats'], { env: { ...base, CLAUDE_CODE_SESSION_ID: 'session-A' } })
    expect(scoped.status, scoped.stderr).toBe(0)
    expect(scoped.stdout).toContain('a.ts')
    expect(scoped.stdout).not.toContain('b.ts')

    const env = { ...base }
    delete env['CLAUDE_CODE_SESSION_ID']
    const unset = runBundle(['stats'], { env })
    expect(unset.status, unset.stderr).toBe(0)
    expect(unset.stdout).toContain(MOST_RECENT_SESSION_HEADING)
    expect(unset.stdout).toContain('b.ts')
  })
})
