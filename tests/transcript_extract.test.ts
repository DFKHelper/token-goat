import { describe, expect, it } from 'vitest'
import {
  buildTranscriptOutline,
  formatCues,
  formatTimestamp,
  parseSliceOptions,
  parseTranscript,
  sliceTranscript,
} from '../src/transcript_extract.js'

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
<v Alice>Welcome everyone to the quarterly review.

2
00:00:05.500 --> 00:00:10.000
<v Bob>Thanks Alice. Let's start with revenue numbers.

3
00:05:00.000 --> 00:05:08.000
<v Alice>Revenue grew twenty percent year over year.
`

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello and welcome to the show.

2
00:00:04,500 --> 00:00:08,000
Today we discuss the widget launch.
`

describe('parseTranscript', () => {
  it('parses VTT cues with <v Name> speaker tags', () => {
    const cues = parseTranscript(VTT)
    expect(cues).toHaveLength(3)
    expect(cues[0]).toMatchObject({ speaker: 'Alice', text: 'Welcome everyone to the quarterly review.' })
    expect(cues[0]?.startSeconds).toBe(1)
    expect(cues[0]?.endSeconds).toBe(5)
    expect(cues[2]?.startSeconds).toBe(300)
  })

  it('parses SRT cues with no speaker tag', () => {
    const cues = parseTranscript(SRT)
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({ speaker: null, text: 'Hello and welcome to the show.' })
    expect(cues[1]?.startSeconds).toBe(4.5)
  })

  it('recognizes a leading Name: prefix as a speaker when there is no <v> tag', () => {
    const content = `1\n00:00:01,000 --> 00:00:02,000\nAlice: hi there\n`
    const cues = parseTranscript(content)
    expect(cues[0]).toMatchObject({ speaker: 'Alice', text: 'hi there' })
  })

  it('returns an empty array for content with no cue timestamps', () => {
    expect(parseTranscript('not a transcript file')).toEqual([])
  })
})

describe('formatTimestamp', () => {
  it('formats seconds as HH:MM:SS', () => {
    expect(formatTimestamp(0)).toBe('00:00:00')
    expect(formatTimestamp(65)).toBe('00:01:05')
    expect(formatTimestamp(3661)).toBe('01:01:01')
  })
})

describe('buildTranscriptOutline', () => {
  it('lists unique speakers with cue counts and a duration', () => {
    const outline = buildTranscriptOutline(parseTranscript(VTT))
    expect(outline.speakers).toEqual(
      expect.arrayContaining([
        { name: 'Alice', cueCount: 2 },
        { name: 'Bob', cueCount: 1 },
      ]),
    )
    expect(outline.durationSeconds).toBe(308)
    expect(outline.markers.length).toBeGreaterThan(0)
  })

  it('returns an empty outline for zero cues', () => {
    expect(buildTranscriptOutline([])).toEqual({ speakers: [], durationSeconds: 0, markers: [] })
  })
})

describe('sliceTranscript', () => {
  const cues = parseTranscript(VTT)

  it('filters by speaker case-insensitively', () => {
    const sliced = sliceTranscript(cues, parseSliceOptions({ speaker: 'alice' }))
    expect(sliced).toHaveLength(2)
    expect(sliced.every((c) => c.speaker === 'Alice')).toBe(true)
  })

  it('filters by --from time range', () => {
    const sliced = sliceTranscript(cues, parseSliceOptions({ from: '00:01:00' }))
    expect(sliced).toHaveLength(1)
    expect(sliced[0]?.text).toContain('Revenue')
  })

  it('filters by --grep pattern', () => {
    const sliced = sliceTranscript(cues, parseSliceOptions({ grep: 'revenue' }))
    expect(sliced).toHaveLength(2)
  })

  it('combines multiple filters as AND', () => {
    const sliced = sliceTranscript(cues, parseSliceOptions({ speaker: 'Alice', grep: 'twenty' }))
    expect(sliced).toHaveLength(1)
  })
})

describe('formatCues', () => {
  it('renders timestamp, speaker, and text', () => {
    const cues = parseTranscript(VTT).slice(0, 1)
    expect(formatCues(cues)).toBe('[00:00:01] Alice: Welcome everyone to the quarterly review.')
  })

  it('omits the speaker segment when there is none', () => {
    const cues = parseTranscript(SRT).slice(0, 1)
    expect(formatCues(cues)).toBe('[00:00:01] Hello and welcome to the show.')
  })
})
