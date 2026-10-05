/** Upgrade command for token-goat. Checks npm registry for updates, runs npm install -g token-goat@latest, and re-syncs hooks and bridge configurations by running the newly installed `token-goat install`. */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.js'
import { loadConfig } from './config.js'
import { displaySafeJson } from './paths.js'
import { formatCommandError } from './command_error.js'
import { dataDir } from './constants.js'
import { ensureDirSync } from './util.js'

const require = createRequire(import.meta.url)

export interface UpgradeOptions {
  check?: boolean
  json?: boolean
}

export interface VersionCheckResult {
  current: string
  latest: string | null
  updateAvailable: boolean
  error?: string | undefined
}

export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** A published version string. The registry's answer reaches the session-start context and the terminal, so anything else is dropped rather than shown. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/

export interface CachedUpdateInfo {
  checkedAt: number
  current: string
  latest: string | null
  updateAvailable: boolean
  error?: string | undefined
}

/** A failed check is retried after an hour rather than a day, so one dropped connection does not hide a release until tomorrow. */
export const FAILED_CHECK_TTL_MS = 60 * 60 * 1000

/** The last check, measured against the version running now rather than the one that wrote it: once an upgrade lands, a cache written before it would otherwise keep announcing the version just installed. */
export function getCachedUpdateStatus(): CachedUpdateInfo | null {
  try {
    const cachePath = path.join(dataDir(), 'update_check.json')
    if (!fs.existsSync(cachePath)) return null
    const raw = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as CachedUpdateInfo
    if (parsed && typeof parsed.checkedAt === 'number') {
      const latest = typeof parsed.latest === 'string' && SEMVER.test(parsed.latest) ? parsed.latest : null
      return { checkedAt: parsed.checkedAt, current: VERSION, latest, updateAvailable: latest !== null && compareSemver(latest, VERSION) > 0, error: latest === null && typeof parsed.error === 'string' ? parsed.error : undefined }
    }
  } catch {
    // Non-fatal if unreadable or corrupted
  }
  return null
}

export function saveCachedUpdateStatus(info: CachedUpdateInfo): void {
  try {
    const dir = dataDir()
    ensureDirSync(dir)
    const cachePath = path.join(dir, 'update_check.json')
    fs.writeFileSync(cachePath, JSON.stringify(info, null, 2), 'utf8')
  } catch {
    // Non-fatal
  }
}

/** Resolves the active npm registry URL. Honors NPM_CONFIG_REGISTRY, npm_config_registry, and defaults to npmjs.org. */
export function getRegistryUrl(): string {
  const envRegistry = process.env['NPM_CONFIG_REGISTRY'] || process.env['npm_config_registry']
  if (envRegistry && typeof envRegistry === 'string') {
    return envRegistry.endsWith('/') ? envRegistry : `${envRegistry}/`
  }
  return 'https://registry.npmjs.org/'
}

export interface NpmInvocation {
  file: string
  prefix: string[]
}

