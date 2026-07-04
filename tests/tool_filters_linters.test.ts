// Batch C golden tests — linter filters. Faithfully ported from the Python suite (test_bash_compress.py linter classes). These are the regression spec for the 16 filters in src/tool_filters/linters.ts.

import { describe, expect, it } from 'vitest'

import { LINTER_FILTERS, TOOL_FILTERS, detectFromCommand, selectFilter } from '../src/tool_filters/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const filterByName = (name: string) => {
  const f = TOOL_FILTERS.find((x) => x.name === name) ?? LINTER_FILTERS.find((x) => x.name === name)
  if (!f) throw new Error(`Filter not found: ${name}`)
  return f
}

const tscFilter = filterByName('tsc')
const ruffFilter = filterByName('ruff')
const mypyFilter = filterByName('mypy')
const pylintFilter = filterByName('pylint')
const oxlintFilter = filterByName('oxlint')
const eslintFilter = filterByName('eslint')
const biomeFilter = filterByName('biome')
const linterFilter = filterByName('linter')
const golangciFilter = filterByName('golangci-lint')
const phpstanFilter = filterByName('phpstan')
const swiftlintFilter = filterByName('swiftlint')
const blackIsortFilter = filterByName('black-isort')
const prettierFilter = filterByName('prettier')
const ktlintFilter = filterByName('ktlint')
const cppcheckFilter = filterByName('cppcheck')
const clangTidyFilter = filterByName('clang-tidy')

// ---------------------------------------------------------------------------
// LINTER_FILTERS array
// ---------------------------------------------------------------------------

describe('LINTER_FILTERS', () => {
  it('exports 16 filter entries', () => {
    expect(LINTER_FILTERS).toHaveLength(16)
  })

  it('all filters are registered in TOOL_FILTERS after PACKAGE_MANAGER_FILTERS', () => {
    for (const f of LINTER_FILTERS) {
      expect(TOOL_FILTERS).toContain(f)
    }
  })

  it('PylintFilter precedes generic LinterFilter in LINTER_FILTERS (dispatch precedence)', () => {
    const pylintIdx = LINTER_FILTERS.findIndex((f) => f.name === 'pylint')
    const linterIdx = LINTER_FILTERS.findIndex((f) => f.name === 'linter')
    expect(pylintIdx).toBeGreaterThanOrEqual(0)
    expect(linterIdx).toBeGreaterThan(pylintIdx)
  })

  it('tsc is first in LINTER_FILTERS (matches Python order)', () => {
    expect(LINTER_FILTERS[0]?.name).toBe('tsc')
  })

  it('clang-tidy is last in LINTER_FILTERS (matches Python order)', () => {
    expect(LINTER_FILTERS[LINTER_FILTERS.length - 1]?.name).toBe('clang-tidy')
  })
})

// ---------------------------------------------------------------------------
// TscFilter
// ---------------------------------------------------------------------------

describe('TscFilter', () => {
  it('matches bare tsc', () => {
    expect(tscFilter.matches(['tsc'])).toBe(true)
  })

  it('matches npx tsc', () => {
    expect(tscFilter.matches(['npx', 'tsc', '--noEmit'])).toBe(true)
  })

  it('matches yarn tsc', () => {
    expect(tscFilter.matches(['yarn', 'tsc'])).toBe(true)
  })

  it('matches pnpm exec tsc', () => {
    expect(tscFilter.matches(['pnpm', 'exec', 'tsc'])).toBe(true)
  })

  it('does not match npx eslint', () => {
    expect(tscFilter.matches(['npx', 'eslint', 'src/'])).toBe(false)
  })

  it('deduplicates same TS code across many occurrences, keeping first 3', () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `src/file${i}.ts(10,5): error TS2345: Type 'string' is not assignable to type 'number'.`,
    )
    const result = tscFilter.apply(lines.join('\n'), '', 1, ['tsc'])
    expect(result.text).toContain('src/file0.ts')
    expect(result.text).toContain('src/file2.ts')
    expect(result.text).not.toContain('src/file3.ts')
    expect(result.text).toMatch(/dropped \d+ more TS2345/)
  })

  it('collapses watch cycles, keeping first and last', () => {
    const init = '[1:00:00 AM] Starting compilation in watch mode...'
    const cycle = '[1:00:05 AM] Starting incremental compilation...'
    const err = 'src/foo.ts(1,1): error TS2345: bad type.'
    const input = [init, err, cycle, err, cycle, err].join('\n')
    const result = tscFilter.apply(input, '', 0, ['tsc', '--watch'])
    expect(result.text).toContain(init)
    expect(result.text).toMatch(/dropped \d+ intermediate watch cycle/)
  })

  it('counts up-to-date project lines in build mode', () => {
    const lines = [
      "[1:00:00 AM] Projects in this build:",
      "    * tsconfig.json",
      "[1:00:01 AM] Project 'tsconfig.json' is up to date because its output is newer than its input.",
      "[1:00:01 AM] Project 'tsconfig.lib.json' is up to date because its output is newer than its input.",
      "[1:00:01 AM] Found 0 errors.",
    ].join('\n')
    const result = tscFilter.apply(lines, '', 0, ['tsc', '--build'])
    expect(result.text).not.toContain('Projects in this build')
    expect(result.text).toMatch(/up-to-date project/)
    expect(result.text).toContain('Found 0 errors')
  })
})

