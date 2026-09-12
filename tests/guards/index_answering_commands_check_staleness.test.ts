/**
 * Structural guard for the "answers from a stale row with no warning" defect class (C5).
 *
 * `symbol`/`read`/`skeleton`/`outline` always ran `staleWarning`/`healStaleIndex` before answering,
 * so an on-disk edit that bypassed the dirty queue self-corrected before the answer went out. Four
 * other commands that also answer straight from indexed rows -- `refs`, `ask`, `semantic`, and
 * `trace --bodies` -- had no staleness check of their own at all, and silently served pre-edit rows
 * with no warning and no self-heal until that was fixed by adding `warnIfFilesStale` and wiring it
 * into `runRefsSingle`, `runAsk`, `runSemantic`, and `cmdTrace`.
 *
 * A per-path regression test (tests/stale_index_warns_on_multi_file_answers.test.ts) pins those four
 * fixed sites against a real, unmocked index. It says nothing about the next command someone adds
 * that queries the index (`queryRefs`/`searchSymbolsFts`) and renders matched-file body content
 * without going through the same staleness check -- so this guard enumerates every exported command
 * function in `src/graph_commands.ts` and `src/read_commands.ts` whose body calls `queryRefs(` or
 * `searchSymbolsFts(` and classifies each one as COVERED (calls `warnIfFilesStale`/`staleWarning`
 * itself) or EXEMPT (its output never carries verbatim/synthesized body content from the matched
 * files -- only file/symbol/line metadata -- so a stale row cannot leak stale *content*, only a
 * stale line number a fresh reindex will correct on the next drain).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { parseTopLevelFunctions, stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')
const SCAN_FILES = ['graph_commands.ts', 'read_commands.ts', 'text_commands.ts']

interface CommandSite {
  readonly file: string
  readonly name: string
  readonly body: string
}

/** Every top-level function in the scanned files whose body queries the index directly via
 * queryRefs( or searchSymbolsFts(. Nested helpers that only forward to one of these (rather than
 * calling it themselves) are not picked up -- this guard targets the command entry points that
 * decide what to render, not every intermediate query wrapper. */
function commandSites(): readonly CommandSite[] {
  const out: CommandSite[] = []
  for (const name of SCAN_FILES) {
    const file = path.join(SRC_DIR, name)
    const src = fs.readFileSync(file, 'utf8')
    for (const fn of parseTopLevelFunctions(src)) {
      const body = stripComments(fn.body)
      if (/\bqueryRefs\s*\(|\bsearchSymbolsFts\s*\(/.test(body)) {
        out.push({ file: name, name: fn.name, body })
      }
    }
  }
  return out
}

function key(site: CommandSite): string {
  return `${site.file}::${site.name}`
}

type Bucket = 'checks-staleness-itself' | 'metadata-only-output-no-body-content-rendered'

/**
 * Classification for every command site this guard has found. A site missing here, or whose
 * bucket no longer matches its real behavior, fails one of the tests below.
 */
const CLASSIFICATION: ReadonlyMap<string, { bucket: Bucket; reason: string }> = new Map([
  [
    'read_commands.ts::runRefsSingle',
    {
      bucket: 'checks-staleness-itself',
      reason: 'calls warnIfFilesStale(results.map(r => r.filePath)) before rendering (C5 fix).',
    },
  ],
  [
    'read_commands.ts::runSemantic',
    {
      bucket: 'checks-staleness-itself',
      reason: 'calls warnIfFilesStale(hits.map(h => h.filePath)) before rendering hit bodies (C5 fix).',
    },
  ],
  [
    'graph_commands.ts::runAsk',
    {
      bucket: 'checks-staleness-itself',
      reason: 'calls warnIfFilesStale(hits.map(h => h.filePath)) before backend dispatch (C5 fix).',
    },
  ],
  [
    'graph_commands.ts::runCallChain',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'emits a caller/callee chain of file:line/symbol-name entries only; never reads or renders a matched file\'s body text.',
    },
  ],
  [
    'graph_commands.ts::runImpact',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'emits the set of symbols/files impacted by a change as file:line/symbol-name entries only, no body content.',
    },
  ],
  [
    'graph_commands.ts::runDead',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'reports symbols with zero live references as file:line/symbol-name entries only, no body content.',
    },
  ],
  [
    'graph_commands.ts::runSimilar',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'emits name/kind/file/line for FTS-matched symbols only; never reads or renders body text.',
    },
  ],
  [
    'graph_commands.ts::runContextFor',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'uses hit.body only internally, to estimate a token budget (estimateTokens(h.body ?? \'\')) -- the emitted entries carry only file/symbol/kind/line/readCmd, never the body text itself.',
    },
  ],
  [
    'graph_commands.ts::runTestFor',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'emits candidate test file paths/symbol names only, no body content.',
    },
  ],
  [
    'graph_commands.ts::runCoverageGaps',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'reports symbols with no covering test as file:line/symbol-name entries only, no body content.',
    },
  ],
  [
    'graph_commands.ts::resolveCallers',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'internal helper used to resolve a symbol\'s callers by name/file; queries refs for name resolution only, never reads or renders body text.',
    },
  ],
  [
    'graph_commands.ts::hasAncestorDispatchRef',
    {
      bucket: 'metadata-only-output-no-body-content-rendered',
      reason: 'internal boolean predicate over queryRefs results (does an ancestor method have a dispatch ref); never reads or renders body text.',
    },
  ],
  [
    'read_commands.ts::renderRefsTargets',
    {
      bucket: 'checks-staleness-itself',
      reason: 'calls warnIfFilesStale(refRows.map(r => r.filePath)) after the per-target loop, before rendering -- covers the multi-symbol and cross-file refs spec forms the same way runRefsSingle covers the single-symbol form.',
    },
  ],
])

