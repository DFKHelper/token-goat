import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// A backslash is only a string escape in some of the languages assignBraceBlockSpans serves. C# verbatim strings (@"...") and PowerShell double-quoted strings both treat a trailing `\` as an ordinary character, so a Windows path literal like @"C:\temp\" ends where it looks like it ends. The generic brace walk assumed C-style escaping everywhere, so that trailing backslash "escaped" the closing quote, the string was read as still open, and every brace after it was swallowed -- collapsing the enclosing method, class and namespace back to a one-line span with a signature-only body. `read "File.cs::Method"` then returned the signature instead of the body.
describe('brace span scanning respects each language string-escape model', () => {
  it('keeps a C# method span across a verbatim string ending in a backslash', async () => {
    const content = [
      'namespace Demo',
      '{',
      '    public class Paths',
      '    {',
      '        public string First()',
      '        {',
      '            var p = @"C:\\temp\\";',
      '            return p;',
      '        }',
      '',
      '        public string Second()',
      '        {',
      '            return "second";',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Paths.cs', content)
    const first = result.symbols.find((s) => s.name === 'First')
    expect(first?.lineStart).toBe(5)
    expect(first?.lineEnd).toBe(9)
    expect(first?.body).toContain('return p;')
    const paths = result.symbols.find((s) => s.name === 'Paths')
    expect(paths?.lineEnd).toBe(15)
  })

  it('still honours a backslash escape in an ordinary C# string literal', async () => {
    // The verbatim carve-out must not disable escaping for a normal literal: the `\"` here is an escaped quote, so the string does NOT close there and the `}` inside it is not the method's.
    const content = [
      'public class Quoted',
      '{',
      '    public string M()',
      '    {',
      '        var s = "a\\"} b";',
      '        return s;',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Quoted.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineStart).toBe(3)
    expect(m?.lineEnd).toBe(7)
  })

  it('treats a doubled quote inside a C# verbatim string as an escaped quote, not a closer', async () => {
    const content = [
      'public class Doubled',
      '{',
      '    public string M()',
      '    {',
      '        var s = @"say ""}"" now";',
      '        return s;',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Doubled.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineEnd).toBe(7)
  })

  it('keeps a PowerShell function span across a path string ending in a backslash', async () => {
    const content = [
      'function Get-Root {',
      '    $p = "C:\\temp\\"',
      '    Write-Output $p',
      '}',
      '',
      'function Get-Other {',
      '    return 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('paths.ps1', content)
    const root = result.symbols.find((s) => s.name === 'Get-Root')
    expect(root?.lineStart).toBe(1)
    expect(root?.lineEnd).toBe(4)
    expect(root?.body).toContain('Write-Output $p')
  })
})
