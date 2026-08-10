/**
 * Built-bundle command matrix (pre-push / CI tier — slow).
 *
 * Builds the real shipping artifact (dist/token-goat.mjs), indexes one shared
 * git fixture, then runs EVERY registered command against the bundle and asserts
 * real output. The case table is driven off the same registry the fast
 * registration guard uses (tests/registry.ts::allCommandNames), so a newly
 * registered command with no matrix case fails the coverage gate automatically —
 * there is no second list to forget.
 *
 * Most commands get a concrete output assertion. A small set is inherently
 * unsuited to a hermetic real-output check and is verified for *reachability*
 * instead (the bundle dispatches to the handler, it is not a Commander
 * "unknown command" error, and it does not crash with a tree-shaken module
 * error): `web-output` (process-local cache, always a miss in a fresh process)
 * and `gdrive-sections` (needs network + a live public doc). These still catch
 * the unregistered / tree-shaken-out-of-bundle bug class.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { zipSync, strToU8 } from 'fflate'

import { allCommandNames } from './registry.js'

import { BUNDLE, ROOT } from './helpers/bundle.js'
import { buildDocxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

let repo: string // indexed fixture; default cwd for read commands
let dataBase: string // isolated data dir holding the shared index
let homeBase: string // fake OS home dir -- keeps `install`'s unconditional
// CLAUDE.md/skill writes (os.homedir()-based, not TOKEN_GOAT_HOME-scoped) off
// the real developer/CI machine's actual ~/.claude

const tempDirs: string[] = []

function tgEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir, HOME: homeBase, USERPROFILE: homeBase }
}

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd ?? repo,
    env: opts.env ?? tgEnv(dataBase),
    encoding: 'utf8',
    timeout: 30000,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** A read command run against the shared indexed fixture. */
function expectRead(args: string[], substr: string): void {
  const r = run(args)
  expect(r.status, `${args.join(' ')} stderr: ${r.stderr}`).toBe(0)
  expect(r.stdout).toContain(substr)
}

/**
 * Unwrap the shared `{items, truncated, totalCount}` `--json` envelope, asserting it against the
 * real built bundle before returning the rows. Row-list commands (`symbol`/`refs`/`skeleton`/
 * `outline`/`types`/`callers`/`dead`/`test-for`/`semantic`) all emit this shape unconditionally.
 */
function envelopeItems<T>(stdout: string): T[] {
  const parsed: unknown = JSON.parse(stdout)
  expect(Array.isArray(parsed)).toBe(false)
  const payload = parsed as { items: T[]; truncated: boolean; totalCount: number }
  expect(Array.isArray(payload.items)).toBe(true)
  expect(typeof payload.truncated).toBe('boolean')
  expect(typeof payload.totalCount).toBe('number')
  return payload.items
}

beforeAll(() => {
  dataBase = mkIsolated('tg-matrix-data-')
  repo = mkIsolated('tg-matrix-repo-')
  homeBase = mkIsolated('tg-matrix-home-')

  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function alphaSym(): number {\n' +
      '  // alphamarker keyword for semantic and grep\n' +
      '  return 1\n}\n' +
      'export function betaSym(): number {\n  return 2\n}\n',
  )
  // Same-file caller so `refs --callers` has a resolvable enclosing function.
  fs.writeFileSync(
    path.join(repo, 'caller.ts'),
    'export function refHelper(): number {\n  return 1\n}\n' +
      'export function refDriver(): number {\n  return refHelper() + refHelper()\n}\n',
  )
  // Importer file so `imports` has a real module specifier to list.
  fs.writeFileSync(
    path.join(repo, 'app.ts'),
    "import { alphaSym } from './src/mod.js'\n" +
      'export function useAlpha(): number {\n  return alphaSym()\n}\n',
  )
  // Second importer with a DISJOINT module specifier, so `imports "a,b"` can be asserted on a
  // specifier unique to each file rather than on mere non-emptiness.
  fs.writeFileSync(
    path.join(repo, 'ctximporter.ts'),
    "import { refHelper } from './caller.js'\n" +
      'export function useRefHelper(): number {\n  return refHelper()\n}\n',
  )
  // Fixture for `refs`/`callers` --exclude-tests: one production call site and two test-file
  // call sites of the same symbol, plus a dead symbol defined ONLY in a test file (for `dead
  // --exclude-tests`, which filters on the DEFINITION site rather than a reference site).
  fs.writeFileSync(
    path.join(repo, 'exclhelper.ts'),
    'export function exclHelperFn(): number {\n  return 1\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'exclprod.ts'),
    'export function exclProdCaller(): number {\n  return exclHelperFn()\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'exclcaller.test.ts'),
    'export function exclTestCallerA(): number {\n  return exclHelperFn()\n}\n' +
      'export function exclTestCallerB(): number {\n  return exclHelperFn()\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'excldead.test.ts'),
    'export function exclDeadOnlyInTest(): number {\n  return 99\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    '# Fixture\n\n## Install\n\nRun npm install to set up the project.\n',
  )
  fs.writeFileSync(path.join(repo, 'pkg.json'), '{\n  "version": "3.2.1"\n}\n')
  // Same-file ambiguous symbol (a top-level function and an unrelated class method share the
  // name 'dup') so the `read` case below can exercise the `file::symbol@LINE` anchor form
  // against the real built bundle, not just the in-process unit tests.
  fs.writeFileSync(
    path.join(repo, 'dupfile.ts'),
    'export class DupHolder {\n  dup(): number {\n    return 10\n  }\n}\n' +
      'export function dup(): number {\n  return 20\n}\n',
  )

  // Fixture for `grep --symbol`: two distinct functions each containing a match (proves the
  // annotation isn't hardcoded to symbols[0]), plus one match at module/top-level scope outside
  // any function (proves an out-of-scope hit gets no symbol tag rather than the nearest one).
  fs.writeFileSync(
    path.join(repo, 'grepsym.ts'),
    'export function grepsymFirst(): number {\n' +
      '  // grepsymmarker inside first\n' +
      '  return 1\n' +
      '}\n' +
      'export function grepsymSecond(): number {\n' +
      '  // grepsymmarker inside second\n' +
      '  return 2\n' +
      '}\n' +
      '// grepsymmarker module top level\n',
  )
  // Fixture for `exports` location: one export the parser indexes (has a symbol row) and one
  // re-export form extractExportNames catches from source text but querySymbols never indexes
  // (it isn't declared in this file, only re-exported).
  fs.writeFileSync(
    path.join(repo, 'exportsloc.ts'),
    'export function indexedExportLoc(): number {\n  return 42\n}\n' +
      "export { reExportedOnlyLoc } from './somewhere'\n",
  )

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git(['init'])
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])
  // Fixture for `types --grep`: two type declarations with disjoint names so a grep pattern can
  // be asserted to keep one and drop the other.
  fs.writeFileSync(
    path.join(repo, 'typesgrep.ts'),
    'export interface TypesGrepAlphaFixture { x: number }\nexport interface TypesGrepBetaFixture { y: number }\n',
  )

  // Second commit touching src/mod.ts so `changed --since HEAD~1` has a diff.
  fs.appendFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function gammaSym(): number {\n  return 3\n}\n',
  )
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second'])

  const idx = run(['index', '.'])
  expect(idx.status, `index failed: ${idx.stderr}`).toBe(0)
  expect(idx.stdout).toMatch(/Indexed \d+ files/)
}, 120000)

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering detached worker can briefly hold a temp dir on Windows
    }
  }
})

// Mitigates a known vitest 2.x/3.x infra flake (vitest-dev/vitest#6479, #8164, fixed upstream in
// v4.0.0-beta.4 / v4.1.6+ via PR #8297; we are pinned to 2.1.9): birpc, vitest's fork<->main-thread
// RPC layer, has a hardcoded 60s timeout on its own heartbeat calls (e.g. onTaskUpdate) in this
// version, independent of the user-configurable testTimeout. Each `it()` case here runs `run()`,
// which shells out via `spawnSync` -- fully synchronous, so it blocks this fork's event loop for
// the whole subprocess lifetime and can't service that heartbeat while blocked. Under heavy
// system load (the full ~249-file suite running many parallel forks, plus two other
// subprocess/CPU-heavy tests earlier in this same file), that can occasionally push a heartbeat
// round trip past the fixed 60s ceiling, surfacing as `[vitest-worker]: Timeout calling
// "onTaskUpdate"` with zero actual test-assertion failures (already absorbed via
// `retry: process.env.CI ? 1 : 0` in vitest.config.ts as a second line of defense). Explicitly
// yielding the event loop after every test gives that heartbeat a guaranteed chance to be
// serviced between tests, which is the documented vitest-community mitigation for this exact
// issue on pre-4.1.6 vitest. It doesn't change what any test does or asserts.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

// Minimal hand-authored single-page PDF (Helvetica text object) for the pdf-extract case below.
const MINIMAL_PDF = '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n' +
  'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n'

/**
 * One assertion per registered command. Keys MUST equal the registered command
 * set (enforced by the coverage gate below). Read commands run against the
 * shared indexed fixture; stateful commands use their own isolated dirs.
 */
