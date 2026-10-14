import * as fs from 'node:fs'

import { querySymbols } from './index_reader.js'
import { ATX_CLASS_BREAK_RE, matchAtxHeading } from './line_matchers.js'
import { eachUnfencedLine } from './markdown_lines.js'
import { detectLanguage } from './parser_types.js'
import { displaySafeJson } from './paths.js'
import { capFileLines, guardText, healStaleIndex, linesWithinChars, readFileText, recordReadStat, resolveAgainstProjectRoot, sumFileSizes } from './read_commands.js'
import { forClient } from './mcp_client_text.js'
import { namedSpecsMergeable, stripHtmlIdSpelling, parseCrossFileMultiSpec } from './read_spec.js'
import { didYouMean, filterSimilarHeadings } from './read_suggest.js'
import { listSections, readSection, type SectionResult } from './section_reader.js'
import { compileGrepMatcher, countNoun } from './util.js'
import { grepFilteredToEmptyNotice } from './filter_notice.js'
import { echoedValue, quotedArg } from './hint_suggestion_guard.js'

// `readSection` only ever resolves headings from the file's own text; a non-heading html element (`<section id="chart1-panel">`) is invisible to it even after the extractor spans its whole element (html.ts::extractHtml), because that span lives in the symbols table, not in the file's heading list. Fall back to an html_id symbol lookup for html files only, so `section "file.html::chart1-panel"` (or the `#chart1-panel` spelling) resolves the same element `read`/`symbol` already do.
function htmlIdSectionFallback(filePath: string, heading: string): SectionResult | null {
  if (detectLanguage(filePath) !== 'html') return null
  healStaleIndex(filePath)
  const hit = querySymbols({ name: stripHtmlIdSpelling(heading, filePath), filePath, kind: 'html_id', limit: 1 })[0]
  if (hit === undefined) return null
  const text = readFileText(filePath)
  if (text === null) return null
  const lines = text.split('\n')
  return { heading: hit.name, content: lines.slice(hit.lineStart - 1, hit.lineEnd).join('\n'), lineStart: hit.lineStart, lineEnd: hit.lineEnd }
}

export const AMBIGUOUS_HEADING_LIMIT = 10

export interface SectionOptions {
  spec: string
  json?: boolean
  /** Internal: true when run as a sub-call of runSectionMulti, which tallies fullSourceBytes once for the whole call rather than once per heading. */
  suppressStat?: boolean
  /** Project root to scope relative paths against. Defaults to process.cwd() when unset, matching runRead/runSymbol's projectRoot option. */
  projectRoot?: string
  /** Maximum number of content lines to return from the top of the section. */
  maxLines?: number
  /** Keep only the section body lines matching this pattern (regex, literal substring when invalid), each under its nearest sub-heading. */
  grep?: string
  /** Characters the printed section is held to, paging past them with a `read "file@A-B"` continuation; the CLI passes {@link outputCeilingChars}, and the MCP tool passes none, so its answers are unchanged. A multi-section call splits it across its sections ({@link perSectionOpts}). */
  maxChars?: number
}

// Keeps the section's own first line plus each matching line, preceded once by the nearest heading line above it, so a surviving line stays attributable to its sub-section.
function filterBodyByGrep(content: string, pattern: string): { content: string; matched: number; total: number } {
  const matches = compileGrepMatcher(pattern)
  const lines = content.split('\n')
  const out: string[] = []
  let matched = 0
  let pendingHeading: string | null = null
  // An ATX heading may be indented up to three spaces; a `#` comment inside a code fence is not a heading.
  const unfenced = new Set(Array.from(eachUnfencedLine(lines), ([i]) => i))
  for (const [i, line] of lines.entries()) {
    const isHeading = unfenced.has(i) && matchAtxHeading(line, ATX_CLASS_BREAK_RE, true) !== null
    if (i === 0 && isHeading) out.push(line)
    else if (isHeading) pendingHeading = line
    const hit = matches(line)
    if (hit) matched++
    if (!hit || (i === 0 && isHeading)) continue
    if (pendingHeading !== null && pendingHeading !== line) out.push(pendingHeading)
    pendingHeading = null
    out.push(line)
  }
  return { content: out.join('\n'), matched, total: lines.length }
}

