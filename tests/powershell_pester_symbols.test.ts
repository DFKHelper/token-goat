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
      '    It "verifies non-internal paths" {',
      '    }',
      '}',
    ].join('\n')

    const testSamples = extractQuickSymbolSamples(pesterScript, 'AuditNonInternalPaths.Tests.ps1')
    expect(testSamples).toContain('AuditSuite')
    expect(testSamples).toContain('verifies non-internal paths')
  })
})