const cases: Record<string, () => void | Promise<void>> = {
  index: () => {
    const r = run(['index', '.'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Indexed \d+ files/)
  },
  symbol: () => {
    expectRead(['symbol', 'alphaSym'], 'alphaSym')
    // A SECOND project sharing this global index and defining the same symbol name is what makes
    // this falsifiable. With only the one fixture repo, bare and --project return the same single
    // row, so the assertions pass even when the CLI registers --project and never forwards
    // projectRoot -- verified: severing that wiring while leaving the flag registered left the
    // whole matrix green. Two projects make the counts differ, so the wiring itself is pinned.
    const otherRepo = mkIsolated('tg-matrix-other-')
    fs.writeFileSync(path.join(otherRepo, 'other.ts'), 'export function alphaSym(): number {\n  return 9\n}\n')
    const otherIdx = run(['index', '.', '--walk'], { cwd: otherRepo })
    expect(otherIdx.status, `index of second project failed: ${otherIdx.stderr}`).toBe(0)

    const global = run(['symbol', 'alphaSym', '--json'])
    expect(global.status, global.stderr).toBe(0)
    const globalItems = (JSON.parse(global.stdout) as { items: Array<{ filePath: string }> }).items
    const globalFiles = globalItems.map((i) => i.filePath.replace(/\\/g, '/')).sort()
    expect(globalFiles.length).toBe(2)
    expect(globalFiles.some((f) => f.includes('other.ts'))).toBe(true)

    const scoped = run(['symbol', 'alphaSym', '--project', '--json'])
    expect(scoped.status, scoped.stderr).toBe(0)
    const scopedPayload = JSON.parse(scoped.stdout) as { items: Array<{ name: string; filePath: string }> }
    expect(scopedPayload.items.length).toBe(1)
    expect(scopedPayload.items[0]?.name).toBe('alphaSym')
    expect(scopedPayload.items[0]?.filePath.replace(/\\/g, '/')).toContain('src/mod.ts')

    // `--json`'s filePath now renders root-relative against the real built binary, matching
    // outline/skeleton/refs --json -- pinned as an exact equality (not just `.toContain`) so a
    // regression back to the absolute spelling is caught.
    expect(scopedPayload.items[0]?.filePath.replace(/\\/g, '/')).toBe('src/mod.ts')
  },
  read: () => {
    expectRead(['read', 'src/mod.ts::alphaSym'], 'return 1')
    // Comma-separated multi-symbol form against the real built bundle -- proves the shipping CLI path, not just the in-process unit tests.
    const multi = run(['read', 'src/mod.ts::alphaSym,betaSym'])
    expect(multi.status, multi.stderr).toBe(0)
    expect(multi.stdout).toContain('alphaSym')
    expect(multi.stdout).toContain('return 1')
    expect(multi.stdout).toContain('betaSym')
    expect(multi.stdout).toContain('return 2')
    // Cross-file form `a::x,b::y` against the real built bundle. Worth its own bundle case rather than trusting the in-process test: the whole bug this closed was a spec MIS-PARSE (lastIndexOf('::') folding the comma-joined spec into one bogus filename), so it can only be proven dead by handing the real argv through the shipping CLI.
    const cross = run(['read', 'src/mod.ts::alphaSym,caller.ts::refHelper'])
    expect(cross.status, cross.stderr).toBe(0)
    expect(cross.stdout).toContain('src/mod.ts::alphaSym')
    expect(cross.stdout).toContain('return 1')
    expect(cross.stdout).toContain('caller.ts::refHelper')
    // --stats against the real built bundle -- proves the flag reaches the shipping CLI, not
    // just the in-process unit tests.
    const stats = run(['read', 'src/mod.ts::alphaSym', '--stats'])
    expect(stats.status, stats.stderr).toBe(0)
    expect(stats.stdout).toMatch(/\[\d+ refs, (un)?documented\]/)
    // file::symbol@LINE anchor, round-tripped through the real built bundle. `dupfile.ts`
    // deliberately has two definitions named 'dup' (a class method and a top-level function) --
    // the ambiguity error's own suggested retry is parsed out and re-run rather than hardcoding
    // an assumed line number, since that suggestion IS the anchor form under test.
    const ambiguous = run(['read', 'dupfile.ts::dup'])
    expect(ambiguous.status).toBe(1)
    expect(ambiguous.stderr).toContain("Ambiguous symbol 'dup'")
    const anchoredRetry = /token-goat read "(dupfile\.ts::dup@\d+)"/.exec(ambiguous.stderr)
    expect(anchoredRetry, ambiguous.stderr).not.toBeNull()
    const anchored = run(['read', anchoredRetry![1]!])
    expect(anchored.status, anchored.stderr).toBe(0)
    expect(anchored.stdout).toContain('return 20')
    expect(anchored.stdout).not.toContain('return 10')
  },
  section: () => expectRead(['section', 'README.md::Install'], 'npm install'),
  // Deliberately a keyword smoke test, not a proof of real embedding-vector search: this
  // shared fixture is indexed with embeddings disabled (isolate-home.ts sets
  // TOKEN_GOAT_EMBEDDINGS_ENABLED=false for the whole suite, and tgEnv inherits it), so this
  // case only exercises the FTS keyword fallback and would pass identically whether or not
  // real semantic search is wired up - it is not a substitute for that proof. The dedicated
  // proof - a meaning-only natural-language query finding a symbol whose name/body never uses
  // the query's words, with a control run showing the same query genuinely misses under FTS
  // alone - lives in tests/semantic_embeddings_e2e.test.ts.
  semantic: () => {
    expectRead(['semantic', 'alphamarker'], 'alphaSym')
    // --json against the real built bundle: proves the JSON envelope (guardJsonRows'
    // {items, truncated, totalCount}) actually reaches stdout through the shipped CLI, not just
    // through the in-process runSemantic() unit tests.
    const r = run(['semantic', 'alphamarker', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const payload = JSON.parse(r.stdout) as { source: string; items: Array<{ filePath: string }>; truncated: boolean; totalCount: number }
    expect(['embeddings', 'fts']).toContain(payload.source)
    expect(Array.isArray(payload.items)).toBe(true)
    expect(payload.items.length).toBeGreaterThan(0)
    expect(typeof payload.truncated).toBe('boolean')
    expect(typeof payload.totalCount).toBe('number')
    // `--json`'s filePath now renders root-relative against the real built binary, matching
    // outline/skeleton/refs --json.
    for (const item of payload.items) {
      expect(item.filePath.replace(/\\/g, '/')).not.toContain(repo.split(path.sep).join('/'))
      expect(path.isAbsolute(item.filePath)).toBe(false)
    }
  },
  skeleton: () => {
    expectRead(['skeleton', 'src/mod.ts'], 'alphaSym')
    const r = run(['skeleton', 'src/mod.ts', '--stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+ refs/)
    // Comma-separated multi-file spec: both files reported, each with a symbol unique to it.
    // Same flag on skeleton, exercised on the shipping bundle rather than only in unit tests.
    const skGrep = run(['skeleton', 'src/mod.ts', '--grep', 'alphaSym'])
    expect(skGrep.status, skGrep.stderr).toBe(0)
    expect(skGrep.stdout).toContain('alphaSym')
    const multi = run(['skeleton', 'src/mod.ts,caller.ts'])
    expect(multi.status, multi.stderr).toBe(0)
    expect(multi.stdout).toContain('# Skeleton: src/mod.ts')
    expect(multi.stdout).toContain('# Skeleton: caller.ts')
    expect(multi.stdout).toContain('alphaSym')
    expect(multi.stdout).toContain('refDriver')
  },
  outline: () => {
    expectRead(['outline', 'src/mod.ts'], 'alphaSym')
    const r = run(['outline', 'src/mod.ts', '--stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+ refs/)
    // Comma-separated multi-file spec: both files reported, each with a symbol unique to it.
    // A multi-file spec with --json must be ONE parseable document, not two concatenated ones.
    const multiJson = run(['outline', 'src/mod.ts,caller.ts', '--json'])
    expect(multiJson.status, multiJson.stderr).toBe(0)
    const mergedNames = (JSON.parse(multiJson.stdout) as { items: Array<{ name: string }> }).items.map((i) => i.name)
    expect(mergedNames).toContain('alphaSym')
    expect(mergedNames).toContain('refDriver')
    const multi = run(['outline', 'src/mod.ts,caller.ts'])
    expect(multi.status, multi.stderr).toBe(0)
    expect(multi.stdout).toContain('# Outline: src/mod.ts')
    expect(multi.stdout).toContain('# Outline: caller.ts')
    expect(multi.stdout).toContain('alphaSym')
    expect(multi.stdout).toContain('refDriver')
    // --grep narrows by symbol name against the real built binary, and an all-filtered result names the filter instead of looking like an empty file.
    const grepped = run(['outline', 'src/mod.ts', '--grep', 'alphaSym'])
    expect(grepped.status, grepped.stderr).toBe(0)
    expect(grepped.stdout).toContain('alphaSym')
    const grepMiss = run(['outline', 'src/mod.ts', '--grep', 'zzzzNoSuchSymbol'])
    expect(grepMiss.status, grepMiss.stderr).toBe(0)
    expect(grepMiss.stdout).toContain('--grep zzzzNoSuchSymbol')
    expect(grepMiss.stdout).toContain('filtered out')
    // Extra space-separated file arguments are named, not silently dropped.
    const extra = run(['outline', 'src/mod.ts', 'caller.ts'])
    expect(extra.status, extra.stderr).toBe(0)
    expect(extra.stdout).toContain('token-goat outline "src/mod.ts,caller.ts"')
  },
  brief: () => {
    const r = run(['brief', 'src/mod.ts::alphaSym'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('alphaSym')
    expect(r.stdout).toContain('return 1')
    expect(r.stdout).toMatch(/Callers \(\d+\)/)
    // Comma-separated multi-symbol form against the real built bundle -- proves the shipping CLI path, not just the in-process unit tests.
    const multi = run(['brief', 'src/mod.ts::alphaSym,betaSym'])
    expect(multi.status, multi.stderr).toBe(0)
    expect(multi.stdout).toContain('alphaSym')
    expect(multi.stdout).toContain('return 1')
    expect(multi.stdout).toContain('betaSym')
    expect(multi.stdout).toContain('return 2')

    // `--json`'s symbol.filePath now renders root-relative against the real built binary,
    // matching the plain-text block above and the outline/skeleton/refs --json convention.
    const j = run(['brief', 'src/mod.ts::alphaSym', '--json'])
    expect(j.status, j.stderr).toBe(0)
    const payload = JSON.parse(j.stdout) as { symbol: { filePath: string } }
    expect(payload.symbol.filePath.replace(/\\/g, '/')).toBe('src/mod.ts')
  },
  refs: () => {
    const r = run(['refs', 'caller.ts::refHelper', '--callers'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver|caller\.ts/)

    const top = run(['refs', 'caller.ts::refHelper', '--top', '1'])
    expect(top.status, top.stderr).toBe(0)
    expect(top.stdout).toMatch(/references across \d+ files? \(showing top 1\)/)

    // -C renders real call-site source; omitting it leaves output byte-identical.
    const plain = run(['refs', 'caller.ts::refHelper'])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).not.toContain('return refHelper() + refHelper()')
    const ctx = run(['refs', 'caller.ts::refHelper', '-C', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    expect(ctx.stdout).toContain('return refHelper() + refHelper()')
    const zero = run(['refs', 'caller.ts::refHelper', '-C', '0'])
    expect(zero.stdout).toBe(plain.stdout)

    // --exclude-tests: opt-in, additive. Absent the flag, both test-file callers are present
    // (byte-identical to today); with it, only the production caller remains and the two test
    // paths are gone -- proves the flag is actually threaded through, not just registered.
    const withoutFlag = run(['refs', 'exclhelper.ts::exclHelperFn'])
    expect(withoutFlag.status, withoutFlag.stderr).toBe(0)
    expect(withoutFlag.stdout).toContain('exclprod.ts')
    expect(withoutFlag.stdout).toContain('exclcaller.test.ts')
    const withFlag = run(['refs', 'exclhelper.ts::exclHelperFn', '--exclude-tests'])
    expect(withFlag.status, withFlag.stderr).toBe(0)
    expect(withFlag.stdout).toContain('exclprod.ts')
    expect(withFlag.stdout).not.toContain('exclcaller.test.ts')
    expect(withFlag.stdout).toContain('hidden by --exclude-tests')

    // Cross-file spec path (runRefsCrossFile) is a distinct code path from the single-symbol
    // spec above -- exercise it against the real built bundle too.
    const crossWithFlag = run(['refs', 'exclhelper.ts::exclHelperFn,src/mod.ts::alphaSym', '--exclude-tests'])
    expect(crossWithFlag.status, crossWithFlag.stderr).toBe(0)
    expect(crossWithFlag.stdout).not.toContain('exclcaller.test.ts')

    // --grep: filters on the call-site FILE PATH, not the enclosing symbol name. A matching
    // pattern keeps only that file's references; a non-matching pattern must not read as "no
    // references found" (the symbol IS referenced -- --grep just filtered every hit).
    const grepMatch = run(['refs', 'exclhelper.ts::exclHelperFn', '--grep', 'exclprod'])
    expect(grepMatch.status, grepMatch.stderr).toBe(0)
    expect(grepMatch.stdout).toContain('exclprod.ts')
    expect(grepMatch.stdout).not.toContain('exclcaller.test.ts')
    const grepEmpty = run(['refs', 'exclhelper.ts::exclHelperFn', '--grep', 'nomatch-zz-12345'])
    expect(grepEmpty.status, grepEmpty.stderr).toBe(0)
    expect(grepEmpty.stdout).toMatch(/filtered out by --grep/)
    expect(grepEmpty.stdout).not.toMatch(/no references found/)
    // An invalid regex must fall back to a literal substring match, never error.
    const grepBadRegex = run(['refs', 'exclhelper.ts::exclHelperFn', '--grep', '[unclosed'])
    expect(grepBadRegex.status, grepBadRegex.stderr).toBe(0)
    expect(grepBadRegex.stdout + grepBadRegex.stderr).not.toMatch(/unknown command|is not a function/)

    // Arity independence: one path, one spelling. The single-symbol path used to resolve a display root while the multi-symbol and cross-file paths passed none, so the identical row rendered `ctximporter.ts:3` in one form and the machine-specific absolute path in the others. `repo` is the project root here, so a root-relative row can never contain it.
    const repoFwd = repo.split(path.sep).join('/')
    const arityForms = [
      run(['refs', 'caller.ts::refHelper']),
      run(['refs', 'caller.ts::refHelper,refDriver']),
      run(['refs', 'caller.ts::refHelper,src/mod.ts::alphaSym']),
    ]
    for (const form of arityForms) {
      expect(form.status, form.stderr).toBe(0)
      // Negative control on the same line: the row IS present (so `not.toContain(repo)` cannot pass vacuously on an empty listing) and it carries no absolute prefix.
      expect(form.stdout).toMatch(/(^|\s)ctximporter\.ts:\d+:/m)
      expect(form.stdout).not.toContain(repo)
      expect(form.stdout).not.toContain(repoFwd)
    }

    // --json carries the same spelling as the text rows, in every arity.
    for (const spec of ['caller.ts::refHelper', 'caller.ts::refHelper,refDriver', 'caller.ts::refHelper,src/mod.ts::alphaSym']) {
      const j = run(['refs', spec, '--json'])
      expect(j.status, j.stderr).toBe(0)
      expect(j.stdout).toContain('"filePath": "ctximporter.ts"')
      expect(j.stdout).not.toContain(repo)
      expect(j.stdout).not.toContain(repoFwd)
    }

    // An anchored --grep must match what the rows show, in every arity -- the exact defect 2591a37c fixed for the single form, which the other two must not reintroduce.
    for (const spec of ['caller.ts::refHelper', 'caller.ts::refHelper,refDriver', 'caller.ts::refHelper,src/mod.ts::alphaSym']) {
      const anchored = run(['refs', spec, '--grep', '^ctximporter'])
      expect(anchored.status, anchored.stderr).toBe(0)
      expect(anchored.stdout).toMatch(/(^|\s)ctximporter\.ts:\d+:/m)
      // Negative control: --grep really filters -- the same-file caller site is dropped.
      expect(anchored.stdout).not.toMatch(/(^|\s)caller\.ts:\d+:/m)
    }
  },
  exports: () => {
    expectRead(['exports', 'src/mod.ts'], 'alphaSym')
    const plain = run(['exports', 'exportsloc.ts'])
    expect(plain.status, plain.stderr).toBe(0)
    // Indexed export gets a location suffix; the unindexed re-export does not.
    expect(plain.stdout).toMatch(/indexedExportLoc \(\d+-\d+\)/)
    expect(plain.stdout).toMatch(/^\S+\s+reExportedOnlyLoc\s*$/m)

    const j = run(['exports', 'exportsloc.ts', '--json'])
    expect(j.status, j.stderr).toBe(0)
    const items = JSON.parse(j.stdout) as Array<{ name: string; lineStart: number | null; lineEnd: number | null }>
    const indexed = items.find((i) => i.name === 'indexedExportLoc')
    const unindexed = items.find((i) => i.name === 'reExportedOnlyLoc')
    expect(indexed?.lineStart).toBe(1)
    expect(indexed?.lineEnd).toBe(3)
    // Cross-check against a second command rather than eyeballing.
    // outline maps a file without its bodies; the JSON branch must not ship them either (it used to, via a raw row spread).
    const outlineJson = run(['outline', 'exportsloc.ts', '--json'])
    expect(outlineJson.status, outlineJson.stderr).toBe(0)
    const outlineItems = JSON.parse(outlineJson.stdout) as { items: Array<{ name: string; lineStart: number; lineEnd: number }> }
    const outlineSym = outlineItems.items.find((s) => s.name === 'indexedExportLoc')
    expect(outlineSym?.lineStart).toBe(indexed?.lineStart)
    expect(outlineSym?.lineEnd).toBe(indexed?.lineEnd)
    expect(outlineSym).not.toHaveProperty('body')
    expect(unindexed?.lineStart).toBe(null)
    expect(unindexed?.lineEnd).toBe(null)

    // --grep narrows by exported NAME against the real built binary, and an all-filtered
    // result names the filter instead of looking like the file has no exports at all.
    const grepped = run(['exports', 'exportsloc.ts', '--grep', 'indexedExportLoc'])
    expect(grepped.status, grepped.stderr).toBe(0)
    expect(grepped.stdout).toContain('indexedExportLoc')
    expect(grepped.stdout).not.toContain('reExportedOnlyLoc')

    const grepMiss = run(['exports', 'exportsloc.ts', '--grep', 'zzzzNoSuchExport'])
    expect(grepMiss.status, grepMiss.stderr).toBe(0)
    expect(grepMiss.stdout).toContain('--grep zzzzNoSuchExport')
    expect(grepMiss.stdout).not.toContain('No exported symbols found')

    // Invalid regex falls back to a literal substring match instead of erroring.
    const grepInvalid = run(['exports', 'exportsloc.ts', '--grep', '[unclosed'])
    expect(grepInvalid.status, grepInvalid.stderr).toBe(0)
  },
  imports: () => {
    const r = run(['imports', 'app.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod/)
    // Comma-separated multi-file spec: one headed block per file.
    const multi = run(['imports', 'app.ts,ctximporter.ts'])
    expect(multi.status, multi.stderr).toBe(0)
    expect(multi.stdout).toContain('# Imports: app.ts')
    expect(multi.stdout).toContain('# Imports: ctximporter.ts')
    expect(multi.stdout).toContain('./src/mod.js')
    expect(multi.stdout).toContain('./caller.js')

    // --grep narrows by MODULE SPECIFIER, and an all-filtered result names the filter
    // instead of looking like the file has no imports at all.
    const grepped = run(['imports', 'app.ts', '--grep', 'mod'])
    expect(grepped.status, grepped.stderr).toBe(0)
    expect(grepped.stdout).toContain('mod')

    const grepMiss = run(['imports', 'app.ts', '--grep', 'zzzzNoSuchImport'])
    expect(grepMiss.status, grepMiss.stderr).toBe(0)
    expect(grepMiss.stdout).toContain('--grep zzzzNoSuchImport')
    expect(grepMiss.stdout).not.toContain('No imports found')

    // Invalid regex falls back to a literal substring match instead of erroring.
    const grepInvalid = run(['imports', 'app.ts', '--grep', '[unclosed'])
    expect(grepInvalid.status, grepInvalid.stderr).toBe(0)
  },
  find: () => expectRead(['find', 'alphaSym'], 'mod'),
  grep: () => {
    expectRead(['grep', 'alphamarker', '.'], 'alphamarker')

    // Plain grep (no --symbol) must be byte-identical to the pre-change baseline output.
    const plain = run(['grep', 'grepsymmarker', 'grepsym.ts'])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).not.toContain('[')

    const withSymbol = run(['grep', 'grepsymmarker', 'grepsym.ts', '--symbol'])
    expect(withSymbol.status, withSymbol.stderr).toBe(0)
    const lines = withSymbol.stdout.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    // Order matches file order: first function, second function, then the trailing
    // module/top-level comment (outside any function's line range).
    expect(lines[0]).toContain('[grepsymFirst (function)]')
    expect(lines[1]).toContain('[grepsymSecond (function)]')
    expect(lines[2]).not.toMatch(/\[/)

    const withSymbolJson = run(['grep', 'grepsymmarker', 'grepsym.ts', '--symbol', '--json'])
    expect(withSymbolJson.status, withSymbolJson.stderr).toBe(0)
    const items = (JSON.parse(withSymbolJson.stdout) as { items: Array<{ line: number; symbol: { name: string; kind: string } | null }> }).items
    expect(items.length).toBe(3)
    expect(items[0]?.symbol?.name).toBe('grepsymFirst')
    expect(items[0]?.symbol?.kind).toBe('function')
    expect(items[1]?.symbol?.name).toBe('grepsymSecond')
    expect(items[1]?.symbol?.kind).toBe('function')
    expect(items[2]?.symbol).toBe(null)
  },
  changed: () => {
    const r = run(['changed', '--since', 'HEAD~1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod\.ts/)
    // Regression: --symbol must be hunk-scoped to the lines the diff actually touched,
    // not every symbol in a file that has any changed line. The second commit only
    // appended gammaSym to the end of src/mod.ts, so alphaSym/betaSym (defined above
    // the appended hunk, untouched) must not be reported as changed symbols.
    const rs = run(['changed', '--since', 'HEAD~1', '--symbol'])
    expect(rs.status, rs.stderr).toBe(0)
    expect(rs.stdout).toContain('gammaSym')
    expect(rs.stdout).not.toContain('alphaSym')
    expect(rs.stdout).not.toContain('betaSym')
    // Regression: `changed <ref>` positional form (README-documented) must reach the same
    // resolution as `--since <ref>` through the built bundle, not be silently dropped.
    const rPositional = run(['changed', 'HEAD~1'])
    expect(rPositional.status, rPositional.stderr).toBe(0)
    expect(rPositional.stdout).toMatch(/mod\.ts/)
    // Regression: bare `changed` in this fixture's 2-commit shallow repo must fail against
    // the default HEAD~5 with the hint appended, instead of a bare unexplained git error.
    const rBareShallow = run(['changed'])
    expect(rBareShallow.status).toBe(1)
    expect(rBareShallow.stderr).toContain('git diff failed')
    expect(rBareShallow.stderr).toMatch(/Hint: this repo has only 2 commits/)
    expect(rBareShallow.stderr).toContain('token-goat changed --since HEAD~1')

    // --grep: filters on the changed FILE PATH. A matching pattern keeps the file; a
    // non-matching pattern must not read as "No files changed." (a file DID change, --grep
    // just filtered it out).
    const grepMatch = run(['changed', '--since', 'HEAD~1', '--grep', 'mod'])
    expect(grepMatch.status, grepMatch.stderr).toBe(0)
    expect(grepMatch.stdout).toMatch(/mod\.ts/)
    const grepEmpty = run(['changed', '--since', 'HEAD~1', '--grep', 'nomatch-zz-12345'])
    expect(grepEmpty.status, grepEmpty.stderr).toBe(0)
    expect(grepEmpty.stdout).toMatch(/filtered out by --grep/)
    expect(grepEmpty.stdout).not.toMatch(/No files changed/)
    // An invalid regex must fall back to a literal substring match, never error.
    const grepBadRegex = run(['changed', '--since', 'HEAD~1', '--grep', '[unclosed'])
    expect(grepBadRegex.status, grepBadRegex.stderr).toBe(0)
    expect(grepBadRegex.stdout + grepBadRegex.stderr).not.toMatch(/unknown command|is not a function/)
  },
  diff: () => {
    // gammaSym was added by the second commit; alphaSym/betaSym are untouched by it.
    const r = run(['diff', 'src/mod.ts::gammaSym', 'HEAD~1..HEAD'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('gammaSym')
    const rUnchanged = run(['diff', 'src/mod.ts::alphaSym', 'HEAD~1..HEAD'])
    expect(rUnchanged.status, rUnchanged.stderr).toBe(0)
    expect(rUnchanged.stdout).toMatch(/No changes/)
    const rMissing = run(['diff', 'src/mod.ts::doesNotExistSym'])
    expect(rMissing.status).toBe(1)
    expect(rMissing.stderr).toContain('not found')
  },
  log: () => {
    // gammaSym was added by the second commit; the log for its own line range should show that
    // commit's history, scoped via git's own `-L` line-range tracking.
    const r = run(['log', 'src/mod.ts::gammaSym'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('gammaSym')
    expect(r.stdout).toContain('second')
    const rMissing = run(['log', 'src/mod.ts::doesNotExistSym'])
    expect(rMissing.status).toBe(1)
    expect(rMissing.stderr).toContain('not found')
  },
  'config-get': () => expectRead(['config-get', 'pkg.json', 'version'], '3.2.1'),
  'csv-query': () => {
    const dir = mkIsolated('tg-matrix-csv-')
    const csvPath = path.join(dir, 'people.csv')
    fs.writeFileSync(csvPath, 'id,name,status\n1,Alice,active\n2,Bob,inactive\n')
    const r = run(['csv-query', csvPath, '--where', 'status=active'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).not.toContain('Bob')
    const rMulti = run(['csv-query', csvPath, '--where', 'status!=active', '--where', 'name=Bob'])
    expect(rMulti.status, rMulti.stderr).toBe(0)
    expect(rMulti.stdout).toContain('Bob')
    expect(rMulti.stdout).not.toContain('Alice')
  },
  'csv-profile': () => {
    const dir = mkIsolated('tg-matrix-csvprof-')
    const csvPath = path.join(dir, 'people.csv')
    fs.writeFileSync(csvPath, 'id,name,status\n1,Alice,active\n2,Bob,inactive\n')
    const r = run(['csv-profile', csvPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('id  (number)')
    expect(r.stdout).toContain('status  (string)')
  },
  'json-outline': () => {
    const dir = mkIsolated('tg-matrix-jsonoutline-')
    const jsonPath = path.join(dir, 'people.json')
    fs.writeFileSync(
      jsonPath,
      JSON.stringify([
        { id: 1, name: 'Alice', status: 'active' },
        { id: 2, name: 'Bob', status: 'inactive' },
      ]),
    )
    const r = run(['json-outline', jsonPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('array of 2 elements (object)')
    expect(r.stdout).toContain('name: string')
  },
  'json-query': () => {
    const dir = mkIsolated('tg-matrix-jsonquery-')
    const jsonPath = path.join(dir, 'people.json')
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        items: [
          { id: 1, name: 'Alice', status: 'active' },
          { id: 2, name: 'Bob', status: 'inactive' },
        ],
      }),
    )
    const r = run(['json-query', jsonPath, 'items[status=active].name'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).not.toContain('Bob')
  },
  'yaml-outline': () => {
    const dir = mkIsolated('tg-matrix-yamloutline-')
    const yamlPath = path.join(dir, 'people.yaml')
    fs.writeFileSync(yamlPath, '- id: 1\n  name: Alice\n  status: active\n- id: 2\n  name: Bob\n  status: inactive\n')
    const r = run(['yaml-outline', yamlPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('array of 2 elements (object)')
    expect(r.stdout).toContain('name: string')
  },
  'yaml-query': () => {
    const dir = mkIsolated('tg-matrix-yamlquery-')
    const yamlPath = path.join(dir, 'people.yaml')
    fs.writeFileSync(
      yamlPath,
      'items:\n  - id: 1\n    name: Alice\n    status: active\n  - id: 2\n    name: Bob\n    status: inactive\n',
    )
    const r = run(['yaml-query', yamlPath, 'items[status=active].name'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).not.toContain('Bob')
  },
  'openapi-outline': () => {
    const dir = mkIsolated('tg-matrix-openapioutline-')
    const specPath = path.join(dir, 'openapi.json')
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.0.0',
        paths: {
          '/users/{id}': {
            get: { operationId: 'getUserById', summary: 'Get a user by ID', tags: ['users'], responses: { '200': { description: 'OK' } } },
          },
        },
      }),
    )
    const r = run(['openapi-outline', specPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('GET')
    expect(r.stdout).toContain('/users/{id}')
    expect(r.stdout).toContain('[getUserById]')
  },
  'openapi-op': () => {
    const dir = mkIsolated('tg-matrix-openapiop-')
    const specPath = path.join(dir, 'openapi.json')
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        openapi: '3.0.0',
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUserById',
              summary: 'Get a user by ID',
              tags: ['users'],
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
            },
          },
        },
      }),
    )
    const r = run(['openapi-op', specPath, 'getUserById'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('GET /users/{id}')
    expect(r.stdout).toContain('404:')
  },
  'zip-list': () => {
    const dir = mkIsolated('tg-matrix-ziplist-')
    const zipPath = path.join(dir, 'fixture.zip')
    fs.writeFileSync(
      zipPath,
      zipSync({
        'README.md': strToU8('# hello\n'),
        'src/index.ts': strToU8('export const x = 1\n'),
      }),
    )
    const r = run(['zip-list', zipPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('README.md')
    expect(r.stdout).toContain('src/index.ts')

    const rJson = run(['zip-list', zipPath, '--json'])
    expect(rJson.status, rJson.stderr).toBe(0)
    const parsed = JSON.parse(rJson.stdout) as Array<{ path: string }>
    expect(parsed.map((e) => e.path)).toEqual(['README.md', 'src/index.ts'])
  },
  'zip-read': () => {
    const dir = mkIsolated('tg-matrix-zipread-')
    const zipPath = path.join(dir, 'fixture.zip')
    fs.writeFileSync(zipPath, zipSync({ 'a.txt': strToU8('hello world\n') }))
    const r = run(['zip-read', zipPath, 'a.txt'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('hello world')

    const rMissing = run(['zip-read', zipPath, 'does-not-exist.txt'])
    expect(rMissing.status).toBe(1)
    expect(rMissing.stderr).toContain('not found')
  },
  'pr-slice': () => {
    // gh's presence/auth state varies by machine and CI image (and this suite must stay
    // hermetic -- no real gh/network calls) -- verify dispatch via --help reachability rather
    // than full behavioral output, same pattern as video-chapters/fetch-image.
    const r = run(['pr-slice', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/files|diff|comments|description/i)
  },
  'sqlite-schema': () => {
    const dir = mkIsolated('tg-matrix-sqliteschema-')
    const dbPath = path.join(dir, 'fixture.db')
    execFileSync(process.execPath, [
      '-e',
      "const Database = require(" +
        JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3')) +
        "); const db = new Database(process.argv[1]); db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'); db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'Alice'); db.close();",
      dbPath,
    ])
    const r = run(['sqlite-schema', dbPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('users  (table, 1 row)')
    expect(r.stdout).toContain('name TEXT')
  },
  'sqlite-query': () => {
    const dir = mkIsolated('tg-matrix-sqlitequery-')
    const dbPath = path.join(dir, 'fixture.db')
    execFileSync(process.execPath, [
      '-e',
      "const Database = require(" +
        JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3')) +
        "); const db = new Database(process.argv[1]); db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'); const ins = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)'); ins.run(1, 'Alice'); ins.run(2, 'Bob'); db.close();",
      dbPath,
    ])
    const r = run(['sqlite-query', dbPath, 'SELECT id, name FROM users ORDER BY id'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).toContain('Bob')
    const rDrop = run(['sqlite-query', dbPath, 'DROP TABLE users'])
    expect(rDrop.status).toBe(1)
    expect(rDrop.stderr).toContain('only SELECT statements are allowed')
    const rStillThere = run(['sqlite-query', dbPath, 'SELECT COUNT(*) AS c FROM users'])
    expect(rStillThere.status, rStillThere.stderr).toBe(0)
    expect(rStillThere.stdout).toContain('2')
  },
  'coverage-report-gaps': () => {
    const dir = mkIsolated('tg-matrix-coveragegaps-')
    const lcovPath = path.join(dir, 'lcov.info')
    fs.writeFileSync(
      lcovPath,
      'SF:src/clean.ts\nDA:1,1\nend_of_record\nSF:src/partial.ts\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\n',
    )
    const r = run(['coverage-report-gaps', lcovPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('src/partial.ts')
    expect(r.stdout).toContain('2-3')
    expect(r.stdout).not.toContain('src/clean.ts')
    const rFiltered = run(['coverage-report-gaps', lcovPath, '--file', 'partial.ts', '--json'])
    expect(rFiltered.status, rFiltered.stderr).toBe(0)
    const parsed = JSON.parse(rFiltered.stdout) as { files: Array<{ filePath: string }> }
    expect(parsed.files.map((f) => f.filePath)).toEqual(['src/partial.ts'])
  },
  conflicts: () => {
    const dir = mkIsolated('tg-matrix-conflicts-')
    const dirtyPath = path.join(dir, 'dirty.ts')
    const cleanPath = path.join(dir, 'clean.ts')
    fs.writeFileSync(
      dirtyPath,
      'before\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature-branch\nafter\n',
    )
    fs.writeFileSync(cleanPath, 'no markers here\n')

    const r = run(['conflicts', dirtyPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('ours line')
    expect(r.stdout).toContain('theirs line')

    const rSummary = run(['conflicts', dirtyPath, '--summary'])
    expect(rSummary.status, rSummary.stderr).toBe(0)
    expect(rSummary.stdout).not.toContain('ours line')

    const rDir = run(['conflicts', dir, '--json'])
    expect(rDir.status, rDir.stderr).toBe(0)
    const parsed = JSON.parse(rDir.stdout) as Array<{ filePath: string }>
    expect(parsed.map((f) => f.filePath)).toEqual([dirtyPath])
  },
  'pdf-extract': () => {
    const dir = mkIsolated('tg-matrix-pdf-')
    const pdfPath = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF, 'latin1'))
    const r = run(['pdf-extract', pdfPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Hello PDF')
    const rLayout = run(['pdf-extract', pdfPath, '--layout'])
    expect(rLayout.status, rLayout.stderr).toBe(0)
    expect(rLayout.stdout).toContain('Hello PDF')
  },
  'pdf-outline': () => {
    const dir = mkIsolated('tg-matrix-pdfo-')
    const pdfPath = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF, 'latin1'))
    const r = run(['pdf-outline', pdfPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('no bookmarks')
  },
  'pdf-meta': () => {
    const dir = mkIsolated('tg-matrix-pdfm-')
    const pdfPath = path.join(dir, 'doc.pdf')
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF, 'latin1'))
    const r = run(['pdf-meta', pdfPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Pages: 1')
    expect(r.stdout).toContain('Text layer: yes')

    const rj = run(['pdf-meta', pdfPath, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const meta = JSON.parse(rj.stdout) as { pageCount: number; title: string | null; author: string | null; hasTextLayer: boolean }
    expect(meta.pageCount).toBe(1)
    // hasTextLayer is the field a caller acts on -- it decides whether pdf-extract is worth running.
    // In text it is a prose sentence you have to substring-match; here it must be a real boolean.
    expect(meta.hasTextLayer).toBe(true)
    // An absent title must come back as null, not the literal string "(none)" the text form prints:
    // that rendering cannot be told apart from a PDF actually titled "(none)".
    expect(meta.title).toBeNull()
    expect(meta.author).toBeNull()
  },
  'sharepoint-resolve': () => {
    const home = mkIsolated('tg-matrix-sphome-')
    const syncRoot = path.join(home, 'OneDrive - Contoso')
    fs.mkdirSync(path.join(syncRoot, 'Documents', 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(syncRoot, 'Documents', 'Reports', 'budget.xlsx'), '')
    const envFound: NodeJS.ProcessEnv = { ...tgEnv(dataBase), HOME: home, USERPROFILE: home }
    delete envFound.OneDriveCommercial
    delete envFound.OneDrive
    const rFound = run(
      ['sharepoint-resolve', 'https://contoso.sharepoint.com/sites/TeamSite/Shared%20Documents/Reports/budget.xlsx'],
      { env: envFound },
    )
    expect(rFound.status, rFound.stderr).toBe(0)
    expect(rFound.stdout).toContain(path.join(syncRoot, 'Documents', 'Reports', 'budget.xlsx'))

    const emptyHome = mkIsolated('tg-matrix-spempty-')
    const envEmpty: NodeJS.ProcessEnv = { ...tgEnv(dataBase), HOME: emptyHome, USERPROFILE: emptyHome }
    delete envEmpty.OneDriveCommercial
    delete envEmpty.OneDrive
    const rMissing = run(['sharepoint-resolve', 'https://contoso.sharepoint.com/sites/OtherTeam/Shared%20Documents/missing.docx'], {
      env: envEmpty,
    })
    expect(rMissing.status, rMissing.stderr).toBe(0)
    expect(rMissing.stdout).toContain('could not resolve a local synced copy')
  },
  'video-chapters': () => {
    // ffprobe's presence/version varies by machine and CI image — verify dispatch via
    // --help reachability rather than full behavioral output (same pattern as fetch-image).
    const r = run(['video-chapters', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/chapter|ffprobe|video/i)
  },
  'xlsx-sheets': () => {
    const dir = mkIsolated('tg-matrix-xlsx-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const ExcelJS = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'exceljs'))});
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('People');
      ws.addRow(['name','age']);
      ws.addRow(['Alice','30']);
      const ws2 = wb.addWorksheet('Q1  Draft');
      ws2.addRow(['x']);
      wb.xlsx.writeFile(${JSON.stringify(xlsxPath)}).catch((e) => { console.error(e); process.exit(1); });
    `])
    const r = run(['xlsx-sheets', xlsxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('People')

    const rj = run(['xlsx-sheets', xlsxPath, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const sheets = JSON.parse(rj.stdout) as Array<{ name: string; ref: string; rows: number; cols: number }>
    expect(sheets.map((s) => s.name)).toContain('People')
    expect(typeof sheets[0]?.rows).toBe('number')
    expect(typeof sheets[0]?.ref).toBe('string')

    // The point of the flag: a sheet name taken straight from the JSON has to be accepted by the
    // sibling command whose --sheet help text says "see xlsx-sheets". Parsing it back out of the
    // padded text line was the step this removes, so the round-trip is what actually needs pinning.
    const rHead = run(['xlsx-head', xlsxPath, '--sheet', sheets[0]!.name])
    expect(rHead.status, rHead.stderr).toBe(0)
    expect(rHead.stdout).toContain('Alice')

    // Excel allows consecutive spaces in a sheet name, and the text form separates its columns with
    // two spaces -- so `Q1  Draft  A1:A1  (1 rows x 1 cols)` cannot be split back into fields at all.
    // That makes this a correctness gap in the text handoff, not just an ergonomic one: JSON must
    // return the name byte-exact, and it has to still drive --sheet.
    const awkward = sheets.find((s) => s.name.includes('  '))
    expect(awkward?.name).toBe('Q1  Draft')
    const rAwkward = run(['xlsx-head', xlsxPath, '--sheet', awkward!.name])
    expect(rAwkward.status, rAwkward.stderr).toBe(0)
  },
  'xlsx-head': () => {
    const dir = mkIsolated('tg-matrix-xlsxh-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const ExcelJS = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'exceljs'))});
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('People');
      ws.addRow(['name','age']);
      ws.addRow(['Alice','30']);
      wb.xlsx.writeFile(${JSON.stringify(xlsxPath)}).catch((e) => { console.error(e); process.exit(1); });
    `])
    const r = run(['xlsx-head', xlsxPath, '--sheet', 'People'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
  },
  'xlsx-range': () => {
    const dir = mkIsolated('tg-matrix-xlsxr-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const ExcelJS = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'exceljs'))});
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('People');
      ws.addRow(['name','age']);
      ws.addRow(['Alice','30']);
      wb.xlsx.writeFile(${JSON.stringify(xlsxPath)}).catch((e) => { console.error(e); process.exit(1); });
    `])
    const r = run(['xlsx-range', xlsxPath, '--sheet', 'People', '--range', 'A1:B2'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
  },
  'xlsx-query': () => {
    const dir = mkIsolated('tg-matrix-xlsxq-')
    const xlsxPath = path.join(dir, 'book.xlsx')
    execFileSync(process.execPath, ['-e', `
      const ExcelJS = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'exceljs'))});
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('People');
      ws.addRow(['name','status']);
      ws.addRow(['Alice','active']);
      ws.addRow(['Bob','inactive']);
      wb.xlsx.writeFile(${JSON.stringify(xlsxPath)}).catch((e) => { console.error(e); process.exit(1); });
    `])
    const r = run(['xlsx-query', xlsxPath, '--sheet', 'People', '--where', 'status=active'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
    expect(r.stdout).not.toContain('Bob')
  },
  'pptx-outline': () => {
    const dir = mkIsolated('tg-matrix-pptxo-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', body: ['Welcome'] }]))
    const r = run(['pptx-outline', pptxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Intro')
  },
  'pptx-slide': () => {
    const dir = mkIsolated('tg-matrix-pptxs-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', body: ['Welcome'] }]))
    const r = run(['pptx-slide', pptxPath, '--slide', '1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Welcome')
  },
  'pptx-notes': () => {
    const dir = mkIsolated('tg-matrix-pptxn-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', notes: 'Say hello warmly' }]))
    const r = run(['pptx-notes', pptxPath, '--slide', '1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Say hello warmly')
  },
  'pptx-text': () => {
    const dir = mkIsolated('tg-matrix-pptxt-')
    const pptxPath = path.join(dir, 'deck.pptx')
    fs.writeFileSync(pptxPath, buildPptxFixture([{ title: 'Intro', body: ['Welcome to the annual meeting'] }]))
    const r = run(['pptx-text', pptxPath, '--grep', 'annual'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Slide 1')
  },
  'docx-outline': () => {
    const dir = mkIsolated('tg-matrix-docxo-')
    const docxPath = path.join(dir, 'doc.docx')
    fs.writeFileSync(docxPath, buildDocxFixture([{ text: 'Overview', headingLevel: 1 }, { text: 'Some body text.' }]))
    const r = run(['docx-outline', docxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Overview')
  },
  'docx-text': () => {
    const dir = mkIsolated('tg-matrix-docxt-')
    const docxPath = path.join(dir, 'doc.docx')
    fs.writeFileSync(docxPath, buildDocxFixture([{ text: 'Overview', headingLevel: 1 }, { text: 'Some body text.' }]))
    const r = run(['docx-text', docxPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Some body text.')
  },
  'transcript-outline': () => {
    const dir = mkIsolated('tg-matrix-transo-')
    const vttPath = path.join(dir, 'meeting.vtt')
    fs.writeFileSync(vttPath, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n<v Alice>Welcome to the meeting.\n')
    const r = run(['transcript-outline', vttPath])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Alice')
  },
  transcript: () => {
    const dir = mkIsolated('tg-matrix-trans-')
    const vttPath = path.join(dir, 'meeting.vtt')
    fs.writeFileSync(vttPath, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n<v Alice>Welcome to the meeting.\n')
    const r = run(['transcript', vttPath, '--speaker', 'Alice'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Welcome to the meeting.')
  },
  screenshot: () => {
    // Real behavior needs a real browser (present on dev machines, not guaranteed in CI) and
    // network access -- same constraint 'fetch-image' below hits, same fix: verify dispatch
    // via --help instead of a real invocation.
    const r = run(['screenshot', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/url|chrome|chromium/i)
  },
  map: () => {
    const r = run(['map'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout).toMatch(/mod|src/)

    // `--compact` must route through the same real indexed data as the plain
    // form (buildProjectMap), not the legacy repomap.ts path -- so it should
    // surface a real fixture symbol (alphaSym, defined in src/mod.ts) rather
    // than an alphabetical file listing with no symbol data.
    const compact = run(['map', '--compact'])
    expect(compact.status, compact.stderr).toBe(0)
    expect(compact.stdout).toContain('alphaSym')
    expect(compact.stdout.length).toBeLessThan(r.stdout.length)

    const json = run(['map', '--json'])
    expect(json.status, json.stderr).toBe(0)
    const parsed = JSON.parse(json.stdout) as { fileCount: number; topSymbols: Array<{ name: string }> }
    expect(parsed.fileCount).toBeGreaterThan(0)
    expect(parsed.topSymbols.some((s) => s.name === 'alphaSym')).toBe(true)
  },
  'bridges-status': () => {
    const r = run(['bridges-status'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('parity matrix')
    expect(r.stdout).toContain('claudecode')
    expect(r.stdout).toContain('pre_tool_use')

    const json = run(['bridges-status', '--json'])
    expect(json.status, json.stderr).toBe(0)
    const rows = JSON.parse(json.stdout) as Array<{ harness: string; events: Record<string, boolean> }>
    expect(rows.length).toBeGreaterThan(0)
    const claudecode = rows.find((row) => row.harness === 'claudecode')
    expect(claudecode?.events.pre_tool_use).toBe(true)
  },
  'bash-output': () => {
    // --file reads a regular file, giving a deterministic real-output check.
    const r = run(['bash-output', '--file', 'pkg.json'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('3.2.1')
  },
  'web-output': () => {
    // Reachability: process-local cache is always empty in a fresh process, so a bogus id is a graceful miss (exit 1), not an "unknown command" / crash.
    const r = run(['web-output', 'no-such-id'])
    expect(r.status).not.toBe(0)
    const all = r.stdout + r.stderr
    expect(all.length).toBeGreaterThan(0)
    expect(all).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
  'mcp-output': () => {
    // A well-formed but uncached mcp_ id is a graceful cache-miss (exit 1).
    const r = run(['mcp-output', 'mcp_0000000000000000'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('no cached mcp output for id')
    // A non-mcp_ id is rejected up front, distinctly from a cache miss.
    const rBad = run(['mcp-output', 'not-an-mcp-id'])
    expect(rBad.status).not.toBe(0)
    expect(rBad.stdout + rBad.stderr).toContain('not an mcp-output id')
  },
  compress: () => {
    // Real output: the generic filter collapses the 60 identical lines to one.
    // 60 (not 6) repeats so the dedupe savings clear the net-benefit floor
    // (bash_compress.min_net_savings_bytes) -- a handful of repeats only saves
    // marker-sized bytes and legitimately falls back to the untouched original.
    const r = run([
      'compress',
      '--filter',
      'generic',
      '--cmd',
      `"${process.execPath}" -e "for (let i = 0; i < 60; i++) console.log('compiling...')"`,
    ])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('×60')
  },
  'compress-text': () => {
    const r = run(['compress-text', 'matrix text '.repeat(20)])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/id: tg_[0-9a-f]{16}/)
    expect(r.stdout).toContain('recovery: token-goat retrieve')
  },
  retrieve: () => {
    const compressed = run(['compress-text', 'matrix retrieval text'])
    expect(compressed.status, compressed.stderr).toBe(0)
    const id = compressed.stdout.match(/id: (tg_[0-9a-f]{16})/)?.[1]
    expect(id).toBeDefined()
    const r = run(['retrieve', id as string])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('matrix retrieval text')
  },
  'handoff-create': () => {
    const r = run(['handoff-create', 'matrix-handoff', 'handoff text'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('"name": "matrix-handoff"')
  },
  'handoff-resolve': () => {
    const created = run(['handoff-create', 'matrix-resolve', 'resolve text'])
    expect(created.status, created.stderr).toBe(0)
    const r = run(['handoff-resolve', 'matrix-resolve', '--full'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('resolve text')
  },
  stats: () => {
    const r = run(['stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    // Bare `stats` is totals-only now; it must never show the full breakdown.
    expect(r.stdout).not.toContain('## By Source')
    expect(r.stdout).not.toContain('## By Command')
    expect(r.stdout).not.toContain('## Last 7 Days')

    const rFull = run(['stats', '--full'])
    expect(rFull.status, rFull.stderr).toBe(0)
    // Length-only (`>0`) wouldn't distinguish --full from the bare totals-only output checked
    // above -- it would still pass even if --full silently stopped adding the by-source/
    // by-command/by-day breakdown and just re-printed the same totals. Assert the real,
    // documented difference structurally (strictly more content than the bare form) rather than
    // pinning exact section-header text, since the actual rendered text depends on the TTY/color
    // path this process takes and isn't guaranteed to be the plain "## By Source" markdown form.
    expect(rFull.stdout.length).toBeGreaterThan(r.stdout.length)
  },
  doctor: () => {
    const r = run(['doctor'])
    // doctor is informational; it may exit non-zero when something is unhealthy, but it must run and print diagnostics, not be unreachable.
    expect(r.status).not.toBeNull()
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)

    const json = run(['doctor', '--json'])
    expect(json.status).not.toBeNull()
    const results = JSON.parse(json.stdout) as Array<{ name: string; status: string; message: string }>
    expect(results.length).toBeGreaterThan(0)
    for (const check of results) {
      expect(['ok', 'warn', 'fail']).toContain(check.status)
    }
  },
  'context-stats': () => {
    const r = run(['context-stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('context')
    const rj = run(['context-stats', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const output = JSON.parse(rj.stdout) as { total_tokens: number }
    expect(typeof output.total_tokens).toBe('number')
  },
  'bootstrap-audit': () => {
    const proj = mkIsolated('tg-matrix-bootstrap-project-')
    const home = mkIsolated('tg-matrix-bootstrap-home-')
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'project startup guidance\n')
    fs.writeFileSync(
      path.join(home, '.claude', 'CLAUDE.md'),
      'global startup guidance\n',
    )
    fs.writeFileSync(
      path.join(home, '.claude', 'agents', 'agent.md'),
      '---\ndescription: matrix metadata\ntools: Read\n---\nPRIVATE PROMPT BODY\n',
    )
    const r = run(['bootstrap-audit', '--project', proj, '--home', home, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const output = JSON.parse(r.stdout) as { counts: { metadata_files: number }; total_estimated_tokens: number }
    expect(output.counts.metadata_files).toBe(1)
    expect(output.total_estimated_tokens).toBeGreaterThan(0)
    const failed = run(['bootstrap-audit', '--project', proj, '--home', home, '--json', '--fail-tokens', '0'])
    expect(failed.status, failed.stderr).toBe(3)
    const failedOutput = JSON.parse(failed.stdout) as { budgets: { failures: string[] } }
    expect(failedOutput.budgets.failures.length).toBeGreaterThan(0)
  },
  memory: () => {
    const proj = mkIsolated('tg-matrix-mem-')
    const claudeMd = path.join(proj, 'CLAUDE.md')
    fs.writeFileSync(claudeMd, '# Rules\n\nAlways run tests.\n\nAlways run tests.\n', 'utf8')

    // --analyze (default): read-only report, no writes.
    const r = run(['memory', '--project', proj])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('CLAUDE.md files')
    expect(r.stdout).toContain('exact-duplicate lines: 1')
    expect(fs.readFileSync(claudeMd, 'utf8')).toContain('Always run tests.\n\nAlways run tests.')

    // --fix without --yes and without a TTY: dry run, file untouched.
    const rDry = run(['memory', '--project', proj, '--fix'])
    expect(rDry.status, rDry.stderr).toBe(0)
    expect(rDry.stdout).toMatch(/Dry run: no files were written/)
    expect(fs.readFileSync(claudeMd, 'utf8')).toContain('Always run tests.\n\nAlways run tests.')

    // --fix --yes: applies the mechanical exact-duplicate-line removal.
    const rFix = run(['memory', '--project', proj, '--fix', '--yes'])
    expect(rFix.status, rFix.stderr).toBe(0)
    expect(rFix.stdout).toMatch(/applied 1 file\(s\)/)
    const after = fs.readFileSync(claudeMd, 'utf8')
    expect((after.match(/Always run tests\./g) ?? []).length).toBe(1)
  },

  waste: () => {
    const proj = mkIsolated('tg-matrix-waste-')
    const transcript = path.join(proj, 'fake-session.jsonl')
    const lines = [
      { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/tmp/never-touched.ts' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: [{ type: 'text', text: 'x'.repeat(300) }] }] } },
      { cwd: proj, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'git status' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: [{ type: 'text', text: 'y'.repeat(300) }] }] } },
      { cwd: proj, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash2', name: 'Bash', input: { command: 'git status' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash2', content: [{ type: 'text', text: 'z'.repeat(300) }] }] } },
    ]
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')

    const r = run(['waste', '--project', proj, '--transcript', transcript])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('token-goat waste')
    expect(r.stdout).toContain('Tokens by tool')
    expect(r.stdout).toContain('never-touched.ts')
    expect(r.stdout).toContain('never referenced again')
    expect(r.stdout).toMatch(/git status.*ran 2 times/)

    const rj = run(['waste', '--project', proj, '--transcript', transcript, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as {
      totalTokens: number
      tokensByTool: Array<{ key: string; tokens: number }>
      neverTouchedAgain: Array<{ filePath: string; tokens: number }>
      repeatedUncompressedBash: Array<{ normalized: string; count: number }>
    }
    expect(parsed.totalTokens).toBeGreaterThan(0)
    expect(parsed.tokensByTool.some((t) => t.key === 'Read')).toBe(true)
    expect(parsed.neverTouchedAgain.some((f) => f.filePath === '/tmp/never-touched.ts')).toBe(true)
    expect(parsed.repeatedUncompressedBash.some((c) => c.normalized === 'git status' && c.count === 2)).toBe(true)
  },

  'session-outline': () => {
    const proj = mkIsolated('tg-matrix-session-outline-')
    const transcript = path.join(proj, 'fake-session.jsonl')
    const lines = [
      { type: 'custom-title', customTitle: 'not a turn' },
      { type: 'user', message: { role: 'user', content: 'read config.ts please' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/config.ts' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export const X = 1'.repeat(20) }] }] },
      },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'config.ts exports X.' }] } },
    ]
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')

    const r = run(['session-outline', transcript])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Transcript:')
    expect(r.stdout).toMatch(/^1\. \[user\]/m)
    expect(r.stdout).toContain('[tools: Read]')
    expect(r.stdout).not.toContain('export const X = 1'.repeat(20))

    const rj = run(['session-outline', transcript, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { transcriptPath: string; turns: Array<{ turn: number; role: string; toolCalls: string[] }> }
    expect(parsed.turns).toHaveLength(4)
    expect(parsed.turns[1]?.toolCalls).toEqual(['Read'])

    // Unknown id/path resolves to nothing and exits non-zero.
    const rMissing = run(['session-outline', 'no-such-session-id', '--project', proj])
    expect(rMissing.status).not.toBe(0)
  },

  'session-slice': () => {
    const proj = mkIsolated('tg-matrix-session-slice-')
    const transcript = path.join(proj, 'fake-session.jsonl')
    const lines = [
      { type: 'user', message: { role: 'user', content: 'read config.ts please' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/config.ts' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export const X = 1' }] }] },
      },
    ]
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')

    const r = run(['session-slice', transcript, '--range', '2-3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Turn 2 [assistant]')
    expect(r.stdout).toContain('tool_use: Read')
    expect(r.stdout).toContain('export const X = 1')
    expect(r.stdout).not.toContain('read config.ts please')

    const rj = run(['session-slice', transcript, '--range', '1', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { turns: Array<{ turn: number; role: string }> }
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.turns[0]?.role).toBe('user')

    // --range is required.
    const rNoRange = run(['session-slice', transcript])
    expect(rNoRange.status).not.toBe(0)
  },

  'mcp-audit': () => {
    const proj = mkIsolated('tg-matrix-mcp-audit-')

    // Test without .mcp.json
    let r = run(['mcp-audit', '--project', proj])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('token-goat mcp-audit')
    expect(r.stdout).toContain('Config found: no')

    // Create .mcp.json
    const configPath = path.join(proj, '.mcp.json')
    const config = {
      mcpServers: {
        'example-server': {
          command: 'node',
          args: ['server.js'],
        },
      },
    }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8')

    // Test with .mcp.json
    r = run(['mcp-audit', '--project', proj])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('token-goat mcp-audit')
    expect(r.stdout).toContain('Config found: yes')

    // Test JSON output
    const rj = run(['mcp-audit', '--project', proj, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as {
      configFound: boolean
      servers: Array<{ name: string; perCallTokens: number; callCount: number; totalTokens: number }>
    }
    expect(parsed.configFound).toBe(true)
    // toBeDefined() alone would still pass on an empty array, missing the actual fixture server
    // the .mcp.json above declares -- pin that it's really surfaced by name.
    expect(parsed.servers.map((s) => s.name)).toContain('example-server')
  },

  recall: () => {
    // The recall index (cache_recall / cache_recall_fts) lives in dataBase's shared global.db,
    // not the per-case-isolated TOKEN_GOAT_HOME blob store, so a random query with no other
    // matrix case populating a matching entry is a reliable, pollution-proof "no hits" check
    // regardless of what else this suite has indexed.
    const nonce = `zzz-nonexistent-query-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = run(['recall', nonce])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`No cache entries match: ${nonce}`)

    const rj = run(['recall', nonce, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    expect(JSON.parse(rj.stdout)).toEqual([])

    // --type/--limit are accepted and don't crash the empty-index path.
    const rFiltered = run(['recall', nonce, '--type', 'bash', '--limit', '3'])
    expect(rFiltered.status, rFiltered.stderr).toBe(0)

    // An invalid --type is rejected up front rather than silently ignored.
    const rBadType = run(['recall', nonce, '--type', 'nope'])
    expect(rBadType.status).not.toBe(0)
    expect(rBadType.stdout + rBadType.stderr).toContain('--type must be one of')

    // The browse form: no query at all must list rather than error out on a missing argument.
    // This is the CLI-layer wiring ([query] vs <query>) that no unit test can pin.
    const rBrowse = run(['recall', '--limit', '3'])
    expect(rBrowse.status, rBrowse.stderr).toBe(0)
    expect(rBrowse.stdout + rBrowse.stderr).not.toMatch(/missing required argument|unknown command/)

    const rBrowseJson = run(['recall', '--limit', '3', '--json'])
    expect(rBrowseJson.status, rBrowseJson.stderr).toBe(0)
    expect(Array.isArray(JSON.parse(rBrowseJson.stdout))).toBe(true)
  },

  'hint-stats': () => {
    // hint_emissions/hint_manual_marks live in dataBase's shared global.db (same DB recall
    // uses) -- reset first so this case's assertions are independent of whatever other cases
    // in this suite ran before it.
    const r0 = run(['hint-stats', '--reset'])
    expect(r0.status, r0.stderr).toBe(0)
    expect(r0.stdout).toContain('cleared')

    const rj = run(['hint-stats', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const rows = JSON.parse(rj.stdout) as Array<{
      category: string
      emitted: number
      actedOn: number
      efficacyPct: number | null
      suppressed: boolean
      manualEffective: number
      manualIneffective: number
    }>
    expect(rows.length).toBe(5)
    expect(rows.every((row) => row.emitted === 0 && row.suppressed === false)).toBe(true)
    expect(rows.map((row) => row.category).sort()).toEqual([
      'bash_recall',
      'bash_redirect',
      'edit_reread_suggest',
      'read_reread_dedup',
      'read_structural_nav',
    ])

    const r = run(['hint-stats'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('category')
    expect(r.stdout).toContain('bash_redirect')

    const rMark = run(['hint-stats', '--mark-effective', 'bash_redirect'])
    expect(rMark.status, rMark.stderr).toBe(0)
    expect(rMark.stdout).toContain('effective')

    const rjAfterMark = run(['hint-stats', '--json'])
    const rowsAfterMark = JSON.parse(rjAfterMark.stdout) as Array<{ category: string; manualEffective: number }>
    expect(rowsAfterMark.find((row) => row.category === 'bash_redirect')?.manualEffective).toBe(1)

    const rBadCategory = run(['hint-stats', '--mark-ineffective', 'nope'])
    expect(rBadCategory.status).not.toBe(0)
    expect(rBadCategory.stdout + rBadCategory.stderr).toContain('--mark-ineffective must be one of')
  },

  version: () => {
    const r = run(['version'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/)
  },
  commands: () => {
    const r = run(['commands'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('token-goat commands')
    expect(r.stdout).toContain('symbol')
    expect(r.stdout).toContain('install')

    const rJson = run(['commands', '--json'])
    expect(rJson.status, rJson.stderr).toBe(0)
    const manifest = JSON.parse(rJson.stdout) as Array<{ name: string; description: string; options: unknown[]; subcommands: Array<{ name: string }> }>
    expect(manifest.length).toBeGreaterThan(10)
    const symbolEntry = manifest.find((e) => e.name === 'symbol')
    // Length-only would still pass on any placeholder/garbled description text -- pin the real
    // one so a regression that swapped/blanked/duplicated a command's description is caught.
    expect(symbolEntry?.description).toBe('search for a symbol by name, or project-wide by --grep name pattern')
    const workerEntry = manifest.find((e) => e.name === 'worker')
    expect(workerEntry?.subcommands.map((s) => s.name)).toContain('start')

    // --grep narrows by name/description/alias; parent match keeps all subcommands, no-match is exit 0.
    const rGrep = run(['commands', '--grep', '^symbol$'])
    expect(rGrep.status, rGrep.stderr).toBe(0)
    expect(rGrep.stdout).toContain('symbol')
    expect(rGrep.stdout).not.toContain('## install')

    const rGrepJson = run(['commands', '--grep', '^symbol$', '--json'])
    const grepManifest = JSON.parse(rGrepJson.stdout) as Array<{ name: string }>
    expect(grepManifest.map((e) => e.name)).toEqual(['symbol'])

    // Subcommand narrowing: a non-matching parent keeps only its matching children. Assert on the `worker` entry rather than the whole result set -- any command whose name or description contains "start" is a legitimate extra match, as `bootstrap-audit` ("startup-context") already is.
    const rGrepWorker = run(['commands', '--grep', 'start', '--json'])
    const grepWorkerManifest = JSON.parse(rGrepWorker.stdout) as Array<{ name: string; subcommands: Array<{ name: string }> }>
    const grepWorkerEntry = grepWorkerManifest.find((e) => e.name === 'worker')
    expect(grepWorkerEntry, rGrepWorker.stdout).toBeDefined()
    expect(grepWorkerEntry?.subcommands.map((s) => s.name)).toEqual(['start'])

    const rNoMatch = run(['commands', '--grep', 'zzz-no-such-command'])
    expect(rNoMatch.status, rNoMatch.stderr).toBe(0)
    expect(rNoMatch.stdout.trim()).toBe('no matches')
  },
  hook: () => {
    // relay never throws on an unknown event; it emits {} and returns 0.
    const r = run(['hook', 'PreToolUse'], { input: '{}' })
    expect(r.status, r.stderr).toBe(0)
  },
  statusline: () => {
    // Must never throw or hang: valid payload, empty stdin, and malformed stdin all exit 0
    // with a single non-empty stdout line, through the real built bundle and its own
    // (shorter than the hook relay's) stdin timeout.
    const payload = JSON.stringify({
      model: { display_name: 'Opus' },
      workspace: { current_dir: repo },
      context_window: { used_percentage: 12 },
    })
    const r = run(['statusline'], { input: payload })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.split('\n').filter((l) => l.length > 0).length).toBe(1)
    expect(r.stdout).toContain('Opus')

    const rEmpty = run(['statusline'], { input: '' })
    expect(rEmpty.status, rEmpty.stderr).toBe(0)
    // Length-only wouldn't catch a fallback that degraded into multi-line or garbled output --
    // pin the same single-line shape the payload case above checks, plus the documented
    // `<project> | idx <status>` structure the empty-stdin fallback falls back to.
    expect(rEmpty.stdout.split('\n').filter((l) => l.length > 0).length).toBe(1)
    expect(rEmpty.stdout).toMatch(/^\S+ \| idx \S+/)

    const rJson = run(['statusline', '--json'], { input: payload })
    expect(rJson.status, rJson.stderr).toBe(0)
    const data = JSON.parse(rJson.stdout) as { project: string; model: string | null }
    expect(data.model).toBe('Opus')
  },
  'write-file': () => {
    const dest = path.join(mkIsolated('tg-matrix-wf-'), 'out.txt')
    const payload = Buffer.from('hello-matrix', 'utf8').toString('base64')
    const r = run(['write-file', dest, '--b64', payload])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello-matrix')
  },
  'replace': () => {
    const dest = path.join(mkIsolated('tg-matrix-rpl-'), 'out.txt')
    fs.writeFileSync(dest, 'cat cat dog', 'utf8')
    const oldB64 = Buffer.from('cat', 'utf8').toString('base64')
    const newB64 = Buffer.from('fox', 'utf8').toString('base64')
    const r = run(['replace', dest, '--old-b64', oldB64, '--new-b64', newB64, '--all'])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe('fox fox dog')
    expect(r.stdout).toContain('replaced 2 occurrences')
  },
  'insert-section': () => {
    const dest = path.join(mkIsolated('tg-matrix-ins-'), 'out.md')
    fs.writeFileSync(dest, '# Title\n\n## Section One\nfirst body\n\n## Section Two\nsecond body\n', 'utf8')
    const contentB64 = Buffer.from('## Section 1.5\ninserted body\n', 'utf8').toString('base64')
    const r = run(['insert-section', dest, '--after', 'Section One', '--content-b64', contentB64])
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(dest, 'utf8')).toBe(
      '# Title\n\n## Section One\nfirst body\n## Section 1.5\ninserted body\n\n## Section Two\nsecond body\n',
    )
    expect(r.stdout).toContain("inserted after 'Section One'")
  },
  'note-add': () => {
    const dest = path.join(mkIsolated('tg-matrix-noteadd-'), 'out.ts')
    fs.writeFileSync(dest, 'export function matrixNoteFn(): number {\n  return 1\n}\n', 'utf8')
    const b64 = Buffer.from('Rationale for matrixNoteFn.', 'utf8').toString('base64')
    const r = run(['note-add', dest, '--symbol', 'matrixNoteFn', '--content-b64', b64])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Note saved')
    expect(r.stdout).toContain('matrixNoteFn')
  },
  'note-get': () => {
    const dest = path.join(mkIsolated('tg-matrix-noteget-'), 'out.md')
    fs.writeFileSync(dest, '# doc\n', 'utf8')
    const b64 = Buffer.from('Whole-file note body.', 'utf8').toString('base64')
    const added = run(['note-add', dest, '--content-b64', b64])
    expect(added.status, added.stderr).toBe(0)
    const r = run(['note-get', dest])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Whole-file note body.')
  },
  'note-list': () => {
    const dest = path.join(mkIsolated('tg-matrix-notelist-'), 'out.md')
    fs.writeFileSync(dest, '# doc\n', 'utf8')
    const b64 = Buffer.from('note-list matrix body.', 'utf8').toString('base64')
    const added = run(['note-add', dest, '--content-b64', b64])
    expect(added.status, added.stderr).toBe(0)
    const r = run(['note-list'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/out\.md/)
  },
  install: () => {
    const proj = mkIsolated('tg-matrix-proj-')
    const r = run(['install', '--project', '--vscode'], { cwd: proj })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Installed token-goat hooks \(project\)/)
    const settingsFile = path.join(proj, '.claude', 'settings.json')
    expect(fs.existsSync(settingsFile)).toBe(true)
    expect(fs.existsSync(path.join(proj, '.vscode', 'mcp.json'))).toBe(true)

    // The generated hook shim must actually be written and wired -- through the BUILT bundle, not source. It sat fully built and fully unit-tested but never written by any install path for months (the injected-seam trap CLAUDE.md calls out), which no source-level test caught.
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }>>
    }
    const preCommand = settings.hooks['PreToolUse']?.[0]?.hooks?.[0]?.command ?? ''
    expect(preCommand).toMatch(/token-goat-shim\.js/)
    const shimPath = preCommand.match(/"([^"]*token-goat-shim\.js)"/)?.[1]
    expect(shimPath, `no quoted shim path in wired command: ${preCommand}`).toBeDefined()
    expect(fs.existsSync(shimPath!)).toBe(true)
  },
  uninstall: () => {
    // Install first so uninstall has something to remove and emits the "Removed ..." path rather than the no-op message.
    const proj = mkIsolated('tg-matrix-uninstall-')
    const installed = run(['install', '--project', '--vscode'], { cwd: proj })
    expect(installed.status, installed.stderr).toBe(0)
    const r = run(['uninstall', '--project', '--vscode'], { cwd: proj })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Removed token-goat hooks \(project\)\./)
  },
  worker: () => {
    // Parent command with subcommands and no own action: prints usage listing its subcommands. Reachable and lists start/stop/status.
    const r = run(['worker', '--help'])
    expect(r.stdout + r.stderr).toMatch(/start[\s\S]*stop[\s\S]*status/)
  },
  'worker status': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstatus-'))
    const r = run(['worker', 'status'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker is (running|not running)\./)
  },
  'worker stop': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstop-'))
    const r = run(['worker', 'stop'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker stopped\.|No running worker\./)
  },
  'worker start': () => {
    const env = tgEnv(mkIsolated('tg-matrix-wstart-'))
    const r = run(['worker', 'start'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Worker started \(pid \d+\)\.|Worker already running\./)
    // Stop the detached worker so it does not outlive the test.
    run(['worker', 'stop'], { env })
  },
  'skill-list': () => {
    const r = run(['skill-list'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-size': () => {
    const r = run(['skill-size'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-body': () => {
    const r = run(['skill-body', 'no-such-skill'])
    expect(r.status).not.toBe(0)
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-compact': () => {
    const r = run(['skill-compact', 'no-such-skill'])
    expect(r.status).not.toBe(0)
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-history': () => {
    const r = run(['skill-history'])
    expect(r.status, r.stderr).toBe(0)
  },
  'skill-diff': () => {
    const r = run(['skill-diff', 'no-such-skill'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'skill-section': () => {
    const r = run(['skill-section', 'no-such-skill::Heading'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'gdrive-sections': () => {
    // Reachability only: needs network + a live public doc. A bogus id must fail gracefully (non-zero) without an "unknown command" or tree-shaken module crash — that is what proves the command is wired into the shipped bundle.
    const r = run(['gdrive-sections', 'not-a-real-doc-id'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function|Cannot find package/)
  },
  'mcp-serve': async () => {
    // mcp-serve is a long-running stdio server, not a one-shot command, so it can't go through
    // the shared spawnSync-based run() helper (spawnSync writes stdin, closes it, and waits for
    // exit -- but this process never exits on its own). Spawn it directly, write one real
    // tools/list JSON-RPC request, read stdout until a response with a matching id arrives (or a
    // bounded timeout elapses), then always kill the child so a broken response can't hang the
    // suite.
    const child = spawn(process.execPath, [BUNDLE, 'mcp-serve'], { cwd: repo, env: tgEnv(dataBase) })
    try {
      const toolNames = await new Promise<string[]>((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(() => reject(new Error('mcp-serve: timed out waiting for tools/list response')), 15000)
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          let idx: number
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            if (line.trim() === '') continue
            const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } }
            if (msg.id === 1 && msg.result?.tools !== undefined) {
              clearTimeout(timer)
              resolve(msg.result.tools.map((t) => t.name))
              return
            }
          }
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'matrix-e2e', version: '0.0.1' } },
          })}\n`,
        )
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      })
      expect(toolNames.sort()).toEqual([
        'changed',
        'compress_text',
        'exports',
        'grep',
        'handoff_create',
        'handoff_resolve',
        'imports',
        'map',
        'outline',
        'read',
        'refs',
        'retrieve_text',
        'section',
        'semantic',
        'skeleton',
        'symbol',
      ])
    } finally {
      child.kill()
    }
  },
  callers: () => {
    // The fixture has refDriver calling refHelper twice; callers should find refDriver as the enclosing symbol.
    const r = run(['callers', 'refHelper'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver|caller\.ts/)
    // The `caller.ts::` prefix only disambiguates WHICH refHelper is meant -- refDriver still surfaces, exercising the real bundle-level parse + disambiguation path end to end.
    const rSpec = run(['callers', 'caller.ts::refHelper'])
    expect(rSpec.status, rSpec.stderr).toBe(0)
    expect(rSpec.stdout).toMatch(/refDriver|caller\.ts/)
    // -C renders real call-site source; omitting it does not.
    expect(r.stdout).not.toContain('return refHelper() + refHelper()')
    const ctx = run(['callers', 'refHelper', '-C', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    expect(ctx.stdout).toContain('return refHelper() + refHelper()')

    // --exclude-tests: opt-in, additive. exclHelperFn has one production caller
    // (exclProdCaller) and two test-file callers (exclcaller.test.ts); absent the flag both
    // test callers surface (unchanged from today), with it only the production one remains.
    const withoutFlag = run(['callers', 'exclhelper.ts::exclHelperFn'])
    expect(withoutFlag.status, withoutFlag.stderr).toBe(0)
    expect(withoutFlag.stdout).toContain('exclProdCaller')
    expect(withoutFlag.stdout).toContain('exclTestCallerA')
    expect(withoutFlag.stdout).toContain('exclTestCallerB')
    const withFlag = run(['callers', 'exclhelper.ts::exclHelperFn', '--exclude-tests'])
    expect(withFlag.status, withFlag.stderr).toBe(0)
    expect(withFlag.stdout).toContain('exclProdCaller')
    expect(withFlag.stdout).not.toContain('exclTestCallerA')
    expect(withFlag.stdout).not.toContain('exclTestCallerB')
    expect(withFlag.stdout).toContain('hidden by --exclude-tests')

    // --grep: filters on the CALLER SYMBOL NAME. A matching pattern keeps only that caller; a
    // non-matching pattern must not read as "no references found" (callers DO exist, --grep
    // just filtered every hit).
    const grepMatch = run(['callers', 'exclhelper.ts::exclHelperFn', '--grep', 'exclProdCaller'])
    expect(grepMatch.status, grepMatch.stderr).toBe(0)
    expect(grepMatch.stdout).toContain('exclProdCaller')
    expect(grepMatch.stdout).not.toContain('exclTestCallerA')
    const grepEmpty = run(['callers', 'exclhelper.ts::exclHelperFn', '--grep', 'nomatch-zz-12345'])
    expect(grepEmpty.status, grepEmpty.stderr).toBe(0)
    expect(grepEmpty.stdout).toMatch(/filtered out by --grep/)
    expect(grepEmpty.stdout).not.toMatch(/no references found/)
    // An invalid regex must fall back to a literal substring match, never error.
    const grepBadRegex = run(['callers', 'exclhelper.ts::exclHelperFn', '--grep', '[unclosed'])
    expect(grepBadRegex.status, grepBadRegex.stderr).toBe(0)
    expect(grepBadRegex.stdout + grepBadRegex.stderr).not.toMatch(/unknown command|is not a function/)

    // `--json`'s file now renders root-relative against the real built binary, matching the
    // plain-text rows above and the outline/skeleton/refs --json convention.
    const j = run(['callers', 'refHelper', '--json'])
    expect(j.status, j.stderr).toBe(0)
    const jParsed = envelopeItems<{ file: string }>(j.stdout)
    expect(jParsed.length).toBeGreaterThan(0)
    for (const entry of jParsed) expect(path.isAbsolute(entry.file)).toBe(false)
  },
  'call-chain': () => {
    // refHelper is called by refDriver which has no further callers in the tiny fixture. Same
    // fixture fact the sibling 'impact' case below pins by content -- length-only here wouldn't
    // catch a regression that printed an unrelated (but still non-empty) chain.
    const r = run(['call-chain', 'refHelper', '--depth', '4'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver/)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rSpec = run(['call-chain', 'caller.ts::refHelper', '--depth', '4'])
    expect(rSpec.status, rSpec.stderr).toBe(0)
    expect(rSpec.stdout).toMatch(/refDriver/)
  },
  impact: () => {
    // refHelper is called by refDriver; impact must list refDriver with hops: 1.
    const r = run(['impact', 'refHelper', '--top', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refDriver/)
    const rSpec = run(['impact', 'caller.ts::refHelper', '--top', '5'])
    expect(rSpec.status, rSpec.stderr).toBe(0)
    expect(rSpec.stdout).toMatch(/refDriver/)
  },
  dead: () => {
    // The dead command must run and produce valid output (or 'No dead symbols found.') without crashing.
    const r = run(['dead', '--top', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)

    // --exclude-tests: opt-in, additive, and filters on the symbol's own DEFINITION site (not a
    // reference site, unlike refs/callers). exclDeadOnlyInTest is defined in excldead.test.ts and
    // never called anywhere -- present without the flag (byte-identical to today), gone with it.
    const withoutFlag = run(['dead', '--top', '500', '--json'])
    expect(withoutFlag.status, withoutFlag.stderr).toBe(0)
    const withoutParsed = envelopeItems<{ name: string; file: string }>(withoutFlag.stdout)
    expect(withoutParsed.some((s) => s.name === 'exclDeadOnlyInTest')).toBe(true)
    // `--json`'s file now renders root-relative against the real built binary, matching the
    // outline/skeleton/refs --json convention.
    for (const entry of withoutParsed) expect(path.isAbsolute(entry.file)).toBe(false)
    const withFlag = run(['dead', '--top', '500', '--json', '--exclude-tests'])
    expect(withFlag.status, withFlag.stderr).toBe(0)
    const withParsed = envelopeItems<{ name: string }>(withFlag.stdout)
    expect(withParsed.some((s) => s.name === 'exclDeadOnlyInTest')).toBe(false)

    // --grep narrows by NAME, and an all-filtered result names the filter instead of looking
    // like a genuinely clean codebase.
    const grepped = run(['dead', '--top', '500', '--json', '--grep', 'exclDeadOnlyInTest'])
    expect(grepped.status, grepped.stderr).toBe(0)
    const greppedParsed = envelopeItems<{ name: string }>(grepped.stdout)
    expect(greppedParsed.map((s) => s.name)).toEqual(['exclDeadOnlyInTest'])

    const grepMiss = run(['dead', '--top', '500', '--grep', 'zzzzNoSuchDeadSymbol'])
    expect(grepMiss.status, grepMiss.stderr).toBe(0)
    expect(grepMiss.stdout).toContain('--grep zzzzNoSuchDeadSymbol')
    expect(grepMiss.stdout).not.toContain('No dead symbols found.')

    // Invalid regex falls back to a literal substring match instead of erroring.
    const grepInvalid = run(['dead', '--top', '500', '--grep', '[unclosed'])
    expect(grepInvalid.status, grepInvalid.stderr).toBe(0)
  },
  deps: () => {
    // app.ts imports from ./src/mod.js — deps must list that as an internal dep, rendered as a
    // root-relative path (not an absolute Windows path) so it can be fed straight back into
    // `outline`/`read`/`skeleton`.
    const r = run(['deps', 'app.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod|internal/)
    expect(r.stdout).toContain('  src/mod.ts')
    expect(r.stdout).not.toContain('\\')

    const rJson = run(['deps', 'app.ts', '--json'])
    expect(rJson.status, rJson.stderr).toBe(0)
    const parsed = JSON.parse(rJson.stdout) as { file: string; internal: string[]; external: string[] }
    expect(parsed.internal).toContain('src/mod.ts')
    for (const entry of parsed.internal) expect(entry).not.toContain('\\')

    // --grep narrows on the module specifier, and an all-filtered result names the filter
    // instead of looking like the file has no imports at all.
    const grepped = run(['deps', 'app.ts', '--grep', 'mod'])
    expect(grepped.status, grepped.stderr).toBe(0)
    expect(grepped.stdout).toContain('src/mod.ts')

    const grepMiss = run(['deps', 'app.ts', '--grep', 'zzzzNoSuchDep'])
    expect(grepMiss.status, grepMiss.stderr).toBe(0)
    expect(grepMiss.stdout).toContain('--grep zzzzNoSuchDep')
    expect(grepMiss.stdout).not.toBe('(no imports found)\n')

    // Invalid regex falls back to a literal substring match instead of erroring.
    const grepInvalid = run(['deps', 'app.ts', '--grep', '[unclosed'])
    expect(grepInvalid.status, grepInvalid.stderr).toBe(0)
  },
  types: () => {
    // The fixture is tiny and may have no type declarations; accept exit 0 or 1 but never a crash.
    const r = run(['types'])
    expect(r.status).not.toBeNull()
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function|Cannot find package/)

    // --grep narrows by NAME against the typesgrep.ts fixture, and an all-filtered result
    // names the filter instead of looking like the store is empty.
    const grepped = run(['types', 'typesgrep.ts', '--json', '--grep', 'Alpha'])
    expect(grepped.status, grepped.stderr).toBe(0)
    const greppedParsed = envelopeItems<{ name: string; filePath: string }>(grepped.stdout)
    expect(greppedParsed.map((t) => t.name)).toEqual(['TypesGrepAlphaFixture'])
    // `--json`'s filePath now renders root-relative against the real built binary, matching the
    // outline/skeleton/refs --json convention.
    expect(greppedParsed[0]?.filePath.replace(/\\/g, '/')).toBe('typesgrep.ts')

    const grepMiss = run(['types', 'typesgrep.ts', '--grep', 'zzzzNoSuchType'])
    expect(grepMiss.status, grepMiss.stderr).toBe(0)
    expect(grepMiss.stdout).toContain('--grep zzzzNoSuchType')
    expect(grepMiss.stdout).not.toContain('No type declarations found')

    // Invalid regex falls back to a literal substring match instead of erroring.
    const grepInvalid = run(['types', 'typesgrep.ts', '--grep', '[unclosed'])
    expect(grepInvalid.status, grepInvalid.stderr).toBe(0)
  },
  scope: () => {
    // Line 2 of caller.ts is inside refHelper (which spans lines 1-3); scope must find it.
    const r = run(['scope', 'caller.ts:2'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/refHelper/)
  },
  similar: () => {
    // similar needs a real indexed symbol in the fixture; use 'refHelper' which is indexed.
    const r = run(['similar', 'caller.ts::refHelper', '--top', '3'])
    // Either finds similar symbols (exit 0) or reports symbol not found (exit 1); both are reachable, not tree-shaken.
    expect(r.status).not.toBeNull()
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  'context-for': () => {
    // This tiny fixture has no symbol matching "parse symbols" even after the widen-on-empty OR
    // retry, so a clean "no matches" (exit 1) is the correct, expected outcome here -- same
    // reachable-either-way pattern as 'similar' above; this is a wiring smoke test, not a
    // relevance test.
    const r = run(['context-for', 'parse symbols'])
    expect(r.status).not.toBeNull()
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    // Every emitted suggestion carries the `@LINE` anchor and actually runs.
    const hit = run(['context-for', 'alphaSym'])
    expect(hit.status, hit.stderr).toBe(0)
    const suggestions = hit.stdout.trim().split('\n').filter((l) => l.startsWith('token-goat read '))
    expect(suggestions.length).toBeGreaterThan(0)
    for (const line of suggestions) {
      const spec = /^token-goat read "(.+)"$/.exec(line)?.[1]
      expect(spec, `malformed suggestion: ${line}`).toMatch(/@\d+$/)
      const exec = run(['read', spec!])
      expect(exec.status, `suggestion failed: ${line}\n${exec.stderr}`).toBe(0)
    }
  },
  'test-for': () => {
    const r = run(['test-for', 'caller.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)

    // `--json`'s testFile now renders root-relative against the real built binary, matching the
    // outline/skeleton/refs --json convention. exclhelper.ts is referenced by exclcaller.test.ts
    // (see the 'refs'/'callers' --exclude-tests fixtures above), so this exercises a real hit.
    const j = run(['test-for', 'exclhelper.ts', '--json'])
    expect(j.status, j.stderr).toBe(0)
    const jParsed = envelopeItems<{ testFile: string }>(j.stdout)
    expect(jParsed.some((e) => e.testFile.replace(/\\/g, '/') === 'exclcaller.test.ts')).toBe(true)
  },
  'coverage-gaps': () => {
    const r = run(['coverage-gaps', '--top', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  arch: () => {
    const r = run(['arch', '--top', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/hubs/)
  },
  blame: () => {
    // The fixture is not a git repo; blame must fail gracefully with exit 1 and a message, not crash.
    const r = run(['blame', 'caller.ts::refHelper'])
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.status).not.toBeNull()
  },
  ask: () => {
    // Degraded mode: no TOKEN_GOAT_ASK_BACKEND set; must print degraded notice and exit 0.
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_ASK_BACKEND: '' }
    const r = run(['ask', 'how are symbols stored'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  pack: () => {
    // Pack a known file and assert its content appears in the bundle.
    const r = run(['pack', 'src/mod.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('alphaSym')
  },
  tokens: () => {
    // --top 1 must limit to exactly one row; --json must parse.
    const r = run(['tokens', 'src/mod.ts', 'caller.ts', '--top', '1'])
    expect(r.status, r.stderr).toBe(0)
    const rows = r.stdout.split('\n').filter((l) => l.includes('mod.ts') || l.includes('caller.ts'))
    expect(rows.length).toBe(1)
    const rj = run(['tokens', 'src/mod.ts', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { entries: unknown[]; total_tokens: number }
    // Exactly one file was requested -- pin the exact entry count so a regression that
    // duplicated or dropped rows (still non-empty either way) is caught.
    expect(parsed.entries.length).toBe(1)
    expect(parsed.total_tokens).toBeGreaterThan(0)
  },
  budget: () => {
    // Output must reflect the file's token cost; --json must parse.
    const r = run(['budget', 'src/mod.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/mod.ts/)
    const rj = run(['budget', 'src/mod.ts', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { total_tokens: number }
    expect(parsed.total_tokens).toBeGreaterThan(0)
  },
  failures: () => {
    // Feed a minimal pytest failure block and assert extraction works; --json must parse.
    const input = [
      '=== FAILURES ===',
      '______ test_add ______',
      'def test_add():',
      '    assert 1 == 2',
      'E   AssertionError: assert 1 == 2',
      '',
      'test_math.py:4: AssertionError',
      '=== 1 failed in 0.05s ===',
    ].join('\n')
    const r = run(['failures'], { input })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('test_add')
    const rj = run(['failures', '--json'], { input })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { failures: Array<{ name: string }> }
    // The fixture has exactly one failure block -- pin the exact count and name so a
    // regression that emitted a duplicate or unrelated entry (still non-empty) is caught.
    expect(parsed.failures.length).toBe(1)
    expect(parsed.failures[0]?.name).toBe('test_add')

    // --delta: first invocation for this --key has no baseline yet, so the current failure is
    // reported as newly-failing rather than an empty/silent delta.
    const first = run(['failures', '--delta', '--key', 'matrix-e2e'], { input })
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('No baseline yet')
    expect(first.stdout).toContain('test_add')

    // Second invocation with the SAME failure: nothing newly failing/fixed, one still-failing
    // (reported as a count, not a re-dump of the block body).
    const second = run(['failures', '--delta', '--key', 'matrix-e2e'], { input })
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('Newly failing (0)')
    expect(second.stdout).toContain('Newly fixed (0)')
    expect(second.stdout).toContain('Still failing (unchanged): 1')

    // Third invocation with a different failing test: the old one is newly-fixed, the new one is
    // newly-failing.
    const changedInput = [
      '=== FAILURES ===',
      '______ test_subtract ______',
      'def test_subtract():',
      '    assert 1 == 0',
      'E   AssertionError: assert 1 == 0',
      '',
      'test_math.py:9: AssertionError',
      '=== 1 failed in 0.05s ===',
    ].join('\n')
    const third = run(['failures', '--delta', '--key', 'matrix-e2e'], { input: changedInput })
    expect(third.status, third.stderr).toBe(0)
    expect(third.stdout).toContain('Newly failing (1)')
    expect(third.stdout).toContain('test_subtract')
    expect(third.stdout).toContain('Newly fixed (1)')
    expect(third.stdout).toContain('test_add')

    // --json shape for --delta: hasBaseline, newlyFailing/newlyFixed arrays, stillFailingCount
    // (not a full stillFailing array).
    const fourthJson = run(['failures', '--delta', '--key', 'matrix-e2e-json', '--json'], { input })
    expect(fourthJson.status, fourthJson.stderr).toBe(0)
    const firstDelta = JSON.parse(fourthJson.stdout) as { hasBaseline: boolean; newlyFailing: string[] }
    expect(firstDelta.hasBaseline).toBe(false)
    expect(firstDelta.newlyFailing).toEqual(['test_add'])
    const fifthJson = run(['failures', '--delta', '--key', 'matrix-e2e-json', '--json'], { input })
    const secondDelta = JSON.parse(fifthJson.stdout) as {
      hasBaseline: boolean
      newlyFailing: string[]
      newlyFixed: string[]
      stillFailingCount: number
      stillFailing?: unknown
    }
    expect(secondDelta.hasBaseline).toBe(true)
    expect(secondDelta.newlyFailing).toEqual([])
    expect(secondDelta.newlyFixed).toEqual([])
    expect(secondDelta.stillFailingCount).toBe(1)
    expect(secondDelta.stillFailing).toBeUndefined()
  },
  todo: () => {
    // Write a temp file with a TODO marker and confirm it's found.
    const fixture = path.join(dataBase, 'todo_fixture.ts')
    fs.writeFileSync(fixture, 'const x = 1 // TODO: fix this\n', 'utf8')
    const r = run(['todo', fixture])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('TODO')
    const rj = run(['todo', fixture, '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { items: Array<{ file: string; kind: string; text: string; line: number }> }
    // The fixture has exactly one TODO marker -- pin the exact count/kind/line/text so a
    // regression that emitted a duplicate or misparsed entry (still non-empty) is caught.
    expect(parsed.items).toEqual([{ file: expect.any(String), kind: 'TODO', text: 'fix this', line: 1 }])
  },
  trace: () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "main.py", line 3, in run',
      '    result = helper()',
      '  File "/usr/lib/python3/site.py", line 10, in site_fn',
      '    pass',
      'ValueError: bad input',
    ].join('\n')
    const r = run(['trace'], { input: tb, cwd: repo })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)

    // Mixed CI log flexing the built bundle's Node/Rust/JVM/.NET grammar support (not just
    // Python), one combined case per the "or one combined multi-grammar case" allowance.
    const mixed = [
      'Error: boom',
      '    at helper (main.js:12:34)',
      '    at Object.<anonymous> (node:internal/modules/cjs/loader:1105:14)',
      '',
      "thread 'main' panicked at src/main.rs:10:5:",
      'called `Option::unwrap()` on a `None` value',
      'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
      '',
      'Exception in thread "main" java.lang.NullPointerException: boom',
      '\tat com.example.MyClass.doWork(MyClass.java:42)',
      '',
      'Unhandled exception. System.NullReferenceException: boom',
      '   at MyApp.Program.DoWork() in Program.cs:line 42',
    ].join('\n')
    const rj = run(['trace', '--json'], { input: mixed, cwd: repo })
    expect(rj.status, rj.stderr).toBe(0)
    expect(rj.stdout + rj.stderr).not.toMatch(/unknown command|is not a function/)
    const parsed = JSON.parse(rj.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(4)
    expect(parsed.tracebacks.some((t) => t.frames.some((f) => f.file === 'main.js'))).toBe(true)
    expect(parsed.tracebacks.some((t) => t.frames.some((f) => f.file === 'src/main.rs'))).toBe(true)
    expect(parsed.tracebacks.some((t) => t.frames.some((f) => f.file === 'MyClass.java'))).toBe(true)
    expect(parsed.tracebacks.some((t) => t.frames.some((f) => f.file === 'Program.cs'))).toBe(true)
  },
  logfold: () => {
    const input = 'added 5 packages in 1s\n[12:00:01] hit\n[12:00:02] hit\n'
    const r = run(['logfold'], { input })
    expect(r.status, r.stderr).toBe(0)
    // npm-summary line should be dropped; identical normalised lines should fold
    expect(r.stdout).not.toContain('added 5 packages')
    expect(r.stdout).toMatch(/hit/)
    // --fold-repeats folds non-adjacent duplicates too, attributing the total count to the
    // first occurrence.
    const r2 = run(['logfold', '--fold-repeats'], { input: 'boom\nnoise\nboom\n' })
    expect(r2.status, r2.stderr).toBe(0)
    expect(r2.stdout).toContain('(x2)')
  },
  lockdeps: () => {
    // token-goat ships a package-lock.json; run against the repo root.
    const r = run(['lockdeps', 'package-lock.json'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('commander')
    expect(r.stdout).toContain('package-lock.json')
  },
  'dep-docs': () => {
    // token-goat depends on commander directly (see package.json); run against the repo root
    // so package.json/README/types resolution all hit the real installed package.
    const r = run(['dep-docs', 'commander', '--json'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { package: string; readme: { file: string } | null; types: { source: string } | null }
    expect(parsed.package).toBe('commander')
    expect(parsed.readme?.file).toMatch(/[Rr]eadme/)
    expect(parsed.types?.source).toBe('bundled')

    const rMissing = run(['dep-docs', 'commande'], { cwd: ROOT })
    expect(rMissing.status).toBe(1)
    expect(rMissing.stderr).toContain('not found')
    expect(rMissing.stderr).toContain('did you mean')
  },
  note: () => {
    // Use an isolated data dir so notes don't pollute real home.
    const noteData = mkIsolated('tg-note-')
    const noteEnv = { ...tgEnv(noteData), TOKEN_GOAT_HOME: noteData }
    const rSet = run(['note', 'set', 'mykey', 'myval'], { env: noteEnv, cwd: repo })
    expect(rSet.status, rSet.stderr).toBe(0)
    const rGet = run(['note', 'get', 'mykey'], { env: noteEnv, cwd: repo })
    expect(rGet.status, rGet.stderr).toBe(0)
    expect(rGet.stdout.trim()).toBe('myval')
    const rList = run(['note', 'list', '--json'], { env: noteEnv, cwd: repo })
    expect(rList.status, rList.stderr).toBe(0)
    const parsed = JSON.parse(rList.stdout) as Record<string, string>
    expect(parsed['mykey']).toBe('myval')
  },
  hot: () => {
    // Fresh isolated env — no sessions; must exit 0 and not crash.
    const hotData = mkIsolated('tg-hot-')
    const r = run(['hot', '--limit', '5'], { env: tgEnv(hotData) })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  recent: () => {
    // Fresh process — no session files read; must exit 0.
    const r = run(['recent', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
  },
  ignores: () => {
    const r = run(['ignores'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Walk mode/)
    const rj = run(['ignores', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { walkMode: string; excludeTests: boolean }
    expect(['git', 'non-git']).toContain(parsed.walkMode)
  },
  'bash-history': () => {
    // Isolated home so no bash blobs exist; must exit 0 and report empty cache.
    const cacheDir = mkIsolated('tg-bhist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['bash-history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No bash output entries cached.')
    const rj = run(['bash-history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
  'web-history': () => {
    // Isolated home so no web blobs exist; must exit 0 and report empty cache.
    const cacheDir = mkIsolated('tg-whist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['web-history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No web output entries cached.')
    const rj = run(['web-history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
  'mcp-history': () => {
    // Isolated home so no mcp blobs exist; must exit 0 and report empty cache.
    const cacheDir = mkIsolated('tg-mhist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['mcp-history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No mcp output entries cached.')
    const rj = run(['mcp-history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
  'reclaim-index': () => {
    // Runs against its own isolated data dir, never `dataBase`: --rebuild drops every derived
    // row, which would wipe the shared index the rest of this suite reads from.
    const isolated = mkIsolated('tg-reclaim-')
    const env = { ...tgEnv(isolated) }
    const rIdx = run(['index'], { env })
    expect(rIdx.status, rIdx.stderr).toBe(0)

    const rj = run(['reclaim-index', '--rebuild', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as {
      rebuilt: boolean
      dropped: Record<string, number>
      beforeBytes: number
      afterBytes: number
    }
    expect(p.rebuilt).toBe(true)
    // The fixture repo really was indexed above, so the rebuild must report dropping real rows
    // -- a 0 here would mean the delete ran against an empty or wrong database.
    expect(p.dropped['symbols']).toBeGreaterThan(0)
    expect(p.afterBytes).toBeGreaterThan(0)

    // Derived rows are genuinely gone, not merely reported as gone.
    const rSym = run(['symbol', 'alphaSym'], { env })
    expect(rSym.stdout).not.toContain('src/mod.ts')

    // Vacuum-only form: valid, and must not silently drop anything.
    const r2 = run(['reclaim-index', '--json'], { env })
    expect(r2.status, r2.stderr).toBe(0)
    const p2 = JSON.parse(r2.stdout) as { rebuilt: boolean; dropped: Record<string, number> }
    expect(p2.rebuilt).toBe(false)
    expect(Object.keys(p2.dropped)).toHaveLength(0)
  },
  'clean-cache': () => {
    // Isolated home; nothing to prune; must exit 0 and report 0 removed total.
    const cacheDir = mkIsolated('tg-clean-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['clean-cache'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('total: 0 removed')
    const rj = run(['clean-cache', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { total: number }
    expect(parsed.total).toBe(0)
  },
  'prune-cache': () => {
    // Isolated home; nothing to prune; must exit 0.
    const cacheDir = mkIsolated('tg-prune-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['prune-cache', '--max-count', '5'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('total:')
    const rj = run(['prune-cache', '--max-count', '5', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { total: number; maxCount: number }
    expect(parsed.maxCount).toBe(5)
  },
  'cache-audit': () => {
    // Must exit 0 and emit findings; content varies by environment.
    const r = run(['cache-audit'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toContain('cache-audit:')
    const rj = run(['cache-audit', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as { findings: unknown[]; issueCount: number }
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(typeof parsed.issueCount).toBe('number')
  },
  resume: () => {
    // No real session blobs in isolated env; must exit 1 with a clear error message.
    const cacheDir = mkIsolated('tg-resume-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['resume', 'no_such_session_xyz'], { env })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no session blob found/i)
  },
  'compact-hint': () => {
    // May have no compact sessions; must exit 0 regardless and produce hint output.
    const cacheDir = mkIsolated('tg-chint-')
    const env = { ...tgEnv(cacheDir), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['compact-hint'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rj = run(['compact-hint', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { tier: string; fillFraction: number }
    expect(typeof p.tier).toBe('string')
    expect(typeof p.fillFraction).toBe('number')
  },
  'session-summary': () => {
    // Isolated home; no sessions; must exit 0 and report empty.
    const cacheDir = mkIsolated('tg-sesssum-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['session-summary'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/no session blobs found|Session:/i)
    const rj = run(['session-summary', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { sessionCount: number }
    expect(typeof p.sessionCount).toBe('number')
  },
  cost: () => {
    // Must exit 0 and emit stats or empty-session message.
    const cacheDir = mkIsolated('tg-cost-')
    const env = { ...tgEnv(cacheDir), TOKEN_GOAT_HOME: cacheDir }
    const r = run(['cost'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rs = run(['cost', '--session'], { env })
    expect(rs.status, rs.stderr).toBe(0)
  },
  baseline: () => {
    // Run against the test repo; must produce a project map with file count.
    const r = run(['baseline'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Project map|Files:|Languages/i)
    const rj = run(['baseline', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { fileCount: number; rootDir: string }
    expect(typeof p.fileCount).toBe('number')
    expect(p.fileCount).toBeGreaterThan(0)
  },
  config: () => {
    // config list in an isolated home — must exit 0 and emit at least one key=value line.
    const cfgDir = mkIsolated('tg-config-')
    const env = { ...tgEnv(cfgDir), TOKEN_GOAT_HOME: cfgDir }
    const r = run(['config', 'list'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/compact_assist|worker/)
    const rj = run(['config', 'list', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const parsed = JSON.parse(rj.stdout) as Record<string, unknown>
    expect(typeof parsed['compact_assist']).toBe('object')
    // config get a known key
    const rg = run(['config', 'get', 'compact_assist.enabled'], { env })
    expect(rg.status, rg.stderr).toBe(0)
    expect(rg.stdout.trim()).toBe('true')
    // config validate on empty config — no issues
    const rv = run(['config', 'validate'], { env })
    expect(rv.status, rv.stderr).toBe(0)
    expect(rv.stdout).toContain('no issues found')
  },
  project: () => {
    // project list — must exit 0 and list blocked_roots (empty by default).
    const projDir = mkIsolated('tg-proj-')
    const env = { ...tgEnv(projDir), TOKEN_GOAT_HOME: projDir }
    const r = run(['project', 'list'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    const rj = run(['project', 'list', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { blocked_roots: string[] }
    expect(Array.isArray(p.blocked_roots)).toBe(true)
    // project prune — no stale roots, exits 0
    const rp = run(['project', 'prune'], { env })
    expect(rp.status, rp.stderr).toBe(0)
  },
  'compact-doc': () => {
    // Run compact-doc with --heading (fixture README.md has an Install section).
    const r = run(['compact-doc', 'README.md', '--heading', 'Install'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout).toContain('Install')
    // --json emits a compact field
    const rj = run(['compact-doc', 'README.md', '--heading', 'Install', '--json'])
    expect(rj.status, rj.stderr).toBe(0)
    const p = JSON.parse(rj.stdout) as { path: string; compact: string }
    expect(typeof p.compact).toBe('string')
    // Length-only wouldn't catch --json returning an unrelated (but still non-empty) section --
    // pin the same real content the plain-text form above already checks.
    expect(p.compact).toContain('Install')
  },
  'fetch-image': () => {
    // fetch-image without network — verify it dispatches correctly by checking --help reachability.
    const r = run(['fetch-image', '--help'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/unknown command|is not a function/)
    expect(r.stdout).toMatch(/url|fetch|image/i)
  },
  history: () => {
    // Isolated home — no blobs; must exit 0 and report empty.
    const histDir = mkIsolated('tg-hist-')
    const env = { ...tgEnv(dataBase), TOKEN_GOAT_HOME: histDir }
    const r = run(['history'], { env })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No history entries found')
    const rj = run(['history', '--json'], { env })
    expect(rj.status, rj.stderr).toBe(0)
    const arr = JSON.parse(rj.stdout) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
  },
}

describe('built bundle image shrink (real sharp dlopen through the full CLI import graph)', () => {
  // Regression test: embeddings.ts used to `require('@xenova/transformers')`
  // eagerly at module load time. index_prune.ts (reachable from every real CLI
  // invocation via cmdIndex) imports embeddings.ts, so every run of the built
  // bundle loaded @xenova/transformers — and transitively its own bundled
  // onnxruntime-node and a nested, differently-versioned copy of sharp's native
  // libvips binaries — before image_shrink.ts's own `import('sharp')` ever ran.
  // That poisoned the Windows DLL search order: the top-level sharp's dlopen
  // then failed with ERR_DLOPEN_FAILED, caught and silently swallowed as
  // "sharp unavailable" by loadSharp()'s catch block, so image shrinking was a
  // silent no-op in the shipped binary despite every image_shrink.test.ts case
  // passing (those import image_shrink.ts directly, never through the CLI's
  // full import graph, so @xenova/transformers was never loaded in-process).
  // This spawns the real dist/token-goat.mjs as a separate process and drives
  // it through the actual `hook pre_tool_use` dispatch path with a real
  // oversized image, asserting a genuine shrink happened — not just "no crash".
  it('shrinks an oversized image end-to-end through the built bundle', async () => {
    const side = 700 // 490,000px: comfortably under the default max_image_pixels cap
    const noise = Buffer.allocUnsafe(side * side * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
    const jpegBuf = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
      .jpeg({ quality: 100 })
      .toBuffer()
    expect(jpegBuf.length).toBeGreaterThan(512 * 1024) // must clear image_shrink's own threshold

    const imgDir = mkIsolated('tg-matrix-img-')
    const imgPath = path.join(imgDir, 'big.jpg')
    fs.writeFileSync(imgPath, jpegBuf)

    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: imgPath },
      session_id: 'matrix-image-shrink',
    })
    // OCR is disabled here: this test's whole point is the sharp DLL-poisoning regression,
    // predating OCR entirely. Leaving OCR on would make the assertion depend on real
    // tesseract.js's confidence score for random noise (low, but not a contract) rather than
    // deterministically exercising the pixel-shrink path this test actually targets. OCR's
    // own built-bundle wiring gets its own smoke test below.
    const r = run(['hook', 'pre_tool_use'], {
      input: payload,
      env: { ...tgEnv(dataBase), TOKEN_GOAT_OCR_ENABLED: 'false' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('sharp unavailable')

    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = out.hookSpecificOutput?.additionalContext ?? ''
    expect(context).toContain('smaller')
    expect(context).toMatch(/data:image\/(jpeg|webp);base64,/)
  }, 30000)

  // Regression coverage for the same class of bug the test above guards against, but for
  // OCR's dependency instead of sharp's: 'tesseract.js' must be in esbuild.config.mjs's
  // EXTERNAL_NATIVE_DEPS (see that file's comment) or esbuild would statically inline it into
  // dist/token-goat.mjs, defeating graceful degradation on installs that skip optional deps --
  // a bug that, like the sharp/DLL one above, would pass every image_ocr.test.ts/
  // image_shrink.test.ts case (they import image_ocr.ts/image_shrink.ts directly from src,
  // never through the built bundle) while being silently broken in the shipped binary. This
  // spawns the real dist/token-goat.mjs against a genuinely text-heavy generated image and
  // asserts only that the hook completes cleanly with SOME valid context output -- not that
  // OCR specifically wins over the pixel-shrink path, since a CI runner with no cached
  // eng.traineddata and no outbound network to fetch it is expected to fail open to the
  // shrink path per this feature's own "must fail open" contract, not fail the test.
  it('handles a text-heavy image end-to-end through the built bundle without crashing or hanging (OCR wiring smoke test)', async () => {
    // A dense multi-line "terminal output" SVG, comfortably under the 16M-pixel decode cap
    // (1400x900 = 1.26M) so it isn't rejected before OCR ever gets a chance to run, and
    // rendered with PNG compression disabled so the byte count clears image_shrink's 512KB
    // gate without needing extreme dimensions that would distort the text past legibility.
    const lines = Array.from(
      { length: 30 },
      (_, i) =>
        `<text x="20" y="${30 + i * 28}" font-family="monospace" font-size="22" fill="white">` +
        `line ${i}: npm run build succeeded, tests passed 214/214</text>`,
    ).join('')
    const svg = Buffer.from(`<svg width="1400" height="900" xmlns="http://www.w3.org/2000/svg">` + `<rect width="1400" height="900" fill="black"/>${lines}</svg>`)
    const textPng = await sharp(svg).png({ compressionLevel: 0 }).toBuffer()
    expect(textPng.length).toBeGreaterThan(512 * 1024)

    const imgDir = mkIsolated('tg-matrix-ocr-img-')
    const imgPath = path.join(imgDir, 'text.png')
    fs.writeFileSync(imgPath, textPng)

    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: imgPath },
      session_id: 'matrix-image-ocr',
    })
    const r = run(['hook', 'pre_tool_use'], { input: payload })
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = out.hookSpecificOutput?.additionalContext ?? ''
    // Either path is acceptable (see comment above); a crash, a hang, or an empty/pass-through
    // response with neither marker is not.
    const gotOcrText = context.includes("OCR'd")
    const gotShrunkImage = /data:image\/(jpeg|webp);base64,/.test(context)
    expect(gotOcrText || gotShrunkImage, `unexpected context output: ${context.slice(0, 200)}`).toBe(true)
  }, 30000)
})

describe('built bundle command matrix', () => {
  it('every registered command has a matrix case (and vice versa)', () => {
    const registered = new Set(allCommandNames())
    const covered = new Set(Object.keys(cases))
    const missing = [...registered].filter((n) => !covered.has(n)).sort()
    const extra = [...covered].filter((n) => !registered.has(n)).sort()
    expect(missing, 'registered commands with no matrix case').toEqual([])
    expect(extra, 'matrix cases for commands that are not registered').toEqual([])
  })

  for (const [name, assertCase] of Object.entries(cases)) {
    it(`'${name}' produces correct output from the built bundle`, assertCase, 120000)
  }
})