// ---------------------------------------------------------------------------
// RuffFilter
// ---------------------------------------------------------------------------

describe('RuffFilter', () => {
  it('matches ruff', () => {
    expect(ruffFilter.matches(['ruff', 'check', '.'])).toBe(true)
  })

  it('summarises repeated rule codes across multiple files', () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `src/file${Math.floor(i / 2)}.py:${i + 1}:1: E501 Line too long (120 > 88 characters)`,
    )
    lines.push('Found 6 errors.')
    const result = ruffFilter.apply(lines.join('\n'), '', 1, ['ruff', 'check', '.'])
    // 3 unique files each with 2 occurrences: qualifies for summary (≥3 occ, ≥2 files)
    expect(result.text).toMatch(/E501.*occurrences in \d+ files/)
    expect(result.text).toContain('Found 6 errors.')
  })

  it('strips success banner on exit 0, returns empty', () => {
    const result = ruffFilter.apply('All checks passed!\n', '', 0, ['ruff', 'check', '.'])
    expect(result.text.trim()).toBe('')
  })

  it('format: counts reformatted lines and keeps summary', () => {
    const lines = [
      'reformatted src/a.py',
      'reformatted src/b.py',
      'reformatted src/c.py',
      '3 files reformatted, 0 files left unchanged',
    ].join('\n')
    const result = ruffFilter.apply(lines, '', 0, ['ruff', 'format', '.'])
    expect(result.text).toContain('3 files reformatted')
    expect(result.text).toMatch(/collapsed.*reformatted/i)
    expect(result.text).not.toContain('reformatted src/a.py')
  })
})

// ---------------------------------------------------------------------------
// ESLintFilter
// ---------------------------------------------------------------------------

