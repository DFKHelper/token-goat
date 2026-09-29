/** Hint auto-suppression eval. token-goat mutes a hint category once at least `hint_stats.min_sample_size` scored emissions leave the 95% Wilson upper bound on its uptake rate under `suppress_threshold_pct` (or, for a category that asks for an absence, the lower bound on its defiance rate over `defiance_threshold_pct`), and then lets a probe through on the occasions `hints.backoff_thresholds` schedules. This script answers two questions about that rule with exact arithmetic rather than a simulation: how often does it mute a category that is actually useful, and how many times is a useless one shown before it goes quiet. It also reads a ledger, read-only, and reports each category's measured rate with a Wilson interval next to the verdict each gate gives it.

The model: a category meets `occasions` detections in a row; each shown hint is followed through with probability `p`, independently, and is scored before the next detection. The dynamic program walks every reachable (scored, followed, suppressed-streak) state with its probability, so every figure it prints is exact for that model. What the model leaves out is timing: a real hint is scored up to five tool calls after it is shown, so a burst of detections can reach the gate before the earlier verdicts land. The gate and the probe schedule are the shipped functions (suppressesAt, isProbeOccasion) and the shipped defaults, not copies.

Run it: `npx tsx scripts/eval-hints.ts` for the tables, `--db <path to global.db>` to add the ledger report. The ledger is opened read-only and must already exist. */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDefaultConfig } from '../src/config_defaults.js'
import type { HintStatsConfig } from '../src/config_types.js'
import { HINT_CATEGORIES, isProbeOccasion, isSuppressionCategory, suppressesAt, wilsonInterval, type HintCategory } from '../src/hint_stats.js'
import Database from '../src/sqlite_driver.js'

export interface Gate {
  readonly name: string
  /** True when a category with `n` scored emissions, `k` of them followed, is suppressed. */
  readonly suppress: (n: number, k: number) => boolean
}

/** The shipped rule under `cfg`, for a category that asks for an action: mute once the 95% Wilson upper bound on the follow rate sits under `suppress_threshold_pct`. A suppression category is judged by the same call with `inverted` set, which under the default 85 = 100 - 15 gives the same verdict on its compliance count. */
export function shippedGate(cfg: HintStatsConfig): Gate {
  return { name: `wilson n>=${cfg.min_sample_size} hi<${cfg.suppress_threshold_pct}%`, suppress: (n, k) => suppressesAt(n, k, cfg, false) }
}

/** The rule this replaced, kept as the baseline the tables compare against: mute once `min_sample_size` scored emissions show a raw follow rate under the threshold. Written out here because the shipped code no longer carries it. */
export function countGate(cfg: HintStatsConfig): Gate {
  return { name: `count n>=${cfg.min_sample_size} <${cfg.suppress_threshold_pct}%`, suppress: (n, k) => n >= cfg.min_sample_size && (100 * k) / n < cfg.suppress_threshold_pct }
}

/** The smallest n at which `gate` suppresses a category that has followed nothing, i.e. how many times a useless hint is shown before it is muted. */
export function firstSuppressionAtZero(gate: Gate, limit = 10_000): number | null {
  for (let n = 1; n <= limit; n++) if (gate.suppress(n, 0)) return n
  return null
}

/** Probability that `gate` fires at some point during `n` consecutive scored emissions of a category whose true uptake is `p`. Ignores probes: this is the chance of a first suppression, the event a useful category should almost never suffer. */
export function everSuppressedProbability(p: number, n: number, gate: Gate): number {
  // dist[k] = probability of k followed after the emissions so far, without having been suppressed yet.
  let dist = [1]
  let fired = 0
  for (let i = 1; i <= n; i++) {
    const next = new Array<number>(i + 1).fill(0)
    for (let k = 0; k < dist.length; k++) {
      const m = dist[k] ?? 0
      if (m === 0) continue
      next[k] = (next[k] ?? 0) + m * (1 - p)
      next[k + 1] = (next[k + 1] ?? 0) + m * p
    }
    for (let k = 0; k <= i; k++) {
      if (gate.suppress(i, k)) {
        fired += next[k] ?? 0
        next[k] = 0
      }
    }
    dist = next
  }
  return fired
}

