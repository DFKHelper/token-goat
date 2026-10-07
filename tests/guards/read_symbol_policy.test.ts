import { describe, expect, it } from 'vitest'
import type { HintsConfig } from '../../src/config_types.js'
import { CONFIG_DEFAULTS } from '../../src/config_defaults.js'
import { PROJECT_LOCKED_KEYS } from '../../src/config_project.js'
import { evaluateFirstReadSymbolPolicy } from '../../src/hooks_read_policy.js'
import type { HookEvent } from '../../src/hook_registry.js'

describe('First-read symbol policy guard', () => {
  it('has defaults configured in CONFIG_DEFAULTS', () => {
    const hints = CONFIG_DEFAULTS.hints as unknown as HintsConfig
    expect(hints.first_read_symbol_bytes).toBe(50_000)
    expect(hints.first_read_symbol_policy).toBe('warn')
  })

  it('is locked against project configuration overrides', () => {
    expect(PROJECT_LOCKED_KEYS).toContain('hints.first_read_symbol_bytes')
    expect(PROJECT_LOCKED_KEYS).toContain('hints.first_read_symbol_policy')
  })

  // Decision logic only: the evidence is injected. The real index path is tests/hooks_read_symbol_policy_e2e.test.ts.
  it('reaches a warn decision from injected evidence without touching the index', () => {
    const dummyEvent: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'view',
      toolInput: { path: 'src/cli.ts' },
      sessionId: 'guard-session',
    agentId: undefined,
    raw: {},
    }

    const decision = evaluateFirstReadSymbolPolicy({
      event: dummyEvent,
      normalizedPath: 'src/cli.ts',
      shownPath: 'src/cli.ts',
      fileSize: 100_000,
      isFirstRead: true,
      firstReadSymbolPolicy: 'warn',
      firstReadSymbolBytes: 50_000,
      // HAND-DERIVED: invented evidence of the shape getReadNavigationEvidence returns.
      navigationEvidence: {
        filePath: 'src/cli.ts',
        indexedMtime: 1234567,
        isStale: false,
        symbolCount: 5,
        topSymbols: [{ name: 'main', kind: 'function', lineStart: 1, lineEnd: 20 }],
        headingCount: 0,
        topHeadings: [],
      },
    })

    expect(decision.action).toBe('warn')
  })
})
