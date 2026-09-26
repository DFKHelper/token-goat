/** The `search` command's symbol and heading channels share one `symbols_fts` table, so each has to filter on `kind` before its LIMIT or the other kind's better-ranked rows fill it. Driven through the real path: indexFileSync writes the rows into the isolated global index and executeParallelSearch runs the channel exactly as the CLI does. Provenance: HAND-DERIVED. The fixture is written so the premise holds by construction, which the control asserts rather than assumes: eight markdown headings repeat the query term where the one code symbol names it once, so an unfiltered FTS query capped at 3 returns only headings. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { searchSymbolsFts } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'

const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-kind-')))
  dirs.push(dir)
  const headings = Array.from({ length: 8 }, (_, i) => `## Gizmo gizmo gizmo ${i}\n\nThe gizmo gizmo section ${i}.\n`).join('\n')
  fs.writeFileSync(path.join(dir, 'guide.md'), `# Guide\n\n${headings}`)
  fs.writeFileSync(path.join(dir, 'tool.ts'), 'export function gizmo(): number {\n  return 1\n}\n')
  for (const f of ['guide.md', 'tool.ts']) indexFileSync(path.join(dir, f), globalDbPath())
  return dir
}

describe('search symbol and heading channels', () => {
  it('fill with headings when the query is not split by kind (control)', () => {
    const dir = project()
    const hits = searchSymbolsFts('gizmo', 3, globalDbPath(), dir)
    expect(hits).toHaveLength(3)
    expect(hits.every((h) => h.kind === 'heading')).toBe(true)
  })

  it('still find the code symbol when headings outrank it', async () => {
    const dir = project()
    const summary = await executeParallelSearch({ query: 'gizmo', limit: 3, projectRoot: dir, channels: ['symbol'] })
    expect(summary.channelCounts.symbol).toBe(1)
    expect(summary.results.map((r) => r.name)).toEqual(['gizmo'])
  })

  it('return only headings on the heading channel', async () => {
    const dir = project()
    const summary = await executeParallelSearch({ query: 'gizmo', limit: 3, projectRoot: dir, channels: ['heading'] })
    expect(summary.channelCounts.heading).toBe(3)
    expect(summary.results.every((r) => r.kind === 'heading')).toBe(true)
  })
})
