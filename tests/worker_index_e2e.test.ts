/**
 * End-to-end smoke test against the BUILT bundle (dist/token-goat.mjs).
 *
 * The indexer regression in worker.test.ts runs against the TypeScript source.
 * That can never catch a parser that gets tree-shaken out of the esbuild
 * bundle — which is exactly what happened when nothing reachable called the
 * real indexer: `parseFile` and every language extractor vanished from the
 * shipped artifact. This test builds the real bundle, runs `index` over a tiny
 * git fixture with an isolated data dir, then runs `symbol` and asserts a known
 * symbol resolves from the shipped binary.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { loadConfig } from '../src/config.js'
import type * as ConfigModule from '../src/config.js'

import { BUNDLE } from './helpers/bundle.js'

// Partial mock that defaults to calling through to the REAL loadConfig (so the spawned-bundle
// tests and the prune test above see identical behavior to before this mock existed -- they
// never read blocked_roots either way). Only the new blocked_roots test below overrides the
// return value, and restores the pass-through afterward via vi.importActual (see its own
// describe block) rather than a module-level variable, since vi.mock's factory is hoisted
// above all top-level code in this file and a captured variable would still be in its
// temporal dead zone when the hoisted factory closure first runs.
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>()
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) }
})

let repo: string
let dataBase: string

/** Redirect the data dir into a temp base so the e2e never touches the real index. */
function tgEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dataBase,
    USERPROFILE: dataBase,
    LOCALAPPDATA: dataBase,
    XDG_DATA_HOME: dataBase,
  }
}

function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    env: tgEnv(),
    encoding: 'utf8',
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

