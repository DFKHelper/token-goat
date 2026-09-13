/**
 * `resolveThroughLinks` walked an unbounded path one `lstatSync` at a time, on a PRE-APPROVAL code
 * path, and the cost was superlinear rather than merely quadratic.
 *
 * MEASURED at 3cd0b044, against the real `isInsideRoot`, one process, same machine:
 *
 *     segments   bytes      isInsideRoot       one realpathSync
 *         10        106            1.3 ms               0.1 ms
 *       1000       6946           38.4 ms               0.3 ms
 *      20000     168946        8,062.5 ms               4.3 ms
 *     200000    1888946    1,301,906.1 ms              14.9 ms
 *
 * That last row is 21m42s of pinned CPU for one call, a factor of ~87,000 over a single realpath.
 * Per-segment cost climbs 38.4us -> 403us -> 6,510us across those rows: the `Array.shift()` queue is
 * one term, and reallocating the growing `base` string in `joinSegment` is the other, which is why
 * the index cursor alone was never going to be sufficient and why the length CAP is the
 * load-bearing control this file asserts.
 *
 * THE IMPACT IS A HANG, NOT SLOWNESS. The reachable path is `getFilePath(event)` ->
 * `vscodePathAllowed` -> `isInsideRoot`, from `hooks_read.ts:22`, `hooks_write.ts:35` and
 * `image_shrink.ts:40` -- BEFORE the user approves the tool call, on a model-chosen path. In VS
 * Code that hook runs IN-PROCESS with no timeout available (`src/vscode_duplicate.ts:124-127` says
 * so); in Claude Code it is a subprocess pinning one core for as long as it takes. A model emitting
 * one long path hangs the editor's hook, and nothing on the other side can cancel it.
 *
 * THE CAP IS INSIDE `resolveThroughLinks`, not at the three hook call sites, because
 * `assertProjectScopeTarget` and every CLI caller reach the same walk and would have been left
 * uncapped by a call-site fix.
 *
 * PROVENANCE: CAPTURE for the timings above (real runs, harness in the commit message) and CAPTURE
 * for everything asserted below -- each expectation is measured from a real call, and the errno
 * cases plant a real unreadable directory rather than describing one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isInsideRoot } from '../src/path_containment.js'
import { CAN_SYMLINK } from './helpers/can-symlink.js'

const POSIX = process.platform !== 'win32'

/**
 * The cap, restated here rather than imported.
 *
 * Importing the constant would make this test agree with whatever the implementation currently
 * says, including with a change that raised it to 4 GB. 4096 is PATH_MAX on Linux; macOS is 1024
 * and Windows is 260 (32,767 with the extended prefix), so no real path any caller has is anywhere
 * near it and the cap costs no legitimate use.
 */
const MAX_BYTES = 4096

const scratches: string[] = []
afterEach(() => {
  while (scratches.length > 0) {
    const d = scratches.pop() as string
    try {
      if (POSIX) fs.chmodSync(d, 0o700)
    } catch {
      // Best effort: restoring the mode is only needed so the rm below can descend.
    }
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // Best effort; the OS temp root is swept independently.
    }
  }
})

function scratch(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walkcap-')))
  scratches.push(d)
  return d
}

/**
 * A path of `n` segments under `root`, lexically inside it by construction.
 *
 * Eight-character segments, so that n=200,000 reproduces the ~1.89 MB shape of the measured
 * 1,301,906 ms row above rather than a shorter path that would understate it.
 */
function longPath(root: string, n: number): string {
  return root + path.sep + Array.from({ length: n }, (_, i) => `seg${i % 10}xxxx`).join(path.sep)
}

