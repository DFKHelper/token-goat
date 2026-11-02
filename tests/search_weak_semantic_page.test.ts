/** `search`'s weak semantic-only page. The summaries and hit rows are HAND-DERIVED from `SearchExecutionSummary` and `FusedSearchResult` in src/search/types.ts; the note wording is CAPTURE from `token-goat search "quuxzzyNotAThing"` on the base build, 2026-10-31, in a scratch home. */
import { describe, expect, it } from 'vitest'

import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { formatSearchText } from '../src/search/search_cli.js'
import type { FusedSearchResult, SearchExecutionSummary } from '../src/search/types.js'

const QUERY = 'quuxzzyNotAThing'
const SEMANTIC_NOTE = 'found nothing close (closest was 0.974, weak above 0.85); its hits may be unrelated'
const COMMAND = '`token-goat search "quuxzzyNotAThing" -c semantic`'

const hit = (n: number, over: Partial<FusedSearchResult> = {}): FusedSearchResult => ({ filePath: `docs/note${n}.md`, lineStart: n, lineEnd: n, preview: `weak note ${n}`, channels: ['semantic'], score: 0.01, channelHits: [], ...over })

const weakSummary = (results: FusedSearchResult[], over: Partial<SearchExecutionSummary> = {}): SearchExecutionSummary => ({
  query: QUERY,
  durationMs: 233,
  totalHits: results.length,
  activeChannels: ['symbol', 'heading', 'text', 'semantic'],
  channelCounts: { symbol: 0, heading: 0, text: 0, semantic: results.length },
  notes: [{ channel: 'semantic', note: SEMANTIC_NOTE }],
  lowConfidence: { closestDistance: 0.974, threshold: 0.85 },
  results,
  ...over,
})

const sixteen = (): FusedSearchResult[] => Array.from({ length: 16 }, (_, i) => hit(i + 1))
const numbered = (text: string): string[] => text.split('\n').filter((line) => /^\d+\. /.test(line))

describe('formatSearchText weak semantic-only page', () => {
  it('R1 prints three hits of a weak semantic-only page and one command for the rest', () => {
    const text = formatSearchText(weakSummary(sixteen()), false)
    expect(numbered(text)).toHaveLength(3)
    expect(text).toContain(`(13 more weak semantic hits not shown -- ${COMMAND} lists them)`)
    expect(text).toContain(COMMAND)
  })

  it('R1 keeps the header and the relevance note unchanged above the capped hits', () => {
    const lines = formatSearchText(weakSummary(sixteen()), false).split('\n')
    expect(lines[0]).toBe('16 results for "quuxzzyNotAThing" in 233ms [symbol:0, heading:0, text:0, semantic:16]')
    expect(lines[1]).toBe(`(note: semantic channel ${SEMANTIC_NOTE})`)
  })

  it('R2 prints every hit once a non-semantic channel found something', () => {
    const results = [...sixteen(), hit(17, { filePath: 'src/worker.ts', channels: ['text'] })]
    const text = formatSearchText(weakSummary(results, { totalHits: 17, channelCounts: { symbol: 0, heading: 0, text: 1, semantic: 16 } }), false)
    expect(numbered(text)).toHaveLength(17)
    expect(text).not.toContain('not shown')
  })

  it('R3 prints every hit when the caller named channels', () => {
    const text = formatSearchText(weakSummary(sixteen()), true)
    expect(numbered(text)).toHaveLength(16)
    expect(text).not.toContain('not shown')
  })

  it('R4 drops the command and names the flag when the query cannot be quoted', () => {
    const text = formatSearchText(weakSummary(sixteen(), { query: "it's $5" }), false)
    expect(numbered(text)).toHaveLength(3)
    expect(text).toContain('(13 more weak semantic hits not shown; rerun with -c semantic to list them)')
    expect(text).not.toContain('token-goat search')
  })

  it('R5 drops the command when the query would print with a control character', () => {
    const text = formatSearchText(weakSummary(sixteen(), { query: 'quuxzzy\u001bNotAThing' }), false)
    expect(numbered(text)).toHaveLength(3)
    expect(text).toContain('(13 more weak semantic hits not shown; rerun with -c semantic to list them)')
    expect(text).not.toContain('token-goat search')
  })

  it('caps only above three hits: three hits print with no hidden line', () => {
    const text = formatSearchText(weakSummary([hit(1), hit(2), hit(3)]), false)
    expect(numbered(text)).toHaveLength(3)
    expect(text).not.toContain('not shown')
  })

  it('caps at three hits: four hits print three and name one more', () => {
    const text = formatSearchText(weakSummary([hit(1), hit(2), hit(3), hit(4)]), false)
    expect(numbered(text)).toHaveLength(3)
    expect(text).toContain('(1 more weak semantic hit not shown -- `token-goat search "quuxzzyNotAThing" -c semantic` lists them)')
  })

  // Provenance: HAND-DERIVED from src/cli.ts (search's --limit and --project flags; the rerun must carry the caller's values or it lists a different set than the page says).
  it('R6 carries a non-default --limit and the --project root into the printed command', () => {
    const text = formatSearchText(weakSummary(sixteen()), false, { limit: 40, projectRoot: '/work/app' })
    expect(text, 'the printed command keeps --limit 40').toContain('--limit 40')
    expect(text, 'the printed command keeps the --project root').toContain('--project "/work/app"')
    expect(text).toContain('`token-goat search "quuxzzyNotAThing" --limit 40 --project "/work/app" -c semantic` lists them)')
  })

  // Provenance: HAND-DERIVED from src/cli.ts (the default --limit is 20, so the default rerun prints the same command R1 pins).
  it('R6 prints no --limit flag at the default limit', () => {
    const text = formatSearchText(weakSummary(sixteen()), false, { limit: 20 })
    expect(text).toContain(COMMAND)
    expect(text).not.toContain('--limit')
  })

  // Provenance: HAND-DERIVED from src/hint_suggestion_guard.ts (stripUnsafeSuggestions removes a suggestion holding a command substitution, so a command the relay would strip is not printed).
  it('R7 prints no command for a query with a command substitution, and the relay passes the text unchanged', () => {
    const text = formatSearchText(weakSummary(sixteen(), { query: 'quuxzzy$(id)' }), false)
    expect(text, 'no command is printed for a query the relay would strip').not.toContain('command omitted')
    expect(stripUnsafeSuggestions(text), 'the relay passes the page unchanged').toBe(text)
    expect(text).toContain('(13 more weak semantic hits not shown; rerun with -c semantic to list them)')
  })

  // Provenance: HAND-DERIVED from src/cli.ts (--min-score drops hits below a fusion score, so the rerun must carry it or it lists a different set than the page says).
  it('R8 carries --min-score into the printed command only when the search was run with it', () => {
    const scored = formatSearchText(weakSummary(sixteen()), false, { minScore: 0.5 })
    expect(scored, 'the printed command keeps --min-score 0.5').toContain('`token-goat search "quuxzzyNotAThing" --min-score 0.5 -c semantic` lists them)')
    const plain = formatSearchText(weakSummary(sixteen()), false)
    expect(plain, 'the default command carries no --min-score').not.toContain('--min-score')
  })

  it('does not cap a semantic page with no low-confidence mark', () => {
    const text = formatSearchText(weakSummary(sixteen(), { lowConfidence: undefined }), false)
    expect(numbered(text)).toHaveLength(16)
    expect(text).not.toContain('not shown')
  })
})
