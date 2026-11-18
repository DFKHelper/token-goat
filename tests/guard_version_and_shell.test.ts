/** Claude Code hook shell and newer guards. Provenance: FORMAT-DERIVED, code.claude.com/docs/en/hooks. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { stringify } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installKimi } from '../src/bridges/kimi_install.js'
import { claudeFindsGitBash, claudeHookShell } from '../src/claude_hook_shell.js'
import { GUARD_VERSION, parseGuardedCommand } from '../src/hook_guard.js'
import { newerGuardInText, verifiedInstall } from '../src/hook_selftest.js'
import { installHooks, settingsPath, uninstallHooks } from '../src/install.js'
import { nativeBuildStamp, newerBuild } from '../src/native_build_stamp.js'
import { syncNativeCopy } from '../src/native_hook.js'
import { kimiConfigPath } from '../src/purge.js'
import { buildNative } from './helpers/native_bin.js'

const WIN = process.platform === 'win32'
const NEWER = `: tg-guard-v${String(GUARD_VERSION + 1)}; exit 0`

let root = ''
let written = ''
let stderr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-guard-version-')))
  written = ''
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written += String(chunk)
    return true
  })
})

afterEach(() => {
  stderr.mockRestore()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the shell Claude Code runs a hook in', () => {
  const git = (dir: string): void => {
    fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cmd', 'git.exe'), '')
    fs.writeFileSync(path.join(dir, 'bin', 'bash.exe'), '')
  }

  it('finds Git Bash by the named path, else beside git.exe on PATH, else not at all', () => {
    const named = path.join(root, 'bash.exe')
    fs.writeFileSync(named, '')
    expect(claudeFindsGitBash({ CLAUDE_CODE_GIT_BASH_PATH: named })).toBe(true)
    const lookalike = path.join(root, 'my-bash.exe')
    fs.writeFileSync(lookalike, '')
    expect(claudeFindsGitBash({ CLAUDE_CODE_GIT_BASH_PATH: lookalike, PATH: '' })).toBe(false)
    const gone = { CLAUDE_CODE_GIT_BASH_PATH: path.join(root, 'gone.exe'), PATH: path.join(root, 'cmd') }
    expect(claudeFindsGitBash(gone)).toBe(false)
    git(root)
    expect(claudeFindsGitBash({ PATH: path.join(root, 'cmd') })).toBe(true)
    const viaGit = { CLAUDE_CODE_GIT_BASH_PATH: lookalike, PATH: path.join(root, 'cmd') }
    expect(claudeFindsGitBash(viaGit)).toBe(true)
    expect(claudeFindsGitBash({ PATH: path.join(root, 'bin') })).toBe(false)
    expect(claudeFindsGitBash({ PATH: '' })).toBe(false)
  })

  it('registers sh with a bash shell field with Git Bash, PowerShell without, no field off Windows', () => {
    expect(claudeHookShell('win32', true)).toEqual({ guard: 'sh', field: 'bash' })
    expect(claudeHookShell('win32', false)).toEqual({ guard: 'powershell', field: 'powershell' })
    expect(claudeHookShell('linux', false)).toEqual({ guard: 'sh' })
    expect(claudeHookShell('darwin', true)).toEqual({ guard: 'sh' })
  })

  it.runIf(WIN).each([
    ['with Git Bash', 'bash.exe', 'sh', 'bash'],
    ['without Git Bash', 'no-such-bash.exe', 'powershell', 'powershell'],
  ])('writes each own entry %s in that shell, reads it back, removes it', (_name, bashPath, guard, field) => {
    const bash = path.join(root, bashPath)
    if (guard === 'sh') fs.writeFileSync(bash, '')
    // A rejected configured path falls back to git.exe on PATH, so the no-Git-Bash row hides the real PATH.
    else vi.stubEnv('PATH', path.join(root, 'empty'))
    vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', bash)
    installHooks('user', { dev: true })
    const first = fs.readFileSync(settingsPath('user'), 'utf8')
    type Entry = { command?: string; shell?: string }
    const parsedSettings = JSON.parse(first) as { hooks: Record<string, Array<{ hooks: Entry[] }>> }
    const entries = Object.values(parsedSettings.hooks).flatMap((g) => g.flatMap((x) => x.hooks))
    const own = entries.filter((h) => h.command !== undefined && parseGuardedCommand(h.command) !== undefined)
    expect(own.length).toBeGreaterThan(3)
    for (const h of own) {
      expect(h.shell).toBe(field)
      const guarded = parseGuardedCommand(h.command!)
      expect(guarded?.kind === 'v1' && (guarded as { shell: string }).shell).toBe(guard)
    }
    installHooks('user', { dev: true })
    expect(fs.readFileSync(settingsPath('user'), 'utf8')).toBe(first)
    expect(uninstallHooks('user')).toBe(true)
    // An uninstall that leaves the settings empty removes the file, so absent is as clean as no guard.
    const left = fs.existsSync(settingsPath('user')) ? fs.readFileSync(settingsPath('user'), 'utf8') : ''
    expect(left.includes('tg-guard')).toBe(false)
  })
})

describe('a guard newer than this build is left alone', () => {
  it('reads the newest guard version a text holds, only when it is newer', () => {
    expect(newerGuardInText(JSON.stringify({ command: NEWER }))).toBe(GUARD_VERSION + 1)
    const current = JSON.stringify({ command: `: tg-guard-v${String(GUARD_VERSION)}; exit 0` })
    expect(newerGuardInText(current)).toBeUndefined()
    expect(newerGuardInText('no guard here')).toBeUndefined()
  })

  it('keeps a file a newer build wrote byte for byte, and says so', () => {
    const file = path.join(root, 'config.toml')
    const before = `hooks = ['${NEWER}']\n`
    fs.writeFileSync(file, before)
    verifiedInstall([file], () => fs.writeFileSync(file, `hooks = ['${NEWER}', 'x']\n`))
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(written).toContain(`guard version ${String(GUARD_VERSION + 1)}`)
    expect(written).toContain('newer token-goat')
  })

  it('still lets a file without a newer guard change', () => {
    const file = path.join(root, 'config.toml')
    fs.writeFileSync(file, 'a = 1\n')
    verifiedInstall([file], () => fs.writeFileSync(file, 'a = 2\n'))
    expect(fs.readFileSync(file, 'utf8')).toBe('a = 2\n')
    expect(written).toBe('')
  })

  it('leaves the Kimi config a newer build wrote untouched when this one installs', () => {
    const file = kimiConfigPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const before = stringify({ hooks: [{ event: 'PreToolUse', command: NEWER }] })
    fs.writeFileSync(file, before)
    installKimi()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(written).toContain('newer token-goat')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('leaves a Claude hook event whose guard is newer exactly as it is, and installs the others', () => {
    const file = settingsPath('user')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const seeded = { hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: NEWER }] }] } }
    fs.writeFileSync(file, JSON.stringify(seeded, null, 2) + '\n')
    installHooks('user', { dev: true })
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown[]> }
    expect(after.hooks['PreToolUse']).toEqual(seeded.hooks.PreToolUse)
    expect(Object.keys(after.hooks).length).toBeGreaterThan(1)
    expect(written).toContain('hooks.PreToolUse')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

describe('the shared native client is never replaced by an older build', () => {
  const stamps = (map: Record<string, string | undefined>) =>
    (bin: string): string | undefined => map[path.basename(bin)]

  it('orders plain x.y.z builds numerically', () => {
    expect(newerBuild('2.10.0', '2.9.35')).toBe(true)
    expect(newerBuild('2.9.35', '2.10.0')).toBe(false)
    expect(newerBuild('2.9.35', '2.9.35')).toBe(false)
    expect(newerBuild('2.9.35-beta', '2.9.0')).toBe(false)
  })

  it('keeps a newer copy, replaces an older or unstamped one, and keeps a stamped over an unstamped', () => {
    const src = path.join(root, 'src.bin')
    const dest = path.join(root, 'native', 'dest.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(src, 'packaged')
    fs.writeFileSync(dest, 'installed')
    const older = stamps({ 'src.bin': '2.9.0', 'dest.bin': '2.10.0' })
    expect(syncNativeCopy(src, dest, { buildStamp: older })).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('installed')
    expect(written).toContain('kept the newer native hook client')
    expect(written).toContain('build 2.10.0')
    written = ''
    const newer = stamps({ 'src.bin': '2.10.0', 'dest.bin': '2.9.0' })
    expect(syncNativeCopy(src, dest, { buildStamp: newer })).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('packaged')
    fs.writeFileSync(dest, 'installed')
    expect(syncNativeCopy(src, dest, { buildStamp: stamps({ 'src.bin': '2.9.0' }) })).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('packaged')
    fs.writeFileSync(dest, 'installed')
    expect(syncNativeCopy(src, dest, { buildStamp: stamps({ 'dest.bin': '2.9.0' }) })).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('installed')
    expect(written).toContain('unstamped')
  })

  it.runIf(WIN || process.platform === 'linux')('reads the version stamped into the real client', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }
    expect(nativeBuildStamp(buildNative())).toBe(pkg.version)
  })

  it('reads no stamp from a file that is not a client', () => {
    const file = path.join(root, 'not-a-client.exe')
    fs.writeFileSync(file, 'x')
    expect(nativeBuildStamp(file)).toBeUndefined()
    expect(nativeBuildStamp(path.join(root, 'gone.exe'))).toBeUndefined()
  })
})
