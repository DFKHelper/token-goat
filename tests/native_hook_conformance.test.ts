/** Cross-language conformance of the native hook client (native/tg-hook) with the TypeScript it re-implements: data directory, bundle directory, endpoint, key path and key rules, MAC, frame codec. A disagreement in any of them fails silently in production -- the client computes a different endpoint or MAC, finds no server, and every hook call takes the slow Node path with correct output -- so each rule is pinned here against the shipping function itself. Provenance: HAND-DERIVED inputs; every expected value is produced by the shipping TypeScript (`dataDir` through `_resetDataDirCacheForTesting`, `resolveBundleDir`, `endpointFor`, `serverKeyPath`, `readServerKey`, `mac`, `macMatches`, `encodeFrame`, `frameFits`, `readFrames`) or by Node's own `path`, `String.prototype.trim` and `os.homedir`, which that code calls; never by the Rust side, which is the implementation under test. The test builds the binary through scripts/build-native.mjs and fails, not skips, when that is impossible: a skipped conformance test is exactly the silent fallback it exists to catch. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import type * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, dataDir } from '../src/constants.js'
import { encodeFrame, endpointFor, frameFits, mac, macMatches, MAX_FRAME_BYTES, readFrames, readServerKey, resolveBundleDir, serverKeyPath } from '../src/hook_ipc.js'
import { buildNative } from './helpers/native_bin.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WIN = process.platform === 'win32'
const DATA_VAR = WIN ? 'LOCALAPPDATA' : 'XDG_DATA_HOME'
const HOME_VAR = WIN ? 'USERPROFILE' : 'HOME'
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)
const LONE_HIGH = String.fromCharCode(0xd800)

let bin = ''
let scratch = ''

beforeAll(() => {
  bin = buildNative()
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-conf-'))
})

afterAll(() => {
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true })
})

interface VectorResult {
  out?: unknown
  error?: string
}

function runVectors(cases: object[]): unknown[] {
  const r = spawnSync(bin, ['--selftest-vectors'], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  expect(r.status, r.stderr).toBe(0)
  const results = JSON.parse(r.stdout) as VectorResult[]
  expect(results).toHaveLength(cases.length)
  return results.map((res, i) => {
    if (res.error !== undefined) throw new Error(`tg-hook rejected case ${i} ${JSON.stringify(cases[i]).slice(0, 300)}: ${res.error}`)
    return res.out
  })
}

/** Node writes, hashes and MACs a string as its UTF-8, which turns a lone surrogate into U+FFFD. That is the only form the Rust side can hold, so both sides are compared in it. */
function wellFormed(v: unknown): unknown {
  if (typeof v === 'string') return Buffer.from(v, 'utf8').toString('utf8')
  if (Array.isArray(v)) return v.map(wellFormed)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [wellFormed(k) as string, wellFormed(x)]))
  return v
}

/** Runs `cases` through the binary and requires each answer to equal the TypeScript's, listing every disagreement at once. */
function expectConforms(cases: object[], expected: unknown[]): void {
  expect(cases.length).toBe(expected.length)
  const actual = runVectors(cases)
  const mismatches = cases.flatMap((c, i) => (isDeepStrictEqual(wellFormed(actual[i]), wellFormed(expected[i])) ? [] : [{ case: c, node: expected[i], rust: actual[i] }]))
  expect(mismatches).toEqual([])
}

/** `dataDir()` exactly as a Node process with `vars` in its environment resolves it, or `null` where os.homedir() throws (a USERPROFILE libuv refuses, no account entry) and `dataDir()` with it: the variables are applied to this process (os.homedir reads them live), the module cache recomputed, and everything restored. VITEST_ALLOW_REAL_DATA_DIR lets the home fallback run; it only computes a path. */
function nodeDataDir(vars: Record<string, string | undefined>): string | null {
  const keys = [...Object.keys(vars), 'VITEST_ALLOW_REAL_DATA_DIR']
  const saved = new Map(keys.map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    process.env['VITEST_ALLOW_REAL_DATA_DIR'] = '1'
    _resetDataDirCacheForTesting()
    return dataDir()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).syscall !== 'uv_os_homedir') throw e
    return null
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetDataDirCacheForTesting()
  }
}

