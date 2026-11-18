/** Every reader that prints a line number or a line's text for a file must count a lone carriage return as a line break, the way the index does (src/source_text.ts), or a CR-only file (classic Mac OS line endings) is one giant line 1 to it: a match is reported on the wrong line with the whole file as its preview, a heading is never found, a conflict region is never seen. One row per reader, each driving the real command on a file whose lines end with a lone CR, with the same file ended by LF beside it as the control. Fixture provenance: HAND-DERIVED. Every file is a few lines written by hand, the line numbers in the assertions are counted by hand off those lines, and the numbering rule is the indexer's own (normalizeSourceText reads a lone CR as a line break). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { indexFileSync } from '../src/parser.js'
import { parseConflicts } from '../src/conflict_query.js'
import { runConflicts } from '../src/read_git.js'
import { collectFiles, formatPack, scanSecrets } from '../src/pack.js'
import { runGrep, runRead } from '../src/read_commands.js'
import { runSection } from '../src/read_section.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'
import { cmdTodo } from '../src/text_todo.js'

import { captureStdout } from './helpers/capture-stdout.js'

let dir: string

beforeEach(() => {
  dir = normalizePath(mkdtempSync(path.join(os.tmpdir(), 'tg-cr-readers-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** `lines` joined and ended by `nl`. A lone CR is how a classic Mac OS editor saved a file. */
function ended(lines: readonly string[], nl: string): string {
  return lines.join(nl) + nl
}

/** The line ending under test, with LF as the control: a row that fails on LF has an expectation the command never met, so a red CR row means the CR handling and nothing else. */
const ENDINGS = [
  ['LF', '\n'],
  ['lone CR', '\r'],
] as const

describe.each(ENDINGS)('grep on a file whose lines end with %s', (_name, nl) => {
  it('reports the match on its own line, with only that line as its text', () => {
    const file = path.join(dir, 'three.txt')
    writeFileSync(file, ended(['first line', 'second line', 'third NEEDLE line'], nl), 'utf-8')
    const out = captureStdout(() => {
      expect(runGrep({ pattern: 'NEEDLE', path: file })).toBe(0)
    })
    expect(out.trim().endsWith(':3: third NEEDLE line')).toBe(true)
    expect(out).not.toContain('first line')
    expect(out).not.toContain('second line')
  })

  it('numbers the context lines around the match as the index does', () => {
    const file = path.join(dir, 'ctx.txt')
    writeFileSync(file, ended(['one', 'two', 'three NEEDLE', 'four', 'five'], nl), 'utf-8')
    const out = captureStdout(() => {
      expect(runGrep({ pattern: 'NEEDLE', path: file, context: 1, json: true })).toBe(0)
    })
    const hits = (JSON.parse(out) as { items: Array<{ line: number; text: string; context?: Array<{ line: number; text: string }> }> }).items
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(3)
    expect(hits[0]!.text).toBe('three NEEDLE')
    expect(hits[0]!.context).toEqual([
      { line: 2, text: 'two' },
      { line: 3, text: 'three NEEDLE' },
      { line: 4, text: 'four' },
    ])
  })
})

describe.each(ENDINGS)('search --channel text on a file whose lines end with %s', (_name, nl) => {
  it('previews the matching line and no other, and names its line number', async () => {
    const file = normalizePath(path.join(dir, 'search.txt'))
    writeFileSync(file, ended(['first line', 'second line', 'third quillwortNeedle line'], nl), 'utf-8')
    getDb(globalDbPath()).prepare('INSERT INTO files (path, sha, mtime) VALUES (?,?,?)').run(file, 'x', 0)
    const summary = await executeParallelSearch({ query: 'quillwortNeedle', channels: ['text'], projectRoot: dir })
    expect(summary.results).toHaveLength(1)
    const hit = summary.results[0]!
    expect(hit.lineStart).toBe(3)
    expect(hit.preview).toContain('third quillwortNeedle line')
    expect(hit.preview).not.toContain('first line')
    expect(hit.preview).not.toContain('second line')
  })
})

describe.each(ENDINGS)('section on a file whose lines end with %s', (_name, nl) => {
  it('finds a heading in a markdown file and stops at the next one', () => {
    const file = path.join(dir, 'doc.md')
    writeFileSync(file, ended(['# Title', 'intro line', '## Target', 'target body', '## After', 'after body'], nl), 'utf-8')
    const { text, code } = runSection({ spec: `${file}::Target`, projectRoot: dir, json: true })
    expect(code).toBe(0)
    const section = JSON.parse(text) as { content: string; lineStart: number; lineEnd: number }
    expect(section.lineStart).toBe(3)
    expect(section.lineEnd).toBe(4)
    expect(section.content).toBe('## Target\ntarget body')
  })

  it('finds an html element by id and cuts it at the line the index recorded', () => {
    const file = path.join(dir, 'page.html')
    writeFileSync(file, ended(['<html>', '<body>', '<section id="chart-panel">', '<p>panel text</p>', '</section>', '</body>', '</html>'], nl), 'utf-8')
    indexFileSync(file)
    const { text, code } = runSection({ spec: `${file}::chart-panel`, projectRoot: dir, json: true })
    expect(code).toBe(0)
    const section = JSON.parse(text) as { content: string; lineStart: number; lineEnd: number }
    expect(section.lineStart).toBe(3)
    expect(section.content).toContain('<p>panel text</p>')
    expect(section.content).not.toContain('<body>')
    expect(section.content).not.toContain('</html>')
  })
})