export interface Exposure {
  /** Expected number of hints shown over the run. */
  readonly shown: number
  /** Expected number of shown hints that were followed: the benefit delivered. */
  readonly followed: number
  /** Probability the category is suppressed after the last occasion. */
  readonly suppressedAtEnd: number
}

/** Exact expected exposure of a category with uptake `p` over `occasions` detections, under `gate` with the `thresholds` probe schedule. Mirrors applyHintTracking: a suppressed occasion bumps the streak and shows the hint only on a probe, without resetting the streak; an unsuppressed one resets the streak and shows it. */
export function exposure(p: number, occasions: number, gate: Gate, thresholds: readonly number[]): Exposure {
  // A state is (n scored, k followed, suppressed streak s), packed into one number: each coordinate is at most `occasions`.
  const base = occasions + 1
  const pack = (n: number, k: number, s: number): number => (n * base + k) * base + s
  let states = new Map<number, number>([[pack(0, 0, 0), 1]])
  let shown = 0
  let followed = 0
  for (let t = 0; t < occasions; t++) {
    const next = new Map<number, number>()
    const add = (key: number, m: number): void => {
      next.set(key, (next.get(key) ?? 0) + m)
    }
    for (const [key, m] of states) {
      const s = key % base
      const k = Math.floor(key / base) % base
      const n = Math.floor(key / (base * base))
      let streak = 0
      if (gate.suppress(n, k)) {
        streak = s + 1
        if (!isProbeOccasion(streak, thresholds)) {
          add(pack(n, k, streak), m)
          continue
        }
      }
      shown += m
      followed += m * p
      if (p > 0) add(pack(n + 1, k + 1, streak), m * p)
      if (p < 1) add(pack(n + 1, k, streak), m * (1 - p))
    }
    states = next
  }
  let suppressedAtEnd = 0
  for (const [key, m] of states) {
    const k = Math.floor(key / base) % base
    const n = Math.floor(key / (base * base))
    if (gate.suppress(n, k)) suppressedAtEnd += m
  }
  return { shown, followed, suppressedAtEnd }
}

export interface LedgerRow {
  readonly category: string
  readonly harness: string
  readonly scored: number
  readonly followed: number
  readonly pending: number
}

/** Each category's scored, followed and pending counts per harness, the populations categoryStats scores: shown, observable, and resolved or not. Opened read-only, so running this against a live ledger changes nothing. */
export function readLedger(dbPath: string): LedgerRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db
      .prepare(
        `SELECT category, harness,
                COALESCE(SUM(CASE WHEN displayed = 1 AND observable = 1 AND resolved = 1 THEN 1 ELSE 0 END), 0) AS scored,
                COALESCE(SUM(CASE WHEN displayed = 1 AND observable = 1 AND resolved = 1 THEN acted_on ELSE 0 END), 0) AS followed,
                COALESCE(SUM(CASE WHEN displayed = 1 AND observable = 1 AND resolved = 0 THEN 1 ELSE 0 END), 0) AS pending
         FROM hint_emissions GROUP BY category, harness ORDER BY category, harness`,
      )
      .all() as LedgerRow[]
  } finally {
    db.close()
  }
}

