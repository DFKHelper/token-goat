/** The `search` command's text channel prints each matching line as its preview, so it has to read a file the way every command that prints file content does: through readFileText, which decodes a UTF-16 file and masks a dotenv file's values. A plain utf-8 read printed a tracked `.env` file's secrets in full where `read .env` masks them, and never matched a word in a UTF-16 file, whose NUL-interleaved bytes contain no query as typed. Driven through the real path: indexFileSync writes the files rows the channel enumerates, and executeParallelSearch runs the channel exactly as the CLI does. Provenance: HAND-DERIVED. The `.env` values are made-up secret-shaped strings; the UTF-16 file is the byte layout Windows PowerShell 5.1 writes by default (BOM FF FE, then UTF-16LE code units), built with Buffer.from(text, 'utf16le'). */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { readFileText } from '../src/read_commands.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'

const SECRET = 'hunter2-s3cret'
const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-text-')))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, '.env'), `DATABASE_URL=postgres://app:${SECRET}@db.internal/prod\nAPI_TOKEN=tok_live_9f8e7d6c5b4a\n`)
  fs.writeFileSync(path.join(dir, 'notes.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Notes\n\nThe zanzibar relay runs nightly.\n', 'utf16le')]))
  for (const f of ['.env', 'notes.md']) indexFileSync(path.join(dir, f), globalDbPath())
  return dir
}

describe('search text channel', () => {
  it('previews a dotenv line the way read shows it, with the value masked', async () => {
    const dir = project()
    const readLine = readFileText(path.join(dir, '.env'))?.split(/\r?\n/)[0]
    // Control: the reader seam masks the value, so a preview equal to its line cannot carry the secret.
    expect(readLine).toContain('DATABASE_URL')
    expect(readLine).not.toContain(SECRET)
    const summary = await executeParallelSearch({ query: 'DATABASE_URL', limit: 5, projectRoot: dir, channels: ['text'] })
    const hit = summary.results.find((r) => path.basename(r.filePath) === '.env')
    expect(hit?.lineStart).toBe(1)
    expect(hit?.preview).toBe(readLine)
    expect(JSON.stringify(summary)).not.toContain(SECRET)
  })

  it('finds a word in a UTF-16 file', async () => {
    const dir = project()
    const summary = await executeParallelSearch({ query: 'zanzibar', limit: 5, projectRoot: dir, channels: ['text'] })
    expect(summary.results.map((r) => [path.basename(r.filePath), r.lineStart, r.preview])).toEqual([['notes.md', 3, 'The zanzibar relay runs nightly.']])
  })
})
