/**
 * Reads embedded chapter markers and subtitle-stream metadata out of a video file via
 * `ffprobe`, so an agent can see a video's structure without downloading/transcoding it.
 * Gated on ffprobe being present on PATH; degrades with a clear message when it isn't.
 */

import { spawnSync } from 'node:child_process'

let _ffprobeAvailable: boolean | undefined

function isFfprobeAvailable(): boolean {
  if (_ffprobeAvailable !== undefined) return _ffprobeAvailable
  try {
    const res = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' })
    _ffprobeAvailable = res.status === 0
  } catch {
    _ffprobeAvailable = false
  }
  return _ffprobeAvailable
}

export interface VideoChapter {
  index: number
  startSeconds: number
  endSeconds: number
  title: string | null
}

export interface VideoSubtitleStream {
  index: number
  codec: string | null
  language: string | null
  title: string | null
}

export interface VideoChaptersResult {
  chapters: VideoChapter[]
  subtitleStreams: VideoSubtitleStream[]
}

interface FfprobeChapter {
  id: number
  start_time: string
  end_time: string
  tags?: { title?: string }
}

interface FfprobeStream {
  index: number
  codec_type: string
  codec_name?: string
  tags?: { language?: string; title?: string }
}

interface FfprobeOutput {
  chapters?: FfprobeChapter[]
  streams?: FfprobeStream[]
}

/** Reads chapters + subtitle-stream metadata from a video file via ffprobe. Throws a
 * clear "ffprobe not found" error if ffprobe isn't on PATH, or a parse error if
 * ffprobe's own invocation fails (e.g. the file isn't a media file it recognizes). */
export function extractVideoChapters(file: string): VideoChaptersResult {
  if (!isFfprobeAvailable()) {
    throw new Error('ffprobe not found on PATH; video-chapters requires ffmpeg (install ffmpeg and ensure ffprobe is on PATH)')
  }

  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_streams', file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) {
    const stderr = (res.stderr ?? '').trim()
    throw new Error(`ffprobe failed to read ${file}${stderr.length > 0 ? `: ${stderr}` : ''}`)
  }

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(res.stdout) as FfprobeOutput
  } catch {
    throw new Error(`ffprobe returned unparseable output for ${file}`)
  }

  const chapters: VideoChapter[] = (parsed.chapters ?? []).map((c) => ({
    index: c.id,
    startSeconds: Number.parseFloat(c.start_time),
    endSeconds: Number.parseFloat(c.end_time),
    title: c.tags?.title ?? null,
  }))

  const subtitleStreams: VideoSubtitleStream[] = (parsed.streams ?? [])
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? null,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
    }))

  return { chapters, subtitleStreams }
}
