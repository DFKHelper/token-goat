/**
 * Guard: a test body must not be able to run to completion having asserted nothing.
 *
 * A test that does not run reports the same thing as a test that passed. `it.skip` at least moves
 * the skip counter, so a permanently-skipped case is visible in every run's summary. A bare
 * `return` inside the body is not: the case executes, asserts nothing, and reports PASSED. Nothing
 * in a green run distinguishes it from a case that did its job, which is how a subject can quietly
 * lose all of its coverage and how a live defect can sit behind a test named for catching it.
 *
 * What this scans for: a `return` with no value, at statement position inside an `it`/`test`
 * callback (not inside a nested function the body defines), that sits ahead of every `expect(...)`
 * / `assert(...)` call in that same body. That is precisely the "can finish having asserted
 * nothing" shape. A bare `return` that follows an assertion is not flagged: those are almost
 * always TypeScript narrowing after `expect(x.kind).toBe(...)`, where the return is unreachable.
 *
 * What it deliberately cannot catch, so that nobody reads a green run here as more than it is:
 *   - a body whose assertions all live in a shared helper (`expectFencedPost(...)`): the scan
 *     counts literal `expect`/`assert` callees only, so helper-only bodies are treated as having
 *     assertions and are never flagged either way;
 *   - a conditional assertion with no early return (`if (res.hookType === 'deny') expect(...)`),
 *     which is the normal shape of a negative test and is far too common to adjudicate here;
 *   - a loop that asserts per item over a collection that happens to be empty at runtime, which no
 *     source scan can see (that one needs a population floor written into the test itself);
 *   - an unawaited promise assertion.
 *
 * Exemptions below are the sites where a bare return is the honest answer: an unavailable optional
 * native dependency, or a privilege the machine does not grant. Each is keyed by file and by the
 * test's own title, so renaming the test or deleting it forces the entry to be revisited rather
 * than silently rotting. The guard also fails on a stale entry that no longer matches a live site,
 * which is what keeps this list from drifting into decoration.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS_ROOT = path.resolve(HERE, '..')
const ROOT = path.resolve(TESTS_ROOT, '..')

/** This guard's own file: it is a test file under the scanned tree, so exclude it from its own sweep. */
const SELF = 'tests/guards/test_bodies_assert_before_returning.test.ts'

type Exemption = { file: string; title: string; sites: number; reason: string }

/**
 * Every test that may finish without asserting, and why. `sites` is how many bare returns in that
 * body precede all of its assertions: a new one appearing in an already-listed test still fails.
 */
