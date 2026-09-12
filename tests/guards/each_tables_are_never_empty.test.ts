/**
 * Guard: an `it.each` / `test.each` / `describe.each` table must not be able to be empty.
 *
 * Vitest registers one case per row of the table. Given zero rows it registers zero cases, and the
 * file then reports green with the whole block missing from the run. Verified directly:
 * `it.each(EMPTY)('case %s', ...)` beside one ordinary `it` in the same describe reports
 * `Tests 1 passed (1)` -- no warning, no skip counter movement, nothing in the summary that says a
 * parameterized block produced nothing. That is the same silent-pass shape as a test body that
 * returns before asserting, one level up: there is no body to return from because there is no case.
 *
 * The risk is not hypothetical in a repo whose guards are mostly driven by a filesystem walk or a
 * parse. Several tables here are `workflowFiles()`, `readGzJson(...)`, `Object.entries(...)` -- an
 * enumeration that stops matching (a moved directory, a renamed job key, a drifted filter) empties
 * the table, and every case it would have generated evaporates rather than failing.
 *
 * What counts as safe, checked statically: the table argument resolves to an array literal with at
 * least one element, either directly or by following same-file `const` initializers through
 * `.map`/`.filter`/`.slice`/`as const`/parentheses. A literal list cannot become empty without
 * someone deleting its members in the same diff.
 *
 * Everything else needs an entry in EXEMPT naming where its non-emptiness IS asserted. That is the
 * point of the exemption reason here: it is not "this is fine", it is the pointer to the floor or
 * the exact-equality assertion that would fail first if the source went empty. An entry whose
 * reason cannot name one is an entry that should be a fix instead.
 *
 * What this cannot catch: a table that is non-empty but wrong (every row the same, rows that do not
 * exercise what the title claims), and a cross-file source whose pin lives in another file -- the
 * exemption reason records that pin in prose, and prose is not checked. It also does not evaluate
 * anything, so a same-file literal that is spread from an empty source (`[...maybeEmpty]`) reads as
 * computed, not as safe, which is the conservative direction.
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
const SELF = 'tests/guards/each_tables_are_never_empty.test.ts'

type Exemption = { file: string; table: string; reason: string }

/** Every `.each` table this guard cannot prove non-empty statically, with the assertion that would fail first if it did go empty. */
const EXEMPT: readonly Exemption[] = [
  {
    file: 'tests/embed_tokenizer_oracle.test.ts',
    table: 'oracle.records.map((r, i) => [i, label(r.text), r] as const)',
    reason: 'Read from a gzipped oracle fixture. The same file asserts `oracle.records.length` is greater than 80, so a fixture that failed to load or decoded to nothing fails there before this table matters.',
  },
  {
    file: 'tests/guards/dependabot_coverage.test.ts',
    table: "entries.map((u) => [`${u['package-ecosystem']} ${u.directory}`, u])",
    reason: 'Parsed out of .github/dependabot.yml. The same file asserts `entries.length` is at least 3, so an unparseable or emptied config fails there first.',
  },
  {
    file: 'tests/guards/dependabot_coverage.test.ts',
    table: 'entries.map((u) => [u.directory])',
    reason: 'Same parsed dependabot.yml entries, covered by the same `entries.length` floor of 3 in this file.',
  },
  {
    file: 'tests/guards/embed_model_available_where_required.test.ts',
    table: 'jobs.map((j) => [j])',
    reason: 'jobsRestoringTheModelCache() returns the result of pinnedPopulation(), which fails on an empty or under-floor population before any table is built from it.',
  },
  {
    file: 'tests/guards/scoped_install_never_writes_claude_code_base.test.ts',
    table: 'scopes',
    reason: 'scopes is the direct return value of pinnedPopulation(), which fails on an empty or under-10 population before this table is used.',
  },
  {
    file: 'tests/guards/installer_writes_are_always_backed_up.test.ts',
    table: 'population',
    reason: 'population is the direct return value of pinnedPopulation(), which fails on an empty or under-30 population before this table is used.',
  },
  {
    file: 'tests/guards/regexp_suppressions_only_shrink.test.ts',
    table: 'Object.entries(CEILINGS)',
    reason: 'CEILINGS is an object literal declared in this file with one key per lint rule; emptying it means deleting those keys in the same diff, and the per-rule ceiling assertions would go with them.',
  },
  {
    file: 'tests/guards/workflow_job_level_contexts.test.ts',
    table: 'files.map((f) => [f])',
    reason: 'workflowFiles() walks .github/workflows. The same file asserts `files.length` is at least 3, so a walk that stopped finding workflows fails there first.',
  },
  {
    file: 'tests/guards/workflow_permissions.test.ts',
    table: 'files.map((f) => [f])',
    reason: 'Same .github/workflows walk, covered by the same `files.length` floor of 3 in this file.',
  },
  {
    file: 'tests/hook_registry.test.ts',
    table: 'HOOK_EVENTS',
    reason: 'Imported from src/types.ts as a literal array of the seven hook event names. Its non-emptiness is pinned by exact-equality assertions in tests/bridges/shims.ts and tests/bridges_status.test.ts, which compare a shim allowlist and a per-event key set against [...HOOK_EVENTS].',
  },
  {
    file: 'tests/project_config_locked_sections.test.ts',
    table: 'PROJECT_LOCKED_SECTIONS.map((s) => [s])',
    reason: 'Imported from src/config.ts. This same file asserts [...PROJECT_LOCKED_SECTIONS].sort() equals a hardcoded list of section names, so an emptied export fails that equality first.',
  },
  {
    file: 'tests/vscode_pre_handler_path_gate.test.ts',
    table: 'TOOLS',
    reason: 'Derived from VSCODE_TOOL_NAME_MAP in src/hooks_cli.ts. This same file asserts TOOLS equals the hardcoded list of the six canonical tool names, so an emptied or drifted map fails that equality first.',
  },
] as const

