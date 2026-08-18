/**
 * Package-wide constants: version re-export, data-directory resolution, and
 * the canonical TOKEN_GOAT_* environment-variable names.
 *
 * Ports the data-dir logic from `paths.py::_default_data_dir` and the env-key
 * `Final[str]` constants from `config.py`. Imports only from other Layer 1
 * leaf modules (version.ts), never from anything above.
 */

import * as fs from 'node:fs'
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
    // macOS has no native LOCALAPPDATA/XDG_DATA_HOME equivalent, but
    // tests/setup/isolate-home.ts unconditionally pins XDG_DATA_HOME for every platform
    // (defense in depth) specifically so an isolated override is available here too --
    // without this check, darwin skipped straight to homeFallbackOrGuard(), which throws
    // unconditionally inside any Vitest worker regardless of whether the override was set,
    // so every test touching dataDir() failed on macOS CI (first darwin CI run, all local
    // runs and win32/linux CI had been green because their branches check their own env var
    // first). A real Mac essentially never sets XDG_DATA_HOME, so this mirrors the win32/
    // linux override pattern with no observed change to real-machine behavior.
    const raw = process.env['XDG_DATA_HOME'] ?? ''
    const base = raw ? safeEnvDir(raw) : undefined
    if (base !== undefined) {
      return path.join(base, 'token-goat')
    }
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
let DATA_DIR: string = defaultDataDir()

/** token-goat data directory (cached for the process lifetime). */
export function dataDir(): string {
  return DATA_DIR
}

/**
 * Test-only: force the next {@link dataDir}/{@link globalDbPath}/{@link configPath} call to
 * re-resolve from the *current* LOCALAPPDATA/XDG_DATA_HOME/HOME env vars, instead of the value
 * cached at whichever moment this module was first imported.
 *
 * DATA_DIR's module-load-time caching (see the comment above) is correct and desirable for the
 * real hot hook path -- the data dir genuinely never changes within one real process's lifetime
 * -- but it silently defeats per-test isolation in the test suite: `tests/setup/isolate-home.ts`
 * pins LOCALAPPDATA/XDG_DATA_HOME once per Vitest *worker* (a forked process reused across many
 * test files), so DATA_DIR is the SAME real directory for every test file that lands on that
 * worker, unlike TOKEN_GOAT_HOME (read live from `process.env` on every call, so a test file's
 * own `beforeEach` override already takes effect immediately with no extra step). A test file
 * that writes real fixture files into `dataDir()`-derived paths (e.g. webCacheDir() in
 * webfetch.ts) can therefore collide with -- or be collided into by -- a completely unrelated
 * test file sharing the same worker, exactly like `TOKEN_GOAT_HOME`'s per-test override already
 * prevents. A test file that needs that same guarantee for LOCALAPPDATA/XDG_DATA_HOME-derived
 * paths must set a fresh per-test override AND call this function so the cached DATA_DIR picks
 * it up -- mirroring the pattern this file's own `tests/constants.test.ts` already documents
 * (see its "cross-pollute unrelated later test files... cache_session_commands.test.ts failing
 * an unrelated assertion" regression comment) as a live, previously-hit failure mode of this
 * exact caching. Deliberately NOT `vi.resetModules()` + re-import -- that same test comment
 * documents `vi.resetModules()` on this module as itself causing permanent cross-file pollution
 * when done in-process; mutating the cached binding directly avoids the module registry
 * entirely.
 */
/**
 * Whether {@link ensureDataDirPrivate} has already run in this process. The data root's mode does
 * not change underneath us, so one syscall per process is enough.
 */
let dataDirHardened = false

/**
 * Create the data root, owner-only, before anything writes a child into it.
 *
 * Everything token-goat caches lands under this directory: bash output, fetched pages, MCP
 * results, session state, and the SQLite index of the project's source. Created with a plain
 * recursive mkdir it took the process umask, which on a stock Linux box means mode 755 -- so on
 * a shared host every other local user could list and read another user's cached work. The
 * individual JSON blobs are written 0600 by `atomicWriteText`, but the SQLite databases are
 * created by the driver at its own default, and the file *names* alone leak which commands ran
 * and which URLs were fetched.
 *
 * Hardening the root rather than each of the ~20 places that create a child is deliberate and
 * strictly stronger: traversal into a 0700 directory is refused for everyone but the owner, so a
 * child's own mode stops mattering. Existing installs are fixed too, not just fresh ones -- an
 * already-created 755 root is chmodded down on the next run.
 *
 * No-op on Windows, where Node ignores POSIX modes and the directory inherits the parent ACL.
 */
export function ensureDataDirPrivate(): void {
  if (dataDirHardened) return
  dataDirHardened = true
  try {
    // Two steps, not one recursive call with a mode: `mode` applies to every level the call
    // creates, and the parents here are shared XDG/AppData directories owned by the user rather
    // than by token-goat -- a recursive create tightened `~/.local` and `~/.local/share` to 0700
    // as collateral, which is not ours to change. The parents get the umask default; only the
    // token-goat directory itself is made owner-only.
    fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true })
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // `mode` only applies to directories this call actually creates, so an install that
      // predates this hardening keeps its old permissive mode until it is chmodded explicitly.
      const current = fs.statSync(DATA_DIR).mode & 0o777
      if ((current & 0o077) !== 0) fs.chmodSync(DATA_DIR, 0o700)
    }
  } catch {
    // Best-effort: a read-only or otherwise unwritable home must not break every command. The
    // caller's own mkdir runs next and reports the real failure with its own context.
  }
}

export function _resetDataDirCacheForTesting(): void {
  DATA_DIR = defaultDataDir()
  dataDirHardened = false
}

/** Path to the global SQLite DB. */
export function globalDbPath(): string {
  return path.join(DATA_DIR, 'global.db')
}

/** Path to the TOML config file. */
export function configPath(): string {
  return path.join(DATA_DIR, 'config.toml')
}

/** Filename of the optional per-project config override, checked at the project root. */
export const PROJECT_CONFIG_FILENAME = '.token-goat.toml'

/** Path to a project's optional `.token-goat.toml` config override file. */
export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_FILENAME)
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
  GLOB_DEDUP_MIN_MATCHES: 'TOKEN_GOAT_GLOB_DEDUP_MIN_MATCHES',
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

// Largest symbol body stored in the index; parser.ts re-exports this as MAX_SYMBOL_BODY_CHARS and
// its docblock carries the full rationale. The value lives here rather than there because db.ts
// bakes it into the partial index backing checkSymbolBodySize, and parser.ts imports db.ts.
// Changing it invalidates that index's predicate: bump SCHEMA_VERSION and add a MIGRATIONS step
// dropping idx_symbols_oversized_body, or the stored index keeps the old threshold.
export const SYMBOL_BODY_CHAR_CAP = 128 * 1024
