/** Guard: a test that sets NODE_OPTIONS for a process it starts keeps the value it inherited. tests/setup/isolate-home.ts puts the permission-source filter preload into the run's NODE_OPTIONS, and that filter is what stops src/rewrite_permission.ts from running reg.exe on Windows. A spawn env that sets NODE_OPTIONS to its own preload alone drops the filter: the child reads the machine policy through reg.exe, which on a loaded machine ends as a timeout, and a hook deny turns into a pass (tests/session_persistence_e2e.test.ts did exactly that, and tests/changed_git_spawns.test.ts and tests/semantic_wasm_runtime_bundle_e2e.test.ts had the same shape). What it checks: every site under tests/ that sets NODE_OPTIONS (an object-literal property, shorthand or computed key, or an assignment to `.NODE_OPTIONS` / `['NODE_OPTIONS']`) must derive the value from a read of NODE_OPTIONS, directly or through a variable declared in the same file. A value the scan cannot trace to such a read (a parameter, an import, a literal) counts as a replacement, so an unknown shape fails closed. What it cannot see: the key built by arithmetic or imported from another file, an env assembled by Object.fromEntries or a JSON round trip, a preload written into generated script text, a read that sits only in one branch of a conditional, and two variables of one name in different scopes of one file (the later read is credited to both). Verified with the samples below, which stand for each shape and are HAND-DERIVED. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS = path.resolve(HERE, '..')

const KEY = 'NODE_OPTIONS'
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

interface Site {
  /** Path relative to the repository root, forward slashes. */
  readonly file: string
  readonly line: number
  /** The value being set, whitespace folded. */
  readonly value: string
  /** True when the value is derived from a read of NODE_OPTIONS. */
  readonly keeps: boolean
}

interface Exemption {
  readonly file: string
  /** A fragment of the value text that picks the one site in `file` this entry covers. */
  readonly valueContains: string
  readonly reason: string
}

/** Sites that set NODE_OPTIONS without the inherited value on purpose. Each entry must match exactly one such site, so a stale entry fails too. */
const EXEMPT: readonly Exemption[] = [
  {
    file: 'tests/guards/permission_filter_single_predicate.test.ts',
    valueContains: 'path.join(testsDir',
    reason: 'The row asks what the filter preload does alone in a fresh node process; the inherited NODE_OPTIONS already holds the same --require (isolate-home.ts), so keeping it would load the preload twice and under a root the row overrides.',
  },
  {
    file: 'tests/guards/permission_filter_single_predicate.test.ts',
    valueContains: '--require "${preload}"',
    reason: 'The same single-preload probe as the row above, run once per spelling of the root; the inherited copy of the preload would install it a second time under the TG_TEST_PERMISSION_ROOT the row sets.',
  },
  {
    file: 'tests/permission_source_filter_spelling.test.ts',
    valueContains: 'cjs.replaceAll',
    reason: 'The probe asks the filter preload alone how it spells each source; the inherited NODE_OPTIONS already holds the same --require (isolate-home.ts) and would install it a second time under the root the row overrides.',
  },
  {
    file: 'tests/permission_snapshot_registry_timeout_bundle.test.ts',
    valueContains: 'nodeOptions',
    reason: 'hintFor takes the complete NODE_OPTIONS from its caller, and the first row must run the bundle WITHOUT the permission filter to show the flake the second row closes; the second row passes the filter explicitly.',
  },
]

function constString(expr: ts.Expression | undefined, decls: ReadonlyMap<string, readonly ts.Expression[]>): string | undefined {
  if (expr === undefined) return undefined
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isIdentifier(expr)) {
    const inits = decls.get(expr.text)
    return inits !== undefined && inits.length === 1 ? constString(inits[0], decls) : undefined
  }
  return undefined
}

function propertyKey(name: ts.PropertyName, decls: ReadonlyMap<string, readonly ts.Expression[]>): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return constString(name.expression, decls)
  return undefined
}

const ASSIGNMENT_KEEPS_OLD_VALUE = new Set<ts.SyntaxKind>([ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken])

