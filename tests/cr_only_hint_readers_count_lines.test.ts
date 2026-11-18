/** The hook hints and the extractors that read a file's own text must count a lone carriage return as a line break, the way the index does (src/source_lines.ts), or a CR-only file (classic Mac OS line endings) is one giant line to them: a heading is numbered 1, a large-file hint calls the file minified, a line the edit-failure advice names is the wrong one. One row per reader, each driving the real function on a file whose lines end with a lone CR, with the same file ended by LF beside it as the control. Fixture provenance: HAND-DERIVED. Every text is a few lines written by hand and the numbers in the assertions are counted by hand off those lines. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { extractChangelogVersionHint, extractMarkdownHeadings } from '../src/hints/markdown_hints.js'
import { handleCsv, handleHtml, handleJsonl, handleTxt } from '../src/hints/file_type_handler.js'
import { hintTarget } from '../src/hint_target.js'
import { diagnoseEditFailure } from '../src/hooks_tool_failure.js'
import { runConfigGet } from '../src/read_inspect.js'

import { captureStdout } from './helpers/capture-stdout.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cr-hints-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** `lines` joined and ended by `nl`. A lone CR is how a classic Mac OS editor saved a file. */
function ended(lines: readonly string[], nl: string): string {
  return lines.join(nl) + nl
}

const ENDINGS = [
  ['LF', '\n'],
  ['lone CR', '\r'],
] as const

describe.each(ENDINGS)('markdown hints on a file whose lines end with %s', (_name, nl) => {
  it('numbers each heading on the line the index counts', () => {
    const headings = extractMarkdownHeadings(ended(['# Title', 'intro', '## Target', 'body', '## After'], nl))
    expect(headings.map((h) => [h.lineNumber, h.text])).toEqual([[1, 'Title'], [3, 'Target'], [5, 'After']])
  })

  it('finds the newest version heading of a changelog', () => {
    const hint = extractChangelogVersionHint(ended(['# Changelog', '## [Unreleased]', 'nothing yet', '## [1.2.0]', 'a change'], nl), 'CHANGELOG.md')
    expect(hint).toContain('1.2.0')
  })
})

describe.each(ENDINGS)('large-file hints on a file whose lines end with %s', (_name, nl) => {
  const rows = Array.from({ length: 1200 }, (_, i) => `row ${i + 1} of the sample file`)

  it('previews the first and last lines of a large text file and counts them', () => {
    const result = handleTxt('sample.txt', ended(rows, nl))
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('1,200 lines total')
    expect(result.message).toContain('row 1 of the sample file')
    expect(result.message).toContain('row 1200 of the sample file')
    expect(result.message).not.toContain('mostly one long line')
  })

  it('reads the header and the sample rows of a large csv', () => {
    const csv = ['id,name,city', ...Array.from({ length: 900 }, (_, i) => `${i},person${i},town${i}`)]
    const result = handleCsv('people.csv', ended(csv, nl))
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('901 rows, 3 columns')
    expect(result.message).toContain('Columns: id,name,city')
    expect(result.message).toContain('0,person0,town0')
  })

  it('does not take a large html page for a minified one', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `<p>paragraph number ${i} of the page body text</p>`)
    const html = ended(['<html>', '<head><title>Sample page</title></head>', '<body>', ...body, '</body>', '</html>'], nl)
    expect(html.length, 'the page must pass the 50,000 character mark the minified check has').toBeGreaterThan(50_000)
    const result = handleHtml('page.html', html)
    expect(result.shouldBlock).toBe(true)
    expect(result.message).not.toContain('appears minified')
    expect(result.message).toContain('Title: Sample page')
  })

  it('counts the records of a large jsonl file and reads the keys of the first', () => {
    const records = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ id: i, kind: 'event', note: 'sample record' }))
    const result = handleJsonl('events.jsonl', ended(records, nl))
    expect(result.shouldBlock).toBe(true)
    expect(result.message).toContain('~1000 records')
    expect(result.message).toContain('Record keys: id, kind, note')
  })
})

describe.each(ENDINGS)('section hint on a file whose lines end with %s', (_name, nl) => {
  it('skips the heading that is really a front matter line, by the line the front matter ends on', () => {
    const content = ended(['---', 'title: Front', '---', '# Real heading', 'body'], nl)
    const headings = [
      { level: 1, text: 'title: Front', lineNumber: 2 },
      { level: 1, text: 'Real heading', lineNumber: 4 },
    ]
    expect(hintTarget('doc.md', 'section', { headings, content })).toEqual({ name: 'Real heading', real: true, slice: 'section' })
  })
})

describe.each(ENDINGS)('config-get on a properties file whose lines end with %s', (_name, nl) => {
  it('reads a key out of the front matter of a markdown file', () => {
    const file = path.join(dir, 'page.md')
    writeFileSync(file, ended(['---', 'title: Hello', '---', 'body text'], nl), 'utf-8')
    const out = captureStdout(() => {
      expect(runConfigGet({ file, key: 'title' })).toBe(0)
    })
    expect(out.trim()).toBe('Hello')
  })

  it('finds a flat key on its own line', () => {
    const file = path.join(dir, 'app.properties')
    writeFileSync(file, ended(['first.key=one', 'spring.datasource.name=main', 'last.key=three'], nl), 'utf-8')
    const out = captureStdout(() => {
      expect(runConfigGet({ file, key: 'spring.datasource.name' })).toBe(0)
    })
    expect(out.trim()).toBe('main')
  })
})

describe.each(ENDINGS)('edit-failure advice on a file whose lines end with %s', (_name, nl) => {
  it('names the line holding the first line of the text that was not found', () => {
    const file = path.join(dir, 'edited.txt')
    writeFileSync(file, ended(['alpha line one here', 'beta line two here', 'gamma line three here'], nl), 'utf-8')
    const input = { file_path: file, old_string: 'beta line two here\nand a line that is gone', new_string: 'x' }
    const event: HookEvent = { eventName: 'post_tool_use_failure', toolName: 'Edit', toolInput: input, sessionId: 'cr-hints', agentId: undefined, raw: { session_id: 'cr-hints', tool_name: 'Edit', tool_input: input } }
    const advice = diagnoseEditFailure(event, 'String to replace not found in file.')
    expect(advice, 'no advice was produced for a failed edit').not.toBeNull()
    expect(advice).toContain('line 2')
    expect(advice).not.toContain('line 1')
  })
})
