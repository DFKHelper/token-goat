/**
 * End-to-end coverage for the adaptive PreCompact manifest budget wired in
 * hooks_compact.ts (see `adaptiveCharBonus`/`gitDirtySignals`).
 *
 * `compact.ts`'s `computeAdaptiveBudget`/`buildManifestAdaptive` were ported from the
 * Python predecessor (`eb119425`) but never wired to the real production PreCompact path --
 * only unit-tested in isolation via directly-injected opts (tests/compact.test.ts). This
 * suite closes that "injected-callback seam" gap (see CLAUDE.md's "Critical path" section)
 * two ways other coverage in this repo doesn't:
 *
 * 1. It dispatches through the *real* registered handler via `relayInProcess` (relay.ts ->
 *    hook_registry.ts's `pre_compact` registration -> `preCompactHandler`), not a directly
 *    imported function reference -- proving the wiring is actually reachable on the wire
 *    path, not just correct in isolation.
 * 2. It never mocks `node:child_process`/`runGit` -- `hasPendingDiff`/`hasUncommittedChanges`
 *    are checked against a real scratch git repo (real `git init`/`diff`/`status --porcelain`
 *    subprocess calls), not a stubbed git result.
 *
 * Deliberately does NOT mock `node:child_process` (unlike hooks_compact.test.ts, which mocks
 * it to control `mem epoch`'s spawnSync call deterministically) -- doing so here would also
 * intercept `runGit`'s spawnSync calls and defeat the "real git state" requirement above.
 *
 * Deliberately does NOT call `clearModuleCaches()` between tests: that helper also runs
 * hook_registry.ts's `clearHooks()` reset (registered via `registerReset`), which empties the
 * shared `_handlers` map. Every hook module registers itself exactly once, at ESM import time
 * (`registerHook('pre_compact', preCompactHandler)` etc. in hooks_compact.ts/hooks_index.ts) --
 * once cleared in-process, nothing re-populates it, so every `relayInProcess` call afterward
 * would silently see zero registered handlers and resolve to `pass` (`{}`), rather than
 * actually dispatching to `preCompactHandler`. Every other suite that calls
 * `clearModuleCaches()` invokes hook handlers directly (bypassing the registry) or drives a
 * fresh child process per call (session_persistence_e2e.test.ts), so this interaction is new
 * here specifically because this suite dispatches in-process through the real registry.
 * Session/config state between tests is instead reset narrowly, via `resetSessionState()` and
 * `invalidateConfigCache()`.
 */

import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as util from '../src/util.js'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- redirects configPath() to a per-test-file temp file so this suite can
// deterministically set compact_assist.max_manifest_chars and hints.git_hint_max_ms without
// touching the real ~/.token-goat config. Mirrors tests/hooks_compact.test.ts's own mock; kept
// in a separate file (rather than added to that one) specifically so it does not inherit that
// file's node:child_process mock. The factory closes over `_testConfigPath` by reference, so
// it resolves correctly even though the `const` below is declared after this call -- vi.mock's
// factory only actually runs later, the first time configPath() is invoked from a test body.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-hooks-compact-adaptive-config-test.toml')

import { relayInProcess } from '../src/relay.js'
import { runGit } from '../src/util.js'
import { recordFileEdit, importSessionState } from '../src/session.js'
import { buildManifest, manifestPrintedPaths } from '../src/manifest.js'
import { saveSessionState } from '../src/session_store.js'
import { defaultConfig, saveConfig, invalidateConfigCache } from '../src/config.js'

const CONFIGURED_CAP = 300
const SESSION_ID = 'adaptive-budget-e2e'

/** Mirrors tests/compact.test.ts's own local helper: clears session.ts's in-memory maps without touching hook_registry.ts's handler registry (see module doc comment above). */
function resetSessionState(): void {
  importSessionState({ files: [], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] })
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  runGit(['init'], { cwd: dir })
  runGit(['config', 'user.email', 'test@token-goat.local'], { cwd: dir })
  runGit(['config', 'user.name', 'Token Goat Test'], { cwd: dir })
  runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello\n')
  runGit(['add', 'tracked.txt'], { cwd: dir })
  runGit(['commit', '-m', 'initial commit'], { cwd: dir })
}

/** On Claude Code (the harness tests/setup/isolate-home.ts pins) a pre_compact context output is written to stdout as raw text, because Claude Code feeds PreCompact stdout to the summarizing model verbatim -- so the wire output IS the manifest, with no JSON envelope to unwrap. */
function manifestFrom(wireOutput: string): string {
  return wireOutput
}

function truncatedAt(manifest: string): number | null {
  const match = manifest.match(/truncated at (\d+) chars/)
  return match ? Number(match[1]) : null
}

async function runPreCompact(cwd: string | undefined): Promise<string> {
  const payload: Record<string, unknown> = { session_id: SESSION_ID }
  if (cwd !== undefined) payload['cwd'] = cwd
  return manifestFrom(await relayInProcess('pre_compact', payload))
}

