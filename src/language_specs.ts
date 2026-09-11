/**
 * The one table of languages token-goat indexes. Every per-language list elsewhere is derived
 * from it: the extension and basename maps detectLanguage reads (parser_types.ts), the read,
 * grep and bash hook gates, the pack fence names, and the display labels. The {@link Language}
 * union itself is derived from the `id` column, so a new row that has no extractor in
 * languages/registry.ts's ADAPTER_EXTRACTORS fails the type check rather than indexing nothing.
 *
 * Adding a language is one row here plus its extractor: see CLAUDE.arch.md "Adding a New Language".
 *
 * Leaf module: no imports, so parser_types.ts and every hook can depend on it without a cycle.
 */

/** Column meanings, one row per language. */
interface LanguageSpecShape {
  readonly id: string
  /** How symbols are extracted: a tree-sitter grammar, a regex adapter in languages/registry.ts's ADAPTER_EXTRACTORS, or a branch in parser.ts's extractNoTreeSitter that returns symbols and refs together. */
  readonly extraction: 'tree-sitter' | 'regex' | 'own-result'
  /** Lowercase extensions with the leading dot. */
  readonly extensions: readonly string[]
  /** Basenames compared case-insensitively. */
  readonly basenames?: readonly string[]
  /** Basenames compared exactly, for names too common in lowercase to claim (`BUILD`). */
  readonly exactBasenames?: readonly string[]
  /** Display spelling for a message a person reads; the id when absent. */
  readonly label?: string
  /** `symbol`/`read "file::Symbol"` resolve named definitions, so the bash hook upgrades a line-range read to a symbol read. */
  readonly symbolBearing: boolean
  /** skeleton/outline are the intended re-read tool: the read hook's count-based deny and post-read structure hint. */
  readonly sourceHints: boolean
  /** A single-file Grep for a `def`/`class`/`function` pattern gets the skeleton hint. */
  readonly grepSource: boolean
  /** Eligible for diff-on-reread when `hints.serve_diff_on_reread` is on. */
  readonly diffable: boolean
  /** Code-fence language `token-goat pack` writes; no fence when absent. */
  readonly fence?: string
  /** Per-extension fence overrides (`.tsx` fences as `tsx`, not `typescript`). */
  readonly fenceByExtension?: Readonly<Record<string, string>>
  /** The extension `imports` parses a basename-matched file as (a bare `Makefile` reads as `.mk`). */
  readonly basenameImportsExtension?: string
  /** For a language whose refs are recorded but which `dead` skips: why an empty `refs` answer is still not evidence of an unused name. */
  readonly partialRefsReason?: string
}

// Program-language defaults: every hint on.
const CODE = { symbolBearing: true, sourceHints: true, grepSource: true, diffable: true } as const
// Data and markup defaults: every hint off.
const DATA = { symbolBearing: false, sourceHints: false, grepSource: false, diffable: false } as const