const WIN_OVERRIDES = [
  'C:\\Users\\me\\AppData\\Local',
  'C:/Users/me/AppData/Local',
  'C:\\Users\\me\\AppData\\Local\\',
  'C:\\Users\\me\\AppData\\Local\\\\',
  'C:\\Users\\me\\.\\AppData\\..\\AppData\\Local',
  'C:\\x\\..\\..\\..\\y',
  'C:\\Users/me\\AppData/Local/',
  '  C:\\Users\\me\\AppData\\Local  ',
  '\tC:\\x\n',
  `${cp(0xfeff)}C:\\x`,
  `${cp(0x85)}C:\\x`,
  `${cp(0x3000)}C:\\x${cp(0x3000)}`,
  'c:\\USERS\\Ünïcødé\\ẞ\\AppData',
  `C:\\Users\\${cp(0x1f600)}\\AppData`,
  'C:\\',
  'C:',
  'C:relative',
  'relative\\dir',
  '.\\x',
  '\\tmp\\tg',
  '/tmp/tg',
  '\\\\server',
  '\\\\server\\share\\dir',
  '//server/share',
  '\\\\?\\C:\\Users\\me',
  '\\\\.\\C:\\x',
  'C:\\x\\COM1:\\y',
  '',
  '   ',
]

const POSIX_OVERRIDES = [
  '/home/u/.local/share',
  '/home/u/.local/share/',
  '/home//u/./x/../share',
  '/a/b/../../..',
  '  /x  ',
  '\t/x\n',
  `${cp(0xfeff)}/x`,
  `${cp(0x85)}/x`,
  '/',
  '//x',
  `/ünï/${cp(0x1f600)}`,
  '\\x',
  'relative',
  './x',
  '',
  ' ',
]

const OVERRIDES = WIN ? WIN_OVERRIDES : POSIX_OVERRIDES
// libuv refuses a USERPROFILE under 3 UTF-8 bytes, so the short Windows homes straddle that floor by bytes, not characters.
const HOMES = WIN ? ['C:\\Users\\fake home', 'C:/Users/fake/', 'relhome', '', 'ab', 'abc', 'é', 'éa'] : ['/home/fake', '/home/fake/', 'relhome', '', 'ab', 'é']