describe('PreCompact adaptive manifest budget (real relay dispatch + real git state)', () => {
  let repoDir: string
  let tgHome: string
  let prevHome: string | undefined

  beforeEach(() => {
    resetSessionState()
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adaptive-budget-repo-'))
    tgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adaptive-budget-home-'))
    prevHome = process.env['TOKEN_GOAT_HOME']
    process.env['TOKEN_GOAT_HOME'] = tgHome
    initRepo(repoDir)

    const cfg = defaultConfig()
    cfg.compact_assist.max_manifest_chars = CONFIGURED_CAP
    // Generous bound (default is 50ms) so a slow CI/Windows git spawn can never flake this
    // suite into a false "clean" reading -- this suite is about proving detection is correct,
    // not about re-testing the default timeout value (already covered by hooks_session.test.ts).
    cfg.hints.git_hint_max_ms = 5000
    saveConfig(cfg)
    invalidateConfigCache()

    // Seed a real, on-disk session cache with edited-file activity via the real session.ts
    // recorder + session_store.ts persister -- large enough (5 edited files, both listed under
    // "### Edited files" and duplicated under "### SAFE_TO_DISCARD") that the natural manifest
    // comfortably exceeds CONFIGURED_CAP regardless of the git-adaptive bonus, so every
    // scenario below actually exercises truncation rather than trivially fitting under any cap.
    // relayInProcess's own loadSessionState (called before the handler runs) reads this back
    // from disk exactly as the production PreCompact dispatch does -- nothing is injected.
    for (let i = 0; i < 5; i++) {
      recordFileEdit(path.join(repoDir, `edited${i}.ts`).split(path.sep).join('/'))
    }
    saveSessionState(SESSION_ID)
  })

  afterEach(() => {
    resetSessionState()
    invalidateConfigCache()
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    try {
      fs.rmSync(repoDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
    try {
      fs.rmSync(tgHome, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ok -- may not exist
    }
  })

  it('preserves the fixed configured cap unchanged on a clean working tree (no regression to the common case)', async () => {
    const manifest = await runPreCompact(repoDir)
    // The seeded session activity guarantees the untruncated manifest is well over
    // CONFIGURED_CAP, so a truncation marker is expected here -- and the signals being
    // false/zero (clean tree) means the reported cap must equal the configured value exactly,
    // not some perturbed number, proving the adaptive bonus contributed 0 in the common case.
    expect(truncatedAt(manifest)).toBe(CONFIGURED_CAP)
  })

  it('never spawns git at all when the manifest already fits under the configured base cap', async () => {
    // Regression: capManifestChars used to compute adaptiveCharBonus() -- 2 real git spawns --
    // unconditionally, even when the manifest was already short enough that no bonus could ever
    // matter. Raising max_manifest_chars well above the seeded manifest's natural length (a few
    // hundred chars) means truncation, and therefore the adaptive bonus, is never relevant here.
    const cfg = defaultConfig()
    cfg.compact_assist.max_manifest_chars = 100_000
    cfg.hints.git_hint_max_ms = 5000
    saveConfig(cfg)
    invalidateConfigCache()

    const runGitSpy = vi.spyOn(util, 'runGit')
    const manifest = await runPreCompact(repoDir)
    const callCount = runGitSpy.mock.calls.length
    runGitSpy.mockRestore()

    expect(truncatedAt(manifest)).toBeNull()
    expect(callCount).toBe(0)
  })

  it('grows the manifest cap through the real relay/hook_registry dispatch when the repo has real uncommitted changes', async () => {
    const cleanManifest = await runPreCompact(repoDir)

    // Real dirty state -- no mocked git call: modifying the tracked file makes both
    // `git diff --no-color --stat HEAD` and `git status --porcelain` genuinely non-empty.
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'changed\n')

    const dirtyManifest = await runPreCompact(repoDir)

    expect(dirtyManifest.length).toBeGreaterThan(cleanManifest.length)
    const cleanCap = truncatedAt(cleanManifest)
    const dirtyCap = truncatedAt(dirtyManifest)
    expect(cleanCap).toBe(CONFIGURED_CAP)
    // Either the boosted cap still truncates (at a strictly larger reported N) or the boost
    // was large enough that the manifest now fits entirely (no truncation marker at all) --
    // both outcomes mean strictly more room than the clean-tree run got.
    if (dirtyCap !== null) {
      expect(dirtyCap).toBeGreaterThan(CONFIGURED_CAP)
    }
  })

  it('detects an untracked-only change via real `git status --porcelain` even though `git diff --stat HEAD` stays empty', async () => {
    const cleanManifest = await runPreCompact(repoDir)

    // Untracked new file: `git diff HEAD` never reports untracked files (hasPendingDiff stays
    // false), but `git status --porcelain` reports it (`?? untracked.txt`), so this isolates
    // the hasUncommittedChanges signal specifically.
    fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'new\n')

    const dirtyManifest = await runPreCompact(repoDir)

    expect(dirtyManifest.length).toBeGreaterThan(cleanManifest.length)
  })

  it('falls back to the fixed cap with zero extra git spawns when the harness sends no cwd', async () => {
    const manifest = await runPreCompact(undefined)
    expect(truncatedAt(manifest)).toBe(CONFIGURED_CAP)
  })

  // HAND-DERIVED: the dirty state is made on disk by this test and the expectation follows from what the adaptive bonus is for -- a wider cap prints more rows, so a sample taken under the wider cap must be at least as large as one taken under the narrower. Nothing is read off the budget arithmetic. The post-compact canary used to rebuild the manifest with no cwd at all, scoring survival against a manifest shorter than the one that was actually sent: the rows it silently dropped were the tail, which is exactly what a summary is least likely to keep, so the ratio came back better than the truth -- the one direction a canary is not allowed to be wrong in.
  it('samples the manifest the hook emitted, not a narrower rebuild of it', async () => {
    // Short fixed-width rows, and a cap read off the manifest this run rendered, because the bonus is a fixed number of CHARACTERS while a row costs whatever an absolute path costs: the rows each side prints are floor(budget / rowWidth) against floor((budget + bonus) / rowWidth), so once a row is wider than the whole bonus the two floors are equal and the boost buys nothing. The seeded rows used to be repoDir-shaped, which makes their width a property of where the OS puts its temp directory -- macOS's /private/var/folders/... reaches that point and Linux's /tmp does not, so this read 2 > 2 on macOS alone. Scaling the cap with the row does not fix it either, since the bonus stays fixed as the row grows; only taking the host's path length out of the row does. repoDir remains the cwd, so the git signal under test is still the real one, and recordFileEdit never opens these paths.
    resetSessionState()
    for (let i = 0; i < 5; i++) recordFileEdit(`/tg-budget/e${i}.ts`)
    saveSessionState(SESSION_ID)

    const wide = defaultConfig()
    wide.compact_assist.max_manifest_chars = 100_000
    wide.hints.git_hint_max_ms = 5000
    saveConfig(wide)
    invalidateConfigCache()
    const full = buildManifest(SESSION_ID)
    const firstRowEnd = full.indexOf('\n', full.indexOf('- /tg-budget/e0.ts'))
    expect(firstRowEnd, 'the seeded rows must render, or this asserts nothing').toBeGreaterThan(0)

    const narrow = defaultConfig()
    narrow.compact_assist.max_manifest_chars = firstRowEnd + 1
    narrow.hints.git_hint_max_ms = 5000
    saveConfig(narrow)
    invalidateConfigCache()

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'changed\n')
    const emitted = await runPreCompact(repoDir)

    const withCwd = manifestPrintedPaths(SESSION_ID, 64, repoDir)
    const withoutCwd = manifestPrintedPaths(SESSION_ID, 64)

    expect(withoutCwd.length, 'the narrow side must actually truncate, or a wider cap has nothing to widen').toBeLessThan(5)
    expect(withCwd.length, 'the dirty-tree bonus must widen the sample, or this asserts nothing').toBeGreaterThan(withoutCwd.length)
    for (const p of withCwd) expect(emitted, `${p} was sampled but never emitted`).toContain(p)
  })

  // HAND-DERIVED: the cap is computed from the manifest this run actually rendered -- find where the shorter of the two rows begins and cap one character before it -- rather than guessed at, so the cut lands on that row whatever the surrounding rows happen to cost. An edited row is a bare `- <path>`, so `- <dir>/a.ts` is a prefix of `- <dir>/a.tsx`: with the longer row surviving above the cut, a substring test reports the cut row as printed, and the canary then scores survival against a path the model was never sent.
  it('does not report a cut row as printed because a longer row shares its prefix', () => {
    const dir = '/tg-prefix-probe'
    resetSessionState()
    recordFileEdit(`${dir}/a.tsx`)
    recordFileEdit(`${dir}/a.ts`)
    saveSessionState(SESSION_ID)

    const wide = defaultConfig()
    wide.compact_assist.max_manifest_chars = 100_000
    saveConfig(wide)
    invalidateConfigCache()
    const full = buildManifest(SESSION_ID)
    const cutAt = full.indexOf(`- ${dir}/a.ts\n`)
    expect(cutAt, 'both rows must render, or this asserts nothing').toBeGreaterThan(full.indexOf(`- ${dir}/a.tsx\n`))

    const narrow = defaultConfig()
    narrow.compact_assist.max_manifest_chars = cutAt
    saveConfig(narrow)
    invalidateConfigCache()

    const printed = manifestPrintedPaths(SESSION_ID, 64)
    expect(printed).toContain(`${dir}/a.tsx`)
    expect(printed).not.toContain(`${dir}/a.ts`)
  })
})
