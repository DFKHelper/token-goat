/** Scoring for the retrieval evals under evals/retrieval. Every function here is pure: the harnesses (scripts/eval-retrieval.ts, scripts/eval-chunking.ts) collect ranked hits by running the real commands, and this file only decides whether a hit is the labelled answer and what the numbers across a query set come to. Kept apart from the harnesses so the arithmetic is unit-tested on hand-computed inputs rather than trusted because the report looked plausible. */

/** A labelled answer. `lineStart`/`lineEnd` narrow it to one span (a symbol's definition, a doc section); without them any hit in the file counts. */
export interface RelevantSpan {
  readonly file: string
  readonly lineStart?: number
  readonly lineEnd?: number
}

/** One ranked result, as a command reported it. A result with no line range is file-level. */
export interface RankedHit {
  readonly file: string
  readonly lineStart?: number
  readonly lineEnd?: number
}

/** Forward slashes, lowercase, no leading `./`, and relative to `root` when it sits under it. Search reports absolute lowercase-drive paths and semantic reports repo-relative ones, so both are brought to one spelling before any comparison. */
export function normalizePath(file: string, root = ''): string {
  let p = file.replaceAll('\\', '/').toLowerCase()
  const r = root.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '')
  if (r !== '' && p.startsWith(`${r}/`)) p = p.slice(r.length + 1)
  return p.replace(/^\.\//, '')
}

/** Whether `hit` is `rel`. A span label needs a hit whose own range overlaps it: a file-level hit on the right file does not count, because it hands the reader the whole file to search again, which is the cost the label exists to measure. */
export function hitMatches(hit: RankedHit, rel: RelevantSpan, root = ''): boolean {
  if (normalizePath(hit.file, root) !== normalizePath(rel.file, root)) return false
  if (rel.lineStart === undefined || rel.lineEnd === undefined) return true
  if (hit.lineStart === undefined || hit.lineEnd === undefined) return false
  return hit.lineStart <= rel.lineEnd && rel.lineStart <= hit.lineEnd
}

/** 1-based rank of the first hit matching any label, or null when none does. */
export function firstRelevantRank(hits: readonly RankedHit[], relevant: readonly RelevantSpan[], root = ''): number | null {
  const i = hits.findIndex((h) => relevant.some((r) => hitMatches(h, r, root)))
  return i === -1 ? null : i + 1
}

/** Count of hits in the top `k` that match some label. What bytes-per-correct-hit divides by. */
export function correctInTopK(hits: readonly RankedHit[], relevant: readonly RelevantSpan[], k: number, root = ''): number {
  return hits.slice(0, k).filter((h) => relevant.some((r) => hitMatches(h, r, root))).length
}

/** 1 when the first relevant rank is within `k`, else 0. Averaged over queries this is hit@k, the fraction of questions a reader answers from the top k; most labels here name one span, where hit@k and recall@k coincide. */
export function hitAtK(rank: number | null, k: number): number {
  return rank !== null && rank <= k ? 1 : 0
}

/** Reciprocal rank cut at `k`: 1/rank inside the cutoff, 0 past it or when nothing matched. Averaged over queries this is MRR@k. */
export function reciprocalRank(rank: number | null, k: number): number {
  return rank !== null && rank <= k ? 1 / rank : 0
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** A seeded PRNG, so a bootstrap interval is the same number on every run and a report can be diffed. mulberry32: 32-bit state, returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Interval {
  readonly mean: number
  readonly lo: number
  readonly hi: number
}

export interface BootstrapOptions {
  readonly iterations?: number
  readonly seed?: number
  /** Two-sided; 0.05 gives a 95% interval. */
  readonly alpha?: number
}

/** The value at index floor(q * n) of an ascending array, clamped to the ends: the q-th empirical quantile with no interpolation, so a reported bound is always a mean some resample actually produced. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
  return sorted[idx] ?? Number.NaN
}

/** Percentile bootstrap interval for the mean of `values`. */
export function bootstrapCI(values: readonly number[], opts: BootstrapOptions = {}): Interval {
  const { iterations = 2000, seed = 1, alpha = 0.05 } = opts
  const m = mean(values)
  if (values.length === 0) return { mean: m, lo: Number.NaN, hi: Number.NaN }
  const rand = mulberry32(seed)
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)] ?? 0
    means.push(sum / values.length)
  }
  means.sort((x, y) => x - y)
  return { mean: m, lo: percentile(means, alpha / 2), hi: percentile(means, 1 - alpha / 2) }
}

