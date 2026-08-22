/**
 * The agent salt in a session-state filename must survive the 64-char filename cap.
 *
 * `relay.ts`'s `sessionStateKey` builds `${sessionId}:agent:${agentId}` so, in its own words,
 * "a subagent's genuinely-first read of a file [is not] denied as 'already read' because a
 * *different* subagent read it earlier". That whole key used to be sanitized and sliced at 64
 * as one string, so a long session id pushed the salt off the end: at 58 sanitized characters
 * the 7-char `_agent_` marker itself was cut, and every subagent in the session -- and at 64
 * the parent too -- mapped onto one file. Two failures follow, and both are silent:
 *
 *  - a subagent is told it has already read a file it has never seen, and
 *  - `listSiblingSessionStates` built its match prefix with NO length cap and compared it
 *    against filenames that had been capped, so it could never match, and the `pre_compact`
 *    manifest reported "Files read: 0" while real work had been done.
 *
 * Session ids arrive off the wire from whatever harness is driving, and `CLAUDE_CODE_SESSION_ID`
 * is a plain env var a wrapper can set to any descriptive string, so long ids are not exotic.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listSiblingSessionStates, loadSessionState, saveSessionState, SESSIONS_SUBDIR } from '../src/session_store.js'
import { exportSessionState, importSessionState, recordFileRead } from '../src/session.js'

// Captured before any test has touched the module-level session maps. Each `readAs` below stands
// in for one hook PROCESS, and in production each of those really is a fresh process with empty
// maps -- `loadSessionState` returns early when a session has no file yet rather than clearing
// what is already in memory, which is correct there and would leak between calls here.
const EMPTY_STATE = JSON.parse(JSON.stringify(exportSessionState()))

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-salt-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

/** The same key shape relay.ts's `sessionStateKey` produces for a subagent. */
const agentKey = (sessionId: string, agentId: string): string => `${sessionId}:agent:${agentId}`

/** Record one file read under `key` and persist it, the way one hook process would. */
function readAs(key: string, filePath: string): void {
  importSessionState(JSON.parse(JSON.stringify(EMPTY_STATE)))
  loadSessionState(key)
  recordFileRead(filePath)
  saveSessionState(key)
}

/** Every session blob currently on disk. */
function sessionFiles(): string[] {
  const dir = path.join(tmpHome, SESSIONS_SUBDIR)
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}

// 36 is a UUID, the shape that always worked. The rest bracket the old 58/64 cliffs, and 90 is
// a wrapper-supplied descriptive id. Parameterized because the defect was purely a function of
// this length -- a single short id passes against the buggy code.
const SESSION_IDS: Array<[string, string]> = [
  ['uuid-length (36)', 'a'.repeat(36)],
  ['just under the old cliff (57)', 'b'.repeat(57)],
  ['at the old cliff (58)', 'c'.repeat(58)],
  ['at the filename cap (64)', 'd'.repeat(64)],
  ['past the cap (90)', 'e'.repeat(90)],
]

describe('subagent session state keyed by a long session id', () => {
  it.each(SESSION_IDS)('keeps two sibling subagents apart: %s', (_label, sessionId) => {
    readAs(agentKey(sessionId, 'agent-one-11111111-1111-1111-1111-111111111111'), '/proj/a.ts')
    readAs(agentKey(sessionId, 'agent-two-22222222-2222-2222-2222-222222222222'), '/proj/a.ts')

    // Two subagents, two blobs. One blob means they shared state, which is exactly the
    // already-read denial the salt exists to prevent.
    expect(sessionFiles()).toHaveLength(2)
  })

  it.each(SESSION_IDS)('keeps a subagent apart from its own parent: %s', (_label, sessionId) => {
    readAs(sessionId, '/proj/a.ts')
    readAs(agentKey(sessionId, 'agent-one-11111111-1111-1111-1111-111111111111'), '/proj/a.ts')

    expect(sessionFiles()).toHaveLength(2)
  })

  it.each(SESSION_IDS)('finds the subagent blobs from the parent id: %s', (_label, sessionId) => {
    readAs(agentKey(sessionId, 'agent-one-11111111-1111-1111-1111-111111111111'), '/proj/a.ts')
    readAs(agentKey(sessionId, 'agent-two-22222222-2222-2222-2222-222222222222'), '/proj/b.ts')

    const siblings = listSiblingSessionStates(sessionId)

    // This is what the pre_compact manifest counts. Zero here is the "Files read: 0" report.
    expect(siblings).toHaveLength(2)
    const paths = siblings.flatMap((s) => s.files.map((f) => f.path)).sort()
    expect(paths).toEqual(['/proj/a.ts', '/proj/b.ts'])
  })

  it('still spells a plain session id as its own exact filename', () => {
    // The salted form is hashed, but the non-salted form must stay human-readable and exact --
    // session_persistence_e2e.test.ts and anyone looking in ~/.token-goat/sessions rely on it.
    readAs('plain-session-id', '/proj/a.ts')

    expect(sessionFiles()).toEqual(['plain-session-id.json'])
  })

  it('does not treat every salted blob as a sibling of an id that sanitizes to nothing', () => {
    readAs(agentKey('real-session', 'agent-one'), '/proj/a.ts')

    // '///' sanitizes to '___', not empty -- use a genuinely empty-sanitizing id. An id that
    // reduces to nothing would otherwise leave the bare `_agent_` marker as the match prefix,
    // which starts every salted filename on disk regardless of which session wrote it.
    expect(listSiblingSessionStates('')).toEqual([])
  })
})
