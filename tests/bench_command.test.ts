/**
 * `token-goat bench` -- the compression benchmark's own correctness.
 *
 * The command exists to be an optimisation target, which makes its failure modes unusual: a
 * benchmark that silently over-reports is worse than no benchmark, because a loop pointed at it
 * will happily optimise the reporting error. Three properties therefore carry real weight here and
 * each has a test that fails when it breaks:
 *
 *   1. It measures the SHIPPING path. `runCase` must agree byte for byte with `deliverCompressed`,
 *      the function `bash_runner` uses to decide what the model receives. A benchmark with its own
 *      copy of the net-benefit gate would keep reporting the old number after delivery changed.
 *   2. The fidelity guard can actually fail. A must-keep list that nothing can violate is not a
 *      guard, and since deleting content RAISES the ratio, an inert guard would let the primary
 *      metric be maximised by destroying output.
 *   3. A refused rewrite is credited nothing. Below the net-benefit floor the raw output ships, so
 *      reporting the filter's would-be savings there would credit compression the model never got.
 *
 * Fixture provenance: the repository corpus under tests/fixtures/bench is CAPTURE (each case's
 * .json names the exact command and date; the .txt is that run's redirected output, unedited). The
 * corpora built inside this file are HAND-DERIVED -- they encode loader and arithmetic logic, and
 * are deliberately not used to assert anything about what a real filter emits.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { currentCommit, loadCorpus, runBenchCommand, runCase, runCorpus } from '../src/cli_bench.js'
import { deliverCompressed, detectFromCommand } from '../src/tool_filters/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_CORPUS = path.join(HERE, 'fixtures', 'bench')

const tempDirs = new Set<string>()

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

/** Build a throwaway corpus on disk. HAND-DERIVED: exercises the loader, not any filter's output. */
function corpus(cases: Record<string, { meta: unknown; output: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-'))
  tempDirs.add(dir)
  for (const [id, { meta, output }] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta), 'utf8')
    fs.writeFileSync(path.join(dir, `${id}.txt`), output, 'utf8')
  }
  return dir
}

const GIT_LOG = Array.from({ length: 400 }, (_, i) => `commit ${String(i).padStart(40, '0')}\n\n    subject line ${i}\n`).join('\n')