export function literalHeadingExists(filePath: string, heading: string): boolean {
  const ordinalMatch = /^([^#\r\n]+)#(\d+)$/.exec(heading)
  const base = (ordinalMatch?.[1] ?? heading).trim().toLowerCase()
  if (base.length === 0) return false
  return listSections(filePath, readFileText).some((h) => h.trim().toLowerCase() === base)
}

/** Where the file part of a `section` spec ends. The last `::` wins when the file it leaves exists (the long-standing rule, kept for a POSIX file whose own name holds `::`); otherwise each `::` is tried from the first, so `api.md::Foo::bar()` reads heading `Foo::bar()` of `api.md` instead of failing on a file called `api.md::Foo`. When no split names a file, the last one is returned and the caller reports it as before. A drive letter holds one colon, so it never reads as a separator. Returns -1 when the spec holds no `::`. */
export function findSectionSeparator(spec: string, projectRoot: string | undefined): number {
  const last = spec.lastIndexOf('::')
  if (last <= 0) return last
  const isFile = (idx: number): boolean => {
    try {
      return fs.statSync(resolveAgainstProjectRoot(spec.slice(0, idx), projectRoot)).isFile()
    } catch {
      return false
    }
  }
  if (isFile(last)) return last
  for (let idx = spec.indexOf('::'); idx !== -1 && idx < last; idx = spec.indexOf('::', idx + 1)) {
    if (idx > 0 && isFile(idx)) return idx
  }
  return last
}

export function runSection(opts: SectionOptions): { text: string; code: number } {
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runSectionCrossFile(crossFilePairs, opts)

  const colonIdx = findSectionSeparator(opts.spec, opts.projectRoot)
  if (colonIdx === -1) {
    return { text: `Invalid section spec — expected "file::Heading", got: ${opts.spec}`, code: 1 }
  }
  const specFilePath = opts.spec.slice(0, colonIdx)
  const filePath = resolveAgainstProjectRoot(specFilePath, opts.projectRoot)
  const heading = opts.spec.slice(colonIdx + 2)

  if (heading.includes(',') && !literalHeadingExists(filePath, heading)) {
    const multiHeadings = heading.split(',').map((h) => h.trim()).filter((h) => h.length > 0)
    if (multiHeadings.length > 1) return runSectionMulti(specFilePath, filePath, multiHeadings, opts)
  }

  const result = readSection(filePath, heading, readFileText) ?? htmlIdSectionFallback(filePath, heading)
  if (result === null) {
    if (!fs.existsSync(filePath)) {
      return { text: `File not found: ${echoedValue(filePath)}`, code: 1 }
    }
    const ordSpec = /^(.*?)#(\d+)$/.exec(heading)
    const ordBase = ordSpec?.[1]?.trim()
    if (ordBase !== undefined && ordBase.length > 0) {
      const baseResult = readSection(filePath, ordBase, readFileText)
      if (baseResult !== null) {
        const total = baseResult.occurrences?.length ?? 1
        return {
          text:
            `Heading ${quotedArg(ordBase)} has ${countNoun(total, 'occurrence')} in ${quotedArg(specFilePath)}; ` +
            `valid ordinals are #1 to #${total}`,
          code: 1,
        }
      }
    }
    const messages = [`Section ${quotedArg(heading)} not found in ${quotedArg(filePath)}`]
    const allHeadings = listSections(filePath, readFileText)
    const available = filterSimilarHeadings(allHeadings, heading)
    if (available.length > 0) messages.push(didYouMean(available))
    else if (allHeadings.length === 0) messages.push(`${quotedArg(specFilePath)} has no headings`)
    else messages.push(`Try: token-goat outline ${quotedArg(specFilePath)}`)
    return { text: messages.join('\n'), code: 1 }
  }

  if (result.occurrences !== undefined) {
    const lines = [
      `Ambiguous heading ${quotedArg(heading)} in ${quotedArg(specFilePath)}: ` +
        `${countNoun(result.occurrences.length, 'heading')} match. ` +
        `Retry with one of the qualified commands below to pick one:`,
    ]
    for (const [i, line] of result.occurrences.slice(0, AMBIGUOUS_HEADING_LIMIT).entries()) {
      lines.push(`  - line ${line}  ->  token-goat section ${quotedArg(`${specFilePath}::${heading}#${i + 1}`)}`)
    }
    if (result.occurrences.length > AMBIGUOUS_HEADING_LIMIT) {
      lines.push(`  (${result.occurrences.length - AMBIGUOUS_HEADING_LIMIT} more not shown)`)
    }
    return { text: lines.join('\n'), code: 1 }
  }

  const kind = result.redirectedFrom !== undefined ? 'section_replacement' : 'section_read'
  const fullSourceBytes = sumFileSizes([filePath])

  let content = result.content
  let lineEnd = result.lineEnd
  let truncatedNotice = ''
  let grepNote = ''
  let grepStats: { matched: number; total: number } | null = null

  if (opts.grep !== undefined) {
    const filtered = filterBodyByGrep(content, opts.grep)
    grepStats = { matched: filtered.matched, total: filtered.total }
    grepNote = filtered.matched === 0 ? `\n${grepFilteredToEmptyNotice(filtered.total, opts.grep, 'line', 'lines')}` : `\n${filtered.matched} of ${filtered.total} lines matched`
    content = filtered.matched === 0 ? '' : filtered.content
  }

  if (opts.maxLines !== undefined && opts.maxLines > 0) {
    const lines = content.split('\n')
    if (lines.length > opts.maxLines) {
      const remaining = lines.length - opts.maxLines
      content = lines.slice(0, opts.maxLines).join('\n')
      // With --grep the kept lines are scattered through the section, so the first maxLines of them say nothing about a contiguous range; the header keeps the span they were drawn from.
      if (opts.grep === undefined) lineEnd = Math.min(result.lineEnd, result.lineStart + opts.maxLines - 1)
      truncatedNotice = `\n... (${countNoun(remaining, 'more line')} not shown; pass a larger --max-lines or omit to read full section)`
    }
  }

  if (opts.json === true) {
    const jsonPayload: Record<string, unknown> = {
      ...result,
      content,
      lineEnd,
      ...(grepStats !== null ? { grep: opts.grep, matchedLines: grepStats.matched, sectionLines: grepStats.total } : {}),
      ...(opts.maxLines !== undefined && opts.maxLines > 0
        ? {
            totalLines: result.content.split('\n').length,
            shownLines: content.split('\n').length,
            truncated: truncatedNotice.length > 0,
          }
        : {}),
    }
    const text = displaySafeJson(jsonPayload)
    if (opts.suppressStat !== true) recordReadStat(kind, fullSourceBytes, text, heading)
    return { text, code: 0 }
  }

  const redirectNote =
    result.redirectedFrom !== undefined ? ` (redirected from: ${echoedValue(result.redirectedFrom)})` : ''
  const header = (end: number): string => `# ${result.heading} — ${filePath}:${result.lineStart}-${end}${redirectNote}`
  let body = `${header(lineEnd)}${content.length > 0 ? `\n${content}` : ''}${truncatedNotice}${grepNote}`
  // Paged, not just cut: a section past the harness's inline limit was persisted to a file the agent then had to read back, so the cut names the read that returns the next lines. A --grep view keeps scattered lines with no file range to page through, so it is cut with a pointer at narrowing instead.
  if (opts.maxChars !== undefined && body.length > opts.maxChars) {
    if (opts.grep === undefined) {
      const cut = capFileLines(result.content.split('\n'), result.lineStart, filePath, opts.maxChars, 'section', header(lineEnd).length + 1)
      if (cut !== null) body = `${header(cut.lastLine)}\n${cut.kept.join('\n')}\n${cut.notice}`
    } else {
      const lines = content.split('\n')
      const kept = lines.slice(0, linesWithinChars(lines, opts.maxChars - header(lineEnd).length - 300))
      body = `${header(lineEnd)}\n${kept.join('\n')}\n${forClient(`[token-goat: section capped at ${opts.maxChars} chars to stay under the harness's inline output limit; showing ${kept.length} of the ${lines.length} lines --grep kept. Narrow the pattern, or read a sub-heading.]`)}`
    }
  }
  const text = guardText(body, 'heading')
  if (opts.suppressStat !== true) recordReadStat(kind, fullSourceBytes, text, heading)
  return { text, code: 0 }
}

/** `opts` for one of `count` sections printed in one answer: an even share of `maxChars`, less what its label line costs, so the whole answer stays under the ceiling and a cut section still names its own next part. */
function perSectionOpts<T extends Omit<SectionOptions, 'spec'>>(opts: T, count: number): T {
  return opts.maxChars === undefined || count < 2 ? opts : { ...opts, maxChars: Math.max(500, Math.floor(opts.maxChars / count) - 200) }
}

export function runSectionMulti(
  specFilePath: string,
  resolvedFilePath: string,
  headings: string[],
  opts: SectionOptions,
): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []
  const includedSections: { heading: string; lineStart: number; lineEnd: number }[] = []

  for (const heading of headings) {
    const sectionResult = readSection(resolvedFilePath, heading, readFileText)
    if (sectionResult !== null) {
      const parent = includedSections.find(
        (p) => sectionResult.lineStart >= p.lineStart && sectionResult.lineEnd <= p.lineEnd,
      )
      if (parent !== undefined) {
        anyFound = true
        const notice = `(already included in section ${quotedArg(parent.heading)}, lines ${sectionResult.lineStart}-${sectionResult.lineEnd})`
        if (opts.json === true) {
          jsonOut[heading] = {
            heading: sectionResult.heading,
            subsumedBy: parent.heading,
            lineStart: sectionResult.lineStart,
            lineEnd: sectionResult.lineEnd,
            notice,
          }
          continue
        }
        textBlocks.push(
          `${heading}:\n# ${sectionResult.heading} — ${specFilePath}:${sectionResult.lineStart}-${sectionResult.lineEnd}\n${notice}`,
        )
        continue
      }
      includedSections.push({
        heading: sectionResult.heading,
        lineStart: sectionResult.lineStart,
        lineEnd: sectionResult.lineEnd,
      })
    }

    const sub = runSection({ ...perSectionOpts(opts, headings.length), spec: `${specFilePath}::${heading}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      jsonOut[heading] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${heading}:\n${sub.text}`)
  }

  const fullSourceBytes = sumFileSizes([resolvedFilePath])
  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  if (anyFound) recordReadStat('section_read', fullSourceBytes, text, opts.spec)
  return { text, code: anyFound ? 0 : 1 }
}

export function runSectionCrossFile(pairs: { file: string; symbol: string }[], opts: SectionOptions): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []
  const includedByFile = new Map<string, { heading: string; lineStart: number; lineEnd: number }[]>()

  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string =>
    distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`

  for (const { file, symbol: heading } of pairs) {
    const resolved = resolveAgainstProjectRoot(file, opts.projectRoot)
    const sectionResult = readSection(resolved, heading, readFileText)
    const key = keyFor({ file, symbol: heading })
    const fileIncluded = includedByFile.get(resolved) ?? []

    if (sectionResult !== null) {
      const parent = fileIncluded.find(
        (p) => sectionResult.lineStart >= p.lineStart && sectionResult.lineEnd <= p.lineEnd,
      )
      if (parent !== undefined) {
        anyFound = true
        const notice = `(already included in section ${quotedArg(parent.heading)}, lines ${sectionResult.lineStart}-${sectionResult.lineEnd})`
        if (opts.json === true) {
          jsonOut[key] = {
            heading: sectionResult.heading,
            subsumedBy: parent.heading,
            lineStart: sectionResult.lineStart,
            lineEnd: sectionResult.lineEnd,
            notice,
          }
          continue
        }
        textBlocks.push(
          `${key}:\n# ${sectionResult.heading} — ${file}:${sectionResult.lineStart}-${sectionResult.lineEnd}\n${notice}`,
        )
        continue
      }
      fileIncluded.push({
        heading: sectionResult.heading,
        lineStart: sectionResult.lineStart,
        lineEnd: sectionResult.lineEnd,
      })
      includedByFile.set(resolved, fileIncluded)
    }

    const sub = runSection({ ...perSectionOpts(opts, pairs.length), spec: `${file}::${heading}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  if (anyFound) {
    const fullSourceBytes = sumFileSizes(Array.from(distinctFiles, (f) => resolveAgainstProjectRoot(f, opts.projectRoot)))
    recordReadStat('section_read', fullSourceBytes, text, opts.spec)
  }
  return { text, code: anyFound ? 0 : 1 }
}

/** `section a b ...`, several positional specs in one call. Only the first used to be read, behind a note that the rest were ignored, so agents spawned one `section` per heading (14 spawns across three recorded commands, about 1-2 s each). Specs that each name a heading are served exactly as their comma form `a,b` is, by {@link runSectionCrossFile}, but paired from the specs themselves rather than from a comma-joined string, so a heading holding a comma stays one heading. Otherwise each spec runs in turn, one block per spec, and the call succeeds when any of them does, as the comma form's does. */
export function runSectionSpecs(specs: string[], opts: Omit<SectionOptions, 'spec'>): { text: string; code: number } {
  const joined = specs.join(',')
  if (namedSpecsMergeable(specs)) {
    const pairs = specs.map((spec) => {
      const idx = findSectionSeparator(spec, opts.projectRoot)
      return { file: spec.slice(0, idx), symbol: spec.slice(idx + 2) }
    })
    return runSectionCrossFile(pairs, { ...opts, spec: joined })
  }
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []
  for (const spec of specs) {
    const sub = runSection({ ...perSectionOpts(opts, specs.length), spec })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) jsonOut[spec] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
    else textBlocks.push(`${spec}:\n${sub.text}`)
  }
  return { text: opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n'), code: anyFound ? 0 : 1 }
}
