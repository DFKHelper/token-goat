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

import { afterAll, describe, expect, it, vi } from 'vitest'

import { isInsideRoot, isNetworkPath, reachesForeignShare, sameDirectory } from '../src/path_containment.js'

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

describe('telling a share from a path merely spelled like one', () => {
  // PROVENANCE: HAND-DERIVED. Each spelling is classified from what reaching it would COST -- a
  // connection to a named host, or a local `realpath` -- not from what the implementation returns.
  // The two halves matter equally: a classifier that says "network" to everything fails closed and
  // looks correct, while declining `\\?\C:\work` costs a real Windows caller a real path.
  const cases: readonly (readonly [string, boolean])[] = [
    ['//server/share/repo', true],
    ['\\\\server\\share\\repo', true],
    ['//?/UNC/server/share/repo', true],
    ['\\\\?\\UNC\\server\\share\\repo', true],
    ['//./unc/server/share/repo', true], // the device prefix is spelled either way, and matched either case
    ['//?/c:/work/repo', false],
    ['\\\\?\\C:\\work\\repo', false],
    ['//./c:/work/repo', false],
    ['//?/Volume{7c1b1e00-0000-0000-0000-100000000000}/work', false],
    ['c:/work/repo', false],
    ['/tmp/repo', false],
  ]
  for (const [spelling, network] of cases) {
    it(`${network ? 'refuses to resolve' : 'resolves'} ${spelling}`, () => {
      expect(isNetworkPath(spelling, 'win32')).toBe(network)
    })
  }

  it.each([
    // PROVENANCE: HAND-DERIVED. Which pairs may start a walk, reasoned from where the two paths
    // live rather than from what the function returns. The `true` rows are the ones that must
    // refuse before any filesystem call.
    { target: '\\\\host\\share\\f', root: 'C:\\work', foreign: true, why: 'a share from a local root' },
    { target: '\\\\?\\UNC\\host\\share\\f', root: 'C:\\work', foreign: true, why: 'the device spelling of one' },
    { target: '\\\\other\\share\\f', root: '\\\\host\\share', foreign: true, why: 'a second host' },
    { target: '\\\\host\\other\\f', root: '\\\\host\\share', foreign: true, why: 'a second share on the same host' },
    { target: '\\\\host\\share\\f', root: '\\\\host\\share', foreign: false, why: 'the project is hosted there' },
    { target: '\\\\HOST\\Share\\f', root: '\\\\host\\share', foreign: false, why: 'a host name is not case-sensitive' },
    { target: '\\\\?\\UNC\\host\\share\\f', root: '\\\\host\\share', foreign: false, why: 'the same share, spelled twice' },
    { target: '\\\\?\\C:\\work\\f', root: 'C:\\work', foreign: false, why: 'a device path is this volume' },
    { target: 'C:\\work\\f', root: 'C:\\work', foreign: false, why: 'neither is a share' },
  ])('$why: reachesForeignShare is $foreign', ({ target, root, foreign }) => {
    expect(reachesForeignShare(target, root, 'win32')).toBe(foreign)
  })

  it('reads no path as a share off Windows', () => {
    // Two leading slashes mean a host there and nothing anywhere else: POSIX leaves a leading `//`
    // implementation-defined and Linux and macOS both resolve it to `/`, which is why
    // `path.posix.normalize('//tmp/repo')` is `/tmp/repo`. Classifying it as a share refused an
    // ordinary local directory, and an SMB mount on those systems is at a path like `/mnt/share`
    // with nothing in the spelling to find.
    expect(path.posix.normalize('//tmp/repo'), 'the premise this test rests on').toBe('/tmp/repo')
    for (const spelling of ['//tmp/repo', '//server/share/repo', '\\\\server\\share\\repo']) {
      expect(isNetworkPath(spelling, 'linux'), spelling).toBe(false)
      expect(isNetworkPath(spelling, 'darwin'), spelling).toBe(false)
    }
  })
})

