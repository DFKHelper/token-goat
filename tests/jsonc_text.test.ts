import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseJsonOrJsonc } from '../src/jsonc_text.js'
import { runSpawned } from './helpers/batch-cli.js'

// Provenance: the tsconfig is CAPTURE (tests/fixtures/jsonc/tsc-init-6.0.3.jsonc, real `tsc --init` output, row in PROVENANCE.tsv); the edge-case documents are HAND-DERIVED from the JSONC grammar (comments and trailing commas outside strings) and their expected values from JSON.parse on the same text with the comments and trailing commas removed by hand.
const TSC_INIT = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'jsonc', 'tsc-init-6.0.3.jsonc'), 'utf8')

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('parseJsonOrJsonc', () => {
  it('reads the tsconfig `tsc --init` writes, which strict JSON.parse rejects', () => {
    expect(() => JSON.parse(TSC_INIT)).toThrow(SyntaxError)
    const parsed = parseJsonOrJsonc(TSC_INIT) as { compilerOptions: Record<string, unknown> }
    expect(parsed.compilerOptions.target).toBe('esnext')
    expect(parsed.compilerOptions.module).toBe('nodenext')
    expect(parsed.compilerOptions.types).toEqual([])
    expect(parsed.compilerOptions.skipLibCheck).toBe(true)
    expect(parsed.compilerOptions).not.toHaveProperty('rootDir')
  })

  it('leaves comment markers, commas and escapes inside strings untouched', () => {
    const text = '{\n  "url": "https://example.com/*not*/a//comment", // real comment\n  "s": "a,}",\n  "e": "\\u0041\\n\\"q\\"",\n  "arr": [1, 2,],\n}'
    expect(parseJsonOrJsonc(text)).toEqual({ url: 'https://example.com/*not*/a//comment', s: 'a,}', e: 'A\n"q"', arr: [1, 2] })
  })

  it('keeps JSON.parse semantics on the JSONC path: __proto__ is an own key and the last duplicate wins', () => {
    const parsed = parseJsonOrJsonc('{ /* c */ "__proto__": { "polluted": 1 }, "k": 1, "k": 2, }') as Record<string, unknown>
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
    expect(parsed.k).toBe(2)
  })

  it('rethrows the strict parser error for text that is not JSONC either', () => {
    const broken = '{ // c\n "a": }'
    let strictMessage = ''
    try {
      JSON.parse(broken)
    } catch (e) {
      strictMessage = (e as Error).message
    }
    expect(() => parseJsonOrJsonc(broken)).toThrow(strictMessage)
    expect(() => parseJsonOrJsonc('')).toThrow(SyntaxError)
  })

  it('returns strict JSON unchanged', () => {
    expect(parseJsonOrJsonc('{"a":[1,{"b":null}]}')).toEqual({ a: [1, { b: null }] })
  })
})

describe('JSON read commands accept JSONC through the built bundle', () => {
  for (const name of ['tsconfig.json', 'devcontainer.jsonc']) {
    it(`${name}: config-get, json-query and json-outline read a commented file`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jsonc-'))
      tmpDirs.push(dir)
      fs.writeFileSync(path.join(dir, name), TSC_INIT)
      const get = runSpawned(['config-get', name, 'compilerOptions.target'], { cwd: dir })
      expect(get.status, get.stderr).toBe(0)
      expect(get.stdout).toContain('esnext')
      const query = runSpawned(['json-query', name, 'compilerOptions.module'], { cwd: dir })
      expect(query.status, query.stderr).toBe(0)
      expect(query.stdout).toContain('nodenext')
      const outline = runSpawned(['json-outline', name], { cwd: dir })
      expect(outline.status, outline.stderr).toBe(0)
      expect(outline.stdout).toContain('compilerOptions')
    })
  }

  it('a file that is not JSONC still fails with the parse error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jsonc-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ // c\n "a": }')
    const res = runSpawned(['json-outline', 'bad.json'], { cwd: dir })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('Failed to parse JSON')
  })
})
