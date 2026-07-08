import { describe, expect, it, vi, beforeEach } from 'vitest'

const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}))

async function loadModule() {
  vi.resetModules()
  return await import('../src/video_chapters.js')
}

function ffprobeJson(chapters: unknown[], streams: unknown[]): string {
  return JSON.stringify({ chapters, streams })
}

describe('extractVideoChapters', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
  })

  it('throws a clear error when ffprobe is not on PATH', async () => {
    spawnSyncMock.mockReturnValue({ status: 1 })
    const { extractVideoChapters } = await loadModule()
    expect(() => extractVideoChapters('video.mp4')).toThrow(/ffprobe not found on PATH/)
  })

  it('parses chapters and subtitle streams from ffprobe JSON output', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 }) // -version probe
      .mockReturnValueOnce({
        status: 0,
        stdout: ffprobeJson(
          [
            { id: 0, start_time: '0.000000', end_time: '2.000000', tags: { title: 'Intro' } },
            { id: 1, start_time: '2.000000', end_time: '4.000000' },
          ],
          [
            { index: 0, codec_type: 'video', codec_name: 'h264' },
            { index: 1, codec_type: 'subtitle', codec_name: 'mov_text', tags: { language: 'eng' } },
          ],
        ),
      })
    const { extractVideoChapters } = await loadModule()
    const result = extractVideoChapters('video.mp4')
    expect(result.chapters).toEqual([
      { index: 0, startSeconds: 0, endSeconds: 2, title: 'Intro' },
      { index: 1, startSeconds: 2, endSeconds: 4, title: null },
    ])
    expect(result.subtitleStreams).toEqual([{ index: 1, codec: 'mov_text', language: 'eng', title: null }])
  })

  it('returns empty chapters/streams for a video with neither', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0, stdout: ffprobeJson([], []) })
    const { extractVideoChapters } = await loadModule()
    const result = extractVideoChapters('plain.mp4')
    expect(result.chapters).toEqual([])
    expect(result.subtitleStreams).toEqual([])
  })

  it('throws with ffprobe stderr when the probe invocation fails', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1, stderr: 'No such file or directory' })
    const { extractVideoChapters } = await loadModule()
    expect(() => extractVideoChapters('nope.mp4')).toThrow(/ffprobe failed to read nope\.mp4: No such file or directory/)
  })

  it('throws a clear error when ffprobe returns unparseable output', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0, stdout: 'not json' })
    const { extractVideoChapters } = await loadModule()
    expect(() => extractVideoChapters('video.mp4')).toThrow(/unparseable output/)
  })

  it('caches the ffprobe-availability check across calls', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: ffprobeJson([], []) })
      .mockReturnValueOnce({ status: 0, stdout: ffprobeJson([], []) })
    const { extractVideoChapters } = await loadModule()
    extractVideoChapters('a.mp4')
    extractVideoChapters('b.mp4')
    expect(spawnSyncMock).toHaveBeenCalledTimes(3)
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual(['-version'])
  })
})
