/**
 * Guard: a text-mode result set that was cut short must say so.
 *
 * `--json` has always carried an honest `totalCount`, so `symbol dup --json` reported 20 items with
 * `totalCount: 40`. Text mode printed exactly the limit's worth of blocks and stopped, with nothing
 * on stdout or stderr to distinguish "these are the matches" from "these are the first 20 of 40".
 * `refs` did the same at its own default of 100. `find` was worse: its file list was cut by
 * `--limit` in both modes while `truncated` stayed false, so even a JSON consumer was told the
 * answer was complete.
 *
 * Why didn't a test catch this: every existing symbol/refs/find test uses a fixture small enough to
 * fit inside the limit, so no assertion ever saw a truncated page, and the JSON tests that do
 * exercise truncation assert on `totalCount` -- a field the text renderer does not use. The gap was
 * a rendering one, invisible to both. These cases build a result set larger than the limit and read
 * the literal output.
 *
 * Each command is asserted both ways: the footer appears when rows were dropped, and is absent when
 * they were not. A fix that appended the line unconditionally would pass the first half alone.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  // stderr captured on the success path too: `find` emits its elision note there, and a helper that
  // only reads stdout would report the notice as missing when it was printed.
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir },
  })
  return { status: res.status ?? 1, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

/** Five definitions of the same name across five files, each also calling both target symbols. */
const FILES = 5

beforeAll(() => {
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
  run(['index', '.', '--walk'])
})

describe('symbol text mode', () => {
  it('names the true total when --limit cut the result set', () => {
    const r = run(['symbol', 'dup', '--limit', '3'])
    expect(r.status).toBe(0)
    expect(r.out.match(/^# dup /gm) ?? [], 'the limit itself must still apply').toHaveLength(3)
    expect(r.out, 'a truncated text result read as a complete one').toContain(`showing 3 of ${FILES} matches`)
  })

  it('says nothing when every match is shown', () => {
    const r = run(['symbol', 'dup', '--limit', '50'])
    expect(r.status).toBe(0)
    expect(r.out.match(/^# dup /gm) ?? []).toHaveLength(FILES)
    expect(r.out, 'a complete result claimed to be truncated').not.toContain('showing')
  })
})

describe('refs text mode', () => {
  it('names the true total when --limit cut the result set', () => {
    const r = run(['refs', 'target.ts::hotSymbol', '--limit', '2'])
    expect(r.status).toBe(0)
    expect(r.out, 'a truncated reference list read as a complete one').toContain(`showing 2 of ${FILES} references`)
  })

  it('names the total per symbol in the multi-symbol form', () => {
    // The multi-spec and cross-file forms render their own line list rather than going through the
    // single-symbol path, so each needs its own footer: fixing only the single form would leave
    // `refs a,b` silently capped.
    const r = run(['refs', 'target.ts::hotSymbol,hotTwo', '--limit', '2'])
    expect(r.status).toBe(0)
    expect(r.out.match(/showing 2 of \d+ references/g) ?? [], 'each symbol needs its own total').toHaveLength(2)
  })

  it('says nothing when every reference is shown', () => {
    const r = run(['refs', 'target.ts::hotSymbol', '--limit', '50'])
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('showing')
  })
})

describe('find', () => {
  it('names the true total when --limit cut the file list', () => {
    const r = run(['find', 'dup', '--limit', '3'])
    expect(r.status).toBe(0)
    expect(r.out, 'a truncated file list read as a complete one').toContain(`Showing 3 of ${FILES} matching files`)
  })

  it('reports the cut in --json too, where truncated used to stay false', () => {
    const r = run(['find', 'dup', '--limit', '3', '--json'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.out) as { files: string[]; truncated: boolean }
    expect(payload.files).toHaveLength(3)
    expect(payload.truncated, 'a JSON consumer was told a cut file list was complete').toBe(true)
  })

  it('says nothing when every matching file is shown', () => {
    const r = run(['find', 'dup', '--limit', '50'])
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('Showing')
  })
})
