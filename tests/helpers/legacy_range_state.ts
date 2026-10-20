import { readFileSync, writeFileSync } from 'node:fs'

import { expect } from 'vitest'

import { sessionSidecarPath } from '../../src/session_store.js'

/** Turn the persisted state of session `sid` into one saved before ranges carried an identity: the line ranges stay, every recorded identity goes. FORMAT-DERIVED: coerce() in src/session_store.ts at 0880537c4^ emits `fileLineRangeIdentities` only when its list is non-empty and a files[] entry carries `rangeFileIdentity` only when one was stored, so that session is a real one with both removed. */
export function stripRangeIdentities(sid: string): void {
  const statePath = sessionSidecarPath(sid, '.json')
  if (statePath === null) throw new Error('no state path for ' + sid)
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { files?: Array<Record<string, unknown>>; fileLineRangeIdentities?: unknown; fileLineRanges?: unknown[] }
  expect(state.fileLineRanges?.length).toBeGreaterThan(0)
  delete state.fileLineRangeIdentities
  for (const entry of state.files ?? []) delete entry['rangeFileIdentity']
  writeFileSync(statePath, JSON.stringify(state))
}
