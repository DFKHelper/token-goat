/**
 * Shared apparatus for testing `isInsideRoot` against real filesystem shapes.
 *
 * Four rounds of audit on the containment primitive have each hand-rebuilt the same fixture
 * scaffolding, and every rebuild re-decided the platform gating and re-derived the expected
 * answers by hand. This module exists so the fifth does not.
 *
 * PROVENANCE: CAPTURE / HAND-DERIVED, split deliberately, and the split is the point.
 *
 *   - The GROUND TRUTH for a materializable case is CAPTURE: {@link assertContainment} actually
 *     creates the target on disk, runs `fs.realpathSync` on it and on the root, and compares them
 *     with `path.relative`. That oracle shares no code with `resolveThroughLinks` -- it is the
 *     kernel's own answer, reached through Node's realpath -- so a case cannot pass by the
 *     implementation agreeing with itself. This is the specific failure mode the repo has hit six
 *     or more times: a fixture written from the code's own matcher.
 *   - Each case ALSO carries a hand-written `expect`, and the two are cross-checked against each
 *     other before either is compared to `isInsideRoot`. A disagreement fails the test naming both
 *     sides, rather than quietly trusting whichever one was written last.
 *   - A case that cannot be materialized (a dangling leaf, an ELOOP pair -- realpath throws on
 *     both by construction) must say so via `unmaterializable`, and that string is printed in the
 *     failure. HAND-DERIVED expectations are fine there, because the question is logic rather than
 *     a wire format, but they are marked so nobody later mistakes one for a captured answer.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { expect } from 'vitest'

import { isInsideRoot } from '../../src/path_containment.js'
import { CAN_JUNCTION, CAN_SYMLINK } from './can-symlink.js'

export const IS_WINDOWS = process.platform === 'win32'

/** One row of a containment matrix. */
export interface ContainmentCase {
  /** Human name, printed on failure. Make it name the SHAPE, not the expected answer. */
  readonly label: string
  /** Absolute path to ask about. */
  readonly target: string
  /**
   * The expected answer, cross-checked against the realpath oracle below. Where the two are
   * checkable this is the KERNEL's answer: what the path really names, not what the implementation
   * would like it to name.
   */
  readonly expect: boolean
  /**
   * Set when the implementation deliberately answers `false` for a target the kernel says IS inside
   * the root -- a conservative refusal rather than a hole. The value is the reason, and it is
   * required rather than optional so that a fail-closed divergence has to be argued for in writing
   * instead of quietly encoded as an expectation. Only this direction is allowed: a case claiming
   * the implementation says `true` where the kernel says `false` is a security defect, and no field
   * here will let you record one.
   */
  readonly conservative?: string
  /**
   * Set when the shape cannot be created on disk, so the realpath oracle cannot run: a dangling
   * leaf, an ELOOP pair, a path the platform refuses outright. The value is the reason, printed on
   * failure, and its presence is what downgrades this row from CAPTURE to HAND-DERIVED.
   */
  readonly unmaterializable?: string
}

/**
 * The independent oracle: does `target` really live under `root`, per the kernel?
 *
 * Materializes `target` (creating its parents, following whatever links are already planted), then
 * compares `realpathSync` of both sides with `path.relative`. Returns null when the shape cannot be
 * materialized, which is the caller's cue to fall back to the case's declared expectation.
 *
 * Deliberately NOT written in terms of anything in `path_containment.ts`: no `foldPath`, no
 * `canonicalize`, no segment walk. `path.relative` folds case on Windows already, and on a
 * case-insensitive macOS volume realpath returns the on-disk spelling for both sides, so the
 * comparison is the platform's own.
 */
function realpathOracle(target: string, root: string): boolean | null {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!fs.existsSync(target)) fs.writeFileSync(target, 'containment-matrix-probe\n')
    const rt = fs.realpathSync(target)
    const rr = fs.realpathSync(root)
    const rel = path.relative(rr, rt)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch {
    return null
  }
}

/**
 * Assert `isInsideRoot` answers `expect` for every case, and that `expect` itself survives the
 * independent oracle.
 *
 * Asserts the population is non-empty first: a matrix that silently collected nothing passes every
 * other assertion in this file, and a guard that can pass vacuously is worse than no guard.
 */
