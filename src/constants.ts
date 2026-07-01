/**
 * Package-wide constants: version re-export, data-directory resolution, and
 * the canonical TOKEN_GOAT_* environment-variable names.
 *
 * Ports the data-dir logic from `paths.py::_default_data_dir` and the env-key
 * `Final[str]` constants from `config.py`. Imports only from other Layer 1
 * leaf modules (version.ts), never from anything above.
 */

import * as os from 'node:os'
import * as path from 'node:path'

import { VERSION } from './version.js'

export { VERSION }

/** Config schema version (matches config.py CONFIG_SCHEMA_VERSION). */
export const CONFIG_SCHEMA_VERSION = 1 as const

/**
 * Validate an env-var directory value before using it as a data-dir base.
 *
 * Accepts only non-empty absolute paths so a crafted env var
 * (`LOCALAPPDATA=../../etc`) cannot redirect the data directory. Returns the
 * trimmed path on success, or undefined to signal the home-based fallback.
 */
function safeEnvDir(value: string): string | undefined {
  const stripped = value.trim()
  if (stripped === '') return undefined
  if (!path.isAbsolute(stripped)) return undefined
  return stripped
}

/**
 * Compute the platform-appropriate data directory.
 *
 * Matches platformdirs.user_data_dir("token-goat", "dfk-helper"):
 *   - Windows:   %LOCALAPPDATA%\dfk-helper\token-goat
 *   - macOS:     ~/Library/Application Support/token-goat
 *   - Linux/BSD: $XDG_DATA_HOME/token-goat (falls back to ~/.local/share/token-goat)
 *
 * Env-var overrides are validated via `safeEnvDir`; malformed values fall back
 * to the home-based default so a crafted env var cannot redirect data paths.
 */
function defaultDataDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    const raw = process.env['LOCALAPPDATA'] ?? ''
    const base = raw ? safeEnvDir(raw) : undefined
    if (base !== undefined) {
      return path.join(base, 'dfk-helper', 'token-goat')
    }
    return path.join(os.homedir(), 'dfk-helper', 'token-goat')
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'token-goat')
  }
  // Linux / BSD / WSL — honour XDG_DATA_HOME.
  const xdg = process.env['XDG_DATA_HOME'] ?? ''
  const base = xdg ? safeEnvDir(xdg) : undefined
  if (base !== undefined) {
    return path.join(base, 'token-goat')
  }
  return path.join(os.homedir(), '.local', 'share', 'token-goat')
}

// Computed once at module load: the data directory never changes within a process lifetime, so caching avoids repeated env reads on the hot hook path.
const DATA_DIR: string = defaultDataDir()

/** token-goat data directory (cached for the process lifetime). */
export function dataDir(): string {
  return DATA_DIR
}

/** Path to the global SQLite DB. */
export function globalDbPath(): string {
  return path.join(DATA_DIR, 'global.db')
}

/** Path to the TOML config file. */
export function configPath(): string {
  return path.join(DATA_DIR, 'config.toml')
}

/**
 * Canonical TOKEN_GOAT_* environment-variable names.
 *
 * Mirrors the `_ENV_*: Final[str]` constants in config.py. Centralizing the
 * literal strings here keeps callers from drifting on spelling. `as const`
 * preserves the literal types.
 */
export const ENV_KEYS = {
  COMPACT_ASSIST: 'TOKEN_GOAT_COMPACT_ASSIST',
  COMPACT_ASSIST_LEGACY: 'TOKENWISE_COMPACT_ASSIST',
  BASH_COMPRESS: 'TOKEN_GOAT_BASH_COMPRESS',
  SESSION_BRIEF: 'TOKEN_GOAT_SESSION_BRIEF',
  SKILL_PRESERVATION: 'TOKEN_GOAT_SKILL_PRESERVATION',
  PREFER_AVIF: 'TOKEN_GOAT_PREFER_AVIF',
  ORPHAN_SWEEP: 'TOKEN_GOAT_ORPHAN_SWEEP',
  CURATOR: 'TOKEN_GOAT_CURATOR',
  HINT_BUDGET: 'TOKEN_GOAT_HINT_BUDGET',
  HINT_JSON_SIDECAR: 'TOKEN_GOAT_HINT_JSON_SIDECAR',
  BASH_DEDUP_MIN_BYTES: 'TOKEN_GOAT_BASH_DEDUP_MIN_BYTES',
  WEB_DEDUP_MIN_BYTES: 'TOKEN_GOAT_WEB_DEDUP_MIN_BYTES',
  GREP_DEDUP_MIN_MATCHES: 'TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES',
  LARGE_READ_BYTES: 'TOKEN_GOAT_LARGE_READ_BYTES',
  BASELINE_BUDGET_TOKENS: 'TOKEN_GOAT_BASELINE_BUDGET_TOKENS',
  REPOMAP_COMPACT_THRESHOLD: 'TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD',
  WEB_CACHE_MAX_FILES: 'TOKEN_GOAT_WEB_CACHE_MAX_FILES',
  WEB_CACHE_MAX_BYTES: 'TOKEN_GOAT_WEB_CACHE_MAX_BYTES',
  WEB_COMPRESS: 'TOKEN_GOAT_WEB_COMPRESS',
  BASH_CACHE_MIN_BYTES: 'TOKEN_GOAT_BASH_CACHE_MIN_BYTES',
  BASH_CACHE_MAX_FILES: 'TOKEN_GOAT_BASH_CACHE_MAX_FILES',
  BASH_CACHE_MAX_BYTES: 'TOKEN_GOAT_BASH_CACHE_MAX_BYTES',
  BASH_CACHE_MAX_BYTES_PER_OUTPUT: 'TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT',
  WORKER_WATCHDOG: 'TOKEN_GOAT_WORKER_WATCHDOG',
  WORKER_MAX_POOL: 'TOKEN_GOAT_WORKER_MAX_POOL',
  COMPRESS_PROFILE: 'TOKEN_GOAT_COMPRESS_PROFILE',
  SKILL_COMPRESS: 'TOKEN_GOAT_SKILL_COMPRESS',
  SERVE_DIFF_ON_REREAD: 'TOKEN_GOAT_SERVE_DIFF_ON_REREAD',
  OVERFLOW_GUARD: 'TOKEN_GOAT_OVERFLOW_GUARD',
  OVERFLOW_MAX_TOKENS: 'TOKEN_GOAT_OVERFLOW_MAX_TOKENS',
  HARNESS_OVERRIDE: 'TOKEN_GOAT_HARNESS_OVERRIDE',
} as const

export type EnvKey = (typeof ENV_KEYS)[keyof typeof ENV_KEYS]
