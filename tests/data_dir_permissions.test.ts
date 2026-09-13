/**
 * Security regression: the data root was created by a plain recursive mkdir with no mode, so it
 * took the process umask -- mode 755 on a stock Linux box. Everything token-goat caches lives
 * under it (bash output, fetched pages, MCP results, session state, and the SQLite index of the
 * project's source), so on a shared host every other local user could list and read another
 * user's cached work. Confirmed live on Linux before the fix: `~/.local/share/token-goat` was 755.
 *
 * The root is now created 0700 and an existing permissive root is chmodded down, so traversal is
 * refused for everyone but the owner and a child's own mode stops mattering. POSIX-only: Windows
 * ignores these modes and inherits the parent ACL instead.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dataDir, ensureDataDirPrivate, ensureHomeDirPrivate, tokenGoatHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { ensureDirSync } from '../src/util.js'

const POSIX = process.platform !== 'win32'
const ENV_KEYS = ['XDG_DATA_HOME', 'LOCALAPPDATA', 'HOME', 'TOKEN_GOAT_HOME'] as const

let saved: Record<string, string | undefined>
let root: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-perm-'))
  process.env['XDG_DATA_HOME'] = path.join(root, 'share')
  process.env['LOCALAPPDATA'] = path.join(root, 'share')
  process.env['HOME'] = root
  _resetDataDirCacheForTesting()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(root, { recursive: true, force: true })
})

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

describe('data directory permissions', () => {
  it.runIf(POSIX)('creates the data root owner-only', () => {
    ensureDataDirPrivate()

    expect(mode(dataDir())).toBe(0o700)
  })

  it.runIf(POSIX)('tightens an existing world-readable root', () => {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o755 })
    fs.chmodSync(dataDir(), 0o755)
    expect(mode(dataDir())).toBe(0o755)

    _resetDataDirCacheForTesting()
    ensureDataDirPrivate()

    expect(mode(dataDir())).toBe(0o700)
  })

  // The point of hardening the root rather than each child: a child created with a permissive
  // mode is still unreachable, because traversal stops at the parent.
  it.runIf(POSIX)('creates the root privately even when a child is made first', () => {
    ensureDirSync(path.join(dataDir(), 'cache', 'web'))

    expect(mode(dataDir())).toBe(0o700)
  })

  // `mkdirSync(recursive, { mode })` applies the mode to every level it creates, so a single
  // recursive call tightened the shared XDG parents (~/.local, ~/.local/share) as collateral.
  // Those belong to the user and to every other application, not to token-goat.
  it.runIf(POSIX)('leaves the shared parent directories at the umask default', () => {
    // The reference directory is made by a plain mkdir in this same process, so it carries
    // whatever umask the runner has. Comparing against it, rather than against a hardcoded 0755,
    // keeps the assertion honest under any umask -- an earlier version asserted the group/other
    // bits were set and failed on CI, where the enclosing mkdtemp root is 0700 by definition.
    const reference = path.join(root, 'reference')
    fs.mkdirSync(reference)
    const rootModeBefore = mode(root)

    ensureDataDirPrivate()

    const parent = path.dirname(dataDir())
    expect(mode(dataDir())).toBe(0o700)
    expect(mode(parent)).toBe(mode(reference))
    expect(mode(root)).toBe(rootModeBefore)
  })

  it('is idempotent and does not throw on a second call', () => {
    ensureDataDirPrivate()

    expect(() => ensureDataDirPrivate()).not.toThrow()
    expect(fs.existsSync(dataDir())).toBe(true)
  })

  // An unwritable home must not take down every command: the caller's own mkdir runs next and
  // reports the real failure with its own context.
  it('hardens the data root only for a path that is actually under it', () => {
    // The dispatch half. Hardening a root nothing is being written under would create it as a side
    // effect of an unrelated mkdir; the point of dispatching on the requested path is that each
    // root is created when, and only when, something is about to land in it.
    const elsewhere = path.join(root, 'not-storage', 'x')

    ensureDirSync(elsewhere)

    expect(fs.existsSync(elsewhere)).toBe(true)
    expect(fs.existsSync(dataDir())).toBe(false)
  })

  it('swallows a failure to create the root', () => {
    process.env['XDG_DATA_HOME'] = path.join(root, 'a-file', 'share')
    process.env['LOCALAPPDATA'] = path.join(root, 'a-file', 'share')
    fs.writeFileSync(path.join(root, 'a-file'), 'not a directory')
    _resetDataDirCacheForTesting()

    expect(() => ensureDataDirPrivate()).not.toThrow()
  })
})

/**
 * The OTHER storage root. `ensureDirSync` hardened `dataDir()` and nothing else, while
 * `dataDir() !== tokenGoatHome()` at runtime -- so `~/.token-goat` took the umask default (0755 on
 * a stock Debian/Ubuntu $HOME) even though the guard that swept this class lists `tokenGoatHome`
 * among its roots and names a home-root site in its own mustInclude. What sits there is the more
 * sensitive half: `session_snapshots/` holds verbatim copies of every file the model read,
 * `sessions/` the session state and its pending-context sidecars, `ocr-cache/` text lifted out of
 * viewed images. Local read disclosure only -- no write access and no escalation -- and Windows is
 * unaffected, which is why these mode assertions are honestly `runIf(POSIX)` rather than reworked
 * into something that can pass here.
 */