beforeAll(() => {
  dataBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-data-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-repo-'))
  fs.writeFileSync(
    path.join(repo, 'sample.ts'),
    'export function knownBundleSymbol(): number {\n  return 7\n}\n',
  )
  // A nested file so relative ("src/mod.ts") and backslash ("src\\mod.ts") inputs are meaningfully distinct from the stored absolute key.
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function alphaSym(): number {\n  return 1\n}\nexport function betaSym(): number {\n  return 2\n}\n',
  )
  // A file whose exported symbol is called within the same file, so the refs index has a resolvable caller for the `refs --callers` smoke test.
  fs.writeFileSync(
    path.join(repo, 'caller.ts'),
    'export function refHelper(): number {\n  return 1\n}\n' +
      'export function refDriver(): number {\n  return refHelper() + refHelper()\n}\n',
  )
  // Two classes each defining a `compress` method, plus one uniquely-named method. The bare
  // `read ambig.ts::compress` ambiguity regression and the qualified `AlphaLinter.compress`
  // disambiguation both run against the REAL indexed DB and the shipped resolver here, not a
  // mocked querySymbols seam (the injected-seam trap CLAUDE.md warns against).
  fs.writeFileSync(
    path.join(repo, 'ambig.ts'),
    [
      'export class AlphaLinter {',
      '  compress(text: string): string {',
      "    return 'alpha:' + text",
      '  }',
      '  alphaOnly(): number {',
      '    return 1',
      '  }',
      '}',
      'export class BetaLinter {',
      '  compress(text: string): string {',
      "    return 'beta:' + text",
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  // A `macro_rules!` definition, so a Rust extractor addition that only ever gets exercised
  // against source (never the tree-shaken bundle) is caught here (regression: the same class
  // of bug that dropped mod_item/foreign_mod_item/macro_definition from RUST_KIND_BY_TYPE could
  // just as easily be a bundling gap instead of a missing map entry).
  fs.writeFileSync(
    path.join(repo, 'macro_fixture.rs'),
    ['#[macro_export]', 'macro_rules! bundleMacroSymbol {', '    () => {};', '}', ''].join('\n'),
  )
  // A top-level `static` and a `union` — same tree-shaking concern as the macro fixture above: a
  // static_item/union_item extractor addition proven only against source (never the built bundle)
  // could still be a bundling gap. These resolve from the shipped binary in the e2e test below.
  fs.writeFileSync(
    path.join(repo, 'static_union_fixture.rs'),
    ['static BUNDLE_STATIC_SYMBOL: u32 = 42;', 'union BundleUnionSymbol { a: u32, b: f32 }', ''].join(
      '\n',
    ),
  )
  // A C `union` — same tree-shaking concern: the union_specifier -> 'union' entry added to
  // CPP_KIND_BY_TYPE (shared by the c and cpp grammars) must resolve from the shipped binary too.
  fs.writeFileSync(
    path.join(repo, 'union_fixture.c'),
    ['union BundleCUnionSymbol {', '  int i;', '  float f;', '};', ''].join('\n'),
  )
  // An anonymous-tag C `typedef` — same tree-shaking concern: the type_definition -> 'type' entry
  // added to CPP_KIND_BY_TYPE plus its declarator-chain name helper must resolve from the shipped
  // binary. The alias lives only on the declarator (the struct itself is anonymous), so a bundling
  // gap would leave it invisible just as a missing map entry would.
  fs.writeFileSync(
    path.join(repo, 'typedef_fixture.c'),
    ['typedef struct {', '  int x;', '  int y;', '} BundleCTypedefSymbol;', ''].join('\n'),
  )
  // A C++ `namespace` — same tree-shaking concern: the namespace_definition -> 'namespace' entry
  // added to CPP_KIND_BY_TYPE must resolve from the shipped binary too.
  fs.writeFileSync(
    path.join(repo, 'namespace_fixture.cpp'),
    ['namespace BundleNamespaceSymbol {', '  void inner() {}', '}', ''].join('\n'),
  )
  // A Go `interface` with declared methods — same tree-shaking concern: the method_elem -> 'method'
  // entry added to GO_KIND_BY_TYPE must resolve from the shipped binary too, not just from source.
  fs.writeFileSync(
    path.join(repo, 'iface_fixture.go'),
    [
      'package main',
      '',
      'type BundleGoInterface interface {',
      '\tBundleGoInterfaceMethod() error',
      '}',
      '',
    ].join('\n'),
  )
  // A TS `interface` with a method/property signature — same tree-shaking concern: the
  // method_signature/property_signature -> 'method'/'var' entries added to TSJS_KIND_BY_TYPE must
  // resolve from the shipped binary too, not just from source.
  fs.writeFileSync(
    path.join(repo, 'iface_fixture.ts'),
    [
      'interface BundleTsInterface {',
      '  bundleTsInterfaceMethod(): void',
      '  bundleTsInterfaceProp: number',
      '}',
      '',
    ].join('\n'),
  )
  // A Java `@interface` with an annotation type element — same tree-shaking concern: the
  // annotation_type_element_declaration -> 'method' entry added to JAVA_KIND_BY_TYPE must
  // resolve from the shipped binary too, not just from source.
  fs.writeFileSync(
    path.join(repo, 'anno_fixture.java'),
    ['@interface BundleJavaAnno {', '  String bundleJavaAnnoElement() default "";', '}', ''].join('\n'),
  )
  // A PEP 695 (Python 3.12) `type` alias statement — same tree-shaking concern: the
  // type_alias_statement -> 'type' entry added to PY_KIND_BY_TYPE plus its custom
  // left-field name helper (the node carries no `name` field) must resolve from the shipped
  // binary too, not just from source.
  fs.writeFileSync(
    path.join(repo, 'pep695_fixture.py'),
    ['type BundlePyTypeAlias = list[int]', ''].join('\n'),
  )
  // A Rust trait associated type (`type Item;`, the Iterator::Item / Deref::Target pattern) — same
  // tree-shaking concern: the associated_type -> 'type' entry added to RUST_KIND_BY_TYPE must
  // resolve from the shipped binary too, not just from source.
  fs.writeFileSync(
    path.join(repo, 'assoc_type_fixture.rs'),
    ['trait BundleAssocTypeTrait {', '    type BundleAssocTypeItem;', '}', ''].join('\n'),
  )
  // A bare `Gemfile` (no extension, plain Ruby syntax) — same has-extractor-but-no-dispatch-entry
  // concern as the .mk fixture below: the FILENAME_LANGUAGE 'gemfile' -> 'ruby' entry must resolve
  // from the shipped binary too, not just from source, or a bundling regression could silently
  // re-break every real project's dependency manifest.
  fs.writeFileSync(
    path.join(repo, 'Gemfile'),
    ['def bundle_gemfile_symbol', '  1', 'end', ''].join('\n'),
  )
  // A bare `Vagrantfile` (no extension, plain Ruby syntax -- `Vagrant.configure(...) do ... end`
  // is ordinary Ruby) -- same has-extractor-but-no-dispatch-entry gap as Gemfile/Rakefile above.
  // Without a FILENAME_LANGUAGE 'vagrantfile' -> 'ruby' entry it fell through to 'unknown' and
  // indexed zero symbols despite the ruby tree-sitter grammar handling its content exactly like
  // any other .rb file.
  fs.writeFileSync(
    path.join(repo, 'Vagrantfile'),
    ['def bundle_vagrantfile_symbol', '  1', 'end', ''].join('\n'),
  )
  // A bare `Brewfile` (no extension, plain Ruby DSL -- Homebrew Bundle's `brew "wget"` / `cask
  // "..."` / `tap "..."` calls are ordinary Ruby method calls) -- same has-extractor-but-no-
  // dispatch-entry gap as Gemfile/Vagrantfile above. Without a FILENAME_LANGUAGE 'brewfile' ->
  // 'ruby' entry it fell through to 'unknown' and indexed zero symbols despite the ruby
  // tree-sitter grammar handling its content exactly like any other .rb file.
  fs.writeFileSync(
    path.join(repo, 'Brewfile'),
    ['def bundle_brewfile_symbol', '  1', 'end', ''].join('\n'),
  )
  // `git ls-files` lists staged files, so init + add is enough — no commit (avoids user config and any global commit hooks firing in the test).
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git(['init'])
  git(['add', '.'])
}, 120000)

afterAll(() => {
  if (dataBase) fs.rmSync(dataBase, { recursive: true, force: true })
  if (repo) fs.rmSync(repo, { recursive: true, force: true })
})

describe('built bundle end-to-end indexing', () => {
  it('builds a bundle that actually contains the indexer', () => {
    const bundle = fs.readFileSync(BUNDLE, 'utf8')
    // The real indexer's write path must survive bundling; the old stub must not. The SQL is built as `DELETE FROM symbols WHERE ${pathEqClause('file_path')}`, so assert the static prefix that survives the interpolation — it vanishes if deleteFileRows is ever stubbed out.
    expect(bundle).toContain('DELETE FROM symbols WHERE ')
    expect(bundle).not.toContain('would index')
    // The call-site ref walker must also survive tree-shaking.
    expect(bundle).toContain('CALL_TYPES_BY_LANG')
  })

  it('index then symbol resolves a known symbol from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)
    expect(idx.stdout).toMatch(/Indexed \d+ files/)

    const sym = runBundle(['symbol', 'knownBundleSymbol'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('knownBundleSymbol')
  }, 60000)

  it('index then symbol resolves a Rust macro_rules! definition from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const sym = runBundle(['symbol', 'bundleMacroSymbol'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('bundleMacroSymbol')
    expect(sym.stdout).toContain('macro_fixture.rs')
  }, 60000)

  it('index then symbol resolves Rust static and union definitions from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const stat = runBundle(['symbol', 'BUNDLE_STATIC_SYMBOL'])
    expect(stat.status).toBe(0)
    expect(stat.stdout).toContain('BUNDLE_STATIC_SYMBOL')
    expect(stat.stdout).toContain('static_union_fixture.rs')

    const uni = runBundle(['symbol', 'BundleUnionSymbol'])
    expect(uni.status).toBe(0)
    expect(uni.stdout).toContain('BundleUnionSymbol')
    expect(uni.stdout).toContain('static_union_fixture.rs')
  }, 60000)

  it('index then symbol resolves a Rust trait associated type from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const sym = runBundle(['symbol', 'BundleAssocTypeItem'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('BundleAssocTypeItem')
    expect(sym.stdout).toContain('assoc_type_fixture.rs')
  }, 60000)

  it('index then symbol resolves a C union definition from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const uni = runBundle(['symbol', 'BundleCUnionSymbol'])
    expect(uni.status).toBe(0)
    expect(uni.stdout).toContain('BundleCUnionSymbol')
    expect(uni.stdout).toContain('union_fixture.c')
  }, 60000)

  it('index then symbol resolves an anonymous-tag C typedef alias from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const td = runBundle(['symbol', 'BundleCTypedefSymbol'])
    expect(td.status).toBe(0)
    expect(td.stdout).toContain('BundleCTypedefSymbol')
    expect(td.stdout).toContain('typedef_fixture.c')
  }, 60000)

  it('index then symbol resolves a C++ namespace definition from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const ns = runBundle(['symbol', 'BundleNamespaceSymbol'])
    expect(ns.status).toBe(0)
    expect(ns.stdout).toContain('BundleNamespaceSymbol')
    expect(ns.stdout).toContain('namespace_fixture.cpp')
  }, 60000)

  it('index then symbol resolves a Go interface method signature from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const iface = runBundle(['symbol', 'BundleGoInterface'])
    expect(iface.status).toBe(0)
    expect(iface.stdout).toContain('BundleGoInterface')
    expect(iface.stdout).toContain('iface_fixture.go')

    const meth = runBundle(['symbol', 'BundleGoInterfaceMethod'])
    expect(meth.status).toBe(0)
    expect(meth.stdout).toContain('BundleGoInterfaceMethod')
    expect(meth.stdout).toContain('iface_fixture.go')
  }, 60000)

  it('index then symbol resolves TS interface method/property signatures from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const meth = runBundle(['symbol', 'bundleTsInterfaceMethod'])
    expect(meth.status).toBe(0)
    expect(meth.stdout).toContain('bundleTsInterfaceMethod')
    expect(meth.stdout).toContain('iface_fixture.ts')

    const prop = runBundle(['symbol', 'bundleTsInterfaceProp'])
    expect(prop.status).toBe(0)
    expect(prop.stdout).toContain('bundleTsInterfaceProp')
    expect(prop.stdout).toContain('iface_fixture.ts')
  }, 60000)

  it('index then symbol resolves a Java annotation type element from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const anno = runBundle(['symbol', 'BundleJavaAnno'])
    expect(anno.status).toBe(0)
    expect(anno.stdout).toContain('BundleJavaAnno')
    expect(anno.stdout).toContain('anno_fixture.java')

    const elem = runBundle(['symbol', 'bundleJavaAnnoElement'])
    expect(elem.status).toBe(0)
    expect(elem.stdout).toContain('bundleJavaAnnoElement')
    expect(elem.stdout).toContain('anno_fixture.java')
  }, 60000)

  it('index then symbol resolves a PEP 695 Python type alias from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const alias = runBundle(['symbol', 'BundlePyTypeAlias'])
    expect(alias.status).toBe(0)
    expect(alias.stdout).toContain('BundlePyTypeAlias')
    expect(alias.stdout).toContain('pep695_fixture.py')
  }, 60000)

  it('index then symbol resolves a bare Gemfile method definition from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const sym = runBundle(['symbol', 'bundle_gemfile_symbol'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('bundle_gemfile_symbol')
    expect(sym.stdout).toContain('Gemfile')
  }, 60000)

  it('index then symbol resolves a bare Vagrantfile method definition from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const sym = runBundle(['symbol', 'bundle_vagrantfile_symbol'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('bundle_vagrantfile_symbol')
    expect(sym.stdout).toContain('Vagrantfile')
  }, 60000)

  it('index then symbol resolves a bare Brewfile method definition from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const sym = runBundle(['symbol', 'bundle_brewfile_symbol'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('bundle_brewfile_symbol')
    expect(sym.stdout).toContain('Brewfile')
  }, 60000)

  // Ref extraction must survive bundling too: a build that tree-shakes the ref walker out would leave the refs table empty and this would return exit 1.
  it('refs --callers resolves a caller from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const refs = runBundle(['refs', 'caller.ts::refHelper', '--callers'])
    expect(refs.status).toBe(0)
    expect(refs.stdout).toContain('refDriver')
    expect(refs.stdout).toContain('caller.ts')
  }, 60000)
})

