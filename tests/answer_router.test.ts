/**
 * Tests for `token-goat answer` -- the deterministic question router in src/answer_router.ts.
 *
 * FIXTURE PROVENANCE: CAPTURE. Every question string in QUESTIONS below is a verbatim, unedited
 * line extracted from a real Claude Code session transcript for this repository:
 *   C:/Users/zelys/.claude/projects/C--Projects-token-goat/2ab49bbf-9914-4011-81d8-e30ccde5b635.jsonl
 *   (512,191,083 bytes, captured 2026-09-20)
 * Extraction command:
 *   rg -o '"description":"[^"]{6,70}"' <transcript> | sed 's/^"description":"//; s/"$//' | sort -u
 * That yields 25,425 distinct agent-authored statements of intent. The 20 below were selected from
 * it by hand and each was then re-verified against the extraction with `grep -Fxq` before being
 * pasted here. None was written from the router's own regexes -- which is the point: a corpus
 * derived from the implementation agrees with the implementation's bugs by construction, and this
 * repository has shipped that defect 6+ times across three unrelated subsystems.
 *
 * The integration cases index this repo's own `src` tree (HAND-DERIVED expectations: the symbol
 * `foldPath` lives in src/path_containment.ts, verifiable with `token-goat symbol foldPath`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { beforeAll, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { querySymbols } from '../src/index_reader.js'

import {
  classify,
  isJudgementQuestion,
  normalizeQuestion,
  normalizeSubject,
  refusal,
  resolveSubject,
  runAnswer,
} from '../src/answer_router.js'
import { captureStdout } from './helpers/capture-stdout.js'
import { indexSrcTree, WHOLE_SRC_INDEX_TIMEOUT_MS } from './helpers/index-src-tree.js'

/** Verbatim CAPTURE lines; see the provenance block above for the transcript and extraction command. */
const QUESTIONS = {
  judgement: [
    'Does symbol accept a comma list',
    'Does any command mutate process.env?',
    'Does storeBashOutput redact its cached copy',
    'Is the filter framework wired at all',
    'Why the existing startup guard missed it',
    'Explain the ordered refs query',
    'How cli_registration enumerates commands',
  ],
  noIntent: ['Which job failed', 'Where hintPath is assigned'],
  callers: [
    { q: 'Callers of resolveSymbolSpec', subject: 'resolveSymbolSpec' },
    { q: 'Call sites of _applyFiltersAndPrint', subject: '_applyFiltersAndPrint' },
    { q: 'All runHook call sites', subject: 'runHook' },
    { q: 'All createMcpServer call sites', subject: 'createMcpServer' },
    { q: 'All staleWarning call sites', subject: 'staleWarning' },
  ],
  exports: [
    { q: 'Check base.ts exports', subject: 'base.ts' },
    { q: 'Check env.ts exports', subject: 'env.ts' },
    { q: 'Check doc_compact exports', subject: 'doc_compact' },
  ],
  unresolvableWhere: ['Where is injection fencing applied?', 'Where is cross-project confinement enforced'],
  tests: [{ q: 'Check test coverage for the ranged-read case', subject: 'ranged-read case' }],
} as const

function captureErr(fn: () => number): { out: string; err: string; code: number } {
  let err = ''
  const origErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    if (typeof chunk === 'string') err += chunk
    return true
  }) as typeof process.stderr.write
  let code = -1
  const out = captureStdout(() => {
    try {
      code = fn()
    } finally {
      process.stderr.write = origErr
    }
  })
  return { out, err, code }
}

