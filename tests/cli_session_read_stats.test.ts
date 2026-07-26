/**
 * Regression: `token-goat session-outline` and `token-goat session-slice` (cmdSessionOutline/
 * cmdSessionSlice in cli.ts) never called recordStat at all, and stats.ts's KIND_TO_SOURCE/
 * COMMAND_KINDS registry had no `session-outline`/`session-slice` entry either -- so their
 * dashboard buckets in `token-goat stats --full` were permanently zero regardless of real usage,
 * even though both commands' own descriptions advertise themselves as "instead of a raw Read"
 * (same class of registry/producer desync fixed for map_lookup/changed_lookup/csv_query/
 * brief_view, see project_runchanged_missing_stat memory). Drives the real, unmocked `run()` CLI
 * entrypoint against a real scratch transcript and asserts a real stats row appears via
 * summarize() against the real (test-isolated) global stats DB -- a synthetic recordStat/DB
 * insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

function writeFakeTranscript(path: string): void {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'read config.ts please' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/config.ts' } }] },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export const X = 1'.repeat(20) }] }] },
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'config.ts exports X.' }] } },
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

describe('session-outline/session-slice stat recording', () => {
  it('`token-goat session-outline` records a session_outline stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-session-outline-'))
    try {
      const transcript = join(root, 'fake-session.jsonl')
      writeFakeTranscript(transcript)

      const before = summarize(30).by_kind['session_outline']
      const beforeEvents = before?.events ?? 0

      await run(['node', 'token-goat', 'session-outline', transcript])

      const after = summarize(30).by_kind['session_outline']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('`token-goat session-slice` records a session_slice stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-session-slice-'))
    try {
      const transcript = join(root, 'fake-session.jsonl')
      writeFakeTranscript(transcript)

      const before = summarize(30).by_kind['session_slice']
      const beforeEvents = before?.events ?? 0

      await run(['node', 'token-goat', 'session-slice', transcript, '--range', '1-2'])

      const after = summarize(30).by_kind['session_slice']
      expect(after).toBeDefined()
      expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
