/** Every file under tests/fixtures declares where it came from in PROVENANCE.tsv, with a tag and a sha256 of its bytes. CLAUDE.md requires a provenance line on every fixture, but a binary GIF or a captured-output file has nowhere to carry one, so the rule was enforced by reviewers alone and a fixture regenerated from the implementation's own output went unnoticed. The hash is what makes a silent regeneration visible: changing a fixture's bytes fails here until a person re-reads the row. */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const TABLE = 'PROVENANCE.tsv'
const TAGS = new Set(['CAPTURE', 'FORMAT-DERIVED', 'HAND-DERIVED', 'HARNESS'])

const walk = (dir: string, rel = ''): string[] =>
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]))

/** The sha256 git would see for these bytes: a file with no NUL byte is text under `* text=auto eol=lf`, so its CRLF endings are folded to LF first. A fresh checkout is already LF, but an editor that rewrites a fixture with CRLF leaves `git status` clean while the raw bytes differ, so hashing them raw failed on a working tree git called unchanged. */
export function fixtureSha(bytes: Buffer): string {
  const canonical = bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/** Problems found in `root`'s fixture tree against its PROVENANCE.tsv; empty when every file is declared. */
export function checkFixtureProvenance(root: string): string[] {
  const problems: string[] = []
  const lines = fs.readFileSync(path.join(root, TABLE), 'utf8').split('\n').filter((l) => l !== '')
  const rows = new Map<string, { tag: string; source: string; sha: string }>()
  for (const line of lines.slice(1)) {
    const [file = '', tag = '', source = '', sha = ''] = line.split('\t')
    rows.set(file, { tag, source, sha })
  }
  const onDisk = new Set(walk(root).filter((f) => f !== TABLE && !/(^|\/)README(\.md)?$/i.test(f)))
  for (const f of onDisk) if (!rows.has(f)) problems.push(`${f} has no row in tests/fixtures/${TABLE}; declare its tag (CAPTURE, FORMAT-DERIVED, HAND-DERIVED or HARNESS), its source and its sha256`)
  for (const [f, row] of rows) {
    if (!onDisk.has(f)) { problems.push(`row "${f}" in tests/fixtures/${TABLE} names a file that does not exist`); continue }
    if (!TAGS.has(row.tag)) problems.push(`row "${f}" has tag "${row.tag}"; it must be one of ${[...TAGS].join(', ')}`)
    if (row.source.trim() === '') problems.push(`row "${f}" has an empty source column; say where the bytes came from`)
    const actual = fixtureSha(fs.readFileSync(path.join(root, f)))
    if (actual !== row.sha) problems.push(`${f} has sha256 ${actual} but its row says ${row.sha}; update the row only if the new content has the same provenance (re-captured from the real producer), never if it was regenerated from this repository's own code`)
  }
  return problems
}

const temps: string[] = []
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A throwaway fixture tree holding one file `a/x.txt` and a table, optionally with a custom row. */
function tree(row?: (sha: string) => string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prov-'))
  temps.push(root)
  fs.mkdirSync(path.join(root, 'a'))
  fs.writeFileSync(path.join(root, 'a', 'x.txt'), 'hello\n')
  const sha = crypto.createHash('sha256').update('hello\n').digest('hex')
  fs.writeFileSync(path.join(root, TABLE), `path\ttag\tsource\tsha256\n${row ? row(sha) : `a/x.txt\tHAND-DERIVED\twritten by hand\t${sha}`}\n`)
  return root
}

describe('fixture provenance table', () => {
  it('accepts a declared file', () => {
    expect(checkFixtureProvenance(tree())).toEqual([])
  })

  it('names a file that has no row', () => {
    const root = tree()
    fs.writeFileSync(path.join(root, 'a', 'orphan.bin'), 'x')
    expect(checkFixtureProvenance(root).join('\n')).toContain('a/orphan.bin has no row')
  })

  it('names a row whose file does not exist', () => {
    const root = tree((sha) => `gone/y.txt\tCAPTURE\tsomewhere\t${sha}`)
    const out = checkFixtureProvenance(root).join('\n')
    expect(out).toContain('row "gone/y.txt"')
    expect(out).toContain('does not exist')
  })

  it('rejects an unknown tag', () => {
    expect(checkFixtureProvenance(tree((sha) => `a/x.txt\tGUESSED\tsomewhere\t${sha}`)).join('\n')).toContain('tag "GUESSED"')
  })

  it('rejects an empty source', () => {
    expect(checkFixtureProvenance(tree((sha) => `a/x.txt\tCAPTURE\t\t${sha}`)).join('\n')).toContain('empty source')
  })

  it('names the file and both hashes when the bytes changed, and says when updating the row is legitimate', () => {
    const stale = 'f'.repeat(64)
    const actual = crypto.createHash('sha256').update('hello\n').digest('hex')
    const out = checkFixtureProvenance(tree(() => `a/x.txt\tCAPTURE\tsomewhere\t${stale}`)).join('\n')
    expect(out).toContain('a/x.txt')
    expect(out).toContain(stale)
    expect(out).toContain(actual)
    expect(out).toContain('same provenance')
  })

  // Provenance: HAND-DERIVED. The CRLF copy is the LF text with each newline doubled by hand; the binary carries a NUL, so git's text=auto leaves it alone.
  it('hashes a CRLF working copy as git stores it, and leaves a binary untouched', () => {
    expect(fixtureSha(Buffer.from('a\r\nb\r\n'))).toBe(fixtureSha(Buffer.from('a\nb\n')))
    expect(fixtureSha(Buffer.from('a\r\n\0'))).not.toBe(fixtureSha(Buffer.from('a\n\0')))
  })

  it('holds for the real tests/fixtures tree', () => {
    pinnedPopulation({ what: 'files under tests/fixtures', items: walk(FIXTURES), floor: 150, mustIncludeExact: ['animated.gif', 'adoption/forks.json', 'wordpiece/oracle.json.gz'] })
    expect(checkFixtureProvenance(FIXTURES)).toEqual([])
  })
})
