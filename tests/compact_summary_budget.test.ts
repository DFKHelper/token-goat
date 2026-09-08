/**
 * compact_assist.summary_budget_chars: the length target PreCompact hands the summariser, and the
 * post-compact counters that say whether it landed.
 *
 * Why this file exists rather than more cases in tests/hooks_compact.test.ts: the load-bearing
 * property here spans two handlers. preCompactHandler asks for an escalation marker and
 * postCompactHandler counts it, so a test that only checks one side proves nothing about the pair
 * -- the emitter could drift to a different literal and every escalation would silently reclassify
 * as an ordinary overrun. The round-trip case below is the guard, and it is why
 * BUDGET_ESCALATION_MARKER is one constant instead of two literals.
 *
 * Fixture provenance:
 *   - The directive text and the marker are FORMAT-DERIVED from src/hooks_compact.ts's own
 *     summaryBudgetDirective, which is honest here because the directive is a literal token-goat
 *     authors and emits; there is no external wire format to disagree with. The assertions
 *     deliberately reference the exported BUDGET_ESCALATION_MARKER rather than re-typing
 *     'TG-BUDGET-ESCALATION:', so a rename moves both sides together instead of going green
 *     against a stale copy.
 *   - Summary bodies are HAND-DERIVED: 'x'.repeat(n) around a chosen budget, so the over/under
 *     boundary is computed from the input rather than read off the implementation.
 *   - The budget default of 24000 is CAPTURE-adjacent: it was chosen from a census of 847 real
 *     compaction summaries (24.56 MB, p50 26,240 chars) recorded in summaryBudgetDirective's own
 *     doc comment. This file does not assert that number -- pinning a tuned default would make
 *     every future retune a test failure rather than a decision.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { dataDir } from '../src/constants.js'
import { getDb } from '../src/db.js'
import type { HookEvent } from '../src/hook_registry.js'
import { BUDGET_ESCALATION_MARKER, postCompactHandler, preCompactHandler, summaryBudgetDirective } from '../src/hooks_compact.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead } from '../src/session.js'

const BUDGET = 500

function setBudget(chars: number): void {
  const cfg = defaultConfig()
  cfg.compact_assist.summary_budget_chars = chars
  saveConfig(cfg)
  invalidateConfigCache()
}

function preCompactEvent(sessionId = 'budget-pre'): HookEvent {
  return { eventName: 'pre_compact', toolName: undefined, toolInput: {}, sessionId, agentId: undefined, raw: { session_id: sessionId, cwd: process.cwd() } }
}

function postCompactEvent(summary: string, sessionId = 'budget-post'): HookEvent {
  return { eventName: 'post_compact', toolName: undefined, toolInput: {}, sessionId, agentId: undefined, raw: { session_id: sessionId, trigger: 'auto', compact_summary: summary } }
}

/** Newest compact_summary detail string. summarize() aggregates and drops `detail`, which is where every counter this handler records lives. */
function latestDetail(): string {
  const db = getDb(join(dataDir(), 'global.db'))
  const row = db.prepare("select detail from stats where kind = 'compact_summary' order by id desc limit 1").get() as { detail: string } | undefined
  return row?.detail ?? ''
}

/** One temp file per call, so recordFileRead has a real path to put in the manifest. */
function makeTmpFile(name: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'tg-budget-')), name)
  writeFileSync(p, 'data')
  return p
}

beforeEach(() => {
  clearModuleCaches()
  invalidateConfigCache()
})

describe('summaryBudgetDirective', () => {
  it('returns nothing at all when budgeting is off, so the preamble ships byte-identical to its pre-budget form', () => {
    expect(summaryBudgetDirective(0)).toBe('')
    // Negative is not merely clamped to a small budget: a misconfigured value must disable the directive rather than ask for a nonsensical target.
    expect(summaryBudgetDirective(-1)).toBe('')
  })

  it('names the exact budget and offers the escalation marker as an escape', () => {
    const text = summaryBudgetDirective(BUDGET)
    expect(text).toContain(String(BUDGET))
    expect(text).toContain(BUDGET_ESCALATION_MARKER)
    // The escape is what keeps the budget a target rather than a cap. Without it a summariser's only way to obey is to drop state, which is the failure this whole feature is gated on avoiding.
    expect(text.toLowerCase()).toContain('exceed it')
  })
})

