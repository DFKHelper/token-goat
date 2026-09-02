/**
 * Tests for the shell/file-tool filter family (Batch J).
 *
 * Covers: GrepFilter, RgFilter, LsFilter, EzaFilter, TreeFilter, FdFilter,
 * WcFilter, BatFilter, DeltaFilter, FzfFilter, LazyGitFilter, JqFilter,
 * YqFilter, CurlFilter, RsyncFilter, DiffFilter, FfmpegFilter,
 * BinaryInspectFilter, FileTypeFilter, PsFilter.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { configPath } from '../src/constants.js'
import {
  GrepFilter,
  RgFilter,
  LsFilter,
  EzaFilter,
  TreeFilter,
  FdFilter,
  WcFilter,
  BatFilter,
  DeltaFilter,
  FzfFilter,
  LazyGitFilter,
  JqFilter,
  YqFilter,
  CurlFilter,
  RsyncFilter,
  DiffFilter,
  FfmpegFilter,
  BinaryInspectFilter,
  FileTypeFilter,
  PsFilter,
  SHELL_FILE_FILTERS,
} from '../src/tool_filters/shell_file.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compress(
  filter: { compress: (a: string, b: string, c: number, d: string[]) => string },
  stdout: string,
  argv: string[],
  { stderr = '', exitCode = 0 } = {},
): string {
  return filter.compress(stdout, stderr, exitCode, argv)
}

// Note: combineOutput in the base class always strips trailing whitespace (`.replace(/\s+$/, '')`), so filter output never ends with `\n`. All passthrough expectations use `.trimEnd()` on the input to match.

// ---------------------------------------------------------------------------
// GrepFilter
// ---------------------------------------------------------------------------

describe('GrepFilter dispatch', () => {
  const f = new GrepFilter()

  it('matches grep', () => expect(f.matches(['grep', '-r', 'foo', '.'])).toBe(true))
  it('matches egrep', () => expect(f.matches(['egrep', 'foo'])).toBe(true))
  it('matches fgrep', () => expect(f.matches(['fgrep', 'foo'])).toBe(true))
  it('matches git grep', () => expect(f.matches(['git', 'grep', 'foo'])).toBe(true))
  it('does not match git log', () => expect(f.matches(['git', 'log', '--oneline'])).toBe(false))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('GrepFilter compression', () => {
  const f = new GrepFilter()
  const argv = ['grep', '-r', 'TODO', '.']

  it('passes through when below threshold', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `src/file.ts:${i + 1}:  // TODO: fix this`)
    const out = lines.join('\n')
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('summarises large grep output with file grouping', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `src/file_${i}.ts:1: match`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('elides the tail of a many-file result with a narrowing hint that actually applies to file count, not context flags', () => {
    // Regression: this hint used to read "use --context or -C flags to narrow" -- -C/--context
    // controls how many surrounding lines are printed per match, which has nothing to do with
    // the number of distinct files listed here, so the advice never actually helped a user
    // facing this exact elision.
    const lines = Array.from({ length: 50 }, (_, i) => `src/file_${i}.ts:1: match`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out).toContain('more file(s) elided; use a more specific pattern or --include=<glob> to narrow')
    expect(out).not.toContain('-C flags')
  })

  it('attributes matches on a Windows absolute path to its file instead of "unattributed" (regression: line.indexOf(\':\') picked up the drive-letter colon in "C:\\foo\\bar.py:12:text", leaving candidate as just "C")', () => {
    const lines = Array.from({ length: 35 }, (_, i) => `C:\\Users\\foo\\bar.py:${i + 1}: match`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out).toContain('C:\\Users\\foo\\bar.py: 35 match(es)')
    expect(out).not.toContain('unattributed')
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Over-long line clipping on the grep/rg pass-through branch. Under
// _GREP_COMPRESS_THRESHOLD the filter returned the raw output verbatim with no
// per-line cap of any kind, and apply()'s line/byte caps only look at
// whole-output size -- so a twelve-line result carrying one 5,000-char hit
// inside a minified bundle shipped that line whole.
// ---------------------------------------------------------------------------

// CAPTURE: `grep -rn "written against invented output shipped broken" src/tool_filters/` run with GNU grep 3.0 in this repo on 2026-09-01. One 1,254-char line; the matched text starts at offset 1,206, i.e. past any 1,000-char head window.
const GREP_LONG_CAPTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'tool_output', 'grep-3.0-long-line.txt'),
  'utf-8',
)
// CAPTURE: `grep -rn "resolveMinNetSavingsBytes" src/tool_filters/` run with GNU grep 3.0 in this repo on 2026-09-01. Four lines, longest 132 chars.
const GREP_SHORT_CAPTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'tool_output', 'grep-3.0-short-lines.txt'),
  'utf-8',
)
const LATE_PATTERN = 'written against invented output shipped broken'
const EARLY_PATTERN = 'Legacy-only by decision'

describe('GrepFilter over-long line clipping', () => {
  const f = new GrepFilter()

  it('keeps a late match visible by centring the retained window on it', () => {
    const out = compress(f, GREP_LONG_CAPTURE, ['grep', '-rn', LATE_PATTERN, 'src/tool_filters/'])
    // Must-not-drop: the matched text itself. A clip that shortens the line but loses the match has spent the bytes and destroyed the answer.
    expect(out).toContain(LATE_PATTERN)
    // Must-not-drop: the path:lineno: field, without which the hit cannot be located.
    expect(out).toContain('src/tool_filters/linters.ts:1443:')
    expect(out).toContain('chars elided')
    expect(out.length).toBeLessThan(GREP_LONG_CAPTURE.trimEnd().length)
  })

  it('head-clips when the match already falls inside the retained window', () => {
    const raw = GREP_LONG_CAPTURE.trimEnd()
    const out = compress(f, GREP_LONG_CAPTURE, ['grep', '-rn', EARLY_PATTERN, 'src/tool_filters/'])
    expect(out).toContain(EARLY_PATTERN)
    expect(out).toBe(`${raw.slice(0, 1000)}  … [${raw.length - 1000} chars elided]`)
  })

  it('leaves the line whole when the match cannot be located (case-folded search)', () => {
    // -i means the literal pattern need not appear verbatim on the line, so there is no position to centre on.
    const out = compress(f, GREP_LONG_CAPTURE, ['grep', '-rni', LATE_PATTERN.toUpperCase(), 'src/tool_filters/'])
    expect(out).toBe(GREP_LONG_CAPTURE.trimEnd())
  })

  it('leaves the line whole for a regex pattern it cannot cheaply re-evaluate', () => {
    const out = compress(f, GREP_LONG_CAPTURE, ['grep', '-rn', 'invented.*broken', 'src/tool_filters/'])
    expect(out).toBe(GREP_LONG_CAPTURE.trimEnd())
  })

  it('leaves a line just under the cap untouched', () => {
    // HAND-DERIVED: 999 chars is one below GREP_MAX_LINE_CHARS, computed from the cap rather than from the clipper.
    const line = `src/a.ts:1:${'x'.repeat(999 - 'src/a.ts:1:'.length - 'NEEDLE'.length)}NEEDLE`
    const raw = `${line}\n${line}`
    const out = compress(f, raw, ['grep', '-rn', 'NEEDLE', '.'])
    expect(line.length).toBe(999)
    expect(out).toBe(raw)
  })

  it('keeps the bare lineno: field grep emits for a single explicit file', () => {
    // CAPTURE: `grep -n "written against invented output shipped broken" src/tool_filters/linters.ts` run with GNU grep 3.0 in this repo on 2026-09-01. Given one explicit file, grep omits the filename and prefixes the line number alone.
    const raw = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'tool_output', 'grep-3.0-long-line-nofile.txt'),
      'utf-8',
    )
    const out = compress(f, raw, ['grep', '-n', LATE_PATTERN, 'src/tool_filters/linters.ts'])
    expect(out).toContain(LATE_PATTERN)
    // Must-not-drop: the line number, the only locator this output form carries.
    expect(out.startsWith('1443:')).toBe(true)
    expect(out.length).toBeLessThan(raw.trimEnd().length)
  })

  it('passes a short-lined result through byte-identically', () => {
    const out = compress(f, GREP_SHORT_CAPTURE, ['grep', '-rn', 'resolveMinNetSavingsBytes', 'src/tool_filters/'])
    expect(out).toBe(GREP_SHORT_CAPTURE.trimEnd())
  })
})

describe('RgFilter over-long line clipping', () => {
  const f = new RgFilter()

  it('applies the same centred clip to context-flag output', () => {
    const out = compress(f, GREP_LONG_CAPTURE, ['rg', '-C', '2', LATE_PATTERN, 'src/tool_filters/'])
    expect(out).toContain(LATE_PATTERN)
    expect(out).toContain('chars elided')
    expect(out.length).toBeLessThan(GREP_LONG_CAPTURE.trimEnd().length)
  })

  it('leaves short context output byte-identical', () => {
    const out = compress(f, GREP_SHORT_CAPTURE, ['rg', '-C', '2', 'resolveMinNetSavingsBytes', 'src/tool_filters/'])
    expect(out).toBe(GREP_SHORT_CAPTURE.trimEnd())
  })
})

// ---------------------------------------------------------------------------
// RgFilter
// ---------------------------------------------------------------------------

describe('RgFilter dispatch', () => {
  const f = new RgFilter()

  it('matches rg with a context flag', () => expect(f.matches(['rg', '-C', '3', 'foo', '.'])).toBe(true))
  it('matches grep (context-line stripping role)', () => expect(f.matches(['grep', '-C', '3', 'foo'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
  it('does not match rg/grep without a context flag (GrepFilter handles those)', () => {
    expect(f.matches(['rg', 'foo', '.'])).toBe(false)
    expect(f.matches(['grep', '-rn', 'TODO', '.'])).toBe(false)
  })
})

describe('RgFilter compression', () => {
  const f = new RgFilter()
  const argv = ['rg', '-C', '3', 'error']

  it('strips context lines when output is large with many context groups', () => {
    // Build output with many groups > _RG_CONTEXT_THRESHOLD (30)
    const groups: string[] = []
    for (let i = 0; i < 12; i++) {
      groups.push(`src/a_${i}.ts:5:  before context line`)
      groups.push(`src/a_${i}.ts:6: error found here`)
      groups.push(`src/a_${i}.ts:7:  after context line`)
      groups.push('')
    }
    const out = compress(f, groups.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(groups.length)
  })

  it('passes through small output (stripped of trailing whitespace)', () => {
    const small = 'src/foo.ts:5: error here\nsrc/foo.ts:6: context'
    expect(compress(f, small, argv)).toBe(small.trimEnd())
  })
})

// ---------------------------------------------------------------------------
// LsFilter
// ---------------------------------------------------------------------------

describe('LsFilter dispatch', () => {
  const f = new LsFilter()

  it('matches ls', () => expect(f.matches(['ls'])).toBe(true))
  it('matches ls -la', () => expect(f.matches(['ls', '-la'])).toBe(true))
  it('matches ls --color=auto', () => expect(f.matches(['ls', '--color=auto'])).toBe(true))
  it('matches dir on Windows', () => expect(f.matches(['dir'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('LsFilter compression', () => {
  const f = new LsFilter()
  const argv = ['ls', '-la']

  it('passes through when at or below threshold (25 entries)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `-rw-r--r-- 1 user group 100 Jan 1 file${i}.ts`)
    const out = lines.join('\n')
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('truncates large directory listing', () => {
    const total = 'total 1024'
    const lines = [total, ...Array.from({ length: 80 }, (_, i) => `-rw-r--r-- 1 u g 100 Jan 1 file${i}.ts`)]
    const out = compress(f, lines.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })
})

describe('LsFilter dir.exe output', () => {
  const f = new LsFilter()
  const argv = ['dir']

  it('recognizes dir.exe banner/summary and keeps directories out of the extension summary', () => {
    const dirEntries = ['.', '..', 'node_modules', 'src', 'tests']
      .map(name => `07/01/2026  09:30 AM    <DIR>          ${name}`)
    const fileEntries = [
      ...Array.from({ length: 5 }, (_, i) => `06/30/2026  08:00 AM             1,${100 + i} file${i}.json`),
      ...Array.from({ length: 5 }, (_, i) => `06/30/2026  08:00 AM             2,${100 + i} file${5 + i}.md`),
      ...Array.from({ length: 5 }, (_, i) => `06/30/2026  08:00 AM             3,${100 + i} file${10 + i}.ts`),
    ]
    const lines = [
      ' Volume in drive C is Windows',
      ' Volume Serial Number is 1234-ABCD',
      '',
      ' Directory of C:/Users/zelys/Projects/token-goat',
      '',
      ...dirEntries,
      ...fileEntries,
      '              15 File(s)         45,678 bytes',
      '               5 Dir(s)  98,765,432 bytes free',
    ]
    const out = compress(f, lines.join('\n'), argv)

    // Banner lines pass through untouched, not folded into the entry list
    expect(out).toContain('Volume in drive C is Windows')
    expect(out).toContain('Directory of C:/Users/zelys/Projects/token-goat')

    // The trailing summary must survive truncation, not be silently dropped
    expect(out).toContain('15 File(s)')
    expect(out).toContain('5 Dir(s)')

    // <DIR> rows must not pollute the extension-based hidden-entries summary
    expect(out).not.toContain('other×')
    expect(out).not.toContain('.×')
  })
})

describe('LsFilter extension-summary escaping (regression: $/$&/$$)', () => {
  const f = new LsFilter()
  const argv = ['ls', '-la']

  it('preserves literal $& in file extensions when building hidden-entry marker (String.replace special sequence)', () => {
    // Regression test for: _LS_HIDDEN_MARKER_EXT.replace('{ext_summary}', extPart)
    // where extPart contains `$&` (which JS String.replace treats as a special sequence).
    //
    // The filter must compress large directory listings and emit a marker like:
    // "[token-goat: 5 more entries — by type: .ts×8 .js×4 .c$&d×1 other×0]"
    //
    // If the bug exists, JavaScript's String.replace will interpret `$&` in the
    // replacement string as "re-insert the matched text", corrupting the output.
    //
    // Use a large enough listing to force compression (> _LS_MAX_ENTRIES = 10).
    const lines = [
      'total 1024',
      ...Array.from({ length: 80 }, (_, i) => `-rw-r--r-- 1 u g 100 Jan 1 file${i}.ts`),
    ]
    // Inject a file with $& in the name into the list (as if it were in the real directory)
    lines.push('-rw-r--r-- 1 u g 300 Jan 1 weird.c$&d')

    const out = compress(f, lines.join('\n'), argv)

    // Output should be compressed
    expect(out.split('\n').length).toBeLessThan(lines.length)

    // The marker line with extension summary should exist
    expect(out).toContain('[token-goat:')
    expect(out).toContain('by type:')

    // CRITICAL: the marker must preserve the literal `.c$&d` in the extension summary.
    // If the bug exists (unfixed .replace), $& is re-interpreted as the matched placeholder,
    // corrupting the text. We assert the literal string is present.
    expect(out).toContain('.c$&d×1')
  })

  it('preserves literal $$ in file extensions when building hidden-entry marker', () => {
    // Similar to above: test the $$ special sequence (which JS treats as a literal $ in replacements).
    const lines = [
      'total 1024',
      ...Array.from({ length: 80 }, (_, i) => `-rw-r--r-- 1 u g 100 Jan 1 file${i}.ts`),
      '-rw-r--r-- 1 u g 300 Jan 1 weird.c$$d',
    ]

    const out = compress(f, lines.join('\n'), argv)

    expect(out.split('\n').length).toBeLessThan(lines.length)
    expect(out).toContain('[token-goat:')
    expect(out).toContain('.c$$d×1')
  })

  it('the "by type" extension breakdown only counts elided entries, not the ones already shown (LSEXT-DOUBLECOUNT regression)', () => {
    // 80 .ts + 50 .js = 130 entries; _LS_MAX_ENTRIES (10) are shown verbatim, so exactly
    // 120 are elided. The by-type breakdown must describe only those 120 elided entries
    // -- its per-extension counts must sum to 120, not to the full 130-entry listing
    // (which would double-count the 10 already-visible entries in the marker text).
    const lines = [
      'total 1024',
      ...Array.from({ length: 80 }, (_, i) => `-rw-r--r-- 1 u g 100 Jan 1 file${i}.ts`),
      ...Array.from({ length: 50 }, (_, i) => `-rw-r--r-- 1 u g 100 Jan 1 file${i}.js`),
    ]

    const out = compress(f, lines.join('\n'), argv)
    const marker = out.split('\n').find((l) => l.includes('by type:'))
    expect(marker).toBeDefined()
    expect(marker).toContain('120 more entries')

    const counts = [...marker!.matchAll(/×(\d+)/g)].map((m) => Number(m[1]))
    const sum = counts.reduce((a, b) => a + b, 0)
    expect(sum).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// EzaFilter
// ---------------------------------------------------------------------------

describe('EzaFilter dispatch', () => {
  const f = new EzaFilter()

  it('matches eza', () => expect(f.matches(['eza'])).toBe(true))
  it('matches exa (legacy)', () => expect(f.matches(['exa'])).toBe(true))
  it('matches eza --tree', () => expect(f.matches(['eza', '--tree'])).toBe(true))
  // A bare `ls` with no eza-only flag is a real GNU/BSD ls invocation, not an aliased eza -- must
  // fall through to LsFilter, not be claimed here.
  it('does not match a plain ls with no eza-only flag', () => expect(f.matches(['ls'])).toBe(false))
  it('does not match ls -la', () => expect(f.matches(['ls', '-la'])).toBe(false))
  // `alias ls=eza` means token-goat only ever sees the literal "ls ..." command text; an
  // eza-only flag on the 'ls' binary is the only signal available to tell the two apart.
  it('matches ls --tree (aliased eza)', () => expect(f.matches(['ls', '--tree'])).toBe(true))
  it('matches ls --icons (aliased eza)', () => expect(f.matches(['ls', '--icons'])).toBe(true))
  it('matches ls --git (aliased eza)', () => expect(f.matches(['ls', '--git'])).toBe(true))
})

describe('EzaFilter compression', () => {
  const f = new EzaFilter()
  const argv = ['eza', '--long', '--git']

  it('passes through when below threshold (≤30 non-empty lines)', () => {
    const out = 'src/\ntests/\npackage.json'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('compresses large eza output', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `drwxr-xr-x - user ${String(i).padStart(3)} Jan 1 dir${i}`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })
})

// ---------------------------------------------------------------------------
// TreeFilter
// ---------------------------------------------------------------------------

describe('TreeFilter dispatch', () => {
  const f = new TreeFilter()

  it('matches tree', () => expect(f.matches(['tree'])).toBe(true))
  it('matches tree -L 3', () => expect(f.matches(['tree', '-L', '3'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('TreeFilter compression', () => {
  const f = new TreeFilter()
  const argv = ['tree']

  it('passes through a small tree', () => {
    const out = '.\n├── src\n│   └── index.ts\n└── package.json\n\n1 directory, 2 files'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('collapses depth-3 entries when a parent has many children', () => {
    // TreeFilter collapses depth≥3 entries (two levels of │ indentation). Structure: . → src → components → [many files at depth 3]
    const lines = [
      '.',
      '├── src',
      '│   └── components',
      ...Array.from({ length: 25 }, (_, i) => `│   │   ├── Component${i}.tsx`),
      '└── package.json',
      '',
      '1 directory, 27 files',
    ]
    const out = compress(f, lines.join('\n'), argv)
    expect(out).toMatch(/\d+ items/)
  })
})

// ---------------------------------------------------------------------------
// FdFilter
// ---------------------------------------------------------------------------

describe('FdFilter dispatch', () => {
  const f = new FdFilter()

  it('matches fd', () => expect(f.matches(['fd', '.ts'])).toBe(true))
  it('matches fdfind', () => expect(f.matches(['fdfind', '.ts'])).toBe(true))
  it('matches find', () => expect(f.matches(['find', '.', '-name', '*.ts'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('FdFilter compression', () => {
  const f = new FdFilter()
  const argv = ['fd', '.ts']

  it('passes through when below threshold (≤40 entries)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`)
    const out = lines.join('\n')
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('truncates large fd output', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `src/path/file${i}.ts`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })
})

// ---------------------------------------------------------------------------
// WcFilter
// ---------------------------------------------------------------------------

describe('WcFilter dispatch', () => {
  const f = new WcFilter()

  it('matches wc', () => expect(f.matches(['wc', '-l', 'file.txt'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('WcFilter compression', () => {
  const f = new WcFilter()
  const argv = ['wc', '-l']

  it('strips leading whitespace from wc -l lines', () => {
    // wc -l outputs leading spaces; WcFilter strips them
    const out = '  42 file.txt\n  42 total'
    const result = compress(f, out, argv)
    expect(result).toContain('42 file.txt')
    expect(result).toContain('42 total')
    expect(result).not.toMatch(/^\s+\d/)
  })

  it('preserves all lines — WcFilter normalises but does not truncate', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `  ${100 + i} src/file${i}.ts`)
    lines.push('  9600 total')
    const result = compress(f, lines.join('\n'), argv)
    expect(result).toContain('total')
    // Line count stays the same (just leading whitespace stripped)
    expect(result.split('\n').length).toBe(lines.length)
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// BatFilter
// ---------------------------------------------------------------------------

describe('BatFilter dispatch', () => {
  const f = new BatFilter()

  it('matches bat', () => expect(f.matches(['bat', 'file.ts'])).toBe(true))
  it('matches batcat', () => expect(f.matches(['batcat', 'file.ts'])).toBe(true))
  it('does not match cat', () => expect(f.matches(['cat', 'file.ts'])).toBe(false))
})

describe('BatFilter compression', () => {
  const f = new BatFilter()
  const argv = ['bat', 'src/index.ts']

  it('strips bat box-drawing border lines', () => {
    const out = [
      '───────┬──────────────────',
      '       │ File: src/index.ts',
      '───────┼──────────────────',
      '   1   │ export function foo() {',
      '   2   │   return 42',
      '   3   │ }',
      '───────┴──────────────────',
    ].join('\n')
    const result = compress(f, out, argv)
    expect(result).not.toContain('───────┬')
    expect(result).not.toContain('───────┴')
    expect(result).toContain('export function foo()')
  })

  it('passes through content lines without separators', () => {
    const out = '   1   │ line one\n   2   │ line two'
    const result = compress(f, out, argv)
    expect(result).toContain('line one')
    expect(result).toContain('line two')
  })
})

// ---------------------------------------------------------------------------
// DeltaFilter
// ---------------------------------------------------------------------------

describe('DeltaFilter dispatch', () => {
  const f = new DeltaFilter()

  it('matches delta', () => expect(f.matches(['delta'])).toBe(true))
  it('does not match diff', () => expect(f.matches(['diff'])).toBe(false))
})

describe('DeltaFilter compression', () => {
  const f = new DeltaFilter()
  const argv = ['delta']

  it('strips delta horizontal-rule separator lines', () => {
    const out = [
      '─────────────────────────────────',
      'src/index.ts',
      '─────────────────────────────────',
      '+added line',
      '-removed line',
    ].join('\n')
    const result = compress(f, out, argv)
    expect(result).not.toMatch(/^─+$/m)
    expect(result).toContain('+added line')
    expect(result).toContain('-removed line')
  })
})

// ---------------------------------------------------------------------------
// FzfFilter
// ---------------------------------------------------------------------------

describe('FzfFilter dispatch', () => {
  const f = new FzfFilter()

  it('matches fzf', () => expect(f.matches(['fzf'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('FzfFilter compression', () => {
  const f = new FzfFilter()
  const argv = ['fzf']

  it('passes through small output (stripped of trailing whitespace)', () => {
    const out = 'src/index.ts'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('truncates large fzf output', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `src/path/to/file${i}.ts`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out.split('\n').filter(Boolean).length).toBeLessThan(lines.length)
  })
})

// ---------------------------------------------------------------------------
// LazyGitFilter
// ---------------------------------------------------------------------------

describe('LazyGitFilter dispatch', () => {
  const f = new LazyGitFilter()

  it('matches lazygit', () => expect(f.matches(['lazygit'])).toBe(true))
  it('does not match git', () => expect(f.matches(['git'])).toBe(false))
})

describe('LazyGitFilter compression', () => {
  const f = new LazyGitFilter()
  const argv = ['lazygit']

  it('replaces TUI ANSI escape output with a note', () => {
    const out = '\x1b[2J\x1b[H\x1b[?1049hLazygit TUI screen content'
    const result = compress(f, out, argv)
    expect(result.toLowerCase()).toMatch(/lazygit|tui|interactive/)
  })

  it('passes through non-TUI output (trailing whitespace stripped)', () => {
    const out = 'plain text output'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })
})

// ---------------------------------------------------------------------------
// JqFilter
// ---------------------------------------------------------------------------

describe('JqFilter dispatch', () => {
  const f = new JqFilter()

  it('matches jq', () => expect(f.matches(['jq', '.', 'file.json'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('JqFilter compression', () => {
  const f = new JqFilter()
  const argv = ['jq', '.']

  it('passes through small JSON output (trailing whitespace stripped)', () => {
    const out = '{\n  "key": "value"\n}'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('truncates large jq output (>200 non-empty lines)', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `  "key${i}": "value${i}",`)
    const out = `{\n${lines.join('\n')}\n}`
    const result = compress(f, out, argv)
    expect(result.split('\n').length).toBeLessThan(out.split('\n').length)
  })
})

// ---------------------------------------------------------------------------
// YqFilter
// ---------------------------------------------------------------------------

describe('YqFilter dispatch', () => {
  const f = new YqFilter()

  it('matches yq', () => expect(f.matches(['yq', '.version', 'file.yaml'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('YqFilter compression', () => {
  const f = new YqFilter()
  const argv = ['yq', '.']

  it('passes through small YAML output (trailing whitespace stripped)', () => {
    const out = 'name: my-app\nversion: 1.0.0'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('truncates large yq output (>150 non-empty lines)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `key${i}: value${i}`)
    const out = lines.join('\n')
    const result = compress(f, out, argv)
    expect(result.split('\n').length).toBeLessThan(lines.length)
  })
})

// ---------------------------------------------------------------------------
// CurlFilter
// ---------------------------------------------------------------------------

describe('CurlFilter dispatch', () => {
  const f = new CurlFilter()

  it('matches curl', () => expect(f.matches(['curl', 'https://example.com'])).toBe(true))
  it('matches wget', () => expect(f.matches(['wget', 'https://example.com'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('CurlFilter compression', () => {
  const f = new CurlFilter()
  const argv = ['curl', '-v', 'https://api.example.com/data']

  it('strips verbose metadata headers from curl -v output', () => {
    const out = [
      '*   Trying 93.184.216.34:443...',
      '* Connected to example.com (93.184.216.34) port 443',
      '* ALPN: offers h2',
      '> GET /data HTTP/2',
      '> Host: api.example.com',
      '> User-Agent: curl/8.0.0',
      '> Accept: */*',
      '>',
      '< HTTP/2 200',
      '< content-type: application/json',
      '<',
      '{"result": "ok"}',
    ].join('\n')
    const result = compress(f, out, argv)
    expect(result).toContain('{"result": "ok"}')
    expect(result.split('\n').length).toBeLessThan(out.split('\n').length)
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })

  it('keeps the HTTP status line and useful response headers through the real apply() pipeline when curl emits \\r\\r\\n per verbose line (observed on Windows), not just the direct compress() call', () => {
    // Real curl -v on Windows terminates each `> `/`< ` verbose line with its
    // own \r\n on top of the stream's own line ending, producing a literal
    // \r\r\n. apply() runs normalise() (CRLF collapse + stripProgress) before
    // compressBody ever sees the text -- this is the production path, unlike
    // the bare compress() calls above which bypass normalise() entirely.
    const stderr = [
      '*   Trying 93.184.216.34:443...\r',
      '> GET /data HTTP/1.1\r\r',
      '> Host: api.example.com\r\r',
      '> \r\r',
      '< HTTP/1.1 200 OK\r\r',
      '< content-type: application/json\r\r',
      '< \r\r',
    ].join('\n')
    const stdout = '{"result": "ok"}'
    const result = f.apply(stdout, stderr, 0, argv)
    expect(result.text).toContain('HTTP/1.1 200 OK')
    expect(result.text).toContain('content-type: application/json')
    expect(result.text).toContain('{"result": "ok"}')
  })
})

