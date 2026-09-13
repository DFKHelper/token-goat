/**
 * A dangling link sitting DIRECTLY in a drive root was resolved lexically, so it read as contained.
 *
 * `resolveThroughLinks` used to find the nearest existing ancestor by walking up with
 * `path.posix.dirname`, and `path.posix.dirname('x:/dangfile')` is `'x:'` -- slashless, so the
 * `while (cur.includes('/'))` loop exited with nothing resolved BEFORE the drive root `x:/` was
 * ever tried. The function then returned the merely-lexical path and never reached the readlink
 * branch that exists precisely to follow a dangling link, so `isInsideRoot('x:/dangfile', 'x:/')`
 * answered true for a link pointing outside the drive. One level deeper the same shape was refused
 * correctly, which is why nothing here looked broken. POSIX was unaffected --
 * `path.posix.dirname('/dangfile')` is `'/'`, which does contain a slash -- so this was invisible
 * on two of the three CI platforms. It is the same shape as the original finding this whole family
 * came from: a walk that gives up early.
 *
 * No end-to-end exploit was demonstrated (mkdir through a dangling junction returns ENOENT, and the
 * one depth-1 target an installer writes is replaced by a temp+rename), so this is a containment
 * primitive being wrong rather than a hole in a caller. That is exactly the thing to fix at the
 * primitive.
 *
 * `subst` is what gives an unprivileged process a writable DRIVE ROOT; the OS temp root never is
 * one. The drive is removed in afterAll, and the whole file skips when a letter cannot be claimed.
 *
 * PROVENANCE: CAPTURE. The fixture is a real `subst` drive with real links on it, and every
 * expectation is read off what the path actually names, never off what the function returned.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isInsideRoot } from '../src/project.js'
import { CAN_SYMLINK } from './helpers/can-symlink.js'

const WIN = process.platform === 'win32'

let backing: string | null = null
let letter: string | null = null

function freeDriveLetter(): string | null {
  for (const c of 'YXWVUT') {
    if (!fs.existsSync(`${c}:/`)) return c
  }
  return null
}

beforeAll(() => {
  // No bare `return` anywhere in here: a hook that bails abandons every statement after it while
  // its whole file keeps reporting PASSED, which is the shape tests/guards/
  // test_bodies_assert_before_returning.test.ts refuses outright (it has no exemption list).
  const candidate = WIN && CAN_SYMLINK ? freeDriveLetter() : null
  if (candidate !== null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-subst-'))
    let claimed = true
    try {
      execFileSync('subst', [`${candidate}:`, dir], { stdio: 'ignore' })
    } catch {
      claimed = false
    }
    if (claimed) {
      backing = dir
      letter = candidate
    } else {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

afterAll(() => {
  if (letter !== null) {
    try {
      execFileSync('subst', [`${letter}:`, '/D'], { stdio: 'ignore' })
    } catch {
      // Best effort: a stray virtual drive is per-session and disappears with the login.
    }
  }
  if (backing !== null) fs.rmSync(backing, { recursive: true, force: true })
})

describe('containment at a drive root', () => {
  /**
   * Reports SKIPPED rather than passing when there is no drive to test against.
   *
   * `it.skipIf` cannot be used: the drive is claimed in `beforeAll`, and skip conditions are
   * evaluated at collection time, when `letter` is still null. A bare `return` would report PASSED
   * for a test that asserted nothing, which is the dishonest half of exactly this family of bug.
   *
   * `ctx.skip()` ABORTS the body by throwing, so no `return` is needed and none is written -- and
   * that is measured, not assumed: a probe calling `ctx.skip()` ahead of `expect(true).toBe(false)`
   * reported 1 skipped / 0 failed under this vitest (4.1.11).
   */
  function needDrive(ctx: { skip: (note?: string) => void }): void {
    if (letter === null) {
      ctx.skip(WIN ? 'no free drive letter or no symlink privilege' : 'windows-only: POSIX dirname reaches / and was never affected')
    }
  }

  it('refuses a dangling FILE link that sits directly in the drive root', (ctx) => {
    needDrive(ctx)
    const root = `${letter as string}:/`
    const outside = path.join(os.tmpdir(), 'tg-outside-target.txt')
    fs.symlinkSync(outside, `${root}dangfile`, 'file')

    expect(isInsideRoot(`${root}dangfile`, root)).toBe(false)
  })

  it('refuses a dangling DIR link that sits directly in the drive root', (ctx) => {
    needDrive(ctx)
    const root = `${letter as string}:/`
    const outside = path.join(os.tmpdir(), 'tg-outside-dir')
    fs.symlinkSync(outside, `${root}dangdir`, 'dir')

    expect(isInsideRoot(`${root}dangdir/a.md`, root)).toBe(false)
  })

  it('still refuses the same shape one level deeper (the control that always worked)', (ctx) => {
    needDrive(ctx)
    const root = `${letter as string}:/`
    fs.mkdirSync(`${root}deep`, { recursive: true })
    fs.symlinkSync(path.join(os.tmpdir(), 'tg-outside-dir'), `${root}deep/dangdir`, 'dir')

    expect(isInsideRoot(`${root}deep/dangdir/a.md`, root)).toBe(false)
  })

  it('still accepts an ordinary not-yet-created file in the drive root', (ctx) => {
    needDrive(ctx)
    const root = `${letter as string}:/`

    expect(isInsideRoot(`${root}not-created-yet.ts`, root)).toBe(true)
    expect(isInsideRoot(`${root}sub/deeper/not-created-yet.ts`, root)).toBe(true)
  })
})