const EXEMPT: readonly Exemption[] = [
  {
    file: 'tests/cli_bootstrap_audit.test.ts',
    title: 'deduplicates canonical files reached through a directory link',
    sites: 1,
    reason: 'Creating the directory link is the fixture. Windows refuses a symlink or junction to an unprivileged process without developer mode, so the scenario cannot be built at all on such a machine.',
  },
  {
    file: 'tests/cli_bootstrap_audit.test.ts',
    title: 'accepts top-level linked agent roots but rejects nested escaping links',
    sites: 1,
    reason: 'Same symlink privilege: the three links this plants are the whole fixture.',
  },
  {
    file: 'tests/cli_bootstrap_audit.test.ts',
    title: 'rejects an external agents root link by default and follows it with opt-in',
    sites: 1,
    reason: 'Same symlink privilege: the external agents-root link is the whole fixture.',
  },
  {
    file: 'tests/cli.test.ts',
    title: 'bash-output --file rejects a FIFO (special file)',
    sites: 1,
    reason: 'mkfifo is not present on every POSIX image the suite runs on, and without the FIFO there is no special file for the reader to reject.',
  },
  {
    file: 'tests/cli_mcp_audit.test.ts',
    title: 'discovers servers from ~/.claude.json even when its key uses a different drive-letter case than the (canonicalized) project root',
    sites: 1,
    reason: 'Drive letters exist only on Windows, and only when the temp directory actually carries one, so there is no differently-cased key to build anywhere else.',
  },
  {
    file: 'tests/cmdindex_case_only_rename_converges.test.ts',
    title: 'refuses a resolved name that lives in another directory',
    sites: 1,
    reason: 'Same symlink privilege: the link whose target carries a fold-equal basename in a different directory is the whole fixture.',
  },
  {
    file: 'tests/codex_review_regressions.test.ts',
    title: 'rejects a directory symlink pointing out of the root (finding 1: canonicalize does not call realpath, so <root>/link -> /elsewhere satisfied a plain string-prefix test while naming a confined-away file)',
    sites: 1,
    reason: 'Same symlink privilege: the escaping directory link is the whole fixture, and the realpath resolution under test is platform-independent.',
  },
  {
    file: 'tests/embed_model_shared_cache.test.ts',
    title: 'refuses to publish through a symlink planted at its temp name',
    sites: 1,
    reason: 'Same symlink privilege: without one there is no planted link to refuse.',
  },
  {
    file: 'tests/embed_model_shared_cache.test.ts',
    title: 'will not copy a cached entry that is a symlink, however good its target looks',
    sites: 1,
    reason: 'Same symlink privilege: without one there is no symlinked cache entry to reject.',
  },
  {
    file: 'tests/embed_vec_module_unloaded.test.ts',
    title: 'prunes symbols/files even though chunk_vectors is present-but-unusable',
    sites: 1,
    reason: 'The scenario is "a vec0 table created while sqlite-vec worked, on a connection that no longer has the module", so building the fixture needs sqlite-vec to have worked once. The body\'s second early return sits behind an assertion and so is not counted here.',
  },
  {
    file: 'tests/guards/language_adapter_produces_symbols.test.ts',
    title: '$language ($kind) produces at least one symbol on a real file of its language',
    sites: 1,
    reason: 'Responsibility is delegated, not dropped: the sibling test in the same file asserts that every non-live CASES entry is reported as stale, so a case this body returns early on fails there instead of vanishing.',
  },
  {
    file: 'tests/guards/script_allowlist_is_enforced.test.ts',
    title: '<template>',
    sites: 1,
    reason: 'Vacuous by design, and correctly so: the rule is "no allowScripts allowlist without the tool that reads it", so a manifest that declares no allowlist has nothing to check. Neither manifest declares one today.',
  },
  {
    file: 'tests/hooks_agent_spawn.test.ts',
    title: 'does not follow a nested symlink out of the project roster into the rest of the filesystem',
    sites: 1,
    reason: 'Same symlink privilege: the escaping link is the whole fixture.',
  },
  {
    file: 'tests/hooks_agent_spawn.test.ts',
    title: 'does not follow the project roster itself when .claude/agents is a symlink out of the project',
    sites: 1,
    reason: 'Same symlink privilege: the escaping roster link is the whole fixture.',
  },
  {
    file: 'tests/index_prune.test.ts',
    title: 'clears the vector as well as the chunk row',
    sites: 1,
    reason: 'sqlite-vec is optional; with no chunk_vectors table there is no vector for the prune to clear.',
  },
  {
    file: 'tests/index_reader.test.ts',
    title: 'searchSymbolsFts matches a natural-language query containing FTS5 operator chars',
    sites: 1,
    reason: 'FTS5 can be compiled out of the sqlite build, leaving no symbols_fts table to query. The sibling test in the same file covers the no-FTS no-op path.',
  },
  {
    file: 'tests/index_reader.test.ts',
    title: 'searchSymbolsFts still finds a match when the query contains a literal double-quote character',
    sites: 1,
    reason: 'Same missing FTS5 table. The escaping itself is pinned unconditionally by the sanitizeFtsQuery unit test alongside it.',
  },
  {
    file: 'tests/read_commands.test.ts',
    title: 'runGrep still follows a legitimate symlink when unconfined (activePins is null)',
    sites: 1,
    reason: 'Same symlink privilege, reported by the fixture helper as canSymlink rather than thrown.',
  },
  {
    file: 'tests/read_commands.test.ts',
    title: 'runGrep finds a file reachable only through a legitimate in-root symlink when confined',
    sites: 1,
    reason: 'Same symlink privilege, reported by the fixture helper as canSymlink rather than thrown.',
  },
  {
    file: 'tests/read_commands.test.ts',
    title: 'runGrep terminates on a symlink cycle when confined',
    sites: 1,
    reason: 'Same symlink privilege: without one there is no cycle to terminate on.',
  },
  {
    file: 'tests/read_commands.test.ts',
    title: 'runGrep does not report the same file twice via a symlink to an already-walked directory when confined',
    sites: 1,
    reason: 'Same symlink privilege: without one there is no second path to the same directory.',
  },
] as const

/** Floors: a scan that found no files, or implausibly few test bodies, must fail rather than pass empty. */
const MIN_FILES = 500
const MIN_TEST_BODIES = 9000

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, acc)
    else if (entry.name.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

type Site = { file: string; title: string; line: number; sites: number }

/** Resolve `it` / `test` / `it.each(...)` / `test.concurrent` and friends to the base identifier. */
function testCallName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null
  let callee: ts.Expression = node.expression
  while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
    callee = ts.isCallExpression(callee) ? callee.expression : callee.expression
  }
  if (!ts.isIdentifier(callee)) return null
  return callee.text === 'it' || callee.text === 'test' ? callee.text : null
}

