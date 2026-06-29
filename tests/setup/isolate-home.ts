/**
 * Global test setup: redirect token-goat's cross-process home to a temp dir.
 *
 * The bash-output, web-output, and session caches persist JSON under
 * `tokenGoatHome()` (TOKEN_GOAT_HOME, else `~/.token-goat`). Without this,
 * any test exercising those stores would write into the developer's real
 * `~/.token-goat`. We point each test worker at its own temp dir.
 *
 * The guard preserves per-test overrides: a test that sets TOKEN_GOAT_HOME in
 * its own beforeEach still wins, and restoring to the prior value lands back on
 * this worker default rather than leaking to the real home.
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