/** How to run npm without a shell. On Windows npm is `npm.cmd`, a batch file, and Node refuses to spawn one without `shell: true` since the CVE-2024-27980 fix (EINVAL), so there it runs as `node npm-cli.js`: the copy npm names in npm_execpath when it launched us, else the one bundled beside node.exe. Ported from scripts/dependabot-body.mjs::npmCommand. Null when no npm can be found. */
export function npmInvocation(host: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; execPath: string; exists: (p: string) => boolean }): NpmInvocation | null {
  const named = host.env['npm_execpath']
  if (typeof named === 'string' && /(?:^|[\\/])npm-cli\.js$/.test(named) && host.exists(named)) return { file: host.execPath, prefix: [named] }
  if (host.platform !== 'win32') return { file: 'npm', prefix: [] }
  const bundled = path.win32.join(path.win32.dirname(host.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return host.exists(bundled) ? { file: host.execPath, prefix: [bundled] } : null
}

function hostNpm(): NpmInvocation | null {
  return npmInvocation({ platform: process.platform, env: process.env, execPath: process.execPath, exists: (p) => fs.existsSync(p) })
}

/** The root of the token-goat package this code is running from: the bundle's `dist/` parent once installed, the repository root under the test runner. Symlinks are resolved first, so a global install made with `npm install -g .` (a link) resolves to the checkout it points at. */
export function runningPackageRoot(moduleUrl: string = import.meta.url): string | null {
  let dir: string
  try {
    dir = fs.realpathSync(path.dirname(fileURLToPath(moduleUrl)))
  } catch {
    return null
  }
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (pkg.name === 'token-goat') return dir
    } catch {
      // no package.json here, or not JSON: keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Whether a package root is a development checkout rather than a published install: the published tarball carries neither `.git` nor the build script. */
export function isDevCheckout(root: string | null): boolean {
  return root !== null && fs.existsSync(path.join(root, '.git')) && fs.existsSync(path.join(root, 'esbuild.config.mjs'))
}

export type UpgradeDecision = 'offline' | 'unreachable' | 'up-to-date' | 'dev-checkout' | 'install'

/** What an upgrade should do with a version check. Installs only when a newer version was actually seen and the running copy is a published install: a failed or offline check is not news of an update, and installing from the registry over a checkout would replace the developer's own build. */
export function upgradeDecision(status: VersionCheckResult, offline: boolean, devCheckout: boolean): UpgradeDecision {
  if (offline) return 'offline'
  if (status.error || !status.latest) return 'unreachable'
  if (!status.updateAvailable) return 'up-to-date'
  if (devCheckout) return 'dev-checkout'
  return 'install'
}

/** upgradeDecision for this process: the offline setting and the running package's location filled in. `upgrade` and `doctor --fix` both decide through here, so the offline gate lives in this module, which owns every request the decision follows from. */
export function currentUpgradeDecision(status: VersionCheckResult): UpgradeDecision {
  return upgradeDecision(status, loadConfig().network.offline, isDevCheckout(runningPackageRoot()))
}

export const DEV_CHECKOUT_ADVICE = 'git pull && npm run build && token-goat install'

/** What to tell the user to do about an update, or null when there is nothing to do. Every surface that announces an update (doctor, stats, the session-start reminder) words it through here, so none tells a development checkout to run `upgrade`, which refuses there, and none announces an update while offline, when `upgrade` would make no check. */
export function updateAdvice(decision: UpgradeDecision): string | null {
  if (decision === 'install') return "Run 'token-goat upgrade' to update."
  if (decision === 'dev-checkout') return `This token-goat runs from a development checkout. To update it, run: ${DEV_CHECKOUT_ADVICE}`
  return null
}

/** Attempt to query latest published version via `npm view token-goat version`. This delegates directly to npm, inheriting Artifactory authentication tokens, corporate TLS certs (cafile), and proxy settings automatically. */
export function fetchViaNpm(timeoutMs = 2500): string | null {
  const npm = hostNpm()
  if (!npm) return null
  try {
    const res = spawnSync(npm.file, [...npm.prefix, 'view', 'token-goat', 'version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    if (res.status === 0 && res.stdout) {
      const trimmed = res.stdout.trim()
      if (SEMVER.test(trimmed)) {
        return trimmed
      }
    }
  } catch {
    // Fall back to direct HTTP
  }
  return null
}

/** Fetch latest published version via HTTP/HTTPS request to the configured registry. Supports both public npm and corporate Artifactory / Nexus mirrors. */
export async function fetchViaHttp(registryUrl: string, timeoutMs = 3500): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const cleanUrl = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`
      const targetUrl = new URL(`token-goat/latest`, cleanUrl)
      const isHttps = targetUrl.protocol === 'https:'
      const getFn = isHttps ? https.get : (require('node:http').get as typeof https.get)

      const req = getFn(
        targetUrl,
        {
          headers: { 'User-Agent': `token-goat/${VERSION} (node/${process.version})` },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume()
            resolve(null)
            return
          }
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            data += chunk
            if (data.length > 32768) {
              req.destroy()
              resolve(null)
            }
          })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as { version?: string; 'dist-tags'?: { latest?: string } }
              const version = parsed.version || parsed['dist-tags']?.latest
              if (version && typeof version === 'string' && SEMVER.test(version)) {
                resolve(version)
              } else {
                resolve(null)
              }
            } catch {
              resolve(null)
            }
          })
        },
      )

      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })

      req.on('error', () => {
        resolve(null)
      })
    } catch {
      resolve(null)
    }
  })
}

/** Fetch latest published version of token-goat. 1. Checks `npm view token-goat version` (native Artifactory, proxy & auth support) 2. Falls back to direct HTTP/HTTPS request against the configured registry URL */
export async function fetchLatestVersion(timeoutMs = 3500): Promise<string | null> {
  if (loadConfig().network.offline) {
    return null
  }
  const npmVersion = fetchViaNpm(Math.min(timeoutMs, 2500))
  if (npmVersion) {
    return npmVersion
  }
  const registryUrl = getRegistryUrl()
  return fetchViaHttp(registryUrl, timeoutMs)
}

/** Simple semver comparator: returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('-')[0]!.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

export async function checkUpdateStatus(
  timeoutMs = 3500,
  forceFresh = false,
): Promise<VersionCheckResult> {
  if (!forceFresh) {
    const cached = getCachedUpdateStatus()
    if (cached && (Date.now() - cached.checkedAt) < (cached.latest ? UPDATE_CACHE_TTL_MS : FAILED_CHECK_TTL_MS)) {
      return { current: VERSION, latest: cached.latest, updateAvailable: cached.updateAvailable, error: cached.error }
    }
  }

  const latest = await fetchLatestVersion(timeoutMs)
  if (!latest) {
    // Offline made no request, so it is not a failed check: caching it would keep the next online run from checking for an hour.
    if (loadConfig().network.offline) {
      return { current: VERSION, latest: null, updateAvailable: false, error: 'network.offline is set, so no update check was made' }
    }
    const result: VersionCheckResult = {
      current: VERSION,
      latest: null,
      updateAvailable: false,
      error: 'Could not reach npm or internal registry (request failed or timed out)',
    }
    saveCachedUpdateStatus({
      checkedAt: Date.now(),
      current: VERSION,
      latest: null,
      updateAvailable: false,
      error: result.error,
    })
    return result
  }
  const updateAvailable = compareSemver(latest, VERSION) > 0
  const result: VersionCheckResult = {
    current: VERSION,
    latest,
    updateAvailable,
  }
  saveCachedUpdateStatus({
    checkedAt: Date.now(),
    current: VERSION,
    latest,
    updateAvailable,
  })
  return result
}

export async function cmdUpgrade(
  opts: UpgradeOptions = {},
  onSyncHooks?: () => Promise<void>,
): Promise<void> {
  const status = await checkUpdateStatus(3500, true)

  if (opts.check) {
    if (opts.json) {
      console.log(displaySafeJson(status, 2))
      return
    }
    if (status.error) {
      console.log(`Current version: v${status.current}`)
      console.log(`[!] ${status.error}`)
      return
    }
    if (status.updateAvailable && status.latest) {
      console.log(`Update available: v${status.current} -> v${status.latest}`)
      console.log(`Run 'token-goat upgrade' to update.`)
    } else {
      console.log(`token-goat is up to date (v${status.current})`)
    }
    return
  }

  const decision = currentUpgradeDecision(status)
  switch (decision) {
    case 'offline':
      console.error(formatCommandError('network.offline is set, so no update check was made and nothing was installed. Unset it (or TOKEN_GOAT_OFFLINE) to upgrade.'))
      process.exitCode = 1
      return
    case 'unreachable':
      console.error(formatCommandError(`${status.error ?? 'could not determine the latest version'}. Nothing was installed.`))
      process.exitCode = 1
      return
    case 'up-to-date':
      console.log(`token-goat is up to date (v${status.current})`)
      return
    case 'dev-checkout':
      console.log(`Update available: v${status.current} -> v${status.latest}`)
      console.log(`This token-goat runs from a development checkout, so it was not replaced. To update it, run:`)
      console.log(`  ${DEV_CHECKOUT_ADVICE}`)
      return
    case 'install':
      break
  }

  console.log(`Upgrading token-goat v${status.current} -> v${status.latest}...`)
  const outcome = await performUpgrade(onSyncHooks)
  if (!outcome.ok) {
    console.error(formatCommandError(outcome.message))
    process.exitCode = 1
    return
  }
  console.log(`[✓] token-goat successfully updated.`)
}

export type UpgradeOutcome = { ok: true } | { ok: false; message: string }

const MANUAL_INSTALL = 'npm install -g token-goat@latest'

/** Installs the latest token-goat globally, then re-runs `token-goat install` from the NEW copy so hooks and bridge manifests match the code now installed. Never exits the process: `doctor --fix` calls this mid-repair. The worker and the resident hook servers are stopped first, because on Windows the native modules they hold open from the global install make npm's replace fail with EPERM; the next hook restarts both from the new copy. */
export async function performUpgrade(onSyncHooks?: () => Promise<void>, npm: NpmInvocation | null = hostNpm()): Promise<UpgradeOutcome> {
  if (!npm) return { ok: false, message: `npm was not found next to this Node.js, so token-goat could not upgrade itself. Run '${MANUAL_INSTALL}' yourself.` }
  try {
    const { stopWorker } = await import('./worker_lifecycle.js')
    const { queryServers } = await import('./hook_client.js')
    await queryServers('stop')
    stopWorker()
  } catch {
    // Nothing running, or unreadable state: the install below reports any lock it actually hits.
  }
  const install = spawnSync(npm.file, [...npm.prefix, 'install', '-g', 'token-goat@latest'], { stdio: 'inherit', windowsHide: true })
  if (install.status !== 0) {
    const why = install.error ? install.error.message : `exit code ${install.status ?? 'unknown'}`
    return { ok: false, message: `npm install failed (${why}). If npm reported EPERM or EBUSY, another program still has token-goat's files open: close running agent sessions and run '${MANUAL_INSTALL}'.` }
  }
  console.log(`Syncing token-goat hooks and integration manifests...`)
  const launcher = installedLauncher(npm)
  if (launcher) {
    const sync = spawnSync(process.execPath, [launcher, 'install'], { stdio: 'inherit', windowsHide: true })
    if (sync.status !== 0) return { ok: false, message: `the new version installed, but 'token-goat install' failed (exit code ${sync.status ?? 'unknown'}). Run 'token-goat install' to finish.` }
    return { ok: true }
  }
  try {
    if (onSyncHooks) await onSyncHooks()
  } catch (e) {
    return { ok: false, message: `the new version installed, but syncing hooks failed (${e instanceof Error ? e.message : String(e)}). Run 'token-goat install' to finish.` }
  }
  return { ok: true }
}

/** The bundle npm just installed, found from `npm root -g`. Null when npm cannot say or the file is not there. */
function installedLauncher(npm: NpmInvocation): string | null {
  const res = spawnSync(npm.file, [...npm.prefix, 'root', '-g'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const root = res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : ''
  if (!root) return null
  const launcher = path.join(root, 'token-goat', 'dist', 'token-goat.mjs')
  return fs.existsSync(launcher) ? launcher : null
}
