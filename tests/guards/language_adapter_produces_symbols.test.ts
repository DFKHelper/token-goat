/**
 * Structural guard on the parser's per-language adapter layer: every registered {@link Language}
 * must actually produce at least one symbol on a real file of its own language, through the real
 * default indexing path (indexFileSync -> writeParseResult -> symbols table), not a mock callback
 * or an isolated unit test of the extractor function alone.
 *
 * This is the specific shape recorded elsewhere in this repo ("a stale name in a matcher list
 * hides behind its siblings"): a list of N adapters where one entry silently stopped producing
 * anything is invisible to a check that only asserts the UNION across all N is non-empty, because
 * the other N-1 keep the union non-zero forever. Each language below is asserted individually.
 *
 * Every fixture is provenance-tagged in its own file: CAPTURE fixtures are real files already
 * tracked in this repo (cited by path below); HAND-DERIVED fixtures under
 * tests/fixtures/language_adapter_symbols/ carry a HAND-DERIVED comment naming that they were
 * written from the language's own syntax, not from this repo's extractor regexes.
 *
 * Grammar availability: nine languages use a tree-sitter grammar that ships as an optional
 * dependency (see package.json optionalDependencies). A guard that silently skips an adapter
 * whose grammar failed to load would pass vacuously in exactly the environment where the feature
 * is broken -- so a missing tree-sitter grammar is NOT a skip here: it fails the run with an
 * explicit message naming which grammar did not load, on the premise that this repo's own dev/CI
 * environment always has them installed (they are also devDependency-equivalent here; see
 * node_modules/tree-sitter-*). If a future environment genuinely cannot carry native grammars,
 * that decision belongs in this file's exemption list, made explicitly and reviewably -- not as
 * a silent fallthrough.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../../src/db.js'
import { querySymbols } from '../../src/index_reader.js'
import { LANGUAGE_SPECS } from '../../src/language_specs.js'
import { detectLanguage, refineLanguageByContent, type Language } from '../../src/parser_types.js'
import { indexFileSync, isTreeSitterAvailable } from '../../src/parser.js'
import { pinnedPopulation } from './population.js'

/** Self-exclusion token so this guard's own source never satisfies a scan of itself. Never appears in real code: /NOSUCH[X]TOKEN/. */
const SELF_EXCLUDE_MARKER = 'NOSUCH[X]TOKEN'
void SELF_EXCLUDE_MARKER

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const HAND_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'language_adapter_symbols')

interface AdapterCase {
  readonly language: Language
  readonly kind: 'tree-sitter' | 'regex' | 'special'
  /** Absolute source path this fixture is read from. */
  readonly source: string
  /** The basename the fixture is copied to before indexing, so detectLanguage sees the real extension/filename it routes on. */
  readonly targetBasename: string
}

