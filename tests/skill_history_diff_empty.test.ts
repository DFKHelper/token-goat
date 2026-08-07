// Regression guard: `skill-history` and `skill-diff` must treat a never-created skill-outputs
// directory as an empty cache (exit 0), not a fatal error. The dir does not exist on a fresh
// install (no skill ever loaded) or a fresh CI checkout; the previous implementations called
// fs.readdir on the missing dir, caught the ENOENT, and rethrew it as a CliError -> exit 1.
// These tests point the cache at a path that does not exist and drive the real run() entry,
// so they fail on the pre-fix code and pass once the missing-dir case degrades to an empty listing.
import { mkdtempSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'
import { listOutputs, setSkillOutputsDirForTesting, skillOutputsDir, storeOutput } from '../src/skill_cache.js'

afterEach(() => {
  setSkillOutputsDirForTesting(null)
})

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await fn()
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

// A path guaranteed not to exist: a fresh temp dir plus a child that was never created.
function missingSkillsDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'tg-empty-cache-')), 'never-created')
}

// run() sets process.exitCode = 1 on a CliError and leaves it untouched on success. Drive the
// real CLI entry against the missing cache and report the resulting exit code.
async function exitCodeOf(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('skill-history / skill-diff against a never-created cache', () => {
  it('skill-history exits 0 when the skill-outputs dir does not exist', async () => {
    setSkillOutputsDirForTesting(missingSkillsDir())
    expect(await exitCodeOf(['skill-history'])).toBe(0)
  })

  it('skill-history --json exits 0 when the skill-outputs dir does not exist', async () => {
    setSkillOutputsDirForTesting(missingSkillsDir())
    expect(await exitCodeOf(['skill-history', '--json'])).toBe(0)
  })

  it('skill-diff exits 0 when the skill-outputs dir does not exist', async () => {
    setSkillOutputsDirForTesting(missingSkillsDir())
    expect(await exitCodeOf(['skill-diff', 'no-such-skill'])).toBe(0)
  })

  // Exit 0 alone was never enough: the pre-fix command printed the column header and nothing else, which is a populated table that happens to have no rows -- unreadable as "the store is empty" and indistinguishable from a lookup against the wrong cache root. The header must not be the whole payload.
  it('skill-history says the store is empty instead of printing a bare header', async () => {
    setSkillOutputsDirForTesting(missingSkillsDir())
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-history'])
    })
    expect(output).toContain('No cached skill versions yet.')
    expect(output).not.toContain('Output ID')
  })

  // The JSON form was already unambiguous ([] cannot be mistaken for a populated result) and must stay machine-parseable rather than inheriting the prose message.
  it('skill-history --json still emits an empty array, not the prose message', async () => {
    setSkillOutputsDirForTesting(missingSkillsDir())
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-history', '--json'])
    })
    expect(JSON.parse(output)).toEqual([])
  })

  // The populated path must keep rendering the table: a guard that only checks the empty case would pass just as happily if the fix had swallowed every listing.
  it('still prints the header and a row once a version is cached', async () => {
    setSkillOutputsDirForTesting(mkdtempSync(join(tmpdir(), 'tg-history-full-')))
    await storeOutput('sess-hist', 'demoskill', 'body text')
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-history'])
    })
    expect(output).toContain('Output ID')
    expect(output).toContain('demoskill')
    expect(output).not.toContain('No cached skill versions yet.')
  })
})

// Regression guard: a `--session-id` filter that hides every cached skill must not be reported as an
// empty cache. "No skills cached yet." for a cache that holds skills under a different session is the
// same defect `refs --exclude-tests` had -- a filtered view rendered as a definitive absence -- and it
// sends the caller off to re-cache work that is already there. The unfiltered path must stay untouched.
describe('skill-list / skill-size under a --session-id filter that hides everything', () => {
  async function cacheOneSkillUnder(sessionId: string): Promise<void> {
    setSkillOutputsDirForTesting(mkdtempSync(join(tmpdir(), 'tg-session-filter-')))
    await storeOutput(sessionId, 'demoskill', 'body text')
  }

  it('skill-list names the skills the session filter hid', async () => {
    await cacheOneSkillUnder('sess-alpha')
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-list', '--session-id', 'sess-beta'])
    })
    expect(output).toContain('sess-beta')
    expect(output).toContain('1 cached under other sessions')
    expect(output).not.toContain('No skills cached yet.')
  })

  it('skill-list still reports a genuinely empty cache as empty', async () => {
    setSkillOutputsDirForTesting(missingSkillsDir())
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-list', '--session-id', 'sess-beta'])
    })
    expect(output).toContain('No skills cached yet.')
    expect(output).not.toContain('cached under other sessions')
  })

  it('skill-list without a filter is unchanged', async () => {
    await cacheOneSkillUnder('sess-alpha')
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-list'])
    })
    expect(output).toContain('demoskill')
    expect(output).not.toContain('cached under other sessions')
  })

  it('skill-size names the skills the session filter hid and drops the empty breakdown heading', async () => {
    await cacheOneSkillUnder('sess-alpha')
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-size', '--session-id', 'sess-beta'])
    })
    expect(output).toContain('(0 skills)')
    expect(output).toContain('1 cached under other sessions, hidden by --session-id sess-beta')
    expect(output).not.toContain('## Per-skill breakdown')
  })

  it('skill-size keeps the breakdown heading and row when skills match', async () => {
    await cacheOneSkillUnder('sess-alpha')
    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-size', '--session-id', 'sess-alpha'])
    })
    expect(output).toContain('(1 skills)')
    expect(output).toContain('## Per-skill breakdown')
    expect(output).toContain('demoskill')
    expect(output).not.toContain('cached under other sessions')
  })
})

// Regression guard: `skill-diff`'s TOCTOU race. listOutputs() can find 2+ cached versions of a
// skill, but by the time the body reads happen, a concurrent storeOutput()/prune-cache eviction
// may have deleted the older version's .txt file -- fs.promises.readFile then resolves via its
// .catch(() => null), which previously reused the exact same "only one cached version" text as
// the genuine <2-versions case, falsely implying a second version never existed. Simulate the
// race deterministically: store two versions (different bodies, so content-hash dedup in
// findCrossSessionEntry doesn't collapse them into one entry), then delete the older version's
// .txt file on disk before invoking skill-diff -- this exercises the same
// "listOutputs() found >=2, but a readFile failed" path a real race would hit.
describe('skill-diff when a version is evicted mid-diff (TOCTOU race)', () => {
  it('reports the version was evicted, not that only one version ever existed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-skill-diff-race-'))
    setSkillOutputsDirForTesting(dir)

    const first = await storeOutput('sess-race', 'race-skill', 'body one')
    const second = await storeOutput('sess-race', 'race-skill', 'body two')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    // cmdSkillDiff picks its "older" version from versions.sort((a, b) => b.ts - a.ts)[1] --
    // find that same second-ranked entry here (instead of assuming storeOutput call order
    // matches ts order, which a same-millisecond tie could break) and delete its .txt file.
    const versions = (await listOutputs())
      .filter((m) => m.skillName === 'race-skill')
      .sort((a, b) => b.ts - a.ts)
    expect(versions.length).toBe(2)
    unlinkSync(resolve(skillOutputsDir(), `${versions[1]!.outputId}.txt`))

    const output = await captureStdout(async () => {
      await run(['node', 'token-goat', 'skill-diff', 'race-skill'])
    })

    expect(output).toContain('evicted')
    expect(output).not.toContain('only one cached version')
  })
})
