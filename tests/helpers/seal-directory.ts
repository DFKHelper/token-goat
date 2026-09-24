/** Make a directory that this process cannot look inside, so a test can exercise the difference between "gone" and "cannot tell". `fs.existsSync` answers false for both, which is the bug two guards here exist to hold shut, and the only honest way to test that is to actually take the permission away rather than stub a module. Sealing can fail -- an elevated or root runner ignores the restriction -- so `sealDirectory` reports whether it worked and callers skip rather than silently pass. `denyWrites` is the milder sibling: a directory this process can still read but not write, for the index a read-only sandbox leaves. It reports failure the same way. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Directories sealed in this process, against the POSIX mode each had beforehand. Unsealing restores that exact mode rather than a fixed 0o755, which would quietly widen a directory that started at 0o700. Windows has no equivalent here: `icacls /reset` puts the directory back on inherited permissions, which is right for the fresh temp directory a test created and wrong for anything with explicit ACLs of its own. Seal only directories the test made itself. */
const sealed = new Map<string, number | null>()

/** Take away this process's ability to enter `dir`. Returns false when the platform or the runner refused, in which case the caller must skip rather than assert. What becomes invisible is what is *inside* `dir`, not `dir` itself: its own entry still lives in its parent, which is still readable. So a test that needs a given path to look absent seals that path's parent, and checks the path itself before asserting anything. */
export function sealDirectory(dir: string): boolean {
  let previousMode: number | null = null
  try {
    if (process.platform === 'win32') {
      // Both steps, in this order: a deny ACE on its own leaves the inherited allow ACEs in place and the directory stays readable. Dropping inheritance and re-granting ourselves full control first makes the deny the only thing that decides. The account has to be domain-qualified -- a bare user name resolves to a different principal and the deny then applies to nobody -- so this reads USERDOMAIN/USERNAME rather than `whoami`, whose output depends on which shell spawned the test.
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

/** Directories write-protected by {@link denyWrites}, against the POSIX mode of the directory and of each file in it beforehand (null on Windows, where the deny ACEs are removed instead). */
const writeDenied = new Map<string, Map<string, number> | null>()

/** The account a Windows ACE must name: a bare user name resolves to a different principal, and the ACE then applies to nobody (see sealDirectory). */
function windowsAccount(): string {
  const domain = process.env.USERDOMAIN
  return `${domain ? `${domain}\\` : ''}${process.env.USERNAME ?? ''}`
}

/** Take away this process's ability to write `dir` or any file directly in it, while leaving all of it readable: an index under a read-only sandbox or a write-denied data directory. Returns false when the platform or the runner refused, or when a probe write still succeeded (a root or elevated runner ignores the restriction), and the caller must then skip rather than assert. Windows denies named rights only, never `W` or `D`. Measured on Windows 11 with icacls: `W` is generic write, which carries SYNCHRONIZE, and a deny of it made the file unopenable for reading as well; a deny of `D` alone made `fs.openSync(file, 'r')` fail with EPERM. Either would turn "cannot write" into "cannot read", which is a different test. */
export function denyWrites(dir: string): boolean {
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name))
  try {
    if (process.platform === 'win32') {
      writeDenied.set(dir, null)
      execFileSync('icacls', [dir, '/deny', `${windowsAccount()}:(WD,AD,WEA,WA,DC)`], { stdio: 'ignore' })
      for (const f of files) execFileSync('icacls', [f, '/deny', `${windowsAccount()}:(WD,AD,WEA,WA)`], { stdio: 'ignore' })
    } else {
      const modes = new Map<string, number>([[dir, fs.statSync(dir).mode & 0o777]])
      for (const f of files) modes.set(f, fs.statSync(f).mode & 0o777)
      writeDenied.set(dir, modes)
      for (const f of files) fs.chmodSync(f, 0o444)
      fs.chmodSync(dir, 0o555)
    }
  } catch {
    allowWrites(dir)
    return false
  }
  if (canStillWrite(dir, files)) {
    allowWrites(dir)
    return false
  }
  return true
}

/** True when a new file can still be created in `dir`, or an existing one opened for writing. */
function canStillWrite(dir: string, files: readonly string[]): boolean {
  const probe = path.join(dir, '.write-probe')
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    // Refused, as intended.
  }
  for (const f of files) {
    try {
      fs.closeSync(fs.openSync(f, 'r+'))
      return true
    } catch {
      // Refused, as intended.
    }
  }
  return false
}

/** Undo {@link denyWrites}, so the directory can be written and deleted again. Best effort. */
export function allowWrites(dir: string): void {
  const modes = writeDenied.get(dir)
  if (modes === undefined) return
  try {
    if (modes === null) {
      for (const e of fs.readdirSync(dir)) execFileSync('icacls', [path.join(dir, e), '/remove:d', windowsAccount()], { stdio: 'ignore' })
      execFileSync('icacls', [dir, '/remove:d', windowsAccount()], { stdio: 'ignore' })
    } else {
      fs.chmodSync(dir, modes.get(dir) ?? 0o755)
      for (const [f, mode] of modes) if (f !== dir && fs.existsSync(f)) fs.chmodSync(f, mode)
    }
    writeDenied.delete(dir)
  } catch {
    // A directory we could not restore only costs a leftover directory under the temp root.
  }
}

/** Unseal everything sealed in this process. */
export function unsealAll(): void {
  for (const dir of [...sealed.keys()]) unsealDirectory(dir)
}
