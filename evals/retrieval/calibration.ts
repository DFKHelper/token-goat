/** Abstention scoring for the retrieval eval: how often a command says it has nothing good when the corpus really has no answer, how often it says so when the answer is there, and which weak-match distance separates the two best on one split so the other split can judge it. Pure, like metrics.ts: the harness collects each query's closest distance and whether it abstained, and this file only does the counting. */
import { bootstrapCI, type BootstrapOptions, type Interval } from './metrics.js'

export interface AbstentionRow {
  /** True for a query whose answer is not in the corpus at all. */
  readonly absent: boolean
  readonly abstained: boolean
}

export interface AbstentionRates {
  /** Share of absent queries the command abstained on: the higher, the fewer confident answers to a question nothing answers. Null with no absent queries. */
  readonly onAbsent: Interval | null
  /** Share of answerable queries the command abstained on, the false alarm rate: a warning on a right answer teaches the reader to ignore the warning. Null with no answerable queries. */
  readonly onPresent: Interval | null
}

export function abstentionRates(rows: readonly AbstentionRow[], opts: BootstrapOptions = {}): AbstentionRates {
  const rate = (absent: boolean): Interval | null => {
    const group = rows.filter((r) => r.absent === absent)
    return group.length === 0 ? null : bootstrapCI(group.map((r) => (r.abstained ? 1 : 0)), opts)
  }
  return { onAbsent: rate(true), onPresent: rate(false) }
}

export interface DistanceRow {
  readonly absent: boolean
  /** Closest dense distance the command reported, or null when it returned no dense match at all. */
  readonly closest: number | null
}

/** Whether `semantic` would call this result weak at `threshold`: its rule is closest > threshold, and a query with no dense match has nothing to be confident in. */
export const abstainsAt = (closest: number | null, threshold: number): boolean => closest === null || closest > threshold

export interface ThresholdScore {
  readonly threshold: number
  readonly onAbsent: number
  readonly onPresent: number
  /** Mean of the miss rate on absent queries and the false alarm rate on answerable ones, so a query set with three answerable queries to every absent one cannot win by never abstaining. */
  readonly balancedError: number
}

/** The abstention rates `threshold` would give on `rows`, or null unless both absent and answerable queries are present, since a balanced error with one class missing is half undefined. */
export function scoreThreshold(rows: readonly DistanceRow[], threshold: number): ThresholdScore | null {
  const absent = rows.filter((r) => r.absent)
  const present = rows.filter((r) => !r.absent)
  if (absent.length === 0 || present.length === 0) return null
  const abstaining = (group: readonly DistanceRow[]): number => group.filter((r) => abstainsAt(r.closest, threshold)).length
  const aA = abstaining(absent)
  const aP = abstaining(present)
  // The miss rate is taken from the count rather than as 1 - onAbsent: 1 - 2/3 is not 1/3 in floating point, and that last bit decided ties between thresholds the counts score equally.
  return { threshold, onAbsent: aA / absent.length, onPresent: aP / present.length, balancedError: ((absent.length - aA) / absent.length + aP / present.length) / 2 }
}

/** The weak-match threshold with the lowest balanced error on `rows`. Candidates sit midway between neighbouring observed distances (and midway between 0 and the smallest), plus the largest distance itself, which abstains on nothing that matched: every distinct split of the observed distances is tried once, and the midpoint keeps the chosen line off any one query's exact value. A tie goes to the higher threshold, because a false alarm on a right answer costs more than a missed warning on a wrong one. Null when either class is missing or no query reported a distance. */
export function fitWeakThreshold(rows: readonly DistanceRow[]): ThresholdScore | null {
  const ds = [...new Set(rows.flatMap((r) => (r.closest === null ? [] : [r.closest])))].sort((a, b) => a - b)
  if (ds.length === 0) return null
  const candidates = [0, ...ds].slice(0, -1).map((d, i) => (d + (ds[i] ?? d)) / 2)
  candidates.push(ds[ds.length - 1] ?? 0)
  let best: ThresholdScore | null = null
  for (const t of candidates) {
    const s = scoreThreshold(rows, t)
    if (s === null) return null
    if (best === null || s.balancedError <= best.balancedError) best = s
  }
  return best
}
