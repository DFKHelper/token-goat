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
 * Compute the platform-appropriate data directory purely from a given home
 * directory, ignoring the current process's real env-var overrides.
 *
 * This is the structural, home-relative equivalent of what `LOCALAPPDATA` /
 * `XDG_DATA_HOME` normally resolve to on a real install:
 *   - Windows:   <home>\AppData\Local\dfk-helper\token-goat
 *   - macOS:     <home>/Library/Application Support/token-goat
 *   - Linux/BSD: <home>/.local/share/token-goat
 *
 * Deliberately does not consult `process.env` — callers that need the data
 * dir for an arbitrary *other* home directory (e.g. `stats --home-dir`) must
 * get a path derived only from that home, not from the current process's own
 * ambient LOCALAPPDATA/XDG_DATA_HOME (which belong to the real caller's home
 * and would otherwise silently override/ignore the requested one). Exported
 * so callers can reuse this exact platform branching instead of duplicating
 * it and drifting out of sync.
 */
export function dataDirForHome(homeDir: string): string {
  const platform = process.platform
  if (platform === 'win32') {
    return path.join(homeDir, 'AppData', 'Local', 'dfk-helper', 'token-goat')
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'token-goat')
  }
  return path.join(homeDir, '.local', 'share', 'token-goat')
}

/**
 * dataDirForHome(os.homedir()) is the correct real-machine fallback when no platform env var
 * override is present -- but tests/setup/isolate-home.ts unconditionally pins LOCALAPPDATA/
 * XDG_DATA_HOME for every Vitest worker specifically so this fallback is never reached in
 * tests. Reaching it there means some test (directly, or via a spawned child process whose env
 * was rebuilt without inheriting the override) cleared the isolation var without supplying its
 * own -- and is about to read/write the developer's real global.db/config.toml. Confirmed this
 * happened in practice: production config.toml was found holding `large_file_skip_kb = 1` and
 * `skip_dirs = ["a"]`, unmistakable test-fixture values, which silently broke real indexing (any
 * source file over 1 KB became skip-eligible). Fail loudly instead of corrupting real data.
 * VITEST_ALLOW_REAL_DATA_DIR opts a test out deliberately when it has already substituted a
 * synthetic home (e.g. tests/constants.test.ts's own home-fallback-formula regression test,
 * which mocks os.homedir() rather than touching the real one).
 */
function homeFallbackOrGuard(): string {
  const inVitest = process.env['VITEST_WORKER_ID'] !== undefined || process.env['VITEST'] === 'true'
  if (inVitest && process.env['VITEST_ALLOW_REAL_DATA_DIR'] !== '1') {
    throw new Error(
      'token-goat: refusing to resolve DATA_DIR against the real home directory inside a ' +
        'Vitest worker (LOCALAPPDATA/XDG_DATA_HOME is unset). This would read or write the ' +
        "developer's real global.db/config.toml. Set LOCALAPPDATA/XDG_DATA_HOME explicitly for " +
        'this process, or VITEST_ALLOW_REAL_DATA_DIR=1 if this is an intentional mocked-home test.',
    )
  }
  return dataDirForHome(os.homedir())
}

/**
 * Compute the platform-appropriate data directory for the *current* process.
 *
 * Matches platformdirs.user_data_dir("token-goat", "dfk-helper"):
 *   - Windows:   %LOCALAPPDATA%\dfk-helper\token-goat
 *   - macOS:     ~/Library/Application Support/token-goat
 *   - Linux/BSD: $XDG_DATA_HOME/token-goat (falls back to ~/.local/share/token-goat)
 *
 * Env-var overrides are validated via `safeEnvDir`; malformed values fall back
 * to the home-based default (via `dataDirForHome`) so a crafted env var
 * cannot redirect data paths.
 */
function defaultDataDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    const raw = process.env['LOCALAPPDATA'] ?? ''
    const base = raw ? safeEnvDir(raw) : undefined
    if (base !== undefined) {
      return path.join(base, 'dfk-helper', 'token-goat')
    }
    return homeFallbackOrGuard()
  }
  if (platform === 'darwin') {
    return homeFallbackOrGuard()
  }
  // Linux / BSD / WSL — honour XDG_DATA_HOME.
  const xdg = process.env['XDG_DATA_HOME'] ?? ''
  const base = xdg ? safeEnvDir(xdg) : undefined
  if (base !== undefined) {
    return path.join(base, 'token-goat')
  }
  return homeFallbackOrGuard()
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
  ORPHAN_SWEEP: 'TOKEN_GOAT_ORPHAN_SWEEP',
  HINT_BUDGET: 'TOKEN_GOAT_HINT_BUDGET',
  HINT_JSON_SIDECAR: 'TOKEN_GOAT_HINT_JSON_SIDECAR',
  BASH_DEDUP_MIN_BYTES: 'TOKEN_GOAT_BASH_DEDUP_MIN_BYTES',
  WEB_DEDUP_MIN_BYTES: 'TOKEN_GOAT_WEB_DEDUP_MIN_BYTES',
  GREP_DEDUP_MIN_MATCHES: 'TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES',
  LARGE_READ_BYTES: 'TOKEN_GOAT_LARGE_READ_BYTES',
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
