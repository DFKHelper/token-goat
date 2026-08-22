/**
 * Array growth sized by file content must not go through spread-as-call-arguments.
 *
 * `target.push(...items)` is a call with one argument per item, so it throws
 * "Maximum call stack size exceeded" somewhere above ~125,000 items. That is a limit on the
 * argument count, not on memory, so it is reached by an ordinary generated file rather than by
 * anything adversarial. Wherever the item count comes from a file rather than from a fixed-size
 * slice, the append goes through `pushAll` instead.
 *
 * These three were missed when the same defect was fixed in `json_query`, `xml_query` (one of
 * two sites in that file) and `ooxml_extract`, and each one is in a command whose entire purpose
 * is to handle a file too big to read whole:
 *
 *  - `todo` crashed on a 200,000-marker file, exiting 1 with no indication of which file,
 *  - the `.vue`/`.svelte`/`.astro` extractor threw out of the indexer on a generated
 *    single-file component (an i18n table, an icon barrel, a generated constant module),
 *  - `xml-query FILE '/path/@*'` crashed on one machine-generated element with many attributes,
 *    and without even the `token-goat:` prefix, so it escaped the error funnel too.
 *
 * The counts below sit just past the threshold: 130,000 is over it and cheap, and the same test
 * at 100,000 passes on the buggy code.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { extractAstro, extractSvelte, extractVue } from '../src/languages/sfc_idx.js'
import { cmdTodo } from '../src/text_commands.js'
import { queryXml } from '../src/xml_query.js'

const OVER_SPREAD_LIMIT = 130_000

describe('a single-file component with more declarations than can be spread as call arguments', () => {
  const script = Array.from({ length: OVER_SPREAD_LIMIT }, (_, i) => `const v${i} = ${i}`).join('\n')

  it.each([
    ['vue', extractVue, `<script>\n${script}\n</script>\n<template><div/></template>`],
    ['svelte', extractSvelte, `<script>\n${script}\n</script>\n<div/>`],
    ['astro', extractAstro, `---\n${script}\n---\n<div/>`],
  ] as Array<[string, (c: string, f: string) => { symbols: unknown[] }, string]>)(
    'extracts every declaration instead of overflowing the call stack: %s',
    (ext, extract, content) => {
      const result = extract(content, `big.${ext}`)

      // MAX_SYMBOLS caps the returned list at 500, but it is applied at the END of extraction,
      // after the whole declaration list has already been appended -- so the append really does
      // see all 130,000 and the overflow really is reachable. Asserting the exact capped count
      // rather than "did not throw", so a fix that swallowed the error and returned a short or
      // empty list could not pass.
      expect(result.symbols).toHaveLength(500)
    },
  )
})

describe('an XML element with more attributes than can be spread as call arguments', () => {
  it('searches all of its attribute values instead of overflowing the call stack', () => {
    const attrs = Array.from({ length: OVER_SPREAD_LIMIT }, (_, i) => `a${i}="v"`).join(' ')
    const xml = `<root><row ${attrs} needle="found"/></root>`

    // The `@*` wildcard is what reaches the guarded append: it is the only branch that
    // collects EVERY attribute of an element at once, with `Object.values(cand.attributes)`.
    // A named-attribute predicate takes the single-value branch beside it and never gets near
    // the spread, so it cannot stand in for this.
    const result = queryXml(xml, '/root/row/@*')

    expect(result.attributeValues).toHaveLength(OVER_SPREAD_LIMIT + 1)
  })
})

describe('a file with more todo markers than can be spread as call arguments', () => {
  let tmpDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-todo-'))
    process.chdir(tmpDir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  it('reports every marker instead of exiting 1 with a raw RangeError', () => {
    // A generated file or a migration log with this many markers is ordinary; before the fix
    // `token-goat todo` over one exited 1 with "Maximum call stack size exceeded" and no
    // indication of which file was at fault.
    const file = path.join(tmpDir, 'big.js')
    fs.writeFileSync(file, Array.from({ length: OVER_SPREAD_LIMIT }, (_, i) => `// TODO: item ${i}`).join('\n'))

    let out = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk)
      return true
    })
    try {
      cmdTodo([file], { json: true })
    } finally {
      write.mockRestore()
    }

    // The count, not merely the absence of a throw: a fix that truncated the list would pass a
    // "did not throw" check.
    expect((JSON.parse(out) as { items: unknown[] }).items).toHaveLength(OVER_SPREAD_LIMIT)
  })
})
