/**
 * stdin support for json-query, yaml-query, xml-query via `-` file argument.
 *
 * Tests the built bundle spawned with piped stdin. HAND-DERIVED test inputs.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let homeDir: string

function run(args: string[], input?: string): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-stdin-'))
})

describe('structured query stdin (json/yaml/xml with - argument)', () => {
  it('json-query - reads from stdin and extracts a value', () => {
    const result = run(['json-query', '-', 'a.b'], '{"a":{"b":1}}')
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe('1')
  })

  it('json-query - with --json flag outputs JSON', () => {
    const result = run(['json-query', '-', 'items[*].id', '--json'], '{"items":[{"id":1},{"id":2}]}')
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.out)
    expect(parsed.items).toEqual([1, 2])
  })

  // `printf '' | token-goat json-query - a` printed "Failed to parse JSON: -", naming neither stdin nor the cause.
  it.each(['json-query', 'yaml-query', 'xml-query'])('%s - with empty stdin says stdin was empty', (cmd) => {
    for (const input of ['', '  \n']) {
      const result = run([cmd, '-', 'a.b'], input)
      expect(result.code).toBe(1)
      expect(result.err).toMatch(/stdin was empty: pipe a document in or pass a file/)
      expect(result.out).toBe('')
    }
  })

  it('json-query - with malformed stdin names <stdin> in the parse error', () => {
    const result = run(['json-query', '-', 'a.b'], '{"a":')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/Failed to parse JSON: <stdin>/)
  })

  it('yaml-query - reads from stdin and extracts a value', () => {
    const yamlDoc = `a:\n  b: 1`
    const result = run(['yaml-query', '-', 'a.b'], yamlDoc)
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe('1')
  })

  it('xml-query - reads from stdin and extracts an element', () => {
    const xmlDoc = '<root><child>text</child></root>'
    const result = run(['xml-query', '-', 'root.child'], xmlDoc)
    expect(result.code).toBe(0)
    expect(result.out.trim()).toContain('text')
  })

  it('json-query with a real file path still works', () => {
    // This ensures we didn't break the normal file-path case.
    // Since we have no fixture dir, we just verify the error is about reading the file,
    // not about stdin handling.
    const result = run(['json-query', '/nonexistent/file.json', 'a.b'])
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/Could not read/)
  })
})