/** Floors: a sweep that found no files, or implausibly few parameterized blocks, must fail rather than pass empty. */
const MIN_FILES = 500
const MIN_EACH_SITES = 150

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, acc)
    else if (entry.name.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

type EachSite = { file: string; table: string; line: number; safe: boolean }

function unwrap(e: ts.Expression | undefined): ts.Expression | undefined {
  let cur = e
  while (cur !== undefined && (ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isSatisfiesExpression(cur))) {
    cur = cur.expression
  }
  return cur
}

/** The identifier a chain like `SHIMS.filter(...).map(...)` is ultimately rooted at, or null if the chain is not rooted at a plain name. */
function rootIdentifier(e: ts.Expression | undefined): string | null {
  let cur = unwrap(e)
  while (cur !== undefined && (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))) {
    cur = unwrap(cur.expression)
  }
  return cur !== undefined && ts.isIdentifier(cur) ? cur.text : null
}

// Follows `const A = B.map(...)` / `const B = [ ... ]` chains, which is how most tables here are built. Bounded because a self-referential or mutually-referential pair would otherwise loop, and because a chain longer than this is not something a reader can check either.
const MAX_RESOLVE_HOPS = 6

function resolvesToNonEmptyLiteral(table: ts.Expression | undefined, decls: ReadonlyMap<string, ts.Expression>): boolean {
  let cur = unwrap(table)
  for (let hop = 0; hop < MAX_RESOLVE_HOPS; hop++) {
    if (cur === undefined) return false
    if (ts.isArrayLiteralExpression(cur)) return cur.elements.length > 0
    const root = rootIdentifier(cur)
    if (root === null) return false
    const next = unwrap(decls.get(root))
    if (next === undefined || next === cur) return false
    cur = next
  }
  return false
}

function scanSource(source: string, rel: string): EachSite[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decls = new Map<string, ts.Expression>()
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) decls.set(n.name.text, n.initializer)
    n.forEachChild(collect)
  }
  collect(sf)

  const sites: EachSite[] = []
  const visit = (node: ts.Node): void => {
    // `it.each(TABLE)(title, fn)`: the outer call's expression is the `it.each(TABLE)` call, whose own expression is the `it.each` property access.
    if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'each'
    ) {
      const table = node.expression.arguments[0]
      sites.push({
        file: rel,
        table: (table !== undefined ? table.getText(sf) : '<no argument>').replace(/\s+/g, ' '),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        safe: resolvesToNonEmptyLiteral(table, decls),
      })
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return sites
}