describe('token-goat home permissions', () => {
  let home: string

  beforeEach(() => {
    home = path.join(root, 'home', '.token-goat')
    process.env['TOKEN_GOAT_HOME'] = home
    _resetDataDirCacheForTesting()
  })

  // The premise the static guard assumed and never checked. If these two ever became the same
  // directory, every assertion below would be about the data root wearing another name.
  it('is a different directory from the data root', () => {
    expect(path.resolve(tokenGoatHome())).not.toBe(path.resolve(dataDir()))
  })

  it.runIf(POSIX)('creates the home root owner-only', () => {
    ensureHomeDirPrivate()

    expect(mode(home)).toBe(0o700)
  })

  it.runIf(POSIX)('tightens an existing world-readable home root', () => {
    fs.mkdirSync(home, { recursive: true })
    fs.chmodSync(home, 0o755)
    _resetDataDirCacheForTesting()

    ensureHomeDirPrivate()

    expect(mode(home)).toBe(0o700)
  })

  // The whole point: every real home-root writer reaches the filesystem through ensureDirSync, so
  // that is where the hardening has to happen. `session_snapshots` is the worst-case child.
  it.runIf(POSIX)('hardens the home root when ensureDirSync creates a child under it', () => {
    ensureDirSync(path.join(tokenGoatHome(), 'session_snapshots', 'sess-1'))

    expect(mode(home)).toBe(0o700)
    expect(fs.existsSync(path.join(home, 'session_snapshots', 'sess-1'))).toBe(true)
  })

  it.runIf(POSIX)('leaves the enclosing $HOME at the umask default', () => {
    // Same collateral-damage rule as the data root: `~` belongs to the user, not to token-goat.
    const reference = path.join(root, 'home-reference')
    fs.mkdirSync(reference, { recursive: true })

    ensureHomeDirPrivate()

    expect(mode(path.dirname(home))).toBe(mode(reference))
  })

  it('re-hardens after TOKEN_GOAT_HOME moves, rather than memoizing one boolean', () => {
    // TOKEN_GOAT_HOME is read live on every call, so a single "already done" flag would leave every
    // root after the first at the umask default -- and the e2e children and the test suite itself
    // move it constantly.
    ensureHomeDirPrivate()
    const second = path.join(root, 'home2', '.token-goat')
    process.env['TOKEN_GOAT_HOME'] = second

    ensureHomeDirPrivate()

    expect(fs.existsSync(second)).toBe(true)
    if (POSIX) expect(mode(second)).toBe(0o700)
  })

  it('does not throw when the home root cannot be created', () => {
    process.env['TOKEN_GOAT_HOME'] = path.join(root, 'a-home-file', 'x')
    fs.writeFileSync(path.join(root, 'a-home-file'), 'not a directory')
    _resetDataDirCacheForTesting()

    expect(() => ensureHomeDirPrivate()).not.toThrow()
  })
})
