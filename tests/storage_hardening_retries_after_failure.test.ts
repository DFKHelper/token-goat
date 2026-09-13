/**
 * A storage root that failed to harden once must be retried, not remembered as done.
 *
 * `ensureDataDirPrivate` set `dataDirHardened = true` BEFORE its try block, and
 * `ensureHomeDirPrivate` did `hardenedHomes.add(home)` before its own -- with an empty catch below.
 * So a single transient failure (EACCES while a backup tool held the directory, EBUSY, ENOSPC, an
 * NFS hiccup, a parent that is momentarily a file) marked the root hardened for the REST OF THE
 * PROCESS. In the CLI that is one command; in the long-lived worker it is the whole session, and
 * every write after it lands in a directory left at the umask default with nothing ever retrying.
 * The catch is deliberately empty -- an unwritable home must not break every command -- which is
 * exactly why the memo has to be inside it: there is no other signal that the work did not happen.
 *
 * The fix is one line moved in each function, and this file is the test that distinguishes the two
 * placements. Nothing else could: with the memo set early, every existing assertion in
 * `tests/data_dir_permissions.test.ts` still passes, because each of them calls into a fresh state
 * where the FIRST call succeeds.
 *
 * Also covers `tokenGoatHome()` routing `TOKEN_GOAT_HOME` through `safeEnvDir` (SA-4): its siblings
 * `LOCALAPPDATA`/`XDG_DATA_HOME` already went through that validator in `defaultDataDir()`, while
 * this one had a bare empty-string check and returned a RELATIVE value verbatim. Since
 * `ensureDirSync` dispatches hardening on `isUnderRoot(dir, tokenGoatHome())`, a relative root
 * quietly turned the 0700 hardening off for a storage tree resolved against the cwd -- and a VS
 * Code hook's cwd is the workspace folder, so session snapshots of every file the model read would
 * have landed inside an untrusted clone at the umask default.
 *
 * PROVENANCE: CAPTURE. Every assertion reads the real filesystem after a real call; the transient
 * failure is a real one (a regular file where a directory has to go), not a mocked throw.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  _resetDataDirCacheForTesting,
  dataDir,
  ensureDataDirPrivate,
  ensureHomeDirPrivate,
  tokenGoatHome,
} from '../src/constants.js'

const POSIX = process.platform !== 'win32'
const ENV_KEYS = ['XDG_DATA_HOME', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'TOKEN_GOAT_HOME'] as const

let saved: Record<string, string | undefined>
let base: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reharden-')))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('a failed hardening attempt is retried on the next call', () => {
  it('creates the data root on the second call after the first one could not', () => {
    // A regular file where the parent directory has to go: mkdirSync throws ENOTDIR/EEXIST, the
    // empty catch swallows it, and the question is whether the memo was set anyway.
    const blocker = path.join(base, 'blocker')
    fs.writeFileSync(blocker, 'a file, not a directory\n')
    process.env['XDG_DATA_HOME'] = path.join(blocker, 'share')
    process.env['LOCALAPPDATA'] = path.join(blocker, 'share')
    process.env['HOME'] = base
    _resetDataDirCacheForTesting()
    const root = dataDir()

    expect(() => ensureDataDirPrivate()).not.toThrow()
    expect(fs.existsSync(root), 'the first attempt was supposed to fail; if it did not, this test proves nothing').toBe(false)

    // The transient condition clears. NO cache reset here, deliberately: resetting would clear the
    // memo and hide the whole defect. This is the same process, later.
    fs.rmSync(blocker)

    ensureDataDirPrivate()

    expect(
      fs.existsSync(root),
      'the data root was never created. The first (failed) attempt memoized itself as done, so every ' +
        'later call in this process returned early -- which in the worker means the rest of the session.',
    ).toBe(true)
    if (POSIX) expect(fs.statSync(root).mode & 0o777).toBe(0o700)
  })

  it('creates the home root on the second call after the first one could not', () => {
    const blocker = path.join(base, 'home-blocker')
    fs.writeFileSync(blocker, 'a file, not a directory\n')
    const home = path.join(blocker, 'nested', '.token-goat')
    process.env['TOKEN_GOAT_HOME'] = home
    _resetDataDirCacheForTesting()

    expect(() => ensureHomeDirPrivate()).not.toThrow()
    expect(fs.existsSync(home), 'the first attempt was supposed to fail; if it did not, this test proves nothing').toBe(false)

    fs.rmSync(blocker)

    ensureHomeDirPrivate()

    expect(
      fs.existsSync(home),
      'the home root was never created. `hardenedHomes.add(home)` ran before the try, so the failed ' +
        'attempt banked itself as a success and the root stayed at the umask default -- and this is the ' +
        'root holding session_snapshots, verbatim copies of every file the model read.',
    ).toBe(true)
    if (POSIX) expect(fs.statSync(home).mode & 0o777).toBe(0o700)
  })
})

describe('TOKEN_GOAT_HOME goes through the same validator as its siblings', () => {
  it('ignores a RELATIVE value and falls back to the default root', () => {
    process.env['HOME'] = base
    process.env['USERPROFILE'] = base
    process.env['TOKEN_GOAT_HOME'] = path.join('some', 'relative', 'dir')
    _resetDataDirCacheForTesting()

    const home = tokenGoatHome()

    expect(path.isAbsolute(home), `tokenGoatHome() returned ${home}, which is relative. ensureDirSync dispatches its 0700 hardening on isUnderRoot(dir, tokenGoatHome()), so a relative root turns the hardening off for a storage tree resolved against whatever the cwd happens to be -- the workspace folder, inside a VS Code hook.`).toBe(true)
    expect(home).toBe(path.join(os.homedir(), '.token-goat'))
  })

  it('ignores an empty value and falls back to the default root', () => {
    process.env['HOME'] = base
    process.env['USERPROFILE'] = base
    process.env['TOKEN_GOAT_HOME'] = '   '
    _resetDataDirCacheForTesting()

    expect(tokenGoatHome()).toBe(path.join(os.homedir(), '.token-goat'))
  })

  it('still honours an ABSOLUTE value, so the validator has not simply disabled the override', () => {
    // The in-band control. Without it the two refusals above would also pass against a
    // `tokenGoatHome()` that ignored the variable entirely -- and the whole test suite relies on
    // this override to stay out of the real `~/.token-goat`.
    const custom = path.join(base, 'custom-home')
    process.env['TOKEN_GOAT_HOME'] = custom
    _resetDataDirCacheForTesting()

    expect(tokenGoatHome()).toBe(path.resolve(custom))
  })
})
