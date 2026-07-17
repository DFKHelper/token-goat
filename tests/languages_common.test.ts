import { describe, expect, it } from 'vitest'
import { stripBlockCommentSpan, stripCstyleComments, stripSqlLineComments } from '../src/languages/common.js'

// ---------------------------------------------------------------------------
// stripBlockCommentSpan (and the private isInsideStringLiteral it delegates
// to) - shared by php.ts and csharp.ts to decide whether a `/*` on a line is
// a real block-comment opener or just two characters that happen to appear
// inside a string literal (e.g. `glob('src/*.php')`).
//
// isInsideStringLiteral must track "is a string open right now, and with
// which quote character" as a single state machine - not two independent
// odd/even parity counters for `"` and `'`. A real line of code can only be
// inside one kind of string at a time, since a `'` can't open a nested
// string while a `"`-delimited string is already open.
// ---------------------------------------------------------------------------

describe('stripBlockCommentSpan', () => {
  it('treats /* as a real comment opener after a closed double-quoted string containing an apostrophe (fail-on-buggy: independent single/double-quote parity counters misread the apostrophe in "don\'t" as an open single-quoted string)', () => {
    const line = `const msg = "don't panic"; /* real comment starts here`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(true)
    expect(result.code.trimEnd()).toBe(`const msg = "don't panic";`)
    expect(result.code.length).toBe(line.length)
  })

  it('strips the full body of a comment opened after an apostrophe-containing double-quoted string, across lines', () => {
    const opening = stripBlockCommentSpan(`const msg = "don't panic"; /* start`, false)
    const middle = stripBlockCommentSpan(`  this line should be fully hidden`, opening.inComment)
    const closing = stripBlockCommentSpan(`end */ realCode()`, middle.inComment)
    expect(opening.inComment).toBe(true)
    expect(middle.inComment).toBe(true)
    expect(middle.code.trim()).toBe('')
    expect(closing.inComment).toBe(false)
    expect(closing.code.trim()).toBe('realCode()')
  })

  it('does not treat /* inside a single-quoted string as a comment opener (glob(\'src/*.php\'))', () => {
    const line = `$files = glob('src/*.php');`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).toBe(line)
  })

  it('handles a single-quoted string that contains a double quote', () => {
    const line = `$s = 'he said "hi" to /* not a comment */ me';`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).toBe(line)
  })

  it('handles empty strings without leaving the quote state stuck open', () => {
    const line = `const a = ""; const b = ''; /* real comment */ const c = 1`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('real comment')
    expect(result.code.startsWith(`const a = ""; const b = ''; `)).toBe(true)
    expect(result.code.trimEnd().endsWith('const c = 1')).toBe(true)
  })

  it('does not toggle string state on an escaped quote', () => {
    const line = 'const s = "say \\"hi\\""; /* real comment */ const d = 1'
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('real comment')
  })

  it('treats /* as a real comment opener after a string ending with an escaped backslash (Windows path: "C:\\\\Users\\\\"; /* comment */)', () => {
    const line = `var x = "C:\\\\Users\\\\"; /* real comment */`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('real comment')
    expect(result.code.trim()).toBe(`var x = "C:\\\\Users\\\\";`)
  })

  it('recognizes a second /* comment on the same line after an earlier stripped comment contained an odd number of quote characters (fail-on-buggy: isInsideStringLiteral rescanning from column 0 instead of the current scan position misreads the apostrophe in the already-stripped "it\'s fine" comment as leaving a string open)', () => {
    const line = `/* it's fine */ /* another comment */ realCode();`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('another comment')
    expect(result.code.trim()).toBe('realCode();')
  })

  it('blank-pads a same-line comment span with spaces instead of deleting it (regression: unlike its sibling stripCstyleComments, this function used to splice the comment out entirely with no replacement, concatenating the tokens on either side when the comment had no surrounding whitespace)', () => {
    const line = 'public/*x*/static void Foo()'
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('publicstatic')
    // '/*x*/' (5 chars) is replaced by 5 spaces, preserving column offsets like stripCstyleComments does.
    expect(result.code).toBe('public     static void Foo()')
  })
})

describe('stripCstyleComments', () => {
  it('recognizes a second /* comment on the same line after an earlier stripped comment contained an odd number of quote characters', () => {
    const text = `/* it's fine */ /* another comment */ realCode();`
    const stripped = stripCstyleComments(text)
    expect(stripped).not.toContain('another comment')
    expect(stripped.trim()).toBe('realCode();')
  })
})

// ---------------------------------------------------------------------------
// stripSqlLineComments - SQL line comment stripper that must be quote-aware
// to avoid blanking SQL code when a `--` marker appears inside a string
// literal (e.g., COMMENT ON COLUMN followed by a description string, or a
// CHECK constraint, or a DEFAULT value). Must match the quote-awareness of
// stripHashComments and stripLineComment above.
// ---------------------------------------------------------------------------

describe('stripSqlLineComments', () => {
  it('strips a real SQL line comment (-- comment text)', () => {
    const line = 'SELECT * FROM users -- this is a comment'
    const result = stripSqlLineComments(line)
    expect(result.length).toBe(line.length)
    expect(result.trim()).toBe('SELECT * FROM users')
  })

  it('does not strip -- inside a single-quoted string literal (fail-on-buggy: silent data loss)', () => {
    const line = `COMMENT ON COLUMN foo.bar IS 'discount -- see note'; CREATE TABLE Baz (id INT);`
    const result = stripSqlLineComments(line)
    // The key assertion: CREATE TABLE is preserved (not blanked by the -- inside the string)
    expect(result).toContain('CREATE TABLE Baz (id INT);')
  })

  it('does not strip -- inside a double-quoted string literal', () => {
    const line = `SELECT "column--name" FROM tbl -- real comment`
    const result = stripSqlLineComments(line)
    expect(result).toContain('"column--name"')
    // The key assertion: real comment is blanked, but the column name is preserved
    expect(result.trim()).toBe(`SELECT "column--name" FROM tbl`)
  })

  it('handles multiple -- markers, stopping at the first unquoted one', () => {
    const line = `SELECT 'text -- inside' AS col1, 'more -- text' AS col2 -- real comment`
    const result = stripSqlLineComments(line)
    expect(result).toContain('text -- inside')
    expect(result).toContain('more -- text')
    expect(result.trim()).toBe(`SELECT 'text -- inside' AS col1, 'more -- text' AS col2`)
  })

  it('preserves line spacing by blanking with spaces instead of removing text', () => {
    const original = 'SELECT id FROM tbl -- comment'
    const result = stripSqlLineComments(original)
    expect(result.length).toBe(original.length)
    expect(result.trim()).toBe('SELECT id FROM tbl')
  })

  it('handles strings with escaped quotes correctly', () => {
    const line = `SELECT 'O''Brien' AS name -- comment`
    const result = stripSqlLineComments(line)
    expect(result).toContain(`'O''Brien'`)
    expect(result.trim()).toBe(`SELECT 'O''Brien' AS name`)
  })

  it('preserves newlines in multi-line text', () => {
    const text = `SELECT * FROM users -- comment line 1
SELECT * FROM orders -- comment line 2`
    const result = stripSqlLineComments(text)
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('SELECT * FROM users')
    expect(lines[1]).toContain('SELECT * FROM orders')
  })
})
