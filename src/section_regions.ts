import {
  stripBlockCommentSpan,
  stripMultilineStringSpan,
  type MultilineStringState,
} from './languages/common.js'

export interface RegionSectionHeader {
  readonly heading: string
  readonly level: number
  readonly index: number
  readonly endIndex?: number
}

type HeadingFromMatch = (match: RegExpExecArray) => string | null
type LineMasker = (line: string) => string

const CSHARP_REGION_RE = /^\s*#\s*region(?:\s+(\S.*))?$/
const CSHARP_END_REGION_RE = /^\s*#\s*endregion\b/
const VB_REGION_RE = /^\s*#\s*Region\s+"((?:[^"]|"")*)"/i
const VB_END_REGION_RE = /^\s*#\s*End\s+Region\b/i

function findRegionHeaders(
  lines: readonly string[],
  startPattern: RegExp,
  endPattern: RegExp,
  headingFromMatch: HeadingFromMatch,
  maskLine: LineMasker = (line) => line,
): RegionSectionHeader[] {
  const headers: RegionSectionHeader[] = []
  const openHeaderIndices: Array<number | null> = []

  for (let i = 0; i < lines.length; i++) {
    const line = maskLine(lines[i] ?? '').trimEnd()
    const start = startPattern.exec(line)
    if (start !== null) {
      const heading = headingFromMatch(start)
      const headerIndex = heading === null ? null : headers.length
      if (heading !== null) headers.push({ heading, level: openHeaderIndices.length + 1, index: i })
      openHeaderIndices.push(headerIndex)
      continue
    }

    if (endPattern.test(line)) {
      const headerIndex = openHeaderIndices.pop()
      if (headerIndex === undefined || headerIndex === null) continue
      const header = headers[headerIndex]
      if (header !== undefined) headers[headerIndex] = { ...header, endIndex: i + 1 }
    }
  }

  return headers
}

function csharpDirectiveMasker(): LineMasker {
  let inBlockComment = false
  let stringState: MultilineStringState | null = null

  return (line) => {
    let code = line
    if (inBlockComment && stringState === null) {
      const commentEnd = line.indexOf('*/')
      if (commentEnd === -1) return ' '.repeat(line.length)
      code = `${' '.repeat(commentEnd + 2)}${line.slice(commentEnd + 2)}`
      inBlockComment = false
    }

    const stringMasked = stripMultilineStringSpan(code, stringState, 'csharp')
    stringState = stringMasked.state

    const commentMasked = stripBlockCommentSpan(stringMasked.code, inBlockComment)
    inBlockComment = commentMasked.inComment
    return commentMasked.code
  }
}

export function findCsharpRegionHeaders(lines: readonly string[]): RegionSectionHeader[] {
  return findRegionHeaders(
    lines,
    CSHARP_REGION_RE,
    CSHARP_END_REGION_RE,
    (match) => {
      const heading = (match[1] ?? '').trim()
      return heading === '' ? null : heading
    },
    csharpDirectiveMasker(),
  )
}

export function findVbRegionHeaders(lines: readonly string[]): RegionSectionHeader[] {
  return findRegionHeaders(
    lines,
    VB_REGION_RE,
    VB_END_REGION_RE,
    (match) => (match[1] ?? '').replace(/""/g, '"'),
  )
}
