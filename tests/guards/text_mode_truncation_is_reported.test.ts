/** Guard: a text-mode result set that was cut short must say so. `--json` has always carried an honest `totalCount`, so `symbol dup --json` reported 20 items with `totalCount: 40`. Text mode printed exactly the limit's worth of blocks and stopped, with nothing on stdout or stderr to distinguish "these are the matches" from "these are the first 20 of 40". `refs` did the same at its own default of 100. `find` was worse: its file list was cut by `--limit` in both modes while `truncated` stayed false, so even a JSON consumer was told the answer was complete. Why didn't a test catch this: every existing symbol/refs/find test uses a fixture small enough to fit inside the limit, so no assertion ever saw a truncated page, and the JSON tests that do exercise truncation assert on `totalCount` -- a field the text renderer does not use. The gap was a rendering one, invisible to both. These cases build a result set larger than the limit and read the literal output. Each command is asserted both ways: the footer appears when rows were dropped, and is absent when they were not. A fix that appended the line unconditionally would pass the first half alone. */
// tg-no-regex-preload: spawns the built bundle or runs a subprocess and never calls the parser in this process
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBatched, stopBatchCli } from '../helpers/batch-cli.js'

let projectDir: string
let homeDir: string

/** Every case runs the built bundle through one long-lived `--batch-serve` process (tests/helpers/batch-cli.ts) instead of a fresh node start per call: the 14 cold starts this file used to pay each cost a machine-speed-dependent amount, and a case's pass or fail should not depend on how fast a start is. The output is still the real bundle's. */
function env(): NodeJS.ProcessEnv {
  return { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir }
}

async function run(args: string[]): Promise<{ status: number; out: string }> {
  // stderr captured on the success path too: `find` emits its elision note there, and a helper that only reads stdout would report the notice as missing when it was printed.
  const res = await runBatched(args, { cwd: projectDir, env: env() })
  return { status: res.status ?? 1, out: res.stdout + res.stderr }
}

/** Same call, streams kept apart: the truth count below is read from a JSON payload on stdout, which the merged helper above would corrupt with any notice printed beside it. */
async function runSplit(args: string[]): Promise<{ out: string; err: string }> {
  const res = await runBatched(args, { cwd: projectDir, env: env() })
  return { out: res.stdout, err: res.stderr }
}

/** Five definitions of the same name across five files, each also calling both target symbols. */
const FILES = 5

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-trunc-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-trunc-home-'))
  // Two referenced symbols, so the multi-symbol `refs a,b` form has a second name to report on.
  writeFileSync(
    join(projectDir, 'target.ts'),
    'export function hotSymbol(): number {\n  return 1\n}\nexport function hotTwo(): number {\n  return 2\n}\n',
  )
  for (let i = 1; i <= FILES; i++) {
    writeFileSync(
      join(projectDir, `d${i}.ts`),
      `import { hotSymbol, hotTwo } from './target.js'\nexport function dup(): number {\n  return hotSymbol() + hotTwo() + ${i}\n}\n`,
    )
  }
  const indexed = await run(['index', '.', '--walk'])
  expect(indexed.status, `indexing the fixture failed: ${indexed.out.slice(0, 400)}`).toBe(0)
})

afterAll(stopBatchCli)