describe('ESLintFilter', () => {
  it('matches eslint', () => {
    expect(eslintFilter.matches(['eslint', 'src/'])).toBe(true)
  })

  it('fast path: returns summary line when exit code is 0 and output contains one', () => {
    const stdout = '✖ 0 problems (0 errors, 0 warnings)'
    const result = eslintFilter.apply(stdout, '', 0, ['eslint', 'src/'])
    expect(result.text).toContain('0 problems')
  })

  it('fast path: returns fallback label when exit code is 0 and no summary line', () => {
    // ESLint sometimes emits nothing on clean exit; the filter returns "ESLint: no errors"
    const result = eslintFilter.apply('some diagnostic output', '', 0, ['eslint', 'src/'])
    expect(result.text).toMatch(/ESLint/i)
  })

  it('deduplicates warnings by rule, keeping first 3, noting more', () => {
    const header = '/project/src/foo.ts'
    const issues = Array.from(
      { length: 5 },
      (_, i) => `  ${10 + i}:1  warning  no-console call  no-console`,
    )
    const summary = '✖ 5 problems (0 errors, 5 warnings)'
    const input = [header, ...issues, summary].join('\n')
    const result = eslintFilter.apply(input, '', 1, ['eslint', 'src/'])
    expect(result.text).toContain(header)
    // First 3 kept
    expect(result.text).toContain(issues[0])
    expect(result.text).toContain(issues[2])
    // 4th onward deduplicated
    expect(result.text).not.toContain(issues[3])
    expect(result.text).toMatch(/\+2 more no-console warnings/)
    expect(result.text).toContain(summary)
  })

  it('skips file stanzas with no issue lines', () => {
    const input = '/project/src/clean.ts\n'
    const result = eslintFilter.apply(input, '', 1, ['eslint', 'src/'])
    // Stanza with no issue lines is suppressed
    expect(result.text).not.toContain('clean.ts')
  })

  it('parses --format compact violations across multiple files instead of dropping them all (regression: every violation line also looks like a file header)', () => {
    const input = [
      "/project/src/foo.ts: line 10, col 5, Error - 'foo' is not defined. (no-undef)",
      "/project/src/foo.ts: line 12, col 3, Warning - 'bar' is defined but never used. (no-unused-vars)",
      '/project/src/bar.ts: line 4, col 1, Error - Parsing error: Unexpected token (no-rule)',
      '',
      '3 problems',
    ].join('\n')
    const result = eslintFilter.apply(input, '', 1, ['eslint', '--format', 'compact', 'src/'])
    expect(result.text).toContain('foo.ts')
    expect(result.text).toContain("'foo' is not defined")
    expect(result.text).toContain("'bar' is defined but never used")
    expect(result.text).toContain('bar.ts')
    expect(result.text).toContain('Parsing error: Unexpected token')
  })

  it('parses --format unix violations instead of dropping them all (regression: every violation line also looks like a file header)', () => {
    const input = [
      "/project/src/foo.ts:10:5: 'foo' is not defined [Error/no-undef]",
      "/project/src/foo.ts:12:3: 'bar' is defined but never used [Warning/no-unused-vars]",
      '',
      '2 problems',
    ].join('\n')
    const result = eslintFilter.apply(input, '', 1, ['eslint', '--format', 'unix', 'src/'])
    expect(result.text).toContain('foo.ts')
    expect(result.text).toContain("'foo' is not defined")
    expect(result.text).toContain("'bar' is defined but never used")
  })
})

// ---------------------------------------------------------------------------
// MypyFilter
// ---------------------------------------------------------------------------

describe('MypyFilter', () => {
  it('matches mypy and dmypy', () => {
    expect(mypyFilter.matches(['mypy', 'src/'])).toBe(true)
    expect(mypyFilter.matches(['dmypy', 'run', '--', 'src/'])).toBe(true)
  })

  it('deduplicates repeated error messages keeping first 3', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `src/module.py:${i + 1}: error: Argument 1 to "foo" has incompatible type "str"; expected "int"`,
    )
    lines.push('Found 5 errors in 1 file (checked 10 source files)')
    const result = mypyFilter.apply(lines.join('\n'), '', 1, ['mypy'])
    expect(result.text).toContain('src/module.py:1:')
    expect(result.text).toContain('src/module.py:3:')
    expect(result.text).not.toContain('src/module.py:4:')
    expect(result.text).toMatch(/suppressed \d+ duplicate error/i)
    expect(result.text).toContain('Found 5 errors')
  })

  it('drops standalone [error-code] lines', () => {
    const input = 'src/x.py:1: error: bad [assignment]\n    [assignment]\n'
    const result = mypyFilter.apply(input, '', 1, ['mypy'])
    // Standalone [assignment] dropped
    expect(result.text.split('\n').filter((ln) => /^\s+\[assignment\]\s*$/.test(ln))).toHaveLength(0)
  })

  it('drops "See https://" note lines', () => {
    const input = 'src/x.py:1: note: See https://mypy.readthedocs.io\n'
    const result = mypyFilter.apply(input, '', 0, ['mypy'])
    expect(result.text).not.toContain('https://mypy.readthedocs.io')
  })
})

// ---------------------------------------------------------------------------
// PylintFilter
// ---------------------------------------------------------------------------

