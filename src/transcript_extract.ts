/**
 * Zero-dependency WebVTT/SRT transcript reader. Both formats are cue blocks of
 * `TIMESTAMP --> TIMESTAMP` followed by one or more text lines, separated by a blank line.
 * VTT timestamps use `.` for the millisecond separator and allow an optional cue identifier
 * line and trailing cue-settings after the arrow; SRT timestamps use `,` and always prefix
 * each cue with a numeric index line. A speaker is read from a leading `<v Name>` tag (VTT,
 * e.g. Teams-exported captions) or a leading `Name:` prefix (common in both formats when the
 * source tool doesn't use `<v>` tags).
 */

import * as fs from 'node:fs'

export interface TranscriptCue {
  index: number
  startSeconds: number
  endSeconds: number
  speaker: string | null
  text: string
}

const TIMESTAMP_RE = /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})/
const CUE_LINE_RE = new RegExp(`^\\s*${TIMESTAMP_RE.source}\\s*-->\\s*${TIMESTAMP_RE.source}`)
const V_TAG_RE = /^<v(?:\.\w+)?\s+([^>]+)>\s*(.*)$/
const NAME_PREFIX_RE = /^([A-Za-z][\w .'-]{0,40}):\s+(.*)$/

function parseTimestamp(text: string): number {
  const m = TIMESTAMP_RE.exec(text)
  if (!m) throw new Error(`invalid timestamp: ${text}`)
  const hours = m[1] !== undefined ? parseInt(m[1].replace(':', ''), 10) : 0
  const minutes = parseInt(m[2] as string, 10)
  const seconds = parseInt(m[3] as string, 10)
  const millisStr = (m[4] as string).padEnd(3, '0')
  const millis = parseInt(millisStr, 10)
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

function extractSpeaker(text: string): { speaker: string | null; text: string } {
  const vMatch = V_TAG_RE.exec(text)
  if (vMatch) return { speaker: (vMatch[1] as string).trim(), text: (vMatch[2] as string).trim() }
  const nameMatch = NAME_PREFIX_RE.exec(text)
  if (nameMatch) return { speaker: (nameMatch[1] as string).trim(), text: (nameMatch[2] as string).trim() }
  return { speaker: null, text: text.trim() }
}

export function parseTranscript(content: string): TranscriptCue[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const cues: TranscriptCue[] = []
  let index = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (CUE_LINE_RE.test(line)) {
      const arrowIdx = line.indexOf('-->')
      const startSeconds = parseTimestamp(line.slice(0, arrowIdx))
      const endSeconds = parseTimestamp(line.slice(arrowIdx + 3))
      i++
      const textLines: string[] = []
      while (i < lines.length && (lines[i] as string).trim().length > 0) {
        textLines.push(lines[i] as string)
        i++
      }
      const rawText = textLines.join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const firstLineForSpeaker = textLines[0] ?? ''
      // Extract the speaker only once. A `<v Name>` tag on the raw first line already resolves the
      // speaker unambiguously, so the leading-`Name:` prefix heuristic must not run a second time on
      // rawText in that case -- it would otherwise mistake ordinary dialogue text that happens to
      // start with "Word:" (e.g. "Bob said: hello") for a redundant speaker label and strip it.
      const vTagSpeaker = extractSpeaker(firstLineForSpeaker)
      const { speaker, text } = V_TAG_RE.test(firstLineForSpeaker)
        ? { speaker: vTagSpeaker.speaker, text: rawText }
        : extractSpeaker(rawText)
      index++
      cues.push({ index, startSeconds, endSeconds, speaker, text })
    } else {
      i++
    }
  }
  return cues
}

export function readTranscript(filePath: string): TranscriptCue[] {
  const content = fs.readFileSync(filePath, 'utf8')
  return parseTranscript(content)
}

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function parseClockSpec(spec: string): number {
  const parts = spec.split(':').map((p) => parseInt(p, 10))
  if (parts.some((p) => Number.isNaN(p))) throw new Error(`invalid time spec: ${spec} (expected HH:MM:SS)`)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, s] = parts as [number, number, number]
  return h * 3600 + m * 60 + s
}

export interface TranscriptOutlineEntry {
  timestamp: string
  preview: string
}

export interface TranscriptOutline {
  speakers: Array<{ name: string; cueCount: number }>
  durationSeconds: number
  markers: TranscriptOutlineEntry[]
}

export function buildTranscriptOutline(cues: TranscriptCue[], bucketCount = 10): TranscriptOutline {
  if (cues.length === 0) return { speakers: [], durationSeconds: 0, markers: [] }

  const speakerCounts = new Map<string, number>()
  for (const cue of cues) {
    if (cue.speaker !== null) speakerCounts.set(cue.speaker, (speakerCounts.get(cue.speaker) ?? 0) + 1)
  }
  const speakers = [...speakerCounts.entries()].map(([name, cueCount]) => ({ name, cueCount }))

  // Cues are not guaranteed to be in chronological array order (multi-track exports,
  // corrected/appended captions), so the last array element is not necessarily the one
  // with the latest end time -- use the true max across all cues instead.
  const durationSeconds = Math.max(...cues.map((c) => c.endSeconds))
  const bucketSize = durationSeconds / Math.min(bucketCount, cues.length)
  const markers: TranscriptOutlineEntry[] = []
  let nextBucketStart = 0
  for (const cue of cues) {
    if (cue.startSeconds >= nextBucketStart) {
      const preview = cue.text.slice(0, 60) + (cue.text.length > 60 ? '...' : '')
      markers.push({ timestamp: formatTimestamp(cue.startSeconds), preview })
      nextBucketStart += bucketSize
    }
  }
  return { speakers, durationSeconds, markers }
}

export interface TranscriptSliceOptions {
  speaker?: string
  fromSeconds?: number
  toSeconds?: number
  grep?: string
}

export function parseSliceOptions(opts: { speaker?: string; from?: string; to?: string; grep?: string }): TranscriptSliceOptions {
  return {
    ...(opts.speaker !== undefined ? { speaker: opts.speaker } : {}),
    ...(opts.from !== undefined ? { fromSeconds: parseClockSpec(opts.from) } : {}),
    ...(opts.to !== undefined ? { toSeconds: parseClockSpec(opts.to) } : {}),
    ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
  }
}

export function sliceTranscript(cues: TranscriptCue[], opts: TranscriptSliceOptions): TranscriptCue[] {
  const re = opts.grep !== undefined ? new RegExp(opts.grep, 'i') : undefined
  return cues.filter((cue) => {
    if (opts.speaker !== undefined && cue.speaker?.toLowerCase() !== opts.speaker.toLowerCase()) return false
    if (opts.fromSeconds !== undefined && cue.startSeconds < opts.fromSeconds) return false
    if (opts.toSeconds !== undefined && cue.startSeconds > opts.toSeconds) return false
    if (re !== undefined && !re.test(cue.text)) return false
    return true
  })
}

export function formatCues(cues: TranscriptCue[]): string {
  return cues
    .map((cue) => `[${formatTimestamp(cue.startSeconds)}]${cue.speaker !== null ? ` ${cue.speaker}:` : ''} ${cue.text}`)
    .join('\n')
}