describe('tg-hook binary', () => {
  it('passes its own unit tests', () => {
    const r = spawnSync('cargo', ['test', '--locked', '--quiet'], { cwd: path.join(ROOT, 'native', 'tg-hook'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    expect(r.error).toBeUndefined()
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  }, 900_000)

  it('--selftest reports this platform and architecture', () => {
    const r = spawnSync(bin, ['--selftest'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, name: 'tg-hook', platform: process.platform, arch: process.arch, protocol: 1, slots: 3 })
  })
})

describe('data directory', () => {
  it('matches defaultDataDir for every override and home, from a given environment', () => {
    const cases: object[] = []
    const expected: unknown[] = []
    for (const home of HOMES) {
      for (const value of [...OVERRIDES, undefined]) {
        const env: Record<string, string> = { [HOME_VAR]: home }
        if (value !== undefined) env[DATA_VAR] = value
        cases.push({ op: 'dataDir', env })
        expected.push(nodeDataDir({ [DATA_VAR]: value, [HOME_VAR]: home }))
      }
    }
    expectConforms(cases, expected)
  })

  function real(env: NodeJS.ProcessEnv, names: string[] = []): { dataDir: string; homedir: string; env: Record<string, string | null> } {
    // libuv on Windows copies USERPROFILE (among others) from the parent into a child environment that lacks it, so a variable meant to be absent in the child is removed from this process for the spawn.
    const absent = [DATA_VAR, HOME_VAR].filter((k) => !Object.keys(env).some((e) => e.toUpperCase() === k))
    const saved = absent.map((k) => [k, process.env[k]] as const)
    for (const k of absent) delete process.env[k]
    let r: SpawnSyncReturns<string>
    try {
      r = spawnSync(bin, ['--selftest-real', ...names], { env, encoding: 'utf8' })
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v
    }
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout) as { dataDir: string; homedir: string; env: Record<string, string | null> }
  }

  /** This process's environment without any spelling of `names`, which Windows treats case-insensitively. */
  function envWithout(...names: string[]): NodeJS.ProcessEnv {
    const drop = new Set(names.map((n) => n.toUpperCase()))
    return Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k.toUpperCase())))
  }

  it('matches defaultDataDir when resolved from the real process environment', () => {
    const mismatches: object[] = []
    // An unset home variable sends both to the OS account database (GetUserProfileDirectoryW, getpwuid_r), which only a child with that variable really absent can exercise.
    for (const home of [HOMES[0] as string, undefined]) {
      for (const value of [OVERRIDES[0] as string, OVERRIDES[1] as string, OVERRIDES[7] as string, OVERRIDES[12] as string, '', undefined]) {
        const env = envWithout(DATA_VAR, HOME_VAR)
        if (home !== undefined) env[HOME_VAR] = home
        if (value !== undefined) env[DATA_VAR] = value
        const got = real(env)
        const want = nodeDataDir({ [DATA_VAR]: value, [HOME_VAR]: home })
        if (got.dataDir !== want) mismatches.push({ home, value, node: want, rust: got.dataDir })
      }
    }
    expect(mismatches).toEqual([])
  })

  it.runIf(WIN)('looks up LOCALAPPDATA case-insensitively, as process.env does on Windows', () => {
    const env = envWithout('LOCALAPPDATA', 'USERPROFILE')
    env['LocalAppData'] = String.raw`D:\lad`
    env['UserProfile'] = String.raw`D:\home`
    expect(real(env).dataDir).toBe(nodeDataDir({ LOCALAPPDATA: String.raw`D:\lad`, USERPROFILE: String.raw`D:\home` }))
  })

  /** ASCII-only JSON of what a Node process sees for `names` and os.homedir(), so it survives any console encoding in between. */
  const PROBE = `const e = {}; for (const n of process.argv.slice(2)) e[n] = process.env[n] ?? null; const s = JSON.stringify({ env: e, homedir: require('os').homedir() }); process.stdout.write(s.replace(/[^\\x00-\\x7f]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\\n')`

  it.runIf(WIN)('decodes an environment value holding an unpaired surrogate the way Node does', () => {
    // Node's own spawn cannot put a lone surrogate into a child's environment (it encodes the string as UTF-8 first), so PowerShell, whose strings are raw UTF-16, sets it.
    const probe = path.join(scratch, 'probe.cjs')
    fs.writeFileSync(probe, PROBE)
    const script = path.join(scratch, 'surrogate.ps1')
    fs.writeFileSync(
      script,
      [
        "$env:LOCALAPPDATA = 'C:\\tg' + [char]0xD800 + '\\lad'",
        "$env:TG_SURROGATE = 'a' + [char]0xDC00 + [char]0xD800 + 'b'",
        "$env:USERPROFILE = 'C:\\Users\\fake'",
        '& $args[0] $args[1] LOCALAPPDATA TG_SURROGATE',
        '& $args[2] --selftest-real LOCALAPPDATA TG_SURROGATE',
        '',
      ].join('\r\n'),
    )
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, process.execPath, probe, bin], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const [nodeLine, rustLine] = r.stdout.trim().split(/\r?\n/)
    const seen = JSON.parse(nodeLine as string) as { env: Record<string, string>; homedir: string }
    const rust = JSON.parse(rustLine as string) as { dataDir: string; env: Record<string, string> }
    // Guards the probe itself: had PowerShell not delivered a lone surrogate, Node would show something other than replacement characters and the comparison below would prove nothing.
    expect(seen.env['TG_SURROGATE']).toContain(cp(0xfffd))
    expect(rust.env).toEqual(seen.env)
    expect(rust.dataDir).toBe(nodeDataDir({ LOCALAPPDATA: seen.env['LOCALAPPDATA'], USERPROFILE: seen.homedir }))
  })

  it.runIf(!WIN)('decodes an environment value holding invalid UTF-8 the way Node does', () => {
    const probe = path.join(scratch, 'probe.cjs')
    fs.writeFileSync(probe, PROBE)
    // Node's own spawn cannot pass bytes that are not UTF-8, so the shell sets them.
    const sh = (cmd: string[]): string => {
      const r = spawnSync('sh', ['-c', `XDG_DATA_HOME="$(printf '/tmp/tg\\377\\355\\240\\200x')" TG_BYTES="$(printf 'a\\300b')" HOME=/home/fake exec "$@"`, 'sh', ...cmd], { encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout
    }
    const seen = JSON.parse(sh([process.execPath, probe, 'XDG_DATA_HOME', 'TG_BYTES'])) as { env: Record<string, string>; homedir: string }
    const rust = JSON.parse(sh([bin, '--selftest-real', 'XDG_DATA_HOME', 'TG_BYTES'])) as { dataDir: string; env: Record<string, string> }
    expect(seen.env['TG_BYTES']).toContain(cp(0xfffd))
    expect(rust.env).toEqual(seen.env)
    expect(rust.dataDir).toBe(nodeDataDir({ XDG_DATA_HOME: seen.env['XDG_DATA_HOME'], HOME: seen.homedir }))
  })
})