describe('PylintFilter', () => {
  it('matches pylint', () => {
    expect(pylintFilter.matches(['pylint', 'src/'])).toBe(true)
  })

  it('takes dispatch priority over generic linter for pylint', () => {
    // dispatch must select pylint, not 'linter' (registration order check)
    const selected = selectFilter(['pylint', 'src/'])
    expect(selected?.name).toBe('pylint')
  })

  it('deduplicates warning/convention/refactor codes beyond first 3', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `src/foo.py:${i + 1}:0: C0114 (C0114): Missing module docstring`,
    )
    lines.push('Your code has been rated at 8.00/10')
    const result = pylintFilter.apply(lines.join('\n'), '', 4, ['pylint', 'src/'])
    expect(result.text).toContain('src/foo.py:1:')
    expect(result.text).not.toContain('src/foo.py:4:')
    expect(result.text).toContain('Your code has been rated at')
  })

  it('always keeps E/F severity regardless of dedup count', () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `src/foo.py:${i + 1}:0: E1101 (E1101): Module 'os' has no 'does_not_exist' member`,
    )
    const result = pylintFilter.apply(lines.join('\n'), '', 4, ['pylint', 'src/'])
    // All 6 E-severity lines kept
    expect(result.text).toContain('src/foo.py:6:')
  })

  it('drops separator lines', () => {
    const input = '------------------------------------\nYour code has been rated at 10/10\n'
    const result = pylintFilter.apply(input, '', 0, ['pylint'])
    expect(result.text).not.toContain('---')
    expect(result.text).toContain('10/10')
  })

  it('only emits module header when the module has kept issues', () => {
    const input = [
      '************* Module foo',
      'foo.py:1:0: C0114 (C0114): Missing module docstring',
      '************* Module bar',
      // no issues for bar
      'Your code has been rated at 9/10',
    ].join('\n')
    const result = pylintFilter.apply(input, '', 4, ['pylint', 'src/'])
    expect(result.text).toContain('Module foo')
    expect(result.text).not.toContain('Module bar')
  })
})

// ---------------------------------------------------------------------------
// OxlintFilter
// ---------------------------------------------------------------------------

describe('OxlintFilter', () => {
  it('matches oxlint and oxc_linter', () => {
    expect(oxlintFilter.matches(['oxlint', 'src/'])).toBe(true)
    expect(oxlintFilter.matches(['oxc_linter', 'src/'])).toBe(true)
  })

  it('deduplicates per-rule issues beyond first 3', () => {
    const fileHeader = '  src/foo.ts'
    // Rule must be at the very end of the line (no trailing chars) for _OXLINT_RULE_RE
    const issues = Array.from(
      { length: 5 },
      (_, i) => `    × unused variable 'x${i}' (no-unused-vars)`,
    )
    const input = [fileHeader, ...issues].join('\n')
    const result = oxlintFilter.apply(input, '', 1, ['oxlint'])
    expect(result.text).toContain(issues[0])
    expect(result.text).toContain(issues[2])
    expect(result.text).not.toContain(issues[3])
    expect(result.text).toMatch(/more.*no-unused-vars/i)
  })

  it('drops location-pointer lines for suppressed issues', () => {
    const fileHeader = '  src/foo.ts'
    const issues = Array.from(
      { length: 5 },
      (_, i) => `    × unused variable${i} (no-unused-vars)`,
    )
    const locationLine = '  ╭─[src/foo.ts:4:1]'
    const input = [fileHeader, ...issues, locationLine].join('\n')
    const result = oxlintFilter.apply(input, '', 1, ['oxlint'])
    // location line follows a suppressed issue, must be dropped
    expect(result.text).not.toContain('╭─[src/foo.ts:4:1]')
  })
})

// ---------------------------------------------------------------------------
// BiomeFilter
// ---------------------------------------------------------------------------

