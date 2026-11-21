import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** One fixed directory outside every per-run temp home, so the 33 MB model is fetched once per machine and not once per run. */
const LOCAL_CACHE_DIR = path.join(os.tmpdir(), 'token-goat-test-model-cache')

/** Bounds a hung fetch. A pinned 33 MB download is far inside it; an offline machine fails in seconds, not at this bound. */
const FETCH_TIMEOUT_MS = 300_000

/** The variables the data directory is resolved from (src/constants.ts: LOCALAPPDATA or XDG_DATA_HOME, HOME on macOS; the same set tests/setup/isolate-home.ts pins), all on one scratch directory, so the child holds no copy of its own and writes nothing under the real data directory. */
function scratchRoots(dir: string): Record<string, string> {
  const roots: Record<string, string> = { TOKEN_GOAT_HOME: dir }
  for (const key of ['LOCALAPPDATA', 'XDG_DATA_HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE']) roots[key] = dir
  return roots
}

// vitest globalSetup: the embed rows read the pinned model from TOKEN_GOAT_MODEL_CACHE_DIR and never download it (the suite is offline by default, tests/setup/isolate-home.ts), so without a copy they skip. This is the one place a test run may reach the network for it: a child process with its own scratch home, so nothing lands in the real data directory, fetches it into the shared cache once and verifies the pinned digests. A value inherited from the launching shell wins, which is how CI points at its restored cache (.github/workflows/ci.yml). A failed fetch is reported in one line and the rows skip.
export default function setup(): void {
  // A nested `vitest run` (tests/retry_visibility_reporter.test.ts) sets this and never touches the model.
  if (process.env['TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD'] === '1') return
  if (process.env['TOKEN_GOAT_MODEL_CACHE_DIR']?.trim()) return
  process.env['TOKEN_GOAT_MODEL_CACHE_DIR'] = LOCAL_CACHE_DIR
  fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true })
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-seed-model-home-'))
  try {
    // owner: this globalSetup; spawnSync blocks until the child exits or the timeout kills it, so it cannot outlive the run.
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/setup/fetch-embed-model.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, ...scratchRoots(scratchHome), TOKEN_GOAT_MODEL_CACHE_DIR: LOCAL_CACHE_DIR, TOKEN_GOAT_OFFLINE: '0' },
    })
    if (child.status !== 0) {
      // The child's last stderr line is its failure; the lines above it are progress notices.
      const why = (child.error?.message ?? child.stderr.trim().split('\n').pop()) || `exit ${child.status ?? child.signal}`
      process.stderr.write(`token-goat tests: embed model not seeded in ${LOCAL_CACHE_DIR} (${why}); the embed backlog rows will skip.\n`)
    }
  } finally {
    fs.rmSync(scratchHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
}
