/** `token-goat answer` books every call in the stats ledger: `answer:<route>` naming the command it delegated to (the one its `via:` line prints), with the delegate's outcome as detail, or `answer:refused` with the reason it refused. `stats` then lists an `answer` row under By Command. Before this the router recorded nothing of its own: a routed answer was booked only as the delegate's kind, indistinguishable from a direct call, and a refusal left no trace, so neither how often `answer` is used nor how often it refuses could be measured. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAnswer } from '../src/answer_router.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { getGlobalDb, summarize } from '../src/stats.js'

let root: string
let origCwd: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-answer-ledger-')))
  origCwd = process.cwd()
  process.chdir(root)
  // HAND-DERIVED: a definition and one caller, names unique to this file, so the router resolves the subject in this scratch project only.
  const def = join(root, 'ledger_def5w.ts')
  const caller = join(root, 'ledger_caller5w.ts')
  writeFileSync(def, 'export function ledgerTarget5w(): number {\n  return 1\n}\n')
  writeFileSync(caller, "import { ledgerTarget5w } from './ledger_def5w.js'\nexport function ledgerUser5w(): number {\n  return ledgerTarget5w()\n}\n")
  indexFileSync(normalizePath(def))
  indexFileSync(normalizePath(caller))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

/** Every `answer:*` row written so far, oldest first, as `kind detail`. */
function answerRows(): string[] {
  const rows = getGlobalDb().prepare(`SELECT kind, detail FROM stats WHERE kind LIKE 'answer:%' ORDER BY rowid`).all() as Array<{ kind: string; detail: string | null }>
  return rows.map((r) => `${r.kind} ${r.detail ?? ''}`)
}

describe('answer outcome ledger', () => {
  it('books the route each answered question took, named as its via: line names it', () => {
    const before = answerRows().length
    // HAND-DERIVED from CAPTURE shapes in tests/answer_router.test.ts ('Callers of resolveSymbolSpec') and the router's own `where is X` intent, with this file's subject substituted.
    expect(runAnswer({ question: 'Callers of ledgerTarget5w' })).toBe(0)
    expect(runAnswer({ question: 'Where is ledgerTarget5w' })).toBe(0)
    expect(runAnswer({ question: 'Check ledger_def5w.ts exports' })).toBe(0)
    expect(answerRows().slice(before)).toEqual(['answer:callers answered', 'answer:symbol answered', 'answer:exports answered'])
  })

  it('books each refusal with the reason it refused', () => {
    const before = answerRows().length
    expect(runAnswer({ question: '   ' })).toBe(1)
    // CAPTURE: verbatim lines from tests/answer_router.test.ts QUESTIONS.judgement and QUESTIONS.noIntent.
    expect(runAnswer({ question: 'Does symbol accept a comma list' })).toBe(1)
    expect(runAnswer({ question: 'Which job failed' })).toBe(1)
    // HAND-DERIVED: a callers question whose subject is in no index table.
    expect(runAnswer({ question: 'Callers of noSuchLedgerSymbol5w' })).toBe(1)
    // HAND-DERIVED: a where question naming a file, which needs a symbol.
    expect(runAnswer({ question: 'Where is ledger_def5w.ts' })).toBe(1)
    expect(answerRows().slice(before)).toEqual([
      'answer:refused empty',
      'answer:refused judgement',
      'answer:refused no-intent',
      'answer:refused unresolved',
      'answer:refused file-needs-symbol',
    ])
  })

  it('summarize lists an answer row under by_command that counts every routed and refused call', () => {
    runAnswer({ question: 'Callers of ledgerTarget5w' })
    runAnswer({ question: 'Which job failed' })
    const row = summarize(30).by_command.find((r) => r.command === 'answer')
    expect(row?.events).toBe(answerRows().length)
    expect(row?.events).toBeGreaterThanOrEqual(2)
  })
})
