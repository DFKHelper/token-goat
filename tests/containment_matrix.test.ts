/**
 * The containment matrix: every filesystem shape `isInsideRoot` has ever been wrong about, plus the
 * ones an auditor probed and found it right about, in one place with one oracle.
 *
 * `isInsideRoot` is the whole trust boundary for project-scope installs (`assertWriteInScope` ->
 * `assertProjectScopeTarget` -> here) and for the VS Code pre-approval path gate. Four audit rounds
 * have each found a different shape it mishandled, and each round's regression test was hand-rolled
 * beside the last one's, so the next shape had to be thought of from scratch. This file is the
 * standing population instead.
 *
 * PROVENANCE: CAPTURE. Every materializable expectation below is cross-checked inside
 * {@link assertContainment} against `fs.realpathSync` -- the kernel's own answer, sharing no code
 * with the implementation under test -- and a disagreement fails the case naming both sides. The
 * handful of shapes that cannot exist on disk by construction (an ELOOP pair) are tagged
 * HAND-DERIVED via `unmaterializable` and say so in the failure message.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isInsideRoot } from '../src/path_containment.js'
import {
  assertContainment,
  claimSubstDrive,
  type ContainmentCase,
  IS_WINDOWS,
  link,
  scratchPair,
} from './helpers/containment_matrix.js'
import { CAN_JUNCTION, CAN_SYMLINK } from './helpers/can-symlink.js'

/** A directory link is a junction on Windows (unprivileged) and a directory symlink on POSIX. */
const CAN_DIR_LINK = IS_WINDOWS ? CAN_JUNCTION : CAN_SYMLINK

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) (cleanups.pop() as () => void)()
})

/**
 * Join path parts WITHOUT collapsing anything.
 *
 * `path.join` normalizes `..` lexically, so `path.join(root, 'jn', '..', 'x')` is already
 * `<root>/x` before the test ever runs: the link-then-dotdot cases silently degrade into plain
 * inside-the-root cases and pass for the wrong reason. Every case below that contains a `..`
 * therefore builds its target with this, not with `path.join`. (Found by the realpath oracle, which
 * reported "inside" for a case whose whole point was that it escaped.)
 */
function raw(...parts: readonly string[]): string {
  return parts.join(path.sep)
}

function scratch(): { base: string; root: string; outside: string } {
  const s = scratchPair('tg-containment-')
  cleanups.push(s.cleanup)
  return { base: s.base, root: s.root, outside: s.outside }
}