describe('the same-directory check itself, on a share no runner has', () => {
  it('refuses two spellings of a share without dialing either', () => {
    // Called directly because `isInsideRoot` cannot reach this on Windows: the link walk refuses a
    // path on an unreachable host several seconds earlier, and no CI runner has a real file server.
    // Left to the integration test alone, the branch would be exercised on one of three platforms
    // and taken on faith by the other two -- and it is the platform that skips which the branch is
    // about.
    const dialed = vi.spyOn(fs.realpathSync, 'native')
    try {
      expect(sameDirectory('//tg-no-such-host/share/Repo', '//tg-no-such-host/share/repo', 'win32')).toBe(false)
      expect(sameDirectory('\\\\tg-no-such-host\\share\\Repo', '\\\\tg-no-such-host\\share\\repo', 'win32')).toBe(false)
      expect(dialed, 'the check opened a connection to a host the caller named').not.toHaveBeenCalled()
    } finally {
      dialed.mockRestore()
    }
  })
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

  it.runIf(process.platform === 'win32')('refuses a share target from a local root before anything can dial', () => {
    // The refusal has to happen BEFORE the link walk, not inside `sameDirectory` at the end of it.
    // The walk refuses a link that escapes onto a share and refuses it without dialling, but a
    // target the caller simply spelled as a share arrives with that share already as its root, so
    // the walk's first `lstatSync` opens the connection -- to an address the model named, inside a
    // hook that runs before the user has approved the tool call. This is a real Windows assertion
    // and costs no connection precisely because the answer is reached first; a fictional host is
    // safe to name here for the same reason.
    const dialed = vi.spyOn(fs.realpathSync, 'native')
    try {
      const started = Date.now()
      expect(isInsideRoot('\\\\tg-no-such-host\\share\\secret.txt', base)).toBe(false)
      const elapsed = Date.now() - started
      expect(dialed, 'the check resolved a path on a host the caller named').not.toHaveBeenCalled()
      // The link walk is what would dial, and `lstatSync` cannot be spied on (its property is not
      // configurable), so the clock stands in for it. This is not a performance assertion and the
      // ceiling is nowhere near the real timings: refusing costs microseconds, while an `lstat` on
      // an unreachable host measured 2,739 ms here and a link walk onto a real one 21.0 s.
      expect(elapsed, 'the walk started before the share was refused').toBeLessThan(1_000)
    } finally {
      dialed.mockRestore()
    }
  })

  it.runIf(process.platform === 'win32')('still resolves a drive-letter device path, which costs no connection', () => {
    // The mirror of the case above, and the reason "two leading slashes" is not the question asked.
    // `\\?\C:\...` is spelled like a share and is not one: it is this volume, one local `realpath`
    // away. Refusing it on the spelling would decline a real path on an ordinary Windows machine,
    // where these two names genuinely are one directory.
    const root = path.join(base, 'device')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '')
    const device = `\\\\?\\${base}`
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    expect(isInsideRoot(path.join(device, 'Device', 'src', 'index.ts'), path.join(device, 'device'))).toBe(!volumeIsCaseSensitive)
  })

  it.runIf(volumeIsCaseSensitive)('refuses a spelling of the root that is not on disk when the root itself is', () => {
    // The asymmetry IS the answer. On a volume that really folds, `MISSING` would have resolved to
    // the same directory as `missing`; that it does not resolve at all, while the root does, is the
    // filesystem saying they are different places and that the caller's one is not there. Admitting
    // it lets a create put a new directory beside the project rather than inside it.
    const root = path.join(base, 'missing')
    fs.mkdirSync(root, { recursive: true })
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    expect(isInsideRoot(path.join(base, 'MISSING', 'new.ts'), root)).toBe(false)
  })

  it('keeps the platform answer when the root itself is not on disk', () => {
    // Nothing to compare and no second directory to be let into -- a project root that has not been
    // created yet, or a configured one that is gone. Failing closed here would refuse a legitimate
    // configuration for no gain, so this is the one branch that still answers from the platform.
    const root = path.join(base, 'never-created')
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    expect(isInsideRoot(path.join(base, 'Never-Created', 'src', 'x.ts'), root)).toBe(true)
  })

  it('accepts a path under the root that does not exist yet, whatever the volume', () => {
    delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    // A write target has no directory to compare, and refusing one would turn every "create a file
    // under the project" into a containment failure. The platform's answer stands there.
    const root = path.join(base, 'writable')
    fs.mkdirSync(root, { recursive: true })
    expect(isInsideRoot(path.join(root, 'not-created-yet', 'x.ts'), root)).toBe(true)
  })
})
