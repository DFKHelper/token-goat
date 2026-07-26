/**
 * Regression: `token-goat gdrive-sections` (cmdGdriveSections in cli.ts) never called
 * recordStat at all, and stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no
 * `gdrive-sections`/`gdrive_sections` entry either -- so its dashboard bucket in
 * `token-goat stats --full` was permanently zero regardless of real usage, even though the
 * command's own description (install.ts's skill body: "outline a Google Doc by ID") advertises
 * itself as a surgical-read alternative to a raw fetch (same class of registry/producer desync
 * already fixed for map_lookup/changed_lookup/csv_query/brief_view/session_outline/session_slice
 * -- see project_runchanged_missing_stat memory). Drives the real, unmocked `run()` CLI
 * entrypoint against a real on-disk web-output cache entry (avoiding any live network fetch) and
 * asserts a real stats row appears via summarize() against the real (test-isolated) global stats
 * DB -- a synthetic recordStat/DB insert would not catch the original absence.
 */
import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'
import { storeWebOutput } from '../src/web_cache.js'

const DOC_TEXT = '# Overview\nThis is the overview section.\n\n# Details\nThis is the details section.\n'

describe('gdrive-sections stat recording', () => {
  it('`token-goat gdrive-sections` (outline mode) records a gdrive_sections stat row through the real global stats DB', async () => {
    const fileId = 'statrec-outline-doc'
    const url = `https://docs.google.com/document/d/${fileId}/export?format=markdown`
    storeWebOutput(url, DOC_TEXT)

    const before = summarize(30).by_kind['gdrive_sections']
    const beforeEvents = before?.events ?? 0

    await run(['node', 'token-goat', 'gdrive-sections', fileId])

    const after = summarize(30).by_kind['gdrive_sections']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })

  it('`token-goat gdrive-sections --heading` records a gdrive_sections stat row through the real global stats DB', async () => {
    const fileId = 'statrec-heading-doc'
    const url = `https://docs.google.com/document/d/${fileId}/export?format=markdown`
    storeWebOutput(url, DOC_TEXT)

    const before = summarize(30).by_kind['gdrive_sections']
    const beforeEvents = before?.events ?? 0

    await run(['node', 'token-goat', 'gdrive-sections', fileId, '--heading', 'Overview'])

    const after = summarize(30).by_kind['gdrive_sections']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })
})
