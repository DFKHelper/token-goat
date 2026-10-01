/**
 * Upgrade command for token-goat.
 *
 * Checks npm registry for updates, runs npm install -g token-goat@latest,
 * and automatically re-syncs hooks and bridge configurations via cmdInstall.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import { createRequire } from 'node:module'
import { VERSION } from './version.js'
import { loadConfig } from './config.js'
import { displaySafeJson } from './paths.js'
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

export interface CachedUpdateInfo {
  checkedAt: number
  current: string
  latest: string | null
  updateAvailable: boolean
  error?: string | undefined
}

export function getCachedUpdateStatus(): CachedUpdateInfo | null {
  try {
    const cachePath = path.join(dataDir(), 'update_check.json')
    if (!fs.existsSync(cachePath)) return null
    const raw = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as CachedUpdateInfo
    if (parsed && typeof parsed.checkedAt === 'number') {
      return parsed
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

/**
 * Resolves the active npm registry URL.
 * Honors NPM_CONFIG_REGISTRY, npm_config_registry, and defaults to npmjs.org.
 */
export function getRegistryUrl(): string {
  const envRegistry = process.env['NPM_CONFIG_REGISTRY'] || process.env['npm_config_registry']
  if (envRegistry && typeof envRegistry === 'string') {
    return envRegistry.endsWith('/') ? envRegistry : `${envRegistry}/`
  }
  return 'https://registry.npmjs.org/'
}

/**
 * Attempt to query latest published version via `npm view token-goat version`.
 * This delegates directly to npm, inheriting Artifactory authentication tokens,
 * corporate TLS certs (cafile), and proxy settings automatically.
 */
export function fetchViaNpm(timeoutMs = 2500): string | null {
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const res = spawnSync(npmCmd, ['view', 'token-goat', 'version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    if (res.status === 0 && res.stdout) {
      const trimmed = res.stdout.trim()
      if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(trimmed)) {
        return trimmed
      }
    }
  } catch {
    // Fall back to direct HTTP
  }
  return null
}

/**
 * Fetch latest published version via HTTP/HTTPS request to the configured registry.
 * Supports both public npm and corporate Artifactory / Nexus mirrors.
 */
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
              if (version && typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
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

/**
 * Fetch latest published version of token-goat.
 * 1. Checks `npm view token-goat version` (native Artifactory, proxy & auth support)
 * 2. Falls back to direct HTTP/HTTPS request against the configured registry URL
 */
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

/**
 * Simple semver comparator: returns 1 if a > b, -1 if a < b, 0 if equal.
 */
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
    if (cached && (Date.now() - cached.checkedAt) < UPDATE_CACHE_TTL_MS) {
      const updateAvailable = cached.latest ? compareSemver(cached.latest, VERSION) > 0 : false
      return {
        current: VERSION,
        latest: cached.latest,
        updateAvailable,
        error: cached.error,
      }
    }
  }

  const latest = await fetchLatestVersion(timeoutMs)
  if (!latest) {
    const result: VersionCheckResult = {
      current: VERSION,
      latest: null,
      updateAvailable: false,
      error: 'Could not reach npm or internal registry (offline or request timed out)',
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

  // Check if running from a local git repository working tree
  const isLocalGitRepo =
    fs.existsSync(path.join(process.cwd(), '.git')) &&
    fs.existsSync(path.join(process.cwd(), 'esbuild.config.mjs'))

  if (isLocalGitRepo) {
    console.log(`Detected local token-goat development repository.`)
    console.log(`To update your local build, run:`)
    console.log(`  git pull && npm run build && token-goat install`)
    return
  }

  console.log(`Upgrading token-goat to latest...`)
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmRes = spawnSync(npmCmd, ['install', '-g', 'token-goat@latest'], {
    stdio: 'inherit',
  })

  if (npmRes.status !== 0) {
    console.error(`npm install failed with exit code ${npmRes.status ?? 1}.`)
    process.exit(npmRes.status ?? 1)
  }

  console.log(`Syncing token-goat hooks and integration manifests...`)
  if (onSyncHooks) {
    await onSyncHooks()
  }
  console.log(`[✓] token-goat successfully updated.`)
}
