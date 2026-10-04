/** `search`'s text channel previews the matching line, and the preview has to contain the match: it was the line's first 140 characters, then the terminal cut that to 120, so a match past that column (a long array literal, a markdown table row, a minified line) printed a preview without the query in it and the hit read as a false positive. A single-line hit that a semantic chunk also landed on printed the chunk instead, which never carries a match past its own 140 characters. Driven through the real path: indexFileSync writes the files rows the channel enumerates, executeParallelSearch runs the channel as the CLI does, and formatSearchText prints it. Provenance: HAND-DERIVED. The long line is built here with the match at a known column; the fused hit in the formatter case is FORMAT-DERIVED from `FusedSearchResult` in src/search/types.ts. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'
import { formatSearchText } from '../src/search/search_cli.js'
import type { FusedSearchResult } from '../src/search/types.js'

const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const PAD = Array.from({ length: 30 }, (_, i) => `alpha${i}`).join(', ')
const LONG_LINE = `export const table = [${PAD}, zebraQuokka, omega];`

function project(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-preview-')))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'long.ts'), `// fixture\n${LONG_LINE}\n    const short = 'zebraquokka here';\n`)
  indexFileSync(path.join(dir, 'long.ts'), globalDbPath())
  return dir
}

describe('search text preview', () => {
  it('shows the matched text when the match sits past the first 140 columns', async () => {
    // Control: the match really is past both cuts the old preview went through.
    expect(LONG_LINE.indexOf('zebraQuokka')).toBeGreaterThan(140)
    const dir = project()
    const summary = await executeParallelSearch({ query: 'ZEBRAQUOKKA', limit: 5, projectRoot: dir, channels: ['text'] })
    const long = summary.results.find((r) => r.lineStart === 2)
    expect(long?.preview).toBe('..., alpha26, alpha27, alpha28, alpha29, zebraQuokka, omega];')
    expect(formatSearchText(summary).split('\n')).toContain('   ..., alpha26, alpha27, alpha28, alpha29, zebraQuokka, omega];')
  })

  it('keeps a short matching line whole, without its indentation', async () => {
    const dir = project()
    const summary = await executeParallelSearch({ query: 'zebraquokka here', limit: 5, projectRoot: dir, channels: ['text'] })
    expect(summary.results.map((r) => [r.lineStart, r.preview])).toEqual([[3, "const short = 'zebraquokka here';"]])
  })

  it('prints the matched line of a one-line hit rather than a longer chunk preview that lacks it', () => {
    const hit: FusedSearchResult = {
      filePath: 'long.ts',
      name: 'table',
      kind: 'variable',
      lineStart: 2,
      lineEnd: 2,
      preview: '// fixture\nexport const table = [alpha0, alpha1, alpha2, alpha3, alpha4, alpha5, alpha6, alpha7, alpha8, alpha9, alpha10, alpha11, alpha12,',
      channels: ['symbol', 'semantic', 'text'],
      score: 0.05,
      channelHits: [],
      matchLine: 2,
      matchPreview: '..., alpha28, alpha29, zebraQuokka, omega];',
    }
    const text = formatSearchText({ query: 'zebraquokka', durationMs: 1, totalHits: 1, activeChannels: ['symbol', 'semantic', 'text'], channelCounts: { symbol: 1, heading: 0, text: 1, semantic: 1 }, results: [hit] })
    expect(text.split('\n').slice(1)).toEqual(['1. long.ts:2 (table · variable) symbol+semantic+text', '   ..., alpha28, alpha29, zebraQuokka, omega];'])
  })
})
