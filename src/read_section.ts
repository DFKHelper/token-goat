import * as fs from 'node:fs'
import * as path from 'node:path'

import { querySymbols } from './index_reader.js'
import { detectLanguage } from './parser_types.js'
import { displaySafeJson } from './paths.js'
import {
  findSpecSeparator,
  guardText,
  healStaleIndex,
  parseCrossFileMultiSpec,
  readFileText,
  recordReadStat,
  resolveAgainstProjectRoot,
  sumFileSizes,
} from './read_commands.js'
import { stripHtmlIdSpelling } from './read_spec.js'
import { didYouMean, filterSimilarHeadings } from './read_suggest.js'
import { listSections, readSection, type SectionResult } from './section_reader.js'
import { countNoun } from './util.js'

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
}

export function literalHeadingExists(filePath: string, heading: string): boolean {
  const ordinalMatch = /^([^#\r\n]+)#(\d+)$/.exec(heading)
  const base = (ordinalMatch?.[1] ?? heading).trim().toLowerCase()
  if (base.length === 0) return false
  return listSections(filePath, readFileText).some((h) => h.trim().toLowerCase() === base)
}

export function runSection(opts: SectionOptions): { text: string; code: number } {
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runSectionCrossFile(crossFilePairs, opts)

  const colonIdx = findSpecSeparator(opts.spec)
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
      return { text: `File not found: '${filePath}'`, code: 1 }
    }
    const ordSpec = /^(.*?)#(\d+)$/.exec(heading)
    const ordBase = ordSpec?.[1]?.trim()
    if (ordBase !== undefined && ordBase.length > 0) {
      const baseResult = readSection(filePath, ordBase, readFileText)
      if (baseResult !== null) {
        const total = baseResult.occurrences?.length ?? 1
        return {
          text:
            `Heading '${ordBase}' has ${countNoun(total, 'occurrence')} in '${specFilePath}'; ` +
            `valid ordinals are #1 to #${total}`,
          code: 1,
        }
      }
    }
    const messages = [`Section '${heading}' not found in '${filePath}'`]
    const allHeadings = listSections(filePath, readFileText)
    const available = filterSimilarHeadings(allHeadings, heading)
    if (available.length > 0) messages.push(didYouMean(available))
    else if (allHeadings.length === 0) messages.push(`'${specFilePath}' has no headings`)
    else messages.push(`Try: token-goat outline ${specFilePath}`)
    return { text: messages.join('\n'), code: 1 }
  }

  if (result.occurrences !== undefined) {
    const lines = [
      `Ambiguous heading '${heading}' in '${specFilePath}': ` +
        `${countNoun(result.occurrences.length, 'heading')} match. ` +
        `Retry with one of the qualified commands below to pick one:`,
    ]
    for (const [i, line] of result.occurrences.slice(0, AMBIGUOUS_HEADING_LIMIT).entries()) {
      lines.push(`  - line ${line}  ->  token-goat section "${specFilePath}::${heading}#${i + 1}"`)
    }
    if (result.occurrences.length > AMBIGUOUS_HEADING_LIMIT) {
      lines.push(`  (${result.occurrences.length - AMBIGUOUS_HEADING_LIMIT} more not shown)`)
    }
    return { text: lines.join('\n'), code: 1 }
  }

  const kind = result.redirectedFrom !== undefined ? 'section_replacement' : 'section_read'
  const fullSourceBytes = sumFileSizes([filePath])

  if (opts.json === true) {
    const text = displaySafeJson(result)
    if (opts.suppressStat !== true) recordReadStat(kind, fullSourceBytes, text, heading)
    return { text, code: 0 }
  }

  const redirectNote =
    result.redirectedFrom !== undefined ? ` (redirected from: '${result.redirectedFrom}')` : ''
  const text = guardText(
    `# ${result.heading} — ${filePath}:${result.lineStart}-${result.lineEnd}${redirectNote}\n${result.content}`,
    'heading',
  )
  if (opts.suppressStat !== true) recordReadStat(kind, fullSourceBytes, text, heading)
  return { text, code: 0 }
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
        const notice = `(already included in section '${parent.heading}', lines ${sectionResult.lineStart}-${sectionResult.lineEnd})`
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

    const sub = runSection({ ...opts, spec: `${specFilePath}::${heading}`, suppressStat: true })
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

  const resolvePath = (f: string): string =>
    opts.projectRoot !== undefined && !path.isAbsolute(f) ? path.resolve(opts.projectRoot, f) : f

  for (const { file, symbol: heading } of pairs) {
    const resolved = resolvePath(file)
    const sectionResult = readSection(resolved, heading, readFileText)
    const key = keyFor({ file, symbol: heading })
    const fileIncluded = includedByFile.get(resolved) ?? []

    if (sectionResult !== null) {
      const parent = fileIncluded.find(
        (p) => sectionResult.lineStart >= p.lineStart && sectionResult.lineEnd <= p.lineEnd,
      )
      if (parent !== undefined) {
        anyFound = true
        const notice = `(already included in section '${parent.heading}', lines ${sectionResult.lineStart}-${sectionResult.lineEnd})`
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

    const sub = runSection({ ...opts, spec: `${file}::${heading}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  if (anyFound) {
    const fullSourceBytes = sumFileSizes(Array.from(distinctFiles, resolvePath))
    recordReadStat('section_read', fullSourceBytes, text, opts.spec)
  }
  return { text, code: anyFound ? 0 : 1 }
}