function scanFile(absPath: string, rel: string): { bodies: number; sites: Site[] } {
  const source = readFileSync(absPath, 'utf8')
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sites: Site[] = []
  let bodies = 0

  const visit = (node: ts.Node): void => {
    if (testCallName(node) !== null && ts.isCallExpression(node)) {
      bodies++
      const titleArg = node.arguments[0]
      const title =
        titleArg !== undefined && ts.isStringLiteralLike(titleArg) && !ts.isTemplateExpression(titleArg)
          ? titleArg.text
          : '<template>'
      const body = node.arguments[1]
      if (body !== undefined && (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) && ts.isBlock(body.body)) {
        const bareReturnLines: number[] = []
        const assertionLines: number[] = []
        const walk = (n: ts.Node, insideNestedFn: boolean): void => {
          const isNestedFn =
            n !== body.body && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))
          if (!insideNestedFn && ts.isReturnStatement(n) && n.expression === undefined) {
            bareReturnLines.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)
          }
          if (ts.isCallExpression(n)) {
            let callee: ts.Expression = n.expression
            while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
              callee = ts.isCallExpression(callee) ? callee.expression : callee.expression
            }
            if (ts.isIdentifier(callee) && (callee.text === 'expect' || callee.text === 'assert')) {
              assertionLines.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)
            }
          }
          n.forEachChild((child) => walk(child, insideNestedFn || isNestedFn))
        }
        walk(body.body, false)
        const firstAssertion = assertionLines.length > 0 ? Math.min(...assertionLines) : Number.POSITIVE_INFINITY
        const ahead = bareReturnLines.filter((l) => l < firstAssertion)
        if (ahead.length > 0) {
          sites.push({
            file: rel,
            title,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            sites: ahead.length,
          })
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return { bodies, sites }
}

const FILES = testFiles(TESTS_ROOT)
    .map((abs) => ({ abs, rel: path.relative(ROOT, abs).split(path.sep).join('/') }))
    .filter((f) => f.rel !== SELF)

let TOTAL_BODIES = 0
const FOUND: Site[] = []
for (const f of FILES) {
  const { bodies, sites } = scanFile(f.abs, f.rel)
  TOTAL_BODIES += bodies
  FOUND.push(...sites)
}

const key = (s: { file: string; title: string }): string => `${s.file} :: ${s.title}`

describe('a test body cannot finish having asserted nothing', () => {
  it('scanned a real population of test files and bodies, so an empty sweep cannot pass as clean', () => {
    pinnedPopulation({
      what: 'tests/**/*.test.ts files walked for it/test bodies',
      items: FILES.map((f) => f.rel),
      floor: MIN_FILES,
      // Anchors spanning both halves of the tree, so a walk that silently loses the guards subdirectory or the top level is a substitution rather than a pass.
      mustInclude: ['tests/embeddings.test.ts', 'tests/guards/population_pinning_is_enforced.test.ts'],
    })
    expect(TOTAL_BODIES).toBeGreaterThanOrEqual(MIN_TEST_BODIES)
    // Self-exclusion, and proof the path spelling SELF uses is the one the sweep produces: this file is a test file under the scanned tree, and every bare `return` quoted in its own prose would otherwise be its own finding.
    expect(testFiles(TESTS_ROOT).map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))).toContain(SELF)
    expect(FILES.map((f) => f.rel)).not.toContain(SELF)
    // The detector itself has to be able to find something, or a floor on the population proves nothing about the scan.
    expect(FOUND.length).toBeGreaterThan(0)
  })

  it('flags no bare return ahead of every assertion outside the recorded exemptions', () => {
    const exemptByKey = new Map(EXEMPT.map((e) => [key(e), e]))
    const unlisted = FOUND.filter((s) => !exemptByKey.has(key(s)))
    expect(
      unlisted.map((s) => `${s.file}:${s.line} :: ${s.title}`),
      'These test bodies can run to completion having asserted nothing, and would report PASSED when they do. Prefer it.skipIf(<condition>) so the run counts them as skipped, or make the body assert unconditionally. If a bare return really is the honest answer, add an entry to EXEMPT in this file with a per-site reason.',
    ).toEqual([])
  })

  it('counts the same number of bare returns each exemption was recorded for', () => {
    const foundByKey = new Map(FOUND.map((s) => [key(s), s]))
    const drifted = EXEMPT.filter((e) => (foundByKey.get(key(e))?.sites ?? -1) !== e.sites).map(
      (e) => `${key(e)} recorded ${e.sites}, found ${foundByKey.get(key(e))?.sites ?? 'none'}`,
    )
    expect(drifted, 'An exemption records how many unasserted-return sites its body has; a new one is a new gap, not a covered one.').toEqual([])
  })

  it('carries no stale exemption for a test that no longer exists or no longer returns early', () => {
    const foundKeys = new Set(FOUND.map(key))
    const stale = EXEMPT.filter((e) => !foundKeys.has(key(e))).map(key)
    expect(stale, 'A stale exemption is how a list like this turns into decoration: remove the entry once the site is gone.').toEqual([])
  })

  it('gives every exemption a reason and names a file that exists', () => {
    expect(EXEMPT.length).toBeGreaterThan(0)
    for (const e of EXEMPT) {
      expect(e.reason.length, `${key(e)} needs a reason`).toBeGreaterThan(40)
      expect(FILES.some((f) => f.rel === e.file), `${e.file} is not a scanned test file`).toBe(true)
    }
  })
})