/** Paired bootstrap interval for mean(after - before), resampling queries rather than the two arms separately: the same query is hard for both configurations, and pairing removes that shared variance, which is what lets a small improvement clear the noise at all. Throws on arms of different length, since a pairing that silently truncates compares different questions. */
export function pairedBootstrapDelta(before: readonly number[], after: readonly number[], opts: BootstrapOptions = {}): Interval {
  if (before.length !== after.length) throw new Error(`paired arms differ in length: ${before.length} vs ${after.length}`)
  const diffs = before.map((b, i) => (after[i] ?? Number.NaN) - b)
  return bootstrapCI(diffs, opts)
}

/** Output bytes spent per correct hit, or null when nothing correct came back: that case has no finite price, and reporting it as 0 or as the raw byte count would both read as a result. */
export function bytesPerCorrectHit(outputBytes: number, correctHits: number): number | null {
  return correctHits > 0 ? outputBytes / correctHits : null
}

/** FNV-1a over the UTF-16 code units of `s`. Stable across runs and platforms, which is the whole requirement: a query's split must never change because the file was re-read. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Deterministic train/test assignment by id hash. `testFraction` of ids land in test on average; the exact count depends on the ids, which is the point: nobody picks which queries are held out. */
export function splitOf(id: string, testFraction = 0.3): 'train' | 'test' {
  return fnv1a(id) % 1000 < Math.round(testFraction * 1000) ? 'test' : 'train'
}

export interface HubFile {
  readonly file: string
  /** Share of the queries whose top k contained this file. */
  readonly share: number
}

/** Files that turn up in the top k of at least `minShare` of the queries, most frequent first, ties by path. A file in the top ten for a third of unrelated questions is a magnet: it costs bytes on every one of them and pushes the real answer down, and no single query's rank shows it. A file listed twice for one query counts once. */
export function hubFiles(topFilesPerQuery: readonly (readonly string[])[], minShare: number): HubFile[] {
  if (topFilesPerQuery.length === 0) return []
  const counts = new Map<string, number>()
  for (const files of topFilesPerQuery) for (const f of new Set(files)) counts.set(f, (counts.get(f) ?? 0) + 1)
  return [...counts]
    .map(([file, n]) => ({ file, share: n / topFilesPerQuery.length }))
    .filter((h) => h.share >= minShare)
    .sort((a, b) => b.share - a.share || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

export interface Top1Row {
  /** Normalized path of the first hit, or null when nothing came back. */
  readonly top1: string | null
  /** Normalized paths the query's labels name. */
  readonly labelFiles: readonly string[]
}

/** Share of the queries with a first hit whose first hit is shared with another query while at least one query in that group is labelled with a different file: two questions with different answers that land on the same file first. Queries that agree on a file every one of them is labelled with are not a collision, however many there are. Null when no query returned anything. */
export function top1CollisionRate(rows: readonly Top1Row[]): number | null {
  const groups = new Map<string, Top1Row[]>()
  for (const r of rows) if (r.top1 !== null) groups.set(r.top1, [...(groups.get(r.top1) ?? []), r])
  let answered = 0
  let colliding = 0
  for (const [file, members] of groups) {
    answered += members.length
    if (members.length > 1 && members.some((m) => !m.labelFiles.includes(file))) colliding += members.length
  }
  return answered === 0 ? null : colliding / answered
}
