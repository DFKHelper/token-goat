/** The one-time savings receipt: the first Claude Code session start after token-goat has saved anything shows the user, once, how much it has saved so far. It rides on Claude Code's top-level `systemMessage`, which the user sees and the model does not. Provenance for that wire fact: FORMAT-DERIVED from claude.exe 2.1.284's hook runner, which turns a hook result's `systemMessage` into a `hook_system_message` attachment rendered as "<hook> says: ..." and skips that attachment type when it converts the conversation for the API. So the receipt costs no tokens there, and must never be sent to a harness whose handling of the field nobody has read. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database, { type SqliteDatabase } from '../src/sqlite_driver.js'
import { checkSavingsReceipt } from '../src/cli_doctor.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { closeDb, getDb } from '../src/db.js'
import { serializeOutput } from '../src/hook_registry.js'
import { savingsReceiptText } from '../src/hooks_session_start.js'
import { relayInProcess } from '../src/relay.js'
import { FIRST_RECEIPT_FLAG, GLOBAL_SCHEMA_SQL, claimFirstSavingsReceipt, firstReceiptShownAt, getGlobalDb, summarize } from '../src/stats.js'
import type { HookOutput } from '../src/types.js'

function openStatsDb(dbPath: string): Database {
  const db = new Database(dbPath)
  db.exec(GLOBAL_SCHEMA_SQL)
  return db
}

function seed(db: SqliteDatabase): void {
  const now = Math.floor(Date.now() / 1000)
  const raw = db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, harness) VALUES (?, ?, ?, ?, ?)')
  raw.run(now, 'surgical_read', 28_004, 7_001, 'claudecode')
  raw.run(now, 'secret_redacted', 0, 999, 'claudecode')
  const rolled = db.prepare('INSERT INTO stats_daily_rollup (day, kind, harness, tg_version, events, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?, ?, ?, ?)')
  rolled.run('2026-01-01', 'bash_compress', 'claudecode', '3.0.0', 4, 52_012, 13_003)
  rolled.run('2026-01-01', 'secret_redacted', 'claudecode', '3.0.0', 2, 0, 555)
}

// HAND-DERIVED: 7,001 raw + 13,003 rolled up; the 999 and 555 recorded under the count-only `secret_redacted` kind are placeholders counted, not tokens, and stay out.
const SEEDED_TOTAL = 20_004

describe('claimFirstSavingsReceipt', () => {
  let tempDir: string
  let db: Database

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-'))
    db = openStatsDb(path.join(tempDir, 'global.db'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('claims nothing while nothing has been saved, and leaves the flag unset', () => {
    expect(claimFirstSavingsReceipt(db)).toBeNull()
    expect(firstReceiptShownAt(db)).toBeNull()
  })

  it('claims nothing when the only rows are count-only kinds', () => {
    db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)').run(1, 'secret_redacted', 0, 42)
    expect(claimFirstSavingsReceipt(db)).toBeNull()
    expect(firstReceiptShownAt(db)).toBeNull()
  })

  it('returns the all-time total, raw and rolled-up rows together, the same figure `stats` reports', () => {
    seed(db)
    expect(claimFirstSavingsReceipt(db)).toBe(SEEDED_TOTAL)
    expect(summarize(0, db).total_tokens_saved).toBe(SEEDED_TOTAL)
  })

  it('is shown once: every later claim is null, and the flag records when', () => {
    seed(db)
    // HAND-DERIVED: 2026-09-29T12:00:00Z, stored in whole seconds.
    const shown = Date.UTC(2026, 8, 29, 12, 0, 0)
    expect(claimFirstSavingsReceipt(db, undefined, shown)).toBe(SEEDED_TOTAL)
    expect(claimFirstSavingsReceipt(db, undefined, shown + 60_000)).toBeNull()
    expect(firstReceiptShownAt(db)).toBe(shown)
  })

  it('once shown, does not sum the whole ledger again on every later session start', () => {
    seed(db)
    expect(claimFirstSavingsReceipt(db)).toBe(SEEDED_TOTAL)
    // The sum reads every raw stats row; on a long-lived install that is the cost of each session start, for an answer already known to be null.
    const statements: string[] = []
    const watched = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql) }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    expect(claimFirstSavingsReceipt(watched)).toBeNull()
    expect(statements.filter((sql) => sql.includes('SUM('))).toEqual([])
  })

  it('does not claim a flag another session set between the check and the insert', () => {
    seed(db)
    db.prepare('INSERT INTO stats_flags (name, set_ts) VALUES (?, ?)').run(FIRST_RECEIPT_FLAG, 1)
    // The pre-check is blinded, as if the other session's insert landed just after it ran: only the insert's own row count can refuse the claim now.
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => (sql.startsWith('SELECT 1 FROM stats_flags') ? { get: () => undefined } : target.prepare(sql))
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    expect(claimFirstSavingsReceipt(racing)).toBeNull()
  })
})

describe('serializeOutput carries a notice as systemMessage on Claude Code only', () => {
  const notice = savingsReceiptText(SEEDED_TOTAL)

  it('keeps the notice out of the model-bound additionalContext', () => {
    const out = JSON.parse(serializeOutput({ hookType: 'context', context: 'reminder', notice }, 'session_start', 'claudecode')) as Record<string, unknown>
    expect(out['systemMessage']).toBe(notice)
    expect(out['hookSpecificOutput']).toEqual({ hookEventName: 'SessionStart', additionalContext: 'reminder' })
  })

  it('sends a notice on a pass as a bare systemMessage', () => {
    expect(JSON.parse(serializeOutput({ hookType: 'pass', notice }, 'session_start', 'claudecode'))).toEqual({ systemMessage: notice })
  })

  it.each(['codex', 'copilot_cli', 'vscode'] as const)('drops the notice for %s', (harness) => {
    for (const output of [{ hookType: 'context', context: 'reminder', notice }, { hookType: 'pass', notice }] as HookOutput[]) {
      expect(serializeOutput(output, 'session_start', harness)).not.toContain('saved about')
    }
  })
})

describe('the receipt through the real relay', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let project: string

  // FORMAT-DERIVED: https://code.claude.com/docs/en/hooks.md, fetched 2026-09-25, the SessionStart JSON input example (the same envelope as tests/fixtures/harness_hook_payloads.ts's claudecode session_start case).
  function sessionStartPayload(): Record<string, unknown> {
    return { session_id: 'receipt-e2e', transcript_path: path.join(project, 'transcript.jsonl'), cwd: project, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }
  }

  async function sessionStart(): Promise<Record<string, unknown>> {
    return JSON.parse(await relayInProcess('session_start', sessionStartPayload())) as Record<string, unknown>
  }

  beforeEach(() => {
    // No clearModuleCaches: it empties the hook registry relay.ts's imports filled once (see tests/call_streak.test.ts).
    for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID']) savedEnv[key] = process.env[key]
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-proj-'))
    const db = getGlobalDb()
    for (const table of ['stats', 'stats_daily_rollup', 'stats_flags']) db.exec(`DELETE FROM ${table}`)
    seed(db)
  })

  afterEach(() => {
    saveConfig(defaultConfig())
    invalidateConfigCache()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('shows the receipt on the first Claude Code session start and never again', async () => {
    const first = await sessionStart()
    expect(first['systemMessage']).toBe('token-goat has saved about 20,004 tokens so far. Run `token-goat stats` for the detail.')
    const context = (first['hookSpecificOutput'] as { additionalContext: string }).additionalContext
    expect(context).toContain('token-goat')
    expect(context).not.toContain('saved about')

    const second = await sessionStart()
    expect(second['systemMessage']).toBeUndefined()
    expect(second['hookSpecificOutput']).toBeDefined()
  })

  it('does not spend the one-time claim on a harness that would drop it', async () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'codex'
    expect(JSON.stringify(await sessionStart())).not.toContain('saved about')
    expect(firstReceiptShownAt()).toBeNull()

    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    expect((await sessionStart())['systemMessage']).toContain('20,004')
  })

  it('still shows the receipt when the session-start reminder is turned off', async () => {
    const cfg = defaultConfig()
    cfg.hints.session_start_reminder = false
    saveConfig(cfg)
    invalidateConfigCache()
    // The handler has nothing for the model here, so it answers pass; the notice on that pass must survive runHook's fold to a bare pass.
    expect(await sessionStart()).toEqual({ systemMessage: savingsReceiptText(SEEDED_TOTAL) })
  })
})

describe('doctor reports the receipt', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-doctor-'))
  })

  afterEach(() => {
    closeDb(path.join(tempDir, 'global.db'))
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('as not shown when there is no database yet', () => {
    expect(checkSavingsReceipt(path.join(tempDir, 'global.db'))).toEqual({ name: 'Savings receipt', status: 'ok', message: 'not shown yet' })
  })

  it('as not shown before the flag is set, and by date after', () => {
    const dbPath = path.join(tempDir, 'global.db')
    const db = getDb(dbPath)
    db.exec(GLOBAL_SCHEMA_SQL)
    expect(checkSavingsReceipt(dbPath).message).toBe('not shown yet')
    // HAND-DERIVED: 1790683200 s is 2026-09-29T12:00:00Z.
    db.prepare('INSERT INTO stats_flags (name, set_ts) VALUES (?, ?)').run(FIRST_RECEIPT_FLAG, 1_790_683_200)
    expect(checkSavingsReceipt(dbPath)).toEqual({ name: 'Savings receipt', status: 'ok', message: 'shown 2026-09-29' })
  })
})
