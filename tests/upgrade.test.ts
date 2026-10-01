import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  compareSemver,
  checkUpdateStatus,
  cmdUpgrade,
  getRegistryUrl,
  getCachedUpdateStatus,
  saveCachedUpdateStatus,
  upgradeDecision,
  updateAdvice,
  npmInvocation,
  isDevCheckout,
  runningPackageRoot,
  fetchViaNpm,
  fetchViaHttp,
  performUpgrade,
  DEV_CHECKOUT_ADVICE,
  UPDATE_CACHE_TTL_MS,
  FAILED_CHECK_TTL_MS,
} from '../src/cli_upgrade.js'
import { VERSION } from '../src/version.js'
import { renderStats } from '../src/render/stats_renderer.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import type { StatsData } from '../src/render/types.js'
import { dataDir } from '../src/constants.js'
import { invalidateConfigCache } from '../src/config.js'

// Every test here is hermetic: TOKEN_GOAT_OFFLINE is on unless a test turns it off, and a test that goes online points npm and the HTTP fallback at a fake registry on 127.0.0.1 with a temp npm cache, prefix and userconfig. Nothing reaches the public registry and nothing installs globally.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const cachePath = (): string => path.join(dataDir(), 'update_check.json')

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
  return { logs, errors }
}

const mockStats: StatsData = {
  period_start: new Date(0),
  period_end: new Date(86_400_000),
  totals: { events: 10, bytes: 500, tokens: 100, sparklines: null },
  by_kind: [{ kind: 'read', bytes: 500, tokens: 100, events: 10, bytes_mode_only: false }],
  by_day: [],
  by_project: [],
  by_command: [{ command: 'read', events: 10, bytes: 500, tokens: 100 }],
}

let savedExitCode: typeof process.exitCode