describe('preCompactHandler', () => {
  it('carries the budget into the context the summariser actually receives', () => {
    setBudget(BUDGET)
    recordFileRead(makeTmpFile('carried.ts'))
    const out = preCompactHandler(preCompactEvent()) as { hookType: string; context: string }
    expect(out.context).toContain(String(BUDGET))
    expect(out.context).toContain(BUDGET_ESCALATION_MARKER)
    // Preservation stays first: a budget that displaced the path-preservation instruction would trade the manifest's whole purpose for length.
    expect(out.context.indexOf('exactly as written')).toBeLessThan(out.context.indexOf(BUDGET_ESCALATION_MARKER))
  })

  it('emits no budget language at all when the key is 0', () => {
    setBudget(0)
    recordFileRead(makeTmpFile('unbudgeted.ts'))
    const out = preCompactHandler(preCompactEvent()) as { hookType: string; context: string }
    expect(out.context).not.toContain(BUDGET_ESCALATION_MARKER)
    expect(out.context.toLowerCase()).not.toContain('at most')
  })
})

describe('postCompactHandler counters', () => {
  it('records over=1 for a summary past the budget and over=0 for one inside it', () => {
    setBudget(BUDGET)
    postCompactHandler(postCompactEvent('x'.repeat(BUDGET + 1)))
    expect(latestDetail()).toContain(`budget=${BUDGET} over=1`)
    postCompactHandler(postCompactEvent('x'.repeat(BUDGET)))
    // Exactly at the budget is inside it: the directive says "at most", so equality must not count as an overrun.
    expect(latestDetail()).toContain(`budget=${BUDGET} over=0`)
  })

  it('never reports an overrun when budgeting is off, however long the summary', () => {
    setBudget(0)
    postCompactHandler(postCompactEvent('x'.repeat(BUDGET * 10)))
    expect(latestDetail()).toContain('budget=0 over=0')
  })

  it('detects the escalation marker this codebase itself asks for, closing the emitter/detector loop', () => {
    setBudget(BUDGET)
    // The marker is lifted from the directive the emitter builds, not hand-typed here: if summaryBudgetDirective ever asks for a different token than postCompactHandler counts, this line stops finding one and the case fails.
    const directive = summaryBudgetDirective(BUDGET)
    const marker = directive.slice(directive.indexOf(BUDGET_ESCALATION_MARKER)).split(' <')[0] ?? ''
    expect(marker).not.toBe('')
    postCompactHandler(postCompactEvent(`${marker} the session spans four unrelated subsystems.\n${'x'.repeat(BUDGET * 2)}`))
    const detail = latestDetail()
    expect(detail).toContain('escalated=1')
    // An escalation is still an overrun. Collapsing the two would hide how often the escape is used to justify a genuinely oversized summary.
    expect(detail).toContain('over=1')
  })

  it('reports escalated=0 for an ordinary oversized summary, so the escape is distinguishable from a plain overrun', () => {
    setBudget(BUDGET)
    postCompactHandler(postCompactEvent('x'.repeat(BUDGET * 2)))
    expect(latestDetail()).toContain('over=1 escalated=0')
  })
})

describe('manifest survival canary', () => {
  it('samples well past the old 12-path cap, which is what makes the ratio able to see late state evaporate', () => {
    setBudget(BUDGET)
    const paths: string[] = []
    for (let i = 0; i < 20; i++) {
      const p = makeTmpFile(`canary${i}.ts`)
      paths.push(p)
      recordFileRead(p)
    }
    // Every path present, so the denominator is the sample width rather than a survival measurement: a 12-wide sample reports 12/12 here and is blind to the 8 files past it.
    postCompactHandler(postCompactEvent(paths.join('\n')))
    const denominator = Number(/manifest_paths=\d+\/(\d+)/.exec(latestDetail())?.[1] ?? '0')
    expect(denominator).toBeGreaterThan(12)
  })
})
