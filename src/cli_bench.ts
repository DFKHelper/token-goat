// `token-goat bench` -- replay a fixed corpus of captured command output through the tool-output
// compressors and report what the model would actually receive.
//
// This exists because the two numbers token-goat already produces answer different questions.
// `token-goat stats` is a live ledger of real sessions: non-stationary (it measures whatever you
// happened to run this week, so two readings are not comparable) and historically prone to
// over-crediting. `tests/token_savings_benchmark.test.ts` is a floor guard over the surgical-read
// commands: it catches a catastrophic regression but treats every value above the floor as an
// identical pass, so it cannot say whether a change helped. Neither is a stable optimisation target.
//
// Two numbers are reported, deliberately not blended into one:
//
//   ratio     PRIMARY, must improve. Byte-weighted `1 - delivered/original` over the whole corpus.
//   fidelity  GUARD, must not regress. Must-keep substrings still present in the delivered body.
//
// A single metric can express "make this number go up" but not "and don't break that", and the
// cheapest route to a higher ratio is always to delete more. Folding fidelity into a weighted
// composite would let a strong ratio buy back a collapsed fidelity, so the two stay separate: the
// ratio is byte-weighted (compensatory across cases, which is what makes it a smooth target) while
// fidelity is non-compensatory -- a single missing line fails the run and exits non-zero, which is
// what makes `revert-on-failure` mechanical.
//
// `coverage` is reported alongside them because a metric that cannot observe a change is worse than
// a noisy one: if a corpus exercises no case for the filter you just improved, the ratio moves zero
// and that reads exactly like "the change did nothing".

import * as fs from 'node:fs'
import * as path from 'node:path'

import { CompressedOutput, TOOL_FILTERS, ToolFilter, combineStreams, deliverCompressed, detectFromCommand } from './tool_filters/index.js'
import { runGit } from './util.js'

/** A corpus case: one captured command output plus the lines a developer must still be able to see. */
export interface BenchCase {
  /** Stable case id, taken from the metadata filename. */
  readonly id: string
  /**
   * Where this output came from. `CAPTURE` (real output from a real run) is the only tag that
   * proves a shipped build emits this shape; `HAND-DERIVED` is honest for logic but proves nothing
   * about a wire format. A case without provenance is not evidence and is refused at load.
   */
  readonly provenance: string
  /** The command whose output this is; routed through the real filter-selection path. */
  readonly command: string
  /** Exit code the command reported. Filters treat a failure differently from a success. */
  readonly exitCode: number
  /**
   * Literal substrings that must survive compression. Written from what a developer needs out of
   * this output, never from what the filter happens to keep -- a must-keep list read off the
   * filter's own behaviour agrees with it by construction and guards nothing.
   */
  readonly mustKeep: readonly string[]
  /** The captured output itself. */
  readonly output: string
}

/** What one case scored. */
export interface BenchCaseResult {
  readonly id: string
  readonly command: string
  /** The filter that claimed the command, or null when none matched (output ships raw). */
  readonly filter: string | null
  /** True when the rewrite cleared the net-benefit floor and the compressed body actually ships. */
  readonly applied: boolean
  readonly originalBytes: number
  /** Bytes the model receives: the compressed body plus its marker, or the original when nothing applied. */
  readonly deliveredBytes: number
  readonly savedPercent: number
  readonly kept: number
  readonly mustKeepTotal: number
  /** Must-keep substrings absent from the delivered body. Non-empty means this case failed. */
  readonly missing: readonly string[]
}

/** The whole run. */
export interface BenchReport {
  readonly cases: readonly BenchCaseResult[]
  readonly originalBytes: number
  readonly deliveredBytes: number
  /** PRIMARY metric: byte-weighted savings across the corpus. 0 when nothing compressed. */
  readonly ratioPercent: number
  /** GUARD metric: must-keep substrings surviving, over the total. */
  readonly kept: number
  readonly mustKeepTotal: number
  /** Cases whose rewrite cleared the net-benefit floor. The rest shipped raw. */
  readonly appliedCases: number
  /** Distinct filters the corpus actually exercised. */
  readonly coveredFilters: number
  /** Filters registered in the shipping dispatch table. */
  readonly registeredFilters: number
  /** True when every must-keep substring survived. The run's pass/fail. */
  readonly fidelityIntact: boolean
}

/** Replaces a case's filter during `--validate`, to check the guard can actually fail. */
type ControlKind = 'none' | 'identity' | 'destroy'

/**
 * A stand-in filter used only by `--validate`. `identity` returns the output unchanged (so the
 * net-benefit gate refuses it and the raw output ships: the metric's floor); `destroy` returns
 * nothing at all (maximum ratio, zero content: the reward-hacking case the guard exists to catch).
 */
