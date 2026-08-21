import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// vitest globalSetup: build the shipping bundle (dist/token-goat.mjs) exactly once per `vitest` invocation, before any test file runs. The e2e and CLI smoke tests spawn this prebuilt artifact, so without this each of them rebuilt it in its own beforeAll - six redundant esbuild runs that also raced on the same output path. One build here replaces all of them. Note: in watch mode this runs once at startup and not on source edits, so a bundle-spawning test will see stale dist until the watcher is restarted; the gating path (`vitest run` in CI and pre-push) rebuilds fresh on every invocation.
export default function setup(): (() => void) | void {
  // A nested `vitest run` spawned from inside a test (retry_visibility_reporter.test.ts) inherits
  // this config and so would rebuild the bundle while the outer run's workers are reading and
  // spawning it. On Windows that contention makes esbuild fail outright, failing the nested run
  // for a reason unrelated to what it tests. Such a run sets this and skips the build: it never
  // touches the bundle, so it has nothing to build.
  if (process.env['TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD'] !== '1') {
    execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: ROOT, stdio: 'ignore' })
  }
  // Must run before createRunRoot(): enableCompileCache writes into os.tmpdir(), and if the run root
  // were already in place the cache would land inside it and be deleted with it every run, silently
  // discarding the spawn-startup saving it exists for.
  enableCompileCache()
  return createRunRoot()
}

// isolate-home.ts creates two temp directories per test file and removes them from a process.on("exit")
// handler. Vitest kills its workers rather than letting them exit, so that handler almost never runs and
// both directories survive the run: 431 files x 2 x every run since the setup was written left 478,005
// tg-test-data-* and 468,096 tg-test-home-* directories in this machine's %TEMP% (67% of all 1,407,592
// entries in it). Parenting them under one per-run root fixes that at the source, because globalSetup
// teardown runs in the main vitest process, which does exit normally -- one directory per run to clean
// up instead of 862 to abandon.
function createRunRoot(): (() => void) | void {
  // A nested `vitest run` inherits this config; it must reuse the outer run's root rather than create
  // and then delete its own out from under the workers still using it.
  if (process.env['TG_TEST_RUN_ROOT']) return
  let root: string
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-run-'))
  } catch {
    return // best-effort: without a root, isolate-home falls back to os.tmpdir() as before
  }
  process.env['TG_TEST_RUN_ROOT'] = root
  return () => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // best-effort
    }
  }
}

/**
 * Point every process in this run -- the vitest workers and, more importantly, the ~975 child
 * processes they spawn to exercise the built bundle -- at one shared V8 compile cache.
 *
 * A bundle spawn costs a measured 257ms against 31ms for a bare `node -e 0`, so ~226ms of it is
 * Node's own module machinery rather than token-goat doing work; a CPU profile of a single
 * `--version` run attributes the bulk to compileSourceTextModule/wrapSafe on a 3.3 MB file.
 * Caching the compiled bytecode takes a bare `--version` spawn to a measured 224ms, an ~11% dent.
 *
 * Do not read that 11% as the suite-level number. Measured end to end on two bundle-heavy files
 * (cli_note + command_matrix_e2e.1), cold runs took 24.0s and 23.7s against warm runs of 23.5s,
 * 23.3s and 23.6s -- consistently positive, but only ~1.7%. The gap is the point: `--version` is
 * almost pure startup, while a real command spends most of its time in SQLite and indexing work
 * that no bytecode cache touches, so a fixed ~27ms saving is a much smaller slice of it. Kept
 * because it is free and never negative, not because it is a significant win.
 *
 * Deliberately NOT per-worker-scoped (unlike the temp homes in isolate-home.ts): the whole point
 * is that the second and subsequent spawns reuse what the first one compiled, so scoping it per
 * worker would hand each worker a cold cache and recover almost nothing. Concurrent readers and
 * writers across workers are expected -- Node writes cache entries atomically and treats a
 * corrupt or partial entry as a miss.
 *
 * Set here in globalSetup rather than in setupFiles because globalSetup completes before any
 * worker is forked, so the workers inherit this env and pass it on to their own children; a
 * setupFiles assignment would run once per test file, after the fork, for no added benefit.
 */
function enableCompileCache(): void {
  if (process.env['NODE_COMPILE_CACHE']) return // an explicit outer setting wins
  const dir = path.join(os.tmpdir(), 'tg-test-v8-compile-cache')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return // best-effort: no cache just means every spawn compiles from source, as before
  }
  process.env['NODE_COMPILE_CACHE'] = dir
}
