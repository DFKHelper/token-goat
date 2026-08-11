/**
 * Global test setup: redirect token-goat's cross-process home AND platform data
 * dir to per-worker temp dirs, so tests never touch — or contend on — the
 * developer's real filesystem.
 *
 * Two separate stores must be isolated:
 *
 *  - TOKEN_GOAT_HOME (else `~/.token-goat`) backs the bash-output, web-output,
 *    and session JSON caches.
 *  - LOCALAPPDATA (Windows) / XDG_DATA_HOME (Linux) resolve DATA_DIR, which holds
 *    global.db (the symbol index) and config.toml. Without isolating it, any test
 *    that indexes writes token-goat's own symbols into the developer's real
 *    global.db AND races the live worker daemon writing to that same file every
 *    2 s — a nondeterministic "database is locked" failure that passes on CI (no
 *    daemon, fresh checkout) but flakes locally. Per-worker isolation makes every
 *    local run match CI's fresh-data-dir condition.
 *
 * Both are pinned to this worker's PID so parallel test forks never share a DB.
 * A test that sets TOKEN_GOAT_HOME in its own beforeEach still wins; subprocess
 * tests that pass an explicit LOCALAPPDATA/XDG_DATA_HOME in the child env also
 * win, because that key overrides the inherited one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Unique per TEST FILE, not per worker process. setupFiles runs once per test file, but
// `pool: 'forks'` REUSES a fork across many files, so keying these dirs on process.pid alone
// handed consecutive files in the same fork one shared global.db. That is cross-file state
// leakage, not contention: which files land in which fork varies run to run, so different files
// failed each run and every one passed in isolation. Reproduced deterministically by running
// `db.test.ts` then `cli_note.test.ts` in a single fork -- the notes db.test.ts left behind made
// cli_note's `not.toContain('[STALE]')` fail. A per-file suffix restores the isolation this
// file's docblock already claimed.
const workerScope = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

// A TOKEN_GOAT_HOME inherited from the ENVIRONMENT (a developer or CI exporting one) must still
// win. A TOKEN_GOAT_HOME left in process.env by a PREVIOUS test file in this same reused fork
// must not -- that is the leak. The sentinel distinguishes the two, which a bare presence check
// cannot.
if (process.env['TG_TEST_HOME_MANAGED'] === '1') {
  delete process.env['TOKEN_GOAT_HOME']
}
if (!process.env['TOKEN_GOAT_HOME']) {
  process.env['TG_TEST_HOME_MANAGED'] = '1'
  const dir = path.join(os.tmpdir(), `tg-test-home-${workerScope}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // best-effort
  }
  process.env['TOKEN_GOAT_HOME'] = dir
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })
}

// Data-dir isolation is unconditional: the system LOCALAPPDATA is always set on Windows, so a presence guard would never isolate it and tests would keep hitting the real global.db. Point both platform env vars at a per-worker temp dir before any token-goat module caches DATA_DIR (setupFiles run before the test module graph imports constants.ts, so the cached value picks this up).
const dataHome = path.join(os.tmpdir(), `tg-test-data-${workerScope}`)
try {
  fs.mkdirSync(dataHome, { recursive: true })
} catch {
  // best-effort
}
process.env['LOCALAPPDATA'] = dataHome
process.env['XDG_DATA_HOME'] = dataHome
// macOS ignores LOCALAPPDATA/XDG_DATA_HOME and derives Application Support from HOME, so HOME has
// to be redirected there for DATA_DIR to land in the sandbox at all.
//
// It is redirected on every platform, not just darwin, because HOME/USERPROFILE is also what
// `os.homedir()` reads -- and code paths that call it directly (waste's transcript fallback to
// `~/.claude/projects`, bootstrap-audit, the bridge installers, context-stats' CLAUDE.md walk)
// escaped the sandbox entirely on Windows and Linux while LOCALAPPDATA/XDG_DATA_HOME were
// redirected. That gap produced a real intermittent failure: the `waste --top` cases read the
// developer's own live Claude Code session transcript (76 MB and growing during a dogfooding
// session), spending ~7s per call parsing it, which blew the test timeout under full-suite
// contention. Sandboxing HOME everywhere closes the class, not just that one instance.
process.env['HOME'] = dataHome
process.env['USERPROFILE'] = dataHome
process.on('exit', () => {
  try {
    fs.rmSync(dataHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

// Embeddings generation (indexing.embeddings_enabled) defaults to true in production so a
// real `token-goat index` populates chunks/chunk_vectors for `token-goat semantic` out of the
// box, but that means every test in this suite that touches indexFileSync/cmdIndex/the worker
// drain would otherwise load a real transformer model and run real inference on every index
// call - slow, and a hard network dependency on a machine without the model already cached
// (e.g. a fresh CI checkout). Force it off by default for the whole suite, exactly like
// TOKEN_GOAT_HOME above: a test that sets this env var itself (e.g. the embeddings-in-index
// regression tests, which additionally gate on the real optional deps being available) still
// wins, because that assignment runs after this file's setup.
if (!process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']) {
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
}

// Pin the three env vars that used to live only in the local pre-push hook
// (.lefthook-scripts/run-test.sh / wsl-test.sh), so a green local pre-push and a
// green CI run mean the same thing. Same "a test that sets its own value wins"
// pattern as TOKEN_GOAT_HOME/TOKEN_GOAT_EMBEDDINGS_ENABLED above: these are only
// defaults, applied before the test module graph imports anything that reads them.
if (!process.env['TOKEN_GOAT_NO_WORKER_SPAWN']) {
  process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '1'
}
if (!process.env['TOKEN_GOAT_HARNESS_OVERRIDE']) {
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
}
if (!process.env['TOKEN_GOAT_MEMORY_PRESSURE_MB']) {
  process.env['TOKEN_GOAT_MEMORY_PRESSURE_MB'] = '99999'
}
