/** The two-sided retrieval gate: a run is compared, query by query, with the ranks a committed baseline recorded, and fails on a significant drop in MRR@10 and also on a significant rise the baseline does not yet record. The second side is deliberate: a change that moves retrieval for the better and leaves the baseline stale hides the next regression behind the headroom it just made, so the author has to re-record the baseline in the same commit and the number is reviewed like any other diff. "Significant" is the paired bootstrap interval of metrics.ts excluding zero; the rows are ranks, so the comparison is deterministic. Pure functions only, so the arithmetic is tested on hand-computed inputs. */
import { pairedBootstrapDelta, reciprocalRank, type Interval } from './metrics.js'

/** Cutoff the recorded reciprocal ranks use. A rank past it scores zero, the same as a miss. */
export const GATE_K = 10

/** What is committed: the first-relevant rank of every answerable query for each gated arm (null = not in the returned list), plus what produced it. */
export interface Baseline {
  readonly schema: 1
  /** Number of distractor files the corpus carried, so a baseline made on another corpus is refused rather than compared. */
  readonly distractors: number
  readonly arms: Readonly<Record<string, Readonly<Record<string, number | null>>>>
}

export interface RunRow {
  readonly id: string
  readonly kind: string
  readonly rank: number | null
}

export type Verdict = 'same' | 'regressed' | 'improved'

export interface GateRow {
  readonly arm: string
  readonly n: number
  readonly delta: Interval
  readonly verdict: Verdict
}

export interface GateResult {
  readonly rows: GateRow[]
  readonly failures: string[]
}

const answerable = (rows: readonly RunRow[]): RunRow[] => rows.filter((r) => r.kind !== 'absent')

/** The baseline a run would record: ranks keyed by query id, for the answerable queries of each arm. */
export function toBaseline(run: Readonly<Record<string, readonly RunRow[]>>, distractors: number): Baseline {
  const arms: Record<string, Record<string, number | null>> = {}
  for (const [arm, rows] of Object.entries(run)) arms[arm] = Object.fromEntries(answerable(rows).map((r) => [r.id, r.rank]))
  return { schema: 1, distractors, arms }
}

const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`

/** Compares a run with the baseline. Anything that makes the comparison itself unsound (another corpus size, a missing arm, a query present on one side only) is a failure too, because scoring the overlap would let a dropped query hide a regression. */
export function compareToBaseline(run: Readonly<Record<string, readonly RunRow[]>>, base: Baseline, distractors: number): GateResult {
  const rows: GateRow[] = []
  const failures: string[] = []
  if (base.distractors !== distractors) failures.push(`baseline was recorded with ${base.distractors} distractor files and this run used ${distractors}; the two cannot be compared`)
  for (const arm of Object.keys(base.arms)) {
    const now = run[arm]
    if (now === undefined) failures.push(`arm ${arm} is in the baseline but this run did not produce it`)
  }
  for (const [arm, runRows] of Object.entries(run)) {
    const before = base.arms[arm]
    if (before === undefined) {
      failures.push(`arm ${arm} is not in the baseline; record it with --update`)
      continue
    }
    const now = answerable(runRows)
    const ids = new Set(now.map((r) => r.id))
    const missing = Object.keys(before).filter((id) => !ids.has(id))
    const extra = now.filter((r) => !(r.id in before)).map((r) => r.id)
    if (missing.length > 0 || extra.length > 0) {
      failures.push(`arm ${arm}: the query set differs from the baseline (only in baseline: ${missing.join(', ') || 'none'}; only in run: ${extra.join(', ') || 'none'}); re-record with --update`)
      continue
    }
    const delta = pairedBootstrapDelta(
      now.map((r) => reciprocalRank(before[r.id] ?? null, GATE_K)),
      now.map((r) => reciprocalRank(r.rank, GATE_K)),
    )
    const verdict: Verdict = delta.lo > 0 ? 'improved' : delta.hi < 0 ? 'regressed' : 'same'
    rows.push({ arm, n: now.length, delta, verdict })
    if (verdict === 'regressed') failures.push(`arm ${arm}: MRR@10 fell by ${signed(-delta.mean)} (95% interval ${signed(delta.lo)} to ${signed(delta.hi)} on ${now.length} queries)`)
    if (verdict === 'improved') failures.push(`arm ${arm}: MRR@10 rose by ${signed(delta.mean)} (95% interval ${signed(delta.lo)} to ${signed(delta.hi)} on ${now.length} queries) and the baseline does not record it; re-record with --update and commit evals/retrieval/baseline.json`)
  }
  return { rows, failures }
}
