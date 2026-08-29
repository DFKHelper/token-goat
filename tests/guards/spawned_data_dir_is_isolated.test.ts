/**
 * A test that pins a spawned binary's data dir must pin it on every platform, not just Windows.
 *
 * `LOCALAPPDATA` chooses the data dir on Windows and `XDG_DATA_HOME` chooses it on Linux and
 * macOS. A test that sets only the first is isolated on Windows and silently shares the Vitest
 * worker's data dir everywhere else, so two spawns in the same file read one another's index and
 * one another's savings ledger. That is invisible on a Windows dev box and fails only on CI:
 * `tests/skill_body_compact_credit.test.ts` passed locally and on `test-windows` while failing on
 * `test` and `test-macos`, because its second case saw the credit its first case had booked.
 *
 * Provenance: HAND-DERIVED. The rule is read off `src/constants.ts`'s own platform branches (the
 * win32 branch reads LOCALAPPDATA, the darwin and linux branches read XDG_DATA_HOME), not off any
 * matcher in the file this checks. The scan below is the whole test: there is no way to observe
 * the POSIX-only failure from Windows, which is exactly why it needs a structural guard.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every `.ts` under `tests/`, so a new file is covered the moment it is added rather than when someone remembers to list it. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('a spawned binary gets an isolated data dir on every platform', () => {
  it('pins XDG_DATA_HOME wherever it pins LOCALAPPDATA for a child process', () => {
    const offenders: string[] = []
    // Excluded explicitly rather than incidentally. This file spells LOCALAPPDATA: in its own
    // rule, so it enters the scan, and it does NOT clear itself on the XDG_DATA_HOME check: the
    // literal text there is `\bXDG_DATA_HOME:`, so the character before XDG is `b`, a word
    // character, and that regex's own `\b` never matches its own source. Only the spawn check
    // spares it today, which one stray `spawn(` anywhere in this file -- a comment would do --
    // would undo, turning the guard into a false offender against itself.
    const self = path.resolve(fileURLToPath(import.meta.url))
    for (const full of testFiles(path.join(process.cwd(), 'tests'))) {
      if (path.resolve(full) === self) continue
      const text = fs.readFileSync(full, 'utf8')
      if (!/\bLOCALAPPDATA:/.test(text)) continue
      if (/\bXDG_DATA_HOME:/.test(text)) continue
      // Only a file that starts a child process can hand one a data dir. tests/screenshot.test.ts pins LOCALAPPDATA in-process to steer Chrome discovery and spawns nothing, so it is out of scope on a real property rather than by name.
      if (!/\bspawnSync\(|\bexecFileSync\(|\bexecSync\(|\bspawn\(/.test(text)) continue
      offenders.push(path.relative(process.cwd(), full).split(path.sep).join('/'))
    }
    expect(
      offenders,
      'each of these hands a child process a Windows-only data dir override, so on Linux and macOS the child falls back to the Vitest worker\'s shared data dir and reads state another test wrote. Set XDG_DATA_HOME to the same directory as LOCALAPPDATA, or use tgEnv from tests/helpers/matrix_cases.ts.',
    ).toEqual([])
  })

  it('still finds test files that hand a child an env, so the scan above cannot narrow itself away', () => {
    // The check above is a "no offenders" assertion, and an empty population satisfies it just as
    // well as a compliant one. Its population is selected by two literal spellings -- the
    // `LOCALAPPDATA:` object-literal key and a direct spawn call -- and both can stop matching
    // without anything failing: tests migrating to tgEnv move the key into the helper, and a new
    // spawn wrapper would hide the call. Either leaves the scan reading zero files forever.
    //
    // The conjunction is pinned rather than either half, because the `LOCALAPPDATA:` count stays
    // healthy on files that never spawn anything, which is exactly the population that does not
    // matter here.
    const self = path.resolve(fileURLToPath(import.meta.url))
    const covered = testFiles(path.join(process.cwd(), 'tests')).filter((full) => {
      if (path.resolve(full) === self) return false
      const text = fs.readFileSync(full, 'utf8')
      return /\bLOCALAPPDATA:/.test(text) && /\bspawnSync\(|\bexecFileSync\(|\bexecSync\(|\bspawn\(/.test(text)
    })
    expect(
      covered.length,
      'no test file both pins LOCALAPPDATA for a child and starts one, so the scan above examines nothing ' +
        'and reports a clean result it never earned. Either both spellings changed, or the walk stopped ' +
        'seeing test files.',
    ).toBeGreaterThan(0)
  })

  it('agrees with the platform branches it is derived from, so the rule is not just asserted here', () => {
    // Anchors the guard to its source. If constants.ts ever stops reading XDG_DATA_HOME on the POSIX branches the rule above is obsolete, and this catches that rather than leaving a scan enforcing a stale invariant.
    const constants = fs.readFileSync(path.join(process.cwd(), 'src', 'constants.ts'), 'utf8')
    expect(/process\.env\['LOCALAPPDATA'\]/.test(constants), 'constants.ts must still pick the data dir from LOCALAPPDATA').toBe(true)
    expect(/process\.env\['XDG_DATA_HOME'\]/.test(constants), 'constants.ts must still pick the data dir from XDG_DATA_HOME').toBe(true)
  })
})
