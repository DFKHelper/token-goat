/**
 * Regression: `token-goat video-chapters` (cmdVideoChapters in src/cli.ts) never called
 * recordStat, and stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry had no `video_chapters` entry
 * either. It advertises itself as a surgical-read alternative to a raw Read of a video file's
 * chapter/subtitle metadata (via ffprobe) -- the same "read replacement" shape as pdf-meta/
 * xlsx-sheets/docx-outline -- but its dashboard bucket in `token-goat stats --full` stayed
 * permanently zero regardless of real usage, the same class of registry/producer desync already
 * fixed for those siblings (see cli_doc_extract_stats.test.ts / project_runchanged_missing_stat
 * memory). Drives the real, unmocked `run()` CLI entrypoint (only `node:child_process`'s
 * `spawnSync` is mocked, standing in for ffprobe) and asserts a real stats row appears via
 * summarize() against the real (test-isolated) global stats DB -- a synthetic recordStat/DB
 * insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'

const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}))

function ffprobeJson(): string {
  return JSON.stringify({
    chapters: [{ id: 0, start_time: '0.000000', end_time: '2.000000', tags: { title: 'Intro' } }],
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
  })
}

describe('`token-goat video-chapters` stat recording', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-statrec-videochapters-'))
    writeFileSync(join(root, 'clip.mp4'), Buffer.from('not a real video, ffprobe is mocked'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('records a video_chapters stat row through the real global stats DB', async () => {
    spawnSyncMock.mockReset()
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 }) // ffprobe -version availability probe
      .mockReturnValueOnce({ status: 0, stdout: ffprobeJson() }) // the real chapter/stream probe

    const { run } = await import('../src/cli.js')
    const { summarize } = await import('../src/stats.js')

    const before = summarize(30).by_kind['video_chapters']
    const beforeEvents = before?.events ?? 0

    await run(['node', 'token-goat', 'video-chapters', join(root, 'clip.mp4')])

    const after = summarize(30).by_kind['video_chapters']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })
})
