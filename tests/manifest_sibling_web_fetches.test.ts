/**
 * The compaction manifest's web-URL section must carry what subagents fetched, not only the parent.
 *
 * `selectManifestFiles` merges sibling subagent blobs so a file a subagent read survives compaction; the web-URL section was built from `getSessionWebFetches()` alone, which holds only the parent's in-memory state. A subagent's fetched URLs live in its own agent-salted blob on disk and reached nothing -- the exact loss the file merge exists to prevent, one section over. A fetched URL is the most expensive row in the manifest to lose: re-reading a file costs a read, while a URL nobody recorded is gone with the cache id that would have recalled it for free.
 *
 * Provenance: HAND-DERIVED. The sibling blobs are written through the real `saveSessionState`
 * under the same `${sessionId}:agent:${agentId}` key shape relay.ts's `sessionStateKey` builds,
 * so the on-disk layout under test is the production writer's, not a fixture's idea of it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { buildManifest } from '../src/manifest.js'
import { exportSessionState, importSessionState, recordWebFetch, recordFileRead } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'

// Captured before any test has touched the module-level session maps, so each `fetchAs` below can stand in for one hook process starting empty.
const EMPTY_STATE = JSON.parse(JSON.stringify(exportSessionState()))

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-manifest-web-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  importSessionState(JSON.parse(JSON.stringify(EMPTY_STATE)))
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

/** The same key shape relay.ts's `sessionStateKey` produces for a subagent. */
const agentKey = (sessionId: string, agentId: string): string => `${sessionId}:agent:${agentId}`

/** Record one web fetch under `key` and persist it, the way one subagent's hook process would. */
function fetchAs(key: string, url: string, prompt: string, cacheId: string): void {
  importSessionState(JSON.parse(JSON.stringify(EMPTY_STATE)))
  loadSessionState(key)
  recordWebFetch(url, prompt, cacheId)
  saveSessionState(key)
}

describe('compaction manifest web URLs across subagents', () => {
  const SESSION = 'f0e9d8c7-b6a5-4433-2211-000000000000'

  it('lists a URL a subagent fetched, not only the parent thread', () => {
    fetchAs(agentKey(SESSION, 'agent-one-11111111-1111-1111-1111-111111111111'), 'https://example.com/sub-a', 'what does this say', 'cafe1111')
    fetchAs(agentKey(SESSION, 'agent-two-22222222-2222-2222-2222-222222222222'), 'https://example.com/sub-b', '', 'cafe2222')

    // The parent thread, which is what runs pre_compact: its own fetch plus at least one read so the manifest has a file section to render alongside.
    importSessionState(JSON.parse(JSON.stringify(EMPTY_STATE)))
    loadSessionState(SESSION)
    recordFileRead('/proj/parent.ts')
    recordWebFetch('https://example.com/parent', '', 'cafe0000')

    const text = buildManifest(SESSION)

    expect(text).toContain('https://example.com/parent')
    expect(text).toContain('https://example.com/sub-a')
    expect(text).toContain('https://example.com/sub-b')
    // The cache id is the row's whole point: it is the handle that recalls the fetched body without paying for the fetch again, so a row that survived with the URL but lost the id is not a pass.
    expect(text).toContain('cafe1111')
    expect(text).toContain('cafe2222')
  })

  it('prints one row when the parent and a subagent fetched the same URL with the same prompt', () => {
    fetchAs(agentKey(SESSION, 'agent-one-11111111-1111-1111-1111-111111111111'), 'https://example.com/shared', 'same prompt', 'cafe3333')

    importSessionState(JSON.parse(JSON.stringify(EMPTY_STATE)))
    loadSessionState(SESSION)
    recordFileRead('/proj/parent.ts')
    recordWebFetch('https://example.com/shared', 'same prompt', 'cafe3333')

    const text = buildManifest(SESSION)
    const rows = text.split('\n').filter((line) => line.includes('https://example.com/shared'))
    expect(rows).toHaveLength(1)
  })
})