const PATH_INPUTS = [
  '',
  '.',
  '..',
  '/',
  '\\',
  '//',
  '\\\\',
  '///',
  'a',
  'a/',
  'a\\',
  'a/b',
  'a\\b',
  'a/./b',
  'a/../b',
  'a/b/../../..',
  '../a',
  './a',
  'C:',
  'C:\\',
  'C:/',
  'c:\\x\\',
  'C:\\x\\..\\..',
  'C:x',
  'C:x\\..\\..',
  'C:\\x\\.\\y\\',
  'C:/x//y///',
  '\\x',
  '/x',
  '//server',
  '//server/',
  '//server/share',
  '//server/share/',
  '\\\\server\\share\\dir\\..\\..',
  '\\\\?\\C:\\x',
  '\\\\?\\C:\\x\\..\\y',
  '\\\\.\\pipe\\x',
  '\\\\.\\C:\\x',
  '\\\\?\\UNC\\s\\sh',
  '\\\\?\\COM1:',
  'CON',
  'CONx',
  'C:\\CON\\x',
  'COM1:',
  'C:\\x\\COM1:\\y',
  'NUL:x',
  'a:b',
  'x:\\y:',
  ':',
  'a/b:c',
  `C:\\Ünïcødé\\${cp(0x1f600)}\\`,
  `/ünï/${cp(0x1f600)}/..`,
  'é',
  cp(0x1f600),
  `x/${cp(0x1f600)}`,
  '/a/b',
  '/a//b/',
  '/a/./b/.',
  '/../a',
  '/a/b/../../../c',
  '///a',
  '  C:\\x  ',
  'C:\\x\\ ',
  '. /x',
]

describe("Node's path module", () => {
  it('join, normalize, isAbsolute, dirname and parse().root agree for both flavors', () => {
    const cases: object[] = []
    const expected: unknown[] = []
    for (const flavor of ['win32', 'posix'] as const) {
      const p = path[flavor]
      for (const input of PATH_INPUTS) {
        for (const args of [[input, 'dfk-helper', 'token-goat'], [input, 'hook-server.key'], [input], [input, ''], ['', input], [input, '..', 'x'], [input, '/abs'], ['C:\\base', input]]) {
          cases.push({ op: 'path', flavor, fn: 'join', args })
          expected.push(p.join(...args))
        }
        cases.push({ op: 'path', flavor, fn: 'normalize', args: [input] }, { op: 'path', flavor, fn: 'isAbsolute', args: [input] }, { op: 'path', flavor, fn: 'dirname', args: [input] }, { op: 'path', flavor, fn: 'parseRoot', args: [input] })
        expected.push(p.normalize(input), p.isAbsolute(input), p.dirname(input), p.parse(input).root)
      }
    }
    expectConforms(cases, expected)
  })

  it('String.prototype.trim strips exactly the ECMAScript whitespace set', () => {
    const codes = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x180e, 0x2000, 0x2001, 0x2005, 0x200a, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
    const inputs = codes.map((c) => `${cp(c)}x${cp(c)}`)
    expectConforms(
      inputs.map((s) => ({ op: 'trim', s })),
      inputs.map((s) => s.trim()),
    )
  })
})