const UPTAKES = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5] as const
const RUNS = [20, 200] as const
const OCCASIONS = 200

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function main(): void {
  const cfg = getDefaultConfig('hint_stats') as HintStatsConfig
  const thresholds = (getDefaultConfig('hints') as { backoff_thresholds: number[] }).backoff_thresholds
  const bar = cfg.suppress_threshold_pct / 100
  const gates = [shippedGate(cfg), countGate(cfg), countGate({ ...cfg, min_sample_size: 20 })]

  console.log(`Shipped rule: suppress once at least ${cfg.min_sample_size} scored emissions put the 95% Wilson upper bound on the follow rate under ${cfg.suppress_threshold_pct}%; the other two columns are the raw-rate rule it replaced, at two sample floors. While suppressed, probe on occasions ${thresholds.join(', ')}, then every ${thresholds[thresholds.length - 1]}th.\n`)
  console.log('Times a hint nobody follows is shown before it is first muted:')
  for (const g of gates) console.log(`  ${g.name.padEnd(24)} ${firstSuppressionAtZero(g) ?? 'never'}`)

  console.log(`\nChance a category is muted at least once within a run of scored emissions (a useful one sits at or above ${pct(bar)}):`)
  console.log(`  ${'uptake'.padEnd(8)}${gates.flatMap((g) => RUNS.map((n) => `${g.name} /${n}`.padStart(30))).join('')}`)
  for (const p of UPTAKES) console.log(`  ${pct(p).padEnd(8)}${gates.flatMap((g) => RUNS.map((n) => pct(everSuppressedProbability(p, n, g)).padStart(30))).join('')}`)

  console.log(`\nOver ${OCCASIONS} detections, probes included: hints shown, of those followed, and the chance the category ends muted. Ideal is every hint shown at or above ${pct(bar)} and as few as possible below it.`)
  for (const p of UPTAKES) {
    const cells = gates.map((g) => {
      const e = exposure(p, OCCASIONS, g, thresholds)
      return `shown ${e.shown.toFixed(1).padStart(5)} followed ${e.followed.toFixed(1).padStart(5)} muted ${pct(e.suppressedAtEnd).padStart(6)}`
    })
    console.log(`  ${pct(p).padEnd(7)} ${cells.join('  |  ')}`)
  }
  console.log(`  (columns: ${gates.map((g) => g.name).join('  |  ')})`)

  const dbPath = arg('db')
  if (dbPath === undefined) return
  if (!existsSync(dbPath)) throw new Error(`no ledger at ${dbPath}`)
  const known = new Set<string>(HINT_CATEGORIES)
  console.log(`\nLedger ${dbPath}, opened read-only. For a category that asks for an absence, followed means complied.`)
  console.log(`  ${'category'.padEnd(24)}${'harness'.padEnd(12)}${'scored'.padStart(7)}${'followed'.padStart(9)}${'pending'.padStart(8)}${'rate'.padStart(8)}  ${'95% Wilson'.padEnd(16)}${gates.map((g) => g.name.padStart(26)).join('')}`)
  for (const r of readLedger(dbPath)) {
    if (!known.has(r.category)) continue
    const inverted = isSuppressionCategory(r.category as HintCategory)
    const ci = wilsonInterval(r.followed, r.scored)
    const rate = r.scored === 0 ? 'n/a' : pct(r.followed / r.scored)
    const verdicts = gates.map((g, i) => {
      // The shipped gate judges a suppression category through its own polarity; the alternatives are compared on the same count.
      const muted = i === 0 ? suppressesAt(r.scored, r.followed, cfg, inverted) : g.suppress(r.scored, r.followed)
      return (muted ? 'muted' : 'shown').padStart(26)
    })
    const undecided = r.scored > 0 && ci.lo < bar && ci.hi >= bar ? '  undecided' : ''
    console.log(`  ${r.category.padEnd(24)}${r.harness.padEnd(12)}${String(r.scored).padStart(7)}${String(r.followed).padStart(9)}${String(r.pending).padStart(8)}${rate.padStart(8)}  ${`[${pct(ci.lo)}, ${pct(ci.hi)}]`.padEnd(16)}${verdicts.join('')}${undecided}`)
  }
  console.log(`\n"undecided": the interval straddles ${pct(bar)}, so the ledger cannot yet say which side of the bar the category is on.`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err: unknown) {
    console.error(err)
    process.exitCode = 1
  }
}
