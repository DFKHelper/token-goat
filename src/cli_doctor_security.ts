/**
 * Security posture and configuration override diagnostics for token-goat doctor.
 *
 * Checks network offline mode, injection scanning, Google Drive integration,
 * fetch allow/deny policies, secret redaction patterns, MCP root confinement,
 * cross-project symbol exposure, locked config environment overrides, and data directory permissions.
 */

import * as fs from 'node:fs'

import { CONFIG_KEY_ENV_OVERRIDES, PROJECT_LOCKED_KEYS, PROJECT_LOCKED_SECTIONS, type Config } from './config.js'
import type { DoctorResult } from './doctor_result.js'
import { envBool } from './env.js'
import { compileCustomPatterns } from './secret_redact.js'

/**
 * The safe direction for each project-locked setting that is a boolean.
 */
export const LOCKED_BOOLEAN_SAFE_VALUE: Readonly<Record<string, boolean>> = {
  'gdrive.enabled': false,
  'injection.enabled': true,
  'redaction.strict': true,
  'mcp.confine_reads_to_project_root': true,
  'screenshot.block_private_targets': true,
  'network.offline': true,
  'indexing.cross_project_symbols': false,
  'webfetch.compress_bodies': true,
}

/**
 * Every project-locked config key that an environment variable can still override.
 */
export function lockedEnvOverridableKeys(): string[] {
  const out: string[] = []
  for (const key of Object.keys(CONFIG_KEY_ENV_OVERRIDES)) {
    const section = key.split('.')[0] ?? ''
    const locked = PROJECT_LOCKED_SECTIONS.includes(section) || PROJECT_LOCKED_KEYS.includes(key)
    if (locked && (CONFIG_KEY_ENV_OVERRIDES[key] ?? []).length > 0) out.push(key)
  }
  return out.sort()
}

/** One locked setting the environment is currently deciding, and how it is deciding it. */
export interface EnvOverriddenSetting {
  readonly setting: string
  readonly envVar: string
  readonly kind: 'weakened' | 'replaced'
}

/**
 * Locked settings the environment is holding open or replacing.
 */
export function envOverriddenSecuritySettings(): EnvOverriddenSetting[] {
  const out: EnvOverriddenSetting[] = []
  for (const setting of lockedEnvOverridableKeys()) {
    const safe = LOCKED_BOOLEAN_SAFE_VALUE[setting]
    for (const envVar of CONFIG_KEY_ENV_OVERRIDES[setting] ?? []) {
      if (safe === undefined) {
        const raw = process.env[envVar]
        if (raw !== undefined && raw.trim() !== '') out.push({ setting, envVar, kind: 'replaced' })
      } else if (envBool(envVar, safe) !== safe) {
        out.push({ setting, envVar, kind: 'weakened' })
      }
    }
  }
  return out
}

/** Owner-only is the shipped mode; anything looser means another local user can read the index. */
export function dataDirPermissionResult(dataDirPath: string): DoctorResult {
  if (process.platform === 'win32') {
    return { name: 'Security data dir', status: 'ok', message: 'inherits the parent ACL (POSIX modes do not apply on Windows)' }
  }
  try {
    const mode = fs.statSync(dataDirPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      return {
        name: 'Security data dir',
        status: 'warn',
        message: `mode ${mode.toString(8).padStart(3, '0')}: other local users can read the indexed source text`,
      }
    }
    return { name: 'Security data dir', status: 'ok', message: `mode ${mode.toString(8).padStart(3, '0')}: owner only` }
  } catch {
    return { name: 'Security data dir', status: 'warn', message: 'could not be read, so its permissions are unknown' }
  }
}