describe('endpoint', () => {
  it('matches endpointFor for every data directory, bundle directory and slot', () => {
    const own = resolveBundleDir(path.join(ROOT, 'dist'))
    const dataDirs = [
      String.raw`C:\Users\U\AppData\Local\dfk-helper\token-goat`,
      'c:\\users\\u\\appdata\\local\\dfk-helper\\token-goat',
      String.raw`C:\USERS\İSTANBUL`,
      `D:\\${cp(0x39f, 0x394, 0x39f, 0x3a3)}`,
      `D:\\${cp(0x3a3, 0x3a3)}x`,
      'D:\\ẞ',
      `D:\\${cp(0x10400)}`,
      '/home/u/.local/share/token-goat',
      '/home/U/.local/share/token-goat',
      // POSIX socket paths: `<dir>/hooks-<16 hex>-<slot>.sock` adds 30 bytes, so 69 bytes stays in the data directory and 70 moves to the temp directory; the multibyte one is 70 bytes but only 69 UTF-16 units.
      `/tmp/d${'x'.repeat(63)}`,
      `/tmp/d${'x'.repeat(64)}`,
      `/tmp/é${'x'.repeat(63)}`,
      path.join(scratch, 'x'.repeat(120)),
    ]
    const bundleDirs = [own, String.raw`C:\Program Files\nodejs\node_modules\token-goat\dist`, '/usr/lib/node_modules/token-goat/dist', 'D:\\Ärger']
    const cases: object[] = []
    const expected: unknown[] = []
    for (const dir of dataDirs) {
      for (const bundle of bundleDirs) {
        for (const slot of [0, 1, 2]) {
          cases.push({ op: 'endpoint', slot, dataDir: dir, bundleDir: bundle })
          expected.push(endpointFor(slot, dir, bundle))
        }
      }
    }
    expectConforms(cases, expected)
  })

  it('resolves the bundle directory to the real path Node resolves, through junctions, symlinks, case and dot segments', () => {
    const dist = path.join(ROOT, 'dist')
    const entries = [path.join(dist, 'token-goat.mjs'), path.join(dist, 'token-goat.mjs').split(path.sep).join('/'), path.relative(process.cwd(), path.join(dist, 'token-goat.mjs')), path.join(scratch, 'missing', 'token-goat.mjs'), path.join(scratch, 'missing', 'token-goat.mjs').split(path.sep).join('/')]
    const junction = path.join(scratch, 'junctioned-dist')
    fs.symlinkSync(dist, junction, 'junction')
    entries.push(path.join(junction, 'token-goat.mjs'), `${junction}${path.sep}..${path.sep}junctioned-dist${path.sep}token-goat.mjs`)
    const unicode = path.join(scratch, `ünï ${cp(0x1f600)}`)
    fs.mkdirSync(unicode)
    entries.push(path.join(unicode, 'token-goat.mjs'))
    if (WIN) entries.push(path.join(dist, 'token-goat.mjs').toUpperCase(), path.join(dist, 'token-goat.mjs').toLowerCase())
    // A true directory symlink needs Developer Mode or elevation on Windows; the junction above is what an npm global install creates there, so this one is extra coverage when available.
    const linked = path.join(scratch, 'symlinked-dist')
    try {
      fs.symlinkSync(dist, linked, 'dir')
      entries.push(path.join(linked, 'token-goat.mjs'))
    } catch (e) {
      if (!WIN) throw e
    }
    expectConforms(
      entries.map((entry) => ({ op: 'bundleDir', entry })),
      entries.map((entry) => resolveBundleDir(path.dirname(entry))),
    )
  })
})

