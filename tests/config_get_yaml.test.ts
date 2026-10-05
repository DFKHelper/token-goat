import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runConfigGet } from '../src/read_inspect.js'

// PROVENANCE: FORMAT-DERIVED from the YAML 1.2.2 spec (https://yaml.org/spec/1.2.2/): literal `|` and folded `>-` block scalars (8.1), node anchors `&` and aliases `*` (6.9.2, 7.1), double-quoted keys (7.3.1), block mappings and sequences (8.2). Expected values HAND-DERIVED from the spec's folding and chomping rules, not from our parser.
const YAML = [
  'a:',
  '  b: 1',
  '  c:',
  '    d: two',
  'list:',
  '  - one',
  '  - two',
  'desc: |',
  '  line one',
  '  line two',
  'folded: >-',
  '  a',
  '  b',
  '"quoted": 7',
  'anch: &x 5',
  'ref: *x',
  'version: 2.0',
  'empty:',
  '',
].join('\n')

describe('config-get on YAML prints values, not the syntax that introduces them', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function run(content: string, key: string, name = 'cfg.yaml'): { code: number; out: string; err: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cfgyaml-'))
    dirs.push(dir)
    const file = path.join(dir, name)
    writeFileSync(file, content, 'utf-8')
    let out = ''
    let err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true }) as typeof process.stderr.write)
    const code = runConfigGet({ file, key })
    vi.restoreAllMocks()
    return { code, out, err }
  }

  it('prints a literal block scalar as its lines, not the `|` indicator', () => {
    const r = run(YAML, 'desc')
    expect(r.code).toBe(0)
    expect(r.out).toBe('line one\nline two\n')
  })

  it('prints a folded strip block scalar folded, not the `>-` indicator', () => {
    const r = run(YAML, 'folded')
    expect(r.code).toBe(0)
    expect(r.out).toBe('a b\n')
  })

  it('prints an anchored value without its anchor and resolves an alias to it', () => {
    expect(run(YAML, 'anch').out).toBe('5\n')
    expect(run(YAML, 'ref').out).toBe('5\n')
  })

  it('finds a double-quoted key by its name', () => {
    const r = run(YAML, 'quoted')
    expect(r.code).toBe(0)
    expect(r.out).toBe('7\n')
  })

  it('prints a mapping and a sequence whole as JSON rather than an empty line', () => {
    const map = run(YAML, 'a')
    expect(map.code).toBe(0)
    expect(JSON.parse(map.out)).toEqual({ b: 1, c: { d: 'two' } })
    const seq = run(YAML, 'list')
    expect(seq.code).toBe(0)
    expect(JSON.parse(seq.out)).toEqual(['one', 'two'])
  })

  it('keeps a scalar spelled the way the file writes it and names a key with no value', () => {
    expect(run(YAML, 'version').out).toBe('2.0\n')
    expect(run(YAML, 'a.c.d').out).toBe('two\n')
    const empty = run(YAML, 'empty')
    expect(empty.code).toBe(0)
    expect(empty.out).toBe('null\n')
  })

  it('reads frontmatter through the same parser', () => {
    // HAND-DERIVED: a flow sequence and a literal block in Markdown frontmatter.
    const md = '---\ntitle: Hello\ntags: [x, y]\nsummary: |\n  one\n  two\n---\n\ntitle = notthis\n'
    expect(run(md, 'title', 'fm.md').out).toBe('Hello\n')
    expect(JSON.parse(run(md, 'tags', 'fm.md').out)).toEqual(['x', 'y'])
    expect(run(md, 'summary', 'fm.md').out).toBe('one\ntwo\n')
  })

  it('reports a missing key and an unparseable file with exit 1', () => {
    const miss = run(YAML, 'a.nope')
    expect(miss.code).toBe(1)
    expect(miss.err).toContain('not found')
    // HAND-DERIVED: an unclosed flow mapping is not valid YAML.
    const bad = run('a: {b: 1\n', 'a')
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('Failed to parse YAML')
    expect(bad.out).toBe('')
  })
})
