/**
 * Regression coverage for the "silently missing recordStat" bug class (see MEMORY.md's
 * project_runchanged_missing_stat entry): stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry
 * having a live entry for a kind is not proof the command that owns it actually calls
 * recordStat -- several prior commands (map, gdrive-sections, ...) carried a registry entry for
 * years with nothing ever writing the row. Drives the real, unmocked `run()` CLI entrypoint for
 * note-add/note-get/note-list and asserts a real stats row appears via summarize() against the
 * real (test-isolated) global stats DB.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'

function eventsFor(kind: string): number {
  return summarize(30).by_kind[kind]?.events ?? 0
}

describe('note-add / note-get / note-list stat recording', () => {
  it('`token-goat note-add` records a note_write stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-noteadd-'))
    try {
      const file = join(root, 'doc.md')
      writeFileSync(file, '# doc\n')

      const before = eventsFor('note_write')
      await run(['node', 'token-goat', 'note-add', file, '--content-b64', Buffer.from('note body').toString('base64')])
      expect(eventsFor('note_write')).toBeGreaterThan(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('`token-goat note-get` records a note_read stat row through the real global stats DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-statrec-noteget-'))
    try {
      const file = join(root, 'doc.md')
      writeFileSync(file, '# doc\n')
      await run(['node', 'token-goat', 'note-add', file, '--content-b64', Buffer.from('note body').toString('base64')])

      const before = eventsFor('note_read')
      await run(['node', 'token-goat', 'note-get', file])
      expect(eventsFor('note_read')).toBeGreaterThan(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('`token-goat note-list` records a note_list stat row through the real global stats DB', async () => {
    const before = eventsFor('note_list')
    await run(['node', 'token-goat', 'note-list'])
    expect(eventsFor('note_list')).toBeGreaterThan(before)
  })
})