describe('server key', () => {
  it('matches serverKeyPath and readServerKey', () => {
    const keyDir = (name: string, content?: Buffer | 'dir', mode?: number): string => {
      const dir = path.join(scratch, 'keys', name)
      fs.mkdirSync(dir, { recursive: true })
      const p = serverKeyPath(dir)
      if (content === 'dir') fs.mkdirSync(p)
      else if (content !== undefined) fs.writeFileSync(p, content, { mode: 0o600 })
      if (mode !== undefined) fs.chmodSync(p, mode)
      return dir
    }
    const dirs = [
      keyDir('good', crypto.randomBytes(32)),
      keyDir('short', crypto.randomBytes(31)),
      keyDir('long', crypto.randomBytes(33)),
      keyDir('empty', Buffer.alloc(0)),
      keyDir('missing'),
      keyDir('is-a-directory', 'dir'),
      path.join(scratch, 'keys', 'no-such-dir'),
    ]
    if (!WIN) dirs.push(keyDir('group-readable', crypto.randomBytes(32), 0o640), keyDir('world-readable', crypto.randomBytes(32), 0o644), keyDir('owner-read-only', crypto.randomBytes(32), 0o400))
    const pathOnly = [...dirs, `${dirs[0] as string}${path.sep}`, (dirs[0] as string).split(path.sep).join('/'), path.join(dirs[0] as string, '..', 'good'), String.raw`C:\x\..\y`, '/a/./b']
    expectConforms(
      [...dirs.map((dataDir) => ({ op: 'readKey', dataDir })), ...pathOnly.map((dataDir) => ({ op: 'keyPath', dataDir }))],
      [...dirs.map((d) => readServerKey(d)?.toString('hex') ?? null), ...pathOnly.map((d) => serverKeyPath(d))],
    )
  })
})

