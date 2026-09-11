/**
 * The language table (src/language_specs.ts) replaced six hand-kept per-site lists. This pins each
 * derived list against the list it replaced, so the refactor is proven identical everywhere except
 * the differences named below, each one on purpose.
 *
 * Provenance: HAND-DERIVED. Every OLD_* literal is copied from the pre-refactor source at commit
 * 896e55f1: src/parser_types.ts EXTENSION_LANGUAGE and FILENAME_LANGUAGE, src/hooks_read.ts
 * DIFFABLE_SOURCE_RE and SOURCE_EXT_RE (plus isSourceExtension's apex/salesforce fallback),
 * src/hooks_grep.ts SOURCE_EXT_RE, src/hooks_bash.ts SYMBOL_BEARING_LANGUAGES, src/pack.ts
 * LANG_MAP, src/ref_blindness.ts LANGUAGE_LABELS. None of it is read from the table under test.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EXACT_FILENAME_LANGUAGE,
  EXTENSION_LANGUAGE,
  FILENAME_LANGUAGE,
  LANGUAGE_SPECS,
  fenceFor,
  languageHasFlag,
  languageLabel,
  type Language,
  type LanguageFlag,
} from '../src/language_specs.js'
import { detectLanguage, nonTreeSitterLanguageCount } from '../src/parser_types.js'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const OLD_EXTENSION_LANGUAGE: Record<string, string> = {
  '.py': 'python', '.pyi': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.rs': 'rust', '.go': 'go',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.rb': 'ruby', '.ruby': 'ruby',
  '.rake': 'ruby', '.java': 'java', '.sh': 'bash', '.bash': 'bash', '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.toml': 'toml', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.cs': 'csharp', '.php': 'php', '.html': 'html', '.htm': 'html', '.liquid': 'liquid', '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift', '.scala': 'scala', '.sc': 'scala', '.lua': 'lua', '.ex': 'elixir', '.exs': 'elixir', '.dart': 'dart', '.zig': 'zig',
  '.r': 'r', '.graphql': 'graphql', '.gql': 'graphql', '.sql': 'sql', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.proto': 'proto',
  '.mk': 'makefile', '.tf': 'terraform', '.tfvars': 'terraform', '.hcl': 'terraform', '.ps1': 'powershell', '.psm1': 'powershell',
  '.env': 'env_file', '.vb': 'vb', '.bas': 'vb', '.vbs': 'vb', '.frm': 'vb', '.cbl': 'cobol', '.cob': 'cobol', '.cobol': 'cobol',
  '.cpy': 'cobol', '.nsp': 'natural', '.nsn': 'natural', '.nss': 'natural', '.nsa': 'natural', '.nsl': 'natural', '.nsg': 'natural',
  '.nsc': 'natural', '.nsh': 'natural', '.cls': 'apex', '.trigger': 'apex', '.cmp': 'salesforce_markup', '.app': 'salesforce_markup',
  '.evt': 'salesforce_markup', '.intf': 'salesforce_markup', '.design': 'salesforce_markup', '.auradoc': 'salesforce_markup',
  '.tokens': 'salesforce_markup', '.page': 'salesforce_markup', '.component': 'salesforce_markup', '.email': 'salesforce_markup',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro', '.ipynb': 'ipynb',
}

const OLD_FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', bsdmakefile: 'makefile', 'cargo.toml': 'toml',
  'pyproject.toml': 'toml', 'package.json': 'json', 'tsconfig.json': 'json', '.envrc': 'env_file', gemfile: 'ruby', rakefile: 'ruby',
  vagrantfile: 'ruby', guardfile: 'ruby', podfile: 'ruby', capfile: 'ruby', fastfile: 'ruby', brewfile: 'ruby',
}

const OLD_DIFFABLE_SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|json|jsonc|py|go|rs|java|rb|php|kt|c|h|cpp|cc|cxx|hpp|cs|sql|yaml|yml|toml|ps1|psm1|cls|trigger|swift|scala|sc|lua|ex|exs|dart|zig|r|R|vb|bas|vbs|frm|cbl|cob|cpy|cobol|nsp|nsn|nss|nsa|nsl|nsg|nsc|nsh)$/i
const OLD_READ_SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|rb|php|kt|kts|cpp|cc|cxx|hpp|hxx|c|h|cs|ps1|psm1|cls|trigger|swift|scala|sc|lua|ex|exs|dart|zig|r|R|vb|bas|vbs|frm|cbl|cob|cpy|cobol|nsp|nsn|nss|nsa|nsl|nsg|nsc|nsh)$/i
const OLD_GREP_SOURCE_EXT_RE = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|vb|bas|vbs|frm|cbl|cob|cpy|cobol|nsp|nsn|nss|nsa|nsl|nsg|nsc|nsh)$/i
// Old isSourceExtension: the regex, or a path-detected apex/salesforce language.
function oldReadSource(ext: string): boolean {
  const lang = OLD_EXTENSION_LANGUAGE[ext]
  return OLD_READ_SOURCE_EXT_RE.test(`x${ext}`) || lang === 'apex' || lang === 'salesforce_metadata' || lang === 'salesforce_markup'
}

const OLD_SYMBOL_BEARING = [
  'python', 'typescript', 'javascript', 'rust', 'go', 'c', 'cpp', 'ruby', 'java', 'csharp', 'php', 'kotlin', 'swift', 'scala', 'lua', 'elixir', 'dart', 'zig', 'r', 'sql', 'graphql', 'proto', 'terraform', 'bash', 'powershell', 'vb', 'cobol', 'natural', 'apex', 'salesforce_metadata', 'salesforce_markup',
]

const OLD_LANG_MAP: Record<string, string> = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.fish': 'fish', '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.json': 'json', '.md': 'markdown', '.html': 'html',
  '.css': 'css', '.scss': 'scss', '.tf': 'hcl', '.kt': 'kotlin', '.swift': 'swift', '.lua': 'lua', '.vb': 'vbnet', '.bas': 'vb', '.frm': 'vb',
  '.cbl': 'cobol', '.cob': 'cobol', '.cpy': 'cobol', '.cobol': 'cobol', '.nsp': 'natural', '.nsn': 'natural', '.nss': 'natural',
  '.nsa': 'natural', '.nsl': 'natural', '.nsg': 'natural', '.nsc': 'natural', '.nsh': 'natural', '.vbs': 'vbscript', '.r': 'r',
  '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
}

const OLD_LABELS: Record<string, string> = {
  csharp: 'C#', cpp: 'C++', c: 'C', php: 'PHP', powershell: 'PowerShell', vb: 'Visual Basic', cobol: 'COBOL', natural: 'Natural',
  sql: 'SQL', graphql: 'GraphQL', proto: 'Protocol Buffers', html: 'HTML', css: 'CSS', toml: 'TOML', json: 'JSON', yaml: 'YAML',
  ini: 'INI', env_file: 'env file', ipynb: 'Jupyter notebook', salesforce_metadata: 'Salesforce metadata',
  salesforce_markup: 'Salesforce markup', unknown: 'this file type',
}

const PLSQL = ['.pks', '.pkb', '.pls', '.plsql', '.pck', '.prc', '.fnc', '.trg', '.tps', '.tpb']
const SF_MARKUP = ['.cmp', '.app', '.evt', '.intf', '.design', '.auradoc', '.tokens', '.page', '.component', '.email']

// Every extension either side knows about, so a dropped extension shows up as a removal.
const ALL_EXTS = [...new Set([
  ...Object.keys(OLD_EXTENSION_LANGUAGE), ...EXTENSION_LANGUAGE.keys(), ...Object.keys(OLD_LANG_MAP), '.jsonc', '.clj', '.fish',
])].sort()

function diff(oldPred: (ext: string) => boolean, flag: LanguageFlag): { added: string[]; removed: string[] } {
  const now = (ext: string): boolean => languageHasFlag(detectLanguage(`x${ext}`), flag)
  return {
    added: ALL_EXTS.filter((e) => now(e) && !oldPred(e)),
    removed: ALL_EXTS.filter((e) => !now(e) && oldPred(e)),
  }
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

describe('language table: derived lists match the pre-refactor lists except the named differences', () => {
  it('extension map: only the new mappings were added, nothing moved or dropped', () => {
    for (const [ext, lang] of Object.entries(OLD_EXTENSION_LANGUAGE)) expect(EXTENSION_LANGUAGE.get(ext), ext).toBe(lang)
    const added = [...EXTENSION_LANGUAGE.keys()].filter((e) => !(e in OLD_EXTENSION_LANGUAGE))
    expect(sorted(added)).toEqual(sorted(['.zsh', '.ksh', '.bats', '.bzl', '.star', ...PLSQL, '.jsonc', '.avsc']))
    for (const e of ['.zsh', '.ksh', '.bats']) expect(detectLanguage(`a${e}`), e).toBe('bash')
    for (const e of ['.bzl', '.star']) expect(detectLanguage(`a${e}`), e).toBe('python')
    for (const e of PLSQL) expect(detectLanguage(`a${e.toUpperCase()}`), e).toBe('sql')
    for (const e of ['.jsonc', '.avsc']) expect(detectLanguage(`a${e}`), e).toBe('json')
  })

  it('basename maps: only the Bazel files were added; BUILD and WORKSPACE match exact case only', () => {
    for (const [base, lang] of Object.entries(OLD_FILENAME_LANGUAGE)) expect(FILENAME_LANGUAGE.get(base), base).toBe(lang)
    expect(sorted([...FILENAME_LANGUAGE.keys()].filter((b) => !(b in OLD_FILENAME_LANGUAGE)))).toEqual(['build.bazel', 'module.bazel', 'workspace.bazel'])
    expect(sorted([...EXACT_FILENAME_LANGUAGE.keys()])).toEqual(['BUILD', 'WORKSPACE'])
    for (const b of ['BUILD', 'pkg/BUILD', 'WORKSPACE', 'BUILD.bazel', 'WORKSPACE.bazel', 'MODULE.bazel', 'Build.Bazel']) expect(detectLanguage(b), b).toBe('python')
    // A lowercase `build` or `workspace` is usually a shell script or a folder, not Bazel.
    for (const b of ['build', 'scripts/build', 'workspace', 'Build']) expect(detectLanguage(b), b).toBe('unknown')
  })

  it('bash hook symbol-bearing set is unchanged', () => {
    const now = LANGUAGE_SPECS.filter((s) => s.symbolBearing).map((s) => s.id)
    expect(sorted(now)).toEqual(sorted(OLD_SYMBOL_BEARING))
  })

  it('read hook source-hint set: adds the other Ruby extensions and Starlark only', () => {
    expect(diff(oldReadSource, 'sourceHints')).toEqual({ added: ['.bzl', '.rake', '.ruby', '.star'], removed: [] })
  })

  it('diff-on-reread set: adds extensions of languages already covered, and the new mappings', () => {
    expect(diff((e) => OLD_DIFFABLE_SOURCE_RE.test(`x${e}`), 'diffable')).toEqual({
      added: sorted(['.avsc', '.bzl', '.cts', '.hxx', '.kts', '.mts', '.pyi', '.rake', '.ruby', '.star', ...PLSQL]),
      removed: [],
    })
  })

  it('grep hook source set: gains the 18 indexed extensions it missed, drops clj (no Clojure adapter)', () => {
    const missed18 = ['.mts', '.cts', '.mjs', '.cjs', '.pyi', '.kts', '.hxx', '.ps1', '.psm1', '.cls', '.trigger', '.sc', '.lua', '.ex', '.exs', '.dart', '.zig', '.r']
    expect(missed18).toHaveLength(18)
    expect(diff((e) => OLD_GREP_SOURCE_EXT_RE.test(`x${e}`), 'grepSource')).toEqual({
      added: sorted([...missed18, '.ruby', '.rake', '.bzl', '.star', ...SF_MARKUP]),
      removed: ['.clj'],
    })
  })

  it('pack fences: every old fence kept except .fish (not indexed); every other indexed extension gains its language fence', () => {
    const now = (ext: string): string => fenceFor(detectLanguage(`x${ext}`), ext)
    const changedOrRemoved = Object.entries(OLD_LANG_MAP).filter(([e, f]) => now(e) !== f).map(([e]) => e)
    expect(changedOrRemoved).toEqual(['.fish'])
    expect(now('.fish')).toBe('')
    const added = [...EXTENSION_LANGUAGE.keys()].filter((e) => !(e in OLD_LANG_MAP) && now(e) !== '')
    expect(sorted(added)).toEqual(sorted([...EXTENSION_LANGUAGE.keys()].filter((e) => !(e in OLD_LANG_MAP) && e !== '.env')))
    expect(fenceFor(detectLanguage('Dockerfile'), '')).toBe('dockerfile')
  })

  it('labels: unchanged except Apex, which used to print as the bare id', () => {
    const ids: Language[] = [...LANGUAGE_SPECS.map((s) => s.id), 'unknown']
    const changed = ids.filter((id) => languageLabel(id) !== (OLD_LABELS[id] ?? id))
    expect(changed).toEqual(['apex'])
    expect(languageLabel('apex')).toBe('Apex')
  })
})

describe('language table: every row reaches an extractor', () => {
  const parserSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'parser.ts'), 'utf8')

  it('each own-result language has its own branch in parser.ts (regex rows are enforced by the NO_TREE_SITTER_EXTRACTORS type)', () => {
    const own = LANGUAGE_SPECS.filter((s) => s.extraction === 'own-result').map((s) => s.id)
    expect(own.length, 'the own-result population must be non-empty').toBeGreaterThanOrEqual(5)
    for (const id of own) expect(parserSrc, `no \`language === '${id}'\` branch in src/parser.ts`).toContain(`language === '${id}'`)
  })

  it('no extension or basename is claimed by two rows', () => {
    const exts = LANGUAGE_SPECS.flatMap((s) => [...s.extensions])
    expect(exts.length).toBe(new Set(exts).size)
    for (const e of exts) expect(e, 'extensions are lowercase with a leading dot').toMatch(/^\.[a-z0-9]+$/)
  })

  it('the doctor count of non-tree-sitter languages matches the architecture doc', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'C4_RUNTIME_ARCHITECTURE.md'), 'utf8')
    const m = /\((\d+) non-tree-sitter languages\)/.exec(doc)
    expect(m, 'docs/C4_RUNTIME_ARCHITECTURE.md must still state the adapter language count').not.toBeNull()
    expect(Number(m?.[1])).toBe(nonTreeSitterLanguageCount())
  })
})
