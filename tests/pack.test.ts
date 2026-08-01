import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { stripComments, scanSecrets, formatMarkdown, formatXml, formatPlain, collectFiles, estimateBudget, formatBudgetText } from '../src/pack.js'
import { estimateTokens as sharedEstimateTokens } from '../src/overflow_guard.js'

// Mutable flag consumed by the 'node:fs' mock below, letting a single test simulate a
// TOCTOU dev/ino mismatch for one specific realpath while every other fs.statSync call
// (in this file's setup/teardown and in every other test) passes through unmodified.
const toctouMismatchPath: { value: string | null } = vi.hoisted(() => ({ value: null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    statSync: ((p: fs.PathLike, opts?: unknown) => {
      const real = actual.statSync(p, opts as never)
      if (toctouMismatchPath.value !== null && p === toctouMismatchPath.value) {
        return { ...real, dev: real.dev + 1, ino: real.ino + 1 } as fs.Stats
      }
      return real
    }) as typeof fs.statSync,
  }
})

// Capability probe: creating a real symlink on Windows requires either an
// elevated shell or Developer Mode. Run it once at module load so the suite
// below can skip cleanly (with a reason) on a locked-down runner instead of
// failing every test with EPERM.
const CAN_SYMLINK = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-symlink-probe-'))
  try {
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'x')
    fs.symlinkSync(target, path.join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pack-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('stripComments', () => {
  it('strips Python line comments', () => {
    const code = 'x = 1  # comment\ny = 2  # another\n'
    const result = stripComments(code, 'file.py')
    expect(result).toContain('x = 1')
    expect(result).toContain('y = 2')
    expect(result).not.toContain('comment')
  })

  it('strips TypeScript block comments', () => {
    const code = 'const x = 1; /* comment */ const y = 2;'
    const result = stripComments(code, 'file.ts')
    expect(result).toContain('const x')
    expect(result).toContain('const y')
    expect(result).not.toContain('comment')
  })

  it('preserves shebangs', () => {
    const code = '#!/bin/bash\n# regular comment\necho test\n'
    const result = stripComments(code, 'script.sh')
    expect(result).toContain('#!/bin/bash')
  })

  it('returns unchanged for unknown extensions', () => {
    const code = 'some code # comment'
    const result = stripComments(code, 'file.unknown')
    expect(result).toBe(code)
  })

  it('leaves a URL inside a string literal untouched (does not mistake // for a comment)', () => {
    const code = "const url = 'https://example.com'"
    const result = stripComments(code, 'file.ts')
    expect(result).toBe(code)
  })

  it('leaves a CSS hex color inside a string literal untouched (does not mistake # for a comment)', () => {
    const code = 'COLOR="#fff"\necho "$COLOR"\n'
    const result = stripComments(code, 'script.sh')
    expect(result).toBe(code)
  })

  it('leaves a block-comment-looking sequence inside a string literal untouched (.ts)', () => {
    const code = 'const s = "a /* b */ c"'
    const result = stripComments(code, 'file.ts')
    expect(result).toBe(code)
  })

  it('still strips a real block comment outside any string literal (.ts)', () => {
    const code = '/* real comment */\nconst x = 1'
    const result = stripComments(code, 'file.ts')
    expect(result).not.toContain('real comment')
    expect(result).toContain('const x = 1')
  })

  it('leaves a block-comment-looking sequence inside a string literal untouched (.css)', () => {
    const code = 'content: "a /* b */ c";'
    const result = stripComments(code, 'file.css')
    expect(result).toBe(code)
  })

  it('strips a real comment after a string ending in an escaped backslash (Python)', () => {
    const code = 'path = "C:\\\\\\\\"\n# real comment'
    const result = stripComments(code, 'file.py')
    expect(result).not.toContain('real comment')
    expect(result).toContain('path = "C:\\\\\\\\"')
  })

  it('strips a real comment after a string ending in an escaped backslash (TypeScript)', () => {
    const code = 'const path = "C:\\\\\\\\"; // real comment'
    const result = stripComments(code, 'file.ts')
    expect(result).not.toContain('real comment')
    expect(result).toContain('const path = "C:\\\\\\\\"')
  })

  it('handles multiple escaped backslashes correctly in a Python string', () => {
    const code = 'path = "a\\\\\\\\\\\\\\\\"  # trailing comment\ncode = 1'
    const result = stripComments(code, 'file.py')
    expect(result).not.toContain('trailing comment')
    expect(result).toContain('code = 1')
  })

  it('leaves a `#`-looking sequence inside a multi-line Python triple-quoted string untouched', () => {
    // Regression: isInsideStringLiteral only counted quote characters from the start of the
    // CURRENT line, so a triple-quoted string opened on an earlier line looked "not open" on
    // every subsequent line, and a `#` inside its content on one of those lines was misread as
    // a real comment and stripped, corrupting the string's content.
    const code = 'x = """\n# not a comment, just text inside the string\nstill text\n"""\ny = 1\n'
    const result = stripComments(code, 'file.py')
    expect(result).toContain('# not a comment, just text inside the string')
    expect(result).toContain('still text')
    expect(result).toContain('y = 1')
  })

  it('still strips a real comment on a later line after an apostrophe inside a double-quoted string (.ts)', () => {
    // Regression: advanceQuoteState tracked dq/sq/bt as independent toggles instead of a single
    // mutually-exclusive "which quote is open" state (unlike languages/common.ts's
    // isInsideStringLiteral, which explicitly guards against this). An apostrophe inside a
    // double-quoted string (e.g. "don't") flipped the independent `sq` flag to open and it never
    // closed, since the string's own closing `"` only resets `dq`. That stray open `sq` state then
    // carried into computeLineStartQuoteStates for every subsequent line, permanently misclassifying
    // a real trailing `//` comment as "inside a string" and leaving it unstripped.
    const code = 'const s = "don\'t panic";\n// real comment\nconst y = 1;\n'
    const result = stripComments(code, 'file.ts')
    expect(result).not.toContain('real comment')
    expect(result).toContain('const y = 1;')
  })

  it('leaves a `//`-looking sequence inside a multi-line template literal untouched (.ts)', () => {
    // Same regression as the Python triple-quoted-string case above, for a JS/TS template
    // literal that spans multiple lines.
    const code = 'const x = `hello\n// not a comment, just text\nworld`;\nconst y = 1;\n'
    const result = stripComments(code, 'file.ts')
    expect(result).toContain('// not a comment, just text')
    expect(result).toContain('world`;')
    expect(result).toContain('const y = 1;')
  })
})

describe('scanSecrets', () => {
  it('detects AWS access keys', () => {
    const files = [
      {
        path: 'config.py',
        rel_path: 'config.py',
        content: 'aws_key = AKIAIOSFODNN7EXAMPLE',
        lines: 1,
        tokens: 10,
      },
    ]
    const hits = scanSecrets(files)
    expect(hits.length).toBe(1)
    expect(hits[0].kind).toBe('AWS access key')
  })

  it('skips safe file extensions', () => {
    const files = [
      {
        path: 'image.png',
        rel_path: 'image.png',
        content: 'fake aws secret AKIAIOSFODNN7EXAMPLE',
        lines: 1,
        tokens: 10,
      },
    ]
    const hits = scanSecrets(files)
    expect(hits.length).toBe(0)
  })

  it('detects a single-quoted or unspaced api_key assignment', () => {
    const files = [
      {
        path: 'a.py',
        rel_path: 'a.py',
        content: "api_key='abc123DEF456ghi789JKL012'",
        lines: 1,
        tokens: 10,
      },
      {
        path: 'b.py',
        rel_path: 'b.py',
        content: 'api_key = abc123DEF456ghi789JKL012',
        lines: 1,
        tokens: 10,
      },
    ]
    const hits = scanSecrets(files)
    expect(hits.length).toBe(2)
    expect(hits.every((h) => h.kind === 'Generic API key')).toBe(true)
  })

  // Regression (mutation-testing gap): once a line matches one secret pattern, scanning stops
  // for that line (`break`) -- one hit per line, not one per matching pattern -- so a line that
  // happens to match two patterns at once (e.g. an AWS key sitting next to a GitHub token) still
  // only reports the first. A mutation dropping the `break` still passed the full suite, since no
  // fixture line matches more than one pattern.
  it('reports only the first matching pattern per line, not every pattern that matches', () => {
    const files = [
      {
        path: 'creds.py',
        rel_path: 'creds.py',
        content: 'AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        lines: 1,
        tokens: 20,
      },
    ]
    const hits = scanSecrets(files)
    expect(hits.length).toBe(1)
    // Not just "one hit" -- specifically the first pattern in SECRET_PATTERNS order (AWS access
    // key), proving the `break` stopped scanning after the first match rather than, say,
    // scanning stopped for an unrelated reason (e.g. a dedup step) while still checking every
    // pattern and keeping the last one.
    expect(hits[0]!.kind).toBe('AWS access key')
  })
})

describe('formatMarkdown', () => {
  it('includes file count and token estimate', () => {
    const result = {
      files: [
        { path: 'f.ts', rel_path: 'f.ts', content: 'code', lines: 1, tokens: 1 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 1,
    }
    const md = formatMarkdown(result)
    expect(md).toContain('1 file')
    expect(md).toContain('tokens')
  })

  // Regression (mutation-testing gap): the file-count noun is singular ('file') only for exactly
  // one file, plural ('files') otherwise -- a mutation that hardcoded 'files' unconditionally
  // still passed the full suite, since the existing "1 file" assertion is also a substring of
  // "1 files" and can't tell the two apart. Pin the exact boundary with a word-boundary match.
  it('uses the singular noun for exactly 1 file and the plural noun otherwise', () => {
    const one = formatMarkdown({
      files: [{ path: 'f.ts', rel_path: 'f.ts', content: 'x', lines: 1, tokens: 1 }],
      skipped: [],
      total_lines: 1,
      total_tokens: 1,
    })
    expect(one).toMatch(/\*\*1 file ·/)

    const zero = formatMarkdown({ files: [], skipped: [], total_lines: 0, total_tokens: 0 })
    expect(zero).toMatch(/\*\*0 files ·/)
  })

  it('formats file sections correctly', () => {
    const result = {
      files: [
        { path: 'test.js', rel_path: 'test.js', content: 'const x = 1', lines: 1, tokens: 5 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 5,
    }
    const md = formatMarkdown(result)
    expect(md).toContain('## `test.js`')
    expect(md).toContain('```javascript')
  })

  // Regression (mutation-testing gap): getLang falls back to '' (a bare fence, no language tag)
  // for an extension not in LANG_MAP, so a code renderer never sees a bogus/guessed language
  // for a file type it doesn't recognize. A mutation falling back to a non-empty placeholder
  // like 'text' still passed the full suite, since no fixture packs a file with an unknown
  // extension.
  it('uses a bare code fence (no language tag) for an unrecognized file extension', () => {
    const result = {
      files: [
        { path: 'notes.xyz', rel_path: 'notes.xyz', content: 'some notes', lines: 1, tokens: 3 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 3,
    }
    const md = formatMarkdown(result)
    expect(md).toContain('## `notes.xyz`\n\n```\n')
  })

  // Regression (mutation-testing gap): the skipped-files note only appends '...' when more than
  // 3 files were skipped (only the first 3 are listed by name), so a skip count of exactly 3
  // must render every name with no trailing ellipsis. A mutation appending '...' unconditionally
  // still passed the full suite, since no fixture exercises the skipped-file note at all.
  it('omits the ellipsis on the skipped-files note when exactly 3 files were skipped', () => {
    const result = {
      files: [],
      skipped: ['a.ts (too large)', 'b.ts (too large)', 'c.ts (too large)'],
      total_lines: 0,
      total_tokens: 0,
    }
    const md = formatMarkdown(result)
    // The closing '*' immediately after the last name already pins that nothing (an ellipsis or
    // otherwise) was inserted between the last name and the end of the note.
    expect(md).toContain('Skipped 3 file(s): a.ts (too large), b.ts (too large), c.ts (too large)*')
  })

  it('appends an ellipsis on the skipped-files note when more than 3 files were skipped', () => {
    const result = {
      files: [],
      skipped: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      total_lines: 0,
      total_tokens: 0,
    }
    const md = formatMarkdown(result)
    expect(md).toContain('Skipped 4 file(s): a.ts, b.ts, c.ts...')
  })
})

describe('formatXml', () => {
  it('wraps files in document elements', () => {
    const result = {
      files: [
        { path: 'f.py', rel_path: 'f.py', content: 'x = 1', lines: 1, tokens: 2 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 2,
    }
    const xml = formatXml(result)
    expect(xml).toContain('<documents>')
    expect(xml).toContain('<document')
    expect(xml).toContain('<source>f.py</source>')
    expect(xml).toContain('</documents>')
  })

  // Regression (mutation-testing gap): escapeXml must escape '&' (in addition to '<' and '>'),
  // so file content containing a literal ampersand doesn't produce malformed XML (an unescaped
  // '&' followed by other content isn't a valid XML entity reference). A mutation dropping the
  // '&' replacement still passed the full suite, since no fixture's content/path contains '&'.
  it('escapes a literal ampersand in file content, not just < and >', () => {
    const result = {
      files: [
        { path: 'f.ts', rel_path: 'f.ts', content: 'a && b < c', lines: 1, tokens: 5 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 5,
    }
    const xml = formatXml(result)
    expect(xml).toContain('a &amp;&amp; b &lt; c')
  })
})

describe('formatPlain', () => {
  it('includes separator and file headers', () => {
    const result = {
      files: [
        { path: 'f.ts', rel_path: 'f.ts', content: 'code', lines: 1, tokens: 1 },
      ],
      skipped: [],
      total_lines: 1,
      total_tokens: 1,
    }
    const text = formatPlain(result)
    expect(text).toContain('File: f.ts')
    expect(text).toContain('=====')
  })
})

describe('symlink escape guard', () => {
  // On Windows, fs.symlinkSync can throw EPERM without elevation or
  // Developer Mode enabled. Skip (not fail) the whole suite when this
  // environment can't create symlinks — see CAN_SYMLINK probe above.
  it.skipIf(!CAN_SYMLINK)('collectFiles does not embed content from a symlink pointing outside the project root', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pack-outside-'))
    try {
      const secretPath = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretPath, 'TOP_SECRET_OUTSIDE_ROOT_VALUE')

      const linkPath = path.join(TMP, 'escape-link.txt')
      fs.symlinkSync(secretPath, linkPath)

      const result = collectFiles(TMP, ['escape-link.txt'])

      const leaked = result.files.some((f) => f.content.includes('TOP_SECRET_OUTSIDE_ROOT_VALUE'))
      expect(leaked).toBe(false)
      expect(result.skipped.some((s) => s.includes('escape-link.txt'))).toBe(true)
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it.skipIf(!CAN_SYMLINK)('collectFiles still reads a symlink that points inside the project root', () => {
    const targetPath = path.join(TMP, 'real.txt')
    fs.writeFileSync(targetPath, 'inside root content')

    const linkPath = path.join(TMP, 'inside-link.txt')
    fs.symlinkSync(targetPath, linkPath)

    const result = collectFiles(TMP, ['inside-link.txt'])

    expect(result.files.some((f) => f.content.includes('inside root content'))).toBe(true)
  })

  it.skipIf(!CAN_SYMLINK)('estimateBudget does not stat a symlink pointing outside the project root', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-budget-outside-'))
    try {
      const secretPath = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretPath, 'TOP_SECRET_OUTSIDE_ROOT_VALUE')

      const linkPath = path.join(TMP, 'escape-link.txt')
      fs.symlinkSync(secretPath, linkPath)

      const result = estimateBudget(TMP, ['escape-link.txt'])

      expect(result.entries.some((e) => e.rel_path.includes('escape-link.txt'))).toBe(false)
      expect(result.skipped.some((s) => s.includes('escape-link.txt'))).toBe(true)
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  // Regression (mutation-testing gap): isPathWithinRoot uses path.relative rather than a naive
  // string-prefix check, specifically so a sibling directory that merely shares root's path as a
  // literal string prefix (e.g. root's own path with '-evil' appended) is never mistaken for a
  // path inside root. A mutation to `resolvedPath.startsWith(rootReal)` still passed the full
  // suite, since the existing outside-root fixtures use an unrelated mkdtempSync directory whose
  // path never happens to share root's exact string prefix.
  it.skipIf(!CAN_SYMLINK)('collectFiles does not embed content from a sibling dir sharing a string prefix with root', () => {
    const siblingDir = `${TMP}-evil`
    fs.mkdirSync(siblingDir)
    try {
      const secretPath = path.join(siblingDir, 'secret.txt')
      fs.writeFileSync(secretPath, 'TOP_SECRET_SIBLING_PREFIX_VALUE')

      const linkPath = path.join(TMP, 'prefix-escape-link.txt')
      fs.symlinkSync(secretPath, linkPath)

      const result = collectFiles(TMP, ['prefix-escape-link.txt'])

      const leaked = result.files.some((f) => f.content.includes('TOP_SECRET_SIBLING_PREFIX_VALUE'))
      expect(leaked).toBe(false)
      expect(result.skipped.some((s) => s.includes('prefix-escape-link.txt'))).toBe(true)
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true })
    }
  })

  // Regression (mutation-testing gap): openWithinRoot opens the fd first, then separately
  // resolves the realpath and re-stats it, and cross-checks that realStat's dev/ino match the
  // already-open fd's own fstatSync result -- specifically to detect a TOCTOU race where the
  // path was repointed between the open and the identity verification. A mutation that dropped
  // this dev/ino comparison (`void realStat; void stat` in place of the check) still passed the
  // full suite, since no existing fixture forces fs.statSync(realPath) to disagree with the
  // already-open fd's fstatSync result. A real filesystem race can't be triggered deterministically
  // in a synchronous test, so this simulates it by mocking fs.statSync to return a mismatched
  // dev/ino for the target file's realpath only, leaving every other fs.statSync call untouched.
  it('collectFiles treats a post-open dev/ino identity mismatch as an escape, not a benign in-root file', () => {
    const targetPath = path.join(TMP, 'toctou-target.txt')
    fs.writeFileSync(targetPath, 'TOCTOU_SHOULD_NOT_LEAK')
    const realTargetPath = fs.realpathSync(targetPath)

    toctouMismatchPath.value = realTargetPath
    try {
      const result = collectFiles(TMP, ['toctou-target.txt'])

      const leaked = result.files.some((f) => f.content.includes('TOCTOU_SHOULD_NOT_LEAK'))
      expect(leaked).toBe(false)
      expect(result.skipped.some((s) => s.includes('toctou-target.txt'))).toBe(true)
    } finally {
      toctouMismatchPath.value = null
    }
  })
})

describe('collectFiles token estimation matches the shared ratio', () => {
  it('uses the same chars-per-token ratio as overflow_guard.estimateTokens instead of its own drifted one', () => {
    // A 25%-lighter local ratio (chars/4 instead of chars/3) would silently let
    // `token-goat pack --budget N` admit content the rest of the codebase considers
    // over-budget, since cmdPack's budget gate compares against this same field.
    const content = 'x'.repeat(300)
    fs.writeFileSync(path.join(TMP, 'sample.ts'), content)
    const result = collectFiles(TMP, ['sample.ts'])
    const pf = result.files[0]
    expect(pf).toBeDefined()
    expect(pf!.tokens).toBe(sharedEstimateTokens(content))
  })
})

describe('estimateBudget token estimation', () => {
  it('scales the token estimate for files bigger than the 100000-byte sample, like it already does for lines', () => {
    const filePath = path.join(TMP, 'big.txt')
    // 1,020,000 bytes total, well past the 100000-byte token sample cap.
    fs.writeFileSync(filePath, ('x'.repeat(50) + '\n').repeat(20000))

    const result = estimateBudget(TMP, ['big.txt'])

    const entry = result.entries[0]
    expect(entry).toBeDefined()
    // A capped, un-extrapolated estimate would report ~25000 (100000 / 4); the true
    // size-proportional estimate is ~255000 (1020000 / 4).
    expect(entry!.tokens).toBeGreaterThan(200000)
  })
})

describe('formatBudgetText', () => {
  it('formats budget output with proper column alignment (no stray commas)', () => {
    const result = {
      entries: [
        { rel_path: 'file1.ts', lines: 100, tokens: 500, size_bytes: 2000 },
        { rel_path: 'file2.py', lines: 200, tokens: 1000, size_bytes: 4000 },
      ],
      skipped: [],
      total_lines: 300,
      total_tokens: 1500,
    }
    const output = formatBudgetText(result)
    const lines = output.split('\n')
    
    // Header row should have no commas
    expect(lines[0]).not.toContain(',')
    expect(lines[0]).toContain('Lines')
    expect(lines[0]).toContain('~Tokens')
    
    // Separator row should have no commas
    expect(lines[1]).not.toContain(',')
    
    // Data rows should have no stray commas after numeric columns
    expect(lines[2]).not.toMatch(/\s\d+,\s+\d+,/)
    expect(lines[3]).not.toMatch(/\s\d+,\s+\d+,/)
    
    // Total row should have no stray commas after numeric columns
    const totalLine = lines.find((l) => l.includes('Total'))
    expect(totalLine).toBeDefined()
    expect(totalLine).not.toMatch(/\s\d+,\s+\d+,/)
    
    // Verify numeric values are right-aligned and line up properly
    expect(lines[2]).toContain('100')
    expect(lines[2]).toContain('500')
    expect(lines[3]).toContain('200')
    expect(lines[3]).toContain('1000')
  })

  it('does not crash with RangeError on a very large entry count (Math.max spread over the call-stack limit)', () => {
    // Regression for a Math.max(...array) column-width computation that blew the engine's
    // call-stack limit once the entries array crossed ~100k-130k items -- exactly the file
    // count a `token-goat budget`/`token-goat tokens` glob can realistically match on a large
    // monorepo. Below that threshold Math.max(...array) works fine, so a small fixture would
    // not have caught this; the array must actually be large enough to overflow the spread.
    const entries = Array.from({ length: 150_000 }, (_, i) => ({
      rel_path: `file${i}.ts`,
      lines: 10,
      tokens: 20,
      size_bytes: 100,
    }))
    const result = { entries, skipped: [], total_lines: entries.length * 10, total_tokens: entries.length * 20 }
    expect(() => formatBudgetText(result)).not.toThrow()
  })

  // Regression (mutation-testing gap): the skipped-files note only appends '...' when more than
  // 5 files were skipped (only the first 5 are listed by name), so a skip count of exactly 5
  // must list every name with no trailing ellipsis. A mutation appending '...' unconditionally
  // still passed the full suite, since no fixture exercises the skipped-file note at all.
  it('omits the ellipsis on the skipped note when exactly 5 files were skipped', () => {
    const result = {
      entries: [],
      skipped: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      total_lines: 0,
      total_tokens: 0,
    }
    const output = formatBudgetText(result)
    // Anchored to end-of-string (the skip note is always the last line) rather than a blanket
    // not.toContain('...') over the whole output, which could false-fail on unrelated ellipsis
    // text elsewhere in the report.
    expect(output).toMatch(/\n {2}Skipped: a\.ts, b\.ts, c\.ts, d\.ts, e\.ts$/)
  })

  it('appends an ellipsis on the skipped note when more than 5 files were skipped', () => {
    const result = {
      entries: [],
      skipped: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      total_lines: 0,
      total_tokens: 0,
    }
    const output = formatBudgetText(result)
    expect(output).toContain('Skipped: a.ts, b.ts, c.ts, d.ts, e.ts...')
  })
})