describe('symbol text mode', () => {
  it('names the true total when --limit cut the result set', async () => {
    const r = await run(['symbol', 'dup', '--limit', '3'])
    expect(r.status).toBe(0)
    expect(r.out.match(/^# dup /gm) ?? [], 'the limit itself must still apply').toHaveLength(3)
    expect(r.out, 'a truncated text result read as a complete one').toContain(`showing 3 of ${FILES} matches`)
  })

  it('says nothing when every match is shown', async () => {
    const r = await run(['symbol', 'dup', '--limit', '50'])
    expect(r.status).toBe(0)
    expect(r.out.match(/^# dup /gm) ?? []).toHaveLength(FILES)
    expect(r.out, 'a complete result claimed to be truncated').not.toContain('showing')
  })
})

describe('refs text mode', () => {
  it('names the true total when --limit cut the result set', async () => {
    const r = await run(['refs', 'target.ts::hotSymbol', '--limit', '2'])
    expect(r.status).toBe(0)
    expect(r.out, 'a truncated reference list read as a complete one').toContain(`showing 2 of ${FILES} references`)
  })

  it('names the total per symbol in the multi-symbol form', async () => {
    // The multi-spec and cross-file forms render their own line list rather than going through the single-symbol path, so each needs its own footer: fixing only the single form would leave `refs a,b` silently capped.
    const r = await run(['refs', 'target.ts::hotSymbol,hotTwo', '--limit', '2'])
    expect(r.status).toBe(0)
    expect(r.out.match(/showing 2 of \d+ references/g) ?? [], 'each symbol needs its own total').toHaveLength(2)
  })

  it('says nothing when every reference is shown', async () => {
    const r = await run(['refs', 'target.ts::hotSymbol', '--limit', '50'])
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('showing')
  })
})

describe('semantic text mode', () => {
  // The JSON half of this is driven by the row-truncation guard (tests/guards/truncation_invariant_holds.test.ts), which only ever asks for --json. Each half was covered and the pair was not: a fix that filled the envelope in and left the renderer silent would pass that guard completely.
  it('names the true match total when --limit cut the set', async () => {
    // Independent oracle: the same query with the cap lifted. A total copied from the shown count cannot satisfy this, and neither can any wrong larger number.
    const full = JSON.parse((await runSplit(['semantic', 'dup', '--limit', '999', '--json'])).out) as { items: unknown[] }
    const truth = full.items.length
    expect(truth, 'semantic matched too little for a cap to drop anything').toBeGreaterThan(2)

    const r = await run(['semantic', 'dup', '--limit', '2'])

    expect(r.out, `semantic showed 2 of ${truth} matches and said nothing`).toContain(`Showing 2 of ${truth} matches`)
  })

  it('marks a clipped candidate count as a floor, and never overstates it', async () => {
    // The candidate over-fetch is proportional to --limit, so at a very small limit the pre-cap count is itself incomplete and the notice reads 'at least N'. That hedge is the honest answer, and it is also the one shape that could hide a wrong number behind a qualifier -- so the floor is checked against the same uncapped oracle. A floor above the real total is a lie whatever word precedes it.
    const full = JSON.parse((await runSplit(['semantic', 'dup', '--limit', '999', '--json'])).out) as { items: unknown[] }
    const truth = full.items.length

    const r = await run(['semantic', 'dup', '--limit', '1'])

    const m = /Showing 1 of (?:at least )?(\d+) matches/.exec(r.out)
    expect(m, `no truncation notice at all; output was ${JSON.stringify(r.out.slice(0, 200))}`).not.toBeNull()
    expect(Number(m?.[1]), `semantic reported more matches than exist (real total ${truth})`).toBeLessThanOrEqual(truth)
    if (Number(m?.[1]) < truth) {
      expect(r.out, 'reported a count below the real total without marking it as a floor').toContain('at least')
    }
  })

  it('says nothing about a cut when every match is shown', async () => {
    const r = await run(['semantic', 'dup', '--limit', '999'])

    expect(r.out.trim(), 'nothing matched, so silence here proves nothing').not.toBe('')
    expect(r.out, 'semantic claimed a cut on a complete result').not.toMatch(/Showing \d+ of/)
  })
})

describe('find', () => {
  it('names the true total when --limit cut the file list', async () => {
    const r = await run(['find', 'dup', '--limit', '3'])
    expect(r.status).toBe(0)
    expect(r.out, 'a truncated file list read as a complete one').toContain(`Showing 3 of ${FILES} matching files`)
  })

  it('reports the cut in --json too, where truncated used to stay false', async () => {
    const r = await run(['find', 'dup', '--limit', '3', '--json'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.out) as { files: string[]; truncated: boolean }
    expect(payload.files).toHaveLength(3)
    expect(payload.truncated, 'a JSON consumer was told a cut file list was complete').toBe(true)
  })

  it('says nothing when every matching file is shown', async () => {
    const r = await run(['find', 'dup', '--limit', '50'])
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('Showing')
  })
})
