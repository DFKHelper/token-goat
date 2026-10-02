/** Report lines for what hit rate cannot see: whether an arm says so when the corpus has no answer, which files it returns for everything, and how often two different questions get the same wrong first answer. Pure: the harness hands over one row per query and prints what comes back. */
import { abstentionRates, fitWeakThreshold, scoreThreshold, type DistanceRow, type ThresholdScore } from './calibration.js'
import { hubFiles, top1CollisionRate, type Interval } from './metrics.js'

/** A file in the top results of at least this share of queries is reported as a hub. A quarter of a 57-query set is 15 queries, far more than any one file legitimately answers. */
export const HUB_SHARE = 0.25

export const pct = (i: Interval): string => `${(i.mean * 100).toFixed(1)} [${(i.lo * 100).toFixed(1)}, ${(i.hi * 100).toFixed(1)}]`
export const num = (i: Interval): string => `${i.mean.toFixed(3)} [${i.lo.toFixed(3)}, ${i.hi.toFixed(3)}]`

export interface QualityRow {
  readonly absent: boolean
  readonly abstained: boolean
  /** Normalised files of the arm's top results, best first. */
  readonly topFiles: readonly string[]
  /** Normalised files the golden labels name; empty for an absent query. */
  readonly labelFiles: readonly string[]
}

const share = (x: number): string => `${(x * 100).toFixed(0)}%`

/** Abstention on both classes, the top-1 collision rate over answerable queries, and the hub files over every query, since a file returned for questions nothing answers is as much a hub as one returned for questions something else answers. */
export function qualityLines(rows: readonly QualityRow[], indent: string): string[] {
  const out: string[] = []
  const a = abstentionRates(rows)
  const nAbsent = rows.filter((r) => r.absent).length
  out.push(`${indent}abstains on absent ${a.onAbsent === null ? '-' : pct(a.onAbsent)} (n=${nAbsent}), on answerable ${a.onPresent === null ? '-' : pct(a.onPresent)} (n=${rows.length - nAbsent})`)
  const collision = top1CollisionRate(rows.filter((r) => !r.absent).map((r) => ({ top1: r.topFiles[0] ?? null, labelFiles: r.labelFiles })))
  out.push(`${indent}top-1 collision ${collision === null ? '-' : share(collision)} of answered answerable queries`)
  const hubs = hubFiles(rows.map((r) => r.topFiles), HUB_SHARE)
  out.push(`${indent}hubs (top results of >= ${share(HUB_SHARE)} of queries): ${hubs.length === 0 ? 'none' : hubs.map((h) => `${h.file} ${share(h.share)}`).join(', ')}`)
  return out
}

const fmtScore = (s: ThresholdScore | null): string =>
  s === null ? '-' : `balanced error ${s.balancedError.toFixed(3)} (abstains on absent ${share(s.onAbsent)}, on answerable ${share(s.onPresent)})`

/** Fits the weak-match line on the train split and scores it on the test split beside the configured line, so a suggested value is judged on queries it was not chosen from. */
export function weakFitLines(train: readonly DistanceRow[], test: readonly DistanceRow[], configured: number, indent: string): string[] {
  const fit = fitWeakThreshold(train)
  if (fit === null) return [`${indent}weak_distance fit: needs absent and answerable queries with a distance in the train split`]
  return [
    `${indent}weak_distance ${configured.toFixed(3)} (configured) on test: ${fmtScore(scoreThreshold(test, configured))}`,
    `${indent}weak_distance ${fit.threshold.toFixed(3)} (fitted on train, ${fmtScore(fit)}) on test: ${fmtScore(scoreThreshold(test, fit.threshold))}`,
  ]
}