export function checkSecurityPosture(cfg: Config, dataDirPath: string): DoctorResult[] {
  const results: DoctorResult[] = []

  results.push({
    name: 'Security network',
    status: 'ok',
    message: cfg.network.offline
      ? 'offline mode is on: no fetch, model download, OCR data, screenshot, or Drive call'
      : 'offline mode is off (network.offline)',
  })

  results.push(
    cfg.injection.enabled
      ? { name: 'Security injection', status: 'ok', message: 'fetched and MCP content is scanned and fenced' }
      : { name: 'Security injection', status: 'warn', message: 'scanning is off (injection.enabled): fetched and MCP content reaches the model unfenced' },
  )

  results.push({
    name: 'Security gdrive',
    status: 'ok',
    message: cfg.gdrive.enabled ? 'enabled (gdrive.enabled = false turns it off)' : 'disabled',
  })

  const allow = cfg.webfetch.allow.length
  const deny = cfg.webfetch.deny.length
  results.push({
    name: 'Security fetch policy',
    status: 'ok',
    message: allow > 0
      ? `${allow} allowed host pattern${allow === 1 ? '' : 's'}, ${deny} denied: nothing outside the allow list is fetched`
      : `no allow list, ${deny} denied pattern${deny === 1 ? '' : 's'}: any host not denied can be fetched`,
  })

  const custom = compileCustomPatterns(cfg.redaction.custom_patterns)
  const strictNote = cfg.redaction.strict ? 'strict mode on' : 'strict mode off (redaction.strict)'
  const patternNote =
    custom.patterns.length === 0
      ? 'built-in patterns only'
      : `${custom.patterns.length} custom pattern${custom.patterns.length === 1 ? '' : 's'} plus the built-in ones`
  results.push(
    custom.problems.length > 0
      ? {
          name: 'Security redaction',
          status: 'warn',
          message:
            `${custom.problems.length} custom redaction pattern${custom.problems.length === 1 ? '' : 's'} could not be used ` +
            `and ${custom.problems.length === 1 ? 'is' : 'are'} not redacting anything: ` +
            custom.problems.map((p) => `${p.pattern} (${p.reason})`).join('; '),
        }
      : { name: 'Security redaction', status: 'ok', message: `${patternNote}, ${strictNote}` },
  )

  const extraRoots = cfg.mcp.allowed_roots.length
  results.push(
    cfg.mcp.confine_reads_to_project_root
      ? {
          name: 'Security mcp roots',
          status: 'ok',
          message: extraRoots === 0
            ? 'reads are confined to the project root the caller names, but mcp.allowed_roots is empty, so an MCP caller may name any root on this machine. (Restrictive mode: may block external skills or transcripts; restore permissive default with: token-goat config set mcp.confine_reads_to_project_root false)'
            : `reads are confined to the project root, and callers may name only the ${extraRoots} root${extraRoots === 1 ? '' : 's'} in mcp.allowed_roots (restrictive mode; restore permissive default with: token-goat config set mcp.confine_reads_to_project_root false)`,
        }
      : { name: 'Security mcp roots', status: 'ok', message: 'confinement is off (mcp.confine_reads_to_project_root = false): MCP reads are unconfined across workspaces, skills, and transcripts (recommended default)' },
  )

  results.push({
    name: 'Security symbol scope',
    status: 'ok',
    message: cfg.indexing.cross_project_symbols
      ? 'symbol lookups can resolve into other projects in the machine-wide index (indexing.cross_project_symbols = false confines them to this project)'
      : 'symbol lookups are confined to this project (restrictive mode; restore permissive cross-project resolution with: token-goat config set indexing.cross_project_symbols true)',
  })

  const overridden = envOverriddenSecuritySettings()
  const weakened = overridden.filter((o) => o.kind === 'weakened')
  const replaced = overridden.filter((o) => o.kind === 'replaced')
  const describe = (o: EnvOverriddenSetting): string => `${o.setting} (${o.envVar})`
  const parts: string[] = []
  if (weakened.length > 0) parts.push(`held open: ${weakened.map(describe).join(', ')}`)
  if (replaced.length > 0) parts.push(`set from the environment: ${replaced.map(describe).join(', ')}`)
  results.push(
    overridden.length === 0
      ? {
          name: 'Security config overrides',
          status: 'ok',
          message: `no environment variable is overriding any of the ${lockedEnvOverridableKeys().length} project-locked settings`,
        }
      : {
          name: 'Security config overrides',
          status: 'warn',
          message:
            `the environment, not the config file, is deciding ${overridden.length === 1 ? 'a' : 'these'} ` +
            `project-locked setting${overridden.length === 1 ? '' : 's'}. ${parts.join('; ')}. ` +
            'A project config cannot change these; an environment variable can, and one can be set by a file in a cloned repository.',
        },
  )

  results.push(dataDirPermissionResult(dataDirPath))
  return results
}
