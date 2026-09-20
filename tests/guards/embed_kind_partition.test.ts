/**
 * The per-kind embedding digests may only narrow sources whose reach really is one extraction kind wide.
 *
 * EMBED_FINGERPRINT was one digest over every embedding-decision source, so an edit to `pdf_extract.ts` -- which can only change how a PDF's bytes become chunk text -- re-embedded every TypeScript, Python and Markdown file on the machine. Splitting it per kind is only sound while one property holds: every source that can decide WHICH chunker a file goes through stays global. That is the whole safety argument for ever skipping a re-embed, since a file can only become a document extractor's business through a classification change, and a classification change has to move the digest of every kind at once. Narrowing one of those into a kind bucket would break the argument silently -- nothing fails, files just keep vectors built by code that no longer describes them.
 *
 * Provenance: HAND-DERIVED. The six sources pinned below are the intersection of `embedFingerprintSources()` and `sharedExtractionSources()`, computed here from those two functions rather than copied from either list, so the pin cannot drift into agreeing with a narrowing that moved one of them. `languages/ini_idx.ts` is in that set and reads like a kind-specific file; it is not, which is the specific mistake this guard exists to catch.
 */
import * as path from 'node:path'

import { describe, it, expect } from 'vitest'

import { embedFingerprintSources, embedGlobalSources, embedKindSources, sharedExtractionSources } from '../../scripts/parser-fingerprint.mjs'
import { EMBED_KIND_FINGERPRINTS } from '../../src/embed_fingerprint.js'
import { embedKindForPath } from '../../src/embed_stamp.js'

const rel = (f: string): string => path.relative(process.cwd(), f).split(path.sep).join('/')

const kindOwned = (): Map<string, string> => {
  const owned = new Map<string, string>()
  for (const [kind, files] of embedKindSources()) for (const file of files) owned.set(rel(file), kind)
  return owned
}

describe('the embed fingerprint partition', () => {
  it('splits a non-empty union, so nothing below can pass over an empty set', () => {
    expect(embedFingerprintSources().length, 'the embedding source list emptied or collapsed; every assertion below would pass vacuously').toBeGreaterThan(20)
    expect(embedKindSources().size, 'no extraction kind has sources of its own, so the split does nothing and no narrowing can be checked').toBeGreaterThan(3)
  })

  it('accounts for every embedding source exactly once, as global or as one kind\'s', () => {
    const union = new Set(embedFingerprintSources().map(rel))
    const global = new Set(embedGlobalSources().map(rel))
    const owned = kindOwned()
    const unaccounted = [...union].filter((f) => !global.has(f) && !owned.has(f))
    expect(unaccounted, `these embedding sources are in neither the global set nor any kind's, so a change to them would move no digest at all and their files would never be re-embedded: ${unaccounted.join(', ')}`).toEqual([])
    const both = [...global].filter((f) => owned.has(f))
    expect(both, `these sources are both global and kind-owned, which makes the kind digest's meaning undefined: ${both.join(', ')}`).toEqual([])
    const orphan = [...owned.keys()].filter((f) => !union.has(f))
    expect(orphan, `these kind sources are not in embedFingerprintSources(), so nothing hashes them and the coverage guard cannot see them: ${orphan.join(', ')}`).toEqual([])
  })

  it('leaves every source that can reclassify a file in the global set', () => {
    const shared = new Set(sharedExtractionSources().map(rel))
    const classifiers = embedFingerprintSources().map(rel).filter((f) => shared.has(f))
    // Calibration: the intersection is the real, computed one -- if it ever empties, the two source lists stopped overlapping and the assertion below would hold for the wrong reason.
    expect(classifiers.sort(), 'the sources shared with the parser fingerprint are not the ones this guard was written against; re-derive the list before trusting the assertion below').toEqual([
      'src/encoding.ts',
      'src/language_specs.ts',
      'src/languages/ini_idx.ts',
      'src/languages/sniff.ts',
      'src/markdown_lines.ts',
      'src/parser_types.ts',
    ])
    const owned = kindOwned()
    const narrowed = classifiers.filter((f) => owned.has(f)).map((f) => `${f} (narrowed to ${owned.get(f)})`)
    expect(narrowed, `these sources decide how a file is classified for extraction and were narrowed into one kind's digest, which breaks the only argument for skipping a re-embed -- a change that sends a file to a different chunker must move every kind's digest: ${narrowed.join(', ')}`).toEqual([])
  })

  it('gives every generated kind digest a path that actually resolves to it', () => {
    // A kind nothing resolves to is a digest that can never invalidate anything -- the stale-name-in-a-matcher-list shape, invisible because its siblings keep working.
    const unreachable = [...EMBED_KIND_FINGERPRINTS.keys()].filter((kind) => {
      const probe = kind === 'markdown' ? 'a/b/notes.md' : `a/b/file.${kind}`
      return embedKindForPath(probe) !== kind
    })
    expect(unreachable, `embedKindForPath resolves no path to these kinds, so their digests can move without re-embedding anything: ${unreachable.join(', ')}`).toEqual([])
  })

  it('resolves a file with no kind of its own to no kind, so the global digest is what gates it', () => {
    expect(embedKindForPath('src/parser.ts')).toBeNull()
    // A standalone .xml file is read as its own bytes by the global decoder, never through the OOXML zip reader the docx/pptx/xlsx kinds own.
    expect(embedKindForPath('a/b/pom.xml')).toBeNull()
  })
})