class ControlFilter extends ToolFilter {
  constructor(
    readonly name: string,
    private readonly transform: (combined: string) => string,
  ) {
    super()
  }

  override apply(stdout: string, stderr: string, exitCode: number): CompressedOutput {
    const originalBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8')
    const text = this.transform(combineStreams(stdout, stderr))
    return new CompressedOutput(text, originalBytes, Buffer.byteLength(text, 'utf8'), this.name, exitCode)
  }
}

const CONTROL_FILTERS: Readonly<Record<Exclude<ControlKind, 'none'>, ToolFilter>> = {
  identity: new ControlFilter('control:identity', (s) => s),
  destroy: new ControlFilter('control:destroy', () => ''),
}

/**
 * Ceiling on a single corpus file. A case is captured command output, so a legitimate one runs to
 * kilobytes; the whole shipped corpus is smaller than this cap. It exists because `--corpus` points
 * the loader at a directory the operator names, and every file matching the layout is read whole
 * into memory before anything validates it. Without a ceiling, one oversized or wrong-directory
 * file is an out-of-memory kill rather than an error message, and a crash reports nothing about
 * which file caused it.
 */
const MAX_BENCH_FILE_BYTES = 5 * 1024 * 1024

/** Read a corpus file, refusing one too large to be a plausible case rather than loading it. */
function readCaseFile(id: string, filePath: string, what: string): string {
  const bytes = fs.statSync(filePath).size
  if (bytes > MAX_BENCH_FILE_BYTES) {
    throw new Error(
      `bench case ${id}: ${what} is ${bytes} bytes, over the ${MAX_BENCH_FILE_BYTES}-byte limit for a corpus file (${filePath})`,
    )
  }
  return fs.readFileSync(filePath, 'utf8')
}