export function assertContainment(cases: readonly ContainmentCase[], root: string): void {
  expect(cases.length, 'containment matrix is empty -- a vacuous pass, not a passing test').toBeGreaterThan(0)

  let captured = 0
  let materializable = 0
  for (const c of cases) {
    // ORDER MATTERS: ask the implementation FIRST, oracle SECOND. The oracle materializes the
    // target, and for a dangling-leaf case that write travels through the link and creates the
    // very file whose absence is the shape under test. Measuring first preserves it.
    const actual = isInsideRoot(c.target, root)

    if (c.unmaterializable === undefined) {
      materializable++
      const oracle = realpathOracle(c.target, root)
      if (oracle === null) {
        throw new Error(`${c.label}: could not materialize ${c.target}, and the case does not declare itself unmaterializable. Add \`unmaterializable: '<why>'\` if that is expected, otherwise the fixture is broken.`)
      }
      captured++
      expect(
        oracle,
        `${c.label}: the declared expectation (${String(c.expect)}) disagrees with what the kernel says about ${c.target} under ${root} (${String(oracle)}). One of the two is wrong; fix the expectation, or the fixture.`,
      ).toBe(c.expect)
    }

    if (c.conservative !== undefined) {
      expect(c.expect, `${c.label}: \`conservative\` only describes refusing a target the kernel places INSIDE the root, so \`expect\` must be true`).toBe(true)
      expect(
        actual,
        `${c.label}: declared as a deliberate conservative refusal (${c.conservative}), but isInsideRoot accepted ${c.target}. Either the implementation changed and the note is stale, or the note is wrong.`,
      ).toBe(false)
    } else {
      expect(
        actual,
        `${c.label}: isInsideRoot(${c.target}, ${root})${c.unmaterializable === undefined ? '' : ` [HAND-DERIVED: ${c.unmaterializable}]`}`,
      ).toBe(c.expect)
    }
  }

  // A matrix whose every case is hand-declared proves only that the expectations agree with the
  // implementation, which is the closed loop this helper exists to avoid. Only enforced when the
  // matrix claimed at least one materializable case -- a deliberately all-unmaterializable matrix
  // (ELOOP pairs, say) is a legitimate HAND-DERIVED suite and says so in every label.
  if (materializable > 0) {
    expect(captured, 'no case in this matrix reached the realpath oracle').toBe(materializable)
  }
}

/** Platform-gated link fixture builders. Each returns false when the platform refuses the link. */
export const link = {
  /** A DIRECTORY link: a junction on Windows (unprivileged), a directory symlink on POSIX. */
  dir(from: string, to: string): boolean {
    if (!(IS_WINDOWS ? CAN_JUNCTION : CAN_SYMLINK)) return false
    try {
      fs.mkdirSync(path.dirname(from), { recursive: true })
      fs.symlinkSync(to, from, 'junction')
      return true
    } catch {
      return false
    }
  },
  /** A DIRECTORY SYMLINK specifically -- distinct from a junction on Windows, where the two resolve differently. */
  dirSymlink(from: string, to: string): boolean {
    if (!CAN_SYMLINK) return false
    try {
      fs.mkdirSync(path.dirname(from), { recursive: true })
      fs.symlinkSync(to, from, 'dir')
      return true
    } catch {
      return false
    }
  },
  /** A FILE link. The target need not exist: a dangling leaf is one of the shapes under test. */
  file(from: string, to: string): boolean {
    if (!CAN_SYMLINK) return false
    try {
      fs.mkdirSync(path.dirname(from), { recursive: true })
      fs.symlinkSync(to, from, 'file')
      return true
    } catch {
      return false
    }
  },
}

/** A fresh scratch root plus a sibling "outside" directory, both real and both cleaned by the caller. */
export function scratchPair(prefix: string): { base: string; root: string; outside: string; cleanup: () => void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  return {
    base,
    root,
    outside,
    cleanup: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true })
      } catch {
        // Best effort: a junction the OS still holds open is not worth failing a run over.
      }
    },
  }
}

/**
 * Claim a virtual drive letter with `subst`, for the shapes that need a WRITABLE DRIVE ROOT.
 *
 * The OS temp root never is one, and a drive root is its own case: `path.posix.dirname('x:/f')` is
 * `'x:'`, slashless, which is how a dangling link directly in a drive root once read as contained.
 * Returns null on POSIX, without a free letter, or without the symlink privilege.
 */
export function claimSubstDrive(): { letter: string; backing: string; release: () => void } | null {
  if (!IS_WINDOWS || !CAN_SYMLINK) return null
  let letter: string | null = null
  for (const c of 'YXWVUT') {
    if (!fs.existsSync(`${c}:/`)) {
      letter = c
      break
    }
  }
  if (letter === null) return null
  const backing = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-subst-'))
  try {
    execFileSync('subst', [`${letter}:`, backing], { stdio: 'ignore' })
  } catch {
    fs.rmSync(backing, { recursive: true, force: true })
    return null
  }
  const claimed = letter
  return {
    letter: claimed,
    backing,
    release: () => {
      try {
        execFileSync('subst', [`${claimed}:`, '/D'], { stdio: 'ignore' })
      } catch {
        // Best effort: a stray virtual drive is per-session and disappears with the login.
      }
      try {
        fs.rmSync(backing, { recursive: true, force: true })
      } catch {
        // As above.
      }
    },
  }
}
