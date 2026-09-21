/**
 * Tests for `token-goat answer` -- the deterministic question router in src/answer_router.ts.
 *
 * FIXTURE PROVENANCE: CAPTURE. Every question string in QUESTIONS below is a verbatim, unedited
 * line extracted from a real Claude Code session transcript for this repository:
 *   C:/Users/zelys/.claude/projects/C--Projects-token-goat/2ab49bbf-9914-4011-81d8-e30ccde5b635.jsonl
 *   (512,191,083 bytes, captured 2026-09-20)
 * Extraction command:
 *   rg -o '"description":"[^"]{6,70}"' <transcript> | sed 's/^"description":"//; s/"$//' | sort -u
 * That yields ~25,400 distinct agent-authored statements of intent (25,425 on the first run, 25,447
 * when re-run under Git Bash's `sort -u`; the per-shape counts quoted below come from the re-run).
 * The 30 lines below were selected from it by hand and each was then re-verified against the
 * extraction with `grep -Fxq` before being pasted here. None was written from the router's own
 * regexes -- which is the point: a corpus derived from the implementation agrees with the
 * implementation's bugs by construction, and this repository has shipped that defect 6+ times across
 * three unrelated subsystems.
 *
 * The integration cases index this repo's own `src` tree (HAND-DERIVED expectations: the symbol
 * `foldPath` lives in src/path_containment.ts and the file src/config.ts exists, both verifiable
 * with `token-goat symbol foldPath` / `token-goat outline src/config.ts`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { beforeAll, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { querySymbols } from '../src/index_reader.js'
import { runCallers } from '../src/graph_commands.js'
import { runSymbol } from '../src/read_commands.js'

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
  /** The bare `X imports` form. 34 hits in the corpus against 15 for `X exports`, so the commoner of the pair was the one with no rule. */
  bareImports: [
    { q: 'Check config imports', subject: 'config' },
    { q: 'List hooks_compact imports', subject: 'hooks_compact' },
    { q: 'Check fold_delivery imports', subject: 'fold_delivery' },
    { q: 'Check image_shrink imports', subject: 'image_shrink' },
  ],
  /** Retrieval verbs the imperative strip did not cover. Each carries a different intent so the strip is shown to run before intent matching, not inside one rule. */
  retrievalVerbs: [
    { q: 'Locate jsonc call sites', intent: 'callers', subject: 'jsonc' },
    { q: 'Read cli_doctor imports', intent: 'imports', subject: 'cli_doctor' },
    { q: 'Measure the blast radius of the substring guard', intent: 'impact', subject: 'substring guard' },
  ],
  /** Edit instructions that are shaped exactly like the bare `X imports` query. They must still classify -- the refusal is subject resolution's job -- but they must never produce an answer. */
  editInstructions: ['Add imports', 'Update imports', 'Remaining imports'],
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

  it('routes every captured bare `X imports` question to the imports intent -- the commoner of the pair had no rule', () => {
    for (const { q, subject } of QUESTIONS.bareImports) {
      expect(classify(q), `failed on: ${q}`).toEqual({ intent: 'imports', subject })
    }
  })

  it('strips the captured retrieval verbs, which the imperative strip did not cover', () => {
    for (const { q, intent, subject } of QUESTIONS.retrievalVerbs) {
      expect(classify(q), `failed on: ${q}`).toEqual({ intent, subject })
    }
  })

  it('does NOT strip an edit verb: a captured edit instruction shaped like a query must not become one', () => {
    // These classify (the shape really is `X imports`), and are refused one layer down by subject resolution -- see the integration case of the same name. What must not happen is the verb being peeled, which would turn "Add imports" into the bare query "imports".
    for (const q of QUESTIONS.editInstructions) {
      expect(classify(q)?.intent, `failed on: ${q}`).toBe('imports')
      expect(classify(q)?.subject, `verb was stripped from: ${q}`).not.toBe('imports')
    }
  })

  it('matches the what-breaks phrasings its own refusal message advertises', () => {
    // HAND-DERIVED: each phrasing is a rewording of the capability the impact refusal already claims ("what-breaks questions"), written from that promise rather than from the patterns -- which is the point, since the patterns are what did not keep it.
    for (const q of [
      'what breaks if I change foldPath',
      'what breaks when foldPath changes',
      'what depends on foldPath',
      'what is impacted by foldPath',
      "what's impacted by foldPath",
    ]) {
      expect(classify(q), `failed on: ${q}`).toEqual({ intent: 'impact', subject: 'foldPath' })
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
    expect(r.out.split('\n')[0]).toBe('via: token-goat callers foldPath --limit 20')
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
    expect(r.out.split('\n')[0]).toBe('via: token-goat impact foldPath --top 20')
  })

  it('answers where-is via symbol', () => {
    const r = captureErr(() => runAnswer({ question: 'where is foldPath' }))
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat symbol foldPath -p --exclude-vendored')
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

  it('resolves a module-shaped subject to the file it names, not to a same-named symbol elsewhere', () => {
    // The shipped defect: `exports`/`imports` resolved symbol-first, so a bare word landed on whichever same-named symbol sorted first and the intent then followed it to THAT symbol's file. Against this repo's real index, `Check config exports` answered about src/bridges/openclaw_install.ts; 12 of the 14 captured subjects that resolved at all were wrong the same way.
    for (const { q, file } of [
      { q: 'Check config exports', file: 'src/config.ts' },
      { q: 'Check image_shrink imports', file: 'src/image_shrink.ts' },
      { q: 'List read_commands imports', file: 'src/read_commands.ts' },
      { q: 'Locate src/paths.ts exports', file: 'src/paths.ts' },
    ]) {
      const r = captureErr(() => runAnswer({ question: q }))
      expect(r.code, `should answer: ${q} (${r.err})`).toBe(0)
      expect(r.out.split('\n')[0]).toMatch(new RegExp(`^via: token-goat (?:exports|imports) ${file.replace('.', '\\.')}$`))
    }
  })

  it('refuses a symbol subject for a file-level intent instead of answering about its defining file', () => {
    const r = captureErr(() => runAnswer({ question: 'exports of foldPath' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain("'foldPath' is a symbol; exports/imports are file-level")
    expect(r.err).toContain('try: token-goat exports src/path_containment.ts')
    expect(r.out).toBe('')
  })

  it('refuses every captured edit instruction shaped like a bare imports query', () => {
    for (const q of QUESTIONS.editInstructions) {
      const r = captureErr(() => runAnswer({ question: q }))
      expect(r.code, `should refuse: ${q}`).toBe(1)
      expect(r.out, `answered an edit instruction: ${q}`).toBe('')
    }
  })

  it('keeps the symbol-to-file translation for tests while letting a file subject win', () => {
    const bySymbol = captureErr(() => runAnswer({ question: 'what tests cover foldPath' }))
    expect(bySymbol.code).toBe(0)
    expect(bySymbol.out.split('\n')[0]).toBe('via: token-goat test-for src/path_containment.ts')

    const byFile = captureErr(() => runAnswer({ question: 'what tests cover config' }))
    expect(byFile.code).toBe(0)
    expect(byFile.out.split('\n')[0]).toBe('via: token-goat test-for src/config.ts')
  })

  it('reports an ambiguous extensionless stem rather than picking one of the files', () => {
    const r = captureErr(() => runAnswer({ question: 'registry exports' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain("'registry' names 2 files in this project")
    expect(r.err).toContain('src/bridges/registry.ts')
    expect(r.err).toContain('src/languages/registry.ts')
  })

  it('never resolves a subject into a vendored, generated, or tool-metadata tree', () => {
    // This repo's own index carries six files under node_modules/ and a .git/config row: the indexing walk skips those directories, but a hook indexes whatever file was just read and `token-goat index <file>` names one directly. Unfiltered they answered "where is worker" with a pdfjs type declaration, and `Check config exports` was ambiguous between .git/config and src/config.ts.
    const vendorDir = join(resolve('node_modules'), '.tg-answer-fixture')
    const ignoredDir = join(resolve('coverage'), 'tg-answer-fixture')
    try {
      mkdirSync(vendorDir, { recursive: true })
      mkdirSync(ignoredDir, { recursive: true })
      const vendored = join(vendorDir, 'zzVendorFixture.ts')
      const generated = join(ignoredDir, 'zzGeneratedFixture.ts')
      writeFileSync(vendored, 'export function zzVendorOnlySymbol(p: string): string {\n  return p\n}\n')
      writeFileSync(generated, 'export function zzGeneratedOnlySymbol(p: string): string {\n  return p\n}\n')
      indexFileSync(normalizePath(vendored))
      indexFileSync(normalizePath(generated))

      // Calibration: both rows really are in the index and inside this project root, so the refusals below are the filter and not a failed write.
      const root = normalizePath(resolve('.'))
      for (const name of ['zzVendorOnlySymbol', 'zzGeneratedOnlySymbol']) {
        expect(querySymbols({ name, rootDir: root, limit: 5 }).length, `${name} was never indexed`).toBeGreaterThan(0)
      }

      expect(resolveSubject('zzVendorOnlySymbol')).toBeNull()
      expect(resolveSubject('zzGeneratedOnlySymbol')).toBeNull()
      // The file reading has to be filtered too, or the extensionless stem walks straight back in.
      expect(resolveSubject('zzVendorFixture', 'file-only')).toBeNull()
      expect(resolveSubject('zzGeneratedFixture.ts', 'file-only')).toBeNull()

      const r = captureErr(() => runAnswer({ question: 'where is zzVendorOnlySymbol' }))
      expect(r.code).toBe(1)
      expect(r.err).toContain("'zzVendorOnlySymbol' is not an indexed symbol or file")
      // Calibration, the other direction: an in-project source symbol still resolves under the same filter.
      expect(resolveSubject('foldPath')?.kind).toBe('symbol')
    } finally {
      rmSync(vendorDir, { recursive: true, force: true })
      rmSync(ignoredDir, { recursive: true, force: true })
    }
  })

  it('finds a real symbol that hundreds of vendored rows of the same name sort in front of', () => {
    // Ignored trees sort FIRST under `ORDER BY file_path` (`node_modules/` before `tests/`), so they fill the front of any page: a fixed cap followed by a filter reports "no such symbol" for a symbol that is plainly there. This project's index really does hold 147 rows named `constructor` under node_modules/ from six files, measured against the live index on 2026-09-20, so the 260 below is a fixture of a shape that exists rather than an invented extreme.
    const vendorDir = join(resolve('node_modules'), '.tg-answer-crowd')
    const realFile = join(resolve('tests'), '.tg-answer-crowd-fixture.ts')
    try {
      mkdirSync(vendorDir, { recursive: true })
      const crowd = join(vendorDir, 'crowd.ts')
      const classes = Array.from({ length: 260 }, (_, i) => `export class ZzCrowd${i} {\n  zzCrowdedSymbol(): number {\n    return ${i}\n  }\n}`)
      writeFileSync(crowd, `${classes.join('\n')}\n`)
      writeFileSync(realFile, 'export function zzCrowdedSymbol(): number {\n  return -1\n}\n')
      indexFileSync(normalizePath(crowd))
      indexFileSync(normalizePath(realFile))

      const root = normalizePath(resolve('.'))
      const all = querySymbols({ name: 'zzCrowdedSymbol', rootDir: root, limit: 1000 })
      // Calibration: the vendored rows really do crowd the front of the ordering, and there really are more of them than one page holds. Without this the test passes for the wrong reason on any index where they happen to sort last.
      expect(all.length, 'the crowd fixture was never indexed').toBeGreaterThan(200)
      expect(all[0]?.filePath, 'the vendored rows did not sort first, so nothing is being crowded out').toContain('node_modules')

      const resolved = resolveSubject('zzCrowdedSymbol')
      expect(resolved?.kind).toBe('symbol')
      expect(resolved?.kind === 'symbol' ? resolved.file : '').toContain('.tg-answer-crowd-fixture.ts')
    } finally {
      rmSync(vendorDir, { recursive: true, force: true })
      rmSync(realFile, { force: true })
    }
  })

  // HAND-DERIVED fixture: the 40 caller functions and the one definition below are written by this test, so the expected counts (40 total, 20 shown) are computed from the input independently of the router's own code. The bound itself was chosen from CAPTURE measurement against this repo's live index on 2026-09-20: `answer "who calls normalizePath"` emitted 24,274 bytes / 501 lines unbounded, against 21,091 bytes for src/paths.ts -- the very file the answer exists to replace -- and 996 bytes at this bound.
  it('bounds the callers delegate, discloses what it withheld, and prints a via: line that reproduces that exact window', () => {
    const defFile = join(resolve('tests'), '.tg-answer-bound-def.ts')
    const callerFile = join(resolve('tests'), '.tg-answer-bound-callers.ts')
    try {
      writeFileSync(defFile, 'export function zzAnswerBoundTarget(): number {\n  return 1\n}\n')
      const callers = Array.from({ length: 40 }, (_, i) => `export function zzAnswerBoundCaller${i}(): number {\n  return zzAnswerBoundTarget()\n}`)
      writeFileSync(callerFile, `${callers.join('\n')}\n`)
      indexFileSync(normalizePath(defFile))
      indexFileSync(normalizePath(callerFile))

      // Calibration: the fixture really does have more callers than the bound, so a 20-row page below is the cap biting and not a short index.
      const unbounded = captureErr(() => runCallers({ symbol: 'zzAnswerBoundTarget' }))
      expect(unbounded.out.trim().split('\n').length, 'the 40 callers were never indexed').toBe(40)
      expect(unbounded.err, 'an unbounded page withheld nothing, so it must not claim it did').not.toContain('Showing the first')

      const r = captureErr(() => runAnswer({ question: 'who calls zzAnswerBoundTarget' }))
      expect(r.code).toBe(0)
      const lines = r.out.trim().split('\n')
      expect(lines[0]).toBe('via: token-goat callers zzAnswerBoundTarget --limit 20')
      // Pre-fix the router passed no bound at all, so this was 40 rows here and 500 against a real symbol.
      expect(lines.length - 1).toBe(20)
      // A cap with no disclosure is worse than no cap: the reader cannot tell a complete answer from a clipped one.
      expect(r.err).toContain('Showing the first 20 of 40 callers (raise --limit to see the rest).')
    } finally {
      rmSync(defFile, { force: true })
      rmSync(callerFile, { force: true })
    }
  })

  // HAND-DERIVED fixture: two definitions of one name, one written into node_modules/ and one into tests/, so which row must survive is decided by the fixture layout rather than by any predicate in the implementation.
  it('drops a vendored definition from the where delegate, and says so in the via: line', () => {
    const vendorDir = join(resolve('node_modules'), '.tg-answer-vendor-out')
    const realFile = join(resolve('tests'), '.tg-answer-vendor-out-fixture.ts')
    try {
      mkdirSync(vendorDir, { recursive: true })
      const vendored = join(vendorDir, 'shadow.ts')
      writeFileSync(vendored, 'export function zzAnswerVendorShadow(): number {\n  return 0\n}\n')
      writeFileSync(realFile, 'export function zzAnswerVendorShadow(): number {\n  return -1\n}\n')
      indexFileSync(normalizePath(vendored))
      indexFileSync(normalizePath(realFile))

      const rootDir = normalizePath(resolve('.'))
      // Calibration: the vendored row really is in the index and really does reach the unfiltered delegate, so the absence asserted below is the filter working and not a failed write.
      const unfiltered = runSymbol({ name: 'zzAnswerVendorShadow', projectRoot: rootDir, limit: 20 })
      expect(unfiltered.text, 'the vendored fixture was never indexed').toContain('node_modules')

      const r = captureErr(() => runAnswer({ question: 'where is zzAnswerVendorShadow' }))
      expect(r.code).toBe(0)
      expect(r.out.split('\n')[0]).toBe('via: token-goat symbol zzAnswerVendorShadow -p --exclude-vendored')
      expect(r.out).not.toContain('node_modules')
      expect(r.out).toContain('.tg-answer-vendor-out-fixture.ts')
    } finally {
      rmSync(vendorDir, { recursive: true, force: true })
      rmSync(realFile, { force: true })
    }
  })

  // HAND-DERIVED fixture: one name defined twice, once inside this project and once in a temp directory that is its own project root, so which definition belongs in the answer is fixed by the layout rather than by any code under test.
  it('replays its own where-intent via: line to the same bytes it printed, project scope included', () => {
    const foreignRoot = mkdtempSync(join(tmpdir(), 'tg-answer-foreign-'))
    const realFile = join(resolve('tests'), '.tg-answer-scope-fixture.ts')
    try {
      const foreignFile = join(foreignRoot, 'foreign.ts')
      writeFileSync(foreignFile, 'export function zzAnswerScopedName(): number {\n  return 7\n}\n')
      writeFileSync(realFile, 'export function zzAnswerScopedName(): number {\n  return -7\n}\n')
      indexFileSync(normalizePath(foreignFile))
      indexFileSync(normalizePath(realFile))

      // Calibration: `symbol` really is machine-wide unless a project scope is passed, so the foreign definition really does reach an unscoped call. Without this the assertions below pass on any machine whose index happens to hold one definition.
      const unscoped = runSymbol({ name: 'zzAnswerScopedName', limit: 20, excludeVendored: true })
      expect(unscoped.text, 'the foreign fixture was never indexed').toContain('foreign.ts')

      const r = captureErr(() => runAnswer({ question: 'where is zzAnswerScopedName' }))
      expect(r.code).toBe(0)
      const [viaLine, ...body] = r.out.split('\n')
      expect(r.out).not.toContain('foreign.ts')

      // Pinning the via: line's text is not the contract; the contract is that running what it names reproduces what it introduced. Drive the replay FROM the line, so a flag the router relies on but does not print fails here. `-p` was exactly that: the router always scopes to this project, `symbol` does not unless asked, and the pointer said `symbol <name>`.
      const flags = (viaLine ?? '').split(' ').slice(4)
      const replay = runSymbol({
        name: 'zzAnswerScopedName',
        limit: 20,
        ...(flags.includes('-p') ? { projectRoot: normalizePath(resolve('.')) } : {}),
        ...(flags.includes('--exclude-vendored') ? { excludeVendored: true } : {}),
      })
      expect(replay.text.trimEnd(), `re-running '${viaLine}' did not reproduce the answer it introduced`).toBe(body.join('\n').trimEnd())
      expect(viaLine).toBe('via: token-goat symbol zzAnswerScopedName -p --exclude-vendored')
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true })
      rmSync(realFile, { force: true })
    }
  })

  it('refuses an empty question', () => {
    const r = captureErr(() => runAnswer({ question: '   ' }))
    expect(r.code).toBe(1)
    expect(r.err).toContain('the question is empty')
  })
})