function parseCase(id: string, metaPath: string, outputPath: string): BenchCase {
  // Read outside the try: the size refusal below must reach the operator as itself, not be caught
  // here and reported as malformed JSON.
  const metaText = readCaseFile(id, metaPath, 'metadata')
  let raw: unknown
  try {
    raw = JSON.parse(metaText)
  } catch (e) {
    throw new Error(`bench case ${id}: ${metaPath} is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
  }
  if (typeof raw !== 'object' || raw === null) throw new Error(`bench case ${id}: expected a JSON object`)
  const meta = raw as Record<string, unknown>
  const str = (key: string): string => {
    const v = meta[key]
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`bench case ${id}: "${key}" must be a non-empty string`)
    return v
  }
  const mustKeep = meta['mustKeep']
  if (!Array.isArray(mustKeep) || mustKeep.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error(`bench case ${id}: "mustKeep" must be an array of non-empty strings`)
  }
  const exitCode = meta['exitCode']
  if (exitCode !== undefined && typeof exitCode !== 'number') throw new Error(`bench case ${id}: "exitCode" must be a number`)
  return {
    id,
    provenance: str('provenance'),
    command: str('command'),
    exitCode: typeof exitCode === 'number' ? exitCode : 0,
    mustKeep: mustKeep as string[],
    output: readCaseFile(id, outputPath, 'output'),
  }
}

/**
 * Load every case in `dir`. A case is a `<id>.json` metadata file beside an `<id>.txt` holding the
 * raw captured output -- the split keeps the output byte-exact, with no escaping between what the
 * command printed and what the compressors see.
 */
export function loadCorpus(dir: string): BenchCase[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    throw new Error(`bench corpus not found: ${dir}`)
  }
  const cases: BenchCase[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    const outputPath = path.join(dir, `${id}.txt`)
    if (!fs.existsSync(outputPath)) throw new Error(`bench case ${id}: missing output file ${outputPath}`)
    cases.push(parseCase(id, path.join(dir, entry), outputPath))
  }
  if (cases.length === 0) throw new Error(`bench corpus is empty: ${dir}`)
  return cases
}

/**
 * Score one case through the real delivery path.
 *
 * Routing and the net-benefit gate both come from the shipping code (`detectFromCommand` +
 * `deliverCompressed`), never from a local re-derivation: a benchmark that re-implements the gate
 * measures a copy, and a change to what ships would move delivery without moving the benchmark.
 */
export function runCase(c: BenchCase, control: ControlKind = 'none'): BenchCaseResult {
  const detected = detectFromCommand(c.command)
  const filter = control === 'none' ? detected?.filter : CONTROL_FILTERS[control]
  const argv = detected?.argv ?? []
  // Captured output is the combined stream a harness already merged, so it is passed as stdout.
  const delivery = filter ? deliverCompressed(filter, c.output, '', c.exitCode, argv) : null
  const body = delivery ? delivery.text + delivery.marker : c.output
  const originalBytes = Buffer.byteLength(c.output, 'utf8')
  const deliveredBytes = Buffer.byteLength(body, 'utf8')
  const missing = c.mustKeep.filter((needle) => !body.includes(needle))
  return {
    id: c.id,
    command: c.command,
    filter: filter?.name ?? null,
    applied: delivery?.applied ?? false,
    originalBytes,
    deliveredBytes,
    savedPercent: originalBytes > 0 ? (100 * Math.max(0, originalBytes - deliveredBytes)) / originalBytes : 0,
    kept: c.mustKeep.length - missing.length,
    mustKeepTotal: c.mustKeep.length,
    missing,
  }
}

/** Score a whole corpus. */
export function runCorpus(cases: readonly BenchCase[], control: ControlKind = 'none'): BenchReport {
  const results = cases.map((c) => runCase(c, control))
  const sum = (pick: (r: BenchCaseResult) => number): number => results.reduce((n, r) => n + pick(r), 0)
  const originalBytes = sum((r) => r.originalBytes)
  const deliveredBytes = sum((r) => r.deliveredBytes)
  const kept = sum((r) => r.kept)
  const mustKeepTotal = sum((r) => r.mustKeepTotal)
  return {
    cases: results,
    originalBytes,
    deliveredBytes,
    ratioPercent: originalBytes > 0 ? (100 * Math.max(0, originalBytes - deliveredBytes)) / originalBytes : 0,
    kept,
    mustKeepTotal,
    appliedCases: results.filter((r) => r.applied).length,
    coveredFilters: new Set(results.map((r) => r.filter).filter((n): n is string => n !== null)).size,
    registeredFilters: TOOL_FILTERS.length,
    fidelityIntact: kept === mustKeepTotal,
  }
}

const pct = (n: number): string => `${n.toFixed(1)}%`

function renderTable(report: BenchReport, floorPercent: number): string {
  const rows = [...report.cases].sort((a, b) => b.originalBytes - a.originalBytes)
  const idWidth = Math.max(4, ...rows.map((r) => r.id.length))
  const filterWidth = Math.max(6, ...rows.map((r) => (r.filter ?? '-').length))
  const lines: string[] = []
  const header = `${'case'.padEnd(idWidth)}  ${'filter'.padEnd(filterWidth)}  ${'in'.padStart(9)}  ${'out'.padStart(9)}  ${'saved'.padStart(7)}  fidelity`
  lines.push(header, '-'.repeat(header.length))
  for (const r of rows) {
    // An unapplied case saved nothing -- the raw output shipped -- so it prints a dash rather than a
    // percentage. Printing the filter's would-be savings there would credit compression that the
    // net-benefit gate refused and the model never received.
    const saved = r.applied ? pct(r.savedPercent) : '-'
    const fidelity = `${r.kept}/${r.mustKeepTotal}${r.missing.length ? ' FAIL' : ''}`
    lines.push(
      `${r.id.padEnd(idWidth)}  ${(r.filter ?? '-').padEnd(filterWidth)}  ${String(r.originalBytes).padStart(9)}  ${String(r.deliveredBytes).padStart(9)}  ${saved.padStart(7)}  ${fidelity}`,
    )
  }
  lines.push('-'.repeat(header.length))
  lines.push(
    `${'TOTAL'.padEnd(idWidth)}  ${''.padEnd(filterWidth)}  ${String(report.originalBytes).padStart(9)}  ${String(report.deliveredBytes).padStart(9)}  ${pct(report.ratioPercent).padStart(7)}  ${report.kept}/${report.mustKeepTotal}`,
  )
  lines.push('')
  // The floor is measured, not assumed: a score reported without it silently claims its own floor
  // is zero, and every delta then carries that unstated offset. Headroom is stated for the same
  // reason -- a small delta against a small remaining range is not the same as a small change.
  lines.push(`ratio    ${pct(report.ratioPercent)} saved  (PRIMARY -- must improve; measured floor ${pct(floorPercent)}, headroom ${pct(100 - report.ratioPercent)})`)
  lines.push(`fidelity ${report.kept}/${report.mustKeepTotal} kept   (GUARD -- must not regress; any miss exits 1)`)
  lines.push(`coverage ${report.coveredFilters}/${report.registeredFilters} filters exercised, ${report.appliedCases}/${report.cases.length} cases compressed`)
  for (const r of report.cases) {
    for (const needle of r.missing) lines.push(`  DROPPED  ${r.id}: ${JSON.stringify(needle)}`)
  }
  return lines.join('\n')
}

/**
 * Negative controls for the metric itself, per the rule that a judge you have not tried to fool is
 * not a judge. `identity` establishes the floor: a filter that changes nothing is refused by the
 * net-benefit gate, the raw output ships, and the ratio must read 0%. `destroy` is the
 * reward-hacking case: deleting everything maximises the ratio, so the guard must fail it. If
 * `destroy` ever passes fidelity, the must-keep lists are not guarding anything and no ratio
 * measured against this corpus means what it appears to mean.
 */
function renderValidation(cases: readonly BenchCase[]): { text: string; code: number } {
  const identity = runCorpus(cases, 'identity')
  const destroy = runCorpus(cases, 'destroy')
  const checks: { label: string; ok: boolean; detail: string }[] = [
    {
      // Not "scores exactly 0%": the unapplied path delivers the streams recombined, which can
      // differ from the captured bytes by a trailing newline. That is a real property of delivery,
      // so the floor is measured and reported rather than assumed -- what must hold is that the
      // net-benefit gate REFUSED every no-op rewrite, which is what makes the floor a floor.
      label: 'floor: the net-benefit gate refuses a no-op filter on every case',
      ok: identity.appliedCases === 0,
      detail: `identity control applied to ${identity.appliedCases}/${identity.cases.length} cases, measured floor ${pct(identity.ratioPercent)}`,
    },
    {
      label: 'floor: a no-op filter keeps every must-keep line',
      ok: identity.fidelityIntact,
      detail: `identity control kept ${identity.kept}/${identity.mustKeepTotal}`,
    },
    {
      label: 'guard: deleting everything is caught',
      ok: !destroy.fidelityIntact,
      detail: `destroy control kept ${destroy.kept}/${destroy.mustKeepTotal} at ${pct(destroy.ratioPercent)} saved`,
    },
  ]
  const failed = checks.filter((c) => !c.ok)
  const lines = checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.label} -- ${c.detail}`)
  lines.push('')
  lines.push(
    failed.length === 0
      ? 'The corpus discriminates: a ratio measured against it cannot be raised by deleting content.'
      : `${failed.length} control check(s) failed. Do not optimise against this corpus until they pass.`,
  )
  return { text: lines.join('\n'), code: failed.length === 0 ? 0 : 1 }
}

const TSV_HEADER = 'timestamp\tcommit\tcases\toriginal_bytes\tdelivered_bytes\tratio_percent\tfidelity_kept\tfidelity_total\tcovered_filters\n'

/**
 * Append one row keyed by the commit it measured, so a series of runs is a readable history rather
 * than a number that only exists on whichever tree is currently checked out.
 */
function appendTsv(file: string, report: BenchReport, commit: string): void {
  const row = [
    new Date().toISOString(),
    commit,
    report.cases.length,
    report.originalBytes,
    report.deliveredBytes,
    report.ratioPercent.toFixed(2),
    report.kept,
    report.mustKeepTotal,
    report.coveredFilters,
  ].join('\t')
  const dir = path.dirname(path.resolve(file))
  fs.mkdirSync(dir, { recursive: true })
  const header = fs.existsSync(file) ? '' : TSV_HEADER
  fs.appendFileSync(file, header + row + '\n', 'utf8')
}

/** The commit a row is measured against, or `'unknown'` outside a repository. */
/**
 * The commit a run is attributed to, suffixed `-dirty` when the tree carries uncommitted changes.
 * The suffix is load-bearing rather than cosmetic: the ordinary use is edit, bench, edit, bench,
 * which produces a run of rows all naming the same HEAD. Without it a history recording several
 * different attempts is indistinguishable from one recording the same code measured repeatedly.
 */
export function currentCommit(cwd?: string): string {
  const opts = cwd === undefined ? {} : { cwd }
  try {
    const r = runGit(['rev-parse', '--short', 'HEAD'], opts)
    const sha = r.stdout.trim()
    if (r.exitCode !== 0 || sha === '') return 'unknown'
    const st = runGit(['status', '--porcelain'], opts)
    return st.exitCode === 0 && st.stdout.trim() !== '' ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

export interface BenchCommandOptions {
  readonly corpus: string
  readonly json?: boolean
  readonly tsv?: string
  readonly validate?: boolean
}

/**
 * Run `token-goat bench`. Exit 1 on a dropped must-keep line, so an iteration loop can revert on
 * the exit code alone without parsing anything.
 */
export function runBenchCommand(opts: BenchCommandOptions): { text: string; code: number } {
  const cases = loadCorpus(opts.corpus)
  if (opts.validate === true) return renderValidation(cases)
  const report = runCorpus(cases)
  if (opts.tsv !== undefined) appendTsv(opts.tsv, report, currentCommit())
  const code = report.fidelityIntact ? 0 : 1
  // Scoring the corpus with a no-op filter costs one extra in-memory pass and turns the floor from
  // an assumption into a measurement.
  const floorPercent = runCorpus(cases, 'identity').ratioPercent
  if (opts.json === true) return { text: JSON.stringify({ ...report, floorPercent }, null, 2), code }
  return { text: renderTable(report, floorPercent), code }
}
