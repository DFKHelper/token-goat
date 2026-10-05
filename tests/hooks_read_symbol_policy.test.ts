import { describe, expect, it } from 'vitest'
import { evaluateFirstReadSymbolPolicy, safeSuggestionTarget } from '../src/hooks_read_policy.js'
import type { HookEvent } from '../src/hook_registry.js'
import type { NavigationEvidence } from '../src/index_reader.js'

function makeEvent(toolName: string, input: Record<string, unknown>): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName,
    toolInput: input,
    sessionId: 'test-session',
    agentId: undefined,
    raw: {},
  }
}

describe('safeSuggestionTarget', () => {
  it('allows safe identifier strings', () => {
    expect(safeSuggestionTarget('parseAst')).toBe('parseAst')
    expect(safeSuggestionTarget('MyClass_v2')).toBe('MyClass_v2')
    expect(safeSuggestionTarget('Section 1 - Introduction')).toBe('Section 1 - Introduction')
  })

  it('rejects empty, non-string, or overlong targets', () => {
    expect(safeSuggestionTarget('')).toBeNull()
    expect(safeSuggestionTarget('   ')).toBeNull()
    expect(safeSuggestionTarget('a'.repeat(81))).toBeNull()
  })

  it('rejects shell metacharacters and injection tokens', () => {
    expect(safeSuggestionTarget('foo; rm -rf /')).toBeNull()
    expect(safeSuggestionTarget('foo`id`')).toBeNull()
    expect(safeSuggestionTarget('foo$(whoami)')).toBeNull()
    expect(safeSuggestionTarget('foo && bar')).toBeNull()
    expect(safeSuggestionTarget('foo | bar')).toBeNull()
    expect(safeSuggestionTarget('foo"bar')).toBeNull()
    expect(safeSuggestionTarget("foo'bar")).toBeNull()
    expect(safeSuggestionTarget('foo\nbar')).toBeNull()
    expect(safeSuggestionTarget('foo::bar')).toBeNull()
  })
})

describe('evaluateFirstReadSymbolPolicy', () => {
  const dummyEvidence: NavigationEvidence = {
    filePath: 'src/cli.ts',
    indexedMtime: 1234567,
    isStale: false,
    symbolCount: 12,
    topSymbols: [
      { name: 'parseAst', kind: 'function', lineStart: 25, lineEnd: 50 },
      { name: 'Compiler', kind: 'class', lineStart: 55, lineEnd: 120 },
      { name: 'emitCode', kind: 'function', lineStart: 125, lineEnd: 180 },
    ],
    headingCount: 0,
    topHeadings: [],
  }

  it('passes when policy is "off"', () => {
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/cli.ts' }),
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 100_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'off',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: dummyEvidence,
    })
    expect(decision.action).toBe('allow')
  })

  it('passes when file size is under threshold', () => {
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/cli.ts' }),
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 40_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'warn',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: dummyEvidence,
    })
    expect(decision.action).toBe('allow')
  })

  it('passes when requested slice is bounded and small', () => {
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/cli.ts', view_range: [10, 40] }),
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 100_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'deny',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: dummyEvidence,
    })
    expect(decision.action).toBe('allow')
  })

  it('passes when evidence is marked stale (fail open)', () => {
    const staleEvidence: NavigationEvidence = {
      ...dummyEvidence,
      isStale: true,
    }
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/cli.ts' }),
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 100_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'deny',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: staleEvidence,
    })
    expect(decision.action).toBe('allow')
  })

  it('passes when no indexed symbols or headings exist', () => {
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/empty.ts' }),
      normalizedPath: 'src/empty.ts',
      shownPath: 'src/empty.ts',
      fileSize: 100_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'warn',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: {
        filePath: 'src/empty.ts',
        indexedMtime: 1234567,
        isStale: false,
        symbolCount: 0,
        topSymbols: [],
        headingCount: 0,
        topHeadings: [],
      },
    })
    expect(decision.action).toBe('allow')
  })

  it('emits warn advisory when policy is "warn" and symbols exist on broad read', () => {
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/cli.ts' }),
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 102_400,
      isFirstRead: true,
      firstReadSymbolPolicy: 'warn',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: dummyEvidence,
    })
    expect(decision.action).toBe('warn')
    if (decision.action === 'warn') {
      expect(decision.message).toContain('src/cli.ts is 100.0KB with 12 indexed symbols')
      expect(decision.message).toContain('token-goat read "src/cli.ts::parseAst"')
      expect(decision.message).toContain('token-goat outline "src/cli.ts"')
    }
  })

  it('emits deny output when policy is "deny" and symbols exist on broad read', () => {
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/cli.ts' }),
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 102_400,
      isFirstRead: true,
      firstReadSymbolPolicy: 'deny',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: dummyEvidence,
    })
    expect(decision.action).toBe('deny')
    if (decision.action === 'deny') {
      expect(decision.message).toContain('12 indexed symbols')
      expect(decision.message).toContain('token-goat read "src/cli.ts::parseAst"')
    }
  })

  it('sanitizes unsafe symbol names and safely falls back to outline', () => {
    const unsafeEvidence: NavigationEvidence = {
      filePath: 'src/malicious.ts',
      indexedMtime: 1234567,
      isStale: false,
      symbolCount: 1,
      topSymbols: [
        { name: 'evil"; rm -rf / #', kind: 'function', lineStart: 1, lineEnd: 10 },
      ],
      headingCount: 0,
      topHeadings: [],
    }
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'src/malicious.ts' }),
      normalizedPath: 'src/malicious.ts',
      shownPath: 'src/malicious.ts',
      fileSize: 100_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'warn',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: unsafeEvidence,
    })
    expect(decision.action).toBe('warn')
    if (decision.action === 'warn') {
      expect(decision.message).not.toContain('evil"; rm -rf')
      expect(decision.message).toContain('Run `token-goat outline "src/malicious.ts"` to read surgically.')
    }
  })

  it('tailors recommendations for markdown headings', () => {
    const headingEvidence: NavigationEvidence = {
      filePath: 'docs/arch.md',
      indexedMtime: 1234567,
      isStale: false,
      symbolCount: 0,
      topSymbols: [],
      topHeadings: [
        { name: 'Architecture Overview', kind: 'heading', lineStart: 1, lineEnd: 20 },
        { name: 'Component Inventory', kind: 'heading', lineStart: 21, lineEnd: 60 },
      ],
      headingCount: 5,
    }
    const decision = evaluateFirstReadSymbolPolicy({
      event: makeEvent('view', { path: 'docs/arch.md' }),
      normalizedPath: 'docs/arch.md',
      shownPath: 'docs/arch.md',
      fileSize: 75_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'warn',
      firstReadSymbolBytes: 50_000,
      navigationEvidence: headingEvidence,
    })
    expect(decision.action).toBe('warn')
    if (decision.action === 'warn') {
      expect(decision.message).toContain('5 indexed headings')
      expect(decision.message).toContain('token-goat section "docs/arch.md::Architecture Overview"')
    }
  })
})
