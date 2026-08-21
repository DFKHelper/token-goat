import { describe, expect, it } from 'vitest'
import { buildLineIndex, findMatchingBraceEndLine, stripBlockCommentSpan, stripCstyleComments, stripSqlLineComments } from '../src/languages/common.js'
import { countContentLines } from '../src/util.js'
import { extractR } from '../src/languages/r.js'
import { extractLwcJavaScript } from '../src/languages/salesforce_frontend.js'
import { extractAstro, extractSvelte, extractVue } from '../src/languages/sfc_idx.js'
import { extractGraphql } from '../src/languages/graphql_idx.js'
import { extractHtml } from '../src/languages/html.js'
import { extractIni } from '../src/languages/ini_idx.js'
import { extractLiquid } from '../src/languages/liquid.js'
import { extractMakefile } from '../src/languages/makefile_idx.js'
import { extractProto } from '../src/languages/proto_idx.js'
import { extractSql } from '../src/languages/sql_idx.js'
import { extractTerraform } from '../src/languages/terraform_idx.js'

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


// ---------------------------------------------------------------------------
// findMatchingBraceEndLine's line-comment awareness is opt-in. Its long-standing
// callers (proto_idx, terraform_idx) hand it content whose comments are already
// stripped, so switching the walk on for everyone would make it pay for a second
// pass and, worse, would apply one language's comment marker to another's code.
// r.ts walks the raw file and does pass a marker.
// ---------------------------------------------------------------------------

describe('findMatchingBraceEndLine line comments', () => {
  const src = ['f <- function(x) {', '  # a closing } in prose', '  x', '}', ''].join('\n')
  const open = src.indexOf('{')

  it('ignores a closing brace inside a comment when given the marker', () => {
    expect(findMatchingBraceEndLine(src, open, 5, buildLineIndex(src), '#')).toBe(4)
  })

  it('still counts that brace when no marker is given, so existing callers are unchanged', () => {
    expect(findMatchingBraceEndLine(src, open, 5, buildLineIndex(src))).toBe(2)
  })
})

describe('findMatchingBraceEndLine block comments (opt-in)', () => {
  it('ignores a closing brace inside a /* */ block comment when given the delimiters', () => {
    const src = ['void f() {', '  /* a stray } in a comment */', '  x;', '}', ''].join('\n')
    const open = src.indexOf('{')
    expect(findMatchingBraceEndLine(src, open, 5, buildLineIndex(src), '//', { blockComment: ['/*', '*/'] })).toBe(4)
  })

  it('still counts that brace when no block-comment delimiters are given, so existing callers are unchanged', () => {
    const src = ['void f() {', '  /* a stray } in a comment */', '  x;', '}', ''].join('\n')
    const open = src.indexOf('{')
    // Without the opt-in, the `}` inside the comment closes the block early (line 2).
    expect(findMatchingBraceEndLine(src, open, 5, buildLineIndex(src), '//')).toBe(2)
  })

  it('returns the noMatchValue when the brace never closes, instead of totalLines', () => {
    const src = ['void f() {', '  x;', '  // no closing brace', ''].join('\n')
    const open = src.indexOf('{')
    expect(findMatchingBraceEndLine(src, open, 4, buildLineIndex(src), '//', { noMatchValue: -1 })).toBe(-1)
  })

  it('defaults noMatchValue to totalLines so existing callers are unchanged', () => {
    const src = ['void f() {', '  x;', '  // no closing brace', ''].join('\n')
    const open = src.indexOf('{')
    expect(findMatchingBraceEndLine(src, open, 4, buildLineIndex(src), '//')).toBe(4)
  })
})


// ---------------------------------------------------------------------------
// countContentLines and the flat-section span ceiling.
//
// Every adapter that lays sections out flat (no brace nesting to close a span)
// hands assignFlatEndLines a `totalLines` figure, and the last section in the
// file inherits it verbatim as its end line. Eight adapters computed that
// figure as `content.split('\n').length`, which counts a phantom final element
// for any file that ends in a newline - i.e. essentially every real file. The
// result was a last symbol whose span ran exactly one line past EOF, and a
// `skeleton` line count reported one line too high.
//
// Why no test caught it: the adapter suites all asserted on the symbols a
// fixture produced - names, kinds, start lines - and their fixtures were
// written as inline template literals that mostly did not end in a newline, so
// the off-by-one never fired. Nothing asserted the invariant that binds every
// adapter at once: no symbol may end past the last line that actually exists.
// These cases assert that invariant directly, on newline-terminated input, for
// all eight adapters.
// ---------------------------------------------------------------------------

describe('countContentLines', () => {
  it('does not count the phantom element a trailing newline leaves behind', () => {
    expect(countContentLines('a\nb\nc\n')).toBe(3)
  })

  it('counts the last line of content that does not end in a newline', () => {
    expect(countContentLines('a\nb\nc')).toBe(3)
  })

  it('reports an empty string as zero lines', () => {
    expect(countContentLines('')).toBe(0)
  })

  it('counts a single line that ends in a newline as one line', () => {
    expect(countContentLines('a\n')).toBe(1)
  })

  it('counts a lone newline as one line', () => {
    expect(countContentLines('\n')).toBe(1)
  })

  it('counts CRLF-terminated content without the phantom element', () => {
    expect(countContentLines('a\r\nb\r\n')).toBe(2)
  })
})