/**
 * Regression for the silent same-file ambiguity bug: `read file::name` used to return
 * candidates[0] (whichever ORDER BY placed first) with no warning when several classes in one
 * file each defined a method of that name. These run the SHIPPED bundle against a real indexed
 * fixture (ambig.ts, two classes each with `compress`), so they exercise the production
 * resolver path end-to-end, not an injected querySymbols mock.
 */
describe('built bundle rejects ambiguous file::symbol lookups (regression)', () => {
  beforeAll(() => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)
  }, 60000)

  it('errors, listing every candidate, when a bare name matches multiple classes', () => {
    const res = runBundle(['read', 'ambig.ts::compress'])
    const out = res.stdout + res.stderr
    // Must NOT silently return one body: exit 1, and the message names both parents + lines.
    expect(res.status).toBe(1)
    expect(out).toMatch(/Ambiguous symbol 'compress'/)
    expect(out).toContain('AlphaLinter.compress')
    expect(out).toContain('BetaLinter.compress')
    // The two bodies must never leak -- an ambiguity error is a candidate list, not a body dump.
    expect(out).not.toContain("return 'alpha:'")
    expect(out).not.toContain("return 'beta:'")
    // It must show the exact qualified retry syntax the user should re-type.
    expect(out).toMatch(/token-goat read "ambig\.ts::\w+\.compress"/)
  }, 30000)

  it('resolves the qualified Parent.method form to that exact class body', () => {
    const alpha = runBundle(['read', 'ambig.ts::AlphaLinter.compress'])
    expect(alpha.status).toBe(0)
    expect(alpha.stdout).toContain("return 'alpha:' + text")
    expect(alpha.stdout).not.toContain("return 'beta:'")

    const beta = runBundle(['read', 'ambig.ts::BetaLinter.compress'])
    expect(beta.status).toBe(0)
    expect(beta.stdout).toContain("return 'beta:' + text")
    expect(beta.stdout).not.toContain("return 'alpha:'")
  }, 30000)

  it('still resolves an unambiguous single-match name with zero behavior change', () => {
    const res = runBundle(['read', 'ambig.ts::alphaOnly'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaOnly(): number')
    expect(res.stdout).not.toMatch(/Ambiguous/)
  }, 30000)
})