describe('the path-resolution walk is bounded', () => {
  it('answers in bounded time for the 200,000-segment path that used to take 21 minutes', () => {
    const root = scratch()
    const target = longPath(root, 200_000)
    expect(Buffer.byteLength(target, 'utf8')).toBeGreaterThan(1_000_000)

    const t0 = performance.now()
    const answer = isInsideRoot(target, root)
    const elapsed = performance.now() - t0

    // The pre-fix measurement for this exact shape was 1,301,906 ms. The bound below is deliberately
    // three orders of magnitude looser than the ~0.3 ms the capped path actually costs, so it is a
    // statement about the ALGORITHM rather than about this machine's load -- and it is still more
    // than six orders of magnitude under the pre-fix figure. A regression that reintroduces the walk
    // cannot squeeze under it.
    expect(
      elapsed,
      `resolving a ${Buffer.byteLength(target, 'utf8')}-byte path took ${elapsed.toFixed(1)} ms. The cap in ` +
        'resolveThroughLinks is gone or has been raised: this call is reachable from the VS Code ' +
        'pre-approval hook, which runs in-process with no timeout, so an unbounded walk here hangs the ' +
        'editor rather than merely being slow.',
    ).toBeLessThan(500)
    // Fail CLOSED: an over-cap path is unresolvable, and unresolvable is never "contained".
    expect(answer).toBe(false)
  })

  it('refuses a path one byte over the cap and accepts the same shape one byte under it', () => {
    // The behavioural statement of the cap, independent of any clock. Both of these are LEXICALLY
    // inside the root and differ only in length, so a passing pair can only mean the length itself
    // is what decided -- which is what makes this the assertion that survives a fast machine.
    const root = scratch()
    const pad = MAX_BYTES - Buffer.byteLength(root, 'utf8') - 2
    expect(pad, 'the scratch root is too long for this fixture to straddle the cap').toBeGreaterThan(16)

    const under = `${root}${path.sep}${'u'.repeat(pad)}`
    const over = `${root}${path.sep}${'o'.repeat(pad + 8)}`
    expect(Buffer.byteLength(under, 'utf8')).toBeLessThanOrEqual(MAX_BYTES)
    expect(Buffer.byteLength(over, 'utf8')).toBeGreaterThan(MAX_BYTES)

    expect(isInsideRoot(under, root), 'a legitimate path under the cap must still resolve').toBe(true)
    expect(isInsideRoot(over, root), 'a path over the cap is unresolvable, and unresolvable fails closed').toBe(false)
  })

  // NOT POSIX-gated, and the gate that used to be here was justified by a measurement that is
  // false. The comment claimed "Windows refuses to CREATE a symlink whose stored target exceeds
  // MAX_PATH, absolute or relative (measured -- ENOENT from symlinkSync, both spellings)". Re-run
  // on win32 (Windows 11, Node 24): a 3,837-byte RELATIVE dir target, the same 3,837-byte target as
  // a file symlink, a 3,082-byte ABSOLUTE dir target and a 3,082-byte junction all created
  // successfully and read back at their full stored length. So the gate was stricter than its own
  // stated reason, and it was costing the ONLY case that discriminates cap 2 its only automated
  // execution -- on the one machine anyone actually runs this suite on, since `origin/main` is 167
  // commits behind and no CI has ever seen this file. CAN_SYMLINK still gates it, because an
  // unprivileged Windows account without Developer Mode genuinely cannot create one; that is a
  // permission fact, checked at run time, rather than an inherited belief about path lengths.
  it.runIf(CAN_SYMLINK)('refuses a SHORT path whose link expansion pushes the resolved form over the cap', () => {
    // The second cap earns its place here and only here. The entry cap measures the INPUT, and this
    // input is 60-odd bytes. A link target is spliced into the remaining work, so the walk can
    // outgrow whatever arrived: without the in-loop check on the growing `base`, the resolved form
    // is unbounded no matter how small the caller's string was. Remove either cap alone and the
    // over-the-cap case above still passes, which is why this case exists to tell them apart.
    // A RELATIVE target of many 100-byte segments. Three OS limits shape this fixture and all
    // three were hit while writing it: a single path COMPONENT is capped at 255 bytes on NTFS and
    // ext4; Windows refuses to create a symlink whose stored target exceeds MAX_PATH, absolute or
    // relative; and Linux caps the stored target itself at PATH_MAX, so the target alone cannot
    // exceed the cap. The root is therefore DEEPENED first, so that root + target crosses 4096
    // while the target on its own stays under it. None of the target's segments exists, which is
    // fine -- an absent component is ENOENT, provably not a link, so the walk keeps going while
    // `base` grows, which is precisely the growth being capped.
    const segment = 'x'.repeat(100)
    let root = scratch()
    while (root.length < 400) {
      root = path.join(root, 'd'.repeat(60))
      fs.mkdirSync(root, { recursive: true })
    }
    const linkTarget = Array.from({ length: 38 }, () => segment).join('/')
    expect(Buffer.byteLength(linkTarget, 'utf8'), 'the stored link target must be under PATH_MAX or the OS refuses to create it').toBeLessThan(MAX_BYTES)
    expect(root.length + linkTarget.length, 'the RESOLVED form has to cross the cap, or this case proves nothing').toBeGreaterThan(MAX_BYTES)
    fs.symlinkSync(linkTarget, path.join(root, 'lnk'), 'dir')

    const target = path.join(root, 'lnk', 'y'.repeat(64))
    expect(Buffer.byteLength(target, 'utf8'), 'the INPUT must be comfortably under the cap, or the entry check decides this').toBeLessThan(MAX_BYTES)

    expect(
      isInsideRoot(target, root),
      'the resolved path exceeds the cap even though the input did not, so it is unresolvable and ' +
        'unresolvable fails closed. Note it is lexically inside the root, so a permissive answer here ' +
        'is what an unbounded walk would return.',
    ).toBe(false)
  })

  it('refuses an over-cap INPUT whose resolved form would collapse back under the cap', () => {
    // THE CASE THAT DISCRIMINATES CAP 1, which nothing did until this was written. The two caps
    // are not redundant, but the assertions around them could not tell them apart: comment out the
    // entry check `Buffer.byteLength(p) > MAX_RESOLVE_PATH_BYTES` and the whole of
    // path_containment_walk_cap + containment_matrix + pre_handler_fs_touches_are_gated stayed at
    // 19 passed / 3 skipped / 0 failed (reproduced on this machine before writing this). The
    // over-the-cap pair above cannot see it because the in-loop cap 2 catches that input too and
    // returns the same verdict, and the 1.89 MB timing case is pinned at a budget the uncapped path
    // fits inside (measured 217 ms against a 500 ms budget).
    //
    // The discriminator is an input that is over the cap in BYTES while its RESOLVED form never is:
    // ~900 `ab/..` pairs collapse to nothing, so `candidate` never grows past `<root>/ab` and cap 2
    // is never reached. Cap 1 present -> unresolvable -> false. Cap 1 removed -> the walk runs to
    // completion and answers TRUE, i.e. a 5,465-byte attacker-chosen path reads as CONTAINED.
    //
    // Preferred over a timing assertion deliberately: this is a CORRECTNESS difference, not a
    // performance one, so it needs no clock, no budget, and no headroom argument, and it says
    // something stronger than "cap 1 makes it fast" -- it says cap 1 is what makes the answer
    // right. Measured both ways on win32: false with the cap, true without it.
    const root = scratch()
    const target = root + path.sep + Array.from({ length: 900 }, () => `ab${path.sep}..`).join(path.sep) + `${path.sep}ab`
    expect(
      Buffer.byteLength(target, 'utf8'),
      'the INPUT has to exceed the cap or the entry check is not what this case is asking about',
    ).toBeGreaterThan(MAX_BYTES)
    // Calibration for the other half: the same shape, short enough to be under the cap, must still
    // answer TRUE. Without it, a `false` above is indistinguishable from a walk that simply cannot
    // handle `..` at all.
    const shortSame = root + path.sep + Array.from({ length: 3 }, () => `ab${path.sep}..`).join(path.sep) + `${path.sep}ab`
    expect(Buffer.byteLength(shortSame, 'utf8')).toBeLessThan(MAX_BYTES)
    expect(isInsideRoot(shortSame, root), 'the dotdot-pair shape resolves to <root>/ab, which IS inside the root').toBe(true)

    expect(
      isInsideRoot(target, root),
      'an input over the byte cap is unresolvable and unresolvable fails closed. Without the ENTRY ' +
        'cap this answers true: the dotdot pairs collapse, the resolved form never grows, the in-loop ' +
        'cap never fires, and a 5.4 KB model-chosen path on the pre-approval hook path reads as ' +
        'contained. Cap 1 is a correctness control, not only a cost one.',
    ).toBe(false)
  })

  it('stays bounded at the adversarial worst case: the longest path the cap still admits', () => {
    // Just under the cap with the shortest possible segments is the most lstat calls an attacker can
    // buy: ~2,000 of them. Measured at 72.65 ms post-fix on this machine. The bound below leaves
    // room for a loaded CI runner while still being far under anything a user would notice.
    const root = scratch()
    const budget = MAX_BYTES - Buffer.byteLength(root, 'utf8') - 4
    const segments = Math.floor(budget / 2)
    const target = root + path.sep + Array.from({ length: segments }, () => 'a').join(path.sep)
    expect(Buffer.byteLength(target, 'utf8')).toBeLessThanOrEqual(MAX_BYTES)

    const t0 = performance.now()
    isInsideRoot(target, root)
    const elapsed = performance.now() - t0

    expect(elapsed, `the worst case the cap admits took ${elapsed.toFixed(1)} ms across ~${segments} segments`).toBeLessThan(4000)
  })
})

