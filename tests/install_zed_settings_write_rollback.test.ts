import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Util from '../src/util.js'

// A real failed write: settings.json read-only, or held open by Zed on Windows (EPERM/EBUSY from the rename). Simulated through the util re-export the bridge imports, because neither condition can be made to fail the same way on all three CI platforms.
const failWrite = vi.hoisted(() => ({ on: false, unreadable: '', restore: false }))
// A shim that exists but cannot be read (EACCES): a mode bit on POSIX, an ACL on Windows, so the read failure is injected for the one path rather than set up per platform.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>()
  const readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (failWrite.unreadable !== '' && p === failWrite.unreadable) throw Object.assign(new Error(`EACCES: permission denied, open '${String(p)}'`), { code: 'EACCES' })
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof real.readFileSync
  return { ...real, readFileSync, default: { ...real, readFileSync } }
})
vi.mock('../src/util.js', async (importOriginal) => {
  const real = await importOriginal<typeof Util>()
  return {
    ...real,
    writeConfigText: (p: string, next: string): void => {
      if (failWrite.on && p.endsWith('settings.json')) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${p}'`), { code: 'EPERM' })
      real.writeConfigText(p, next)
    },
    atomicWriteBytes: (p: string, bytes: Buffer | Uint8Array): void => {
      if (failWrite.restore) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${p}'`), { code: 'EBUSY' })
      real.atomicWriteBytes(p, bytes)
    },
  }
})

const { installZed, zedSettingsPath, zedShimPath } = await import('../src/bridges/zed_install.js')

const saved = { APPDATA: process.env['APPDATA'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }
let userDir: string

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-zed-rollback-'))
  for (const k of Object.keys(saved)) process.env[k] = userDir
  failWrite.on = false
  failWrite.unreadable = ''
  failWrite.restore = false
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(userDir, { recursive: true, force: true })
})

describe('Zed install when the settings.json write fails', () => {
  it('removes a shim it had just created', () => {
    // HAND-DERIVED: the shim is only reachable through the context_servers entry, so with that write failed nothing would ever launch it.
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ "theme": "One" }\n')
    failWrite.on = true
    expect(() => installZed()).toThrow(/EPERM/)
    expect(fs.existsSync(zedShimPath())).toBe(false)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ "theme": "One" }\n')
  })

  it('puts back the shim an earlier install wrote', () => {
    // HAND-DERIVED: a re-install that rewrites a stale shim and then fails must leave the shim the still-current settings.json was written against.
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{}\n')
    fs.writeFileSync(zedShimPath(), 'stale shim from an older token-goat\n')
    failWrite.on = true
    expect(() => installZed()).toThrow(/EPERM/)
    expect(fs.readFileSync(zedShimPath(), 'utf8')).toBe('stale shim from an older token-goat\n')
  })

  it('keeps a shim it could not read rather than delete it', () => {
    // HAND-DERIVED: only ENOENT means no shim existed; a file the install could not read is still there and still the user's.
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{}\n')
    fs.writeFileSync(zedShimPath(), 'shim the user locked down\n')
    failWrite.unreadable = zedShimPath()
    failWrite.on = true
    expect(() => installZed()).toThrow(/EPERM/)
    expect(fs.existsSync(zedShimPath())).toBe(true)
  })

  it('reports the settings.json failure when putting the shim back fails too', () => {
    // HAND-DERIVED: the settings.json write is what the user has to fix, so a second failure in the rollback must not replace its message.
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{}\n')
    fs.writeFileSync(zedShimPath(), 'stale shim\n')
    failWrite.on = true
    failWrite.restore = true
    expect(() => installZed()).toThrow(/EPERM/)
  })

  it('puts back non-UTF-8 bytes exactly', () => {
    // HAND-DERIVED: a hand-edited shim with a Latin-1 byte would come back as U+FFFD if the snapshot were read as text.
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{}\n')
    const latin1 = Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a])
    fs.writeFileSync(zedShimPath(), latin1)
    failWrite.on = true
    expect(() => installZed()).toThrow(/EPERM/)
    expect(fs.readFileSync(zedShimPath()).equals(latin1)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('puts back the shim mode when only the mode changed', () => {
    // HAND-DERIVED: the install chmods the shim to 0755 even when its content is already current, so a failed write must undo the chmod too (POSIX only: Windows has no mode bits to restore).
    installZed()
    const shim = zedShimPath()
    fs.chmodSync(shim, 0o644)
    fs.writeFileSync(zedSettingsPath(), '{}\n')
    failWrite.on = true
    expect(() => installZed()).toThrow(/EPERM/)
    expect(fs.statSync(shim).mode & 0o777).toBe(0o644)
  })

  it.skipIf(process.platform === 'win32')('puts back the mode of a stale shim it rewrote', () => {
    // HAND-DERIVED: the atomic rewrite replaces the file, so the restored bytes need their original mode put back as well.
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{}\n')
    fs.writeFileSync(zedShimPath(), 'stale shim\n', { mode: 0o600 })
    fs.chmodSync(zedShimPath(), 0o600)
    failWrite.on = true
    expect(() => installZed()).toThrow(/EPERM/)
    expect(fs.readFileSync(zedShimPath(), 'utf8')).toBe('stale shim\n')
    expect(fs.statSync(zedShimPath()).mode & 0o777).toBe(0o600)
  })

  it('still installs both files when the write succeeds', () => {
    // HAND-DERIVED: control for the two cases above, so a rollback that fired unconditionally would fail here.
    installZed()
    expect(fs.existsSync(zedShimPath())).toBe(true)
    expect(fs.readFileSync(zedSettingsPath(), 'utf8')).toContain('token-goat')
  })
})
