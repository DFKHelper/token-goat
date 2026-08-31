/**
 * Guard: a command that returns fewer rows than it found must say so, and the number it says it
 * with must be the *pre-cap* total.
 *
 * tests/guards/text_mode_truncation_is_reported.test.ts is the ancestor of this file and covers
 * three commands: symbol, refs, find. Thirty-eight commands accept a row-limiting flag. The gap
 * was not an oversight so much as the default outcome -- a guard written against the commands that
 * had the bug that week stays pointed there, and this repo has shipped that decay twice before
 * (`stats --json`'s payload whitelist, the Copilot canonical builder), both times as coverage that
 * looked present and was dead.
 *
 * Two things are asserted, and the second is the one that matters:
 *
 *  1. Disclosure -- a capped result carries a truncation signal.
 *  2. The invariant -- `totalCount` is the size of the set *before* the cap, so
 *     `truncated` implies `totalCount > items.length`.
 *
 * A guard that asserted only (1) would have passed on the real defect this repo shipped. In
 * src/read_commands.ts the payload was built from `capped.totalCount`, which equals
 * `results.length` *after* the cap: the flag was `true`, the field was present, and the number
 * beside it was a restatement of `items.length`. Present-and-wrong, not absent. Both fixes in that
 * file were applied by hand at one call site each; nothing enforced the rule anywhere else, which
 * is what this file is for.
 *
 * A shared row-limit-plus-budget helper was written for the three defects this guard found and
 * then deleted unused: they needed three different shapes. `find` had an object payload and
 * wanted one more field; `similar` had a bare array and could only disclose out of band; and
 * `logfold` caps input lines while emitting folded rows, so it has no single pre-cap row count
 * to report at all. The common invariant is real and is what this guard asserts, but it does
 * not factor into common code -- an uncalled helper would only have looked like coverage.
 *
 * Scope comes from `commandsWithRowLimit()` in tests/registry.ts, derived from the shipping
 * commander program, so a new `--limit` command is in scope on the day it is registered rather
 * than the day somebody remembers. Commands that cannot be exercised by a filesystem fixture are
 * listed in EXEMPT with a reason each; the list is asserted to contain no command that has since
 * become testable, so it ratchets down rather than accumulating.
 *
 * Provenance: every expectation here is CAPTURE -- taken from running the built bundle against the
 * fixture below, not read off the emitting code. A fixture derived from the producer's own source
 * agrees with the producer by construction, including when the producer is wrong, and that exact
 * mistake has been found six times in this repo across three unrelated subsystems.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { commandsWithRowLimit } from '../registry.js'
import { SESSION_TRUNCATION_COMMANDS } from './session_truncation_commands.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

/** Distinct files each defining `dup` and referencing both target symbols, so every row-producing command has more than a handful of results to cut. */
const FILES = 8
/** The cap every case below applies. Small enough to be well under FILES, large enough that an off-by-one in a slice is not mistaken for a working cap. */
const LIMIT = 2

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string; err: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    // All four, and the home directory deliberately outside projectDir: a home nested inside the
    // indexed root makes `index . --walk` refuse to run, and the resulting empty index turns every
    // case below into a "no matches" pass.
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, USERPROFILE: homeDir },
  })
  return { status: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' }
}

/** Parse a `--json` payload, failing with the raw output rather than a bare SyntaxError. */
/** Parse stdout as JSON, or undefined. Used where the case also needs stderr, so it cannot go through runJson. */
function safeParse(out: string): unknown {
  try {
    return JSON.parse(out) as unknown
  } catch {
    return undefined
  }
}

function runJson(args: string[]): unknown {
  const r = run([...args, '--json'])
  try {
    return JSON.parse(r.out)
  } catch {
    expect.fail(`\`${args.join(' ')} --json\` did not emit JSON.\nstdout: ${r.out.slice(0, 300)}\nstderr: ${r.err.slice(0, 300)}`)
  }
}

/** The rows in a payload, whether it is a bare array or an envelope with a single array field. */
function rowsOf(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload
  if (payload === null || typeof payload !== 'object') return undefined
  const arrays = Object.values(payload as Record<string, unknown>).filter(Array.isArray)
  return arrays.length === 1 ? (arrays[0] as unknown[]) : undefined
}