describe('an unreadable ancestor fails closed rather than resolving lexically', () => {
  // The walk used to catch EVERY lstatSync throw and treat the segment as "not a link". EACCES on an
  // untraversable ancestor is not evidence that nothing is a link -- it is evidence that the answer
  // is unknown -- and answering "not a link" turns an unknown into a permissive verdict on a
  // pre-approval path. ENOENT and ENOTDIR are genuinely different: they prove the component is
  // absent, so it provably is not a link, and the walk must keep going or every not-yet-created
  // install target would be refused.
  it('still resolves a path whose components simply do not exist yet (ENOENT is not a failure)', () => {
    const root = scratch()

    expect(isInsideRoot(path.join(root, 'never', 'created', 'file.ts'), root)).toBe(true)
  })

  it('treats a component under a FILE as absent rather than unreadable (ENOTDIR)', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'a-file'), 'not a directory\n')

    // Nonsensical as a target, but it must produce an answer rather than a throw, and the answer
    // must be the lexical-containment one: nothing here is a link.
    expect(isInsideRoot(path.join(root, 'a-file', 'under', 'it.ts'), root)).toBe(true)
  })

  it.runIf(POSIX && process.getuid?.() !== 0)('refuses a path below a directory it cannot traverse (EACCES)', () => {
    const root = scratch()
    const locked = path.join(root, 'locked')
    fs.mkdirSync(path.join(locked, 'inner'), { recursive: true })
    scratches.push(locked)
    fs.chmodSync(locked, 0o000)

    // Calibration: the fixture only means something if the OS really is refusing this process.
    let denied = false
    try {
      fs.lstatSync(path.join(locked, 'inner'))
    } catch (err) {
      denied = (err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EPERM'
    }
    expect(denied, 'the 0o000 directory is still traversable by this process, so this case proves nothing').toBe(true)

    expect(
      isInsideRoot(path.join(locked, 'inner', 'target.ts'), root),
      'an ancestor that cannot be read might be a symlink out of the project, and there is no way to ' +
        'find out. Answering "contained" turns an unknown into a permissive verdict on a pre-approval path.',
    ).toBe(false)
  })
})