describe('classify (pure, no index)', () => {
  it('refuses every captured judgement/behaviour question', () => {
    for (const q of QUESTIONS.judgement) {
      expect(isJudgementQuestion(q), `should be judgement: ${q}`).toBe(true)
      expect(classify(q), `should not classify: ${q}`).toBeNull()
    }
  })

  it('refuses captured questions that match no intent', () => {
    for (const q of QUESTIONS.noIntent) {
      expect(classify(q), `should not classify: ${q}`).toBeNull()
    }
  })

  it('routes every captured caller-shaped question to the callers intent with the right subject', () => {
    for (const { q, subject } of QUESTIONS.callers) {
      expect(classify(q), `failed on: ${q}`).toEqual({ intent: 'callers', subject })
    }
  })

  it('routes every captured export-shaped question to the exports intent, stripping the imperative verb', () => {
    for (const { q, subject } of QUESTIONS.exports) {
      expect(classify(q), `failed on: ${q}`).toEqual({ intent: 'exports', subject })
    }
  })

  it('routes the captured test-coverage question to the tests intent', () => {
    for (const { q, subject } of QUESTIONS.tests) {
      expect(classify(q), `failed on: ${q}`).toEqual({ intent: 'tests', subject })
    }
  })

  it('classifies the captured unresolvable where-questions as where, leaving the refusal to subject resolution', () => {
    for (const q of QUESTIONS.unresolvableWhere) {
      expect(classify(q)?.intent, `failed on: ${q}`).toBe('where')
    }
  })

  it('a judgement question naming a resolvable symbol still refuses -- the hard over-firing case', () => {
    for (const q of ['why does foldPath fold the case', 'is foldPath correct', "what's the bug in foldPath", 'should I rewrite foldPath']) {
      expect(classify(q), `should not classify: ${q}`).toBeNull()
    }
    // Calibration, the other direction: the same symbol in a routable question must still route.
    expect(classify('who calls foldPath')).toEqual({ intent: 'callers', subject: 'foldPath' })
  })

  it('normalizes whitespace, question marks, and a leading imperative verb', () => {
    expect(normalizeQuestion('  Check   env.ts   exports ?? ')).toBe('env.ts exports')
    expect(normalizeSubject('  `foldPath`, ')).toBe('foldPath')
    expect(normalizeSubject('the foldPath')).toBe('foldPath')
  })

  it('formats a refusal with both a reason and a next command', () => {
    expect(refusal('why', 'token-goat semantic "x"')).toBe('cannot answer deterministically: why; try: token-goat semantic "x"')
  })
})

