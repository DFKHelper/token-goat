/**
 * On an UPGRADED install the storage root already exists, and three of the four subsystems that
 * write into it skip their `ensureDirSync` when it does.
 *
 * `tests/guards/storage_dirs_are_hardened.test.ts` decides whether a function is hardened by
 * matching `/\bensureDirSync\s*\(/` anywhere in its body. That regex cannot tell
 *
 *     ensureDirSync(dir)
 *
 * from
 *
 *     if (!fs.existsSync(dir)) ensureDirSync(dir)
 *
 * and four home-root writers are the second form: `snapshots.ts::writeSnapshotKind`,
 * `snapshots.ts::store`, `session_store.ts::saveSessionState`, `disk_cache.ts::storeBlob`. On a
 * fresh install the guarded call runs and the root is created 0700. On an upgraded install --
 * every install that has ever run before, which is the common case -- the directory already exists,
 * the guarded call is skipped, and the hardening reaches the root only because `atomicWriteCore`
 * (`src/util.ts`) calls `ensureDirSync` unconditionally on its way to the write. That is a
 * load-bearing fact about a helper three layers down, and until this file nothing asserted it: the
 * static guard is green either way, because it is reading for a call name it can see rather than
 * for a mode it can measure.
 *
 * So this is the behavioural half, and it is deliberately NOT a better regex. It pre-creates the
 * root world-readable exactly as an install predating the hardening left it, drives ONE real write
 * through each subsystem's public entry point in a FRESH PROCESS, and reads the mode back off the
 * disk. A future refactor that moves `ensureDirSync` out of `atomicWriteCore` -- entirely
 * reasonable-looking, since every caller "already calls it" -- turns this red and leaves the static
 * guard green.
 *
 * A fresh process per subsystem is required, not tidiness: both roots memoize their hardening
 * (`dataDirHardened`, `hardenedHomes` in `src/constants.ts`), so a root some earlier test in the
 * same vitest worker already hardened would make every assertion here pass without the subsystem
 * doing anything.
 *
 * POSIX-only for the mode assertion: Windows ignores these modes and inherits the parent ACL, so
 * `runIf(POSIX)` is the honest reporting rather than a weaker assertion that can pass anywhere. The
 * "the write actually happened" half runs everywhere, which is what keeps the POSIX half from
 * silently degrading into a check on a subsystem that has stopped writing at all.
 *
 * PROVENANCE: CAPTURE. Every expectation is a mode read back from a real directory after a real
 * write by the real subsystem; nothing here is transcribed from the implementation.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { tsxProcessArgs } from './helpers/tsx_process.js'

const POSIX = process.platform !== 'win32'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DRIVER = path.join(HERE, 'fixtures', 'storage_write_driver.ts')

/**
 * The subsystems, each named by the source site whose `ensureDirSync` is behind an `existsSync`
 * guard. Losing one of these silently is the failure this file exists to prevent, so the list is
 * asserted non-empty and each entry runs its own case rather than being folded into a loop with one
 * shared assertion.
 */
const SUBSYSTEMS = [
  { arg: 'snapshots', site: 'src/snapshots.ts::store (and writeSnapshotKind, which uses a bare fs.writeFileSync)' },
  { arg: 'session', site: 'src/session_store.ts::saveSessionState' },
  { arg: 'cache', site: 'src/disk_cache.ts::storeBlob' },
] as const

const scratches: string[] = []
afterEach(() => {
  while (scratches.length > 0) {
    try {
      fs.rmSync(scratches.pop() as string, { recursive: true, force: true })
    } catch {
      // Best effort; the OS temp root is swept independently.
    }
  }
})

interface DriveResult {
  readonly home: string
  readonly written: string
  readonly stdout: string
}

/** Pre-create the home root 0755 as a pre-hardening install left it, then drive one real write. */
function driveOneWrite(arg: string): DriveResult {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-upgrade-'))
  scratches.push(base)
  const home = path.join(base, '.token-goat')
  fs.mkdirSync(home, { recursive: true })
  fs.chmodSync(home, 0o755)

  const stdout = execFileSync(process.execPath, tsxProcessArgs(DRIVER, arg), {
    // The repo root, not the scratch: `--import tsx` resolves `tsx` from the child's cwd, and a
    // scratch directory under the OS temp root has no node_modules above it.
    cwd: path.join(HERE, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_GOAT_HOME: home,
      // The data root must not collide with the home root, and must not be a real one either.
      XDG_DATA_HOME: path.join(base, 'share'),
      LOCALAPPDATA: path.join(base, 'share'),
      HOME: base,
      USERPROFILE: base,
    },
  })

  const m = /^OK (.+)$/m.exec(stdout)
  expect(m, `${arg}: the driver did not report a written file. Its output was: ${stdout.trim()}`).not.toBeNull()
  return { home, written: (m as RegExpExecArray)[1] as string, stdout }
}

describe('an already-existing storage root is re-hardened by a real write', () => {
  it('names at least one subsystem, so the cases below are not a vacuous population', () => {
    expect(SUBSYSTEMS.length).toBeGreaterThan(0)
  })

  for (const s of SUBSYSTEMS) {
    it(`writes through ${s.site}`, () => {
      const r = driveOneWrite(s.arg)

      // Runs on every platform. Without it the POSIX case below could pass on a subsystem that
      // silently stopped writing anything at all: a directory nobody touched keeps whatever mode
      // it had, and 0700 would then be asserted of a fixture rather than of a behaviour -- except
      // the fixture is 0755, so this pairing is what makes the mode meaningful.
      expect(fs.existsSync(r.written), `${s.arg}: the driver reported ${r.written} but it is not on disk`).toBe(true)
      expect(path.resolve(r.written).startsWith(path.resolve(r.home)), `${s.arg}: wrote outside the storage root`).toBe(true)
    })

    it.runIf(POSIX)(`tightens the pre-existing 0755 root while writing through ${s.site}`, () => {
      const r = driveOneWrite(s.arg)

      expect(
        fs.statSync(r.home).mode & 0o777,
        `${s.arg}: the storage root was left world-readable after a real write. On a shared host every ` +
          'other local user can then list the session snapshots, cached pages and index databases inside ' +
          `it. The write reached ${r.written} without passing through ensureDirSync -- check whether ` +
          "atomicWriteCore still calls it unconditionally, since that is the only thing making this pass " +
          `for a subsystem whose own ensureDirSync sits behind an existsSync guard (${s.site}).`,
      ).toBe(0o700)
    })
  }
})
