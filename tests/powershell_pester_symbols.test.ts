import { describe, expect, it } from 'vitest'
import { extractPowershell } from '../src/languages/powershell_idx.js'
import { extractQuickSymbolSamples } from '../src/hooks_read.js'

describe('PowerShell Pester test blocks and hyphenated function symbols', () => {
  it('extracts Describe, Context, and It test blocks with proper line spans', () => {
    const code = [
      'Describe "AuditNonInternalPaths" {',
      '    Context "When path is external" {',
      '        It "flags the violation correctly" {',
      '            $result = Audit-NonInternalPaths -Path "C:\\external"',
      '            $result | Should -Be $true',
      '        }',
      '    }',
      '}',
    ].join('\n')

    const { symbols } = extractPowershell(code, 'AuditNonInternalPaths.Tests.ps1')
    const names = symbols.map((s) => s.name)

    expect(names).toContain('AuditNonInternalPaths')
    expect(names).toContain('When path is external')
    expect(names).toContain('flags the violation correctly')

    const describeSym = symbols.find((s) => s.name === 'AuditNonInternalPaths')
    expect(describeSym).toBeDefined()
    expect(describeSym?.kind).toBe('test')
    expect(describeSym?.lineStart).toBe(1)
    expect(describeSym?.lineEnd).toBe(8)
    expect(describeSym?.body).toContain('Context "When path is external"')

    const contextSym = symbols.find((s) => s.name === 'When path is external')
    expect(contextSym).toBeDefined()
    expect(contextSym?.kind).toBe('context')
    expect(contextSym?.lineStart).toBe(2)
    expect(contextSym?.lineEnd).toBe(7)

    const itSym = symbols.find((s) => s.name === 'flags the violation correctly')
    expect(itSym).toBeDefined()
    expect(itSym?.kind).toBe('test')
    expect(itSym?.lineStart).toBe(3)
    expect(itSym?.lineEnd).toBe(6)
  })

  it('extracts BeforeAll setup blocks and nested helper functions within Pester scopes', () => {
    const code = [
      'Describe "CapMvrisPipeline" {',
      '    BeforeAll {',
      '        function Resolve-EmailRecipientGroup {',
      '            param($Group)',
      '            return "recipients@example.com"',
      '        }',
      '    }',
      '    It "sends email to resolved group" {',
      '        $recipients = Resolve-EmailRecipientGroup -Group "ops"',
      '        $recipients | Should -Be "recipients@example.com"',
      '    }',
      '}',
    ].join('\n')

    const { symbols } = extractPowershell(code, 'CapMvrisPipeline.Tests.ps1')
    const names = symbols.map((s) => s.name)

    expect(names).toContain('CapMvrisPipeline')
    expect(names).toContain('BeforeAll')
    expect(names).toContain('Resolve-EmailRecipientGroup')
    expect(names).toContain('sends email to resolved group')

    const beforeAllSym = symbols.find((s) => s.name === 'BeforeAll')
    expect(beforeAllSym).toBeDefined()
    expect(beforeAllSym?.kind).toBe('setup')
    expect(beforeAllSym?.lineStart).toBe(2)
    expect(beforeAllSym?.lineEnd).toBe(7)
    expect(beforeAllSym?.parent).toBe('CapMvrisPipeline')

    const helperFn = symbols.find((s) => s.name === 'Resolve-EmailRecipientGroup')
    expect(helperFn).toBeDefined()
    expect(helperFn?.kind).toBe('function')
    expect(helperFn?.lineStart).toBe(3)
    expect(helperFn?.lineEnd).toBe(6)
    expect(helperFn?.parent).toBe('BeforeAll')
    expect(helperFn?.body).toContain('param($Group)')
    expect(helperFn?.body).toContain('return "recipients@example.com"')

    const itSym = symbols.find((s) => s.name === 'sends email to resolved group')
    expect(itSym).toBeDefined()
    expect(itSym?.lineStart).toBe(8)
    expect(itSym?.lineEnd).toBe(11)
    expect(itSym?.parent).toBe('CapMvrisPipeline')
  })

  it('extracts hyphenated functions with multi-line body spans', () => {
    const code = [
      'function Audit-NonInternalPaths {',
      '    [CmdletBinding()]',
      '    param(',
      '        [Parameter(Mandatory = $true)]',
      '        [string]$Path',
      '    )',
      '    if (Test-Path $Path) {',
      '        return $true',
      '    }',
      '    return $false',
      '}',
    ].join('\n')

    const { symbols } = extractPowershell(code, 'audit_non_internal_paths.ps1')
    expect(symbols.length).toBe(1)
    const fn = symbols[0]
    expect(fn.name).toBe('Audit-NonInternalPaths')
    expect(fn.kind).toBe('function')
    expect(fn.lineStart).toBe(1)
    expect(fn.lineEnd).toBe(11)
    expect(fn.body).toContain('[CmdletBinding()]')
    expect(fn.body).toContain('return $false')
  })

  it('quick symbol sampling detects PowerShell functions and Pester blocks for pre-tool nudges', () => {
    const psScript = [
      'function Audit-NonInternalPaths {',
      '    param($Path)',
      '}',
      'function Get-AuditArtifact {',
      '    param($Name)',
      '}',
    ].join('\n')

    const scriptSamples = extractQuickSymbolSamples(psScript, 'audit_non_internal_paths.ps1')
    expect(scriptSamples).toContain('Audit-NonInternalPaths')
    expect(scriptSamples).toContain('Get-AuditArtifact')

    const pesterScript = [
      'Describe "AuditSuite" {',
      '    BeforeAll {',
      '    }',
      '    It "verifies non-internal paths" {',
      '    }',
      '}',
    ].join('\n')

    const testSamples = extractQuickSymbolSamples(pesterScript, 'AuditNonInternalPaths.Tests.ps1')
    expect(testSamples).toContain('AuditSuite')
    expect(testSamples).toContain('BeforeAll')
    expect(testSamples).toContain('verifies non-internal paths')
  })

  // Regression (cap-before-predicate): surgicalHint's in-memory branch drops the names escapeHintName refuses, but this function stopped collecting at the three the hint displays -- so three unusable names at the top of a file were the only three the drop could ever consider, and the hint fell back to its generic placeholder. A Pester block name is free text, so it is a real vector for the marker character that makes escapeHintName refuse a name. The `limit` argument is what lets the caller over-fetch and filter afterwards. HAND-DERIVED: three unusable names is one more than the default cap could see past, computed from that cap's own value.
  it('collects past the display count when the caller asks for more', () => {
    const script = [
      "Describe '[tg] first' { }",
      "Describe '[tg] second' { }",
      "Describe '[tg] third' { }",
      "Describe 'Real Suite' { }",
    ].join('\n')

    expect(extractQuickSymbolSamples(script, 'Markers.Tests.ps1')).not.toContain('Real Suite')
    expect(extractQuickSymbolSamples(script, 'Markers.Tests.ps1', 500)).toContain('Real Suite')
  })
})
