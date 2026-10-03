// `gh api` prints compact single-line JSON when stdout is not a TTY. The generic wide-line clip (base.ts step 2b) cut any such line over 4000 chars before GhFilter ran, so JSON.parse failed and neither the *_url stripping nor the base64 `content` redaction happened. A filter that parses the whole document now declares it and skips the clip when the stream is one JSON value.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { compressOutput, selectFilter } from '../src/tool_filters/dispatch.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gh_api')
// CAPTURE: `gh api 'repos/DFKHelper/token-goat/pulls?state=closed&per_page=2'` redirected to a file (not a TTY), 61,658 bytes on one line. Row in tests/fixtures/PROVENANCE.tsv.
const PULLS = fs.readFileSync(path.join(FIXTURES, 'pulls_closed.json'), 'utf8')
// CAPTURE: `gh api repos/DFKHelper/token-goat/contents/README.md` redirected to a file, 119,943 bytes on one line with a base64 `content`. Row in tests/fixtures/PROVENANCE.tsv.
const CONTENTS = fs.readFileSync(path.join(FIXTURES, 'contents_readme.json'), 'utf8')

function run(argv: string[], stdout: string): string {
  const filter = selectFilter(argv)
  if (filter === null) throw new Error(`no filter for ${argv.join(' ')}`)
  return compressOutput(filter, stdout, '', 0, argv).text
}

describe('whole-document JSON filters see an unclipped single-line document', () => {
  it('captures really are one line over the clip width', () => {
    for (const text of [PULLS, CONTENTS]) {
      expect(text.trim().includes('\n')).toBe(false)
      expect(text.length).toBeGreaterThan(4000)
    }
  })

  it('gh api strips *_url boilerplate from a captured response over 4000 chars', () => {
    const text = run(['gh', 'api', 'repos/DFKHelper/token-goat/pulls?state=closed&per_page=2'], PULLS)
    expect(text).toMatch(/stripped \d+ \*_url boilerplate fields from gh api response/)
    expect(text).not.toContain('"commits_url"')
    expect(text).not.toContain('clipped line(s) wider')
  })

  it('gh api redacts a captured base64 content field over 4000 chars', () => {
    const text = run(['gh', 'api', 'repos/DFKHelper/token-goat/contents/README.md'], CONTENTS)
    const bytes = Buffer.from((JSON.parse(CONTENTS) as { content: string }).content, 'base64').length
    expect(text).toContain(`<base64 content: ${bytes} bytes decoded>`)
    expect(text).not.toContain(JSON.stringify((JSON.parse(CONTENTS) as { content: string }).content).slice(1, 200))
  })

  it('the json CLI array dedup sees a compact array over 4000 chars', () => {
    // CAPTURE of the shape: `json -o json-0` (trentm/json 11.0.0) printed `[{"a":1},{"a":2}]` on one line; the 300 identical records here are generated from that shape.
    const compact = JSON.stringify(Array.from({ length: 300 }, () => ({ level: 'info', message: 'duplicate record body' })))
    expect(compact.length).toBeGreaterThan(4000)
    const text = run(['json', '-o', 'json-0'], compact)
    expect(text).not.toContain('clipped line(s) wider')
    expect(text.length).toBeLessThan(compact.length / 4)
  })

  it('a 200 KB single-line JSON document the filter does not rewrite stays capped', () => {
    // HAND-DERIVED: one object whose only value is a 200,000-char string, so gh api has no *_url or content field to rewrite and returns the text unchanged.
    const doc = JSON.stringify({ note: 'x'.repeat(200_000) })
    const text = run(['gh', 'api', 'repos/o/r/anything'], doc)
    expect(text.length).toBeLessThan(doc.length / 10)
    expect(text).toContain('{"note":"xxxx')
  })

  it('a filter that did not opt in still has wide lines clipped', () => {
    const wide = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => `item-${i}`) })
    const text = run(['gh', 'pr', 'list', '--json', 'number'], wide)
    expect(text).toContain('clipped line(s) wider')
  })
})
