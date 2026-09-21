/**
 * Regression: `token-goat stats` rendered its top-files section from `dataDir()/sessions`, a directory nothing has ever written to, while every session blob is written under `tokenGoatHome()/sessions`. The read found an empty directory, returned `''`, and the section was silently absent from every shipped build. Reader and writer now share `sessionsDir()`.
 *
 * Both cases drive the SHIPPING path. `renderTopSessionFilesFromDisk` is called with no `overrideSessionsDir` -- the injected seam every previous test supplied, which is why the shipping default argument was never once exercised -- and the end-to-end case spawns the built bundle and asserts on the rendered `stats` output rather than re-deriving the ranking the function under test performs.
 *
 * Fixture provenance: CAPTURE. The session JSON is written by the real writer (`recordFileRead` from src/session.ts, persisted by `saveSessionState` from src/session_store.ts), not hand-authored, so it pins the reader to the writer's own on-disk location and record shape rather than to a schema this test invented.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderTopSessionFilesFromDisk } from '../src/cli_stats.js'
import { recordFileRead } from '../src/session.js'
import { sessionsDir } from '../src/sessions_dir.js'
import { saveSessionState } from '../src/session_store.js'
import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

const PRIOR_TOKEN_GOAT_HOME = process.env.TOKEN_GOAT_HOME
let home: string
let workDir: string

/** Record `path` as read `count` times through the real session recorder and persist it with the real writer. */
function writeSessionBlob(sessionId: string, filePath: string, count: number): void {
  for (let i = 0; i < count; i++) recordFileRead(filePath)
  saveSessionState(sessionId)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-topfiles-home-'))
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-topfiles-work-'))
  process.env.TOKEN_GOAT_HOME = home
})

afterEach(() => {
  if (PRIOR_TOKEN_GOAT_HOME === undefined) delete process.env.TOKEN_GOAT_HOME
  else process.env.TOKEN_GOAT_HOME = PRIOR_TOKEN_GOAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('stats top-files reads the directory the session writer writes to', () => {
  it('renders the top files from a blob the real writer persisted, with no override supplied', () => {
    const tracked = path.join(workDir, 'hot-file.ts')
    fs.writeFileSync(tracked, 'export const a = 1\n', 'utf-8')
    writeSessionBlob('topfiles-default-arg', tracked, 4)

    // The writer's own location, asserted before the reader's: if these ever diverge again the failure names which half moved.
    expect(fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'))).toHaveLength(1)

    const rendered = renderTopSessionFilesFromDisk(5)
    expect(rendered).toContain('Top files this session:')
    expect(rendered).toContain('hot-file.ts')
    expect(rendered).toContain('4x')
  })

  it('renders nothing when the session store is genuinely empty', () => {
    fs.mkdirSync(sessionsDir(), { recursive: true })
    expect(renderTopSessionFilesFromDisk(5)).toBe('')
  })

  it('the built bundle prints the section for a real session blob and omits it for an empty store', () => {
    const env = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home })

    const empty = runBundle(['stats'], { env })
    expect(empty.status, empty.stderr).toBe(0)
    expect(empty.stdout).not.toContain('Top files this session:')

    const tracked = path.join(workDir, 'bundle-hot-file.ts')
    fs.writeFileSync(tracked, 'export const b = 2\n', 'utf-8')
    writeSessionBlob('topfiles-bundle-e2e', tracked, 3)

    const populated = runBundle(['stats'], { env })
    expect(populated.status, populated.stderr).toBe(0)
    expect(populated.stdout).toContain('Top files this session:')
    expect(populated.stdout).toContain('bundle-hot-file.ts')
  })
})
