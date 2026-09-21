/**
 * The correlator a hint emission is scored against must come from the hint builder, which knows
 * the file it is pointing at, and never from a regex scrape of the rendered sentence.
 *
 * FIXTURE PROVENANCE
 *
 * `SED_HINT_TEXT` is CAPTURE: the literal `additionalContext` string emitted by the shipped
 * global binary on 2026-09-20, from
 *   echo '{"session_id":"ISOLATION_PROBE_XYZZY","cwd":"C:/Projects/token-goat","tool_name":"Bash",
 *          "tool_input":{"command":"sed -n '10,52p' src/paths.ts"}}' | token-goat hook pre_tool_use
 * run under an isolated LOCALAPPDATA/TOKEN_GOAT_HOME sandbox, JSON-unescaped.
 *
 * `LIVE_LEDGER_CORRELATOR` / `LIVE_LEDGER_ROWS` are CAPTURE: read-only query against the author's
 * real global ledger the same day --
 *   SELECT correlator, COUNT(*) FROM hint_emissions WHERE category='bash_redirect' GROUP BY 1
 * returned `/class` with 245 rows and 0 acted_on, against 697 rows in the category. They are
 * asserted here only to keep the *reason* for this change checkable, not as a spec for behavior.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { extractPathCorrelator, resolvePendingHintsForEvent, resetHintStats } from '../src/hint_stats.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { getDb } from '../src/db.js'
import { globalDbPath, configPath } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'

const SED_HINT_TEXT =
  '`sed -n` line-range reads bypass read hooks. For a whole function/class, `token-goat symbol <name>` or `token-goat read "src/paths.ts::<Symbol>"` is robust to line shifts; or `token-goat read "src/paths.ts@10-52"` for exactly those lines.'
const LIVE_LEDGER_CORRELATOR = '/class'
const LIVE_LEDGER_ROWS = 245

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

function nonce(): string {
  return `hc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function preBashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'pre_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

function postBashEvent(sessionId: string, command: string): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId, agentId: undefined, raw: {} }
}

function rowsFor(sessionId: string): Array<{ category: string; correlator: string | null; acted_on: number }> {
  return getDb(globalDbPath())
    .prepare(`SELECT category, correlator, acted_on FROM hint_emissions WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as Array<{ category: string; correlator: string | null; acted_on: number }>
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

// Every case below drives the sed branch twice on purpose. The priced gate in
// bash_range_savings.ts silences the surgical advice, so the surviving emission from that branch
// is the already-served overlap warning -- which is not gated on a cheaper replacement, and which
// reaches the ledger through the same pathHint call carrying the same correlators.
describe('hint correlators come from the builder, not from the hint text', () => {
  it('positive control: the scrape really does yield the prose fragment the live ledger recorded', () => {
    expect(extractPathCorrelator(SED_HINT_TEXT)).toBe(LIVE_LEDGER_CORRELATOR)
    expect(LIVE_LEDGER_ROWS).toBeGreaterThan(0)
  })

  it('records the file the sed range hint is about, not a word out of its own sentence', () => {
    const session = nonce()
    preBashHandler(preBashEvent(session, `sed -n '10,900p' src/paths.ts`))
    const out = preBashHandler(preBashEvent(session, `sed -n '20,800p' src/paths.ts`))
    expect(out.hookType).toBe('context')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.category).toBe('bash_redirect')
    expect(rows[0]!.correlator).toBe('src/paths.ts')
    expect(rows[0]!.correlator).not.toBe(LIVE_LEDGER_CORRELATOR)
  })

  it('a multi-file range read names every file, and following through on the second one counts', () => {
    const session = nonce()
    preBashHandler(preBashEvent(session, `sed -n '10,900p' src/paths.ts; sed -n '10,900p' src/util.ts`))
    const out = preBashHandler(
      preBashEvent(session, `sed -n '20,800p' src/paths.ts; sed -n '20,800p' src/util.ts`),
    )
    expect(out.hookType).toBe('context')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.correlator!.split('\n').sort()).toEqual(['src/paths.ts', 'src/util.ts'])

    resolvePendingHintsForEvent(postBashEvent(session, `token-goat read "src/util.ts::basename"`))
    expect(rowsFor(session)[0]!.acted_on).toBe(1)
  })

  it('does not credit a token-goat call naming some other file', () => {
    const session = nonce()
    preBashHandler(preBashEvent(session, `sed -n '10,900p' src/paths.ts`))
    preBashHandler(preBashEvent(session, `sed -n '20,800p' src/paths.ts`))
    for (let i = 0; i < 8; i++) {
      resolvePendingHintsForEvent(postBashEvent(session, `token-goat read "src/db.ts::getDb"`))
    }
    expect(rowsFor(session)[0]!.acted_on).toBe(0)
  })

})
