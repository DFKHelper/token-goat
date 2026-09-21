/**
 * A detection the agent never saw -- auto-suppressed, or declined by a hint's own net-benefit
 * gate -- gets a zero-byte row, so the ledger can answer how often a hint fired at all.
 *
 * Before this, a suppressed detection left no trace: a category muted into silence and a category
 * whose trigger had stopped firing printed identically, and those call for opposite actions
 * (review the throttle vs. retire the hint). The same hole swallowed the range hints' priced gate
 * -- it declines on essentially every real file (see src/bash_range_savings.ts), and nothing
 * anywhere recorded that it had.
 *
 * FIXTURE PROVENANCE
 *
 * `RETENTION_DAYS` is FORMAT-DERIVED from the exported constant it must match, imported here
 * rather than restated so the two cannot drift.
 *
 * Everything else is HAND-DERIVED: every count is computed from the emissions the test itself
 * makes, independently of how the implementation aggregates them. The hook-level cases drive
 * preBashHandler against real files in a temp dir and read the ledger back.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import {
  logHintEmission,
  logSuppressedDetection,
  getHintStatsSummary,
  resetHintStats,
  shouldSuppress,
} from '../src/hint_stats.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postEditHandler } from '../src/hooks_edit.js'
import { postReadHandler } from '../src/hooks_read.js'
import { storeBashOutputSync } from '../src/bash_output_cache.js'
import { recordBashOutput } from '../src/session.js'
import { shortFingerprint } from '../src/fingerprint.js'
import { stripOutputPipeline } from '../src/hooks_bash_commands.js'
import { pruneHintEmissions, STATS_RETENTION_DAYS } from '../src/stats.js'
import { getDb } from '../src/db.js'
import { globalDbPath, configPath } from '../src/constants.js'
import { defaultConfig, saveConfig } from '../src/config.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookEvent } from '../src/hook_registry.js'

const RETENTION_DAYS = STATS_RETENTION_DAYS

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

function nonce(): string {
  return `ud${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function preBashEvent(sessionId: string, command: string, cwd: string): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    agentId: undefined,
    raw: { cwd },
  }
}

function rowsFor(sessionId: string): Array<{
  category: string
  correlator: string | null
  displayed: number
  observable: number
  resolved: number
  bytes_emitted: number | null
}> {
  return getDb(globalDbPath())
    .prepare(
      `SELECT category, correlator, displayed, observable, resolved, bytes_emitted
       FROM hint_emissions WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId) as ReturnType<typeof rowsFor>
}

function summaryFor(category: string) {
  const row = getHintStatsSummary().find((r) => r.category === category)
  expect(row, `no summary row for ${category}`).toBeDefined()
  return row!
}

beforeEach(() => {
  clearModuleCaches()
  resetHintStats()
})

afterEach(() => {
  resetHintStats()
  clearModuleCaches()
})

describe('a detection that never reached the agent still gets a row', () => {
  it('writes it zero-byte, undisplayed, unobservable and already resolved', () => {
    const session = nonce()
    logSuppressedDetection('bash_redirect', session, 'src/paths.ts')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      category: 'bash_redirect',
      correlator: 'src/paths.ts',
      displayed: 0,
      observable: 0,
      // Already resolved, so it never occupies a slot in the pending-resolution scan.
      resolved: 1,
      // Nothing was shown, so nothing was spent -- a NULL here would read as "legacy, unknown".
      bytes_emitted: 0,
    })
  })

  it('counts as detected, and is kept out of every other count', () => {
    const session = nonce()
    logHintEmission('bash_redirect', session, 'src/shown.ts', false, 400)
    logSuppressedDetection('bash_redirect', session, 'src/hidden.ts')
    logSuppressedDetection('bash_redirect', session, 'src/hidden2.ts')

    const row = summaryFor('bash_redirect')
    expect(row.detected).toBe(2)
    expect(row.emitted).toBe(1)
    expect(row.unobservable).toBe(0)
    // The two undisplayed rows cost nothing, so the spend figure must not move.
    expect(row.bytesEmitted).toBe(400)
  })

  it('never enters the efficacy fraction or the suppression sample', () => {
    const cfg = defaultConfig()
    cfg.hint_stats.min_sample_size = 5
    cfg.hint_stats.suppress_threshold_pct = 15
    saveConfig(cfg)
    clearModuleCaches()

    for (let i = 0; i < 20; i++) logSuppressedDetection('bash_redirect', nonce(), `src/f${i}.ts`)

    // 20 detections, none of them shown. There is no evidence here to mute a category on, and
    // an efficacy percentage over rows nobody read would be an invention.
    expect(summaryFor('bash_redirect').efficacyPct).toBeNull()
    expect(shouldSuppress('bash_redirect', nonce())).toBe(false)
  })

  it('is distinguishable from a displayed-but-unscoreable row, which is a different thing', () => {
    const session = nonce()
    logSuppressedDetection('bash_redirect', session, 'src/never-shown.ts')
    logHintEmission('bash_redirect', session, null, false, 300)

    const row = summaryFor('bash_redirect')
    // One reached the agent and could not be scored; one never reached it at all. Pooling them
    // would lose exactly the distinction this column exists to make.
    expect(row.detected).toBe(1)
    expect(row.unobservable).toBe(1)
    expect(row.emitted).toBe(0)
    expect(row.bytesEmitted).toBe(300)
  })

  it('ages out on hint_emissions own retention window, not kept forever', () => {
    const session = nonce()
    logSuppressedDetection('bash_redirect', session, 'src/old.ts')
    const db = getDb(globalDbPath())
    const old = Date.now() - (RETENTION_DAYS + 1) * 86400 * 1000
    db.prepare('UPDATE hint_emissions SET emitted_at = ? WHERE session_id = ?').run(old, session)

    const fresh = nonce()
    logSuppressedDetection('bash_redirect', fresh, 'src/new.ts')

    pruneHintEmissions(db)

    // Positive control in the same run: the recent row must survive, or a prune that deleted
    // everything would pass this test for the wrong reason.
    expect(rowsFor(session)).toHaveLength(0)
    expect(rowsFor(fresh)).toHaveLength(1)
  })
})

describe('the range-read hint records the files its priced gate declined on', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-undisplayed-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('logs an undisplayed detection naming the file, instead of falling silent with no trace', () => {
    const file = path.join(dir, 'sample.ts')
    fs.writeFileSync(file, Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}`).join('\n'), 'utf8')

    const session = nonce()
    const out = preBashHandler(preBashEvent(session, `sed -n '10,52p' sample.ts`, dir))
    // The gate declines here: the file is not indexed in this temp dir, so no substitute can be
    // priced, and an unpriceable proposal has not earned the context it would spend.
    expect(out.hookType).toBe('pass')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.displayed).toBe(0)
    expect(rows[0]!.category).toBe('bash_redirect')
    expect(rows[0]!.correlator).toContain('sample.ts')
  })

  it('names every file a multi-file range read declined on, not just the first', () => {
    for (const name of ['a.ts', 'b.ts']) {
      fs.writeFileSync(path.join(dir, name), Array.from({ length: 80 }, (_, i) => `const x${i} = ${i}`).join('\n'), 'utf8')
    }

    const session = nonce()
    const out = preBashHandler(preBashEvent(session, `sed -n '10,52p' a.ts; sed -n '10,52p' b.ts`, dir))
    expect(out.hookType).toBe('pass')

    const correlators = rowsFor(session).map((r) => r.correlator ?? '')
    expect(correlators).toHaveLength(2)
    expect(correlators.some((c) => c.includes('a.ts'))).toBe(true)
    expect(correlators.some((c) => c.includes('b.ts'))).toBe(true)
  })

  it('negative control: a command the hook never recognized writes no row at all', () => {
    const session = nonce()
    const out = preBashHandler(preBashEvent(session, 'echo hello', dir))
    expect(out.hookType).toBe('pass')
    // Both this and the declines above return `pass`. Only one of them is a decision, and only
    // that one leaves a row -- otherwise the column would count every unremarkable command.
    expect(rowsFor(session)).toHaveLength(0)
  })
})

/**
 * The same decision, at the other net-benefit gates. `detected` has always promised to count a
 * hint "declined by a hint's own net-benefit gate", but only the bash range-read gate above ever
 * wrote such a row: every other site called meetsSavingsFloor and returned `pass` on failure,
 * which is byte-identical to the hook not recognizing the input at all. On one real ledger that
 * left edit_reread_suggest -- 5140 shown hints, more than any other category -- with zero recorded
 * refusals, so its decline rate was not low, it was unmeasured.
 *
 * Every case here is paired with a control, because the way this change fails is by recording an
 * absence as a refusal: a file too short to hint on, or a command with nothing cached, never
 * reached a price comparison and must stay out of the column.
 *
 * PROVENANCE: HAND-DERIVED. The file sizes are computed against the two shipped defaults --
 * hints.min_session_hint_savings_bytes (512) and post_read_code_compress.min_lines (200) -- rather
 * than read off any producer's output, which is sound here because what is under test is a
 * threshold comparison rather than a wire format.
 */