describe('every index-answering command checks staleness or is proven metadata-only (stale-content defect class)', () => {
  it('finds a real, non-empty population of index-querying command functions', () => {
    const sites = commandSites()
    pinnedPopulation({
      what: 'exported command functions in graph_commands.ts/read_commands.ts that call queryRefs( or searchSymbolsFts( directly',
      items: sites.map(key),
      floor: 8,
      mustInclude: ['runRefsSingle', 'runSemantic', 'runAsk', 'runCallChain'],
    })
  })

  it('every discovered site is classified', () => {
    const sites = commandSites()
    const unclassified = sites.filter((s) => !CLASSIFICATION.has(key(s)))
    expect(
      unclassified.map(key),
      'These command functions query the index (queryRefs/searchSymbolsFts) but have no CLASSIFICATION ' +
        'entry -- add one deciding whether they need warnIfFilesStale/staleWarning (if they render body ' +
        'content from the matched files) or are metadata-only (file/symbol/line only, no body text).',
    ).toEqual([])
  })

  it('every classification is still real (site exists, bucket still matches reality)', () => {
    const sites = new Map(commandSites().map((s) => [key(s), s]))
    const stale = [...CLASSIFICATION.keys()].filter((k) => !sites.has(k))
    expect(stale, 'these keys are classified but the scan no longer finds a matching command function').toEqual([])

    for (const [k, { bucket }] of CLASSIFICATION) {
      const site = sites.get(k)
      if (!site) continue
      if (bucket === 'checks-staleness-itself') {
        expect(
          /\bwarnIfFilesStale\s*\(|\bstaleWarning\s*\(/.test(site.body),
          `${k} is classified as checking staleness itself but its body no longer calls ` +
            'warnIfFilesStale(...) or staleWarning(...) -- the exact regression C5 fixed.',
        ).toBe(true)
      } else {
        expect(
          !/\bwarnIfFilesStale\s*\(|\bstaleWarning\s*\(/.test(site.body),
          `${k} is classified as metadata-only (not needing its own staleness check) but its body now ` +
            'calls warnIfFilesStale/staleWarning anyway -- reclassify it as checks-staleness-itself so ' +
            'this guard actually verifies the call stays there on a future refactor.',
        ).toBe(true)
      }
    }
  })

  it('a metadata-only site that starts rendering .body/resolveBody output without also gaining a staleness check is caught', () => {
    // Belt-and-braces: for every metadata-only site, if its body text renders a `.body`/`resolveBody(`
    // value into anything that looks like emitted output (a template literal, a pushed object field,
    // a console.log/JSON.stringify argument) rather than only using it for a numeric/boolean decision
    // (token counting, truthiness), it must also call warnIfFilesStale/staleWarning.
    const sites = new Map(commandSites().map((s) => [key(s), s]))
    const offenders: string[] = []
    for (const [k, { bucket }] of CLASSIFICATION) {
      if (bucket !== 'metadata-only-output-no-body-content-rendered') continue
      const site = sites.get(k)
      if (!site) continue
      const rendersBodyText =
        /(?:entries\.push|results\.push|out\.push|\.push)\([^)]*\bbody\b/.test(site.body) ||
        /`[^`]*\$\{[^}]*\bbody\b[^}]*\}[^`]*`/.test(site.body)
      const checksStaleness = /\bwarnIfFilesStale\s*\(|\bstaleWarning\s*\(/.test(site.body)
      if (rendersBodyText && !checksStaleness) offenders.push(k)
    }
    expect(
      offenders,
      'These sites are classified metadata-only but their body appears to push/interpolate a `.body` ' +
        'field into emitted output without any staleness check -- reclassify as checks-staleness-itself ' +
        'and add warnIfFilesStale/staleWarning, or fix the emission to stop carrying body content.',
    ).toEqual([])
  })
})