/**
 * Where a command is required to disclose a cut. Not a style preference -- it follows from the
 * payload shape, and the repo has already settled it both ways:
 *
 * - `envelope`: the --json payload is an object, so the flag and the total ride in-band where a
 *   `cmd --json | jq` consumer sees them. This is the required channel whenever the shape allows.
 * - `stderr`: the --json payload is a deliberate bare array (`similar`, `coverage-gaps`, `impact`)
 *   with nowhere in-band to put a flag. Adding one is a breaking change to a public output shape,
 *   so these report the clipped count on stderr instead -- the choice runCoverageGaps documents in
 *   its own source. The residual risk is real and is the price of not breaking consumers: a
 *   `cmd --json | jq` pipeline discards stderr and still sees an unmarked short list. What the
 *   guard refuses to accept is a command that discloses on NEITHER channel.
 */
type Disclosure =
  /** Field carrying the pre-cap total. Commands predate one naming convention; `brief` says `totalCallers`. */
  | { readonly kind: 'envelope'; readonly totalField: string }
  | { readonly kind: 'stderr' }
  /**
   * `stderr-more`: the cap goes into the SQL query itself, so the rows past it are never fetched
   * and never counted -- an exact total would cost a second full query on every call. These fetch
   * one row beyond the cap, which buys the honest half (THAT a remainder exists) for one row, and
   * say so without naming a number they did not compute. Same kind `recall` uses in the session
   * half of this guard. The assertion deliberately does not pin the wording, only that a
   * remainder is signalled and the flag to raise is named -- pinning prose makes a rewrite fail a
   * guard that has nothing to say about it.
   */
  | { readonly kind: 'stderr-more' }

/** A command this guard drives, with the arguments that make it return more than LIMIT rows. */
interface Case {
  readonly command: string
  readonly args: readonly string[]
  readonly flag: string
  readonly disclosure: Disclosure
}

const ENVELOPE: Disclosure = { kind: 'envelope', totalField: 'totalCount' }
const STDERR: Disclosure = { kind: 'stderr' }
const STDERR_MORE: Disclosure = { kind: 'stderr-more' }

const CASES: readonly Case[] = [
  { command: 'symbol', args: ['symbol', 'dup'], flag: '--limit', disclosure: ENVELOPE },
  { command: 'refs', args: ['refs', 'target.ts::hotSymbol'], flag: '--limit', disclosure: ENVELOPE },
  { command: 'callers', args: ['callers', 'target.ts::hotSymbol'], flag: '--limit', disclosure: ENVELOPE },
  { command: 'find', args: ['find', 'dup'], flag: '--limit', disclosure: ENVELOPE },
  { command: 'dead', args: ['dead'], flag: '--top', disclosure: ENVELOPE },
  { command: 'brief', args: ['brief', 'target.ts::hotSymbol'], flag: '--limit', disclosure: { kind: 'envelope', totalField: 'totalCallers' } },
  { command: 'csv-query', args: ['csv-query', 'data.csv'], flag: '--head', disclosure: ENVELOPE },
  { command: 'json-query', args: ['json-query', 'data.json', 'rows[*].name'], flag: '--head', disclosure: ENVELOPE },
  { command: 'yaml-query', args: ['yaml-query', 'data.json', 'rows[*].name'], flag: '--head', disclosure: ENVELOPE },
  { command: 'tokens', args: ['tokens', '*.ts'], flag: '--top', disclosure: ENVELOPE },
  { command: 'types', args: ['types'], flag: '--limit', disclosure: ENVELOPE },
  { command: 'semantic', args: ['semantic', 'dup'], flag: '--limit', disclosure: ENVELOPE },
  // Bare-array payloads: nowhere in-band to carry a flag without breaking every consumer.
  { command: 'similar', args: ['similar', 'target.ts::hotSymbol'], flag: '--top', disclosure: STDERR },
  { command: 'coverage-gaps', args: ['coverage-gaps'], flag: '--top', disclosure: STDERR },
  // Cap lives in the SQL LIMIT, so there is no pre-cap total to name -- see `stderr-more`.
  { command: 'context-for', args: ['context-for', 'dup'], flag: '--top', disclosure: STDERR_MORE },
  { command: 'ask', args: ['ask', 'dup'], flag: '--top', disclosure: STDERR_MORE },
]