describe('the other net-benefit gates record their declines too', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-decline-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const editEvent = (sessionId: string, file: string): HookEvent => ({
    eventName: 'post_tool_use',
    toolName: 'Edit',
    toolInput: { file_path: file },
    sessionId,
    agentId: undefined,
    raw: { cwd: dir },
  })

  const readEvent = (sessionId: string, file: string): HookEvent => ({
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: file },
    sessionId,
    agentId: undefined,
    raw: { cwd: dir },
  })

  it('names the markdown file whose re-read hint was refused on price', () => {
    const file = path.join(dir, 'tiny.md')
    // Under the 512-byte floor: a `section` hint was composable, and only its price stopped it.
    fs.writeFileSync(file, '# Title\n\nshort\n', 'utf8')

    const session = nonce()
    expect(postEditHandler(editEvent(session, file)).hookType).toBe('pass')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.category).toBe('edit_reread_suggest')
    expect(rows[0]!.displayed).toBe(0)
    expect(rows[0]!.correlator).toContain('tiny.md')
  })

  it('positive control: the same gate above the floor still shows the hint, and books it as shown', () => {
    const file = path.join(dir, 'big.md')
    fs.writeFileSync(file, '# Title\n\n' + 'padding line of prose\n'.repeat(60), 'utf8')
    expect(fs.statSync(file).size).toBeGreaterThan(512)

    const session = nonce()
    expect(postEditHandler(editEvent(session, file)).hookType).toBe('context')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    // Same category, opposite column: without this the test above would pass against a gate that
    // had stopped emitting anything at all.
    expect(rows[0]!.displayed).toBe(1)
  })

  it('names the source file whose structural-navigation hint was refused on price', () => {
    const file = path.join(dir, 'many.ts')
    // 250 lines clears post_read_code_compress.min_lines (200); at 2 bytes a line the whole file
    // is 500 bytes, under the 512-byte floor. Long enough to hint on, too small to be worth it.
    fs.writeFileSync(file, 'a\n'.repeat(250), 'utf8')
    expect(fs.statSync(file).size).toBeLessThan(512)

    const session = nonce()
    expect(postReadHandler(readEvent(session, file)).hookType).toBe('pass')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.category).toBe('read_structural_nav')
    expect(rows[0]!.displayed).toBe(0)
    expect(rows[0]!.correlator).toContain('many.ts')
  })

  it('negative control: a file under min_lines had no hint to decline, so it writes no row', () => {
    const file = path.join(dir, 'few.ts')
    fs.writeFileSync(file, 'a\n'.repeat(10), 'utf8')

    const session = nonce()
    expect(postReadHandler(readEvent(session, file)).hookType).toBe('pass')
    // Also under the floor, so a gate that recorded on size alone would log this one too and
    // report the structural-navigation hint as declining on files it never considered.
    expect(rowsFor(session)).toHaveLength(0)
  })

  it('names the cached output id a recall hint was refused over', () => {
    const cmd = 'npm test'
    // Between hints.bash_dedup_min_bytes (200) and the 512-byte floor: big enough for the dedup
    // branch to take an interest, too small for the recall to pay for the context it would cost.
    const id = storeBashOutputSync(cmd, 'x'.repeat(300), 0, dir)
    recordBashOutput(shortFingerprint(stripOutputPipeline(cmd)), id, 300)

    const session = nonce()
    // Not `pass` like the gates above: a declined recall falls through to the generic compress
    // path, so the refusal is hidden behind an unrelated success rather than behind silence.
    expect(preBashHandler(preBashEvent(session, cmd, dir)).hookType).toBe('rewriteInput')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.category).toBe('bash_recall')
    expect(rows[0]!.displayed).toBe(0)
    // The cache id, not a path: it is what classifyBashHint reads back out of a recall hint that
    // did get shown, so the declined rows join the shown ones on the same key.
    expect(rows[0]!.correlator).toBe(id)
  })

  it('positive control: the same recall above the floor is shown instead of declined', () => {
    const cmd = 'npm test'
    const id = storeBashOutputSync(cmd, 'x'.repeat(4000), 0, dir)
    recordBashOutput(shortFingerprint(stripOutputPipeline(cmd)), id, 4000)

    const session = nonce()
    expect(preBashHandler(preBashEvent(session, cmd, dir)).hookType).toBe('context')

    const rows = rowsFor(session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.displayed).toBe(1)
  })

  it('counts every one of them under detected, which is the column that promised to hold them', () => {
    const session = nonce()
    fs.writeFileSync(path.join(dir, 'a.md'), '# a\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'b.ts'), 'a\n'.repeat(250), 'utf8')

    postEditHandler(editEvent(session, path.join(dir, 'a.md')))
    postReadHandler(readEvent(session, path.join(dir, 'b.ts')))

    // Read back through the summary rather than the table: the doc comment on CategoryEfficacy
    // makes its promise about this surface, and a row that never reaches it keeps the gate blind.
    expect(summaryFor('edit_reread_suggest').detected).toBe(1)
    expect(summaryFor('read_structural_nav').detected).toBe(1)
  })
})
