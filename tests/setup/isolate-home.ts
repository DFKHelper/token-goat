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

if (!process.env['TOKEN_GOAT_HOME']) {
  const dir = path.join(os.tmpdir(), `tg-test-home-${process.pid}`)
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
const dataHome = path.join(os.tmpdir(), `tg-test-data-${process.pid}`)
try {
  fs.mkdirSync(dataHome, { recursive: true })
} catch {
  // best-effort
}
process.env['LOCALAPPDATA'] = dataHome
process.env['XDG_DATA_HOME'] = dataHome
process.on('exit', () => {
  try {
    fs.rmSync(dataHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})