const FILES = testFiles(TESTS_ROOT)
  .map((abs) => ({ abs, rel: path.relative(ROOT, abs).split(path.sep).join('/') }))
  .filter((f) => f.rel !== SELF)

const ALL_SITES: EachSite[] = []
for (const f of FILES) ALL_SITES.push(...scanSource(readFileSync(f.abs, 'utf8'), f.rel))
const COMPUTED = ALL_SITES.filter((s) => !s.safe)

// Provenance: HAND-DERIVED. Two minimal TypeScript sources written here from the rule this guard states, not read off the resolver, so they check the resolver rather than agree with it.
const SAFE_SOURCE = `
const BASE = [['a'], ['b']]
const DERIVED = BASE.map((r) => r)
it.each(DERIVED)('case %s', () => {})
`
const COMPUTED_SOURCE = `
const FROM_DISK = readdirSync('somewhere').map((f) => [f])
it.each(FROM_DISK)('case %s', () => {})
`

const key = (s: { file: string; table: string }): string => `${s.file} :: ${s.table}`

describe('a parameterized test block cannot register zero cases and report green', () => {
  it('scanned a real population of files and parameterized blocks, and classifies both ways', () => {
    pinnedPopulation({
      what: 'tests/**/*.test.ts files walked for it.each/test.each/describe.each tables',
      items: FILES.map((f) => f.rel),
      floor: MIN_FILES,
      // Anchors spanning both halves of the tree, so a walk that silently loses the guards subdirectory or the top level is a substitution rather than a pass.
      mustInclude: ['tests/embeddings.test.ts', 'tests/guards/population_pinning_is_enforced.test.ts'],
    })
    expect(ALL_SITES.length).toBeGreaterThanOrEqual(MIN_EACH_SITES)
    // Self-exclusion, and proof the path spelling SELF uses is the one the sweep produces: the two synthetic sources above quote `.each` call shapes that would otherwise be findings against this file's own text.
    expect(testFiles(TESTS_ROOT).map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))).toContain(SELF)
    expect(FILES.map((f) => f.rel)).not.toContain(SELF)
    // The classifier has to be able to answer both ways, or "everything is safe" would be indistinguishable from "the resolver matches nothing".
    expect(ALL_SITES.some((s) => s.safe)).toBe(true)
    expect(COMPUTED.length).toBeGreaterThan(0)
  })

  it('classifies a literal-rooted chain as safe and a disk-rooted one as computed', () => {
    // Follows `DERIVED -> BASE -> [['a'], ['b']]`, which is the two-hop shape most safe tables here use.
    expect(scanSource(SAFE_SOURCE, 'synthetic-safe.ts').map((s) => s.safe)).toEqual([true])
    // Rooted at a call whose result nothing in the file constrains, which is the shape that can silently produce no rows.
    expect(scanSource(COMPUTED_SOURCE, 'synthetic-computed.ts').map((s) => s.safe)).toEqual([false])
  })

  it('leaves no parameterized block whose table this guard cannot prove non-empty outside the recorded exemptions', () => {
    const exemptKeys = new Set(EXEMPT.map(key))
    const unlisted = COMPUTED.filter((s) => !exemptKeys.has(key(s)))
    expect(
      unlisted.map((s) => `${s.file}:${s.line} :: ${s.table}`),
      'This .each table is built rather than written out, so nothing here proves it has a row. If it is empty at run time the block registers zero cases and the file still reports green. Either assert a floor on the source in the same file, or add an EXEMPT entry naming the assertion that would fail first if the source went empty.',
    ).toEqual([])
  })

  it('carries no stale exemption for a table that is gone or is now statically provable', () => {
    const computedKeys = new Set(COMPUTED.map(key))
    const stale = EXEMPT.filter((e) => !computedKeys.has(key(e))).map(key)
    expect(stale, 'A stale exemption is how a list like this turns into decoration: remove the entry once the site is gone or the table became a literal.').toEqual([])
  })

  it('gives every exemption a reason and names a file that exists', () => {
    expect(EXEMPT.length).toBeGreaterThan(0)
    for (const e of EXEMPT) {
      expect(e.reason.length, `${key(e)} needs a reason naming the assertion that covers it`).toBeGreaterThan(60)
      expect(FILES.some((f) => f.rel === e.file), `${e.file} is not a scanned test file`).toBe(true)
    }
  })
})