describe('runAnswer against the real index', () => {
  beforeAll(() => {
    indexSrcTree()
  }, WHOLE_SRC_INDEX_TIMEOUT_MS)

  it('resolves a bare symbol subject and answers who-calls via the callers command', () => {
    const r = captureErr(() => runAnswer({ question: 'who calls foldPath' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat callers foldPath')
    expect(r.out).toMatch(/\bsrc\/[^\s]+\.ts:\d+/)
  })

  it('resolves a SYMBOL subject to its defining FILE for test-for -- the failure class `test-for foldPath` has today', () => {
    const r = captureErr(() => runAnswer({ question: 'what tests cover foldPath' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat test-for src/path_containment.ts')
    expect(r.err).not.toContain('Could not read')
  })

  it('answers what-does-X-export for a path subject', () => {
    const r = captureErr(() => runAnswer({ question: 'what does src/paths.ts export' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat exports src/paths.ts')
    expect(r.out).toContain('normalizePath')
  })

  it('answers what-does-X-import', () => {
    const r = captureErr(() => runAnswer({ question: 'what does src/answer_router.ts import' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat imports src/answer_router.ts')
    expect(r.out).toContain('./index_reader.js')
  })

  it('answers what-breaks-if-X-changes via impact', () => {
    const r = captureErr(() => runAnswer({ question: 'what breaks if foldPath changes' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat impact foldPath')
  })

  it('answers where-is via symbol', () => {
    const r = captureErr(() => runAnswer({ question: 'where is foldPath' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat symbol foldPath')
    expect(r.out).toContain('src/path_containment.ts')
  })

  it('never resolves a subject to a same-named symbol in a DIFFERENT project', () => {
    // The symbols table is machine-wide. Dogfooding the built binary against this repo answered
    // "where does normalizePath live" with a JavaScript file in an unrelated website checkout and
    // "tests for runWorker" with a scratch script on another drive -- both confident, both wrong.
    // An index holding only one project cannot show that, so this indexes a decoy outside the root.
    // The decoy's symbol name exists ONLY outside the root, so the assertion does not depend on
    // which of two same-named rows querySymbols happens to order first: scoped, there is no
    // in-project row at all and the only correct answer is a refusal.
    const outside = mkdtempSync(join(tmpdir(), 'tg-answer-foreign-'))
    try {
      const decoy = join(outside, 'decoy.ts')
      writeFileSync(decoy, 'export function zzForeignOnlySymbol(p: string): string {\n  return p\n}\n')
      indexFileSync(normalizePath(decoy))
      // Calibration: the decoy really is in the index unscoped, so the null below is scoping and not a failed write.
      const unscoped = querySymbols({ name: 'zzForeignOnlySymbol', limit: 5 }).map((s) => s.filePath)
      expect(unscoped).toContain(normalizePath(decoy))

      expect(resolveSubject('zzForeignOnlySymbol'), 'resolved a symbol from another project').toBeNull()

      const r = captureErr(() => runAnswer({ question: 'who calls zzForeignOnlySymbol' }))
      expect(r.code).toBe(1)
      expect(r.err).toContain("'zzForeignOnlySymbol' is not an indexed symbol or file")
      // Calibration, the other direction: an in-project symbol still resolves under the same scoping.
      expect(resolveSubject('foldPath')?.kind).toBe('symbol')

      // Resolving the subject in-project is not enough on its own: the DELEGATE has to be scoped
      // too. `where` hands the name to runSymbol, which without a projectRoot searches the same
      // machine-wide table and lists every same-named definition on the machine.
      const shared = join(outside, 'shared.ts')
      writeFileSync(shared, 'export function foldPath(p: string): string {\n  return p\n}\n')
      indexFileSync(normalizePath(shared))
      expect(querySymbols({ name: 'foldPath', limit: 50 }).map((s) => s.filePath)).toContain(normalizePath(shared))

      const rWhere = captureErr(() => runAnswer({ question: 'where is foldPath' }))
      expect(rWhere.code).toBe(0)
      expect(rWhere.out).toContain('path_containment.ts')
      expect(rWhere.out, 'the where delegate listed a definition from another project').not.toContain('tg-answer-foreign-')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('resolves a bare basename to the single project file carrying it', () => {
    const resolved = resolveSubject('path_containment.ts')
    expect(resolved?.kind).toBe('file')
  })

  it('refuses a judgement question that names a resolvable symbol, citing judgement and not a missing subject', () => {
    const r = captureErr(() => runAnswer({ question: 'why does foldPath fold the case' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain('cannot answer deterministically: that asks for judgement')
    expect(r.err).toContain('try: token-goat semantic')
    expect(r.out).toBe('')
  })

  it('refuses when the subject is not in the index rather than guessing a near match', () => {
    const r = captureErr(() => runAnswer({ question: 'who calls notARealSymbolAnywhere' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain("'notARealSymbolAnywhere' is not an indexed symbol or file")
    expect(r.out).toBe('')
  })

  it('refuses every captured unresolvable where-question, suggesting semantic search', () => {
    for (const q of QUESTIONS.unresolvableWhere) {
      const r = captureErr(() => runAnswer({ question: q }))
      expect(r.code, `should refuse: ${q}`).toBe(1)
      expect(r.err).toContain('is not an indexed symbol or file')
      expect(r.err).toContain('token-goat semantic')
    }
  })

  it('refuses a symbol-only intent given a file subject, and names the command that does take a file', () => {
    const r = captureErr(() => runAnswer({ question: 'who calls src/paths.ts' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain("'src/paths.ts' is a file, and callers needs a symbol")
    expect(r.err).toContain('try: token-goat outline src/paths.ts')
  })

  it('refuses an empty question', () => {
    const r = captureErr(() => runAnswer({ question: '   ' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain('the question is empty')
  })
})
