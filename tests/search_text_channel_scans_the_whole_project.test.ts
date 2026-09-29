/** The `search` command's text channel stopped after the first 300 indexed files, and stopped again as soon as it had `limit` matching lines, so in a repo of 1,874 indexed files it never opened src/mcp_compress.ts (entry 493) and `search -c text compressMcpResult` returned one eval fixture and a "capped" note. It now scans every file inside a byte budget, then hands out one line per file per round, busiest file first. Driven through the real path: indexFileSync writes the files rows the channel enumerates, and executeParallelSearch runs the channel exactly as the CLI does. Provenance: HAND-DERIVED. The file counts, names and line layouts are made up; the expected hits follow from them by counting, not from running the channel. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { getOwnProjectFileEntries } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'

const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-scan-')))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text)
    indexFileSync(path.join(dir, name), globalDbPath())
  }
  return dir
}

describe('search text channel coverage', () => {
  it('finds a word in a file past the 300th indexed file, with no capped note', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 320; i++) files[`a${String(i).padStart(3, '0')}.md`] = `# Filler ${i}\n\nNothing to see.\n`
    files['zz-target.md'] = '# Target\n\nThe quetzalcoatl relay lives here.\n'
    const dir = project(files)
    // Control: the target really does sit past where the old 300-file count stopped.
    const order = [...getOwnProjectFileEntries(dir).values()].map((e) => path.basename(e.filePath))
    expect(order.indexOf('zz-target.md')).toBeGreaterThanOrEqual(300)

    const summary = await executeParallelSearch({ query: 'quetzalcoatl', limit: 5, projectRoot: dir, channels: ['text'] })
    expect(summary.results.map((r) => [path.basename(r.filePath), r.lineStart])).toEqual([['zz-target.md', 3]])
    expect(summary.degradedChannels).toBeUndefined()
  }, 60_000)

  it('does not let the first file to match take every slot', async () => {
    // a-busy.md sorts first and mentions the word on 20 lines; b-quiet.md mentions it once. The old loop kept a-busy.md's first five lines and never read b-quiet.md.
    const busy = ['# Busy', ''].concat(Array.from({ length: 20 }, (_, i) => `ocelot note ${i}`)).join('\n')
    const dir = project({ 'a-busy.md': busy, 'b-quiet.md': '# Quiet\n\nOne ocelot.\n' })
    const summary = await executeParallelSearch({ query: 'ocelot', limit: 5, projectRoot: dir, channels: ['text'] })
    // Round one gives each file its first line, busiest file first; later rounds give a-busy.md two more, and three lines is a file's share, so four hits come back for a limit of five.
    const hits = summary.results.flatMap((r) => r.channelHits.map((h) => [path.basename(h.filePath), h.lineStart, h.rank]))
    expect(hits.sort((x, y) => (x[2] as number) - (y[2] as number))).toEqual([
      ['a-busy.md', 3, 1],
      ['b-quiet.md', 3, 2],
      ['a-busy.md', 4, 3],
      ['a-busy.md', 5, 4],
    ])
  })

  it('puts the file that mentions the word most ahead of one that sorts first', async () => {
    const dir = project({ 'a-once.md': '# Once\n\nA lone pangolin.\n', 'b-often.md': '# Often\n\npangolin one\npangolin two\npangolin three\npangolin four\n' })
    const summary = await executeParallelSearch({ query: 'pangolin', limit: 2, projectRoot: dir, channels: ['text'] })
    const hits = summary.results.flatMap((r) => r.channelHits.map((h) => [path.basename(h.filePath), h.lineStart, h.rank]))
    expect(hits.sort((x, y) => (x[2] as number) - (y[2] as number))).toEqual([
      ['b-often.md', 3, 1],
      ['a-once.md', 3, 2],
    ])
  })
})