describe.each(ENDINGS)('conflicts on a file whose lines end with %s', (_name, nl) => {
  const lines = ['before', '<<<<<<< ours', 'mine', '=======', 'theirs', '>>>>>>> branch', 'after']

  it('finds the region on the lines the index counts, with the lines around it as context', () => {
    const parsed = parseConflicts('f.txt', ended(lines, nl), 1)
    expect(parsed.warnings).toEqual([])
    expect(parsed.regions).toHaveLength(1)
    const region = parsed.regions[0]!
    expect(region.lineStart).toBe(2)
    expect(region.lineEnd).toBe(6)
    expect(region.ours.content).toBe('mine')
    expect(region.theirs.content).toBe('theirs')
    expect(region.beforeContext).toEqual([{ line: 1, text: 'before' }])
    expect(region.afterContext).toEqual([{ line: 7, text: 'after' }])
  })

  it('reports it through the command', () => {
    const file = path.join(dir, 'merge.txt')
    writeFileSync(file, ended(lines, nl), 'utf-8')
    const out = captureStdout(() => {
      expect(runConflicts({ path: file, json: true })).toBe(0)
    })
    const parsed = JSON.parse(out) as Array<{ regions: Array<{ lineStart: number; lineEnd: number }> }>
    expect(parsed, 'the command reported no conflicted file').toHaveLength(1)
    expect(parsed[0]!.regions.map((r) => [r.lineStart, r.lineEnd])).toEqual([[2, 6]])
  })
})

describe.each(ENDINGS)('todo on a file whose lines end with %s', (_name, nl) => {
  it('reports the marker on its own line', () => {
    const file = path.join(dir, 'notes.ts')
    writeFileSync(file, ended(['const a = 1', 'const b = 2', '// TODO: third thing'], nl), 'utf-8')
    const out = captureStdout(() => {
      cmdTodo([file], { json: true })
    })
    const items = (JSON.parse(out) as { items: Array<{ line: number; kind: string; text: string }> }).items
    expect(items.map((i) => [i.line, i.kind, i.text])).toEqual([[3, 'TODO', 'third thing']])
  })
})

describe.each(ENDINGS)('pack on a file whose lines end with %s', (_name, nl) => {
  // PROVENANCE: HAND-DERIVED. AKIAIOSFODNN7EXAMPLE is the example access key id in the AWS documentation, the shape of the 'AWS access key' pattern in src/pack.ts.
  const lines = ['first line', 'second line', 'key AKIAIOSFODNN7EXAMPLE here']

  function packed(): ReturnType<typeof collectFiles> {
    writeFileSync(path.join(dir, 'pack.txt'), ended(lines, nl), 'utf-8')
    const result = collectFiles(dir, ['pack.txt'], {})
    expect(result.files, 'pack collected no file, so the row measures nothing').toHaveLength(1)
    return result
  }

  it('counts the lines and numbers them as the index does', () => {
    const result = packed()
    expect(result.files[0]!.lines).toBe(3)
    const out = formatPack(result, 'plain', { line_numbers: true })
    expect(out).toContain('3  key AKIAIOSFODNN7EXAMPLE here')
    expect(out).toContain('2  second line')
  })

  it('names the line holding a secret and shows only that line', () => {
    const hits = scanSecrets(packed().files)
    expect(hits.map((h) => [h.line, h.kind, h.snippet])).toEqual([[3, 'AWS access key', 'key AKIAIOSFODNN7EXAMPLE here']])
  })
})

describe.each(ENDINGS)('read file:N on a file whose lines end with %s', (_name, nl) => {
  it('resolves the line to the symbol the index recorded around it', () => {
    const file = path.join(dir, 'inner.ts')
    writeFileSync(file, ended(['const a = 1', 'function inner() {', '  return 2', '}'], nl), 'utf-8')
    indexFileSync(file)
    const { text, code } = runRead({ spec: `${file}:3`, projectRoot: dir })
    expect(code, text).toBe(0)
    expect(text).toContain('function inner() {')
    expect(text).toContain('return 2')
    expect(text).not.toContain('const a = 1')
  })
})
