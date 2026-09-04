/**
 * Guard for the reachability claim underneath `token-goat bench`'s file paths.
 *
 * `bench` takes `--corpus <dir>` and `--tsv <path>` and does not confine either one. That is
 * deliberate: writing a results row to a file outside the repository is the normal way to keep a
 * history across attempts, and confining it would break the command's stated purpose. The reason it
 * is safe to leave unconfined is not a property of the code that opens the file, it is a property of
 * where the value comes from: both arrive from a flag the operator typed, on a command the operator
 * ran. Nothing model-controlled reaches them. No hook builds these options, no MCP tool exposes the
 * command, and nothing derives a corpus directory from file content.
 *
 * That reasoning was written down in a security response as prose, which is the shape this project
 * has repeatedly found to be invisible until it is wrong: a reachability assertion nobody can
 * re-run decays the moment someone wires the command up a second way. This guard converts it into
 * something mechanical. If a hook handler, an MCP tool, a bridge, or anything else in `src/` starts
 * calling into the bench entry points, the claim stops being true and this test says so, which is
 * the signal to re-triage the finding rather than to add the new caller to the list below.
 *
 * The population is named rather than inferred, and asserted non-empty: a guard that searches for
 * callers and finds none looks identical to a guard whose search stopped working, and this
 * repository has shipped that shape before.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

/** Entry points that accept a caller-supplied filesystem path into the bench command. */
const BENCH_ENTRY_POINTS = ['runBenchCommand', 'loadCorpus', 'appendTsv'] as const

/**
 * Files allowed to reference them, each with the reason it is not a reachability problem.
 * `cli_bench.ts` defines them; `cli.ts` is the commander dispatch table, where the values come
 * straight off the parsed command line.
 */
const ALLOWED = new Map([
  ['cli_bench.ts', 'defines the bench command'],
  ['cli.ts', 'commander dispatch: both paths come from operator-typed flags'],
])

function walkSrc(): string[] {
  const root = path.join(process.cwd(), 'src')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * Pinned: this guard's whole claim is "nothing else calls bench", which a walk returning nothing
 * would also report. The floor sits well under the current count so ordinary file churn does not
 * trip it, and the anchor is the file that defines the entry points: if the walk stops reaching
 * that one, it is no longer scanning the code this guard is about.
 */
function srcFiles(): readonly string[] {
  return pinnedPopulation({
    what: 'src/**/*.ts files scanned for bench callers',
    items: walkSrc(),
    floor: 150,
    mustInclude: ['cli_bench.ts'],
  })
}

/** Every src file naming a bench entry point, as a repo-relative path. */
function referencingFiles(): string[] {
  const pattern = new RegExp(`\\b(${BENCH_ENTRY_POINTS.join('|')})\\b`)
  return srcFiles()
    .filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(process.cwd(), f).split(path.sep).join('/'))
    .sort()
}

describe('bench file paths stay operator-typed', () => {
  // Checked per name, not in aggregate. The list first shipped with `appendTsvRow`, which matches
  // nothing in this codebase, and the whole-list check below stayed green because the other two
  // names matched: a stale entry narrows the guard's reach and reports nothing while doing it.
  it.each(BENCH_ENTRY_POINTS)('%s is a name that exists in src/', (name) => {
    const hits = srcFiles().filter((f) => new RegExp(`\\b${name}\\b`).test(fs.readFileSync(f, 'utf8')))
    expect(
      hits,
      `No file in src/ contains "${name}", so listing it in BENCH_ENTRY_POINTS widens nothing. ` +
        'Either it was renamed and the guard needs the current name, or it never existed.',
    ).not.toEqual([])
  })

  it('finds the known callers, so the search itself is working', () => {
    const found = referencingFiles()
    expect(
      found,
      'No file in src/ mentions any bench entry point. Either the command was removed, or these ' +
        'names changed and the guard below is now scanning for something that does not exist -- in ' +
        'which case it would pass against a codebase that had wired bench into a hook. Update ' +
        'BENCH_ENTRY_POINTS to the current names.',
    ).not.toEqual([])
    expect(found, 'src/cli.ts should still dispatch the bench command').toContain('src/cli.ts')
  })

  it('no caller outside the CLI dispatch path reaches the bench entry points', () => {
    const offenders = referencingFiles().filter((f) => !ALLOWED.has(path.basename(f)))
    expect(
      offenders,
      'A file outside the CLI dispatch path now calls into `token-goat bench`. Its --corpus and ' +
        '--tsv paths are unconfined on the grounds that both come from a flag the operator typed. ' +
        'A hook, MCP tool, or bridge caller breaks that premise, because those carry model-derived ' +
        'values. Do not add the file here to make this pass: confine the path at the new call site, ' +
        'or re-triage the finding this guard exists to hold open.',
    ).toEqual([])
  })
})
