import * as fs from 'fs'
import { FILTERS } from './filters.js'
import { displaySafeText, displaySafeJson } from './paths.js'
import { requireNonNegativeStrictInt } from './util.js'

const VOLATILE_SUBS: Array<{ re: RegExp; placeholder: string }> = [
  { re: /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, placeholder: '[HH:MM:SS]' },
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, placeholder: '[UUID]' },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, placeholder: '[IP]' },
  { re: /\b[0-9a-f]{8,}\b/g, placeholder: '[HEX]' },
  { re: /(?<![A-Za-z0-9_])\d+(?![A-Za-z0-9_])/g, placeholder: '[N]' },
]

function normalizeVolatile(line: string): string {
  let out = line
  for (const sub of VOLATILE_SUBS) {
    out = out.replace(sub.re, sub.placeholder)
  }
  return out
}

interface FoldedLine {
  text: string
  count: number
}

const MAX_FOLD_REPEATS_KEYS = 20_000

function applyFiltersAndFold(lines: string[], noNormalize: boolean, foldRepeats: boolean): FoldedLine[] {
  const dropped: string[] = []
  for (const raw of lines) {
    let cur: string | null = raw
    for (const filter of FILTERS) {
      if (cur === null) break
      if (filter.pattern !== null && !filter.pattern.test(cur)) continue
      cur = filter.replacer(cur)
      break
    }
    if (cur !== null) dropped.push(cur)
  }

  const folded: FoldedLine[] = []

  if (!foldRepeats) {
    let prevKey: string | null = null
    let lastText = ''
    let count = 0
    for (const line of dropped) {
      const key = noNormalize ? line : normalizeVolatile(line)
      if (key === prevKey) {
        count++
      } else {
        if (prevKey !== null) folded.push({ text: lastText, count })
        prevKey = key
        lastText = line
        count = 1
      }
    }
    if (prevKey !== null) folded.push({ text: lastText, count })
    return folded
  }

  const keyIndex = new Map<string, number>()
  let prevKey: string | null = null
  for (const line of dropped) {
    const key = noNormalize ? line : normalizeVolatile(line)
    const seenIdx = keyIndex.get(key)
    if (seenIdx !== undefined) {
      const entry = folded[seenIdx]
      if (entry !== undefined) entry.count++
    } else if (key === prevKey && folded.length > 0) {
      const entry = folded[folded.length - 1]
      if (entry !== undefined) entry.count++
    } else {
      folded.push({ text: line, count: 1 })
      if (keyIndex.size < MAX_FOLD_REPEATS_KEYS) keyIndex.set(key, folded.length - 1)
    }
    prevKey = key
  }
  return folded
}

function readInput(src: string | undefined): string {
  if (src !== undefined) return fs.readFileSync(src, 'utf8')
  return fs.readFileSync(0, 'utf8')
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

export function cmdLogfold(
  src: string | undefined,
  opts: { tail?: string | undefined; noNormalize?: boolean; foldRepeats?: boolean | undefined; json?: boolean | undefined },
): void {
  const text = readInput(src)
  const rawLines = splitLines(text)
  const allLines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  let lines = allLines
  if (opts.tail !== undefined) {
    const n = requireNonNegativeStrictInt('--tail', opts.tail)
    lines = lines.slice(Math.max(0, lines.length - n))
  }
  const inputLines = allLines.length
  const shownLines = lines.length
  const truncated = shownLines < inputLines

  const folded = applyFiltersAndFold(lines, opts.noNormalize === true, opts.foldRepeats === true)

  if (truncated) {
    process.stderr.write(`Showing last ${shownLines} of ${inputLines} lines (raise --tail to see more).\n`)
  }

  if (opts.json === true) {
    process.stdout.write(displaySafeJson({ lines: folded, truncated, inputLines, shownLines }) + '\n')
    return
  }

  for (const item of folded) {
    if (item.count > 1) {
      process.stdout.write(`${displaySafeText(item.text)}  (x${item.count})\n`)
    } else {
      process.stdout.write(`${displaySafeText(item.text)}\n`)
    }
  }
}
