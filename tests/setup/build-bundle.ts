import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLE_OUTPUTS } from '../../scripts/build-options.mjs'
import { readBundleStamp, sourceDigest } from '../../scripts/source-digest.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Whether dist/ has to be rebuilt before the suite spawns it. The build records a digest of the sources it read (scripts/source-digest.mjs), and a bundle counts as fresh only when that digest matches the sources now. This compared mtimes until a mutation run restored a source file with `mv` from a backup: the file got back its older timestamp, the bundle built from the mutant in between looked newer than every source, and the next run tested the mutant, not the code on disk. tests/build_bundle_freshness.test.ts holds that case. */
export function shouldBuildBundle(root: string = ROOT): boolean {
  if (process.env['TOKEN_GOAT_TEST_FORCE_BUNDLE_BUILD'] === '1') return true

  if (BUNDLE_OUTPUTS.some((name) => !fs.existsSync(path.join(root, 'dist', name)))) return true

  return readBundleStamp(root) !== sourceDigest(root)
}

// vitest globalSetup: ensure the shipping bundle (dist/token-goat.mjs) is available and fresh before any test file runs. The e2e and CLI smoke tests spawn this prebuilt artifact, so without this each of them rebuilt it in its own beforeAll - six redundant esbuild runs that also raced on the same output path. One freshness-gated build here replaces all of them. Note: in watch mode this runs once at startup and not on source edits, so a bundle-spawning test will see stale dist until the watcher is restarted.
export default function setup(): (() => void) | void {
  // A nested `vitest run` spawned from inside a test (retry_visibility_reporter.test.ts) inherits this config and so would rebuild the bundle while the outer run's workers are reading and spawning it. On Windows that contention makes esbuild fail outright, failing the nested run for a reason unrelated to what it tests. Such a run sets this and skips the build: it never touches the bundle, so it has nothing to build.
  if (process.env['TOKEN_GOAT_TEST_SKIP_BUNDLE_BUILD'] !== '1' && shouldBuildBundle()) {
    execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: ROOT, stdio: 'ignore' })
  }
  // Must run before createRunRoot(): enableCompileCache writes into os.tmpdir(), and if the run root were already in place the cache would land inside it and be deleted with it every run, silently discarding the spawn-startup saving it exists for.
  enableCompileCache()
  pinRustHomes()
  buildNativeOnce()
  return createRunRoot()
}

// rustup and cargo find the toolchain and the crate cache through HOME unless RUSTUP_HOME and CARGO_HOME say otherwise, and isolate-home points every worker's HOME at a temp directory, so a cargo run from a test file (the conformance suite's `cargo test`) installed the pinned toolchain and fetched every crate again, into a directory deleted with the run. Pinned here, before any worker forks, to the homes this user's rustup actually uses; an outer setting wins.
function pinRustHomes(): void {
  for (const [name, dir] of [['RUSTUP_HOME', '.rustup'], ['CARGO_HOME', '.cargo']] as const) {
    const home = path.join(os.homedir(), dir)
    if (process.env[name] === undefined && fs.existsSync(home)) process.env[name] = home
  }
}

// Built here, once, under the real home, rather than by each test file that runs it. Per file, the builds replaced dist/native while other files were running that binary (EPERM on the rename, failing a whole file), and each ran under isolate-home's temp HOME, where rustup finds no toolchain and cargo no crate cache: every build downloaded both again. The outcome crosses to the workers through the environment, as TG_TEST_RUN_ROOT does; a failed build is recorded rather than thrown, so a machine without Rust fails the native test files (tests/helpers/native_bin.ts) and nothing else. A nested run inherits the outer run's outcome and builds nothing.
function buildNativeOnce(): void {
  if (process.env['TG_TEST_NATIVE_BIN'] !== undefined || process.env['TG_TEST_NATIVE_BUILD_ERROR'] !== undefined) return
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-native.mjs')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const bin = r.status === 0 ? (r.stdout.trim().split(/\r?\n/).pop() ?? '') : ''
  if (bin !== '') process.env['TG_TEST_NATIVE_BIN'] = bin
  else process.env['TG_TEST_NATIVE_BUILD_ERROR'] = `scripts/build-native.mjs failed (exit ${String(r.status)}); the native test files need the Rust toolchain pinned in native/tg-hook/rust-toolchain.toml.\n${(r.stderr ?? '').slice(-8000)}${r.error?.message ?? ''}`
}

// isolate-home.ts creates two temp directories per test file and removes them from a process.on("exit") handler. Vitest kills its workers rather than letting them exit, so that handler almost never runs and both directories survive the run: 431 files x 2 x every run since the setup was written left 478,005 tg-test-data-* and 468,096 tg-test-home-* directories in this machine's %TEMP% (67% of all 1,407,592 entries in it). Parenting them under one per-run root fixes that at the source, because globalSetup teardown runs in the main vitest process, which does exit normally -- one directory per run to clean up instead of 862 to abandon. The teardown below only runs when the main vitest process exits normally, so every interrupted run (Ctrl-C, a killed agent, a crash) abandons its root: measured 65 abandoned tg-run-* roots totalling 127 MB, all under two days old, 55 of them from a single day. sweepStaleRunRoots() reclaims them on the next run. Age gate for an abandoned run root. The root's own mtime is the liveness signal: isolate-home creates a tg-test-data-*/tg-test-home-* pair directly inside it for every test file, so a live run bumps it continuously. 6h against a ~110s full suite is ~200x headroom, and it also clears the one false-positive shape a tighter gate would hit: a `vitest` watcher left open and idle, whose root goes untouched between saves.
const STALE_RUN_ROOT_MS = 6 * 60 * 60 * 1000

