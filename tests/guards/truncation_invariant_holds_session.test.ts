/**
 * Truncation invariant, session-cache half.
 *
 * The sibling guard (truncation_invariant_holds.test.ts) covers commands whose rows come from a
 * project index, and exempted every command whose rows come from a session cache or transcript on
 * the stated grounds that "a fixture cannot create one". That reason was false. `storeWebOutput`,
 * `storeBashOutput` and `storeMcpOutput` each seed their cache in one call, `recordFileRead` seeds
 * session read data, and tests/cli_output_section_notfound.test.ts already drives the real CLI
 * against a seeded cache. Thirteen commands sat behind that wrong reason, and four of the first
 * five checked turned out to drop rows with no disclosure of any kind.
 *
 * That is the more dangerous half of the failure, not the lesser one: an exemption with a true
 * reason is a known gap, while an exemption with a false reason reads as coverage and stops anyone
 * looking again. Same shape as the guard-gate defect in this repo's own history where a population
 * emptied silently and every assertion inside the loop kept passing.
 *
 * Provenance: CAPTURE. Every expectation here is read off a real run of the built bundle against a
 * seeded cache, never off the producing function's source.
 *
 * Seeding is in-process while the assertions spawn the built bundle, so both must agree on where
 * the cache lives. They do because this file deliberately does NOT mint its own home directory: it
 * inherits the one tests/setup/isolate-home.ts already set, which redirects TOKEN_GOAT_HOME *and*
 * LOCALAPPDATA/XDG_DATA_HOME -- both storage roots, which matters because the recall index writes
 * through dataDir() rather than tokenGoatHome(). Minting a private home here would leave the
 * in-process seed and the spawned reader looking at different directories, and every case below
 * would pass on an empty result.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { storeWebOutput } from '../../src/web_cache.js'
import { storeBashOutput } from '../../src/bash_output_cache.js'
import { storeMcpOutput } from '../../src/mcp_cache.js'
import { getSessionId, recordFileRead } from '../../src/session.js'
import { saveSessionState } from '../../src/session_store.js'
import { SESSION_TRUNCATION_COMMANDS } from './session_truncation_commands.js'

const BUNDLE = join(__dirname, '..', '..', 'dist', 'token-goat.mjs')

/** Seeded rows per source. Comfortably above LIMIT so the cap has something to drop. */
const SEEDED = 8
/** The cap every case is driven at. */
const LIMIT = 3

let projectDir: string

function run(args: string[]): { status: number; out: string; err: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    // Inherited on purpose -- see the header. Overriding the home here would decouple the seed
    // from the reader and make every assertion below vacuous.
    env: { ...process.env },
  })
  return { status: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' }
}

function rowsOf(out: string): unknown[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return undefined
  }
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed === 'object' && parsed !== null) {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return v
    }
  }
  return undefined
}

/**
 * How a command is expected to tell the reader it dropped rows.
 *
 * `envelope` is only correct where the JSON payload is already an object -- adding a wrapper to a
 * command that emits a bare array would break every `cmd --json | jq '.[]'` pipeline in existence,
 * so those disclose on stderr instead. The residual risk is real and worth naming: a pipeline that
 * discards stderr still cannot see the notice. What is refused is disclosure on *neither* channel.
 *
 * `stderr-more` exists because a total is not always a quantity the command has. `recall` pushes
 * its limit into SQL, so the rows beyond it are never fetched and never counted; demanding an exact
 * total there would mean either a second COUNT query on every call or inventing a number. An
 * existence signal is the honest maximum, and it is still the difference between a reader who knows
 * to raise --limit and one who believes they have seen everything.
 */
type Disclosure =
  | { readonly kind: 'envelope'; readonly totalField: string }
  | { readonly kind: 'stderr-count' }
  | { readonly kind: 'stderr-more' }

interface Case {
  readonly command: string
  readonly args: string[]
  readonly flag: string
  readonly disclosure: Disclosure
}

const CASES: readonly Case[] = [
  { command: 'bash-history', args: ['bash-history'], flag: '--limit', disclosure: { kind: 'stderr-count' } },
  { command: 'web-history', args: ['web-history'], flag: '--limit', disclosure: { kind: 'stderr-count' } },
  { command: 'mcp-history', args: ['mcp-history'], flag: '--limit', disclosure: { kind: 'stderr-count' } },
  { command: 'history', args: ['history'], flag: '--limit', disclosure: { kind: 'stderr-count' } },
  { command: 'hot', args: ['hot'], flag: '--limit', disclosure: { kind: 'envelope', totalField: 'totalCount' } },
  { command: 'recall', args: ['recall'], flag: '--limit', disclosure: { kind: 'stderr-more' } },
]

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-trunc-sess-'))
  for (let i = 1; i <= SEEDED; i++) {
    storeWebOutput(`https://example.com/page-${i}`, `# Page ${i}\nbody text for page ${i}\n`)
    await storeBashOutput(`echo seeded-command-${i}`, `seeded output ${i}\n`, 0, null)
    storeMcpOutput('trunc-sess-session', `tool_${i}`, { arg: i }, `mcp result ${i}\n`)
    const f = join(projectDir, `read-${i}.ts`)
    writeFileSync(f, `export const v${i} = ${i}\n`)
    recordFileRead(f)
  }
  // `hot` aggregates tokenGoatHome()/sessions/*.json, not in-memory state, so the reads above are
  // invisible to a separate process until they are flushed. Without this the hot case reported
  // "0 of 0" -- its calibration assertion caught it, which is the whole reason that assertion is
  // not optional.
  saveSessionState(getSessionId())
})