const CASES: readonly AdapterCase[] = [
  // --- tree-sitter (grammar ships as an optional dependency) ---
  { language: 'typescript', kind: 'tree-sitter', source: path.join(REPO_ROOT, 'src', 'paths.ts'), targetBasename: 'paths.ts' },
  { language: 'javascript', kind: 'tree-sitter', source: path.join(REPO_ROOT, 'demo', 'demo.js'), targetBasename: 'demo.js' },
  { language: 'python', kind: 'tree-sitter', source: path.join(REPO_ROOT, 'tests', 'fixtures', 'token_savings', 'report.py'), targetBasename: 'report.py' },
  { language: 'go', kind: 'tree-sitter', source: path.join(REPO_ROOT, 'tests', 'fixtures', 'token_savings', 'inventory.go'), targetBasename: 'inventory.go' },
  { language: 'rust', kind: 'tree-sitter', source: path.join(HAND_FIXTURES, 'sample.rs'), targetBasename: 'sample.rs' },
  { language: 'ruby', kind: 'tree-sitter', source: path.join(HAND_FIXTURES, 'sample.rb'), targetBasename: 'sample.rb' },
  { language: 'java', kind: 'tree-sitter', source: path.join(HAND_FIXTURES, 'Sample.java'), targetBasename: 'Sample.java' },
  { language: 'c', kind: 'tree-sitter', source: path.join(HAND_FIXTURES, 'sample.c'), targetBasename: 'sample.c' },
  { language: 'cpp', kind: 'tree-sitter', source: path.join(HAND_FIXTURES, 'sample.cpp'), targetBasename: 'sample.cpp' },

  // --- regex-based extractors ---
  // README.md and not CLAUDE.md: CLAUDE.md is gitignored, so it exists on a developer box and on no
  // CI checkout anywhere. `caseIsLive` then dropped markdown from the population, and the pinned
  // membership check caught it -- on the first CI run the file ever saw. See the tracked-source
  // assertion below, which now refuses any fixture that can go missing the same way.
  { language: 'markdown', kind: 'regex', source: path.join(REPO_ROOT, 'README.md'), targetBasename: 'README.md' },
  { language: 'json', kind: 'regex', source: path.join(REPO_ROOT, 'package.json'), targetBasename: 'package.json' },
  { language: 'yaml', kind: 'regex', source: path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), targetBasename: 'ci.yml' },
  { language: 'toml', kind: 'regex', source: path.join(REPO_ROOT, '.gitleaks.toml'), targetBasename: 'gitleaks.toml' },
  { language: 'css', kind: 'regex', source: path.join(REPO_ROOT, 'assets', 'css', 'style.css'), targetBasename: 'style.css' },
  { language: 'dockerfile', kind: 'regex', source: path.join(HAND_FIXTURES, 'Dockerfile.sample'), targetBasename: 'Dockerfile' },
  { language: 'csharp', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.cs'), targetBasename: 'Sample.cs' },
  { language: 'php', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.php'), targetBasename: 'sample.php' },
  { language: 'html', kind: 'regex', source: path.join(REPO_ROOT, 'demo', 'index.html'), targetBasename: 'index.html' },
  { language: 'liquid', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.liquid'), targetBasename: 'sample.liquid' },
  { language: 'kotlin', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.kt'), targetBasename: 'Sample.kt' },
  { language: 'swift', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.swift'), targetBasename: 'Sample.swift' },
  { language: 'scala', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.scala'), targetBasename: 'Sample.scala' },
  { language: 'lua', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.lua'), targetBasename: 'sample.lua' },
  { language: 'elixir', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.ex'), targetBasename: 'sample.ex' },
  { language: 'dart', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.dart'), targetBasename: 'sample.dart' },
  { language: 'zig', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.zig'), targetBasename: 'sample.zig' },
  { language: 'r', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.r'), targetBasename: 'sample.r' },
  { language: 'graphql', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.graphql'), targetBasename: 'sample.graphql' },
  { language: 'sql', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.sql'), targetBasename: 'sample.sql' },
  { language: 'ini', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.ini'), targetBasename: 'sample.ini' },
  { language: 'makefile', kind: 'regex', source: path.join(HAND_FIXTURES, 'Makefile.sample'), targetBasename: 'Makefile' },
  { language: 'proto', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.proto'), targetBasename: 'sample.proto' },
  { language: 'terraform', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.tf'), targetBasename: 'sample.tf' },
  { language: 'powershell', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.ps1'), targetBasename: 'sample.ps1' },
  { language: 'vb', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.vb'), targetBasename: 'Sample.vb' },
  { language: 'cobol', kind: 'special', source: path.join(HAND_FIXTURES, 'Sample.cbl'), targetBasename: 'Sample.cbl' },
  { language: 'natural', kind: 'special', source: path.join(HAND_FIXTURES, 'Sample.nsp'), targetBasename: 'Sample.nsp' },
  { language: 'abap', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.abap'), targetBasename: 'Sample.abap' },
  { language: 'sas', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.sas'), targetBasename: 'Sample.sas' },
  { language: 'pli', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.pli'), targetBasename: 'Sample.pli' },
  { language: 'rpg', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.rpgle'), targetBasename: 'Sample.rpgle' },
  { language: 'jcl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.jcl'), targetBasename: 'Sample.jcl' },
  { language: 'objc', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.m'), targetBasename: 'Sample.m' },
  { language: 'groovy', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.groovy'), targetBasename: 'Sample.groovy' },
  { language: 'perl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.pm'), targetBasename: 'Sample.pm' },
  { language: 'solidity', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.sol'), targetBasename: 'Sample.sol' },
  { language: 'thrift', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.thrift'), targetBasename: 'Sample.thrift' },
  { language: 'glsl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.frag'), targetBasename: 'Sample.frag' },
  { language: 'hlsl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.hlsl'), targetBasename: 'Sample.hlsl' },
  { language: 'wgsl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.wgsl'), targetBasename: 'Sample.wgsl' },
  { language: 'metal', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.metal'), targetBasename: 'Sample.metal' },
  { language: 'fortran', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.f90'), targetBasename: 'Sample.f90' },
  { language: 'pascal', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.pas'), targetBasename: 'Sample.pas' },
  // A `.m` is MATLAB only by content, so this case is live only while the fixture has a `function` header line and no Objective-C marker.
  { language: 'matlab', kind: 'regex', source: path.join(HAND_FIXTURES, 'matlab_isolate_axes.m'), targetBasename: 'isolate_axes.m' },
  // CMake is found by the CMakeLists.txt basename here, not the `.cmake` extension.
  { language: 'cmake', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.cmake'), targetBasename: 'CMakeLists.txt' },
  // One `asm` adapter covers three dialects; the HLASM fixture is routed by content, not by a separate extension.
  { language: 'asm', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.s'), targetBasename: 'Sample.s' },
  { language: 'batch', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.bat'), targetBasename: 'Sample.bat' },
  { language: 'erlang', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.erl'), targetBasename: 'Sample.erl' },
  { language: 'vhdl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.vhd'), targetBasename: 'Sample.vhd' },
  { language: 'jinja2', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.j2'), targetBasename: 'Sample.j2' },
  { language: 'handlebars', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.hbs'), targetBasename: 'Sample.hbs' },
  { language: 'erb', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.erb'), targetBasename: 'Sample.erb' },
  { language: 'ejs', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.ejs'), targetBasename: 'Sample.ejs' },
  { language: 'nunjucks', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.njk'), targetBasename: 'Sample.njk' },
  { language: 'twig', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.twig'), targetBasename: 'Sample.twig' },
  // A `.p` is ABL only by content, so this case is live only while the fixture's head still carries an ABL marker.
  { language: 'abl', kind: 'regex', source: path.join(HAND_FIXTURES, 'Sample.p'), targetBasename: 'Sample.p' },
  { language: 'common_lisp', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.lisp'), targetBasename: 'sample.lisp' },
  { language: 'scheme', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.scm'), targetBasename: 'sample.scm' },
  { language: 'racket', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.rkt'), targetBasename: 'sample.rkt' },
  { language: 'clojure', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.clj'), targetBasename: 'sample.clj' },
  { language: 'emacs_lisp', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.el'), targetBasename: 'sample.el' },
  { language: 'haskell', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.hs'), targetBasename: 'sample.hs' },
  { language: 'ocaml', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.ml'), targetBasename: 'sample.ml' },
  { language: 'fsharp', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.fs'), targetBasename: 'sample.fs' },
  { language: 'nix', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.nix'), targetBasename: 'sample.nix' },
  {
    language: 'apex',
    kind: 'regex',
    source: path.join(REPO_ROOT, 'tests', 'fixtures', 'salesforce-dx', 'force-app', 'main', 'default', 'classes', 'SafeNavigationService.cls'),
    targetBasename: 'SafeNavigationService.cls',
  },
  {
    language: 'salesforce_metadata',
    kind: 'regex',
    source: path.join(
      REPO_ROOT,
      'tests',
      'fixtures',
      'salesforce-dx',
      'force-app',
      'main',
      'default',
      'classes',
      'SafeNavigationService.cls-meta.xml',
    ),
    targetBasename: 'SafeNavigationService.cls-meta.xml',
  },
  { language: 'env_file', kind: 'regex', source: path.join(HAND_FIXTURES, 'sample.env.sample'), targetBasename: '.env' },
  { language: 'bash', kind: 'regex', source: path.join(REPO_ROOT, '.lefthook-scripts', 'run-all-checks.sh'), targetBasename: 'run-all-checks.sh' },

  // --- special-cased dispatch (own ParseContentResult shape, symbols + refs) ---
  { language: 'salesforce_markup', kind: 'special', source: path.join(HAND_FIXTURES, 'sample.cmp'), targetBasename: 'sample.cmp' },
  { language: 'vue', kind: 'special', source: path.join(HAND_FIXTURES, 'Sample.vue'), targetBasename: 'Sample.vue' },
  { language: 'svelte', kind: 'special', source: path.join(HAND_FIXTURES, 'Sample.svelte'), targetBasename: 'Sample.svelte' },
  { language: 'astro', kind: 'special', source: path.join(HAND_FIXTURES, 'Sample.astro'), targetBasename: 'Sample.astro' },
  { language: 'ipynb', kind: 'special', source: path.join(HAND_FIXTURES, 'sample.ipynb'), targetBasename: 'sample.ipynb' },
]

/** True when `c.source` exists on disk and `detectLanguage(c.targetBasename)` still resolves to `c.language` -- the symmetric stale-key check: a case naming a language the dispatcher no longer routes to that extension/filename, or a fixture that vanished, cannot silently keep passing. */
function caseIsLive(c: AdapterCase): boolean {
  if (!fs.existsSync(c.source)) return false
  // Refined by content exactly as indexFileSync does, so an extension shared by two languages (`.cls`, `.p`) routes as it will in the index.
  return refineLanguageByContent(c.targetBasename, detectLanguage(c.targetBasename), fs.readFileSync(c.source, 'utf8')) === c.language
}

describe('every registered language adapter produces symbols on a real file, through the real indexFileSync path', () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    closeAllDbs()
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
    tmpDirs = []
  })

  it('has a real, present population of adapter cases, not an empty or stale list', () => {
    const live = CASES.filter(caseIsLive).map((c) => c.language)
    pinnedPopulation({
      what: 'registered language adapters with a real-file fixture exercised through indexFileSync',
      items: live,
      floor: 40,
      mustInclude: ['typescript', 'javascript', 'python', 'markdown', 'json'],
    })

    // Every fixture source must be a TRACKED file. An untracked one is present on the machine that
    // wrote the case and absent everywhere else, which silently shrinks the population rather than
    // failing: markdown pointed at the gitignored CLAUDE.md and was live locally, dead on every CI
    // runner. `git ls-files` is asked once for the whole set, and its answer is checked to be
    // non-empty so a git failure cannot read as "all tracked".
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--', ...CASES.map((c) => path.relative(REPO_ROOT, c.source))], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 24 })
        .split('\0')
        .filter((s) => s !== '')
        .map((s) => path.resolve(REPO_ROOT, s)),
    )
    expect(tracked.size, 'git ls-files returned nothing, so this check would certify every source as untracked-but-unnoticed').toBeGreaterThan(0)
    expect(
      CASES.filter((c) => !tracked.has(path.resolve(c.source))).map((c) => `${c.language} -> ${path.relative(REPO_ROOT, c.source)}`),
      'fixture sources that are not tracked by git: they exist on the machine that added them and on no fresh checkout',
    ).toEqual([])

    // Every row of the language table needs a case here, of the matching extraction kind.
    const kindOf = { 'tree-sitter': 'tree-sitter', regex: 'regex', 'own-result': 'special' } as const
    const missing = LANGUAGE_SPECS.filter((s) => !CASES.some((c) => c.language === s.id && c.kind === kindOf[s.extraction])).map((s) => `${s.id} (${s.extraction})`)
    expect(missing, 'language table rows with no CASES entry of the matching kind').toEqual([])

    const stale = CASES.filter((c) => !caseIsLive(c)).map((c) => c.language)
    expect(
      stale,
      `a CASES entry names a fixture that vanished, or a targetBasename detectLanguage no longer routes to the declared language:\n  ${stale.join('\n  ')}`,
    ).toEqual([])
  })

  it.each(CASES)('$language ($kind) produces at least one symbol on a real file of its language', (c) => {
    if (!caseIsLive(c)) return // reported as stale by the sibling test above

    if (c.kind === 'tree-sitter') {
      const available = isTreeSitterAvailable(c.language)
      expect(
        available,
        `tree-sitter grammar for '${c.language}' did not load in this environment (see package.json optionalDependencies) -- ` +
          'this guard treats that as a failure rather than a silent skip, since a skip here would pass vacuously in exactly ' +
          'the broken-grammar environment this check exists to catch.',
      ).toBe(true)
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-lang-adapter-${c.language}-`))
    tmpDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'index.db')
    const file = path.join(tmpDir, c.targetBasename)
    fs.writeFileSync(file, fs.readFileSync(c.source))

    indexFileSync(file, dbPath)
    const hits = querySymbols({ filePath: file }, dbPath)

    expect(
      hits.length,
      `'${c.language}' adapter produced 0 symbols on a real file (${path.relative(REPO_ROOT, c.source)}) through the real indexFileSync path.`,
    ).toBeGreaterThan(0)
  })
})
