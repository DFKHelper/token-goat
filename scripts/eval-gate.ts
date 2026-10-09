/** CI gate on retrieval quality: builds the pinned eval corpus (the files the golden set labels plus seeded distractors), runs the `fused` and `semantic` arms of scripts/eval-retrieval.ts over it, and compares the ranks with evals/retrieval/baseline.json. Exits 1 on a significant fall in MRR@10 and on a significant rise the baseline does not record; see evals/retrieval/gate.ts. Usage: npx tsx scripts/eval-gate.ts --home <dir> [--bin dist/token-goat.mjs] [--distractors 150] [--report run.json] [--update] `--report` skips the run and gates an existing eval-retrieval report. `--update` rewrites the baseline from the run instead of comparing. The corpus is a slice on purpose: the full repository takes far longer to embed than a CI job should spend, and it changes with every commit, which would move the numbers for reasons that are not retrieval. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compareToBaseline, toBaseline, type Baseline, type RunRow } from '../evals/retrieval/gate.js'
import { num } from '../evals/retrieval/quality.js'

export const GATED_ARMS = 'fused,semantic'
export const BASELINE_PATH = 'evals/retrieval/baseline.json'
/** Distractor files in the gated corpus. */
export const GATE_DISTRACTORS = 150

interface ReportFile {
  readonly arms: Record<string, RunRow[]>
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** Runs the eval harness over the pinned corpus and returns its report. The harness exits nonzero on a crash, which is a gate failure, not a pass. */
function runEval(home: string, bin: string, distractors: number): ReportFile {
  mkdirSync(home, { recursive: true })
  const out = path.join(path.resolve(home), 'gate-report.json')
  const args = ['--import', 'tsx', 'scripts/eval-retrieval.ts', '--home', home, '--bin', path.resolve(bin), '--reindex', '--arms', GATED_ARMS, '--distractors', String(distractors), '--out', out]
  const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  if (r.error !== undefined || r.status !== 0) throw new Error(`eval-retrieval exited ${r.status}${r.error === undefined ? '' : `: ${r.error.message}`}`)
  return JSON.parse(readFileSync(out, 'utf8')) as ReportFile
}

function main(): void {
  const distractors = Number(arg('distractors') ?? GATE_DISTRACTORS)
  if (!Number.isInteger(distractors) || distractors < 0) throw new Error('--distractors takes a whole number of files')
  const reportPath = arg('report')
  const home = arg('home')
  if (reportPath === undefined && home === undefined) {
    process.stderr.write('eval-gate: --home <dir> is required unless --report is given; the eval writes to the savings ledger and must not touch your real one.\n')
    process.exit(2)
  }
  const report = reportPath !== undefined ? (JSON.parse(readFileSync(reportPath, 'utf8')) as ReportFile) : runEval(home ?? '', arg('bin') ?? 'dist/token-goat.mjs', distractors)
  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(toBaseline(report.arms, distractors), null, 1)}\n`)
    process.stdout.write(`eval-gate: wrote ${BASELINE_PATH}\n`)
    return
  }
  const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  const { rows, failures } = compareToBaseline(report.arms, base, distractors)
  for (const r of rows) process.stdout.write(`eval-gate: ${r.arm.padEnd(10)} n=${String(r.n).padStart(2)}  MRR@10 delta ${num(r.delta)}  ${r.verdict}\n`)
  for (const f of failures) process.stderr.write(`eval-gate: FAIL ${f}\n`)
  if (failures.length > 0) process.exit(1)
  process.stdout.write('eval-gate: ok, retrieval matches the committed baseline\n')
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main()
