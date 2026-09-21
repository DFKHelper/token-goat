/**
 * Prices a line-range read's proposed surgical replacement against the read itself, so a hint
 * that redirects a line-range read can be required to prove it saves something before it is
 * allowed to spend context saying so.
 *
 * The defect this exists to close: the sed/awk/head range hints were pushed unconditionally and
 * had never compared their own proposal to what was asked for. Two measurements, both reproduced
 * on this machine on 2026-09-20:
 *
 *   sed -n '1,30p' CHANGELOG.md                   10,572 bytes  (what was asked for)
 *   token-goat section "CHANGELOG.md::Unreleased" 15,150 bytes  (what the hint proposed)
 *
 * -- the proposal was 43% larger, and the hint named the file rather than a right-sized heading,
 * so the agent could not have picked a better one even knowing to try. That single file accounted
 * for 179,195 tokens across 75 reads in 21 command spellings in one session. Ignoring the hint was
 * the correct behavior, which is why 695 emissions bought 6 follow-throughs.
 *
 * What this module reports is the honest comparison: the bytes of the lines actually requested,
 * against the bytes of the regions a surgical read would have to return to cover them, plus the
 * per-region disclosure header that read prints. It is deliberately NOT measured by running the
 * replacement command -- `read`'s output is folded and capped above a size, so a by-running
 * measurement reports a large region as cheaper than it is and the gate would pass on the
 * compressor's work rather than on the region being small.
 *
 * What the shipped gate actually computes for those two cases, dogfooded against the built binary
 * under an isolated index on 2026-09-21:
 *
 *   sed -n '1,30p' CHANGELOG.md   requested 10,572  replacement 15,798 over 10 regions  -5,226
 *   sed -n '10,52p' src/paths.ts  requested  4,469  replacement  5,419 over 12 regions    -950
 *
 * Both are negative against a 512-byte floor, so both fall silent.
 *
 * A result worth knowing before reading the call sites: regions tile the file and every region
 * this returns contains at least one requested line, so the replacement is a superset of the
 * request and cannot be smaller except by newline-join edge effects at a file boundary. Measured
 * over 4,507 windows across 10 real files at the corpus's own size distribution (p50 30, p90 100,
 * p99 269 lines): bigger in 4,421, equal in 11, smaller in 75, and the largest saving anywhere was
 * 104 bytes -- under any sane `hints.min_session_hint_savings_bytes`. So in practice this gate
 * closes the range hints rather than throttling them. That outcome is left to the measurement
 * rather than hardcoded: a hardcoded `false` would be this analysis restated as code, and could
 * never notice a file shape that does pay.
 */
import { statSync, readFileSync } from 'node:fs'

import { resolveIndexPath } from './paths.js'
import { getFileEntry, querySymbols } from './index_reader.js'
import { fingerprintFile } from './fingerprint.js'
import { resolveLineRegions } from './line_regions.js'

/** Every symbol in one file, never a page of them: a partial answer here silently shrinks the replacement and biases the gate toward emitting. SQLite reads -1 as unlimited, the same sentinel graph_traversal.ts uses for its own whole-file lookups. */
const ALL_SYMBOLS_IN_FILE = -1

/** Bytes `read` spends disclosing one region before its body -- a blank line plus a header of the shape `# [1/12] file preamble  lines 1-19 of 325 (~202 tok)`, measured at 55 bytes on the longest of the ten captured in this file's header measurement. Counted against the replacement rather than ignored, because it is context the agent pays for; rounding it up rather than down keeps the gate from passing on an optimistic figure. */
const REGION_HEADER_BYTES = 56

export interface RangeSubstitute {
  /** Bytes of the lines the command actually asked for. */
  requestedBytes: number
  /** Bytes the surgical replacement would cost, regions plus their disclosure headers. */
  replacementBytes: number
  /** Exactly runnable replacements, in file order, each naming the specific region it returns -- never the file alone. A multi-line symbol is named (shift-robust); a preamble, a gap, or a one-line symbol has no name worth quoting and is addressed by its own line span. */
  commands: string[]
}

/**
 * Price the substitute for `ranges` of `hintPath`, or null when no honest comparison is available:
 * the file is missing, was never indexed, is indexed stale, or has no symbols to resolve regions
 * from. Null means "do not emit", not "emits for free" -- a hint whose proposal cannot be priced
 * has not earned the context it would spend.
 */
export function rangeSubstituteFor(
  hintPath: string,
  cwd: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): RangeSubstitute | null {
  if (ranges.length === 0) return null
  try {
    const resolved = resolveIndexPath(hintPath, cwd)
    if (!statSync(resolved).isFile()) return null
    // Never price against an index that has drifted from disk: stale line spans would compare a
    // window of today's file against regions of yesterday's. Same two primitives, and the same
    // reason for using them rather than read_commands.ts, as bash_structural_index.ts.
    const entry = getFileEntry(resolved)
    if (entry === null) return null
    if (entry.sha !== '') {
      const diskSha = fingerprintFile(resolved)
      if (diskSha === null || diskSha !== entry.sha) return null
    }

    const lines = readFileSync(resolved, 'utf8').split('\n')
    const symbols = querySymbols({ filePath: resolved, limit: ALL_SYMBOLS_IN_FILE })
    if (symbols.length === 0) return null

    const bytesOf = (start: number, end: number): number =>
      Buffer.byteLength(lines.slice(start - 1, Math.min(end, lines.length)).join('\n'), 'utf8')

    // Requested lines are unioned, not summed: a command naming two ranges that overlap would
    // otherwise be charged twice for the shared lines and the gate would flatter itself.
    const requestedLines = new Set<number>()
    const regionBySpan = new Map<string, { kind: string; name: string | null; start: number; end: number }>()
    for (const [start, end] of ranges) {
      for (let l = start; l <= Math.min(end, lines.length); l++) requestedLines.add(l)
      for (const r of resolveLineRegions(symbols, lines.length, start, end)) {
        // The label is display text (`function foo`); the runnable command needs the bare name, and a region's name is whatever symbol spans exactly those lines. A markdown heading is indexed as a one-line symbol, so it resolves here and is then addressed by span rather than by name below -- `read "file::Heading"` returns the heading line, not the section under it.
        const named = symbols.find((s) => s.lineStart === r.start && s.lineEnd === r.end)
        regionBySpan.set(`${r.start}-${r.end}`, {
          kind: r.kind,
          name: r.kind === 'symbol' && r.end > r.start && named !== undefined ? named.name : null,
          start: r.start,
          end: r.end,
        })
      }
    }
    if (regionBySpan.size === 0) return null

    let requestedBytes = 0
    for (const l of requestedLines) requestedBytes += Buffer.byteLength(lines[l - 1] ?? '', 'utf8') + 1
    const regions = [...regionBySpan.values()].sort((a, b) => a.start - b.start || a.end - b.end)
    const replacementBytes = regions.reduce((t, r) => t + bytesOf(r.start, r.end) + REGION_HEADER_BYTES, 0)
    const commands = regions.map((r) =>
      r.name === null
        ? `token-goat read "${hintPath}:${r.start}-${r.end}"`
        : `token-goat read "${hintPath}::${r.name}"`,
    )
    return { requestedBytes, replacementBytes, commands }
  } catch {
    // Any failure to price is a failure to justify emitting; fall silent rather than guess.
    return null
  }
}