/** Every site in `source` that sets NODE_OPTIONS, and whether its value comes from a read of it. */
function scanSource(source: string, rel: string): Site[] {
  const kind = ['.ts', '.mts', '.cts'].includes(path.extname(rel)) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind)
  const decls = new Map<string, ts.Expression[]>()
  const destructured = new Set<string>()
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      decls.set(n.name.text, [...(decls.get(n.name.text) ?? []), n.initializer])
    }
    // `const { NODE_OPTIONS } = process.env` and `const { NODE_OPTIONS: inherited } = env` bind a read of it.
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && ts.isObjectBindingPattern(n.parent)) {
      const from = n.propertyName === undefined ? n.name.text : ts.isIdentifier(n.propertyName) || ts.isStringLiteral(n.propertyName) ? n.propertyName.text : undefined
      if (from === KEY) destructured.add(n.name.text)
    }
    n.forEachChild(collect)
  }
  collect(sf)

  const readsKey = (n: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(n)) return n.name.text === KEY
    if (ts.isElementAccessExpression(n)) return constString(n.argumentExpression, decls) === KEY
    return false
  }

  const keeps = (node: ts.Node, seen: Set<string>): boolean => {
    if (readsKey(node)) return true
    if (ts.isIdentifier(node)) {
      if (destructured.has(node.text)) return true
      if (seen.has(node.text)) return false
      seen.add(node.text)
      return (decls.get(node.text) ?? []).some((init) => keeps(init, seen))
    }
    // The member name of `a.b` is a property name, not a variable, so only its object is followed.
    if (ts.isPropertyAccessExpression(node)) return keeps(node.expression, seen)
    return ts.forEachChild(node, (child) => keeps(child, seen) || undefined) ?? false
  }

  const sites: Site[] = []
  const add = (at: ts.Node, value: ts.Node, kept: boolean): void => {
    sites.push({ file: rel, line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1, value: value.getText(sf).replace(/\s+/g, ' '), keeps: kept })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyKey(node.name, decls) === KEY) add(node, node.initializer, keeps(node.initializer, new Set()))
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === KEY) add(node, node.name, keeps(node.name, new Set()))
    if (ts.isBinaryExpression(node) && (readsKey(node.left) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || ASSIGNMENT_KEEPS_OLD_VALUE.has(node.operatorToken.kind)))) {
      add(node, node.right, node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? keeps(node.right, new Set()) : true)
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return sites
}

/** Every script source under tests/, skipping dot-prefixed scratch directories, node_modules and fixtures. */
function testSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'fixtures') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testSources(full, out)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function liveSites(): Site[] {
  const files = pinnedPopulation({
    what: 'script files under tests/',
    items: testSources(TESTS).map((f) => path.relative(TESTS, f).split(path.sep).join('/')),
    floor: 400,
    mustInclude: ['session_persistence_e2e.test.ts', 'setup/isolate-home.ts', 'helpers/sqlite_busy_trace.ts', 'guards/a_spawn_env_never_replaces_node_options.test.ts'],
  })
  return files.flatMap((rel) => scanSource(readFileSync(path.join(TESTS, rel), 'utf8'), `tests/${rel}`))
}