beforeEach(() => {
  savedExitCode = process.exitCode
  vi.stubEnv('TOKEN_GOAT_OFFLINE', '1')
  invalidateConfigCache()
  fs.rmSync(cachePath(), { force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  invalidateConfigCache()
  fs.rmSync(cachePath(), { force: true })
  process.exitCode = savedExitCode
})

describe('compareSemver', () => {
  // HAND-DERIVED: semver ordering of the numeric triple; a prerelease tag is ignored for ordering.
  it('correctly compares equal versions', () => {
    expect(compareSemver('2.9.12', '2.9.12')).toBe(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('correctly identifies a newer version', () => {
    expect(compareSemver('2.10.0', '2.9.12')).toBe(1)
    expect(compareSemver('3.0.0', '2.9.12')).toBe(1)
    expect(compareSemver('2.9.13', '2.9.12')).toBe(1)
  })

  it('correctly identifies an older version', () => {
    expect(compareSemver('2.9.11', '2.9.12')).toBe(-1)
    expect(compareSemver('1.9.12', '2.9.12')).toBe(-1)
  })

  it('compares the numeric part of a prerelease version', () => {
    expect(compareSemver('2.10.0-beta.1', '2.9.12')).toBe(1)
    expect(compareSemver('2.9.12-rc.1', '2.9.12')).toBe(0)
  })
})

describe('registry resolution', () => {
  // FORMAT-DERIVED: npm reads its config from npm_config_* environment variables in either case (docs.npmjs.com/cli/using-npm/config, "Environment Variables").
  it('defaults to npmjs.org when no registry env vars are set', () => {
    vi.stubEnv('npm_config_registry', undefined)
    vi.stubEnv('NPM_CONFIG_REGISTRY', undefined)
    expect(getRegistryUrl()).toBe('https://registry.npmjs.org/')
  })

  it('honors npm_config_registry from an Artifactory config and adds the trailing slash', () => {
    vi.stubEnv('NPM_CONFIG_REGISTRY', undefined)
    vi.stubEnv('npm_config_registry', 'https://artifactory.corp.internal/artifactory/api/npm/npm-virtual')
    expect(getRegistryUrl()).toBe('https://artifactory.corp.internal/artifactory/api/npm/npm-virtual/')
  })

  it('honors the uppercase NPM_CONFIG_REGISTRY', () => {
    vi.stubEnv('npm_config_registry', undefined)
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://nexus.corp.internal/repository/npm-group/')
    expect(getRegistryUrl()).toBe('https://nexus.corp.internal/repository/npm-group/')
  })
})

describe('update check cache', () => {
  function seed(ageMs: number, latest: string | null, extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(cachePath(), JSON.stringify({ checkedAt: Date.now() - ageMs, current: VERSION, latest, updateAvailable: latest !== null, ...extra }))
  }

  it('round-trips a cached status and serves it within the TTL', async () => {
    saveCachedUpdateStatus({ checkedAt: Date.now(), current: VERSION, latest: '99.0.0', updateAvailable: true })
    expect(getCachedUpdateStatus()?.latest).toBe('99.0.0')
    const status = await checkUpdateStatus(100, false)
    expect(status.latest).toBe('99.0.0')
    expect(status.updateAvailable).toBe(true)
  })

  it('serves a successful check for up to 24 hours and no longer', async () => {
    seed(2 * 60 * 60 * 1000, '99.0.0')
    expect((await checkUpdateStatus(100)).latest).toBe('99.0.0')
    seed(UPDATE_CACHE_TTL_MS + 60 * 60 * 1000, '99.0.0')
    const stale = await checkUpdateStatus(100)
    expect(stale.latest).toBeNull()
    expect(stale.error).toContain('network.offline')
  })

  it('serves a failed check for an hour only, so a transient outage does not hide an update for a day', async () => {
    seed(60 * 1000, null, { error: 'boom' })
    expect((await checkUpdateStatus(100)).error).toBe('boom')
    seed(FAILED_CHECK_TTL_MS + 60 * 60 * 1000, null, { error: 'boom' })
    expect((await checkUpdateStatus(100)).error).toContain('network.offline')
  })

  it('recomputes updateAvailable against the running version, so an upgrade does not leave a stale notice', () => {
    // The cache was written by v0.0.1 when VERSION was the newest release; after upgrading to VERSION it is not an update.
    seed(60 * 1000, VERSION, { current: '0.0.1', updateAvailable: true })
    const cached = getCachedUpdateStatus()
    expect(cached?.current).toBe(VERSION)
    expect(cached?.updateAvailable).toBe(false)
    expect(stripAnsiEscapes(renderStats(mockStats))).not.toContain('Update available')
  })

  it('drops a cached latest that is not a version, so it never reaches the terminal', () => {
    seed(60 * 1000, 'evil<x>', { updateAvailable: true })
    const cached = getCachedUpdateStatus()
    expect(cached?.latest).toBeNull()
    expect(cached?.updateAvailable).toBe(false)
  })

  // HAND-DERIVED: the suite runs from this repository, a development checkout, where `upgrade` refuses to replace the install; the cache says 99.0.0 is out.
  it('renders the update insight in token-goat stats with the advice that works from here', () => {
    vi.stubEnv('TOKEN_GOAT_OFFLINE', '0')
    invalidateConfigCache()
    saveCachedUpdateStatus({ checkedAt: Date.now(), current: VERSION, latest: '99.0.0', updateAvailable: true })
    const output = stripAnsiEscapes(renderStats(mockStats))
    expect(output).toContain('Update available:')
    expect(output).toContain(`v${VERSION} → v99.0.0`)
    expect(output).toContain(DEV_CHECKOUT_ADVICE)
    expect(output).not.toContain("Run 'token-goat upgrade'")
  })

  // HAND-DERIVED: offline, `upgrade` makes no check and installs nothing, so a cached update from before going offline has no action to offer.
  it('renders no update insight while offline, when upgrade would do nothing', () => {
    saveCachedUpdateStatus({ checkedAt: Date.now(), current: VERSION, latest: '99.0.0', updateAvailable: true })
    expect(stripAnsiEscapes(renderStats(mockStats))).not.toContain('Update available')
  })
})

describe('updateAdvice', () => {
  // HAND-DERIVED: what cmdUpgrade does for each decision: installs, refuses with the checkout's own update steps, or has nothing to install.
  it('tells an installed copy to run upgrade', () => {
    expect(updateAdvice('install')).toBe("Run 'token-goat upgrade' to update.")
  })
  it('gives a development checkout its own update steps', () => {
    expect(updateAdvice('dev-checkout')).toContain(DEV_CHECKOUT_ADVICE)
    expect(updateAdvice('dev-checkout')).not.toContain('token-goat upgrade')
  })
  it.each(['offline', 'unreachable', 'up-to-date'] as const)('has nothing to say when the decision is %s', (decision) => {
    expect(updateAdvice(decision)).toBeNull()
  })
})

describe('offline', () => {
  it('makes no check and writes no cache, so the next online run checks at once', async () => {
    const status = await checkUpdateStatus(100, true)
    expect(status.latest).toBeNull()
    expect(status.updateAvailable).toBe(false)
    expect(status.error).toContain('network.offline')
    expect(fs.existsSync(cachePath())).toBe(false)
  })

  it('upgrade fails with a message naming network.offline and installs nothing', async () => {
    const { logs, errors } = captureConsole()
    await cmdUpgrade()
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('network.offline is set')
    expect(errors.join('\n')).toContain('nothing was installed')
    expect(logs.join('\n')).not.toContain('Upgrading')
  })

  it('upgrade --check reports the offline setting', async () => {
    const { logs } = captureConsole()
    await cmdUpgrade({ check: true })
    expect(logs.join('\n')).toContain(`Current version: v${VERSION}`)
    expect(logs.join('\n')).toContain('[!] network.offline is set')
  })
})

describe('upgradeDecision', () => {
  // HAND-DERIVED: one row per outcome, in the order the checks run.
  const update = { current: '1.0.0', latest: '2.0.0', updateAvailable: true }
  it.each([
    ['offline wins over everything', update, true, true, 'offline'],
    ['an error is unreachable', { current: '1.0.0', latest: null, updateAvailable: false, error: 'x' }, false, false, 'unreachable'],
    ['no latest is unreachable', { current: '1.0.0', latest: null, updateAvailable: false }, false, false, 'unreachable'],
    ['no newer version is up to date', { current: '2.0.0', latest: '2.0.0', updateAvailable: false }, false, true, 'up-to-date'],
    ['a dev checkout is never replaced', update, false, true, 'dev-checkout'],
    ['an installed copy upgrades', update, false, false, 'install'],
  ] as const)('%s', (_name, status, offline, dev, expected) => {
    expect(upgradeDecision(status, offline, dev)).toBe(expected)
  })
})

describe('npmInvocation', () => {
  // HAND-DERIVED: npm sets npm_execpath to its own npm-cli.js for scripts it runs; the Windows Node.js installer puts npm at <node dir>/node_modules/npm/bin/npm-cli.js.
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const bundled = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'

  it('runs the npm-cli.js that npm_execpath names, with this Node.js', () => {
    const cli = '/usr/lib/node_modules/npm/bin/npm-cli.js'
    expect(npmInvocation({ platform: 'linux', env: { npm_execpath: cli }, execPath: '/usr/bin/node', exists: (p) => p === cli })).toEqual({ file: '/usr/bin/node', prefix: [cli] })
  })

  it('ignores an npm_execpath that is another package manager', () => {
    const yarn = '/usr/lib/node_modules/yarn/bin/yarn.js'
    expect(npmInvocation({ platform: 'linux', env: { npm_execpath: yarn }, execPath: '/usr/bin/node', exists: () => true })).toEqual({ file: 'npm', prefix: [] })
  })

  it('finds the npm bundled next to node.exe on Windows', () => {
    expect(npmInvocation({ platform: 'win32', env: {}, execPath, exists: (p) => p === bundled })).toEqual({ file: execPath, prefix: [bundled] })
  })

  it('returns null on Windows when no bundled npm exists', () => {
    expect(npmInvocation({ platform: 'win32', env: {}, execPath, exists: () => false })).toBeNull()
  })

  it('finds a working npm on this machine', () => {
    // CAPTURE: the real host npm, run the way performUpgrade runs it.
    const npm = npmInvocation({ platform: process.platform, env: process.env, execPath: process.execPath, exists: (p) => fs.existsSync(p) })
    expect(npm).not.toBeNull()
    const res = spawnSync(npm!.file, [...npm!.prefix, '--version'], { encoding: 'utf8', windowsHide: true })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 60_000)
})

describe('dev checkout detection', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-upgrade-root-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('is a checkout only with both .git and the build script', () => {
    expect(isDevCheckout(null)).toBe(false)
    expect(isDevCheckout(tmp)).toBe(false)
    fs.mkdirSync(path.join(tmp, '.git'))
    expect(isDevCheckout(tmp)).toBe(false)
    fs.writeFileSync(path.join(tmp, 'esbuild.config.mjs'), '')
    expect(isDevCheckout(tmp)).toBe(true)
  })

  it('is not a checkout with the build script but no .git', () => {
    // A source tarball or a vendored copy carries the build script without a repository, and has no git pull to recommend.
    fs.writeFileSync(path.join(tmp, 'esbuild.config.mjs'), '')
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'token-goat' }))
    expect(isDevCheckout(tmp)).toBe(false)
  })

  it('recognizes this repository as a checkout', () => {
    expect(isDevCheckout(fs.realpathSync(REPO_ROOT))).toBe(true)
  })

  it('resolves the package root of the running code to this repository under the test runner', () => {
    expect(runningPackageRoot()).toBe(fs.realpathSync(REPO_ROOT))
  })

  it('walks up to the token-goat package.json, and returns null outside one', () => {
    // HAND-DERIVED: the published tarball layout, <root>/package.json beside <root>/dist/token-goat.mjs.
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'token-goat' }))
    fs.mkdirSync(path.join(tmp, 'dist'))
    const bundle = path.join(tmp, 'dist', 'token-goat.mjs')
    fs.writeFileSync(bundle, '')
    expect(runningPackageRoot(pathToFileURL(bundle).href)).toBe(fs.realpathSync(tmp))
    expect(isDevCheckout(runningPackageRoot(pathToFileURL(bundle).href))).toBe(false)

    const other = path.join(tmp, 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'not-token-goat' }))
    fs.writeFileSync(path.join(other, 'x.mjs'), '')
    // A dependency's own package.json is passed over on the way up to token-goat's.
    expect(runningPackageRoot(pathToFileURL(path.join(other, 'x.mjs')).href)).toBe(fs.realpathSync(tmp))
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-upgrade-none-'))
    try {
      fs.writeFileSync(path.join(elsewhere, 'x.mjs'), '')
      expect(runningPackageRoot(pathToFileURL(path.join(elsewhere, 'x.mjs')).href)).toBeNull()
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('performUpgrade', () => {
  // HAND-DERIVED: a stand-in npm that logs its argv and answers `root -g` and `install -g`; it is passed in, so no real npm runs.
  let tmp: string
  let log: string
  let fakeNpm: string
  let globalRoot: string

  const FAKE_NPM = [
    "const fs = require('node:fs')",
    'const a = process.argv.slice(2)',
    "fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(a) + '\\n')",
    "if (a[0] === 'root') { process.stdout.write((process.env.FAKE_NPM_ROOT || '') + '\\n'); process.exit(0) }",
    "if (a[0] === 'install') process.exit(Number(process.env.FAKE_NPM_INSTALL_EXIT || '0'))",
  ].join('\n')
  const FAKE_LAUNCHER = [
    "import fs from 'node:fs'",
    "fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(['launcher', ...process.argv.slice(2)]) + '\\n')",
    "process.exit(Number(process.env.FAKE_LAUNCHER_EXIT || '0'))",
  ].join('\n')

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-upgrade-npm-'))
    log = path.join(tmp, 'npm.log')
    fakeNpm = path.join(tmp, 'npm-cli.cjs')
    fs.writeFileSync(fakeNpm, FAKE_NPM)
    globalRoot = path.join(tmp, 'global', 'node_modules')
    fs.mkdirSync(path.join(globalRoot, 'token-goat', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(globalRoot, 'token-goat', 'dist', 'token-goat.mjs'), FAKE_LAUNCHER)
    vi.stubEnv('FAKE_NPM_LOG', log)
    vi.stubEnv('FAKE_NPM_ROOT', globalRoot)
    vi.stubEnv('FAKE_NPM_INSTALL_EXIT', '0')
    vi.stubEnv('FAKE_LAUNCHER_EXIT', '0')
    captureConsole()
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const calls = (): unknown[][] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown[]) : []
  const npm = (): { file: string; prefix: string[] } => ({ file: process.execPath, prefix: [fakeNpm] })

  it('installs, then runs install from the NEW copy rather than the old in-process code', async () => {
    const onSync = vi.fn(async () => undefined)
    expect(await performUpgrade(onSync, npm())).toEqual({ ok: true })
    expect(calls()).toEqual([['install', '-g', 'token-goat@latest'], ['root', '-g'], ['launcher', 'install']])
    expect(onSync).not.toHaveBeenCalled()
  })

  it('reports a failed install and syncs nothing', async () => {
    vi.stubEnv('FAKE_NPM_INSTALL_EXIT', '1')
    const outcome = await performUpgrade(undefined, npm())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('npm install failed')
    expect(calls()).toEqual([['install', '-g', 'token-goat@latest']])
  })

  it('falls back to the in-process sync when npm cannot name the new copy', async () => {
    vi.stubEnv('FAKE_NPM_ROOT', '')
    const onSync = vi.fn(async () => undefined)
    expect(await performUpgrade(onSync, npm())).toEqual({ ok: true })
    expect(onSync).toHaveBeenCalledOnce()
  })

  it('reports a failed install sync from the new copy', async () => {
    vi.stubEnv('FAKE_LAUNCHER_EXIT', '3')
    const outcome = await performUpgrade(undefined, npm())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("'token-goat install' failed (exit code 3)")
  })

  it('tells the user what to run when no npm can be found', async () => {
    const outcome = await performUpgrade(undefined, null)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('npm install -g token-goat@latest')
  })
})

describe('against a registry', () => {
  // FORMAT-DERIVED: the packument and version-document shapes of the npm registry API (github.com/npm/registry, docs/REGISTRY-API.md): GET /{package} returns dist-tags and versions, GET /{package}/{tag} returns that version's manifest. The base path picks the version served: /new/ is 99.0.0, /same/ is the running version, /bad/ is not a version at all.
  const REGISTRY = [
    "const http = require('node:http')",
    'const versions = JSON.parse(process.argv[2])',
    'const server = http.createServer((req, res) => {',
    "  const parts = (req.url || '').split('?')[0].split('/').filter(Boolean)",
    '  const v = versions[parts[0]]',
    "  const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }",
    "  const base = 'http://127.0.0.1:' + server.address().port + '/' + parts[0]",
    "  const manifest = { name: 'token-goat', version: v, dist: { tarball: base + '/token-goat/-/token-goat-' + v + '.tgz', shasum: '0000000000000000000000000000000000000000' } }",
    "  if (v && parts.length === 2 && parts[1] === 'token-goat') return send({ name: 'token-goat', 'dist-tags': { latest: v }, versions: { [v]: manifest }, time: {} })",
    "  if (v && parts.length === 3 && parts[1] === 'token-goat' && parts[2] === 'latest') return send(manifest)",
    '  res.writeHead(404); res.end()',
    '})',
    "server.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + server.address().port + '\\n'))",
  ].join('\n')

  let dir: string
  let server: ChildProcess
  let port = 0

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-upgrade-registry-'))
    const script = path.join(dir, 'registry.cjs')
    fs.writeFileSync(script, REGISTRY)
    // A child process, not an in-process server: fetchViaNpm blocks the event loop in spawnSync while npm talks to it.
    server = spawn(process.execPath, [script, JSON.stringify({ new: '99.0.0', same: VERSION, bad: '1.0.0<script>' })], { stdio: ['ignore', 'pipe', 'inherit'] })
    port = await new Promise<number>((resolve, reject) => {
      let out = ''
      server.stdout!.on('data', (c: Buffer) => {
        out += c.toString()
        const m = /PORT (\d+)/.exec(out)
        if (m) resolve(Number(m[1]))
      })
      server.on('exit', (code) => reject(new Error(`fake registry exited (${code})`)))
    })
  })

  afterAll(() => {
    server?.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function online(tag: string): string {
    const url = `http://127.0.0.1:${port}/${tag}/`
    vi.stubEnv('TOKEN_GOAT_OFFLINE', '0')
    vi.stubEnv('npm_config_registry', url)
    vi.stubEnv('NPM_CONFIG_REGISTRY', url)
    vi.stubEnv('npm_config_cache', path.join(dir, 'npm-cache'))
    vi.stubEnv('npm_config_prefix', path.join(dir, 'npm-prefix'))
    vi.stubEnv('npm_config_userconfig', path.join(dir, 'npmrc'))
    vi.stubEnv('npm_config_update_notifier', 'false')
    invalidateConfigCache()
    return url
  }

  it('npm view reads the latest version from the configured registry', () => {
    // CAPTURE: the real npm on this machine, against the fake registry.
    online('new')
    expect(fetchViaNpm(30_000)).toBe('99.0.0')
  }, 60_000)

  it('the HTTP fallback reads the same version', async () => {
    expect(await fetchViaHttp(online('new'), 10_000)).toBe('99.0.0')
  })

  it('the HTTP fallback rejects a version string that is not semver', async () => {
    expect(await fetchViaHttp(online('bad'), 10_000)).toBeNull()
  })

  it('upgrade from a development checkout reports the update and replaces nothing', async () => {
    online('new')
    const { logs } = captureConsole()
    await cmdUpgrade()
    const out = logs.join('\n')
    expect(out).toContain(`Update available: v${VERSION} -> v99.0.0`)
    expect(out).toContain('development checkout')
    expect(out).toContain(DEV_CHECKOUT_ADVICE)
    expect(out).not.toContain('Upgrading')
    expect(process.exitCode).toBe(savedExitCode)
  }, 60_000)

  it('upgrade --check --json reports the newer version and caches it', async () => {
    online('new')
    const { logs } = captureConsole()
    await cmdUpgrade({ check: true, json: true })
    const parsed = JSON.parse(logs[0]!) as { current: string; latest: string; updateAvailable: boolean }
    expect(parsed).toMatchObject({ current: VERSION, latest: '99.0.0', updateAvailable: true })
    expect(getCachedUpdateStatus()?.latest).toBe('99.0.0')
  }, 60_000)

  it('upgrade --check says up to date when the registry has the running version', async () => {
    online('same')
    const { logs } = captureConsole()
    await cmdUpgrade({ check: true })
    expect(logs.join('\n')).toContain(`token-goat is up to date (v${VERSION})`)
  }, 60_000)
})
