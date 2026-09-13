/**
 * The containment fold has to be a fact about the volume, not about the platform.
 *
 * `isCaseInsensitiveFs()` answers "win32 or darwin", and both of those platforms can hand you a
 * case-SENSITIVE directory: Windows carries a per-directory flag (`fsutil file setCaseSensitiveInfo`,
 * which WSL sets on everything it creates) and macOS will format a case-sensitive APFS volume on
 * request. There, `<root>/Repo` and `<root>/repo` are two different directories with different
 * contents, and a fold reads the second as the first -- so everything under a real, distinct,
 * OUTSIDE directory is admitted. That is the disclosure direction, the one a containment boundary
 * is never allowed to be wrong in, and it is the mirror image of the Kelvin-sign fold that
 * `containment_case_fold_is_ascii_only.test.ts` pins from the other side.
 *
 * The defect cannot be staged on a case-insensitive volume, because the two directories cannot both
 * exist there. So the volume is asked first, and the case-sensitive half runs where the checkout
 * really is case-sensitive -- Linux on CI, and any macOS or Windows machine set up that way -- with
 * `TOKEN_GOAT_CASE_INSENSITIVE_FS=1` forcing the fold that the platform check would otherwise skip.
 * That override is the same seam the DB collation tests use; it changes what the code believes, not
 * what the disk does, which is exactly the disagreement being tested.
 *
 * PROVENANCE: HAND-DERIVED. Both directories are created here and the assertion is about which one
 * `isInsideRoot` lets a caller reach; nothing is read off the implementation.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { isInsideRoot } from '../src/path_containment.js'

const previous = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']

/**
 * Built at module load, not in `beforeAll`: `it.runIf` is evaluated while the file is being
 * collected, so a flag set in a hook is still false when the decision is made and every case-
 * sensitive assertion is skipped on the one machine that could have run it.
 */
function caseSensitiveBase(): { base: string; sensitive: boolean } {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-case-')))
  // Windows can be asked for the exact volume this test is about, and asking is what makes the
  // platform with the disclosure the platform that runs the assertion rather than skips it. Needs
  // the same optional component WSL does, so a runner without it just falls through to the skip.
  if (process.platform === 'win32') {
    try {
      execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', base, 'enable'], { stdio: 'ignore' })
    } catch {
      /* no case-sensitive directories available here */
    }
  }
  fs.mkdirSync(path.join(base, 'probe'))
  return { base, sensitive: !fs.existsSync(path.join(base, 'PROBE')) }
}

const { base, sensitive: volumeIsCaseSensitive } = caseSensitiveBase()

afterAll(() => {
  if (previous === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
  else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = previous
  fs.rmSync(base, { recursive: true, force: true })
})

describe('containment on a volume whose case sensitivity disagrees with the platform', () => {
  it.runIf(!volumeIsCaseSensitive)('calibration: this volume cannot hold the two directories, so the case below is skipped honestly', () => {
    expect(fs.existsSync(path.join(base, 'PROBE')), 'the volume turned case-sensitive mid-run').toBe(true)
  })

  it.runIf(volumeIsCaseSensitive)('refuses a sibling that only the fold puts inside the root', () => {
    const root = path.join(base, 'repo')
    const sibling = path.join(base, 'Repo')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'not the project')
    // Without the override the fold never happens here and the test would pass for the wrong
    // reason -- it would be measuring Linux, not the Windows-with-a-WSL-directory case it is about.
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    expect(isInsideRoot(path.join(sibling, 'secret.txt'), root), 'a distinct directory beside the root was admitted as part of it').toBe(false)
    // The other half, or the first assertion is satisfied by refusing everything.
    expect(isInsideRoot(path.join(root, 'src', 'index.ts'), root), 'an ordinary path under the root was refused').toBe(true)
  })

  it.runIf(volumeIsCaseSensitive)('still refuses it when the platform check is what says the volume folds', () => {
    // The same pair with the override taken off. On Linux this is the platform answer agreeing;
    // the value of the assertion is that the two paths never compare equal by either route.
    delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    expect(isInsideRoot(path.join(base, 'Repo', 'secret.txt'), path.join(base, 'repo'))).toBe(false)
  })

  it.runIf(!volumeIsCaseSensitive)('still accepts a different spelling of the root where the volume really does fold', () => {
    // The mirror, and the reason the check asks the filesystem rather than simply dropping the
    // fold: on a case-insensitive volume `Repo` and `repo` ARE the same directory, and refusing
    // that would decline a real path -- git reports a root's casing differently from the shell more
    // or less at random.
    const root = path.join(base, 'project')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '')
    expect(isInsideRoot(path.join(base, 'Project', 'src', 'index.ts'), root)).toBe(true)
  })

  it('accepts a path under the root that does not exist yet, whatever the volume', () => {
    // A write target has no directory to compare, and refusing one would turn every "create a file
    // under the project" into a containment failure. The platform's answer stands there.
    const root = path.join(base, 'writable')
    fs.mkdirSync(root, { recursive: true })
    expect(isInsideRoot(path.join(root, 'not-created-yet', 'x.ts'), root)).toBe(true)
  })
})