describe('a spawn env that sets NODE_OPTIONS keeps the inherited value', () => {
  it('has no site under tests/ that replaces it, except the exempt ones', () => {
    const replaced = liveSites().filter((s) => !s.keeps && !EXEMPT.some((e) => e.file === s.file && s.value.includes(e.valueContains)))
    expect(
      replaced.map((s) => `${s.file}:${s.line}  NODE_OPTIONS: ${s.value}`),
      'these sites set NODE_OPTIONS without the value the run inherited, which drops the permission-source filter preload that tests/setup/isolate-home.ts installs; build the value from process.env.NODE_OPTIONS (see hookEnv in tests/session_persistence_e2e.test.ts)',
    ).toEqual([])
  })

  it('sees the sites it is meant to see, so an empty scan cannot pass', () => {
    const sites = liveSites()
    const files = new Set(sites.map((s) => s.file))
    expect(sites.length).toBeGreaterThanOrEqual(10)
    for (const known of ['tests/session_persistence_e2e.test.ts', 'tests/changed_git_spawns.test.ts', 'tests/semantic_wasm_runtime_bundle_e2e.test.ts', 'tests/helpers/sqlite_busy_trace.ts', 'tests/setup/isolate-home.ts']) {
      expect(files.has(known), `${known} sets NODE_OPTIONS and the scan did not see it`).toBe(true)
    }
  })

  it('has no exemption that no longer matches a replacing site, and none that matches two', () => {
    const replacing = liveSites().filter((s) => !s.keeps)
    for (const e of EXEMPT) {
      const hits = replacing.filter((s) => s.file === e.file && s.value.includes(e.valueContains))
      expect(hits.length, `${e.file} (${e.valueContains}) matches ${hits.length} replacing sites, expected exactly one`).toBe(1)
      expect(e.reason.length, `${e.file} needs a reason`).toBeGreaterThan(20)
    }
  })

  // HAND-DERIVED: each sample is a few lines written for one shape; no producer output is involved.
  const SAMPLES: readonly (readonly [string, readonly string[], boolean])[] = [
    ['an inline object literal with a template string', ['const e = { ...process.env, NODE_OPTIONS: `--require "${probe}"` }'], true],
    ['a multi-line object literal', ['const env = {', '  ...process.env,', '  TOKEN_GOAT_HOME: home,', '  NODE_OPTIONS: "--jitless",', '  ...extra,', '}'], true],
    ['a quoted key', ['const e = { ...process.env, "NODE_OPTIONS": "--x" }'], true],
    ['a computed key held in a const', ['const KEY = "NODE_OPTIONS"', 'const e = { ...process.env, [KEY]: "--x" }'], true],
    ['a shorthand property', ['const NODE_OPTIONS = "--x"', 'const e = { ...process.env, NODE_OPTIONS }'], true],
    ['a variable holding the value', ['const opts = "--x"', 'const e = { ...process.env, NODE_OPTIONS: opts }'], true],
    ['a parameter holding the value', ['function f(opts: string) { return { ...process.env, NODE_OPTIONS: opts } }'], true],
    ['a dotted assignment on a variable holding the env', ['const env = { ...process.env }', 'env.NODE_OPTIONS = "--x"'], true],
    ['a bracket assignment on a variable holding the env', ['const env = { ...process.env }', 'env["NODE_OPTIONS"] = "--x"'], true],
    ['an Object.assign onto the env', ['Object.assign(env, { NODE_OPTIONS: "--x" })'], true],
    ['a spread of another env, then the override', ['const e = { ...base, ...process.env, NODE_OPTIONS: "" }'], true],
    ['a template that reads an unrelated variable', ['const probe = "p"', 'const e = { NODE_OPTIONS: `--require "${probe}"` }'], true],
    ['a value that reads a different variable of the env', ['const e = { NODE_OPTIONS: process.env.OTHER ?? "" }'], true],
    ['variables that refer to each other', ['const a = b', 'const b = a', 'const e = { NODE_OPTIONS: a }'], true],
    ['an array element that is a read of another key', ['const e = { NODE_OPTIONS: [process.env["PATH"], "--x"].join(" ") }'], true],
    ['an array that appends to the inherited value', ['const e = { ...process.env, NODE_OPTIONS: [process.env["NODE_OPTIONS"], "--x"].filter(Boolean).join(" ") }'], false],
    ['a template that appends to a read of the env', ['const e = { NODE_OPTIONS: `${env["NODE_OPTIONS"] ?? ""} --x` }'], false],
    ['a value built from a variable that holds the read', ['const inherited = process.env["NODE_OPTIONS"]', 'const e = { NODE_OPTIONS: `${inherited ? `${inherited} ` : ""}--x` }'], false],
    ['a dotted read', ['const e = { NODE_OPTIONS: `${process.env.NODE_OPTIONS} --x` }'], false],
    ['a destructured read', ['const { NODE_OPTIONS } = process.env', 'const e = { NODE_OPTIONS: `${NODE_OPTIONS} --x` }'], false],
    ['a shorthand of a destructured read', ['const { NODE_OPTIONS } = process.env', 'const e = { NODE_OPTIONS }'], false],
    ['a renamed destructured read', ['const { NODE_OPTIONS: inherited } = process.env', 'const e = { NODE_OPTIONS: `${inherited} --x` }'], false],
    ['a computed key whose read uses the same key', ['const KEY = "NODE_OPTIONS"', 'const e = { [KEY]: `${process.env[KEY]} --x` }'], false],
    ['a process-level assignment from a read', ['process.env["NODE_OPTIONS"] = [process.env["NODE_OPTIONS"], p].join(" ")'], false],
    ['a compound append', ['env.NODE_OPTIONS += " --x"'], false],
    ['a nullish assignment', ['env["NODE_OPTIONS"] ??= "--x"'], false],
  ]

  it.each(SAMPLES.map(([name, lines, replaced]) => [name, lines.join('\n'), replaced] as const))('classifies a sample: %s', (_name, source, replaced) => {
    const sites = scanSource(source, 'sample.ts')
    expect(sites.length, 'the scan found no NODE_OPTIONS site in the sample').toBeGreaterThan(0)
    expect(sites.some((s) => !s.keeps)).toBe(replaced)
  })

  it('does not take a read, a delete or a string that merely names the variable for a site', () => {
    const source = ['const o = process.env["NODE_OPTIONS"]', 'delete env["NODE_OPTIONS"]', 'const rows = ["NODE_OPTIONS=--require=./x.js npm test"]', 'const t = { not: process.env.NODE_OPTIONS }'].join('\n')
    expect(scanSource(source, 'sample.ts')).toEqual([])
  })

  it('reads a .cjs source as script text', () => {
    expect(scanSource('const e = { NODE_OPTIONS: "--x" }', 'sample.cjs').map((s) => s.keeps)).toEqual([false])
  })
})
