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

import { dataDir, ensureDataDirPrivate, _resetDataDirCacheForTesting } from '../src/constants.js'
import { ensureDirSync } from '../src/util.js'

const POSIX = process.platform !== 'win32'
const ENV_KEYS = ['XDG_DATA_HOME', 'LOCALAPPDATA', 'HOME'] as const

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
    ensureDataDirPrivate()

    const parent = path.dirname(dataDir())
    expect(mode(dataDir())).toBe(0o700)
    expect(mode(parent) & 0o077).not.toBe(0)
    expect(mode(path.dirname(parent)) & 0o077).not.toBe(0)
  })

  it('is idempotent and does not throw on a second call', () => {
    ensureDataDirPrivate()

    expect(() => ensureDataDirPrivate()).not.toThrow()
    expect(fs.existsSync(dataDir())).toBe(true)
  })

  // An unwritable home must not take down every command: the caller's own mkdir runs next and
  // reports the real failure with its own context.
  it('swallows a failure to create the root', () => {
    process.env['XDG_DATA_HOME'] = path.join(root, 'a-file', 'share')
    process.env['LOCALAPPDATA'] = path.join(root, 'a-file', 'share')
    fs.writeFileSync(path.join(root, 'a-file'), 'not a directory')
    _resetDataDirCacheForTesting()

    expect(() => ensureDataDirPrivate()).not.toThrow()
  })
})