describe('built bundle non-git walk-index (--walk)', () => {
  it('indexes a non-git folder and resolves a symbol, excluding .env', () => {
    const walkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-walk-'))
    try {
      fs.writeFileSync(
        path.join(walkDir, 'thing.ts'),
        'export function walkE2ESymbol(): number {\n  return 9\n}\n',
      )
      fs.writeFileSync(path.join(walkDir, '.env'), 'WALK_E2E_SECRET=nope\n')

      // Without --walk a non-git folder still errors, now pointing at the flag.
      const noFlag = runBundle(['index', walkDir])
      expect(noFlag.status).toBe(1)
      expect(noFlag.stderr).toMatch(/--walk/)

      // With --walk the walker indexes thing.ts (1 file); .env is excluded.
      const idx = runBundle(['index', '--walk', walkDir])
      expect(idx.status).toBe(0)
      expect(idx.stdout).toMatch(/Indexed 1 files/)

      const sym = runBundle(['symbol', 'walkE2ESymbol'])
      expect(sym.status).toBe(0)
      expect(sym.stdout).toContain('walkE2ESymbol')

      // The .env key must never have entered the index: a miss exits 1 with the "No matches" notice on stderr (and nothing on stdout).
      const secret = runBundle(['symbol', 'WALK_E2E_SECRET'])
      expect(secret.status).toBe(1)
      expect(secret.stderr).toMatch(/No matches/i)
    } finally {
      fs.rmSync(walkDir, { recursive: true, force: true })
    }
  }, 60000)
})

