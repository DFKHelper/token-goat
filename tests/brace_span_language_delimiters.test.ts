import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// The brace walk used to derive its block-comment delimiters from the line-comment prefix: any language spelling line comments `//` was assumed to spell block comments `/* */`. Zig spells line comments `//` but has no block comment at all, so an ordinary `a/*b` (divide, then pointer dereference) opened a comment the scan never found a closer for. skipBlockComment returned -1, findBlockOpenBrace bailed, and the function kept its one-line signature span.
describe('brace span scanning respects a language without block comments', () => {
  it('keeps a Zig function span when a divide is followed by a dereference', async () => {
    const content = [
      'pub fn f(a: i32, b: i32) i32 {',
      '    return a/*b;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('div.zig', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(1)
    expect(f?.lineEnd).toBe(3)
    expect(f?.body).toContain('return a/*b;')
  })

  it('still skips a real block comment in a language that has one', async () => {
    const content = [
      '<?php',
      'function f() {',
      '  /* } */',
      '  return 1;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('block.php', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(2)
    expect(f?.lineEnd).toBe(5)
    expect(f?.body).toContain('return 1;')
  })
})

// Zig writes a multi-line string as a `\\` at the start of each line, running to end of line with no closing delimiter and no escape sequences. The brace walk read those lines as code, so a `}` sitting in the text closed the enclosing function early.
describe('brace span scanning treats a Zig line-prefixed string as opaque', () => {
  it('keeps a function span across a multi-line string containing a brace', async () => {
    const content = [
      'pub fn g() void {',
      '    const t =',
      '        \\\\}',
      '        \\\\still text',
      '    ;',
      '    use(t);',
      '}',
      '',
      'pub fn h() void {',
      '    other();',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('multiline.zig', content)
    const g = result.symbols.find((s) => s.name === 'g')
    expect(g?.lineStart).toBe(1)
    expect(g?.lineEnd).toBe(7)
    expect(g?.body).toContain('use(t);')
    // The skip stops at the newline, not at end of content, so the next function is still found whole.
    const h = result.symbols.find((s) => s.name === 'h')
    expect(h?.lineStart).toBe(9)
    expect(h?.lineEnd).toBe(11)
  })

  it('still reads a backslash inside a quoted Zig string as an escape', async () => {
    const content = [
      'pub fn e() void {',
      '    const s = "a\\\\";',
      '    use(s);',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('escape.zig', content)
    const e = result.symbols.find((s) => s.name === 'e')
    expect(e?.lineStart).toBe(1)
    expect(e?.lineEnd).toBe(4)
  })
})

// PHP accepts both `//` and `#` for a line comment, but the brace walk was told about `//` only, so a brace inside a `#` comment was counted as real and the enclosing function's span stopped there. `#` is not universally a comment in PHP: `#[Attr]` is an attribute, and reading it as a comment would lose an opening brace sharing that line.
describe('brace span scanning knows both PHP line-comment spellings', () => {
  it('skips a closing brace inside a hash comment', async () => {
    const content = [
      '<?php',
      'function f() {',
      '  # }',
      '  return 1;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('hash.php', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(2)
    expect(f?.lineEnd).toBe(5)
    expect(f?.body).toContain('return 1;')
  })

  it('still reads a PHP attribute sharing the signature line as code', async () => {
    const content = [
      '<?php',
      'function f(#[SensitiveParameter] string $p) {',
      '  return $p;',
      '}',
      '',
      '#[Route(\'/x\')]',
      'function g() {',
      '  return 2;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('attr.php', content)
    expect(result.symbols.find((s) => s.name === 'f')?.lineEnd).toBe(4)
    const g = result.symbols.find((s) => s.name === 'g')
    expect(g?.lineStart).toBe(7)
    expect(g?.lineEnd).toBe(9)
  })

  it('keeps treating a hash-bracket line as a comment in PowerShell, which has no attribute syntax there', async () => {
    const content = [
      'function f {',
      '#[note] }',
      '  Write-Output 1',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('note.ps1', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(1)
    expect(f?.lineEnd).toBe(4)
  })
})

// PowerShell was told a backslash escapes nothing, which is right, but nothing was put in its place: the real escape character is a backtick, so an escaped quote inside a double-quoted string closed the string early and the text after it -- including a brace -- was read as code.
describe('brace span scanning honours the PowerShell escape character', () => {
  it('keeps a function span across a backtick-escaped quote', async () => {
    const content = [
      'function f {',
      '  $t = "a`" } still text"',
      '  Write-Output $t',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('escape.ps1', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(1)
    expect(f?.lineEnd).toBe(4)
    expect(f?.body).toContain('Write-Output $t')
  })

  it('does not treat a backtick as an escape inside a single-quoted PowerShell string', async () => {
    const content = [
      'function f {',
      "  $t = 'a`'",
      '  Write-Output $t',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('literal.ps1', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(1)
    expect(f?.lineEnd).toBe(4)
  })

  it('still treats a backslash as an escape in a language on the other side of the property', async () => {
    const content = [
      'class C {',
      '  void M() {',
      '    var s = "a\\" } still text";',
      '    Use(s);',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Escape.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
  })
})

// A C# 11 raw string opens on a run of three or more quotes and closes on the next run at least as long, and takes no escapes at all. Read as three ordinary quotes, `"""C:\Users\"""` ends with a backslash "escaping" the closing quote, so the walk stayed inside a string for the rest of the file and the method and its class both fell back to their signature lines.
describe('brace span scanning treats a C# raw string as opaque', () => {
  it('keeps method and class spans across a raw string ending in a backslash', async () => {
    const content = [
      'class C {',
      '  void M() {',
      '    var path = """C:\\Users\\""";',
      '    Use(path);',
      '  }',
      '',
      '  void N() {',
      '    Other();',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Raw.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
    expect(m?.body).toContain('Use(path);')
    expect(result.symbols.find((s) => s.name === 'C')?.lineEnd).toBe(10)
    expect(result.symbols.find((s) => s.name === 'N')?.lineEnd).toBe(9)
  })

  it('closes a four-quote raw string only on a run of four, not on the three quotes inside it', async () => {
    const content = [
      'class C {',
      '  void M() {',
      '    var s = """"a """ } b"""";',
      '    Use(s);',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Raw4.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
    expect(result.symbols.find((s) => s.name === 'C')?.lineEnd).toBe(6)
  })

  it('still reads three adjacent quotes in Kotlin as a fixed three-quote literal', async () => {
    const content = [
      'class Sizes {',
      '    fun label(): String {',
      '        val s = """5" wide"""',
      '        return s',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Sizes.kt', content)
    const label = result.symbols.find((s) => s.name === 'label')
    expect(label?.lineStart).toBe(2)
    expect(label?.lineEnd).toBe(5)
  })

  it('still reads an empty C# string literal as two ordinary quotes', async () => {
    const content = [
      'class C {',
      '  void M() {',
      '    var s = "" + "}";',
      '    Use(s);',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Empty.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
  })
})

// Dart writes a triple-quoted string with either `"""` or `'''`, but the brace walk only knew the double-quoted spelling. A `'''` literal holding an odd number of single quotes re-pairs them, so the text between is read as code and a brace in it closes the enclosing method.
describe('brace span scanning knows both Dart triple-quote spellings', () => {
  it('keeps method and class spans across a triple-single-quoted string holding a lone quote', async () => {
    const content = [
      'class C {',
      '  void m() {',
      "    var s = '''a ' } b''';",
      '    use(s);',
      '  }',
      '',
      '  void n() {',
      '    other();',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Quotes.dart', content)
    const m = result.symbols.find((s) => s.name === 'm')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
    expect(m?.body).toContain('use(s);')
    expect(result.symbols.find((s) => s.name === 'C')?.lineEnd).toBe(10)
  })

  it('still reads an ordinary single-quoted Dart string as a string', async () => {
    const content = [
      'class C {',
      '  void m() {',
      "    var s = 'a } b';",
      '    use(s);',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Plain.dart', content)
    const m = result.symbols.find((s) => s.name === 'm')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
    expect(result.symbols.find((s) => s.name === 'C')?.lineEnd).toBe(6)
  })

  it('does not treat three single quotes as a string opener in Kotlin, which has only the double-quoted spelling', async () => {
    const content = [
      'class K {',
      '    fun label(): String {',
      '        val s = """5" wide"""',
      '        return s',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('K.kt', content)
    const label = result.symbols.find((s) => s.name === 'label')
    expect(label?.lineStart).toBe(2)
    expect(label?.lineEnd).toBe(5)
    expect(result.symbols.find((s) => s.name === 'K')?.lineEnd).toBe(6)
  })
})