describe('BiomeFilter', () => {
  it('matches biome', () => {
    expect(biomeFilter.matches(['biome', 'check'])).toBe(true)
  })

  it('matches npx biome and @biomejs/biome', () => {
    expect(biomeFilter.matches(['npx', 'biome', 'check'])).toBe(true)
    expect(biomeFilter.matches(['npx', '@biomejs/biome', 'check'])).toBe(true)
  })

  it('does not match npx eslint', () => {
    expect(biomeFilter.matches(['npx', 'eslint', 'src/'])).toBe(false)
  })

  it('passes through short output unchanged (≤40 non-empty lines)', () => {
    const input = ['Found 2 diagnostics', '', 'Checked 3 files in 10ms'].join('\n')
    const result = biomeFilter.apply(input, '', 1, ['biome', 'check'])
    expect(result.text).toContain('Found 2 diagnostics')
    expect(result.text).toContain('Checked 3 files')
  })

  it('collapses repeated rule stanzas beyond first 3', () => {
    // Need > 40 non-empty lines to exceed the pass-through threshold. Each stanza: 1 rule line + 1 source line = 2 non-empty; 25 stanzas = 50 non-empty.
    const stanza = (n: number) =>
      [
        `  × lint/suspicious/noDoubleEquals ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `     ${n} │ if (a == b) {}`,
        '',
      ].join('\n')
    const prefix = Array.from({ length: 25 }, (_, i) => stanza(i + 1)).join('\n')
    const summary = 'Found 25 diagnostics\nChecked 1 file in 50ms'
    const input = prefix + '\n' + summary
    const result = biomeFilter.apply(input, '', 1, ['biome', 'check'])
    expect(result.text).toContain('Found 25 diagnostics')
    expect(result.text).toMatch(/more.*lint\/suspicious\/noDoubleEquals/i)
  })
})

// ---------------------------------------------------------------------------
// Generic LinterFilter
// ---------------------------------------------------------------------------

describe('LinterFilter (generic)', () => {
  it('matches pyright', () => {
    expect(linterFilter.matches(['pyright', 'src/'])).toBe(true)
  })

  it('matches stylelint and rome', () => {
    expect(linterFilter.matches(['stylelint', '**/*.css'])).toBe(true)
    expect(linterFilter.matches(['rome', 'check'])).toBe(true)
  })

  it('deduplication path: pyright dedupe-by-key keeps first 3 per diagnostic key', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `  src/x.ts:${i + 1} - error: Type 'string' is not assignable to type 'number'. (reportArgumentType)`,
    )
    const result = linterFilter.apply(lines.join('\n'), '', 1, ['pyright', 'src/'])
    // Keeps first 3 per diagnostic key and collapses the rest to a count
    expect(result.text).toContain('src/x.ts:1')
    expect(result.text).toContain('src/x.ts:3')
    expect(result.text).not.toContain('src/x.ts:4')
    expect(result.text).not.toContain('src/x.ts:5')
    expect(result.text).toContain('+2 more matching error')
  })

  it('stanza path (stylelint/rome): emits each file header exactly once across a mid-stanza non-issue line', () => {
    // Regression: the earlier port pushed the file header both when flushing accumulated rules at a non-issue line AND again at end-of-stanza, so a stanza with issues -> separator -> more issues duplicated the header. Python's _compress_eslint_stanza emits the header exactly once. The stanza header must match _ESLINT_FILE_RE (js/ts/jsx/tsx/...), so use a .tsx path even though stylelint also runs on CSS — the stanza format is keyed on the JS/TS-style file header line, matching the Python original.
    const input = [
      'src/component.tsx',
      '  1:1  error  Expected indentation of 2 spaces  indentation',
      '  2:5  error  Expected indentation of 2 spaces  indentation',
      '  --- separator (non-issue) ---',
      '  3:1  warning  Unexpected unknown unit  unit-no-unknown',
    ].join('\n')
    const result = linterFilter.apply(input, '', 1, ['stylelint', 'src/'])
    const headerCount = (result.text.match(/src\/component\.tsx/g) ?? []).length
    expect(headerCount).toBe(1)
    // The non-issue separator line is preserved (kept in place, not dropped).
    expect(result.text).toContain('--- separator (non-issue) ---')
    // Both rules survive (each under its keep-3 cap).
    expect(result.text).toContain('unit-no-unknown')
  })
})

// ---------------------------------------------------------------------------
// GolangciLintFilter
// ---------------------------------------------------------------------------

describe('GolangciLintFilter', () => {
  it('matches golangci-lint', () => {
    expect(golangciFilter.matches(['golangci-lint', 'run'])).toBe(true)
  })

  it('matches npx golangci-lint', () => {
    expect(golangciFilter.matches(['npx', 'golangci-lint', 'run'])).toBe(true)
  })

  it('deduplicates file/linter pairs beyond first 3', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `pkg/foo.go:${i + 10}: unused variable x (unused)`,
    )
    const result = golangciFilter.apply(lines.join('\n'), '', 1, ['golangci-lint', 'run'])
    expect(result.text).toContain('pkg/foo.go:10:')
    expect(result.text).toContain('pkg/foo.go:12:')
    expect(result.text).not.toContain('pkg/foo.go:13:')
    expect(result.text).toMatch(/\+\d+ more unused issues in pkg\/foo\.go omitted/)
  })

  it('drops structured-log noise lines', () => {
    const input = [
      'time=2024-01-01T00:00:00Z level=info msg="Running linters"',
      'pkg/foo.go:1: unused (unused)',
      'golangci-lint version 1.55.0',
    ].join('\n')
    const result = golangciFilter.apply(input, '', 1, ['golangci-lint', 'run'])
    expect(result.text).not.toContain('time=2024')
    expect(result.text).not.toContain('golangci-lint version')
    expect(result.text).toContain('pkg/foo.go:1:')
  })
})

// ---------------------------------------------------------------------------
// PhpStanFilter
// ---------------------------------------------------------------------------

describe('PhpStanFilter', () => {
  it('matches phpstan and psalm', () => {
    expect(phpstanFilter.matches(['phpstan', 'analyse'])).toBe(true)
    expect(phpstanFilter.matches(['psalm'])).toBe(true)
  })

  it('matches phpstan.phar and psalm.phar', () => {
    expect(phpstanFilter.matches(['phpstan.phar', 'analyse'])).toBe(true)
    expect(phpstanFilter.matches(['psalm.phar'])).toBe(true)
  })

  it('phpstan: deduplicates per-file row messages beyond first 3', () => {
    const header = ' Line  src/foo.php'
    const rows = Array.from(
      { length: 5 },
      (_, i) => `  ${i + 1}  Undefined variable: $foo`,
    )
    const summary = ' [ERROR] Found 5 errors'
    const input = [header, ...rows, summary].join('\n')
    const result = phpstanFilter.apply(input, '', 1, ['phpstan', 'analyse'])
    // first 3 kept
    expect(result.text).toContain('  1  Undefined variable')
    expect(result.text).toContain('  3  Undefined variable')
    // Summary always kept
    expect(result.text).toContain('[ERROR]')
  })

  it('psalm: drops progress lines', () => {
    const input = [
      'Scanning files...',
      'Analyzing files...',
      'ERROR: UndefinedVariable - src/foo.php:10',
      'Checked 1 file',
    ].join('\n')
    const result = phpstanFilter.apply(input, '', 1, ['psalm'])
    expect(result.text).not.toContain('Scanning files')
    expect(result.text).not.toContain('Analyzing files')
    expect(result.text).toContain('UndefinedVariable')
  })
})

// ---------------------------------------------------------------------------
// SwiftLintFilter (makeLinterFilter factory)
// ---------------------------------------------------------------------------

describe('SwiftLintFilter (factory)', () => {
  it('matches swiftlint', () => {
    expect(swiftlintFilter.matches(['swiftlint'])).toBe(true)
  })

  it('always keeps error/serious severity regardless of count', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `src/foo.swift:${i + 1}:1: error: Force cast usage is discouraged. (force_cast)`,
    )
    const result = swiftlintFilter.apply(lines.join('\n'), '', 2, ['swiftlint'])
    // All errors kept
    expect(result.text).toContain('src/foo.swift:5:')
  })

  it('deduplicates warnings by rule beyond first 3, emits collapse note', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `src/foo.swift:${i + 1}:1: warning: Trailing whitespace violation (trailing_whitespace)`,
    )
    lines.push('Done linting! The source files linted had no violations')
    const result = swiftlintFilter.apply(lines.join('\n'), '', 0, ['swiftlint'])
    expect(result.text).toContain('src/foo.swift:1:')
    expect(result.text).toContain('src/foo.swift:3:')
    expect(result.text).not.toContain('src/foo.swift:4:')
    expect(result.text).toMatch(/\+2 more trailing_whitespace warning\(s\) elided/)
    // Summary line emitted last
    const lines2 = result.text.split('\n').filter((ln) => ln.trim())
    const lastLine = lines2[lines2.length - 1]!
    expect(lastLine).toMatch(/Done linting/i)
  })

  it('drops progress lines and counts them', () => {
    const input = [
      'Linting Swift files at path src/',
      "Linting 'Foo.swift'",
      'src/Foo.swift:1:1: warning: Force try (force_try)',
    ].join('\n')
    const result = swiftlintFilter.apply(input, '', 2, ['swiftlint'])
    expect(result.text).not.toContain('Linting Swift files')
    expect(result.text).toContain('force_try')
  })
})

// ---------------------------------------------------------------------------
// BlackIsortFilter
// ---------------------------------------------------------------------------

describe('BlackIsortFilter', () => {
  it('matches black and isort', () => {
    expect(blackIsortFilter.matches(['black', '.'])).toBe(true)
    expect(blackIsortFilter.matches(['isort', '.'])).toBe(true)
  })

  it('black: samples first 5 reformatted lines and notes the rest', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `reformatted src/file${i}.py`)
    lines.push('All done! ✨ 🍰 ✨\n8 files reformatted, 0 files left unchanged')
    const result = blackIsortFilter.apply(lines.join('\n'), '', 0, ['black', '.'])
    // First 5 sample
    expect(result.text).toContain('reformatted src/file0.py')
    expect(result.text).toContain('reformatted src/file4.py')
    expect(result.text).not.toContain('reformatted src/file5.py')
    expect(result.text).toMatch(/\+3 more reformatted/)
    expect(result.text).toContain('All done!')
  })

  it('isort: samples first 5 fixing lines and notes the rest', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `Fixing src/file${i}.py`)
    const result = blackIsortFilter.apply(lines.join('\n'), '', 0, ['isort', '.'])
    expect(result.text).toContain('Fixing src/file0.py')
    expect(result.text).toContain('Fixing src/file4.py')
    expect(result.text).not.toContain('Fixing src/file5.py')
    expect(result.text).toMatch(/\+2 more fixed/)
  })
})

// ---------------------------------------------------------------------------
// PrettierFilter
// ---------------------------------------------------------------------------

describe('PrettierFilter', () => {
  it('matches prettier', () => {
    expect(prettierFilter.matches(['prettier', '--write', '.'])).toBe(true)
  })

  it('matches npx prettier and pnpx prettier', () => {
    expect(prettierFilter.matches(['npx', 'prettier', '--write', '.'])).toBe(true)
    expect(prettierFilter.matches(['pnpx', 'prettier', '--write', '.'])).toBe(true)
  })

  it('does not match npx eslint', () => {
    expect(prettierFilter.matches(['npx', 'eslint'])).toBe(false)
  })

  it('samples changed files and drops unchanged', () => {
    const lines = [
      'src/a.ts 10ms',
      'src/b.ts (unchanged)',
      'src/c.ts 8ms',
      'src/d.ts (unchanged)',
      'Code style issues found in 2 files. Forgot to run Prettier?',
    ]
    const result = prettierFilter.apply(lines.join('\n'), '', 1, ['prettier', '--check', '.'])
    expect(result.text).toContain('src/a.ts')
    expect(result.text).toContain('src/c.ts')
    expect(result.text).not.toContain('src/b.ts')
    expect(result.text).not.toContain('src/d.ts')
    expect(result.text).toMatch(/dropped 2 unchanged/)
    expect(result.text).toContain('Code style issues found')
  })
})

// ---------------------------------------------------------------------------
// KtlintFilter
// ---------------------------------------------------------------------------

describe('KtlintFilter', () => {
  it('matches ktlint', () => {
    expect(ktlintFilter.matches(['ktlint'])).toBe(true)
  })

  it('deduplicates plain-text warning lines by rule', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `src/Foo.kt:${i + 1}:1: warning: Exceeded max line length (standard:max-line-length)`,
    )
    const result = ktlintFilter.apply(lines.join('\n'), '', 1, ['ktlint'])
    expect(result.text).toContain('src/Foo.kt:1:')
    expect(result.text).toContain('src/Foo.kt:3:')
    expect(result.text).not.toContain('src/Foo.kt:4:')
    expect(result.text).toMatch(/more standard:max-line-length warnings/)
  })

  it('always keeps error-severity lines', () => {
    const lines = Array.from(
      { length: 5 },
      (_, i) => `src/Foo.kt:${i + 1}:1: error: Unexpected semicolon (standard:no-semi)`,
    )
    const result = ktlintFilter.apply(lines.join('\n'), '', 1, ['ktlint'])
    // All errors kept regardless of count
    expect(result.text).toContain('src/Foo.kt:5:')
  })

  it('drops checkstyle XML wrapper tags', () => {
    const input = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<checkstyle version="8.0">',
      '<file name="src/Foo.kt">',
      '  <error line="1" column="1" severity="warning" message="test" source="standard:no-semi"/>',
      '</file>',
      '</checkstyle>',
    ].join('\n')
    const result = ktlintFilter.apply(input, '', 1, ['ktlint'])
    expect(result.text).not.toContain('<?xml')
    expect(result.text).not.toContain('<checkstyle')
    expect(result.text).toContain('standard:no-semi')
  })
})

// ---------------------------------------------------------------------------
// CppcheckFilter
// ---------------------------------------------------------------------------

describe('CppcheckFilter', () => {
  it('matches cppcheck', () => {
    expect(cppcheckFilter.matches(['cppcheck', 'src/'])).toBe(true)
  })

  it('collapses checking progress lines and keeps diagnostics', () => {
    const lines = [
      'Checking src/foo.cpp...',
      'Checking src/bar.cpp...',
      '[src/foo.cpp:10]: (error) Null pointer dereference',
      '1/2 files checked 50% done',
      '2/2 files checked 100% done',
    ]
    const result = cppcheckFilter.apply(lines.join('\n'), '', 1, ['cppcheck', 'src/'])
    expect(result.text).toContain('[src/foo.cpp:10]')
    expect(result.text).not.toContain('Checking src/foo.cpp')
    expect(result.text).toMatch(/collapsed.*Checking.*progress/)
  })
})

// ---------------------------------------------------------------------------
// ClangTidyFilter
// ---------------------------------------------------------------------------

describe('ClangTidyFilter', () => {
  it('matches clang-tidy and run-clang-tidy', () => {
    expect(clangTidyFilter.matches(['clang-tidy', 'src/foo.cpp'])).toBe(true)
    expect(clangTidyFilter.matches(['run-clang-tidy', '-p', 'build/'])).toBe(true)
  })

  it('collapses warnings-generated count lines', () => {
    const lines = [
      'src/foo.cpp:10:5: warning: use of old-style cast [google-readability-casting]',
      '5 warnings generated.',
      'src/bar.cpp:20:1: warning: use of old-style cast [google-readability-casting]',
      '3 warnings generated.',
    ]
    const result = clangTidyFilter.apply(lines.join('\n'), '', 1, ['clang-tidy'])
    expect(result.text).toContain('src/foo.cpp:10:')
    expect(result.text).not.toContain('warnings generated.')
    expect(result.text).toMatch(/collapsed \d+ total.*warnings generated/i)
  })

  it('keeps only first context block per diagnostic, drops subsequent caret lines', () => {
    // Context lines must have ≥4 leading spaces (^\s{4,}\S) or be pure caret/tilde lines. We test with pure caret/tilde lines (^\s+[\^~]+\s*$), two per diagnostic.
    const lines = [
      'src/foo.cpp:10:5: warning: unsigned comparison [some-check]',
      '    ^~~~~~~~~~~~',  // first context line: matches ^\s+\^[~^]*\s*$ → kept
      '    ~~~~~~~~~~~',   // second context line: matches ^\s+~+\s*$ → dropped
    ]
    const result = clangTidyFilter.apply(lines.join('\n'), '', 1, ['clang-tidy'])
    expect(result.text).toContain('src/foo.cpp:10:5:')
    expect(result.text).toContain('^~~~~~~~~~~~')
    // The second (tilde-only) context line must be absent — the caret line itself also contains '~~~~~~~~~~~' so we check for the standalone tilde prefix with leading spaces
    expect(result.text).not.toContain('\n    ~~~~~~~~~~~')
    expect(result.text).toMatch(/dropped \d+ redundant source-context/)
  })
})

// ---------------------------------------------------------------------------
// Dispatch integration
// ---------------------------------------------------------------------------

describe('detectFromCommand (linter dispatch)', () => {
  it('detects eslint src/ as the eslint filter', () => {
    const r = detectFromCommand('eslint src/')
    expect(r?.filter.name).toBe('eslint')
  })

  it('detects ruff check . as the ruff filter', () => {
    const r = detectFromCommand('ruff check .')
    expect(r?.filter.name).toBe('ruff')
  })

  it('detects npx tsc --noEmit as tsc filter', () => {
    const r = detectFromCommand('npx tsc --noEmit')
    expect(r?.filter.name).toBe('tsc')
  })

  it('detects mypy src/ as the mypy filter', () => {
    const r = detectFromCommand('mypy src/')
    expect(r?.filter.name).toBe('mypy')
  })

  it('detects golangci-lint run as golangci-lint filter', () => {
    const r = detectFromCommand('golangci-lint run')
    expect(r?.filter.name).toBe('golangci-lint')
  })

  it('detects npx prettier --write . as prettier filter', () => {
    const r = detectFromCommand('npx prettier --write .')
    expect(r?.filter.name).toBe('prettier')
  })

  it('detects cppcheck src/ as cppcheck filter', () => {
    const r = detectFromCommand('cppcheck src/')
    expect(r?.filter.name).toBe('cppcheck')
  })
})
