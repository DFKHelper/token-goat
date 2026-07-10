import { describe, it, expect } from 'vitest'
import { extractCsharp } from '../src/languages/csharp.js'
import { extractPhp } from '../src/languages/php.js'
import { extractKotlin } from '../src/languages/kotlin.js'
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
    expect(before?.docstring).toBe('Before')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('After')
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
    expect(before?.docstring).toBe('Before')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('After')
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
    expect(after?.docstring).toBe('After')
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
    expect(before?.docstring).toBe('Before')
    const after = symbols.find((s) => s.name === 'afterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('After')
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
    expect(after?.docstring).toBe('After')
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
    expect(before?.docstring).toBe('Before')
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
    expect(before?.docstring).toBe('Before')
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
    expect(before?.docstring).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('After')
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
    expect(after?.docstring).toBe('After')
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
    expect(before?.docstring).toBe('Before')
    const after = symbols.find((s) => s.name === 'AfterMethod')
    expect(after?.kind).toBe('method')
    expect(after?.docstring).toBe('After')
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