describe('MAC', () => {
  it('matches mac for keys of every length and parts with multibyte and unpaired-surrogate text', () => {
    const seed = (label: string, n: number): Buffer => {
      const out = Buffer.alloc(n)
      for (let i = 0; i < n; i += 32) crypto.createHash('sha256').update(`${label}:${i}`).digest().copy(out, i)
      return out
    }
    const keys = [seed('k32', 32), Buffer.alloc(0), seed('k64', 64), seed('k65', 65), seed('k100', 100)]
    const nc = seed('nc', 16).toString('hex')
    const ns = seed('ns', 16).toString('hex')
    const partLists = [[], [''], ['a'], ['ab', 'c'], ['a', 'bc'], ['S', nc, ns], ['Q', nc, ns, '{"kind":"hook"}'], ['é'], [cp(0x1f600)], ['İstanbul', 'ΟΔΟΣ'], ['a:b', '12:x'], ['日本語テキスト'], [`x${LONE_HIGH}y`], ['x'.repeat(100_000)], [`${'é'.repeat(50_000)}${cp(0x1f600)}`]]
    const cases: object[] = []
    const expected: unknown[] = []
    for (const key of keys) {
      for (const parts of partLists) {
        cases.push({ op: 'mac', keyHex: key.toString('hex'), parts })
        expected.push(mac(key, ...parts))
      }
    }
    const good = mac(keys[0] as Buffer, 'S', nc, ns)
    const flipped = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`
    // Pairs whose UTF-16 lengths match but UTF-8 lengths do not are left out: Node's timingSafeEqual throws on them rather than answering.
    for (const [e, a] of [[good, good], [good, flipped], [good, good.slice(1)], [good, good.toUpperCase()], ['', ''], [good, `${good}0`]] as const) {
      cases.push({ op: 'macMatches', expected: e, actual: a })
      expected.push(macMatches(e, a))
    }
    expectConforms(cases, expected)
  })
})

/** What `readFrames` makes of `chunks` arriving on a socket in order: the frames it delivers and whether it reported an error (after which a destroyed socket delivers nothing more). */
function nodeDecode(chunks: Buffer[]): { frames: unknown[]; error: boolean } {
  const listeners: Array<(chunk: Buffer) => void> = []
  let destroyed = false
  const socket = {
    on(event: string, fn: (chunk: Buffer) => void) {
      if (event === 'data') listeners.push(fn)
      return socket
    },
    destroy() {
      destroyed = true
    },
  }
  const frames: unknown[] = []
  let error = false
  readFrames(
    socket as unknown as net.Socket,
    (m) => frames.push(m),
    () => (error = true),
  )
  for (const chunk of chunks) {
    if (destroyed) break
    for (const fn of listeners) fn(chunk)
  }
  return { frames, error }
}

function rawFrame(body: Buffer | string, claimed?: number): Buffer {
  const b = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const header = Buffer.alloc(4)
  header.writeUInt32BE(claimed ?? b.length, 0)
  return Buffer.concat([header, b])
}

describe('frames', () => {
  it('encodes messages byte-for-byte as encodeFrame does', () => {
    // Keys are written in byte order: serde_json's map sorts them, and the relay never depends on key order, only on JSON.parse reading back the same values.
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('')
    const messages = [
      { nc: 'ab12', t: 'hello', v: 1 },
      { cwd: 'C:\\Users\\me\\proj', elapsedMs: 12, env: { A: '1', Path: String.raw`C:\a;C:\b` }, event: 'pre_tool_use', input: '{"tool_name":"Bash","tool_input":{"command":"ls \\"x\\""}}', kind: 'hook' },
      { s: `quote " backslash \\ slash / controls ${controls} del ${String.fromCharCode(0x7f)} seps ${cp(0x2028)}${cp(0x2029)} bom ${cp(0xfeff)} emoji ${cp(0x1f600)} cjk 日本` },
      { a: [], b: {}, c: [1, -1, 0, 9007199254740991, 1.5, 0.1, 123456.789], d: [true, false, null], e: [[{ f: 'g' }]] },
      'bare string',
      [1, 'two', { three: 3 }],
    ]
    expectConforms(
      messages.map((message) => ({ op: 'encodeFrame', message })),
      messages.map((m) => {
        const frame = encodeFrame(m)
        return { hex: frame.toString('hex'), fits: frameFits(frame) }
      }),
    )
  })

  it('agrees with frameFits at and over MAX_FRAME_BYTES', () => {
    const sizes = [2, 3, MAX_FRAME_BYTES, MAX_FRAME_BYTES + 1]
    expectConforms(
      sizes.map((bodyBytes) => ({ op: 'encodeSized', bodyBytes })),
      sizes.map((n) => {
        const frame = encodeFrame('a'.repeat(n - 2))
        return { header: frame.subarray(0, 4).toString('hex'), bodySha256: crypto.createHash('sha256').update(frame.subarray(4)).digest('hex'), fits: frameFits(frame) }
      }),
    )
  })

  it('decodes a byte stream into the frames and errors readFrames reports', () => {
    const hello = encodeFrame({ t: 'challenge', v: 1, ns: 'ff', mac: 'aa' })
    const done = encodeFrame({ ok: true, stdout: `{"x":"${cp(0x1f600)}"}`, status: 0 })
    const streams: Buffer[][] = [
      [hello],
      [Buffer.concat([hello, done])],
      [hello.subarray(0, 3), hello.subarray(3, 9), hello.subarray(9)],
      [...Buffer.concat([hello, done])].map((b) => Buffer.from([b])),
      [rawFrame(Buffer.alloc(0), MAX_FRAME_BYTES + 1)],
      [rawFrame(Buffer.alloc(0), MAX_FRAME_BYTES)],
      [Buffer.concat([hello, rawFrame(Buffer.alloc(0), MAX_FRAME_BYTES + 1)])],
      [rawFrame('[1,2]')],
      [rawFrame('42')],
      [rawFrame('"s"')],
      [rawFrame('null')],
      [rawFrame('{"a":')],
      [rawFrame('{}'), rawFrame('{"after":"error"}')],
      [rawFrame(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0x22, 0x7d]))],
      [rawFrame(`{"a":"x\\ud800y","\\udc00":"k","p":"\\ud83d\\ude00","q":"\\\\ud800"}`)],
      [rawFrame('{"a":1,"a":2}')],
      [rawFrame(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]))],
      [rawFrame(' \t\r\n{"a" : [ 1 , 2 ] }\n ')],
      [rawFrame(`${'['.repeat(100)}${']'.repeat(100)}`.replace(/^\[/, '{"a":[').replace(/\]$/, ']}'))],
      [rawFrame('{"a":1}{"b":2}')],
      [rawFrame('{"a":"\\u0041\\n\\t\\/"}')],
    ]
    expectConforms(
      streams.map((chunks) => ({ op: 'decode', chunksHex: chunks.map((c) => c.toString('hex')) })),
      streams.map((chunks) => nodeDecode(chunks)),
    )
  })
})
