import * as fs from 'node:fs'
import * as path from 'node:path'

import { displaySafeJson } from './paths.js'
import {
  findSpecSeparator,
  guardText,
  parseCrossFileMultiSpec,
  readFileText,
  recordReadStat,
  resolveAgainstProjectRoot,
  sumFileSizes,
} from './read_commands.js'
import { didYouMean, filterSimilarHeadings } from './read_suggest.js'
import { listSections, readSection } from './section_reader.js'
import { countNoun } from './util.js'

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

  const result = readSection(filePath, heading, readFileText)
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

  for (const heading of headings) {
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

  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string =>
    distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`

  for (const { file, symbol: heading } of pairs) {
    const sub = runSection({ ...opts, spec: `${file}::${heading}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    const key = keyFor({ file, symbol: heading })
    if (opts.json === true) {
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  const resolvePath = (f: string): string =>
    opts.projectRoot !== undefined && !path.isAbsolute(f) ? path.resolve(opts.projectRoot, f) : f

  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  if (anyFound) {
    const fullSourceBytes = sumFileSizes(Array.from(distinctFiles, resolvePath))
    recordReadStat('section_read', fullSourceBytes, text, opts.spec)
  }
  return { text, code: anyFound ? 0 : 1 }
}
