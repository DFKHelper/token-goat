/** Label resolution and answer grading for the golden retrieval eval (evals/retrieval, scripts/eval-retrieval.ts). The unit fixtures are HAND-DERIVED: each source snippet is written here and its expected line span counted by hand from the snippet, never read back from token-goat's parser. The staleness checks run against this repository's real files, so a rename that orphans a golden label fails here rather than showing up in an eval report as a retrieval regression. The `answer` output samples are FORMAT-DERIVED from the delegate output tests/answer_router.test.ts pins (`via: token-goat deps src/delivery_cap.ts --importers`, an indented `  src/hooks_bash_post.ts`, `./index_reader.js`) and from `refusal()` in src/answer_router.ts. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { headingSpans, resolveLabel, symbolSpans, type GoldenLabel } from '../evals/retrieval/labels.js'
import { answerFileMatches, parseAnswer } from '../scripts/eval-retrieval.js'

const ROOT = path.resolve(import.meta.dirname, '..')

function jsonl<T>(rel: string): T[] {
  return readFileSync(path.join(ROOT, rel), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T)
}

describe('symbolSpans', () => {
  const src = ['/** doc */', 'export function alpha(): number {', '  return 1', '}', '', 'export const BETA = {', '  a: 1,', '}', 'class Gamma {', '  delta(): void {}', '}'].join('\n')

  it('spans a function from its keyword line to its closing brace, leaving the JSDoc out', () => {
    expect(symbolSpans(src, 'x.ts', 'alpha')).toEqual([{ lineStart: 2, lineEnd: 4 }])
  })

  it('spans a const through its whole statement, export keyword included', () => {
    expect(symbolSpans(src, 'x.ts', 'BETA')).toEqual([{ lineStart: 6, lineEnd: 8 }])
  })

  it('starts a later declarator of a multi-name const on the statement line, not its own', () => {
    const multi = ['export const A = 1,', '  B = {', '    x: 1,', '  }'].join('\n')
    expect(symbolSpans(multi, 'x.ts', 'B')).toEqual([{ lineStart: 1, lineEnd: 4 }])
  })

  it('finds a method nested in a class', () => {
    expect(symbolSpans(src, 'x.ts', 'delta')).toEqual([{ lineStart: 10, lineEnd: 10 }])
  })

  it('returns nothing for a name that is only mentioned, never declared', () => {
    expect(symbolSpans('const a = alpha()\n', 'x.ts', 'alpha')).toEqual([])
  })
})

describe('headingSpans', () => {
  const md = ['# Top', 'intro', '## A', 'a text', '```sh', '# not a heading', '## also not', '```', 'more a', '### A.1', 'deep', '## B', 'b text', '', ''].join('\n')

  it('ends a section at the next heading of the same level, keeping deeper ones inside', () => {
    expect(headingSpans(md, 'A')).toEqual([{ lineStart: 3, lineEnd: 11 }])
  })

  it('skips lines inside a fenced block, so a shell comment neither matches nor ends a section', () => {
    expect(headingSpans(md, 'not a heading')).toEqual([])
    expect(headingSpans(md, 'also not')).toEqual([])
  })

  it('runs the last section to the last non-blank line', () => {
    expect(headingSpans(md, 'B')).toEqual([{ lineStart: 12, lineEnd: 13 }])
  })

  it('runs a top-level heading to the end of the file', () => {
    expect(headingSpans(md, 'Top')).toEqual([{ lineStart: 1, lineEnd: 13 }])
  })

  it('only closes a fence on the same marker at least as long as the opener', () => {
    const t = ['## S', '````', '```', '## inside', '````', '## T'].join('\n')
    expect(headingSpans(t, 'inside')).toEqual([])
    expect(headingSpans(t, 'S')).toEqual([{ lineStart: 1, lineEnd: 5 }])
  })

  it('strips a closing hash sequence from the heading text', () => {
    expect(headingSpans('## Closed ##\nbody\n', 'Closed')).toEqual([{ lineStart: 1, lineEnd: 2 }])
  })
})

describe('resolveLabel', () => {
  it('throws on a label that does not resolve, naming it', () => {
    expect(() => resolveLabel({ file: 'x.ts', symbol: 'gone' }, 'const here = 1\n')).toThrow('label does not resolve: x.ts :: gone')
  })
})