// ---------------------------------------------------------------------------
// RsyncFilter
// ---------------------------------------------------------------------------

describe('RsyncFilter dispatch', () => {
  const f = new RsyncFilter()

  it('matches rsync', () => expect(f.matches(['rsync', '-avz', 'src/', 'dst/'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('RsyncFilter compression', () => {
  const f = new RsyncFilter()
  const argv = ['rsync', '-avz', '--progress', 'src/', 'dst/']

  it('passes through small rsync output (trailing whitespace stripped)', () => {
    // Non-path lines (no `/` except in summary) pass through
    const out = 'sending incremental file list\nfile.txt\n\nsent 100 bytes'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('drops per-file transfer lines that are file paths and adds a note', () => {
    const lines = [
      'sending incremental file list',
      // These file paths contain '/' and get dropped
      ...Array.from({ length: 30 }, (_, i) => `src/path/to/file${i}.dat`),
      '',
      'sent 65536 bytes  received 512 bytes  44032.00 bytes/sec',
    ]
    const out = compress(f, lines.join('\n'), argv)
    // Summary line preserved
    expect(out).toContain('sent')
    // Output should be shorter — file paths dropped
    expect(out.split('\n').length).toBeLessThan(lines.length)
    // Suppression note added
    expect(out).toMatch(/collapsed \d+ per-file/)
  })
})

// ---------------------------------------------------------------------------
// DiffFilter
// ---------------------------------------------------------------------------

describe('DiffFilter dispatch', () => {
  const f = new DiffFilter()

  it('matches diff', () => expect(f.matches(['diff', 'a.txt', 'b.txt'])).toBe(true))
  it('matches diff -u', () => expect(f.matches(['diff', '-u', 'a.txt', 'b.txt'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('DiffFilter compression', () => {
  const f = new DiffFilter()
  const argv = ['diff', '-u', 'a.txt', 'b.txt']

  it('passes through small diff output (≤50 non-empty lines, trailing whitespace stripped)', () => {
    const out = '--- a.txt\n+++ b.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('compresses large unified diff across many files', () => {
    const fileDiffs: string[] = []
    for (let i = 0; i < 25; i++) {
      fileDiffs.push(`--- a/file${i}.ts`)
      fileDiffs.push(`+++ b/file${i}.ts`)
      for (let h = 0; h < 5; h++) {
        fileDiffs.push(`@@ -${h * 10 + 1},5 +${h * 10 + 1},5 @@`)
        for (let j = 0; j < 4; j++) fileDiffs.push(` context line`)
        fileDiffs.push(`-old line ${h}`)
        fileDiffs.push(`+new line ${h}`)
      }
    }
    const out = compress(f, fileDiffs.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(fileDiffs.length)
  })

  it('does not double-count files for diff -ru with command-echo lines (recursive diff)', () => {
    const fileCount = 25
    const parts: string[] = []
    for (let i = 0; i < fileCount; i++) {
      parts.push(`diff -ru a/file${i}.ts b/file${i}.ts`)
      parts.push(`--- a/file${i}.ts\t2024-01-01 00:00:00.000000000 +0000`)
      parts.push(`+++ b/file${i}.ts\t2024-01-01 00:00:01.000000000 +0000`)
      parts.push('@@ -1,3 +1,3 @@')
      parts.push(' context line')
      parts.push('-old line')
      parts.push('+new line')
    }
    const out = compress(f, parts.join('\n'), ['diff', '-ru', 'a', 'b'])
    // Each of the 25 files must be counted once, not twice (echo line + header both matching the file-header regex)
    expect(out).toContain(`large diff (${fileCount} files)`)
    expect(out).not.toContain(`large diff (${fileCount * 2} files)`)
  })

  it('does not treat a removed line starting with "-- " as a spurious file boundary', () => {
    // A removed SQL/Lua/Haskell comment (or markdown horizontal rule) renders
    // as a bare `--- `-prefixed line with no following `+++ ` line — it must
    // not be misdetected as a second file's header.
    const lines: string[] = ['--- a/file.sql', '+++ b/file.sql', '@@ -1,6 +1,6 @@']
    for (let j = 0; j < 4; j++) lines.push(' context line')
    lines.push('-- removed comment line')
    lines.push('+kept line')
    // Pad past the 50-line passthrough threshold so compression actually runs.
    for (let j = 0; j < 50; j++) lines.push(' more context line')
    const out = compress(f, lines.join('\n'), argv)
    // A spurious split would report 2 files in the stat-only/large-diff path,
    // or otherwise duplicate/mislabel the `file.sql` header.
    expect(out).not.toContain('large diff')
    expect(out.match(/--- a\/file\.sql/g)?.length ?? 0).toBe(1)
    expect(out).toContain('-- removed comment line')
  })
})

describe('DiffFilter honors [bash_diff].max_hunks_per_file for the density cap (not hardcoded-disabled 0)', () => {
  // saveConfig does not create configPath()'s parent directory itself; make
  // sure it exists before writing (same pattern as bash_runner.test.ts).
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })

  afterEach(() => {
    invalidateConfigCache()
    try {
      fs.unlinkSync(configPath())
    } catch {
      // ok — may not exist
    }
  })

  it('a low configured max_hunks_per_file drops low-density hunks with the density-cap message, which the hardcoded-disabled default never emits', () => {
    const cfg = defaultConfig()
    cfg.bash_diff.max_hunks_per_file = 2 // config.ts's validated floor is 1
    saveConfig(cfg)

    const f = new DiffFilter()
    const argv = ['diff', '-u', 'a.txt', 'b.txt']
    const lines: string[] = ['--- a/file.ts', '+++ b/file.ts']
    // Two high-density hunks (mostly +/- lines) ...
    for (let h = 0; h < 2; h++) {
      lines.push(`@@ -${h * 20 + 1},5 +${h * 20 + 1},5 @@`)
      lines.push(`-old dense line ${h}`)
      lines.push(`+new dense line ${h}`)
      lines.push(`-old dense line ${h}b`)
      lines.push(`+new dense line ${h}b`)
    }
    // ... and three low-density hunks (mostly unchanged context lines).
    // Padded well past the 50-non-empty-line passthrough threshold so
    // compression (and the density cap under test) actually runs.
    for (let h = 2; h < 5; h++) {
      lines.push(`@@ -${h * 20 + 1},20 +${h * 20 + 1},20 @@`)
      for (let j = 0; j < 19; j++) lines.push(' context line')
      lines.push(`-old sparse line ${h}`)
    }
    const out = compress(f, lines.join('\n'), argv)
    // With max_hunks_per_file=2 the density cap keeps only the 2 dense hunks
    // and reports the 3 dropped low-density ones by this exact message —
    // impossible to see at all when the cap is hardcoded to 0 (disabled).
    expect(out).toMatch(/\[\.\.\. 3 more hunks, avg density [\d.]+ — likely whitespace\/formatting\]/)
    expect(out).toContain('new dense line 0')
    expect(out).toContain('new dense line 1')
  })

  it('emits MORE than 3 hunks per file when max_hunks_per_file is configured above 3 (regression: a hardcoded stage-2 cap of 3 shadowed the config)', () => {
    const cfg = defaultConfig()
    cfg.bash_diff.max_hunks_per_file = 10 // above the former hardcoded cap of 3
    saveConfig(cfg)

    const f = new DiffFilter()
    const argv = ['diff', '-u', 'a.txt', 'b.txt']
    const lines: string[] = ['--- a/file.ts', '+++ b/file.ts']
    // Six dense hunks (all changed lines) — none should be dropped by the
    // density cap (6 <= 10). Before the fix, stage 2 re-capped to 3.
    // Padded past the 50-non-empty-line passthrough threshold so compression
    // (and the cap under test) actually runs.
    for (let h = 0; h < 6; h++) {
      lines.push(`@@ -${h * 20 + 1},10 +${h * 20 + 1},10 @@`)
      for (let j = 0; j < 5; j++) {
        lines.push(`-old dense line ${h}-${j}`)
        lines.push(`+new dense line ${h}-${j}`)
      }
    }
    const out = compress(f, lines.join('\n'), argv)
    // All six hunks must survive — the single config-driven cap is 10.
    for (let h = 0; h < 6; h++) {
      expect(out).toContain(`new dense line ${h}-0`)
    }
    // And no "elided" second-stage message, since nothing was elided.
    expect(out).not.toMatch(/more hunks in this file elided/)
  })
})

// ---------------------------------------------------------------------------
// FfmpegFilter
// ---------------------------------------------------------------------------

describe('FfmpegFilter dispatch', () => {
  const f = new FfmpegFilter()

  it('matches ffmpeg', () => expect(f.matches(['ffmpeg', '-i', 'input.mp4', 'output.mp3'])).toBe(true))
  it('matches ffprobe', () => expect(f.matches(['ffprobe', 'video.mp4'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('FfmpegFilter compression', () => {
  const f = new FfmpegFilter()
  const argv = ['ffmpeg', '-i', 'input.mp4', 'output.mp3']

  it('strips ffmpeg build-noise preamble and preserves stream info', () => {
    const out = [
      'ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers',
      '  built with gcc 12.2.0 (GCC)',
      '  configuration: --prefix=/usr --enable-gpl --enable-libx264',
      '  libavutil      58.  2.100 / 58.  2.100',
      '  libavcodec     60.  3.100 / 60.  3.100',
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':",
      '  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s',
      '    Stream #0:0(und): Video: h264',
      "Output #0, mp3, to 'output.mp3':",
      '    Stream #0:1(und): Audio: mp3',
      'frame=    0 fps=0.0 q=-0.0 size=       0kB time=00:00:00.50 bitrate=   0.0kbits/s',
      'frame= 2500 fps= 25 q=-0.0 Lsize=   12345kB time=00:01:23.45 bitrate=1234.5kbits/s',
      'video:0kB audio:12345kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.04%',
    ].join('\n')
    const result = compress(f, out, argv)
    // Build noise should be suppressed
    expect(result).not.toContain('--prefix=/usr')
    // Stream/input/output info should survive
    expect(result).toMatch(/Stream|Input|Output|video:|audio:/)
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// BinaryInspectFilter
// ---------------------------------------------------------------------------

describe('BinaryInspectFilter dispatch', () => {
  const f = new BinaryInspectFilter()

  it('matches xxd', () => expect(f.matches(['xxd', 'file.bin'])).toBe(true))
  it('matches hexdump', () => expect(f.matches(['hexdump', '-C', 'file.bin'])).toBe(true))
  it('matches od', () => expect(f.matches(['od', '-An', '-tx1', 'file.bin'])).toBe(true))
  it('matches hd', () => expect(f.matches(['hd', 'file.bin'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('BinaryInspectFilter compression', () => {
  const f = new BinaryInspectFilter()
  const argv = ['xxd', 'file.bin']

  it('identifies PNG magic bytes in xxd output', () => {
    // PNG magic: 89 50 4e 47 0d 0a 1a 0a
    const out = '00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  .PNG........IHDR'
    const result = compress(f, out, argv)
    expect(result.toLowerCase()).toMatch(/png|identified|magic|image/)
  })

  it('passes through short hex dump without throwing', () => {
    const out = [
      '00000000: 504b 0304 1400 0000 0800 2b5c 5756 f92a  PK........+\\WV.*',
      '00000010: e900 1c00 0000 0000 0000 0000 1600 0000  ................',
      '00000020: 7465 7374 2e74 7874 4c4f 4e47 4c49 5354  test.txtLONGLIST',
    ].join('\n')
    expect(() => compress(f, out, argv)).not.toThrow()
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// FileTypeFilter
// ---------------------------------------------------------------------------

describe('FileTypeFilter dispatch', () => {
  const f = new FileTypeFilter()

  it('matches file', () => expect(f.matches(['file', 'binary.bin'])).toBe(true))
  it('matches file with -b flag', () => expect(f.matches(['file', '-b', 'image.png'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('FileTypeFilter compression', () => {
  const f = new FileTypeFilter()
  const argv = ['file', '--mime-type', '*']

  it('passes through small file output (trailing whitespace stripped)', () => {
    const out = 'image.png: image/png\ndoc.pdf: application/pdf'
    expect(compress(f, out, argv)).toBe(out.trimEnd())
  })

  it('truncates large file output', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `file${i}.ts: text/plain; charset=utf-8`)
    const out = compress(f, lines.join('\n'), argv)
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })
})

// ---------------------------------------------------------------------------
// PsFilter
// ---------------------------------------------------------------------------

describe('PsFilter dispatch', () => {
  const f = new PsFilter()

  it('matches ps', () => expect(f.matches(['ps', 'aux'])).toBe(true))
  it('matches top', () => expect(f.matches(['top'])).toBe(true))
  it('matches pstree', () => expect(f.matches(['pstree'])).toBe(true))
  it('matches tasklist on Windows', () => expect(f.matches(['tasklist'])).toBe(true))
  it('does not match empty argv', () => expect(f.matches([])).toBe(false))
})

describe('PsFilter compression', () => {
  const f = new PsFilter()
  const argv = ['ps', 'aux']

  it('preserves column header and active processes in ps output', () => {
    const header = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND'
    const devProc = 'user     12345  2.5  3.0 512000 122880 pts/1  Sl+  10:00   5:00 node /home/user/project/node_modules/.bin/vitest'
    const lines = [header, devProc]
    const result = compress(f, lines.join('\n'), argv)
    expect(result).toContain('USER')
    expect(result).toContain('vitest')
  })

  it('suppresses idle low-resource processes from large ps output', () => {
    const header = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND'
    const idle = Array.from({ length: 30 }, (_, i) =>
      `user       ${100 + i}  0.0  0.1  12345  4096 ?        Ss   Jan01   0:00 /usr/lib/systemd/systemd-${i}`)
    const devProc = 'user     12345  2.5  3.0 512000 122880 pts/1  Sl+  10:00   5:00 node /home/user/project/node_modules/.bin/vitest'
    const lines = [header, ...idle, devProc]
    const out = compress(f, lines.join('\n'), argv)
    // dev process should be kept
    expect(out).toContain('vitest')
    // output should be smaller — idle processes dropped
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('returns empty output for empty stdout', () => {
    expect(compress(f, '', argv)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// PsFilter.detect — TUI detection
// ---------------------------------------------------------------------------

describe('PsFilter.detect', () => {
  it('detects ps output with PID header', () => {
    const out = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND'
    expect(PsFilter.detect(out)).toBe(true)
  })

  it('detects top output via "top -" prefix', () => {
    const out = 'top - 10:00:00 up 1 day\nTasks: 200 total'
    expect(PsFilter.detect(out)).toBe(true)
  })

  it('does not detect normal command output', () => {
    expect(PsFilter.detect('hello world')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Registry — SHELL_FILE_FILTERS ordering and registration
// ---------------------------------------------------------------------------

describe('SHELL_FILE_FILTERS registry', () => {
  it('RgFilter precedes GrepFilter in SHELL_FILE_FILTERS', () => {
    const rgIdx = SHELL_FILE_FILTERS.findIndex((f) => f instanceof RgFilter)
    const grepIdx = SHELL_FILE_FILTERS.findIndex((f) => f instanceof GrepFilter)
    expect(rgIdx).toBeGreaterThanOrEqual(0)
    expect(grepIdx).toBeGreaterThan(rgIdx)
  })

  it('DiffFilter precedes LsFilter in SHELL_FILE_FILTERS', () => {
    const diffIdx = SHELL_FILE_FILTERS.findIndex((f) => f instanceof DiffFilter)
    const lsIdx = SHELL_FILE_FILTERS.findIndex((f) => f instanceof LsFilter)
    expect(diffIdx).toBeGreaterThanOrEqual(0)
    expect(lsIdx).toBeGreaterThan(diffIdx)
  })

  // EzaFilter must precede LsFilter: its matches() gate falls through to a plain `ls` (see
  // EzaFilter.matches doc comment), so it needs first crack at claiming an aliased
  // `ls --tree`/`ls --icons`/etc. invocation.
  it('EzaFilter precedes LsFilter in SHELL_FILE_FILTERS', () => {
    const ezaIdx = SHELL_FILE_FILTERS.findIndex((f) => f instanceof EzaFilter)
    const lsIdx = SHELL_FILE_FILTERS.findIndex((f) => f instanceof LsFilter)
    expect(ezaIdx).toBeGreaterThanOrEqual(0)
    expect(lsIdx).toBeGreaterThan(ezaIdx)
  })

  it('all 20 filters are present in SHELL_FILE_FILTERS', () => {
    const classes = [
      GrepFilter, RgFilter, LsFilter, EzaFilter, TreeFilter,
      FdFilter, WcFilter, BatFilter, DeltaFilter, FzfFilter,
      LazyGitFilter, JqFilter, YqFilter, CurlFilter, RsyncFilter,
      DiffFilter, FfmpegFilter, BinaryInspectFilter, FileTypeFilter, PsFilter,
    ]
    for (const Cls of classes) {
      expect(SHELL_FILE_FILTERS.some((f) => f instanceof Cls)).toBe(true)
    }
    expect(SHELL_FILE_FILTERS).toHaveLength(20)
  })

  // RgFilter is registered before GrepFilter and also claims 'grep'/'rg', but its matches()
  // now gates on context flags (-A/-B/-C/--context), so a plain grep/rg with no context
  // flags falls through to GrepFilter's per-file match-count summarizer.
  it('selectFilter dispatches plain grep (no context flags) to GrepFilter', () => {
    expect(selectFilter(['grep', '-r', 'TODO', '.'])).toBeInstanceOf(GrepFilter)
  })

  it('selectFilter dispatches grep with a context flag to RgFilter', () => {
    expect(selectFilter(['grep', '-C', '3', 'TODO', '.'])).toBeInstanceOf(RgFilter)
  })

  it('selectFilter dispatches plain rg (no context flags) to GrepFilter', () => {
    expect(selectFilter(['rg', 'TODO'])).toBeInstanceOf(GrepFilter)
  })

  it('selectFilter dispatches rg with a context flag to RgFilter', () => {
    expect(selectFilter(['rg', '-C', '3', 'TODO'])).toBeInstanceOf(RgFilter)
  })

  it('selectFilter dispatches ls to LsFilter', () => {
    expect(selectFilter(['ls', '-la'])).toBeInstanceOf(LsFilter)
  })

  // Regression: EzaFilter's own 'ls' binary claim was unreachable dead code when LsFilter was
  // registered first -- an `alias ls=eza` shell setup running `ls --tree` (token-goat only ever
  // sees the literal "ls --tree" text, never the shell's alias resolution) was always routed to
  // LsFilter's generic ls-format compressor instead of EzaFilter's tree-aware one.
  it('selectFilter dispatches ls --tree (aliased eza) to EzaFilter, not LsFilter', () => {
    expect(selectFilter(['ls', '--tree'])).toBeInstanceOf(EzaFilter)
  })

  // 'eza' is only claimed by EzaFilter (LsFilter no longer double-claims it), so a real `eza` invocation gets EzaFilter's tree/column-aware compression.
  it('selectFilter dispatches eza to EzaFilter, not LsFilter', () => {
    expect(selectFilter(['eza', '--long'])).toBeInstanceOf(EzaFilter)
  })

  it('selectFilter dispatches exa to EzaFilter (only EzaFilter claims exa)', () => {
    expect(selectFilter(['exa', '--long'])).toBeInstanceOf(EzaFilter)
  })

  it('selectFilter dispatches tree', () => {
    expect(selectFilter(['tree'])).toBeInstanceOf(TreeFilter)
  })

  it('selectFilter dispatches fd', () => {
    expect(selectFilter(['fd', '.ts'])).toBeInstanceOf(FdFilter)
  })

  it('selectFilter dispatches wc', () => {
    expect(selectFilter(['wc', '-l', 'file.txt'])).toBeInstanceOf(WcFilter)
  })

  it('selectFilter dispatches bat', () => {
    expect(selectFilter(['bat', 'file.ts'])).toBeInstanceOf(BatFilter)
  })

  it('selectFilter dispatches delta', () => {
    expect(selectFilter(['delta'])).toBeInstanceOf(DeltaFilter)
  })

  it('selectFilter dispatches fzf', () => {
    expect(selectFilter(['fzf'])).toBeInstanceOf(FzfFilter)
  })

  it('selectFilter dispatches lazygit', () => {
    expect(selectFilter(['lazygit'])).toBeInstanceOf(LazyGitFilter)
  })

  it('selectFilter dispatches jq', () => {
    expect(selectFilter(['jq', '.', 'data.json'])).toBeInstanceOf(JqFilter)
  })

  it('selectFilter dispatches yq', () => {
    expect(selectFilter(['yq', '.version', 'config.yaml'])).toBeInstanceOf(YqFilter)
  })

  it('selectFilter dispatches curl', () => {
    expect(selectFilter(['curl', 'https://example.com'])).toBeInstanceOf(CurlFilter)
  })

  it('selectFilter dispatches wget', () => {
    expect(selectFilter(['wget', 'https://example.com'])).toBeInstanceOf(CurlFilter)
  })

  it('selectFilter dispatches rsync', () => {
    expect(selectFilter(['rsync', '-avz', 'src/', 'dst/'])).toBeInstanceOf(RsyncFilter)
  })

  it('selectFilter dispatches diff', () => {
    expect(selectFilter(['diff', 'a.txt', 'b.txt'])).toBeInstanceOf(DiffFilter)
  })

  it('selectFilter dispatches ffmpeg', () => {
    expect(selectFilter(['ffmpeg', '-i', 'in.mp4', 'out.mp3'])).toBeInstanceOf(FfmpegFilter)
  })

  it('selectFilter dispatches xxd', () => {
    expect(selectFilter(['xxd', 'file.bin'])).toBeInstanceOf(BinaryInspectFilter)
  })

  it('selectFilter dispatches file', () => {
    expect(selectFilter(['file', 'binary'])).toBeInstanceOf(FileTypeFilter)
  })

  it('selectFilter dispatches ps', () => {
    expect(selectFilter(['ps', 'aux'])).toBeInstanceOf(PsFilter)
  })
})
