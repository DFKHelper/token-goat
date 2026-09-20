/**
 * Guard: the guards' view of the repository does not depend on which index git happened to hand them.
 *
 * `git ls-files` reads `$GIT_INDEX_FILE`. `git commit --only <paths>` points that at a temporary index holding HEAD plus only the named paths, for the duration of the hooks, so a guard that enumerates tracked files during a partial commit sees a truncated repository and reports invariants broken that are not. Measured on this repo before the fix: `git commit --only <one file>` with a second file staged took the pre-commit guard suite to 7 failed files, while `npx vitest run tests/guards` on the same tree at the same moment was 162/162 green.
 *
 * Two halves, and both are needed. `tests/helpers/tracked-files.ts` owns the enumeration and deletes the variable itself, so a guard is right even when run outside the suite setup; `tests/setup/isolate-home.ts` deletes it process-wide, which is the only thing that also stops a test's own scratch `git add` writing its fixture paths into the commit index git is preparing.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { trackedFiles } from '../helpers/tracked-files.js'
import { pinnedPopulation } from './population.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD_DIR = path.join(REPO, 'tests', 'guards')
const SELF = path.basename(fileURLToPath(import.meta.url))

// Assembled from two halves so this file never contains the literal it searches for. A structural guard whose own source is an instance of the pattern it rejects has contaminated its population, and self-exclusion alone would leave the needle matching the prose of any future guard that merely discusses the rule.
const SPAWNS_LS_FILES = new RegExp(`'ls` + `-files'`)

// This file is excluded because it deliberately constructs and exercises the needle above; every other guard is in scope. Measured 2026-09-20: 167 guard sources, 166 after the self-exclusion, pinned with room either side so ordinary growth does not trip it but a collapsed readdir does.
function guards(): readonly string[] {
  return pinnedPopulation({
    what: 'guard sources scanned for a second copy of the tracked-file enumeration',
    items: fs.readdirSync(GUARD_DIR).filter((f) => f.endsWith('.ts') && f !== SELF),
    floor: 140,
    ceiling: 320,
    mustIncludeExact: ['checkout_line_endings.test.ts', 'doc_links_resolve.test.ts'],
  })
}

const read = (f: string): string => fs.readFileSync(path.join(GUARD_DIR, f), 'utf8')

describe('tracked-file enumeration ignores the ambient index', () => {
  it('lists a file staged for this commit but outside the pathspec being committed', () => {
    // CAPTURE: the partial index is built by a real `git commit -- a.txt` on a scratch repo, and the temporary index git hands its own pre-commit hook is captured from that hook rather than reconstructed. Reconstructing it with `read-tree` + `update-index` would be a guess at the shape; this is the shape.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ambient-index-'))
    const savedIndexFile = process.env['GIT_INDEX_FILE']
    try {
      const run = (args: string[]): void => {
        execFileSync('git', args, { cwd: scratch, stdio: 'ignore' })
      }
      run(['init', '-q'])
      run(['config', 'user.email', 'a@b.com'])
      run(['config', 'user.name', 'Test'])
      fs.writeFileSync(path.join(scratch, 'a.txt'), 'a\n')
      run(['add', 'a.txt'])
      run(['commit', '-q', '-m', 'init'])

      // A pre-commit hook that copies aside the exact GIT_INDEX_FILE git gave it, so the fixture below is git's own temporary partial-commit index and not an imitation of one.
      const capturedIndex = path.join(scratch, 'captured-index')
      const hook = path.join(scratch, '.git', 'hooks', 'pre-commit')
      fs.writeFileSync(hook, `#!/bin/sh\ncp "$GIT_INDEX_FILE" "${capturedIndex.replace(/\\/g, '/')}"\n`, { mode: 0o755 })

      // A second file staged into the REAL index, outside the pathspec of the partial commit below.
      fs.writeFileSync(path.join(scratch, 'readme.md'), '# doc\n')
      run(['add', 'readme.md'])
      fs.writeFileSync(path.join(scratch, 'a.txt'), 'a2\n')
      run(['commit', '-q', '-m', 'partial', '--only', '--', 'a.txt'])
      expect(fs.existsSync(capturedIndex), 'the pre-commit hook never ran, so no real partial index was captured and the rest of this test would prove nothing').toBe(true)

      // Calibration: prove the trap is real before asking whether the helper dodges it. A raw `git ls-files` under that captured index misses the staged file.
      process.env['GIT_INDEX_FILE'] = capturedIndex
      const seenByThisPartialIndex = execFileSync('git', ['-C', scratch, 'ls-files'], { encoding: 'utf8' }).split('\n').filter((p) => p !== '')
      expect(seenByThisPartialIndex.length, 'the captured index listed nothing at all, so its missing readme.md below would be vacuous').toBeGreaterThan(0)
      expect(seenByThisPartialIndex).not.toContain('readme.md')

      // The enumeration under test, under the same ambient GIT_INDEX_FILE a pre-commit hook inherits.
      const seen = trackedFiles({ repo: scratch })
      expect(seen).toContain('readme.md')

      // Anchors. A function that returns everything also satisfies `toContain`, and one that throws into a caught path returns nothing while looking fine, so pin both the floor and a file that must be there.
      expect(seen.length, 'the enumeration returned nothing, so every assertion above is vacuous').toBeGreaterThan(0)
      expect(seen).toContain('a.txt')

      // The same two anchors against the real repository, which is what the guards actually enumerate.
      const repoSeen = trackedFiles()
      expect(repoSeen.length, 'the enumeration found no tracked file in this repository, so every guard built on it certifies an empty set').toBeGreaterThan(500)
      expect(repoSeen).toContain('package.json')
    } finally {
      if (savedIndexFile === undefined) delete process.env['GIT_INDEX_FILE']
      else process.env['GIT_INDEX_FILE'] = savedIndexFile
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('routes every guard through the shared helper, with no second copy of the enumeration', () => {
    // HAND-DERIVED: the needle is the quoted argv element a git spawn has to contain, assembled at runtime from two halves so that this file's own source is not an instance of the thing it looks for -- a structural guard that matches itself certifies a contaminated population. Structural rather than behavioural on purpose: a direct call passes a behavioural test every time the ambient index happens to be the real one, which is every run except the one that matters.
    const offenders = guards().filter((f) => SPAWNS_LS_FILES.test(read(f)))
    expect(offenders, 'guards enumerating the repository with their own `git` call instead of tests/helpers/tracked-files.ts, whose whole job is to not inherit the ambient GIT_INDEX_FILE').toEqual([])

    // Calibration: an empty offender list means nothing unless the needle still fires. Prove it against the exact call shape that was removed from checkout_line_endings.test.ts.
    expect(SPAWNS_LS_FILES.test(`execFileSync('git', ['ls` + `-files', '-z'], { cwd: REPO })`), 'the detector no longer matches a direct call, so the empty result above is a dead scan').toBe(true)

    // The enumeration still has to exist somewhere, or "nobody calls it directly" is satisfied by nobody calling it at all.
    expect(SPAWNS_LS_FILES.test(fs.readFileSync(path.join(REPO, 'tests', 'helpers', 'tracked-files.ts'), 'utf8')), 'the shared helper no longer spawns git, so the guards are enumerating from somewhere else').toBe(true)
  })

  it('non-firing: the scan accepts every guard that reaches the enumeration through the helper', () => {
    // The rule must not block valid guard sources. The population is pinned by pinnedPopulation before it is walked, so a readdir that returned nothing cannot read as a clean sweep.
    const accepted = guards().filter((f) => !SPAWNS_LS_FILES.test(read(f)))
    expect(accepted.length, 'the scan rejected every guard, so it is a rule nothing can satisfy').toBeGreaterThan(100)
    for (const caller of ['doc_links_resolve.test.ts', 'checkout_line_endings.test.ts', 'scratch_roots_resolve_natively.test.ts', 'test_suite_include_covers_every_test_file.test.ts', 'a_confidential_name_never_reaches_a_tracked_file.test.ts', 'language_adapter_produces_symbols.test.ts']) {
      expect(accepted, `${caller} enumerates through the shared helper, so the scan must accept it`).toContain(caller)
      expect(read(caller), `${caller} must import the helper rather than merely have stopped spawning git`).toContain("from '../helpers/tracked-files.js'")
    }
  })
})
