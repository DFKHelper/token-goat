import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// Kotlin, Scala, Swift and Dart all have a `"""..."""` literal that runs to the next `"""` and takes no escape sequences. The generic brace walk read those three quotes as three ordinary string delimiters, so two very ordinary literals derailed it: a lone `"` inside the text (`"""5" wide"""`) flipped its idea of what was code, and a trailing backslash (`"""C:\Users\"""`, perfectly legal since there are no escapes) "escaped" the closing quote and left the walk inside a string for the rest of the file. Either way findMatchingBraceEndLine found no closing brace, noMatchValue -1 kicked in, and the enclosing function and class stayed at their one-line signature spans -- so `read "Paths.kt::root"` returned `fun root(): String` instead of the body.
describe('brace span scanning treats a triple-quoted literal as opaque', () => {
  it('keeps a Kotlin function span across a raw string ending in a backslash', async () => {
    const content = [
      'package demo',
      '',
      'class Paths {',
      '    fun root(): String {',
      '        val p = """C:\\Users\\"""',
      '        return p',
      '    }',
      '',
      '    fun other(): Int {',
      '        return 42',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Paths.kt', content)
    const root = result.symbols.find((s) => s.name === 'root')
    expect(root?.lineStart).toBe(4)
    expect(root?.lineEnd).toBe(7)
    expect(root?.body).toContain('return p')
    expect(result.symbols.find((s) => s.name === 'Paths')?.lineEnd).toBe(12)
  })

  it('keeps a Kotlin function span across a raw string holding a lone double quote', async () => {
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

  it('keeps a Swift function span across a multi-line string holding a lone double quote', async () => {
    const content = [
      'struct Sizes {',
      '    func label() -> String {',
      '        let s = """',
      '        5" wide',
      '        """',
      '        return s',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Sizes.swift', content)
    const label = result.symbols.find((s) => s.name === 'label')
    expect(label?.lineStart).toBe(2)
    expect(label?.lineEnd).toBe(7)
  })

  it('keeps a Scala method span across a raw string holding a lone double quote', async () => {
    const content = [
      'class Sizes {',
      '  def label(): String = {',
      '    val s = """5" wide"""',
      '    s',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Sizes.scala', content)
    const label = result.symbols.find((s) => s.name === 'label')
    expect(label?.lineStart).toBe(2)
    expect(label?.lineEnd).toBe(5)
  })

  it('still honours a backslash escape in an ordinary Kotlin string literal', async () => {
    // Control: the triple-quote carve-out must not switch escaping off for a normal literal. The `\"` here is an escaped quote, so the string does not close there and the `}` inside it is not the function's.
    const content = [
      'class Quoted {',
      '    fun m(): String {',
      '        val s = "a\\"} b"',
      '        return s',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Quoted.kt', content)
    const m = result.symbols.find((s) => s.name === 'm')
    expect(m?.lineStart).toBe(2)
    expect(m?.lineEnd).toBe(5)
  })

  it('does not read three adjacent quotes in PowerShell as a triple-quoted literal', async () => {
    // Anti-over-fix control: PowerShell has no `"""` literal -- it escapes a quote by doubling it, so `""""` is a one-character string holding a quote. Turning the triple-quote scan on for PowerShell would look for a closer that is not there and collapse the function back to its signature line.
    const content = [
      'function Get-Quote {',
      '    $q = """"',
      '    return $q',
      '}',
      '',
      'function Get-Other {',
      '    return 42',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('quote.ps1', content)
    const fn = result.symbols.find((s) => s.name === 'Get-Quote')
    expect(fn?.lineStart).toBe(1)
    expect(fn?.lineEnd).toBe(4)
  })
})
