/**
 * End-to-end regression for the `refs.context` storage cap.
 *
 * A ref's context is the source line it sits on, and on a file a human wrote that is
 * short by construction. Generated metadata is not written that way: a FlexiPage, a
 * serialized Flow, a minified bundle and a one-line JSON document all put the entire
 * document on line 1, so every reference on that line stored the whole file as its
 * context and the bytes written grew with the square of the input. Measured before the
 * cap, on a 779 KB FlexiPage carrying 10,000 component references: 7,789,990,000
 * characters of context, and 58 seconds to index one file.
 *
 * Provenance: HAND-DERIVED. The fixture is a FlexiPage assembled here from the Salesforce
 * metadata element names the adapter already extracts, and the expectations are computed
 * from the input (one line, N references, each context bounded) independently of the code
 * under test. The 7.79e9 figure above is a CAPTURE from running the shipped extractor
 * against a generated 10,000-reference file.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync, MAX_REF_CONTEXT_CHARS, boundRefContext } from '../src/parser.js'
import { getDb, closeDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'

/** One FlexiPage holding `count` component references, serialized onto a single line the way the platform emits it. */
function makeSingleLineFlexiPage(count: number): string {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">']
  for (let i = 0; i < count; i++) parts.push(`<componentInstance><componentName>Comp${i}</componentName></componentInstance>`)
  parts.push('</FlexiPage>')
  return parts.join('')
}

describe('refs.context storage cap', () => {
  it('bounds every stored context on a document written as one long line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-refctx-'))
    const dbPath = join(dir, 'index.db')
    try {
      const file = join(dir, 'Big.flexipage-meta.xml')
      const source = makeSingleLineFlexiPage(400)
      writeFileSync(file, source, 'utf-8')
      expect(source.split('\n').length, 'the fixture must be one line, or it asserts nothing').toBe(1)
      expect(source.length, 'the fixture must exceed the cap, or the bound is never exercised').toBeGreaterThan(MAX_REF_CONTEXT_CHARS)

      indexFileSync(file, dbPath)

      const rows = getDb(dbPath)
        .prepare('SELECT name, context FROM refs WHERE file_path = ? ORDER BY col')
        .all(normalizePath(file)) as { name: string; context: string }[]
      expect(rows.length, 'the adapter must produce references, or this measures an empty set').toBeGreaterThan(300)
      for (const row of rows) {
        expect(row.context.length, `stored context for ${row.name} is ${row.context.length} chars`).toBeLessThanOrEqual(MAX_REF_CONTEXT_CHARS)
      }
      // The whole point of a window rather than a head slice: the reference must still be visible in its own context row.
      const late = rows[rows.length - 1]
      expect(late.context, `the last reference's own name must survive the window`).toContain(late.name)
    } finally {
      closeDb(dbPath)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a context that already fits exactly alone', () => {
    const line = 'x'.repeat(MAX_REF_CONTEXT_CHARS)
    expect(boundRefContext(line, 0)).toBe(line)
  })

  it('keeps the reference in view when it sits at the end of a very long line', () => {
    const needle = 'TheReferencedName'
    const line = 'x'.repeat(MAX_REF_CONTEXT_CHARS * 3) + needle
    const bounded = boundRefContext(line, line.length - needle.length)
    expect(bounded.length).toBeLessThanOrEqual(MAX_REF_CONTEXT_CHARS)
    expect(bounded).toContain(needle)
  })
})