describe('golden labels stay resolvable against this repository', () => {
  interface Golden {
    id: string
    query: string
    kind: string
    relevant: GoldenLabel[]
  }
  const golden = jsonl<Golden>('evals/retrieval/golden.jsonl')

  it('has unique ids and a known kind on every record', () => {
    expect(golden.length).toBeGreaterThanOrEqual(40)
    expect(new Set(golden.map((g) => g.id)).size).toBe(golden.length)
    for (const g of golden) expect(['identifier', 'paraphrase', 'doc', 'absent']).toContain(g.kind)
  })

  it('labels a query absent exactly when nothing in the repo answers it', () => {
    for (const g of golden) expect(g.relevant.length === 0, g.id).toBe(g.kind === 'absent')
    expect(golden.filter((g) => g.kind === 'absent').length).toBeGreaterThanOrEqual(12)
  })

  it.each(golden.map((g) => [g.id, g] as const))('%s resolves every label', (_id, g) => {
    for (const l of g.relevant) expect(resolveLabel(l, readFileSync(path.join(ROOT, l.file), 'utf8')).length).toBeGreaterThan(0)
  })

  it('names only files that exist in answer.jsonl', () => {
    for (const a of jsonl<{ expectFiles: string[] }>('evals/retrieval/answer.jsonl')) for (const f of a.expectFiles) expect(existsSync(path.join(ROOT, f)), f).toBe(true)
  })
})

describe('parseAnswer', () => {
  it('reads the route from the via line and collects files from every delegate shape', () => {
    const out = ['via: token-goat deps src/delivery_cap.ts --importers', 'imported by:', '  src/hooks_bash_post.ts', '  src\\hooks_mcp.ts', 'clipToDeliveryCap\tsrc/bash_runner.ts:41'].join('\n')
    const r = parseAnswer(out)
    expect(r.route).toBe('deps')
    expect(r.files).toEqual(expect.arrayContaining(['src/hooks_bash_post.ts', 'src/hooks_mcp.ts', 'src/bash_runner.ts']))
  })

  it('never credits the file named on the via line, which is the question echoed back, not an answer', () => {
    const r = parseAnswer(['via: token-goat deps src/delivery_cap.ts --importers', '  src/hooks_bash_post.ts'].join('\n'))
    expect(r.files).toEqual(['src/hooks_bash_post.ts'])
  })

  it('collects a path from the line right after the via line', () => {
    expect(parseAnswer(['via: token-goat symbol runWorker', 'runWorker  src/worker.ts:12'].join('\n')).files).toEqual(['src/worker.ts'])
  })

  it('scores a refusal as refused only when stdout is empty and stderr carries the refusal', () => {
    expect(parseAnswer('', "cannot answer deterministically: 'x' is not an indexed symbol or file; try: token-goat semantic \"x\"").route).toBe('refused')
  })

  it('scores a crash as error, never as refused', () => {
    expect(parseAnswer('', 'TypeError: boom').route).toBe('error')
    expect(parseAnswer('some output', 'cannot answer deterministically: x; try: y').route).toBe('error')
  })
})

describe('answerFileMatches', () => {
  it('matches a repo path whole, in either slash style', () => {
    expect(answerFileMatches('src/worker.ts', 'src\\worker.ts')).toBe(true)
    expect(answerFileMatches('src/worker.ts', 'tests/worker.ts')).toBe(false)
  })

  it('matches an import specifier on its tail, reading .js as .ts', () => {
    expect(answerFileMatches('src/dirty_queue.ts', './dirty_queue.js')).toBe(true)
    expect(answerFileMatches('src/bridges/x.ts', '../bridges/x.js')).toBe(true)
  })

  it('matches a specifier tail only on a whole path segment', () => {
    expect(answerFileMatches('src/dirty_queue.ts', './queue.js')).toBe(false)
  })

  it('does not let a bare file name stand in for a path', () => {
    expect(answerFileMatches('src/dirty_queue.ts', 'dirty_queue.ts')).toBe(false)
  })

  it('matches an absolute path under the root', () => {
    expect(answerFileMatches('src/worker.ts', 'C:/Projects/token-goat/src/worker.ts', 'C:\\Projects\\token-goat')).toBe(true)
  })
})