export const LANGUAGE_SPECS = [
  { id: 'typescript', extraction: 'tree-sitter', extensions: ['.ts', '.tsx', '.mts', '.cts'], ...CODE, fence: 'typescript', fenceByExtension: { '.tsx': 'tsx' } },
  { id: 'javascript', extraction: 'tree-sitter', extensions: ['.js', '.jsx', '.mjs', '.cjs'], ...CODE, fence: 'javascript', fenceByExtension: { '.jsx': 'jsx' } },
  // Bazel and Starlark (`.bzl`, `.star`, BUILD/WORKSPACE/MODULE.bazel) are a Python dialect: `def` and top-level calls such as `load(...)` parse with the Python grammar (https://github.com/bazelbuild/starlark/blob/master/spec.md).
  { id: 'python', extraction: 'tree-sitter', extensions: ['.py', '.pyi', '.bzl', '.star'], basenames: ['build.bazel', 'workspace.bazel', 'module.bazel'], exactBasenames: ['BUILD', 'WORKSPACE'], ...CODE, fence: 'python' },
  { id: 'go', extraction: 'tree-sitter', extensions: ['.go'], ...CODE, fence: 'go' },
  { id: 'rust', extraction: 'tree-sitter', extensions: ['.rs'], ...CODE, fence: 'rust' },
  // Rake task files, Gemfile, Rakefile and the other extensionless Ruby DSL files are plain Ruby syntax.
  { id: 'ruby', extraction: 'tree-sitter', extensions: ['.rb', '.ruby', '.rake'], basenames: ['gemfile', 'rakefile', 'vagrantfile', 'guardfile', 'podfile', 'capfile', 'fastfile', 'brewfile'], ...CODE, fence: 'ruby' },
  { id: 'java', extraction: 'tree-sitter', extensions: ['.java'], ...CODE, fence: 'java' },
  // `.h` is C unless it declares an Objective-C `@interface` or `@protocol` (refineLanguageByContent); a C++ header parses with the C grammar.
  { id: 'c', extraction: 'tree-sitter', extensions: ['.c', '.h'], label: 'C', ...CODE, fence: 'c' },
  { id: 'cpp', extraction: 'tree-sitter', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'], label: 'C++', ...CODE, fence: 'cpp' },
  // zsh, ksh and bats scripts share the POSIX `name() {` and `function name {` function forms the bash adapter reads.
  { id: 'bash', extraction: 'regex', extensions: ['.sh', '.bash', '.zsh', '.ksh', '.bats'], ...DATA, symbolBearing: true, fence: 'bash' },
  // MDX headings are plain ATX; `.rst` needs an underline heading parser this adapter lacks, so it stays unmapped.
  { id: 'markdown', extraction: 'regex', extensions: ['.md', '.markdown', '.mdx'], ...DATA, fence: 'markdown' },
  { id: 'toml', extraction: 'regex', extensions: ['.toml'], basenames: ['cargo.toml', 'pyproject.toml'], label: 'TOML', ...DATA, diffable: true, fence: 'toml' },
  // JSON with comments (`.jsonc`) and Avro schemas (`.avsc`) read with the JSON adapter, which skips `//` and `/* */` comments.
  { id: 'json', extraction: 'regex', extensions: ['.json', '.jsonc', '.avsc'], basenames: ['package.json', 'tsconfig.json'], label: 'JSON', ...DATA, diffable: true, fence: 'json' },
  { id: 'yaml', extraction: 'regex', extensions: ['.yaml', '.yml'], label: 'YAML', ...DATA, diffable: true, fence: 'yaml' },
  { id: 'css', extraction: 'regex', extensions: ['.css', '.scss', '.sass', '.less'], label: 'CSS', ...DATA, grepSource: true, diffable: true, fence: 'css', fenceByExtension: { '.scss': 'scss', '.sass': 'sass', '.less': 'less' } },
  { id: 'dockerfile', extraction: 'regex', extensions: [], basenames: ['dockerfile'], ...DATA, fence: 'dockerfile' },
  { id: 'csharp', extraction: 'regex', extensions: ['.cs'], label: 'C#', ...CODE, fence: 'csharp' },
  { id: 'php', extraction: 'regex', extensions: ['.php'], label: 'PHP', ...CODE, fence: 'php' },
  { id: 'html', extraction: 'regex', extensions: ['.html', '.htm'], label: 'HTML', ...DATA, fence: 'html' },
  { id: 'liquid', extraction: 'regex', extensions: ['.liquid'], ...DATA, fence: 'liquid' },
  { id: 'kotlin', extraction: 'regex', extensions: ['.kt', '.kts'], ...CODE, fence: 'kotlin' },
  { id: 'swift', extraction: 'regex', extensions: ['.swift'], ...CODE, fence: 'swift' },
  { id: 'scala', extraction: 'regex', extensions: ['.scala', '.sc'], ...CODE, fence: 'scala' },
  { id: 'lua', extraction: 'regex', extensions: ['.lua'], ...CODE, fence: 'lua' },
  { id: 'elixir', extraction: 'regex', extensions: ['.ex', '.exs'], ...CODE, fence: 'elixir' },
  { id: 'dart', extraction: 'regex', extensions: ['.dart'], ...CODE, fence: 'dart' },
  { id: 'zig', extraction: 'regex', extensions: ['.zig'], ...CODE, fence: 'zig' },
  { id: 'r', extraction: 'regex', extensions: ['.r'], ...CODE, fence: 'r' },
  { id: 'graphql', extraction: 'regex', extensions: ['.graphql', '.gql'], label: 'GraphQL', ...DATA, symbolBearing: true, fence: 'graphql' },
  // Oracle PL/SQL sources: package spec and body, standalone procedure/function, trigger, and object type spec and body.
  { id: 'sql', extraction: 'regex', extensions: ['.sql', '.pks', '.pkb', '.pls', '.plsql', '.pck', '.prc', '.fnc', '.trg', '.tps', '.tpb'], label: 'SQL', ...DATA, symbolBearing: true, diffable: true, fence: 'sql' },
  { id: 'ini', extraction: 'regex', extensions: ['.ini', '.cfg', '.conf'], label: 'INI', ...DATA, fence: 'ini' },
  // `.mk` fragments (config.mk, rules.mk) share a bare Makefile's syntax.
  { id: 'makefile', extraction: 'regex', extensions: ['.mk'], basenames: ['makefile', 'gnumakefile', 'bsdmakefile'], ...DATA, fence: 'makefile', basenameImportsExtension: '.mk' },
  { id: 'proto', extraction: 'regex', extensions: ['.proto'], label: 'Protocol Buffers', ...DATA, symbolBearing: true, fence: 'protobuf' },
  { id: 'terraform', extraction: 'regex', extensions: ['.tf', '.tfvars', '.hcl'], ...DATA, symbolBearing: true, fence: 'hcl' },
  // `.env` and `.env.<suffix>` are matched by parser_types.ts's DOTENV_VARIANT_RE before this table.
  { id: 'env_file', extraction: 'regex', extensions: ['.env'], basenames: ['.envrc'], label: 'env file', ...DATA },
  { id: 'powershell', extraction: 'regex', extensions: ['.ps1', '.psm1'], label: 'PowerShell', ...CODE, fence: 'powershell' },
  // VB.NET, VB6/VBA standard modules, VBScript and VB6 forms. A VB6 class module shares `.cls` with Apex and is told apart by content in refineLanguageByContent.
  { id: 'vb', extraction: 'regex', extensions: ['.vb', '.bas', '.vbs', '.frm'], label: 'Visual Basic', ...CODE, fence: 'vb', fenceByExtension: { '.vb': 'vbnet', '.vbs': 'vbscript' } },
  {
    id: 'cobol', extraction: 'own-result', extensions: ['.cbl', '.cob', '.cobol', '.cpy'], label: 'COBOL', ...CODE, fence: 'cobol',
    partialRefsReason: "PERFORM, GO TO and CALL 'literal' are recorded as references, but a paragraph also runs by falling through from the one above it and a program can be called through a data item holding its name, so `dead` skips COBOL",
  },
  // Natural object sources as NaturalONE and SYSOBJH export them. Maps (.nsm) and DDMs (.nsd) are layouts, not code, and stay unmapped.
  {
    id: 'natural', extraction: 'own-result', extensions: ['.nsp', '.nsn', '.nss', '.nsa', '.nsl', '.nsg', '.nsc', '.nsh'], label: 'Natural', ...CODE, fence: 'natural',
    partialRefsReason: "PERFORM, CALLNAT 'literal' and FETCH 'literal' are recorded as references, but an object can also be called through a variable holding its name, so `dead` skips Natural",
  },
  { id: 'abap', extraction: 'regex', extensions: ['.abap'], label: 'ABAP', ...CODE, fence: 'abap' },
  { id: 'sas', extraction: 'regex', extensions: ['.sas'], label: 'SAS', ...CODE, fence: 'sas' },
  { id: 'pli', extraction: 'regex', extensions: ['.pli', '.pl1'], label: 'PL/I', ...CODE, fence: 'pli' },
  // `.rpg` stays unmapped: RPG II and RPG III sources use it, and their fixed layout predates the ILE RPG forms this adapter reads.
  { id: 'rpg', extraction: 'regex', extensions: ['.rpgle', '.sqlrpgle'], label: 'RPG', ...CODE, fence: 'rpgle' },
  { id: 'jcl', extraction: 'regex', extensions: ['.jcl'], label: 'JCL', ...CODE, fence: 'jcl' },
  // `.mm` is always Objective-C++. A `.m` (MATLAB uses it too) is Objective-C only on an `#import`, `@interface`, `@implementation` or `@protocol` line, and a `.h` only on `@interface` or `@protocol`: refineLanguageByContent in parser_types.ts decides.
  { id: 'objc', extraction: 'regex', extensions: ['.mm'], label: 'Objective-C', ...CODE, fence: 'objectivec' },
  // Gradle build scripts and Jenkinsfiles are Groovy.
  { id: 'groovy', extraction: 'regex', extensions: ['.groovy', '.gvy', '.gradle'], basenames: ['jenkinsfile'], label: 'Groovy', ...CODE, fence: 'groovy', basenameImportsExtension: '.groovy' },
  // A Prolog `.pl` stays unknown (refineLanguageByContent), and a `.t` is Perl only on a Perl marker line.
  { id: 'perl', extraction: 'regex', extensions: ['.pl', '.pm'], label: 'Perl', ...CODE, fence: 'perl' },
  { id: 'solidity', extraction: 'regex', extensions: ['.sol'], label: 'Solidity', ...CODE, fence: 'solidity' },
  { id: 'thrift', extraction: 'regex', extensions: ['.thrift'], label: 'Thrift', ...DATA, symbolBearing: true, fence: 'thrift' },
  { id: 'glsl', extraction: 'regex', extensions: ['.glsl', '.vert', '.frag', '.comp', '.geom', '.tesc', '.tese'], label: 'GLSL', ...CODE, fence: 'glsl' },
  // `.fx` stays unmapped: other languages use it too.
  { id: 'hlsl', extraction: 'regex', extensions: ['.hlsl', '.hlsli'], label: 'HLSL', ...CODE, fence: 'hlsl' },
  { id: 'wgsl', extraction: 'regex', extensions: ['.wgsl'], label: 'WGSL', ...CODE, fence: 'wgsl' },
  { id: 'metal', extraction: 'regex', extensions: ['.metal'], label: 'Metal', ...CODE, fence: 'metal' },
  // `.f`, `.for` and `.f77` are read as fixed form unless code starts in column 1. `.fpp` stays unmapped: it is used for both forms.
  { id: 'fortran', extraction: 'regex', extensions: ['.f', '.for', '.f77', '.f90', '.f95', '.f03', '.f08'], label: 'Fortran', ...CODE, fence: 'fortran' },
  // `.inc` stays unmapped (many languages use it), and a `.pp` (Puppet uses it too) is Pascal only on a unit, program or library header: refineLanguageByContent in parser_types.ts decides. Text-form `.dfm` forms list their components.
  { id: 'pascal', extraction: 'regex', extensions: ['.pas', '.dpr', '.dpk', '.lpr', '.dfm'], label: 'Pascal', ...CODE, fence: 'pascal' },
  // MATLAB has no extension of its own: a `.m` that is not Objective-C is MATLAB only on a `function` or `classdef` header line, which refineLanguageByContent in parser_types.ts checks, so a Mathematica or Mercury `.m` stays unknown.
  { id: 'matlab', extraction: 'regex', extensions: [], label: 'MATLAB', ...CODE, fence: 'matlab' },
  { id: 'cmake', extraction: 'regex', extensions: ['.cmake'], basenames: ['cmakelists.txt'], label: 'CMake', ...CODE, fence: 'cmake', basenameImportsExtension: '.cmake' },
  // OpenEdge ABL has no extension of its own: a `.p` or `.w` (Pascal and CWEB use them too) or a `.cls` (Apex, VB6) is ABL only when its head carries an ABL marker, which refineLanguageByContent in parser_types.ts checks. The path-only hooks see a `.p` or `.w` as unknown and a `.cls` as Apex.
  { id: 'abl', extraction: 'regex', extensions: [], label: 'OpenEdge ABL', ...CODE, fence: 'abl' },
  { id: 'apex', extraction: 'regex', extensions: ['.cls', '.trigger'], label: 'Apex', ...CODE, fence: 'apex' },
  // Matched by the `-meta.xml` suffix in detectLanguage, not by an extension.
  { id: 'salesforce_metadata', extraction: 'regex', extensions: [], label: 'Salesforce metadata', ...DATA, symbolBearing: true, sourceHints: true, grepSource: true, fence: 'xml' },
  { id: 'salesforce_markup', extraction: 'own-result', extensions: ['.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.tokens', '.page', '.component', '.email'], label: 'Salesforce markup', ...DATA, symbolBearing: true, sourceHints: true, grepSource: true, fence: 'xml' },
  { id: 'vue', extraction: 'own-result', extensions: ['.vue'], ...DATA, fence: 'vue' },
  { id: 'svelte', extraction: 'own-result', extensions: ['.svelte'], ...DATA, fence: 'svelte' },
  { id: 'astro', extraction: 'own-result', extensions: ['.astro'], ...DATA, fence: 'astro' },
  // Notebooks index through their code cells as Python, in parser.ts's ipynb branch.
  { id: 'ipynb', extraction: 'own-result', extensions: ['.ipynb'], label: 'Jupyter notebook', ...DATA, fence: 'json' },
] as const satisfies readonly LanguageSpecShape[]

type Spec = (typeof LANGUAGE_SPECS)[number]

/** Languages token-goat can recognise. `unknown` is the catch-all fallback. */
export type Language = Spec['id'] | 'unknown'

/** Languages indexed through a tree-sitter grammar. */
export type TreeSitterLanguage = Extract<Spec, { extraction: 'tree-sitter' }>['id']

/** Languages whose regex adapter must have an entry in languages/registry.ts's ADAPTER_EXTRACTORS (or, for the structured-document formats, in parser.ts's own half of that table). */
export type RegexLanguage = Extract<Spec, { extraction: 'regex' }>['id']

/** Languages parser.ts's extractNoTreeSitter handles in a branch of their own. */
export type OwnResultLanguage = Extract<Spec, { extraction: 'own-result' }>['id']

/** The per-path boolean columns a hook can ask about. */
export type LanguageFlag = 'symbolBearing' | 'sourceHints' | 'grepSource' | 'diffable'

const SPEC_BY_ID: ReadonlyMap<string, LanguageSpecShape> = new Map(LANGUAGE_SPECS.map((s) => [s.id, s]))

function rows(): readonly LanguageSpecShape[] {
  return LANGUAGE_SPECS
}

/** Lowercase extension (with the dot) to language. */
export const EXTENSION_LANGUAGE: ReadonlyMap<string, Language> = new Map(
  LANGUAGE_SPECS.flatMap((s) => s.extensions.map((e): [string, Language] => [e, s.id])),
)

/** Lowercase basename to language. */
export const FILENAME_LANGUAGE: ReadonlyMap<string, Language> = new Map(
  rows().flatMap((s) => (s.basenames ?? []).map((b): [string, Language] => [b, s.id as Language])),
)

/** Exact-case basename to language. */
export const EXACT_FILENAME_LANGUAGE: ReadonlyMap<string, Language> = new Map(
  rows().flatMap((s) => (s.exactBasenames ?? []).map((b): [string, Language] => [b, s.id as Language])),
)

/** The languages indexed through a tree-sitter grammar when the optional `tree-sitter` package loads; without it they fall back to a coarse regex scan with no references. */
export const TREE_SITTER_LANGUAGES: readonly Language[] = LANGUAGE_SPECS.filter((s) => s.extraction === 'tree-sitter').map((s) => s.id)

/** True when `language`'s row sets `flag`. `unknown` has no row and every flag off. */
export function languageHasFlag(language: Language, flag: LanguageFlag): boolean {
  return SPEC_BY_ID.get(language)?.[flag] === true
}

/** Human spelling of a language id, for a message a person reads. */
export function languageLabel(language: Language): string {
  if (language === 'unknown') return 'this file type'
  return SPEC_BY_ID.get(language)?.label ?? language
}

/** The pack code-fence name for a file of `language` with lowercase extension `ext`, or `''` for none. */
export function fenceFor(language: Language, ext: string): string {
  const spec = SPEC_BY_ID.get(language)
  if (spec === undefined) return ''
  return spec.fenceByExtension?.[ext] ?? spec.fence ?? ''
}

/** The extension `imports` parses a basename-matched file of `language` as, or undefined. */
export function basenameImportsExtension(language: Language): string | undefined {
  return SPEC_BY_ID.get(language)?.basenameImportsExtension
}

/** Why an empty refs answer is not evidence of dead code in a language whose refs are recorded but which `dead` skips; undefined for every other language. */
export function partialRefsReason(language: Language): string | undefined {
  return SPEC_BY_ID.get(language)?.partialRefsReason
}
