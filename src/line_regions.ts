/**
 * Maps a requested line span onto the file regions that cover it. Split out of read_spec.ts so
 * the Bash hook path can price a line-range read's surgical replacement (bash_range_savings.ts)
 * without importing read_spec.ts, which reaches read_commands.ts and through it the whole
 * parser/language-adapter graph -- a graph the hook's eager bundle has a size ceiling against
 * (tests/guards/dist_chunks_deduped.test.ts). Pure: symbols and numbers in, spans out, no I/O and
 * no database, which is what makes it safe to sit on both paths.
 */
import type { SymbolEntry } from './parser_types.js'

/** One contiguous slice of a file that a queried line falls in: the smallest symbol enclosing it, the preamble above the first symbol, or the gap between two symbols. `label` is what gets disclosed in the output header, so a caller that asked for line 142 and got lines 120-190 can see which is which. */
export type LineRegion = { kind: 'symbol' | 'preamble' | 'gap'; label: string; start: number; end: number }

/** Map a requested line span onto the regions it overlaps, in file order. Per line: smallest enclosing symbol, else the preamble when the line sits above the first symbol's start, else the gap between the previous symbol's end and the next one's start (running to EOF when nothing follows). Regions fully contained in another picked region are dropped rather than printed twice -- a range landing on both a method and its containing class coalesces to the class, which already covers the method's lines. Returns `[]` when the file has no indexed symbols; the caller reports that rather than serving an adjacent slice that would read as the answer. */
export function resolveLineRegions(
  symbols: readonly SymbolEntry[],
  totalLines: number,
  start: number,
  end: number,
): LineRegion[] {
  if (symbols.length === 0) return []
  const firstStart = symbols.reduce((m, s) => Math.min(m, s.lineStart), Number.POSITIVE_INFINITY)
  const regionFor = (line: number): LineRegion => {
    let best: SymbolEntry | null = null
    for (const s of symbols) {
      if (s.lineStart > line || s.lineEnd < line) continue
      if (best === null || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) best = s
    }
    if (best !== null) {
      return { kind: 'symbol', label: `${best.kind} ${best.name}`, start: best.lineStart, end: best.lineEnd }
    }
    if (line < firstStart) return { kind: 'preamble', label: 'file preamble', start: 1, end: firstStart - 1 }
    let prev: SymbolEntry | null = null
    let next: SymbolEntry | null = null
    for (const s of symbols) {
      if (s.lineEnd < line && (prev === null || s.lineEnd > prev.lineEnd)) prev = s
      if (s.lineStart > line && (next === null || s.lineStart < next.lineStart)) next = s
    }
    const prevName = prev === null ? 'start of file' : prev.name
    return {
      kind: 'gap',
      label: next === null ? `gap after ${prevName}` : `gap between ${prevName} and ${next.name}`,
      start: prev === null ? 1 : prev.lineEnd + 1,
      end: next === null ? totalLines : next.lineStart - 1,
    }
  }
  const bySpan = new Map<string, LineRegion>()
  for (let line = start; line <= Math.min(end, totalLines); line++) {
    const r = regionFor(line)
    const key = `${r.start}-${r.end}`
    const seen = bySpan.get(key)
    if (seen === undefined) bySpan.set(key, r)
    else if (!seen.label.split(' / ').includes(r.label)) seen.label = `${seen.label} / ${r.label}`
  }
  const picked = [...bySpan.values()]
  return picked
    .filter((r) => !picked.some((o) => o !== r && o.start <= r.start && o.end >= r.end))
    .sort((a, b) => a.start - b.start || a.end - b.end)
}