describe('built bundle resolves relative reader paths (regression for path keying)', () => {
  // The index is keyed by the absolute normalized path; before the resolver was wired in, skeleton/outline used exact equality against the user-typed relative path and silently returned "not indexed". These run the SHIPPED binary from the repo root with a relative path and a Windows backslash path.
  beforeAll(() => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)
  }, 60000)

  it('skeleton resolves a relative path to indexed symbols', () => {
    const res = runBundle(['skeleton', 'src/mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
    expect(res.stdout).toContain('betaSym')
  }, 30000)

  it('outline resolves a relative path to indexed symbols', () => {
    const res = runBundle(['outline', 'src/mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
  }, 30000)

  it('read resolves a relative file::symbol spec', () => {
    const res = runBundle(['read', 'src/mod.ts::alphaSym'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
  }, 30000)

  it('skeleton resolves a Windows-style backslash path', () => {
    const res = runBundle(['skeleton', 'src\\mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
  }, 30000)
})

/**
 * Regression for the relative-root index keying bug. `token-goat index .` (a
 * relative root) used to store relative file_path keys, while every reader
 * resolves to the absolute-normalized key — so a relative-root index was
 * unqueryable. This runs the SHIPPED bundle from inside the repo with `.` as the
 * root, then (a) inspects the DB to prove the stored key is absolute-normalized,
 * and (b) proves a reader query resolves non-empty. Both fail on pre-fix code.
 */
describe('built bundle keys a relative-root index on the absolute path', () => {
  let relRepo: string
  let relData: string

  function relEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: relData,
      USERPROFILE: relData,
      LOCALAPPDATA: relData,
      XDG_DATA_HOME: relData,
    }
  }

  function runRel(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: relRepo,
      env: relEnv(),
      encoding: 'utf8',
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  // Mirror constants.ts::defaultDataDir so the test can open the same global DB the bundle
  // wrote to under the redirected data dir. darwin now also honors an XDG_DATA_HOME override
  // (already set to `base` by relEnv() above) before falling back to the Library/Application
  // Support path -- matching defaultDataDir()'s darwin branch fix.
  function globalDbFor(base: string): string {
    if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat', 'global.db')
    return path.join(base, 'token-goat', 'global.db')
  }

  beforeAll(() => {
    relData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-relroot-data-'))
    relRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-relroot-repo-'))
    fs.mkdirSync(path.join(relRepo, 'src'))
    fs.writeFileSync(
      path.join(relRepo, 'src', 'mod.ts'),
      'export function relRootSym(): number {\n  return 9\n}\n',
    )
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: relRepo, stdio: 'ignore' })
    }
    git(['init'])
    git(['add', '.'])

    const idx = runRel(['index', '.'])
    expect(idx.status).toBe(0)
    expect(idx.stdout).toMatch(/Indexed \d+ files/)
  }, 60000)

  afterAll(() => {
    if (relData) fs.rmSync(relData, { recursive: true, force: true })
    if (relRepo) fs.rmSync(relRepo, { recursive: true, force: true })
  })

  it(
    'stores the symbol file_path as the absolute-normalized key',
    () => {
      const dbPath = globalDbFor(relData)
      expect(fs.existsSync(dbPath)).toBe(true)
      const db = new Database(dbPath, { readonly: true })
      try {
        const rows = db
          .prepare('SELECT DISTINCT file_path FROM symbols')
          .all() as Array<{ file_path: string }>
        expect(rows.length).toBe(1)
        const expectedKey = normalizePath(path.resolve(relRepo, 'src', 'mod.ts'))
        const keys = rows.map((r) => r.file_path)
        // The pre-fix bug stored the relative 'src/mod.ts'; the fix stores the absolute-normalized key that every reader resolves to.
        expect(keys).toContain(expectedKey)
        expect(keys).not.toContain('src/mod.ts')
      } finally {
        db.close()
      }
    },
    30000,
  )

  it('resolves a relative reader query against the relative-root index', () => {
    const res = runRel(['skeleton', 'src/mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('relRootSym')
  }, 30000)
})

/**
 * Smoke the newly-registered commands against the shipped bundle. exports,
 * imports, find, and web-output were implemented (or partly implemented) but not
 * reachable; these prove they run from dist and return the expected output.
 */
describe('built bundle exposes exports / imports / find / web-output', () => {
  let cmdRepo: string
  let cmdData: string

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: cmdRepo,
      env: {
        ...process.env,
        HOME: cmdData,
        USERPROFILE: cmdData,
        LOCALAPPDATA: cmdData,
        XDG_DATA_HOME: cmdData,
      },
      encoding: 'utf8',
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  beforeAll(() => {
    cmdData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmd-data-'))
    cmdRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmd-repo-'))
    fs.writeFileSync(
      path.join(cmdRepo, 'mod.ts'),
      "import { helper } from './helper'\n" +
        "import defaultThing from 'pkg'\n" +
        'export function exportedFn(): number {\n  return helper()\n}\n' +
        'export class ExportedClass {}\n' +
        'function privateFn(): number {\n  return defaultThing\n}\n',
    )
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: cmdRepo, stdio: 'ignore' })
    }
    git(['init'])
    git(['add', '.'])
    const idx = run(['index', '.'])
    expect(idx.status).toBe(0)
  }, 60000)

  afterAll(() => {
    if (cmdData) fs.rmSync(cmdData, { recursive: true, force: true })
    if (cmdRepo) fs.rmSync(cmdRepo, { recursive: true, force: true })
  })

  it('exports lists exported symbols whose stored body omits the export keyword', () => {
    const res = run(['exports', 'mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('exportedFn')
    expect(res.stdout).toContain('ExportedClass')
    expect(res.stdout).not.toContain('privateFn')
  }, 30000)

  it('imports lists the modules a file imports', () => {
    const res = run(['imports', 'mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('./helper')
    expect(res.stdout).toContain('pkg')
  }, 30000)

  it('find resolves a symbol name to its file', () => {
    const res = run(['find', 'exportedFn'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('mod.ts')
  }, 30000)

  it('web-output exits 1 with a clear message for an unknown id', () => {
    const res = run(['web-output', 'no-such-id'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('no cached web output')
  }, 30000)
})

describe('cmdIndex prunes deleted files (shipping path)', () => {
  // cmdIndex is async (it awaits the per-file embeddings step alongside the syntactic parse),
  // so this test must await it too - a bare call returns before the walk/prune loop finishes.
  it('removes a deleted file\'s symbols on re-index via --walk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-prune-'))
    const dbPath = path.join(dir, 'idx.db')
    fs.writeFileSync(path.join(dir, 'keep.ts'), 'export const keepSym = 1\n')
    const goneFile = path.join(dir, 'gone.ts')
    fs.writeFileSync(goneFile, 'export const goneSym = 2\n')
    await cmdIndex(dir, { walk: true, dbPath })
    const db = getDb(dbPath)
    const count = (sym: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE name = ?').get(sym) as { n: number }).n
    expect(count('goneSym')).toBe(1)
    fs.rmSync(goneFile)
    await cmdIndex(dir, { walk: true, dbPath })
    expect(count('goneSym')).toBe(0)
    expect(count('keepSym')).toBe(1)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })
})

describe('cmdIndex honors worker.blocked_roots (shipping path)', () => {
  afterEach(async () => {
    // Restore pass-through so this override never leaks into another test file/run order.
    const actual = await vi.importActual<typeof ConfigModule>('../src/config.js')
    vi.mocked(loadConfig).mockImplementation(actual.loadConfig)
  })

  // Regression: worker.blocked_roots (set via `token-goat project exclude`) was validated from
  // TOML and reported by `token-goat ignores`/`doctor`, but cmdIndex never consulted it -- a
  // file under a blocked root was indexed exactly like any other file.
  it('skips files under a blocked root during --walk indexing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-blocked-'))
    const dbPath = path.join(dir, 'idx.db')
    fs.writeFileSync(path.join(dir, 'keep.ts'), 'export const keepSym = 1\n')
    const blockedDir = path.join(dir, 'vendor')
    fs.mkdirSync(blockedDir, { recursive: true })
    fs.writeFileSync(path.join(blockedDir, 'lib.ts'), 'export const blockedSym = 2\n')

    const real = loadConfig()
    vi.mocked(loadConfig).mockReturnValue({
      ...real,
      worker: { ...real.worker, blocked_roots: [blockedDir] },
    })

    await cmdIndex(dir, { walk: true, dbPath })

    const db = getDb(dbPath)
    const count = (sym: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE name = ?').get(sym) as { n: number }).n
    expect(count('keepSym')).toBe(1)
    expect(count('blockedSym')).toBe(0)

    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if database file is still locked
    }
  })
})