describe('containment matrix', () => {
  it('resolves the lexical shapes, with no link involved anywhere', () => {
    const { root, outside } = scratch()
    const cases: ContainmentCase[] = [
      { label: 'the root itself', target: root, expect: true },
      { label: 'an ordinary file inside', target: path.join(root, 'a.txt'), expect: true },
      { label: 'a not-yet-created file several levels down', target: path.join(root, 'x', 'y', 'z.ts'), expect: true },
      { label: 'dotdot that climbs and comes back in', target: raw(root, 'sub', '..', 'back.txt'), expect: true },
      { label: 'an absolute escape to a sibling directory', target: path.join(outside, 'stolen.txt'), expect: false },
      { label: 'a relative escape written as dotdot off the root', target: raw(root, '..', 'outside', 'stolen2.txt'), expect: false },
      { label: 'a sibling whose name merely PREFIXES the root', target: `${root}-evil${path.sep}a.txt`, expect: false },
    ]

    assertContainment(cases, root)
  })

  it.skipIf(!CAN_DIR_LINK)('resolves directory links, including the dotdot that follows one', () => {
    const { base, root, outside } = scratch()
    fs.mkdirSync(path.join(root, 'other'), { recursive: true })

    expect(link.dir(path.join(root, 'jn'), outside), 'planting root/jn -> outside').toBe(true)
    expect(link.dir(path.join(root, 'deep', 'jn'), path.join(root, 'other')), 'planting root/deep/jn -> root/other').toBe(true)
    expect(link.dir(path.join(base, 'rootlink'), root), 'planting base/rootlink -> root').toBe(true)

    const cases: ContainmentCase[] = [
      { label: 'a file behind a directory link that leaves the root', target: path.join(root, 'jn', 'leak.txt'), expect: false },
      // PLATFORM-DIVERGENT, and the oracle is what established it rather than a guess. Win32
      // collapses `..` LEXICALLY in its path parser, before the object manager ever resolves the
      // junction, so `<root>\jn\..` really does name `<root>` and the file really is written
      // inside. POSIX resolves the symlink first and lands in `<base>`, outside. `isInsideRoot`
      // resolves link-first on both, so on Windows it refuses a path the kernel would have kept
      // inside: conservative, declared, and asserted as such rather than papered over.
      IS_WINDOWS
        ? {
            label: 'junction-then-dotdot (Win32 collapses the dotdot lexically, so it stays inside)',
            target: raw(root, 'jn', '..', 'climbed.txt'),
            expect: true,
            conservative: 'isInsideRoot resolves the junction before the dotdot, which lands above the root; refusing a write Win32 would have kept inside is the safe direction',
          }
        : {
            label: 'symlink-then-dotdot, which climbs out of the link target',
            target: raw(root, 'jn', '..', 'climbed.txt'),
            expect: false,
          },
      { label: 'link-then-dotdot that lands back inside the root', target: raw(root, 'deep', 'jn', '..', 'inner.txt'), expect: true },
      { label: 'the root reached through a link that points at it', target: path.join(base, 'rootlink', 'a.txt'), expect: true },
    ]

    assertContainment(cases, root)
  })

  it.skipIf(!CAN_DIR_LINK)('accepts a root that is itself a link', () => {
    const { base, root, outside } = scratch()
    const rootlink = path.join(base, 'rootlink')
    expect(link.dir(rootlink, root), 'planting base/rootlink -> root').toBe(true)

    assertContainment(
      [
        { label: 'a file under the linked root', target: path.join(rootlink, 'a.txt'), expect: true },
        { label: 'the real root, addressed directly, while the declared root is the link', target: path.join(root, 'b.txt'), expect: true },
        { label: 'an escape, with the root given as a link', target: path.join(outside, 'stolen.txt'), expect: false },
      ],
      rootlink,
    )
  })

  it('accepts a root given as a RELATIVE path', () => {
    const { root, outside } = scratch()
    // Relative to the process cwd, which vitest leaves at the repo root. A caller passing
    // `process.cwd()`-relative roots is not hypothetical: `projectScopeRoot` resolves `opts.projectRoot`
    // exactly because a bridge may hand one in unresolved.
    const relRoot = path.relative(process.cwd(), root)
    expect(path.isAbsolute(relRoot), 'the fixture root must be expressible relative to cwd').toBe(false)

    assertContainment(
      [
        { label: 'a file inside, with a relative root', target: path.join(root, 'a.txt'), expect: true },
        { label: 'an escape, with a relative root', target: path.join(outside, 'stolen.txt'), expect: false },
      ],
      relRoot,
    )
  })

  it.skipIf(!CAN_SYMLINK)('fails closed on a dangling leaf and on an ELOOP pair', () => {
    const { root, outside } = scratch()
    expect(link.file(path.join(root, 'dang-out'), path.join(outside, 'nope.txt')), 'planting the outward dangling leaf').toBe(true)
    expect(link.file(path.join(root, 'dang-in'), path.join(root, 'nope.txt')), 'planting the inward dangling leaf').toBe(true)
    expect(link.file(path.join(root, 'loop-a'), path.join(root, 'loop-b')), 'planting loop-a').toBe(true)
    expect(link.file(path.join(root, 'loop-b'), path.join(root, 'loop-a')), 'planting loop-b').toBe(true)

    assertContainment(
      [
        // The leaf does not exist, so `realpathSync` throws and the pre-fix code fell back to a
        // LEXICAL answer -- which is true, and wrong. Measured before the oracle materializes it.
        { label: 'a dangling leaf link pointing out of the root', target: path.join(root, 'dang-out'), expect: false },
        { label: 'a dangling leaf link pointing back inside the root', target: path.join(root, 'dang-in'), expect: true },
        {
          label: 'an ELOOP pair: neither side can ever resolve, so containment is unknowable',
          target: path.join(root, 'loop-a'),
          expect: false,
          unmaterializable: 'the two links point at each other, so every filesystem call on either returns ELOOP',
        },
      ],
      root,
    )
  })

  it.runIf(process.platform === 'darwin')('treats an NFD spelling and its NFC form as the same path', () => {
    // APFS and HFS+ are normalization-INSENSITIVE: a directory created as NFC 'e\u0301' opens under
    // the NFD spelling and vice versa, so a target spelled one way under a root spelled the other
    // is genuinely the same location. ext4 and NTFS are normalization-SENSITIVE and would make
    // these two distinct paths, which is why the normalization in `isInsideRoot` is darwin-gated
    // and why this test is too. Skipped honestly off macOS rather than asserted from a string fold.
    const { base } = scratch()
    const nfc = path.join(base, 'caf\u00e9')
    const nfd = path.join(base, 'cafe\u0301')
    fs.mkdirSync(nfc, { recursive: true })

    assertContainment(
      [
        { label: 'an NFD target under an NFC root', target: path.join(nfd, 'a.txt'), expect: true },
        { label: 'an escape, under a root spelled NFC', target: path.join(base, 'elsewhere', 'x.txt'), expect: false },
      ],
      nfc,
    )
  })

  describe('windows-only path spellings', () => {
    it.runIf(IS_WINDOWS)('is not fooled by a trailing-dot or trailing-space component', () => {
      // Win32 strips a trailing dot or space from a component before the filesystem ever sees it,
      // which historically let `foo/../` style escapes hide behind `foo. /..`. The oracle catches
      // the stripping because it asks realpath what the path actually named.
      const { root, outside } = scratch()
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true })

      assertContainment(
        [
          { label: 'a trailing-space component inside the root', target: `${path.join(root, 'sub')} ${path.sep}a.txt`, expect: true },
          { label: 'a trailing-dot component inside the root', target: `${path.join(root, 'sub')}.${path.sep}b.txt`, expect: true },
          { label: 'a trailing-dot escape', target: `${outside}.${path.sep}stolen.txt`, expect: false },
        ],
        root,
      )
    })

    it.runIf(IS_WINDOWS)('resolves the extended-length \\\\?\\ prefix the same way as the plain spelling', () => {
      const { root, outside } = scratch()

      // Node's own `realpathSync` cannot answer for this spelling -- it throws
      // `EISDIR: illegal operation on a directory, lstat 'C:'` -- so the oracle is unavailable and
      // these two rows are HAND-DERIVED, marked as such. Win32 itself accepts the spelling
      // (mkdir/write/exists all succeed through it), which is exactly why it has to be pinned:
      // a containment check that answered "inside" for the prefixed spelling of an OUTSIDE path
      // would be a bypass. Refusing the prefixed spelling of an inside path is the safe direction.
      const why = "Node's realpathSync throws EISDIR on the \\\\?\\ spelling, so there is no independent oracle for it"
      assertContainment(
        [
          { label: 'an escape written with the \\\\?\\ prefix', target: `\\\\?\\${path.join(outside, 'stolen.txt')}`, expect: false, unmaterializable: why },
          { label: 'an inside path written with the \\\\?\\ prefix', target: `\\\\?\\${path.join(root, 'a.txt')}`, expect: false, unmaterializable: why },
        ],
        root,
      )
    })

    it.runIf(IS_WINDOWS)('resolves an 8.3 short name reached after a dotdot', (ctx) => {
      const { root, outside } = scratch()
      const longName = 'outside-directory-with-a-long-name'
      const longDir = path.join(path.dirname(outside), longName)
      fs.mkdirSync(longDir, { recursive: true })

      const short = shortNameOf(longDir)
      if (short === null) {
        ctx.skip('8dot3 name creation is disabled on this volume, so there is no short name to resolve')
      }

      assertContainment(
        [
          {
            label: 'an escape whose final hop is an 8.3 short name reached through a dotdot',
            target: raw(root, '..', short as string, 'stolen.txt'),
            expect: false,
          },
        ],
        root,
      )
    })

    it.runIf(IS_WINDOWS)('does not read an alternate-data-stream suffix as an escape', () => {
      // `file.txt:stream` names a stream ON that file, so it is inside the root exactly when the
      // file is. The failure to guard against is the opposite one -- a `:` making the path parse as
      // a drive-qualified absolute somewhere else.
      const { root } = scratch()
      fs.writeFileSync(path.join(root, 'a.txt'), 'host file\n')

      expect(
        [true, false].includes(isInsideRoot(path.join(root, 'a.txt:evil'), root)),
        'sanity: the call must answer, not throw',
      ).toBe(true)
      expect(isInsideRoot(path.join(root, 'a.txt:evil'), root), 'an ADS on a file inside the root is inside the root').toBe(true)
    })
  })

  describe('at a drive root', () => {
    /**
     * A dangling link sitting DIRECTLY in a drive root was resolved lexically, so it read as
     * contained. `resolveThroughLinks` walked up with `path.posix.dirname`, and
     * `path.posix.dirname('x:/dangfile')` is `'x:'` -- slashless, so the `while (cur.includes('/'))`
     * loop exited with nothing resolved BEFORE the drive root `x:/` was ever tried, and the readlink
     * branch that exists precisely to follow a dangling link was never reached. One level deeper the
     * same shape was refused correctly, which is why nothing looked broken. POSIX was unaffected
     * (`path.posix.dirname('/dangfile')` is `'/'`, which does contain a slash), so this was invisible
     * on two of three CI platforms.
     *
     * `subst` is what gives an unprivileged process a writable DRIVE ROOT; the OS temp root never is
     * one. Absorbed here from the standalone file this shape used to live in.
     */
    it.runIf(IS_WINDOWS && CAN_SYMLINK)('resolves links and plain paths sitting directly in a drive root', (ctx) => {
      const drive = claimSubstDrive()
      if (drive === null) {
        ctx.skip('no free drive letter, or subst refused')
      }
      cleanups.push((drive as NonNullable<typeof drive>).release)
      const root = `${(drive as NonNullable<typeof drive>).letter}:${path.sep}`

      const away = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-drive-outside-'))
      cleanups.push(() => fs.rmSync(away, { recursive: true, force: true }))

      fs.symlinkSync(path.join(away, 'target.txt'), `${root}dangfile`, 'file')
      fs.symlinkSync(away, `${root}dangdir`, 'dir')
      fs.mkdirSync(`${root}deep`, { recursive: true })
      fs.symlinkSync(away, `${root}deep${path.sep}dangdir`, 'dir')

      assertContainment(
        [
          { label: 'a dangling FILE link directly in the drive root', target: `${root}dangfile`, expect: false },
          { label: 'a DIR link directly in the drive root', target: `${root}dangdir${path.sep}a.md`, expect: false },
          { label: 'the same DIR-link shape one level deeper (the control that always worked)', target: `${root}deep${path.sep}dangdir${path.sep}a.md`, expect: false },
          { label: 'an ordinary not-yet-created file in the drive root', target: `${root}not-created-yet.ts`, expect: true },
          { label: 'an ordinary not-yet-created file below the drive root', target: `${root}sub${path.sep}deeper${path.sep}not-created-yet.ts`, expect: true },
        ],
        root,
      )
    })
  })
})

/** The 8.3 short name of a directory, or null when the volume has 8dot3 name creation disabled. */
function shortNameOf(dir: string): string | null {
  try {
    const out = execFileSync('cmd', ['/c', 'dir', '/x', '/ad', path.dirname(dir)], { encoding: 'utf8' })
    const base = path.basename(dir)
    for (const line of out.split(/\r?\n/)) {
      if (!line.endsWith(base)) continue
      const m = /\s([A-Z0-9_~]{1,8}(?:\.[A-Z0-9_~]{1,3})?)\s+\S/.exec(line)
      if (m !== null && m[1] !== undefined && m[1] !== base) return m[1]
    }
    return null
  } catch {
    return null
  }
}
