import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyHintTracking,
  classifyBashHint,
  classifyEditHint,
  classifyReadHint,
  extractPathCorrelator,
  getHintStatsSummary,
  isHintCategory,
  logHintEmission,
  markCategoryEffective,
  markCategoryIneffective,
  resetHintStats,
  resolvePendingHintsForEvent,
  shouldSuppress,
  HINT_CATEGORIES,
} from '../src/hint_stats.js'
import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { defaultConfig, saveConfig } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'

function nonce(): string {
  return `hs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    agentId: undefined,
    raw: {},
  }
}

function readEvent(sessionId: string, filePath: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: filePath },
    sessionId,
    agentId: undefined,
    raw: {},
  }
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

describe('isHintCategory', () => {
  it('accepts exactly the five tracked categories', () => {
    for (const c of HINT_CATEGORIES) {
      expect(isHintCategory(c)).toBe(true)
    }
    expect(isHintCategory('not_a_category')).toBe(false)
    expect(isHintCategory('')).toBe(false)
  })
})

describe('extractPathCorrelator', () => {
  it('extracts an absolute Windows path', () => {
    expect(extractPathCorrelator('Use `token-goat read "C:/repo/src/mod.ts::Foo"` instead.')).toBe('C:/repo/src/mod.ts::Foo')
  })

  it('extracts an absolute POSIX path', () => {
    expect(extractPathCorrelator('was already read this session; see /home/user/repo/file.md')).toBe('/home/user/repo/file.md')
  })

  it('returns null when no path-shaped substring is present', () => {
    expect(extractPathCorrelator('Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass).')).toBe(null)
  })

  it('trims trailing sentence punctuation', () => {
    expect(extractPathCorrelator('See C:/repo/file.ts for details.')).toBe('C:/repo/file.ts')
  })

  // Regression: hint text templates in hooks_edit.ts/hooks_read.ts splice a literal
  // `::<placeholder>` (e.g. `::HeadingName`, `::SectionName`, `::<field>`, `::Symbol`,
  // `::SymbolName`, `::name`, or a bracketed `::<...>` name) onto the real path so a human
  // reads it as "put a heading/symbol name here" -- not a real value. An agent that actually
  // follows the hint substitutes its own concrete heading/symbol, so isActedOn's
  // `command.includes(correlator)` check could never match if the correlator kept the literal
  // placeholder text, permanently pinning the category's efficacy at 0% and triggering
  // auto-suppression despite perfect real-world follow-through. The correlator must therefore
  // be just the bare path when the `::` suffix is one of these known placeholders.
  it('strips a known literal placeholder suffix, keeping only the bare path', () => {
    expect(extractPathCorrelator('Use `token-goat section "C:/repo/README.md::HeadingName"` to re-read a specific section.')).toBe('C:/repo/README.md')
    expect(extractPathCorrelator('Use `token-goat section "' + '/a/b.md' + '::SectionName"` to read one section.')).toBe('/a/b.md')
    expect(extractPathCorrelator('Use `token-goat section "' + '/a/b.json' + '::<field>"` to extract just the value.')).toBe('/a/b.json')
    expect(extractPathCorrelator('Use `token-goat read "' + '/a/b.ts' + '::SymbolName"` for one function.')).toBe('/a/b.ts')
  })

  it('keeps a concrete, non-placeholder :: suffix (e.g. a real tsconfig field name)', () => {
    expect(extractPathCorrelator('Use `token-goat section "/a/tsconfig.json::compilerOptions"` to extract compiler options.')).toBe(
      '/a/tsconfig.json::compilerOptions',
    )
  })
})

describe('classifyBashHint', () => {
  it('classifies a bash-output recall hint by its embedded id', () => {
    const result = classifyBashHint('Prior output from `npm test` is cached. Use `token-goat bash-output ab12cd34` to recall the full file.')
    expect(result.category).toBe('bash_recall')
    expect(result.correlator).toBe('ab12cd34')
  })

  it('classifies a surgical-redirect hint by its embedded path when no bash-output id is present', () => {
    const result = classifyBashHint('`cat` loads the entire file into context. Use `token-goat read "C:/repo/file.ts::SymbolName"` to read one function or class.')
    expect(result.category).toBe('bash_redirect')
    // Regression: "SymbolName" is the literal placeholder this hint text template splices onto
    // the path -- an agent following the hint substitutes a real symbol name, so the correlator
    // must be the bare path (see extractPathCorrelator's regression test for the full explanation).
    expect(result.correlator).toBe('C:/repo/file.ts')
  })

  it('falls back to a null correlator when the redirect hint has no extractable path', () => {
    const result = classifyBashHint('Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass). For symbol discovery: `token-goat refs <symbol>` or `token-goat semantic`.')
    expect(result.category).toBe('bash_redirect')
    expect(result.correlator).toBe(null)
  })
})

describe('classifyReadHint', () => {
  it('classifies a re-read dedup hint', () => {
    const result = classifyReadHint('Note: C:/repo/file.ts was already read this session (2 reads). Use `token-goat read "C:/repo/file.ts::Foo"`.')
    expect(result.category).toBe('read_reread_dedup')
    expect(result.correlator).toBe('C:/repo/file.ts')
  })

  it('classifies a structural-navigation hint', () => {
    const result = classifyReadHint('C:/repo/file.ts is 400 lines. Use `token-goat skeleton "C:/repo/file.ts"` for structural navigation.')
    expect(result.category).toBe('read_structural_nav')
    expect(result.correlator).toBe('C:/repo/file.ts')
  })
})

describe('classifyEditHint', () => {
  it('always classifies as edit_reread_suggest', () => {
    const result = classifyEditHint('README.md was edited. Use `token-goat section "C:/repo/README.md::HeadingName"` to re-read a specific section.')
    expect(result.category).toBe('edit_reread_suggest')
    // Regression: "HeadingName" is the literal placeholder this hint text template splices onto
    // the path -- an agent following the hint substitutes a real heading, so the correlator must
    // be the bare path, not the placeholder text (see extractPathCorrelator's regression test
    // above for the full explanation).
    expect(result.correlator).toBe('C:/repo/README.md')
  })
})

describe('logHintEmission', () => {
  it('inserts an unresolved pending row when a correlator is present', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as
      | { resolved: number; acted_on: number; calls_remaining: number }
      | undefined
    expect(row).toBeDefined()
    expect(row?.resolved).toBe(0)
    expect(row?.acted_on).toBe(0)
    expect(row?.calls_remaining).toBeGreaterThan(0)
  })

  it('inserts an already-resolved, not-acted-on row when no correlator is available', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number } | undefined
    expect(row?.resolved).toBe(1)
    expect(row?.acted_on).toBe(0)
  })

  it('still counts toward emitted even with a null correlator', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'bash_redirect')
    expect(row?.emitted).toBe(1)
    expect(row?.actedOn).toBe(0)
  })
})

describe('resolvePendingHintsForEvent', () => {
  it('marks acted_on when a subsequent Bash command mentions the exact correlator (bash_redirect)', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/file.ts::Foo"'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.resolved).toBe(1)
    expect(row.acted_on).toBe(1)
  })

  it('requires the bash-output id itself for bash_recall, not just any token-goat call', () => {
    const n = nonce()
    logHintEmission('bash_recall', n, 'ab12cd34')
    // A token-goat call that does NOT reference this id must not count as acted-on.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output zz99yy88'))

    let db = getDb(globalDbPath())
    let row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
    expect(row.resolved).toBe(0) // still pending — window not exhausted yet

    resolvePendingHintsForEvent(bashEvent(n, 'token-goat bash-output ab12cd34'))
    db = getDb(globalDbPath())
    row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(1)
    expect(row.resolved).toBe(1)
  })

  it('resolves as not-acted-on once the window is exhausted by unrelated tool calls', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    for (let i = 0; i < 10; i++) {
      resolvePendingHintsForEvent(readEvent(n, `C:/repo/unrelated-${i}.ts`))
    }
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as {
      resolved: number
      acted_on: number
      calls_remaining: number
    }
    expect(row.resolved).toBe(1)
    expect(row.acted_on).toBe(0)
  })

  it('does not resolve pending hints from a different session', () => {
    const n = nonce()
    const other = nonce()
    logHintEmission('bash_redirect', n, 'C:/repo/file.ts')
    resolvePendingHintsForEvent(bashEvent(other, 'token-goat read "C:/repo/file.ts::Foo"'))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(0)
    expect(row.resolved).toBe(0)
  })

  it('does not credit acted_on when "token-goat" only appears as a path segment, not an actual CLI invocation', () => {
    // This project's own working directory is literally named "token-goat", so a command that
    // re-runs the exact wasteful pattern the hint warned about -- but whose target path merely
    // lies inside this repo -- must not falsely satisfy the "did the agent invoke token-goat" check.
    const n = nonce()
    const correlator = 'C:/Projects/token-goat/src/hint_stats.ts'
    logHintEmission('bash_redirect', n, correlator)
    resolvePendingHintsForEvent(bashEvent(n, `cat ${correlator}`))

    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT resolved, acted_on, calls_remaining FROM hint_emissions WHERE session_id = ?').get(n) as {
      resolved: number
      acted_on: number
      calls_remaining: number
    }
    expect(row.acted_on).toBe(0)
    expect(row.resolved).toBe(0) // still pending, window merely decremented -- not falsely resolved as acted-on
  })
})

describe('efficacy calculation', () => {
  it('computes acted-on / emitted as a percentage', () => {
    const n1 = nonce()
    const n2 = nonce()
    const n3 = nonce()
    logHintEmission('read_reread_dedup', n1, 'C:/repo/a.ts')
    logHintEmission('read_reread_dedup', n2, 'C:/repo/b.ts')
    logHintEmission('read_reread_dedup', n3, 'C:/repo/c.ts')
    resolvePendingHintsForEvent(bashEvent(n1, 'token-goat read "C:/repo/a.ts::Foo"'))
    // n2 and n3 time out unresolved (not acted on).
    for (let i = 0; i < 6; i++) {
      resolvePendingHintsForEvent(readEvent(n2, 'C:/other.ts'))
      resolvePendingHintsForEvent(readEvent(n3, 'C:/other.ts'))
    }

    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'read_reread_dedup')
    expect(row?.emitted).toBe(3)
    expect(row?.actedOn).toBe(1)
    expect(row?.efficacyPct).toBeCloseTo(33.3, 1)
  })

  it('reports null efficacy for a category with zero emissions', () => {
    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'edit_reread_suggest')
    expect(row?.emitted).toBe(0)
    expect(row?.efficacyPct).toBe(null)
  })
})

describe('shouldSuppress — threshold + minimum sample size', () => {
  it('never suppresses below the configured minimum sample size, even at 0% efficacy', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 5
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)

    for (let i = 0; i < 4; i++) {
      const n = nonce()
      logHintEmission('bash_redirect', n, null) // resolved immediately, never acted on
    }
    expect(shouldSuppress('bash_redirect', nonce())).toBe(false)
  })

  it('suppresses once both the sample-size floor and the efficacy threshold are crossed', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 5
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)

    for (let i = 0; i < 5; i++) {
      const n = nonce()
      logHintEmission('bash_redirect', n, null) // 0% acted-on
    }
    expect(shouldSuppress('bash_redirect', nonce())).toBe(true)
  })

  it('does not suppress a category whose efficacy is at/above threshold regardless of sample size', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 4
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)

    for (let i = 0; i < 4; i++) {
      const n = nonce()
      logHintEmission('bash_recall', n, `id-${i}`)
      resolvePendingHintsForEvent(bashEvent(n, `token-goat bash-output id-${i}`))
    }
    expect(shouldSuppress('bash_recall', nonce())).toBe(false)
  })

  it('respects a reconfigured threshold/sample size', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 2
    cfg.hint_stats.suppress_threshold_pct = 50
    saveConfig(cfg)

    const nActed = nonce()
    logHintEmission('read_structural_nav', nActed, 'C:/repo/a.ts')
    resolvePendingHintsForEvent(bashEvent(nActed, 'token-goat skeleton "C:/repo/a.ts"'))
    const nNotActed = nonce()
    logHintEmission('read_structural_nav', nNotActed, null)
    // 1/2 = 50%, not below a 50% threshold.
    expect(shouldSuppress('read_structural_nav', nonce())).toBe(false)

    cfg.hint_stats.suppress_threshold_pct = 60
    saveConfig(cfg)
    // Same 50% data, now below a 60% threshold.
    expect(shouldSuppress('read_structural_nav', nonce())).toBe(true)
  })
})

describe('applyHintTracking', () => {
  const classify = (text: string): { category: 'bash_redirect'; correlator: string | null } => ({ category: 'bash_redirect', correlator: extractPathCorrelator(text) })

  it('passes through non-context outputs untouched (deny/pass/rewrite are not hints)', () => {
    const event = bashEvent(nonce(), 'cat file.ts')
    const passOut = { hookType: 'pass' as const }
    expect(applyHintTracking(event, passOut, classify)).toEqual(passOut)
    const denyOut = { hookType: 'deny' as const, message: 'blocked' }
    expect(applyHintTracking(event, denyOut, classify)).toEqual(denyOut)
  })

  it('logs an emission and returns the context output unchanged when not suppressed', () => {
    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/file.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/file.ts::Foo"` instead.' }
    const result = applyHintTracking(event, contextOut, classify)
    expect(result).toEqual(contextOut)

    const summary = getHintStatsSummary()
    expect(summary.find((r) => r.category === 'bash_redirect')?.emitted).toBeGreaterThan(0)
  })

  it('substitutes passOutput() and does not log when the category is suppressed', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 1
    cfg.hint_stats.suppress_threshold_pct = 100 // guarantee suppression on the very first sample
    saveConfig(cfg)

    const seedSession = nonce()
    logHintEmission('bash_redirect', seedSession, null) // 0% acted-on, resolved

    const n = nonce()
    const event = bashEvent(n, 'cat C:/repo/other.ts')
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/other.ts::Foo"` instead.' }
    const result = applyHintTracking(event, contextOut, classify)
    expect(result).toEqual({ hookType: 'pass' })

    // The suppressed emission must not itself have been logged.
    const db = getDb(globalDbPath())
    const row = db.prepare('SELECT COUNT(*) AS n FROM hint_emissions WHERE session_id = ?').get(n) as { n: number }
    expect(row.n).toBe(0)
  })

  it('preserves the full ACTED_ON_WINDOW of genuinely subsequent chances for a pre_tool_use-emitted hint, despite the guaranteed self-resolving post_tool_use pass for the same tool call', () => {
    const n = nonce()
    // preBashHandler fires on pre_tool_use — the real production caller of applyHintTracking for
    // bash_redirect hints. Its own post_tool_use event for this SAME command is guaranteed to run
    // resolvePendingHintsForEvent next, before any genuinely later tool call can occur.
    const triggerCommand = 'cat C:/repo/file.ts'
    const preEvent: HookEvent = { eventName: 'pre_tool_use', toolName: 'Bash', toolInput: { command: triggerCommand }, sessionId: n, agentId: undefined, raw: {} }
    const contextOut = { hookType: 'context' as const, context: 'Use `token-goat read "C:/repo/file.ts::Foo"` instead.' }
    applyHintTracking(preEvent, contextOut, classify)

    // The self-resolving post_tool_use pass for the same triggering command.
    resolvePendingHintsForEvent(bashEvent(n, triggerCommand))

    // Four more genuinely subsequent, unrelated tool calls must still not exhaust the window.
    for (let i = 0; i < 4; i++) {
      resolvePendingHintsForEvent(readEvent(n, `C:/repo/unrelated-${i}.ts`))
    }
    let db = getDb(globalDbPath())
    let row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.resolved).toBe(0) // still pending after the self-resolve + 4 unrelated calls

    // The 5th genuinely subsequent call is the correct follow-through — must still count.
    resolvePendingHintsForEvent(bashEvent(n, 'token-goat read "C:/repo/file.ts::Foo"'))
    db = getDb(globalDbPath())
    row = db.prepare('SELECT resolved, acted_on FROM hint_emissions WHERE session_id = ?').get(n) as { resolved: number; acted_on: number }
    expect(row.acted_on).toBe(1)
    expect(row.resolved).toBe(1)
  })
})

describe('manual marks', () => {
  it('tracks effective/ineffective votes separately from the automatic signal, per category', () => {
    markCategoryEffective('bash_redirect')
    markCategoryEffective('bash_redirect')
    markCategoryIneffective('bash_redirect')

    const summary = getHintStatsSummary()
    const row = summary.find((r) => r.category === 'bash_redirect')
    expect(row?.manualEffective).toBe(2)
    expect(row?.manualIneffective).toBe(1)
    // Manual marks never feed into the automatic emitted/actedOn counters.
    expect(row?.emitted).toBe(0)
  })
})

describe('resetHintStats', () => {
  it('clears every tracked emission and manual mark', () => {
    const n = nonce()
    logHintEmission('bash_redirect', n, null)
    markCategoryEffective('bash_redirect')

    resetHintStats()

    const summary = getHintStatsSummary()
    expect(summary.every((r) => r.emitted === 0 && r.manualEffective === 0 && r.manualIneffective === 0)).toBe(true)
  })
})
