/**
 * Make a directory that this process cannot look inside, so a test can exercise the difference
 * between "gone" and "cannot tell".
 *
 * `fs.existsSync` answers false for both, which is the bug two guards here exist to hold shut, and
 * the only honest way to test that is to actually take the permission away rather than stub a
 * module. Sealing can fail -- an elevated or root runner ignores the restriction -- so `sealDirectory`
 * reports whether it worked and callers skip rather than silently pass.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'

/**
 * Directories sealed in this process, against the POSIX mode each had beforehand.
 *
 * Unsealing restores that exact mode rather than a fixed 0o755, which would quietly widen a
 * directory that started at 0o700. Windows has no equivalent here: `icacls /reset` puts the
 * directory back on inherited permissions, which is right for the fresh temp directory a test
 * created and wrong for anything with explicit ACLs of its own. Seal only directories the test
 * made itself.
 */
const sealed = new Map<string, number | null>()

/**
 * Take away this process's ability to enter `dir`. Returns false when the platform or the runner
 * refused, in which case the caller must skip rather than assert.
 *
 * What becomes invisible is what is *inside* `dir`, not `dir` itself: its own entry still lives in
 * its parent, which is still readable. So a test that needs a given path to look absent seals that
 * path's parent, and checks the path itself before asserting anything.
 */
export function sealDirectory(dir: string): boolean {
  let previousMode: number | null = null
  try {
    if (process.platform === 'win32') {
      // Both steps, in this order: a deny ACE on its own leaves the inherited allow ACEs in place
      // and the directory stays readable. Dropping inheritance and re-granting ourselves full
      // control first makes the deny the only thing that decides. The account has to be
      // domain-qualified -- a bare user name resolves to a different principal and the deny then
      // applies to nobody -- so this reads USERDOMAIN/USERNAME rather than `whoami`, whose output
      // depends on which shell spawned the test.
      const domain = process.env.USERDOMAIN
      const user = `${domain ? `${domain}\\` : ''}${process.env.USERNAME ?? ''}`
      execFileSync('icacls', [dir, '/inheritance:r', '/grant', `${user}:(F)`], { stdio: 'ignore' })
      execFileSync('icacls', [dir, '/deny', `${user}:(RX,RD,S)`], { stdio: 'ignore' })
    } else {
      previousMode = fs.statSync(dir).mode & 0o777
      fs.chmodSync(dir, 0o000)
    }
  } catch {
    return false
  }
  sealed.set(dir, previousMode)
  return true
}

/** Give the permission back, so the temp tree can be deleted. Best effort. */
export function unsealDirectory(dir: string): void {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [dir, '/reset'], { stdio: 'ignore' })
    else fs.chmodSync(dir, sealed.get(dir) ?? 0o755)
    sealed.delete(dir)
  } catch {
    // A directory we could not unseal only costs a leftover directory under the temp root.
  }
}

/** Unseal everything sealed in this process. */
export function unsealAll(): void {
  for (const dir of [...sealed.keys()]) unsealDirectory(dir)
}