// A detached `--worker-daemon` started by a test lives in a data dir under a run root, and on Windows it holds global.db there, so the rmSync below leaves the folder behind and the daemon runs on. Each daemon names itself in queue/drain-heartbeat; stop exactly the pids named by a heartbeat that is still being refreshed (a stale one may name a pid that something else has since reused) and nothing else.
const DAEMON_HEARTBEAT_FRESH_MS = 60_000
const DAEMON_SEARCH_DEPTH = 6

function heartbeatFiles(dir: string, depth: number, found: string[]): void {
  if (depth > DAEMON_SEARCH_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.name === 'queue') {
      const beat = path.join(full, 'drain-heartbeat')
      if (fs.existsSync(beat)) found.push(beat)
      continue
    }
    heartbeatFiles(full, depth + 1, found)
  }
}

export function killDaemonsUnder(root: string): void {
  const beats: string[] = []
  heartbeatFiles(root, 0, beats)
  for (const beat of beats) {
    try {
      if (Date.now() - fs.statSync(beat).mtimeMs > DAEMON_HEARTBEAT_FRESH_MS) continue
      const pid = parseInt(fs.readFileSync(beat, 'utf8').trim(), 10)
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
      process.kill(pid, 'SIGKILL')
    } catch {
      // best-effort: already gone, not ours to signal, or unreadable
    }
  }
}

// Best-effort removal of run roots abandoned by earlier interrupted runs. Only `tg-run-` prefixed directories are considered, so the deliberately shared tg-test-v8-compile-cache survives. Any failure (a permission error, a root another process holds open) is skipped: this must never fail the run.
export function sweepStaleRunRoots(dir: string = os.tmpdir(), prefixes: readonly string[] = ['tg-run-']): void {
  try {
    const cutoff = Date.now() - STALE_RUN_ROOT_MS
    for (const entry of fs.readdirSync(dir)) {
      if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue
      const full = path.join(dir, entry)
      try {
        const st = fs.statSync(full)
        if (!st.isDirectory() || st.mtimeMs >= cutoff) continue
        killDaemonsUnder(full)
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 1 })
      } catch {
        // best-effort: skip this root
      }
    }
  } catch {
    // best-effort: nothing swept
  }
}

// tests/helpers/temp-config.ts::indexableDir() puts fixtures the dirty queue must accept under the repo's .tmp/, since the queue refuses anything under the OS temp dir, so the %TEMP% run root above cannot hold them. They leaked the same way for the same reason: a tg-test-cfg-* root per test file, removed only by an exit handler killed workers never run, 42 of them in this checkout with their files intact. The repo's .tmp/ gets its own per-run root, which the teardown removes and the sweep reclaims, the sweep also taking tg-test-cfg-* roots from runs before this existed.
export const INDEXABLE_TMP = path.join(ROOT, '.tmp')

export function createRunRoot(): (() => void) | void {
  // A nested `vitest run` inherits this config; it must reuse the outer run's root rather than create and then delete its own out from under the workers still using it.
  if (process.env['TG_TEST_RUN_ROOT']) return
  sweepStaleRunRoots()
  sweepStaleRunRoots(INDEXABLE_TMP, ['tg-run-', 'tg-test-cfg-'])
  const created: string[] = []
  for (const [name, base] of [['TG_TEST_RUN_ROOT', os.tmpdir()], ['TG_TEST_INDEXABLE_ROOT', INDEXABLE_TMP]] as const) {
    try {
      fs.mkdirSync(base, { recursive: true })
      const root = fs.mkdtempSync(path.join(base, 'tg-run-'))
      process.env[name] = root
      created.push(root)
    } catch {
      // best-effort: without a root, isolate-home and temp-config fall back to their own directories as before
    }
  }
  return () => {
    for (const root of created) {
      killDaemonsUnder(root)
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // best-effort
      }
    }
  }
}

/** Point every process in this run -- the vitest workers and, more importantly, the ~975 child processes they spawn to exercise the built bundle -- at one shared V8 compile cache. A bundle spawn costs a measured 257ms against 31ms for a bare `node -e 0`, so ~226ms of it is Node's own module machinery rather than token-goat doing work; a CPU profile of a single `--version` run attributes the bulk to compileSourceTextModule/wrapSafe on a 3.3 MB file. Caching the compiled bytecode takes a bare `--version` spawn to a measured 224ms, an ~11% dent. Do not read that 11% as the suite-level number. Measured end to end on two bundle-heavy files (cli_note + command_matrix_e2e.1), cold runs took 24.0s and 23.7s against warm runs of 23.5s, 23.3s and 23.6s -- consistently positive, but only ~1.7%. The gap is the point: `--version` is almost pure startup, while a real command spends most of its time in SQLite and indexing work that no bytecode cache touches, so a fixed ~27ms saving is a much smaller slice of it. Kept because it is free and never negative, not because it is a significant win. Deliberately NOT per-worker-scoped (unlike the temp homes in isolate-home.ts): the whole point is that the second and subsequent spawns reuse what the first one compiled, so scoping it per worker would hand each worker a cold cache and recover almost nothing. Concurrent readers and writers across workers are expected -- Node writes cache entries atomically and treats a corrupt or partial entry as a miss. Set here in globalSetup rather than in setupFiles because globalSetup completes before any worker is forked, so the workers inherit this env and pass it on to their own children; a setupFiles assignment would run once per test file, after the fork, for no added benefit. */
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
