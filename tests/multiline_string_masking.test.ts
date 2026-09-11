import { describe, it, expect } from 'vitest'
import { extractCsharp } from '../src/languages/csharp.js'
import { extractPhp } from '../src/languages/php.js'
import { extractKotlin } from '../src/languages/kotlin.js'
import { extractScala } from '../src/languages/scala.js'
import { extractDart } from '../src/languages/dart.js'
import { extractPowershell } from '../src/languages/powershell_idx.js'
import { stripMultilineStringSpan, type MultilineStringState } from '../src/languages/common.js'

// ---------------------------------------------------------------------------
// Regression coverage for the multi-line string forms `stripStringLiterals`'s own
// doc comment calls out as gaps: PHP heredoc/nowdoc, Kotlin/C# triple-quoted raw
// strings, C# verbatim strings, and PowerShell here-strings. Each of these can
// contain an unbalanced `{`/`}` and span multiple lines - before the shared
// `stripMultilineStringSpan` masking, such a brace desynced the regex adapters'
// brace-depth counters, mis-parenting or dropping every symbol declared after the
// string closed.
//
// Every `?.docstring).toBe('Before'|'After')` assertion below was updated to `?.parent` when
// the `symbols.parent` column was added: the containing class name these regex adapters recover
// for a method now lives in its own `parent` field, not overloaded into `docstring` (see
// db.ts's SCHEMA_SQL comment for the full history). What each assertion actually verifies --
// that scope tracking survived the multi-line string without desyncing -- is unchanged.
// ---------------------------------------------------------------------------

