// Regression guard: `skill-history` and `skill-diff` must treat a never-created skill-outputs
// directory as an empty cache (exit 0), not a fatal error. The dir does not exist on a fresh
// install (no skill ever loaded) or a fresh CI checkout; the previous implementations called
// fs.readdir on the missing dir, caught the ENOENT, and rethrew it as a CliError -> exit 1.
// These tests point the cache at a path that does not exist and drive the real run() entry,
// so they fail on the pre-fix code and pass once the missing-dir case degrades to an empty listing.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { setSkillOutputsDirForTesting } from '../src/skill_cache.js'

afterEach(() => {
  setSkillOutputsDirForTesting(null)
})

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
