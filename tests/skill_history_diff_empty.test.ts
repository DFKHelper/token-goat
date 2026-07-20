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