/**
 * Commands whose row cap this guard does not drive, each with the reason. A reason is required, and
 * the case below rejects any entry whose stated reason has stopped being true, so the list ratchets
 * down: an exemption survives only as long as nobody makes the command testable.
 *
 * Note what is *not* a reason: "this command's truncation looks fine". That is a claim the guard
 * exists to check, and accepting it as prose would reproduce the whitelist this file replaces.
 */
/**
 * Commands this guard does not drive, each with the reason it does not.
 *
 * A reason here has to be TRUE, not merely present. Thirteen entries once shared the reason
 * "a fixture cannot create one" for their session-backed data; `storeWebOutput` seeds that cache
 * in a single call, and six of those commands turned out to drop rows silently. An exemption
 * with a false reason is worse than a missing test: a gap reads as a decision, and nobody looks
 * again. Those six now live in truncation_invariant_holds_session.test.ts.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['retrieve', '--head/--tail trim LINES of cached text, not rows of a list, so "the pre-cap count of the rows being capped" is not a quantity that exists here -- the same unit mismatch that gives logfold its own test. Disclosure is line-shaped and driven by tests/cached_output_elision_discloses.test.ts. That test exists because the first version of THIS reason was false: it claimed the render path already disclosed, and a real run showed the one-sided --head/--tail branches emitting nothing at all'],
  ['bash-output', 'line trim on cached text, not a row list; disclosure driven by tests/cached_output_elision_discloses.test.ts, alongside retrieve'],
  ['web-output', 'line trim on cached text, not a row list; disclosure driven by tests/cached_output_elision_discloses.test.ts, alongside retrieve'],
  ['mcp-output', 'line trim on cached text, not a row list; disclosure driven by tests/cached_output_elision_discloses.test.ts, alongside retrieve'],
  ['waste', '--top sizes an explicit ranking -- the field is literally `topCalls` -- and the report carries its own whole-set aggregate computed before it. Verified rather than assumed: totalTokens is byte-identical at --top 2 and --top 500 on a real session, so a capped page cannot be mistaken for the whole spend. Contrast `tokens`, which paired a sliced list with a whole-set total and IS driven above'],
  ['bootstrap-audit', 'reads an installed agent/skill tree under a home directory rather than an indexed project, and its payload carries four arrays, so it fits neither this fixture nor rowsOf(). Driven against a real seeded home in tests/arch_bootstrap_truncation_discloses.test.ts. The old reason (\'audits an installed agent configuration, not a project\') described why a fixture is awkward and was read as why no check was needed; --top 1 against 77 installed entries rendered one row and said nothing'],
  ['impact', 'discloses correctly today -- a real run prints \'Showing top 2 of 955 impacted symbols\' plus a separate hop-depth notice -- but its bare-array payload needs a caller graph deeper than this fixture builds to exercise either. Covered by its own hop-depth tests. The previous reason (\'its cap does not engage on a fixture this size\') was a statement about the fixture written as though it were one about the command'],
  ['arch', 'reports three lists (hubs, entry points, cycles) under one --top, so its payload has no single row array for this guard\'s rowsOf() to cap and count -- a shape mismatch, not an untestable command. Each list carries its own total, checked in tests/arch_bootstrap_truncation_discloses.test.ts. That test exists because THIS reason was once \'there is no single row list to check\', which is true of the harness and was silently read as true of the command: a real run showed hubs and entry points both cut from 270 and 511 down to 2 with nothing said on either channel'],
  ['refs --top', '--top switches refs to a per-FILE histogram, a different payload from --limit\'s row list, and that payload already discloses: a real run reports totalFiles: 68 beside shown: 2. The row-list half is driven by the refs case above. The previous reason claimed the two flags share one envelope, which is not true of either the shape or the code path'],
  ['xlsx-query', 'needs a binary .xlsx fixture; the same query envelope is covered through csv-query and json-query'],
  ['sqlite-query', 'needs a binary .db fixture; the same query envelope is covered through csv-query and json-query'],
  ['xml-query', 'needs an XML fixture; the same query envelope is covered through csv-query and json-query'],
  ['pdf-extract', 'needs a binary PDF fixture; text extraction, not a row list'],
  ['docx-text', 'needs a binary .docx fixture; text extraction, not a row list'],
  ['logfold', 'its cap is on INPUT LINES while the payload is folded rows -- different units, so "the pre-cap count of the rows being capped" is not a quantity that exists here. It does disclose, in-band and on stderr; driven by its own case in tests/logfold_tail_discloses.test.ts'],
])

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-trunc-inv-'))
  // Outside projectDir on purpose -- see the note in run().
  homeDir = mkdtempSync(join(tmpdir(), 'tg-trunc-inv-home-'))
  writeFileSync(
    join(projectDir, 'target.ts'),
    'export function hotSymbol(): number {\n  return 1\n}\nexport function hotTwo(): number {\n  return 2\n}\n',
  )
  for (let i = 1; i <= FILES; i++) {
    writeFileSync(
      join(projectDir, `d${i}.ts`),
      `import { hotSymbol, hotTwo } from './target.js'\nexport interface Rec${i} {\n  a: number\n}\nexport function dup(): number {\n  return hotSymbol() + hotTwo() + ${i}\n}\n`,
    )
  }
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, name: `n${i}` }))
  writeFileSync(join(projectDir, 'data.csv'), `a,b\n${rows.map((r) => `${r.id},${r.name}`).join('\n')}\n`)
  writeFileSync(join(projectDir, 'data.json'), JSON.stringify({ rows }))
  run(['index', '.', '--walk'])
})

describe('the guard covers every row-limited command or names why not', () => {
  it('indexed the fixture, so a "no matches" result cannot pass as a complete one', () => {
    const payload = runJson(['symbol', 'dup']) as { items?: unknown[] }

    expect(payload.items ?? [], 'the fixture index is empty; every case below would assert on nothing').toHaveLength(FILES)
  })

  it('every row-limited command is either driven by a case or exempt with a reason', () => {
    // The session-cache half of this guard drives SESSION_TRUNCATION_COMMANDS; those are covered,
    // not exempt, and the shared list is what keeps that claim from going stale.
    const covered = new Set([...CASES.map((c) => c.command), ...SESSION_TRUNCATION_COMMANDS])
    const uncovered = commandsWithRowLimit()
      .map((c) => c.name)
      .filter((name) => !covered.has(name) && !EXEMPT.has(name))

    expect(
      uncovered,
      `these commands cap their rows and nothing checks that they say so: ${uncovered.join(', ')}. ` +
        `Add a case to CASES, or an entry to EXEMPT with the reason it cannot be driven.`,
    ).toEqual([])
  })

  it('carries no exemption for a command that no longer takes a row limit', () => {
    // An exemption for a command that has since lost its cap, or been renamed, reads as coverage
    // being deliberately skipped when in fact there is nothing left to skip. Left alone the list
    // only grows, and a growing list of reasons is how a guard turns back into a whitelist.
    const limited = new Set(commandsWithRowLimit().map((c) => c.name))
    const stale = [...EXEMPT.keys()].filter((name) => !limited.has(name) && !name.includes(' --'))

    expect(stale, `EXEMPT names command(s) that no longer take a row-limiting flag: ${stale.join(', ')}. Remove them.`).toEqual([])
  })

  it('carries no exemption for a command a case now drives', () => {
    const covered = new Set(CASES.map((c) => c.command))
    const both = [...EXEMPT.keys()].filter((name) => covered.has(name))

    expect(both, `EXEMPT and CASES both name: ${both.join(', ')}. A driven command needs no exemption.`).toEqual([])
  })
})

describe.each(CASES)('$command $flag', ({ command, args, flag, disclosure }) => {
  /** Rows the command returns with the cap effectively lifted -- the independent measure of truth. */
  const uncappedRows = (): number => rowsOf(runJson([...args, flag, '999']))?.length ?? 0

  it('applies the cap at all, so the rest of this case is not asserting on an uncapped result', () => {
    // Calibration. Without it, a command that silently ignored its flag would satisfy every
    // assertion below by returning a complete result that was never truncated -- a green tick
    // that means the opposite of what it appears to mean.
    const capped = rowsOf(runJson([...args, flag, String(LIMIT)]))
    const uncapped = rowsOf(runJson([...args, flag, '999']))

    expect(capped, `${command} --json has no single row array to check`).toBeDefined()
    expect(uncapped).toBeDefined()
    expect(capped ?? [], `${command} ${flag} ${LIMIT} returned ${capped?.length ?? 0} rows; the flag is not capping`).toHaveLength(LIMIT)
    expect(
      (uncapped ?? []).length,
      `${command} returns ${uncapped?.length ?? 0} rows uncapped, so ${flag} ${LIMIT} drops nothing and this case proves nothing`,
    ).toBeGreaterThan(LIMIT)
  })

  it('discloses the cut, and the total it reports is the real one', () => {
    const r = run([...args, flag, String(LIMIT), '--json'])
    const rows = rowsOf(safeParse(r.out))
    const shown = rows?.length ?? 0
    // Measured independently of anything the command claims, so a total that is merely
    // self-consistent (`items.length` restated, or a count of some other set) still fails.
    const truth = uncappedRows()

    if (disclosure.kind === 'envelope') {
      const payload = safeParse(r.out)
      const envelope = (typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>

      expect(
        envelope.truncated,
        `${command} ${flag} ${LIMIT} returned ${shown} of ${truth} rows and did not set truncated. ` +
          `A consumer cannot tell this apart from a complete answer.`,
      ).toBe(true)

      const total = envelope[disclosure.totalField]
      expect(
        typeof total,
        `${command} sets truncated but carries no numeric ${disclosure.totalField}. "Something was cut" without ` +
          `"how much" leaves the reader unable to ask for the rest.`,
      ).toBe('number')
      // Equality, not "greater than shown": a total that merely exceeds the returned count is
      // satisfied by any wrong-but-larger number, which is how a count of a different set has
      // shipped here before.
      expect(
        total as number,
        `${command} reports ${disclosure.totalField}=${String(total)}, but the command returns ${truth} rows uncapped. ` +
          `The disclosed total must be the pre-cap count of the very rows being capped.`,
      ).toBe(truth)
      return
    }

    if (disclosure.kind === 'stderr-more') {
      // No exact total is claimed, so there is nothing to check for equality. What must be true
      // is that a remainder was signalled at all, and that the reader is told which flag widens
      // it -- the two things that separate a clipped page from a complete one.
      expect(
        /more/i.test(r.err),
        `${command} ${flag} ${LIMIT} returned ${shown} of ${truth} rows and signalled no remainder on stderr. ` +
          `Its cap is applied in SQL, so nothing in the payload can carry this either.
stderr was: ${JSON.stringify(r.err.slice(0, 200))}`,
      ).toBe(true)
      expect(
        r.err.includes(flag),
        `${command} says more exists but does not name ${flag}, so the reader is told to look further without being told how.`,
      ).toBe(true)
      return
    }

    // Bare array: the count has to arrive on stderr or not at all.
    const m = /Showing (?:top|last) (\d+) of (\d+)/.exec(r.err)
    expect(
      m,
      `${command} ${flag} ${LIMIT} returned ${shown} of ${truth} rows as a bare array and printed no ` +
        `"Showing top N of M" notice on stderr. With no envelope to carry a flag and nothing on stderr, ` +
        `a clipped page is byte-identical to the complete list.
stderr was: ${JSON.stringify(r.err.slice(0, 200))}`,
    ).not.toBeNull()
    expect(Number(m?.[1]), `${command}'s notice says it is showing ${m?.[1]} rows but emitted ${shown}`).toBe(shown)
    expect(
      Number(m?.[2]),
      `${command}'s notice reports a total of ${m?.[2]}, but the command returns ${truth} rows uncapped.`,
    ).toBe(truth)
  })

  it('says nothing about truncation when the whole result fits', () => {
    // The other half. A fix that set truncated unconditionally, or printed the notice on every
    // run, would pass the case above on its own.
    const r = run([...args, flag, '999', '--json'])

    if (disclosure.kind === 'envelope') {
      const payload = safeParse(r.out)
      const envelope = (typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>
      expect(envelope.truncated ?? false, `${command} reports a complete result as truncated`).toBe(false)
      return
    }
    if (disclosure.kind === 'stderr-more') {
      expect(
        /more/i.test(r.err),
        `${command} signalled a remainder on a complete result: ${JSON.stringify(r.err.slice(0, 200))}`,
      ).toBe(false)
      return
    }
    expect(
      /Showing (?:top|last) \d+ of \d+/.test(r.err),
      `${command} printed a truncation notice for a complete result: ${JSON.stringify(r.err.slice(0, 200))}`,
    ).toBe(false)
  })
})