describe('bench corpus loading', () => {
  it('reads a well-formed case', () => {
    const dir = corpus({ a: { meta: { provenance: 'HAND-DERIVED', command: 'git log', mustKeep: ['x'] }, output: 'x\n' } })
    const [c] = loadCorpus(dir)
    expect(c?.command).toBe('git log')
    expect(c?.exitCode).toBe(0)
    expect(c?.output).toBe('x\n')
  })

  it('refuses a case with no provenance, because an untagged fixture is not evidence', () => {
    const dir = corpus({ a: { meta: { command: 'git log', mustKeep: [] }, output: 'x' } })
    expect(() => loadCorpus(dir)).toThrow(/provenance/)
  })

  it('refuses a case whose mustKeep is not a list of non-empty strings', () => {
    const dir = corpus({ a: { meta: { provenance: 'p', command: 'git log', mustKeep: ['ok', ''] }, output: 'x' } })
    expect(() => loadCorpus(dir)).toThrow(/mustKeep/)
  })

  it('refuses a metadata file with no output beside it', () => {
    const dir = corpus({ a: { meta: { provenance: 'p', command: 'git log', mustKeep: [] }, output: 'x' } })
    fs.rmSync(path.join(dir, 'a.txt'))
    expect(() => loadCorpus(dir)).toThrow(/missing output file/)
  })

  it('refuses an empty corpus rather than reporting a vacuous 0%', () => {
    expect(() => loadCorpus(corpus({}))).toThrow(/empty/)
  })

  // `--corpus` reads every file matching the layout in a directory the operator names, whole, into
  // memory, before anything validates it. The refusal is checked against a real oversized file on
  // disk rather than a stubbed stat: a mocked size would pass whether or not the code ever asks the
  // filesystem, which is exactly the thing under test.
  it('refuses an output file too large to be a captured case, instead of loading it whole', () => {
    const dir = corpus({ a: { meta: { provenance: 'HAND-DERIVED', command: 'git log', mustKeep: [] }, output: 'x\n' } })
    fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
    expect(() => loadCorpus(dir)).toThrow(/output is \d+ bytes, over the \d+-byte limit/)
  })

  // The metadata file needs its own case: it is read inside a try that reports a parse failure, so
  // a size refusal raised in the wrong place would surface as "not valid JSON" and send whoever hit
  // it looking for a syntax error in a file that is merely too big.
  it('refuses an oversized metadata file as oversized, not as malformed JSON', () => {
    const dir = corpus({ a: { meta: { provenance: 'HAND-DERIVED', command: 'git log', mustKeep: [] }, output: 'x\n' } })
    fs.writeFileSync(path.join(dir, 'a.json'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
    expect(() => loadCorpus(dir)).toThrow(/metadata is \d+ bytes, over the \d+-byte limit/)
    expect(() => loadCorpus(dir)).not.toThrow(/valid JSON/)
  })
})

describe('bench measures the shipping path', () => {
  // The load-bearing test. If `runCase` ever stops routing through `deliverCompressed`, delivery
  // and the benchmark can disagree -- and the benchmark is the thing that would keep saying the
  // old number.
  it('reports exactly the bytes deliverCompressed would hand to the model', () => {
    for (const c of loadCorpus(REPO_CORPUS)) {
      const detected = detectFromCommand(c.command)
      expect(detected, `${c.id}: corpus command no longer routes to a filter`).not.toBeNull()
      const d = deliverCompressed(detected!.filter, c.output, '', c.exitCode, detected!.argv)
      const expected = Buffer.byteLength(d.text + d.marker, 'utf8')
      const result = runCase(c)
      expect(result.deliveredBytes, c.id).toBe(expected)
      expect(result.filter, c.id).toBe(detected!.filter.name)
      expect(result.applied, c.id).toBe(d.applied)
    }
  })

  it('credits a refused rewrite with no savings, because the raw output is what ships', () => {
    const report = runCorpus(loadCorpus(REPO_CORPUS))
    for (const r of report.cases.filter((x) => !x.applied)) {
      // Delivery recombines the streams, which can move a trailing newline; nothing beyond that.
      expect(Math.abs(r.originalBytes - r.deliveredBytes), r.id).toBeLessThanOrEqual(2)
    }
  })
})

describe('the fidelity guard discriminates', () => {
  it('fails when a filter deletes everything, even though that maximises the ratio', () => {
    const cases = loadCorpus(REPO_CORPUS)
    const destroyed = runCorpus(cases, 'destroy')
    // The ratio -- the metric a loop would be maximising -- goes UP while the output is destroyed.
    expect(destroyed.ratioPercent).toBeGreaterThan(runCorpus(cases).ratioPercent)
    expect(destroyed.kept).toBe(0)
    expect(destroyed.fidelityIntact).toBe(false)
  })

  it('holds the floor: the net-benefit gate refuses a no-op filter on every case', () => {
    const cases = loadCorpus(REPO_CORPUS)
    const identity = runCorpus(cases, 'identity')
    expect(identity.appliedCases).toBe(0)
    expect(identity.fidelityIntact).toBe(true)
    // Without this half, `appliedCases` hardcoded to 0 would satisfy the assertion above and the
    // floor check in --validate at the same time -- a constant is not a measurement.
    expect(runCorpus(cases).appliedCases).toBeGreaterThan(0)
  })

  it('reports the real corpus as intact, so a failure means a real drop', () => {
    const report = runCorpus(loadCorpus(REPO_CORPUS))
    expect(report.fidelityIntact).toBe(true)
    expect(report.mustKeepTotal).toBeGreaterThan(0)
    expect(report.ratioPercent).toBeGreaterThan(0)
  })

  it('names every dropped line rather than only counting them', () => {
    const dir = corpus({
      a: { meta: { provenance: 'HAND-DERIVED', command: 'git log', mustKeep: ['a line no filter can invent'] }, output: GIT_LOG },
    })
    const r = runCase(loadCorpus(dir)[0]!)
    expect(r.missing).toEqual(['a line no filter can invent'])
    expect(r.kept).toBe(0)
  })
})

describe('bench command', () => {
  it('exits 1 when a must-keep line was dropped, so a loop can revert on the exit code alone', () => {
    const dir = corpus({
      a: { meta: { provenance: 'HAND-DERIVED', command: 'git log', mustKeep: ['nothing emits this'] }, output: GIT_LOG },
    })
    const { text, code } = runBenchCommand({ corpus: dir })
    expect(code).toBe(1)
    expect(text).toContain('DROPPED')
  })

  it('exits 0 and reports both metrics plus the measured floor on the real corpus', () => {
    const { text, code } = runBenchCommand({ corpus: REPO_CORPUS })
    expect(code).toBe(0)
    expect(text).toMatch(/ratio\s+\d+\.\d% saved/)
    expect(text).toMatch(/measured floor \d+\.\d%/)
    expect(text).toMatch(/fidelity \d+\/\d+ kept/)
    expect(text).toMatch(/coverage \d+\/\d+ filters exercised/)
  })

  it('passes --validate on the shipped corpus, and fails it on a corpus that guards nothing', () => {
    expect(runBenchCommand({ corpus: REPO_CORPUS, validate: true }).code).toBe(0)
    // No must-keep lines at all: deleting the entire output would score 100% and pass.
    const inert = corpus({ a: { meta: { provenance: 'HAND-DERIVED', command: 'git log', mustKeep: [] }, output: GIT_LOG } })
    const r = runBenchCommand({ corpus: inert, validate: true })
    expect(r.code).toBe(1)
    expect(r.text).toContain('Do not optimise against this corpus')
  })

  it('appends one TSV row per run and writes the header exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-tsv-'))
    tempDirs.add(dir)
    const tsv = path.join(dir, 'nested', 'bench.tsv')
    runBenchCommand({ corpus: REPO_CORPUS, tsv })
    runBenchCommand({ corpus: REPO_CORPUS, tsv })
    const lines = fs.readFileSync(tsv, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('ratio_percent')
    expect(lines.filter((l) => l.startsWith('timestamp'))).toHaveLength(1)
    for (const row of lines.slice(1)) expect(row.split('\t')).toHaveLength(9)
  })

  it('emits JSON carrying both metrics and the measured floor', () => {
    const { text, code } = runBenchCommand({ corpus: REPO_CORPUS, json: true })
    expect(code).toBe(0)
    const report = JSON.parse(text) as { ratioPercent: number; floorPercent: number; fidelityIntact: boolean; cases: unknown[] }
    expect(report.fidelityIntact).toBe(true)
    expect(report.ratioPercent).toBeGreaterThan(report.floorPercent)
    expect(report.cases.length).toBeGreaterThan(0)
  })

  // Found by running the installed binary rather than by a test: the ordinary use is edit, bench,
  // edit, bench, so a whole run of TSV rows names the same HEAD. Undecorated, a history recording
  // several different attempts is indistinguishable from one recording the same code repeatedly.
  it('marks a run measured against a modified tree, so two attempts at one commit are distinguishable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-git-'))
    tempDirs.add(dir)
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    }
    git('init', '-q')
    git('config', 'user.email', 't@example.invalid')
    git('config', 'user.name', 'T')
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n', 'utf8')
    git('add', '-A')
    git('commit', '-qm', 'first')

    const clean = currentCommit(dir)
    expect(clean).toMatch(/^[0-9a-f]{7,}$/)

    fs.writeFileSync(path.join(dir, 'f.txt'), 'two\n', 'utf8')
    expect(currentCommit(dir)).toBe(`${clean}-dirty`)
  })

  it('reports a corpus directory that does not exist rather than scoring zero cases', () => {
    expect(() => runBenchCommand({ corpus: path.join(os.tmpdir(), 'tg-bench-absent-dir') })).toThrow(/corpus not found/)
  })
})
