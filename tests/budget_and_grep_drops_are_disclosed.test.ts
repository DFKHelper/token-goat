/**
 * Two drops that the row-truncation guard cannot see, because neither is a row cap.
 *
 * 1. `context-for --budget` rejects individual symbols for being too large. That is a filter, not
 *    a cap, so it has no `--limit` for the guard's registry scan to find -- and it can reject
 *    EVERY candidate, which rendered as zero lines of output and exit 0: byte-identical to a
 *    search that matched nothing, so the reader concludes there is no relevant code rather than
 *    that their budget was too small.
 *
 * 2. `types --grep` used to run against the already-capped set, because `--limit` was pushed into
 *    each kind's SQL query. A name ranked below the cap could not be found by searching for it,
 *    and the search reported honestly on a set the caller never asked for. Fixing the total (the
 *    guard's concern) required moving the cap out of SQL, which is what makes this checkable.
 *
 * Provenance: CAPTURE. Expectations are read from real runs of the built bundle against the
 * fixture below.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const FILES = 6

let projectDir: string
let homeDir: string

function run(args: string[]): { out: string; err: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, USERPROFILE: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '' }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-budget-grep-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-budget-grep-home-'))
  for (let i = 1; i <= FILES; i++) {
    // Bodies deliberately fat, so a small --budget rejects every one of them.
    const filler = Array.from({ length: 40 }, (_, k) => `  const pad${k} = ${k} * ${i}`).join('\n')
    writeFileSync(
      join(projectDir, `m${i}.ts`),
      `export interface Shape${i} {\n  a: number\n}\nexport function widget(): number {\n${filler}\n  return ${i}\n}\n`,
    )
  }
  // One declaration whose name sorts last, so it is the one a cap would drop first.
  writeFileSync(join(projectDir, 'zz.ts'), 'export interface ZebraShape {\n  z: number\n}\n')
  run(['index', '.', '--walk'])
})

describe('context-for --budget says what the budget rejected', () => {
  it('rejects every candidate at a tiny budget, and says so rather than printing nothing', () => {
    // Calibration: confirm there ARE candidates, so an empty result is the budget's doing.
    const uncapped = run(['context-for', 'widget'])
    expect(uncapped.out.trim(), 'no candidates at all; the budget case below would prove nothing').not.toBe('')

    const r = run(['context-for', 'widget', '--budget', '10'])

    expect(r.out.trim(), 'the fixture bodies are small enough to fit a 10-token budget; raise the filler').toBe('')
    expect(
      r.err,
      'every candidate was rejected by --budget and the command printed nothing at all, which is what a genuine no-match looks like',
    ).toMatch(/were larger than --budget/)
  })

  it('names the count when the budget rejects some but not all', () => {
    // Sized between "everything fits" and "nothing fits". Found by bisecting real runs, not
    // computed from the estimator, so a change to token estimation fails this loudly rather than
    // silently agreeing with itself.
    const r = run(['context-for', 'widget', '--budget', '900'])

    const m = /Showing (\d+) of (\d+) matching symbols?; (\d+) did not fit/.exec(r.err)
    expect(m, `no partial-budget notice on stderr; stderr was ${JSON.stringify(r.err.slice(0, 200))}`).not.toBeNull()
    // The three numbers have to agree with each other and with the rows actually printed.
    const shown = r.out.trim() === '' ? 0 : r.out.trim().split('\n').length
    expect(Number(m?.[1]), 'the notice reports a different count than the number of rows emitted').toBe(shown)
    expect(Number(m?.[1]) + Number(m?.[3]), 'shown + rejected does not add up to the candidate total the notice names').toBe(Number(m?.[2]))
  })

  it('stays silent when every candidate fits', () => {
    const r = run(['context-for', 'widget', '--budget', '100000'])

    expect(r.out.trim(), 'nothing was returned, so silence here proves nothing').not.toBe('')
    expect(r.err, 'claimed a budget rejection on a run where everything fit').not.toMatch(/did not fit --budget/)
  })
})

describe('types --grep searches the whole set, not just the page --limit would show', () => {
  it('finds a declaration that ranks below the cap', () => {
    // Calibration: ZebraShape must genuinely fall outside the first row, or the cap is not being
    // tested at all. `types` sorts by file path, so zz.ts sorts last among the fixture files.
    const all = JSON.parse(run(['types', '--json']).out) as { items: { name: string }[] }
    const names = all.items.map((i) => i.name)
    expect(names.length, 'fixture produced too few declarations to rank one below a cap').toBeGreaterThan(1)
    expect(names.indexOf('ZebraShape'), 'ZebraShape is not below the cap, so this case cannot detect a cap-before-filter bug').toBeGreaterThan(0)

    const r = JSON.parse(run(['types', '--limit', '1', '--grep', 'ZebraShape', '--json']).out) as { items: { name: string }[] }

    expect(
      r.items.map((i) => i.name),
      'searching by name found nothing, because the cap ran before the search and dropped the row being searched for',
    ).toContain('ZebraShape')
  })

  it('says in text mode too that the per-kind cap held rows back', () => {
    // The JSON half is driven by the row-truncation guard. Text mode is where most readers
    // see this, and it is a separate renderer -- an envelope fix does not reach it.
    const all = JSON.parse(run(['types', '--json']).out) as { items: unknown[] }
    const truth = all.items.length
    expect(truth, 'fixture declares too few types for a cap to drop anything').toBeGreaterThan(1)

    const r = run(['types', '--limit', '1'])

    expect(r.err, `types capped a list of ${truth} declarations and said nothing`).toContain(`of ${truth} type declarations`)
    expect(r.err, 'the notice does not name the flag that widens it').toContain('--limit')
  })

  it('says nothing in text mode when every declaration is shown', () => {
    const r = run(['types', '--limit', '999'])

    expect(r.out.trim(), 'no declarations at all, so silence proves nothing').not.toBe('')
    expect(r.err, 'types claimed a cut on a complete result').not.toMatch(/of \d+ type declarations/)
  })

  it('still reports the matched total against the filtered set, not the whole store', () => {
    // The filter and the cap both narrow, and the reported total has to describe the set the
    // caller asked for -- otherwise the fix above just moves the wrong number somewhere else.
    const r = JSON.parse(run(['types', '--grep', 'Shape', '--json']).out) as { items: unknown[]; totalCount: number; truncated: boolean }

    expect(r.totalCount, 'totalCount does not match the rows returned for an uncapped filtered query').toBe(r.items.length)
    expect(r.truncated, 'an uncapped filtered query was reported as truncated').toBe(false)
  })
})