describe('the session half covers exactly the commands the sibling guard defers to it', () => {
  it('drives every command on the shared list, and no command the sibling still checks', () => {
    // Without this, deleting a case here would silently shrink coverage: the sibling guard reads
    // the shared list, not this file, so it would go on treating the name as covered.
    expect([...CASES.map((c) => c.command)].sort()).toEqual([...SESSION_TRUNCATION_COMMANDS].sort())
  })
})

describe.each(CASES)('$command discloses when $flag drops rows', ({ command, args, flag, disclosure }) => {
  const jsonRows = (extra: string[]): unknown[] | undefined => rowsOf(run([...args, ...extra, '--json']).out)
  const uncappedRows = (): number => jsonRows([flag, '999'])?.length ?? 0

  it('applies the cap at all, so the rest of this case is not asserting on an uncapped result', () => {
    // Calibration, and it has already earned its place once: an earlier attempt to seed these
    // caches through the post_tool_use hook exited 0 and stored nothing, because that path gates
    // the cache write behind a compression-worthwhile check. Without this assertion the whole file
    // would have gone green against empty caches while proving nothing at all.
    const capped = jsonRows([flag, String(LIMIT)])
    const uncapped = jsonRows([flag, '999'])

    expect(capped, `${command} --json has no row array to check`).toBeDefined()
    expect(uncapped, `${command} --json has no row array to check when uncapped`).toBeDefined()
    expect(
      (uncapped ?? []).length,
      `${command} returned ${uncapped?.length ?? 0} rows uncapped; the cache seed did not reach the spawned bundle, ` +
        `so ${flag} ${LIMIT} drops nothing and every assertion in this case would pass vacuously`,
    ).toBeGreaterThan(LIMIT)
    expect(capped ?? [], `${command} ${flag} ${LIMIT} returned ${capped?.length ?? 0} rows; the flag is not capping`).toHaveLength(LIMIT)
  })

  it('says so when it drops rows', () => {
    const r = run([...args, flag, String(LIMIT), '--json'])
    const shown = rowsOf(r.out)?.length ?? 0
    const truth = uncappedRows()

    if (disclosure.kind === 'envelope') {
      const parsed: unknown = JSON.parse(r.out)
      const envelope = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
      expect(
        envelope['truncated'],
        `${command} ${flag} ${LIMIT} returned ${shown} of ${truth} rows and did not set truncated. ` +
          `A consumer cannot tell this apart from a complete answer.`,
      ).toBe(true)
      expect(
        envelope[disclosure.totalField],
        `${command} set ${disclosure.totalField} to ${String(envelope[disclosure.totalField])}, but an independent ` +
          `uncapped run returns ${truth} rows. A total that merely exceeds the page is satisfied by any wrong ` +
          `larger number, which is how a count of a different set has shipped here before.`,
      ).toBe(truth)
      return
    }

    if (disclosure.kind === 'stderr-count') {
      const m = /Showing (\d+) of (\d+)/.exec(r.err)
      expect(
        m,
        `${command} ${flag} ${LIMIT} returned ${shown} of ${truth} rows and printed no notice on stderr. ` +
          `Its --json payload is a bare array, so there is nowhere in-band to put the flag without breaking ` +
          `every pipeline that consumes it; stderr is the only channel left, and it is currently silent.`,
      ).not.toBeNull()
      expect(Number(m?.[1]), `${command} reported showing ${m?.[1]} rows but emitted ${shown}`).toBe(shown)
      expect(
        Number(m?.[2]),
        `${command} reported a total of ${m?.[2]} but an independent uncapped run returns ${truth}`,
      ).toBe(truth)
      return
    }

    // stderr-more: existence, not a count.
    expect(
      /more|raise --limit/i.test(r.err),
      `${command} ${flag} ${LIMIT} returned ${shown} rows with at least ${truth} available and gave no sign ` +
        `that more exist. It cannot state an exact total without a second query, but it can say there is a remainder.`,
    ).toBe(true)
  })

  it('stays quiet when nothing is dropped', () => {
    // The other half of the invariant, and the half a disclosure bolted on unconditionally would
    // fail: a complete answer must not claim rows were omitted.
    const r = run([...args, flag, '999', '--json'])
    expect(/Showing \d+ of \d+|more available|raise --limit/i.test(r.err), `${command} claimed truncation on a complete result`).toBe(false)
    if (disclosure.kind === 'envelope') {
      const parsed: unknown = JSON.parse(r.out)
      const envelope = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
      expect(envelope['truncated'], `${command} set truncated on a complete result`).not.toBe(true)
    }
  })
})