describe('PHP heredoc/nowdoc multi-line masking', () => {
  it('does not let braces inside a heredoc desync scope depth', () => {
    const content = `<?php
class Before {
    public function beforeMethod() {
        return 1;
    }
}

$text = <<<EOT
This heredoc has a brace { that would desync depth counting
and another one }
EOT;

class After {
    public function afterMethod() {
        return 2;
    }
}
`
    const { symbols } = extractPhp(content, 'heredoc.php')
    const before = symbols.find((s) => s.name === 'beforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
    // The class declarations themselves must also still resolve correctly.
    expect(symbols.find((s) => s.name === 'Before')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'After')?.kind).toBe('class')
  })

  it('does not let braces inside a nowdoc desync scope depth', () => {
    const content = `<?php
class Before {
    public function beforeMethod() {
        return 1;
    }
}

$text = <<<'EOT'
This nowdoc has a brace { that would desync depth counting
and another one }
EOT;

class After {
    public function afterMethod() {
        return 2;
    }
}
`
    const { symbols } = extractPhp(content, 'nowdoc.php')
    const before = symbols.find((s) => s.name === 'beforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('recognizes a PHP 7.3+ indented heredoc closing marker', () => {
    const content = `<?php
class Before {
    public function beforeMethod() {
        return 1;
    }
}

function withHeredoc() {
    $text = <<<EOT
        Indented heredoc body { with a brace }
        EOT;
    return $text;
}

class After {
    public function afterMethod() {
        return 2;
    }
}
`
    const { symbols } = extractPhp(content, 'indented_heredoc.php')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })
})

describe('Kotlin triple-quoted raw string multi-line masking', () => {
  it('does not let braces inside a """ raw string desync scope depth', () => {
    const content = `class Before {
  fun beforeMethod(): Int {
    return 1
  }
}

val text = """
This raw string has a brace { that would desync depth counting
and another one }
""".trimIndent()

class After {
  fun afterMethod(): Int {
    return 2
  }
}
`
    const { symbols } = extractKotlin(content, 'raw_string.kt')
    const before = symbols.find((s) => s.name === 'beforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('does not treat a """ appearing inside an already-open single-line string literal as a raw-string opener (mirrors the PHP heredoc-inside-string guard)', () => {
    // One unescaped `"` precedes the `"""` run, so isInsideStringLiteral is true at that
    // index -- pre-fix, findMultilineOpener had no such guard for Kotlin and would have
    // misdetected this as opening a real multi-line raw string.
    const { code, state } = stripMultilineStringSpan('val x = "before """', null, 'kotlin')
    expect(code).toBe('val x = "before """')
    expect(state).toBeNull()
  })

  it('registers a genuine second raw-string opener after a first raw string closes mid-line, even when the closed string\'s own content contains an odd (unbalanced) apostrophe (fail-on-buggy: isInsideStringLiteral scanned from index 0 instead of from `from`, so the closed string\'s dangling apostrophe made the second opener look like it was still inside a single-quoted string)', () => {
    const openState: MultilineStringState = { kind: 'tripleQuote', identifier: '3' }
    const { state } = stripMultilineStringSpan(`it's""" val b = """`, openState, 'kotlin')
    // The first `"""` (closing the carried-in raw string) lands right after `it's`; that
    // content -- not real code, just the already-closed string's own body -- contains a lone
    // apostrophe. Scanning isInsideStringLiteral from index 0 (pre-fix) reads that dangling
    // apostrophe as an unclosed single-quoted string spanning all the way to the second `"""`,
    // wrongly vetoing it as "inside a string literal" and leaving mlState null.
    expect(state).not.toBeNull()
    expect(state?.kind).toBe('tripleQuote')
  })

  it('handles a single-line """ raw string without breaking later symbols', () => {
    const content = `class Before {
  fun beforeMethod(): Int {
    return 1
  }
}

val text = """a brace { in a one-line raw string }"""

class After {
  fun afterMethod(): Int {
    return 2
  }
}
`
    const { symbols } = extractKotlin(content, 'raw_string_oneline.kt')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })
})

describe('PowerShell here-string multi-line masking', () => {
  it('does not let braces inside a @"..."@ here-string desync scope depth', () => {
    const content = `class Before {
  BeforeMethod() {
    Write-Host "before"
  }
}

$text = @"
This here-string has a brace { that would desync depth counting
and another one }
"@

function AfterFunction {
  Write-Host "after"
}
`
    const { symbols } = extractPowershell(content, 'here_string.ps1')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterFunction')
    expect(after?.kind).toBe('function')
  })

  it('does not let braces inside a @\'...\'@ here-string desync scope depth', () => {
    const content = `class Before {
  BeforeMethod() {
    Write-Host "before"
  }
}

$text = @'
This here-string has a brace { that would desync depth counting
and another one }
'@

function AfterFunction {
  Write-Host "after"
}
`
    const { symbols } = extractPowershell(content, 'here_string_single.ps1')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterFunction')
    expect(after?.kind).toBe('function')
  })
})

describe('C# verbatim string multi-line masking', () => {
  it('does not let braces inside a @"..." verbatim string desync scope depth', () => {
    const content = `public class Before {
    public void BeforeMethod() {
    }
}

public class Holder {
    public string Text = @"
This verbatim string has a brace { that would desync depth counting
and another one }
";
}

public class After {
    public void AfterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'verbatim.cs')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('treats a doubled "" inside a verbatim string as an escaped quote, not a closer', () => {
    const content = `public class Before {
    public void BeforeMethod() {
    }
}

public class Holder {
    public string Text = @"she said ""hello { world }"" today";
}

public class After {
    public void AfterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'verbatim_escaped_quote.cs')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('registers a genuine second verbatim-string opener after a first verbatim string closes mid-line, even when the closed string\'s own content contains an http:// URL (fail-on-buggy: lineCommentStartIndex scanned from index 0 instead of from `from`, so the closed string\'s http:// looked like a real // line comment)', () => {
    const openState: MultilineStringState = { kind: 'verbatim', identifier: '' }
    const { state } = stripMultilineStringSpan('http://x"; var b = @"', openState, 'csharp')
    // The first `"` (closing the carried-in verbatim string) lands right after `http://x`; that
    // content is the already-closed string's own body, not real code. Scanning
    // lineCommentStartIndex from index 0 (pre-fix) reads its `http://` as a real `//` line
    // comment starting at index 5, wrongly vetoing the genuine `var b = @"` opener at index 19
    // as "inside a comment" and leaving mlState null.
    expect(state).not.toBeNull()
    expect(state?.kind).toBe('verbatim')
  })

  it('registers a genuine second verbatim-string opener after a first verbatim string closes mid-line, even when the closed string\'s own content contains an unbalanced /* (fail-on-buggy: isInsideSameLineBlockComment scanned from index 0 instead of from `from`, so the closed string\'s dangling /* made the second opener look like it was still inside a block comment)', () => {
    const openState: MultilineStringState = { kind: 'verbatim', identifier: '' }
    const { state } = stripMultilineStringSpan('/* unterminated"; var b = @"', openState, 'csharp')
    // The first `"` (closing the carried-in verbatim string) lands right after `/*
    // unterminated`; that content is the already-closed string's own body, not real code.
    // Scanning isInsideSameLineBlockComment from index 0 (pre-fix) reads its unbalanced `/*` as
    // a real block-comment opener with no closer on the line, wrongly vetoing the genuine
    // `var b = @"` opener as "inside a block comment" and leaving mlState null.
    expect(state).not.toBeNull()
    expect(state?.kind).toBe('verbatim')
  })
})

describe('C# raw string ("""...""") multi-line masking', () => {
  it('does not let braces inside a """ raw string desync scope depth', () => {
    const content = `public class Before {
    public void BeforeMethod() {
    }
}

public class Holder {
    public string Text = """
This raw string has a brace { that would desync depth counting
and another one }
""";
}

public class After {
    public void AfterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'raw_string.cs')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('does not treat a """ appearing inside an already-open single-line string literal as a raw-string opener', () => {
    // Same guard as the Kotlin case above: one unescaped `"` precedes the `"""` run.
    const { code, state } = stripMultilineStringSpan('var x = "before """', null, 'csharp')
    expect(code).toBe('var x = "before """')
    expect(state).toBeNull()
  })

  it('recognizes a C# 11+ 4-quote raw string delimiter (not just the fixed 3-quote form), including content that itself contains a run of 3 quotes', () => {
    const content = `public class Before {
    public void BeforeMethod() {
    }
}

public class Holder {
    public string Text = """"
This raw string contains an embedded run of quotes: """ and a brace { that would desync depth counting }
"""";
}

public class After {
    public void AfterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'raw_string_4quote.cs')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('recognizes a C# 11+ 5-quote raw string delimiter', () => {
    const content = `public class Before {
    public void BeforeMethod() {
    }
}

public class Holder {
    public string Text = """""
This raw string contains an embedded run of quotes: """" and a brace { that would desync depth counting }
""""";
}

public class After {
    public void AfterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'raw_string_5quote.cs')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('masks a same-line 4-quote raw string (with a 3-quote run embedded as content) and resumes normal code after it', () => {
    const { code, state } = stripMultilineStringSpan('var s = """"abc """ def""""; var y = 2;', null, 'csharp')
    expect(state).toBeNull()
    expect(code.endsWith('; var y = 2;')).toBe(true)
    expect(code).not.toContain('abc')
    expect(code).not.toContain('def')
  })

  it('same-line closer: masks the full matched quote-run when it is longer than the opener, leaving no stray quote characters behind (regression: maskEnd used the opener length instead of the matched closer length)', () => {
    const { code, state } = stripMultilineStringSpan('var s = """abc""""; var y = 2;', null, 'csharp')
    expect(state).toBeNull()
    expect(code.endsWith('; var y = 2;')).toBe(true)
    expect(code).not.toContain('abc')
    expect(code).not.toContain('"')
  })

  it('multi-line closer: masks the full matched quote-run on the closing line when it is longer than the opener (regression: closesSameLine/maskEnd used tripleLen instead of the matched closer length)', () => {
    const content = `public class Before {
    public void BeforeMethod() {
    }
}

public class Holder {
    public string Text = """
line one
""""; public string Trailing = "leftover";
}

public class After {
    public void AfterMethod() {
    }
}
`
    const { symbols } = extractCsharp(content, 'raw_string_closer_longer_than_opener.cs')
    const before = symbols.find((s) => s.name === 'BeforeMethod')
    expect(before?.kind).toBe('method')
    expect(before?.parent).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })
})

// ---------------------------------------------------------------------------
// Interaction with existing single-line string/comment handling: multi-line masking
// must not break single-line strings, or lines that contain no multi-line-string
// opener at all.
// ---------------------------------------------------------------------------

describe('stripMultilineStringSpan interaction with single-line content', () => {
  it('leaves a line with no opener completely unchanged', () => {
    const { code, state } = stripMultilineStringSpan('const x = 1 + 2;', null, 'csharp')
    expect(code).toBe('const x = 1 + 2;')
    expect(state).toBeNull()
  })

  it('does not treat a regular single-line string as a multi-line opener', () => {
    const { code, state } = stripMultilineStringSpan('var s = "just a normal string with a { brace }";', null, 'csharp')
    expect(code).toBe('var s = "just a normal string with a { brace }";')
    expect(state).toBeNull()
  })

  it('masks a same-line verbatim string and resumes normal code after it', () => {
    const { code, state } = stripMultilineStringSpan('var s = @"one line { verbatim }"; var y = 2;', null, 'csharp')
    expect(state).toBeNull()
    expect(code.endsWith('; var y = 2;')).toBe(true)
    expect(code).not.toContain('{')
    expect(code).not.toContain('}')
  })

  it('does not treat <<< inside a normal quoted string as a heredoc opener', () => {
    const { code, state } = stripMultilineStringSpan('$s = "not <<<REAL a heredoc";', null, 'php')
    expect(code).toBe('$s = "not <<<REAL a heredoc";')
    expect(state).toBeNull()
  })

  it('carries state across lines and closes on the matching identifier', () => {
    const first = stripMultilineStringSpan('$text = <<<EOT', null, 'php')
    expect(first.state).not.toBeNull()
    const second = stripMultilineStringSpan('body { with a brace }', first.state, 'php')
    expect(second.code.trim()).toBe('')
    expect(second.state).not.toBeNull()
    const third = stripMultilineStringSpan('EOT;', second.state, 'php')
    expect(third.state).toBeNull()
    expect(third.code).toBe('   ;')
  })

  it('does not open a here-string when @" is not the last token on the line', () => {
    const { code, state } = stripMultilineStringSpan('$s = @"not a here-string opener" + 1', null, 'powershell')
    expect(state).toBeNull()
    expect(code).toBe('$s = @"not a here-string opener" + 1')
  })

  it('round-trips a full heredoc span end to end across three lines', () => {
    let state: MultilineStringState | null = null
    const lines = ['$text = <<<EOT', 'has a { brace }', 'EOT;']
    const masked: string[] = []
    for (const line of lines) {
      const result = stripMultilineStringSpan(line, state, 'php')
      masked.push(result.code)
      state = result.state
    }
    expect(state).toBeNull()
    expect(masked.join('\n')).not.toContain('{')
    expect(masked.join('\n')).not.toContain('}')
    expect(masked[2]).toBe('   ;')
  })
})

// Regression: findMultilineOpener did not check whether opener-shaped text (e.g. `<<<EOT`,
// `"""`, `@"`) sat inside a real `//`/`#` line comment before treating it as a genuine opener.
// An opener that never closes (no matching closer anywhere later in the file) then masked
// every remaining line as string content until EOF, silently dropping every symbol declared
// after the commented-out example.
describe('comment-awareness: opener-shaped text inside a real line comment is not a real opener', () => {
  it('PHP: does not open a heredoc from opener-shaped text inside a // comment', () => {
    const content = `<?php
class Before {
    public function beforeMethod() {
        return 1;
    }
}

// example usage: <<<EOT usage pattern
class After {
    public function afterMethod() {
        return 2;
    }
}
`
    const { symbols } = extractPhp(content, 'commented_heredoc.php')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('Kotlin: does not open a raw string from opener-shaped text inside a // comment', () => {
    const content = `class Before {
  fun beforeMethod(): Int {
    return 1
  }
}

// looks risky: """{ but is just a line comment
class After {
  fun afterMethod(): Int {
    return 2
  }
}
`
    const { symbols } = extractKotlin(content, 'commented_raw_string.kt')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('C#: does not open a raw string from opener-shaped text inside a // comment', () => {
    const content = `class Before {
    public int BeforeMethod() {
        return 1;
    }
}

// looks risky: """{ but is just a line comment
class After {
    public int AfterMethod() {
        return 2;
    }
}
`
    const { symbols } = extractCsharp(content, 'commented_raw_string.cs')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('C#: does not open a verbatim string from opener-shaped text inside a // comment', () => {
    const content = `class Before {
    public int BeforeMethod() {
        return 1;
    }
}

// looks risky: @"{ but is just a line comment
class After {
    public int AfterMethod() {
        return 2;
    }
}
`
    const { symbols } = extractCsharp(content, 'commented_verbatim_string.cs')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.parent).toBe('After')
  })

  it('PowerShell: does not open a here-string from opener-shaped text inside a # comment', () => {
    const content = `class Before {
  BeforeMethod() {
    Write-Host "before"
  }
}

# example usage: @"
function AfterFunction {
  Write-Host "after"
}
`
    const { symbols } = extractPowershell(content, 'commented_here_string.ps1')
    const after = symbols.find((s) => s.name === 'AfterFunction')
    expect(after?.kind).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Scala and Dart multi-line string literals. Both languages were declared
// `tripleQuote: true` (Dart also `tripleSingleQuote: true`) for brace-span
// assignment in `src/parser.ts`, but neither extractor carried any multi-line
// string state, so a declaration-shaped line inside a `"""` / `'''` body was
// extracted as a real symbol.
//
// Fixture provenance: FORMAT-DERIVED. The delimiters come from the Scala
// Language Specification, chapter 1 "Lexical Syntax", section 1.3.5 "String
// Literals" (multi-line string literals, delimited by `"""`), and from the Dart
// Programming Language Specification, section "Strings" (multi-line strings
// delimited by `'''` or `"""`, with the `r` prefix marking a raw string). The
// surrounding declarations are ordinary source in each language.
// ---------------------------------------------------------------------------

describe('Scala """ multi-line string masking', () => {
  it('does not extract declaration-shaped content inside a """ string as real symbols', () => {
    const content = `package probe

object Queries {
  val sql: String = """
class FabricatedClass {
  def fabricatedMethod(x: Int): Int = x
}
val fabricatedVal = 1
"""

  def realMethod(y: Int): Int = y + 1
}

class RealClass {
  def realOther(): Unit = ()
}
`
    const { symbols } = extractScala(content, 'probe.scala')
    const names = symbols.map((s) => s.name)
    // Must not appear: every one of these is string content, not a declaration.
    expect(names).not.toContain('FabricatedClass')
    expect(names).not.toContain('fabricatedMethod')
    expect(names).not.toContain('fabricatedVal')
    // Must survive: the real declarations on both sides of the string.
    expect(symbols.find((s) => s.name === 'Queries')?.kind).toBe('object')
    expect(symbols.find((s) => s.name === 'sql')?.kind).toBe('val')
    expect(symbols.find((s) => s.name === 'realMethod')?.parent).toBe('Queries')
    expect(symbols.find((s) => s.name === 'RealClass')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'realOther')?.parent).toBe('RealClass')
  })

  it('does not let an unbalanced brace inside a """ string desync scope depth', () => {
    const content = `object Outer {
  val broken = """
  {{{ unbalanced braces }
  """

  def stillMine(): Int = 1
}

class Sibling {
  def siblingMethod(): Int = 2
}
`
    const { symbols } = extractScala(content, 'unbalanced.scala')
    expect(symbols.find((s) => s.name === 'stillMine')?.parent).toBe('Outer')
    expect(symbols.find((s) => s.name === 'Sibling')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'siblingMethod')?.parent).toBe('Sibling')
  })

  it('keeps a declaration that merely follows a same-line """ string (masking must not swallow real code)', () => {
    const content = `object Holder {
  val greeting = """hello { world }"""
  def afterInline(): Int = 3
  val tail = 4
}
`
    const { symbols } = extractScala(content, 'inline.scala')
    expect(symbols.find((s) => s.name === 'greeting')?.kind).toBe('val')
    expect(symbols.find((s) => s.name === 'afterInline')?.parent).toBe('Holder')
    expect(symbols.find((s) => s.name === 'tail')?.parent).toBe('Holder')
  })
})

describe('Dart multi-line string masking', () => {
  it("does not extract declaration-shaped content inside a ''' string as real symbols", () => {
    const content = `class RealDart {
  static const String tpl = '''
class FabricatedDartClass {
}
void fabricatedDartFn() {}
''';

  void realDartMethod() {}
}

void realTopLevel() {}
`
    const { symbols } = extractDart(content, 'probe.dart')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('FabricatedDartClass')
    expect(names).not.toContain('fabricatedDartFn')
    expect(symbols.find((s) => s.name === 'RealDart')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'realDartMethod')?.parent).toBe('RealDart')
    expect(symbols.find((s) => s.name === 'realTopLevel')?.kind).toBe('function')
  })

  it('does not extract declaration-shaped content inside a """ string as real symbols', () => {
    const content = `class DoubleQuoted {
  static const String tpl = """
class FabricatedDoubleClass {
}
void fabricatedDoubleFn() {}
""";

  void realDoubleMethod() {}
}
`
    const { symbols } = extractDart(content, 'double.dart')
    const names = symbols.map((s) => s.name)
    expect(names).not.toContain('FabricatedDoubleClass')
    expect(names).not.toContain('fabricatedDoubleFn')
    expect(symbols.find((s) => s.name === 'DoubleQuoted')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'realDoubleMethod')?.parent).toBe('DoubleQuoted')
  })

  it('keeps a declaration that merely follows a same-line multi-line string (masking must not swallow real code)', () => {
    const content = `class Inline {
  static const String one = '''a brace { in a one-line string }''';
  void afterInline() {}
  int tail = 4;
}
`
    const { symbols } = extractDart(content, 'inline.dart')
    expect(symbols.find((s) => s.name === 'Inline')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'afterInline')?.parent).toBe('Inline')
  })

  it('does not treat an ordinary single-quoted string as a multi-line opener', () => {
    const content = `class Ordinary {
  String name = 'plain';
  String empty = '';
  void stillHere() {}
}
`
    const { symbols } = extractDart(content, 'ordinary.dart')
    expect(symbols.find((s) => s.name === 'Ordinary')?.kind).toBe('class')
    expect(symbols.find((s) => s.name === 'stillHere')?.parent).toBe('Ordinary')
  })
})
