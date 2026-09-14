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
import { VERSION } from './version.js'
import { loadConfig } from './config.js'
import { displaySafeJson } from './paths.js'

export interface UpgradeOptions {
  check?: boolean
  json?: boolean
}

export interface VersionCheckResult {
  current: string
  latest: string | null
  updateAvailable: boolean
  error?: string
}

/**
 * Fetch latest published version of token-goat from npm registry.
 * Timeboxed with a strict 3500ms timeout to prevent hanging.
 */
export async function fetchLatestVersion(timeoutMs = 3500): Promise<string | null> {
  if (loadConfig().network.offline) {
    return null
  }
  return new Promise((resolve) => {
    const req = https.get(
      'https://registry.npmjs.org/token-goat/latest',
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
          // Bound payload read to 32KB
          if (data.length > 32768) {
            req.destroy()
            resolve(null)
          }
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { version?: string }
            resolve(typeof parsed.version === 'string' ? parsed.version : null)
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
  })
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

export async function checkUpdateStatus(timeoutMs = 3500): Promise<VersionCheckResult> {
  const latest = await fetchLatestVersion(timeoutMs)
  if (!latest) {
    return {
      current: VERSION,
      latest: null,
      updateAvailable: false,
      error: 'Could not reach npm registry (offline or request timed out)',
    }
  }
  const updateAvailable = compareSemver(latest, VERSION) > 0
  return {
    current: VERSION,
    latest,
    updateAvailable,
  }
}

export async function cmdUpgrade(
  opts: UpgradeOptions = {},
  onSyncHooks?: () => Promise<void>,
): Promise<void> {
  const status = await checkUpdateStatus()

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
