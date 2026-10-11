/** Provenance: the reg results are a CAPTURE on this Windows 11 machine with the English display language: a missing key, and a missing value under an existing key, both exit 1 with `ERROR: The system was unable to find the specified registry key or value.`; a key whose ACL denies read exits 1 with `ERROR: Access is denied.`. The `Settings    REG_SZ    <json>` listing is FORMAT-DERIVED from the same capture. The forged files are HAND-DERIVED from the attack the security audit described: a record a hook leaves in a file the same user can write is a record the agent can write, so no on-disk copy of registry policy may add or remove a rule. The Spanish message is HAND-DERIVED (any text that differs from the denied one) and stands for a non-English display language. The U+FFFD output is HAND-DERIVED from the way node decodes a byte reg printed in the OEM code page as UTF-8. The scripted reg replaces spawnSync for the absolute reg.exe path only; nothing else is mocked. */
import type * as ChildProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Answer = { code?: number | null; out?: string; err?: string }
const NOT_FOUND = 'ERROR: The system was unable to find the specified registry key or value.\r\n'
const DENIED = 'ERROR: Access is denied.\r\n'
const denyJson = JSON.stringify({ permissions: { deny: ['Read(./secret/**)'] } })
const settingsOut = (json: string): string => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_SZ    ${json}\r\n\r\n`
const K_L = 'HKLM\\SOFTWARE\\Policies\\ClaudeCode'
const K_C = 'HKCU\\SOFTWARE\\Policies\\ClaudeCode'
const SENTINEL = 'HKLM\\SOFTWARE\\TokenGoatNoSuchKey'
const absent: Answer = { code: 1, err: NOT_FOUND }
const timedOut: Answer = { code: null }
const ES = 'ERROR: El sistema no pudo encontrar la clave o el valor del Registro especificado.\r\n'

const reg = vi.hoisted(() => ({ calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown>; async?: true }[], answers: {} as Record<string, Answer> }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawnSync: (cmd: string, args: readonly string[], ...rest: unknown[]) => {
      if (!/reg\.exe$/i.test(cmd)) return (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, args, ...rest)
      reg.calls.push({ cmd, args: [...args], opts: (rest[0] ?? {}) as Record<string, unknown> })
      const a = reg.answers[args[1] as string] ?? { code: 1, err: '' }
      return a.code === null ? { status: null, error: new Error('spawnSync reg.exe ETIMEDOUT'), stdout: '', stderr: '' } : { status: a.code ?? 0, stdout: a.out ?? '', stderr: a.err ?? '' }
    },
    // FORMAT-DERIVED from https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback: a non-zero exit gives an error whose `code` is the exit code, a timeout kills the child and gives `killed` true with a null `code`; the callback always runs on a later tick.
    execFile: (cmd: string, args: readonly string[], opts: unknown, cb: (err: (Error & { code?: number | null; killed?: boolean }) | null, stdout: string, stderr: string) => void) => {
      if (!/reg\.exe$/i.test(cmd)) return (actual.execFile as (...a: unknown[]) => unknown)(cmd, args, opts, cb)
      reg.calls.push({ cmd, args: [...args], opts: (opts ?? {}) as Record<string, unknown>, async: true })
      const a = reg.answers[args[1] as string] ?? { code: 1, err: '' }
      const code = a.code === undefined ? 0 : a.code
      const err = code === 0 ? null : code === null ? Object.assign(new Error('reg.exe timed out'), { code: null, killed: true }) : Object.assign(new Error('Command failed'), { code, killed: false })
      setImmediate(() => cb(err, a.out ?? '', a.err ?? ''))
      return undefined
    },
  }
})

import { loadHiddenRuleCheck, loadPermissionSnapshot, permissionNeutralRewrite, primeManagedPolicyAhead, readHintCrossesRule, resetPermissionSourceCache, type RewriteRequest } from '../src/rewrite_permission.js'

const FILTER = Symbol.for('token-goat.permission-source-filter')
const slot = globalThis as unknown as Record<symbol, unknown>

let root: string
let home: string
let winRoot: string
const savedWindir = process.env['windir']
const savedHome = process.env['TOKEN_GOAT_HOME']
const savedRoot = process.env['SystemRoot']
const savedFilter = slot[FILTER]
const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
const secret = (): string[] => [path.join(root, 'secret', 'a.txt')]
const open = (): string[] => [path.join(root, 'open', 'a.txt')]
const keysAsked = (): string[] => reg.calls.map((c) => c.args[1] as string)
const live = (answers: Record<string, Answer>): void => {
  reg.answers = { [K_L]: { out: settingsOut(denyJson) }, [K_C]: absent, [SENTINEL]: absent, ...answers }
  reg.calls.length = 0
  resetPermissionSourceCache()
}
const held = (): boolean => readHintCrossesRule('claudecode', root, open())
const asyncKeys = (): string[] => reg.calls.filter((c) => c.async === true).map((c) => c.args[1] as string)
const syncCalls = (): number => reg.calls.filter((c) => c.async !== true).length
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-regpolicy-'))
  home = path.join(root, 'tg')
  fs.mkdirSync(home, { recursive: true })
  process.env['TOKEN_GOAT_HOME'] = home
  // A throwaway Windows folder holding a reg.exe, as the registry read only spawns a reg.exe the validated folder holds.
  winRoot = path.join(root, 'win')
  fs.mkdirSync(path.join(winRoot, 'System32'), { recursive: true })
  fs.writeFileSync(path.join(winRoot, 'System32', 'reg.exe'), '')
  process.env['SystemRoot'] = winRoot
  // Let the registry sources through and keep every other source hidden, so the machine's own settings do not leak in.
  slot[FILTER] = (source: string): boolean => source.startsWith('registry:')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  live({})
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  slot[FILTER] = savedFilter
  if (savedHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = savedHome
  if (savedRoot === undefined) delete process.env['SystemRoot']
  else process.env['SystemRoot'] = savedRoot
  if (savedWindir === undefined) delete process.env['windir']
  else process.env['windir'] = savedWindir
  resetPermissionSourceCache()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the Windows registry policy is always read live', () => {
  it('queries HKLM then HKCU by absolute reg path with the 5 s wait, and applies the deny it finds', () => {
    expect(readHintCrossesRule('claudecode', root, secret())).toBe(true)
    expect(readHintCrossesRule('claudecode', root, open())).toBe(false)
    expect(keysAsked().slice(0, 2)).toEqual([K_L, K_C])
    for (const c of reg.calls) {
      expect(c.cmd, 'reg must be run by absolute path so a PATH entry cannot stand in for it').toBe(path.join(winRoot, 'System32', 'reg.exe'))
      expect(c.opts['timeout'], 'the wait must stay 5 s').toBe(5000)
    }
  })

  // HAND-DERIVED from the attack the security review described: a standing deny-read ACL on a sentinel key the user can create makes it answer "Access is denied", the same text a denied policy key gives. Only a key the user cannot create can be the baseline, so the sentinel is under HKLM and never HKCU.
  it('asks for the absent baseline under HKLM, a key a user cannot create, never under HKCU', () => {
    live({ [K_L]: { code: 1, err: ES }, [K_C]: { code: 1, err: ES }, [SENTINEL]: { code: 1, err: ES } })
    loadPermissionSnapshot(root)
    expect(keysAsked().filter((k) => /NoSuchKey/.test(k))).toEqual(['HKLM\\SOFTWARE\\TokenGoatNoSuchKey'])
  })

  // HAND-DERIVED: SystemRoot and windir are environment values any parent can set; a relative one would make the spawn resolve against the working directory.
  it('runs reg from windir when SystemRoot is relative, and from an absolute path even when no folder holds it', () => {
    process.env['SystemRoot'] = '.'
    process.env['windir'] = winRoot
    live({})
    held()
    expect(reg.calls.length).toBeGreaterThan(0)
    for (const c of reg.calls) expect(c.cmd).toBe(path.join(winRoot, 'System32', 'reg.exe'))
    process.env['SystemRoot'] = '.'
    process.env['windir'] = ''
    live({})
    held()
    expect(reg.calls.length).toBeGreaterThan(0)
    for (const c of reg.calls) expect(path.win32.isAbsolute(c.cmd), 'a relative or bare reg is resolved by the working directory or PATH').toBe(true)
  })

  it('never asks the sentinel when no key exited 1, or when reg gave the English not-found message', () => {
    live({ [K_L]: { out: settingsOut('{}') }, [K_C]: { out: settingsOut('{}') } })
    loadPermissionSnapshot(root)
    expect(keysAsked()).toEqual([K_L, K_C])
    live({ [K_L]: absent, [K_C]: absent, [SENTINEL]: timedOut })
    expect(held(), 'the English message is absent without asking the sentinel').toBe(false)
    expect(keysAsked()).toEqual([K_L, K_C])
  })

  it('asks the sentinel once, and only when an exit-1 message is not the English one', () => {
    live({ [K_L]: { code: 1, err: ES }, [K_C]: { code: 1, err: ES }, [SENTINEL]: { code: 1, err: ES } })
    loadPermissionSnapshot(root)
    expect(keysAsked()).toEqual([K_L, SENTINEL, K_C])
    live({ [K_L]: { code: 1, err: DENIED }, [K_C]: { code: 1, err: DENIED } })
    expect(held()).toBe(true)
    expect(keysAsked()).toEqual([K_L, SENTINEL])
  })

  it('a second hook process reads the registry again and keeps nothing on disk', () => {
    expect(loadPermissionSnapshot(root)?.deny.map((r) => r.raw)).toEqual(['Read(./secret/**)'])
    resetPermissionSourceCache()
    reg.calls.length = 0
    expect(loadPermissionSnapshot(root)?.deny.map((r) => r.raw)).toEqual(['Read(./secret/**)'])
    expect(reg.calls.length, 'the second process reused the first one\'s read').toBeGreaterThan(0)
    expect(fs.readdirSync(home), 'a policy read left a file behind').toEqual([])
  })

  it('a forged copy of the policy on disk has no effect: it neither hides the live deny nor adds an allow', () => {
    const forged = [
      { at: Date.now(), json: null },
      { at: Date.now() + 600_000, json: { permissions: { allow: ['Bash(*)'] } } },
      { at: String(Date.now()), json: [] },
      { permissions: { allow: ['Bash(*)'] } },
    ]
    for (const body of forged) {
      for (const name of ['registry_L.json', 'registry_C.json', 'registry_HKLM.json', 'registry_HKCU.json', 'claude_registry_HKLM.json']) {
        fs.writeFileSync(path.join(home, name), JSON.stringify(body))
        fs.mkdirSync(path.join(home, 'cache'), { recursive: true })
        fs.writeFileSync(path.join(home, 'cache', name), JSON.stringify(body))
      }
      live({})
      const snapshot = loadPermissionSnapshot(root)
      expect(snapshot?.deny.map((r) => r.raw), JSON.stringify(body)).toEqual(['Read(./secret/**)'])
      expect(snapshot?.allow, JSON.stringify(body)).toEqual([])
      expect(readHintCrossesRule('claudecode', root, secret()), JSON.stringify(body)).toBe(true)
      expect(reg.calls.length, 'the live read was skipped').toBeGreaterThan(0)
    }
  })

  // HAND-DERIVED from the threat: a file the same user can write is a file the agent can write, so a planted policy entry (a deny rule, stamped now so a 30-second memory would have believed it) must not decide what the machine registry holds. The registry is asked every time and nothing of the answer is stored. The reg answers are mocked, as the real reg.exe fails closed after 5 s and a loaded machine crosses that.
  it('a planted policy memory is not read by a rewrite, and no registry answer is stored', async () => {
    await loadHiddenRuleCheck()
    const dir = path.join(home, 'policy_cache')
    fs.mkdirSync(dir, { recursive: true })
    for (const key of [K_L, K_C]) {
      fs.writeFileSync(path.join(dir, `${key.replace(/\W+/g, '_')}.json`), JSON.stringify({ key, at: Date.now(), settings: { permissions: { deny: ['Bash(curl:*)'] } } }))
    }
    const before = fs.readdirSync(dir).sort()
    const cmd = "token-goat compress -f generic --timeout 600 -c 'curl https://example.com'"
    const req: RewriteRequest = { kind: 'shell-wrap', harness: 'claudecode', mode: 'default', cwd: root, original: 'curl https://example.com', rewritten: cmd }
    live({ [K_L]: absent, [K_C]: absent })
    expect(permissionNeutralRewrite({ command: cmd }, req)).not.toBeNull()
    expect(keysAsked()).toEqual([K_L, K_C])
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    expect(fs.readdirSync(home).sort()).toEqual(['policy_cache'])
  })

  it('a lookup that times out, fails to start or returns something unreadable holds the hint back', () => {
    for (const a of [timedOut, { code: 2, err: NOT_FOUND }, { out: 'not a listing' }, { out: '' }] as Answer[]) {
      live({ [K_L]: a })
      expect(held(), JSON.stringify(a)).toBe(true)
      live({ [K_C]: a })
      expect(held(), JSON.stringify(a)).toBe(true)
    }
    live({})
    expect(held()).toBe(false)
  })

  it('launches nothing for registry keys that are hidden from the read', () => {
    slot[FILTER] = (): boolean => false
    loadPermissionSnapshot(root)
    expect(reg.calls).toEqual([])
  })

  it('Codex and Copilot hints never reach the registry', () => {
    for (const harness of ['codex', 'copilot_cli'] as const) {
      expect(readHintCrossesRule(harness, root, secret())).toBe(false)
    }
    expect(reg.calls).toHaveLength(0)
  })
})

describe('exit 1 from reg means absent only when its message is the one for a key that cannot exist', () => {
  it('a key and a value that are absent let the hint through', () => {
    live({ [K_L]: absent })
    expect(held()).toBe(false)
  })

  it('a key reg may not read holds the hint back, because access denied also exits 1', () => {
    live({ [K_C]: { code: 1, err: DENIED } })
    expect(held()).toBe(true)
    live({ [K_L]: { code: 1, err: DENIED }, [K_C]: absent })
    expect(held()).toBe(true)
  })

  it('a missing key is recognised by repeating the sentinel\'s message, whatever language reg prints', () => {
    const es = ES
    live({ [K_L]: { code: 1, err: es }, [K_C]: { code: 1, err: es }, [SENTINEL]: { code: 1, err: es } })
    expect(held()).toBe(false)
    live({ [K_L]: { code: 1, err: es }, [K_C]: { code: 1, err: DENIED }, [SENTINEL]: { code: 1, err: es } })
    expect(held()).toBe(true)
  })

  it('a sentinel that is not reported missing leaves nothing to compare, so the hint is held back', () => {
    const es = { code: 1, err: ES }
    live({ [K_L]: es, [K_C]: es, [SENTINEL]: { code: 0, out: settingsOut('{}') } })
    expect(held()).toBe(true)
    live({ [K_L]: es, [K_C]: es, [SENTINEL]: { code: 2, err: ES } })
    expect(held()).toBe(true)
    live({ [K_L]: es, [K_C]: es, [SENTINEL]: timedOut })
    expect(held()).toBe(true)
  })

  it('two empty messages are not the same message', () => {
    live({ [K_L]: { code: 1 }, [K_C]: { code: 1 }, [SENTINEL]: { code: 1 } })
    expect(held()).toBe(true)
  })

  it('a query that exits with another code holds the hint back', () => {
    live({ [K_C]: { code: 2, err: NOT_FOUND } })
    expect(held()).toBe(true)
    live({ [K_C]: { code: 2, out: settingsOut('{}') } })
    expect(held(), 'a listing is not trusted when the exit code is not 0').toBe(true)
  })

  it('a Settings value that decoded with a replacement character holds the hint back, so a non-ASCII deny cannot be lost', () => {
    live({ [K_L]: { out: settingsOut(JSON.stringify({ permissions: { deny: ['Read(./s�cret/**)'] } })) } })
    expect(held(), 'the byte reg printed is not valid UTF-8').toBe(true)
    live({ [K_L]: { out: settingsOut(JSON.stringify({ permissions: { deny: ['Read(./secret/**)'] } })) } })
    expect(held()).toBe(false)
  })

  it('a Settings value that is not a JSON object holds the hint back', () => {
    live({ [K_L]: { out: settingsOut('[1]') } })
    expect(held()).toBe(true)
    live({ [K_L]: { out: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_BINARY    00\r\n' } })
    expect(held()).toBe(true)
  })
})

// HAND-DERIVED: the resident hook server keeps the managed sources for 30 s, and each expiry made the next handler wait on two synchronous reg.exe runs; the background refresh must decide exactly as that synchronous read does, or leave the decision to it.
describe('the resident hook server refreshes the registry policy off the event loop', () => {
  it('fills the cache from a background read, so a snapshot launches no synchronous reg', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    primeManagedPolicyAhead()
    await flush()
    expect(reg.calls, 'only Windows has a registry to read').toEqual([])
    Object.defineProperty(process, 'platform', { value: 'win32' })
    primeManagedPolicyAhead()
    expect(syncCalls(), 'the refresh blocked the event loop').toBe(0)
    await flush()
    expect(asyncKeys(), 'the English not-found message needs no sentinel').toEqual([K_L, K_C])
    reg.calls.length = 0
    expect(loadPermissionSnapshot(root)?.deny.map((r) => r.raw)).toEqual(['Read(./secret/**)'])
    expect(reg.calls, 'the snapshot read the registry again although the refresh had').toEqual([])
  })

  it('reads a localized missing key as absent through the sentinel, as the synchronous read does', async () => {
    live({ [K_L]: { code: 1, err: ES }, [K_C]: { code: 1, err: ES }, [SENTINEL]: { code: 1, err: ES } })
    primeManagedPolicyAhead()
    await flush()
    expect(asyncKeys()).toEqual([K_L, K_C, SENTINEL])
    reg.calls.length = 0
    expect(held()).toBe(false)
    expect(reg.calls).toEqual([])
  })

  it('leaves the decision to the synchronous read when the background read is unreadable', async () => {
    for (const a of [{ code: 1, err: DENIED }, timedOut, { code: 2, err: NOT_FOUND }, { out: 'not a listing' }] as Answer[]) {
      live({ [K_L]: a })
      primeManagedPolicyAhead()
      await flush()
      reg.calls.length = 0
      expect(held(), JSON.stringify(a)).toBe(true)
      expect(syncCalls(), `${JSON.stringify(a)}: an unreadable background read was cached`).toBeGreaterThan(0)
    }
  })

  it('drops a refresh that a reset or a newer synchronous read overtook', async () => {
    primeManagedPolicyAhead()
    resetPermissionSourceCache()
    await flush()
    reg.calls.length = 0
    loadPermissionSnapshot(root)
    expect(syncCalls(), 'a refresh begun before the reset filled the cache after it').toBeGreaterThan(0)
    vi.useFakeTimers({ toFake: ['Date'] })
    live({})
    primeManagedPolicyAhead()
    vi.setSystemTime(Date.now() + 1000)
    reg.answers[K_L] = absent
    expect(loadPermissionSnapshot(root)?.deny, 'the synchronous read saw the policy removed').toEqual([])
    await flush()
    reg.calls.length = 0
    expect(loadPermissionSnapshot(root)?.deny, 'an older background read replaced a newer synchronous one').toEqual([])
    expect(reg.calls).toEqual([])
  })

  it('stops reading once no snapshot has been taken for five minutes, and resumes with the next one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    live({})
    primeManagedPolicyAhead()
    await flush()
    reg.calls.length = 0
    vi.advanceTimersByTime(20_000)
    expect(asyncKeys(), 'no refresh 20 s on').toEqual([K_L, K_C])
    await flush()
    vi.advanceTimersByTime(380_000)
    await flush()
    reg.calls.length = 0
    vi.advanceTimersByTime(100_000)
    await flush()
    expect(reg.calls, 'an idle server kept launching reg').toEqual([])
    loadPermissionSnapshot(root)
    reg.calls.length = 0
    vi.advanceTimersByTime(20_000)
    expect(asyncKeys(), 'a snapshot did not resume the refresh').toEqual([K_L, K_C])
    await flush()
  })
})