describe('flat-section adapters never end a symbol past EOF', () => {
  /**
   * The highest end line anything the adapter extracted claims, or 0 when it
   * found nothing. Adapters surface flat spans either as symbols or as a
   * separate sections array, and both inherit `totalLines` on the last entry,
   * so both count.
   */
  function maxEnd(spans: ReadonlyArray<{ lineEnd?: number; lineStart?: number; endLine?: number; line?: number }>): number {
    let hi = 0
    for (const span of spans) {
      const end = span.lineEnd ?? span.endLine ?? span.lineStart ?? span.line ?? 0
      if (end > hi) hi = end
    }
    return hi
  }

  const cases: Array<{ lang: string; content: string; extract: (c: string) => ReadonlyArray<{ lineEnd?: number; lineStart?: number; endLine?: number; line?: number }> }> = [
    {
      lang: 'html',
      content: '<html>\n<body>\n<h1 id="top">Title</h1>\n<h2>Sub</h2>\n</body>\n</html>\n',
      extract: (c) => [...extractHtml(c, 'a.html').symbols, ...extractHtml(c, 'a.html').sections],
    },
    {
      lang: 'liquid',
      content: '{% comment %}x{% endcomment %}\n<h1>One</h1>\n{% assign a = 1 %}\n<h2>Two</h2>\n',
      extract: (c) => extractLiquid(c, 'b.liquid').sections,
    },
    {
      lang: 'graphql',
      content: 'type Query {\n  a: String\n}\n\ntype Mutation {\n  b: String\n}\n',
      extract: (c) => extractGraphql(c, 'c.graphql').symbols,
    },
    {
      lang: 'makefile',
      content: 'all:\n\techo one\n\nclean:\n\techo two\n',
      extract: (c) => extractMakefile(c, 'Makefile'),
    },
    {
      lang: 'ini',
      content: '[first]\nkey = 1\n\n[second]\nother = 2\n',
      extract: (c) => extractIni(c, 'd.ini'),
    },
    {
      // A trailing statement with no closing brace or semicolon leaves the span
      // to `totalLines`, which is what makes this case discriminating.
      lang: 'sql',
      content: 'CREATE TABLE a (id INT);\n\nCREATE VIEW v AS SELECT 1\n',
      extract: (c) => extractSql(c, 'e.sql'),
    },
    {
      // Terraform and proto close their last symbol at a brace, so `totalLines`
      // never reaches a span here and these two stay green on both sides of the
      // fix. They are kept as invariant guards: a future adapter change that
      // starts leaning on `totalLines` would be caught without new test work.
      lang: 'terraform',
      content: 'resource "aws_s3_bucket" "one" {\n  bucket = "x"\n}\n\nvariable "two" {\n  type = string\n}\n',
      extract: (c) => extractTerraform(c, 'f.tf'),
    },
    {
      lang: 'proto',
      content: 'message One {\n  string a = 1;\n}\n\nmessage Two {\n  string b = 1;\n}\n',
      extract: (c) => extractProto(c, 'g.proto').symbols,
    },
  ]

  for (const { lang, content, extract } of cases) {
    it(`keeps every ${lang} symbol inside the file (fail-on-buggy: split('\\n').length counts a phantom line for newline-terminated input)`, () => {
      const real = countContentLines(content)
      const symbols = extract(content)
      expect(symbols.length).toBeGreaterThan(0)
      expect(maxEnd(symbols)).toBeLessThanOrEqual(real)
    })
  }

  // Vue, Svelte, Astro and LWC emit a symbol for the whole component, spanning
  // line 1 to the end of the file, so the phantom line landed on every single
  // file those adapters saw rather than only on the last section of some.
  const wholeFileCases: Array<{ lang: string; file: string; content: string; extract: (c: string, f: string) => ReadonlyArray<{ lineEnd?: number; lineStart?: number }> }> = [
    {
      lang: 'vue',
      file: 'Card.vue',
      content: '<template>\n  <div>hi</div>\n</template>\n\n<script setup>\nconst a = 1\n</script>\n',
      extract: (c, f) => extractVue(c, f).symbols,
    },
    {
      lang: 'svelte',
      file: 'Card.svelte',
      content: '<script>\n  let a = 1\n</script>\n\n<div>{a}</div>\n',
      extract: (c, f) => extractSvelte(c, f).symbols,
    },
    {
      lang: 'astro',
      file: 'Card.astro',
      content: '---\nconst a = 1\n---\n\n<div>{a}</div>\n',
      extract: (c, f) => extractAstro(c, f).symbols,
    },
    {
      lang: 'lwc',
      file: 'accountCard/accountCard.js',
      content: "import { LightningElement, api } from 'lwc'\n\nexport default class AccountCard extends LightningElement {\n  @api recordId\n}\n",
      extract: (c, f) => extractLwcJavaScript(c, f).symbols,
    },
  ]

  for (const { lang, file, content, extract } of wholeFileCases) {
    it(`keeps the whole-file ${lang} symbol inside the file (fail-on-buggy: the component span was taken straight from split('\\n').length)`, () => {
      const symbols = extract(content, file)
      expect(symbols.length).toBeGreaterThan(0)
      expect(maxEnd(symbols)).toBe(countContentLines(content))
    })
  }

  it('keeps an R body with no closing brace inside the file (fail-on-buggy: the unterminated-body fallback end line was the phantom line)', () => {
    const content = 'f <- function(x) {\n  x + 1\n'
    const symbols = extractR(content, 'a.R').symbols
    expect(symbols.length).toBeGreaterThan(0)
    expect(maxEnd(symbols)).toBeLessThanOrEqual(countContentLines(content))
  })

  it('still spans the final line when the file does not end in a newline', () => {
    const content = '[first]\nkey = 1\n\n[second]\nother = 2'
    const symbols = extractIni(content, 'h.ini')
    expect(maxEnd(symbols)).toBe(countContentLines(content))
  })
})
